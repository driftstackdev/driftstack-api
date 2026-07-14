// V-530.B — scroll velocity profiles with exponential decay.
//
// Second module of the Phase 3 real implementation, after V-530.A
// (touch event distributions). Models the velocity curve a human finger
// flick produces on a scroll container: initial velocity from the flick,
// then exponential decay as friction slows the scroll.
//
// Distinct from the existing `generateScrollPattern` mock surface
// (constant per-tick deltas) — this module produces realistic decaying
// per-tick deltas. The existing mock surface stays unchanged for
// backward compatibility; new callers reach for the velocity profile.
//
// Sub-slices remaining:
//   - V-530.C (W19) — dwell time models + click-position distributions
//     refined with element-region-aware bias.
//   - V-530.D (later) — idle-period jitter + multi-touch gesture sequencing.

import type { ElementClass } from './types.js';
import { requireFinite } from './validation.js';

/** A single per-tick sample of a decaying scroll. */
export interface ScrollVelocityTick {
  /** Wall-clock time since scroll-start (ms). */
  tMs: number;
  /** Instantaneous velocity at this tick (pixels per second). */
  velocityPxPerSec: number;
  /** Pixels scrolled during this tick (signed: + = forward, - = reverse). */
  deltaPx: number;
  /** Cumulative pixels scrolled from start through this tick. */
  cumulativePx: number;
}

/** A complete scroll-velocity profile from finger flick to rest. */
export interface ScrollVelocityProfile {
  /** Direction of the scroll. */
  direction: 'up' | 'down' | 'left' | 'right';
  /** Initial velocity at t=0 (pixels per second). */
  initialVelocityPxPerSec: number;
  /** Exponential decay rate (1 / seconds). Higher = faster decay. */
  decayRate: number;
  /** Per-tick samples from start to rest. */
  ticks: readonly ScrollVelocityTick[];
  /** Total distance scrolled (absolute, in pixels). */
  totalDistancePx: number;
  /** Total wall-clock duration of the scroll in ms. */
  durationMs: number;
  /** RNG seed used to generate this profile. */
  seed: string;
}

/**
 * Per-element-class defaults for scroll velocity. The `container` class
 * the touch initiates on shapes the initial flick velocity + friction.
 * scroll-container has stronger flicks + lower friction (the touched
 * surface is designed to be scrolled); generic containers have weaker
 * flicks + higher friction (incidental scroll, e.g. background body).
 */
export interface ScrollVelocityClassDefaults {
  /** Mean initial velocity (pixels per second). */
  meanInitialVelocityPxPerSec: number;
  /** ± jitter around mean initial velocity (px/s). */
  initialVelocityJitter: number;
  /** Mean decay rate (1/s). */
  meanDecayRate: number;
  /** ± jitter around mean decay rate (1/s). */
  decayRateJitter: number;
}

export const SCROLL_VELOCITY_DEFAULTS: Readonly<Record<ElementClass, ScrollVelocityClassDefaults>> =
  Object.freeze({
    'scroll-container': {
      meanInitialVelocityPxPerSec: 2400,
      initialVelocityJitter: 600,
      meanDecayRate: 2.0,
      decayRateJitter: 0.4,
    },
    generic: {
      meanInitialVelocityPxPerSec: 1500,
      initialVelocityJitter: 400,
      meanDecayRate: 3.5,
      decayRateJitter: 0.5,
    },
    image: {
      meanInitialVelocityPxPerSec: 1800,
      initialVelocityJitter: 500,
      meanDecayRate: 3.0,
      decayRateJitter: 0.5,
    },
    video: {
      meanInitialVelocityPxPerSec: 1200,
      initialVelocityJitter: 350,
      meanDecayRate: 4.0,
      decayRateJitter: 0.6,
    },
    button: {
      // Scrolling from a button surface is unusual but possible (touchpad
      // / inertial scroll origin happens to be over a button). Conservative
      // defaults — short, weak scroll.
      meanInitialVelocityPxPerSec: 900,
      initialVelocityJitter: 250,
      meanDecayRate: 5.0,
      decayRateJitter: 0.7,
    },
    link: {
      meanInitialVelocityPxPerSec: 900,
      initialVelocityJitter: 250,
      meanDecayRate: 5.0,
      decayRateJitter: 0.7,
    },
    input: {
      // Scrolling within an input rarely happens; default small.
      meanInitialVelocityPxPerSec: 700,
      initialVelocityJitter: 200,
      meanDecayRate: 6.0,
      decayRateJitter: 0.8,
    },
  });

/** Default tick interval (ms). 16ms ≈ 60 Hz, matching touch device rates. */
const DEFAULT_TICK_INTERVAL_MS = 16;

/** Velocity below this threshold (px/s) terminates the scroll. */
const REST_VELOCITY_THRESHOLD_PX_PER_SEC = 5;

/** Hard cap on duration to bound test runtime. ~5 seconds is generous. */
const MAX_DURATION_MS = 5000;

/**
 * Hard floor on `tickIntervalMs`. The generation loop below is bounded by
 * WALL-CLOCK duration (`tMs <= MAX_DURATION_MS`), not by iteration count, so
 * the number of loop iterations is `~MAX_DURATION_MS / tickIntervalMs` —
 * unbounded as `tickIntervalMs` shrinks toward 0. VERIFIED: tickIntervalMs
 * 0.001 synchronously builds a 3.1-million-element array; 0.00001 OOM-crashes
 * the process. No real touch/display samples faster than ~1 kHz (a
 * best-effort upper bound — typical touch scroll ticks run at 60 Hz / 16 ms;
 * even a 120 Hz ProMotion-class display is only ~8.3 ms), so 1 ms is already
 * a generous floor with headroom to spare, and it caps the worst case at
 * MAX_DURATION_MS / MIN_TICK_INTERVAL_MS = 5000 iterations for the full 5 s
 * window — bounded, sane, and nowhere near OOM territory.
 */
export const MIN_TICK_INTERVAL_MS = 1;

// Self-check: keep the worst-case iteration count sane so a future change to
// either constant can't silently reopen the unbounded-loop gap. 10,000 is a
// generous ceiling (2x the current 5,000 worst case) — well short of anything
// that risks the OOM behaviour this floor exists to prevent.
if (MAX_DURATION_MS / MIN_TICK_INTERVAL_MS > 10_000) {
  throw new Error(
    `scroll.ts: MAX_DURATION_MS / MIN_TICK_INTERVAL_MS must stay <= 10000 ` +
      `(got ${MAX_DURATION_MS / MIN_TICK_INTERVAL_MS}); this bounds the worst-case ` +
      `iteration count of generateScrollVelocityProfile's generation loop`,
  );
}

export interface GenerateScrollVelocityProfileOpts {
  /** Direction of the scroll. */
  direction: 'up' | 'down' | 'left' | 'right';
  /** Element class the scroll initiates from (informs defaults). */
  elementClass: ElementClass;
  /** Optional explicit initial velocity (px/s). Overrides class default. */
  initialVelocityPxPerSec?: number;
  /** Optional explicit decay rate (1/s). Overrides class default. */
  decayRate?: number;
  /** Optional tick interval (ms). Default 16 ms. */
  tickIntervalMs?: number;
  /** Optional seed override (defaults to deterministic per-call seed). */
  seed?: string;
}

function mulberry32(seedNum: number): () => number {
  let state = seedNum >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ⚠️ DETERMINISTIC FALLBACK SEED — reference/testing only. Derived purely from
// the input args, so two default-seed calls with the same args produce
// BYTE-IDENTICAL profiles. Intentional for this reference layer (reproducible
// tests). Production callers MUST pass a per-session `seed` so sessions don't
// emit correlated, replayable scroll profiles (a cross-session correlation tell).
function defaultSeed(opts: GenerateScrollVelocityProfileOpts): string {
  return `scroll-v:${opts.direction}:${opts.elementClass}`;
}

/**
 * Generate a scroll velocity profile with exponential decay.
 *
 * Pure + deterministic given (direction, elementClass, seed). The profile
 * starts at `initialVelocityPxPerSec` and decays as
 *   v(t) = v0 * exp(-decayRate * t)
 * sampled at `tickIntervalMs` intervals until velocity drops below the
 * rest threshold (5 px/s) or `MAX_DURATION_MS` is reached.
 *
 * Direction sign convention:
 *   - 'down' / 'right' → positive `deltaPx`
 *   - 'up' / 'left'    → negative `deltaPx`
 *
 * `totalDistancePx` is always positive (absolute distance scrolled).
 */
export function generateScrollVelocityProfile(
  opts: GenerateScrollVelocityProfileOpts,
): ScrollVelocityProfile {
  const tickIntervalMs = opts.tickIntervalMs ?? DEFAULT_TICK_INTERVAL_MS;
  requireFinite('generateScrollVelocityProfile: tickIntervalMs', tickIntervalMs);
  if (tickIntervalMs <= 0) {
    throw new Error(
      `generateScrollVelocityProfile: tickIntervalMs must be > 0 (got ${tickIntervalMs})`,
    );
  }
  // Floor on top of the > 0 check above: the generation loop below is bounded
  // by wall-clock duration, not iteration count, so a tiny-but-positive
  // tickIntervalMs (e.g. 0.001, 0.00001) makes the loop run millions of times
  // and can OOM the process. See MIN_TICK_INTERVAL_MS for the full reasoning.
  if (tickIntervalMs < MIN_TICK_INTERVAL_MS) {
    throw new Error(
      `generateScrollVelocityProfile: tickIntervalMs must be >= ${MIN_TICK_INTERVAL_MS} ` +
        `(got ${tickIntervalMs}); values below this floor make the generation loop's ` +
        `iteration count (MAX_DURATION_MS / tickIntervalMs) unbounded`,
    );
  }
  // Override inputs bypass the default-branch clamps (Math.max(1, v0) /
  // Math.max(0.1, decayRate)), so validate them here. A non-positive
  // initial velocity yields a dead/reverse scroll; a negative decay rate
  // makes v(t) GROW — a physically-impossible accelerating flick that no
  // real finger produces (a behavioural tell). A decayRate override of 0
  // would yield a non-decaying constant-velocity scroll that never slows —
  // equally impossible for a real finger flick (it always decays under
  // friction) — so the override is FLOORED to 0.1 below, matching the
  // default path's Math.max(0.1, …) clamp rather than throwing (so existing
  // decayRate:0 callers keep working, just with a realistic floor).
  if (opts.initialVelocityPxPerSec !== undefined) {
    requireFinite(
      'generateScrollVelocityProfile: initialVelocityPxPerSec',
      opts.initialVelocityPxPerSec,
    );
    if (opts.initialVelocityPxPerSec <= 0) {
      throw new Error(
        `generateScrollVelocityProfile: initialVelocityPxPerSec must be > 0 when set ` +
          `(got ${opts.initialVelocityPxPerSec})`,
      );
    }
  }
  if (opts.decayRate !== undefined) {
    requireFinite('generateScrollVelocityProfile: decayRate', opts.decayRate);
    if (opts.decayRate < 0) {
      throw new Error(
        `generateScrollVelocityProfile: decayRate must be >= 0 when set (got ${opts.decayRate})`,
      );
    }
  }

  const seed = opts.seed ?? defaultSeed(opts);
  const rng = mulberry32(hashSeed(seed));
  const uniformSigned = (): number => rng() * 2 - 1;

  const defaults = SCROLL_VELOCITY_DEFAULTS[opts.elementClass];
  const v0 =
    opts.initialVelocityPxPerSec ??
    Math.max(
      1,
      defaults.meanInitialVelocityPxPerSec + uniformSigned() * defaults.initialVelocityJitter,
    );
  const decayRate =
    opts.decayRate !== undefined
      ? // Floor an explicit override to 0.1 — a real finger flick always decays,
        // so decayRate 0 (non-decaying, constant-velocity ~5s scroll) is
        // physically impossible. Same floor as the default-path clamp below.
        Math.max(0.1, opts.decayRate)
      : Math.max(0.1, defaults.meanDecayRate + uniformSigned() * defaults.decayRateJitter);

  const sign = opts.direction === 'up' || opts.direction === 'left' ? -1 : 1;
  const tickSec = tickIntervalMs / 1000;

  const ticks: ScrollVelocityTick[] = [];
  let tMs = 0;
  let cumulativePx = 0;

  while (tMs <= MAX_DURATION_MS) {
    const tSec = tMs / 1000;
    const velocityPxPerSec = v0 * Math.exp(-decayRate * tSec);

    // Pixels scrolled this tick: ∫ v(τ)dτ from t to t+tickSec
    //   = (v0 / decayRate) * (exp(-decay * t) - exp(-decay * (t+tickSec)))
    const deltaPxAbs =
      decayRate === 0
        ? v0 * tickSec
        : (v0 / decayRate) *
          (Math.exp(-decayRate * tSec) - Math.exp(-decayRate * (tSec + tickSec)));
    const deltaPx = sign * deltaPxAbs;
    cumulativePx += deltaPx;

    ticks.push({ tMs, velocityPxPerSec, deltaPx, cumulativePx });

    if (velocityPxPerSec < REST_VELOCITY_THRESHOLD_PX_PER_SEC && tMs > 0) {
      break;
    }
    tMs += tickIntervalMs;
  }

  // Guarantee a settling phase: a real finger flick always coasts to a
  // stop, so the profile MUST end at rest. The `tMs <= MAX_DURATION_MS`
  // cap above can truncate the loop while velocity is still high (a high
  // v0 with a low/floored decayRate decays slowly — e.g. v0=8000,
  // decayRate=0.1 is still ~4800 px/s at 5 s), which would otherwise read
  // as an unnatural abrupt mid-flight stop — a behavioural tell. When the
  // last sampled tick is still above the rest threshold, append a final
  // tick AT rest (velocity 0) carrying the remaining coast distance.
  //
  // ⚠️ Off-by-one integral: the in-loop tick emitted at time t_cut already
  // covers the interval [t_cut, t_cut + tickSec] (its deltaPx is
  // ∫ v(τ)dτ from t_cut to t_cut + tickSec — see the loop body above). So
  // the settling tail must resume at t_cut + tickSec, NOT at t_cut, or the
  // interval [t_cut, t_cut + tickSec] is double-counted and totalDistancePx /
  // cumulativePx are inflated by exactly that last in-loop tick's distance.
  // The correct, NON-overlapping tail is:
  //   ∫ v(τ)dτ from t_cut + tickSec to ∞ = v(t_cut + tickSec) / decayRate
  //     = v(t_cut) * exp(-decayRate * tickSec) / decayRate
  // Combined with the in-loop sum (which covers [0, t_cut + tickSec]) this
  // yields the exact analytic total ∫ v(τ)dτ from 0 to ∞ = v0 / decayRate,
  // with no overlap — so the emitted distance is exact, not merely smaller.
  const lastTick = ticks[ticks.length - 1];
  if (lastTick !== undefined && lastTick.velocityPxPerSec >= REST_VELOCITY_THRESHOLD_PX_PER_SEC) {
    // decayRate is floored to >= 0.1 above, so this division is always safe.
    // Advance the tail's start bound by one tick (× exp(-decayRate * tickSec))
    // so it begins exactly where the last in-loop tick's integral ended.
    const velocityAfterLastTick = lastTick.velocityPxPerSec * Math.exp(-decayRate * tickSec);
    const tailDistanceAbs = velocityAfterLastTick / decayRate;
    const tailDelta = sign * tailDistanceAbs;
    cumulativePx += tailDelta;
    ticks.push({
      tMs: lastTick.tMs + tickIntervalMs,
      velocityPxPerSec: 0,
      deltaPx: tailDelta,
      cumulativePx,
    });
  }

  return {
    direction: opts.direction,
    initialVelocityPxPerSec: v0,
    decayRate,
    ticks,
    totalDistancePx: Math.abs(cumulativePx),
    durationMs: ticks[ticks.length - 1]?.tMs ?? 0,
    seed,
  };
}
