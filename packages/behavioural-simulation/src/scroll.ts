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

/** Slowest useful event cadence. A lower rate collapses visible motion into jumps. */
const MAX_TICK_INTERVAL_MS = 100;

/** Generous upper bound beyond observed human finger-flick velocity. */
const MAX_INITIAL_VELOCITY_PX_PER_SEC = 12_000;

/** Slowest supported friction; also keeps the analytic integral stable. */
const MIN_DECAY_RATE = 0.1;

/** Avoid an effectively instantaneous one-sample stop. Defaults peak at 6.8/s. */
const MAX_DECAY_RATE = 20;

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
 * rest threshold (5 px/s). Explicit overrides that cannot settle inside
 * `MAX_DURATION_MS` are rejected instead of compressing unseen motion into a
 * synthetic final tick.
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
  if (tickIntervalMs > MAX_TICK_INTERVAL_MS) {
    throw new Error(
      `generateScrollVelocityProfile: tickIntervalMs must be <= ${MAX_TICK_INTERVAL_MS} ` +
        `(got ${tickIntervalMs}); slower sampling collapses a gesture into visible jumps`,
    );
  }
  // Override inputs bypass the bounded class defaults, so validate the whole
  // physical envelope here. Non-positive velocity is a dead/reverse scroll;
  // non-positive decay never slows (or accelerates); extreme velocity, decay
  // or cadence collapses a gesture into detector-visible jumps. Reject those
  // inputs rather than silently rewriting caller intent or emitting an
  // unphysical profile.
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
    if (opts.initialVelocityPxPerSec > MAX_INITIAL_VELOCITY_PX_PER_SEC) {
      throw new Error(
        `generateScrollVelocityProfile: initialVelocityPxPerSec must be <= ` +
          `${MAX_INITIAL_VELOCITY_PX_PER_SEC} when set (got ${opts.initialVelocityPxPerSec})`,
      );
    }
  }
  if (opts.decayRate !== undefined) {
    requireFinite('generateScrollVelocityProfile: decayRate', opts.decayRate);
    if (opts.decayRate < MIN_DECAY_RATE || opts.decayRate > MAX_DECAY_RATE) {
      throw new Error(
        `generateScrollVelocityProfile: decayRate must be >= ${MIN_DECAY_RATE} and <= ` +
          `${MAX_DECAY_RATE} when set (got ${opts.decayRate})`,
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
    opts.decayRate ??
    Math.max(0.1, defaults.meanDecayRate + uniformSigned() * defaults.decayRateJitter);

  // Every generated profile must contain its own visible settling sample. The
  // previous cap path integrated the unobserved exponential tail to infinity
  // and placed the entire remainder in one zero-velocity tick. For
  // v0=8000/decay=0.1 that produced a 48,484 px final jump after 313 ordinary
  // samples. Reject a physically incompatible override instead. Use the last
  // actual cadence-aligned sample at/before MAX_DURATION_MS, not the ideal 5 s
  // point, so fractional tick intervals cannot slip through then stop above
  // the threshold because their next sample lands after the cap.
  const lastSampleMs = Math.floor(MAX_DURATION_MS / tickIntervalMs) * tickIntervalMs;
  const velocityAtLastSample = v0 * Math.exp(-decayRate * (lastSampleMs / 1000));
  if (velocityAtLastSample >= REST_VELOCITY_THRESHOLD_PX_PER_SEC) {
    throw new Error(
      `generateScrollVelocityProfile: velocity/decay overrides must settle below ` +
        `${REST_VELOCITY_THRESHOLD_PX_PER_SEC} px/s within ${MAX_DURATION_MS} ms ` +
        `(got ${velocityAtLastSample.toFixed(3)} px/s at the final sample)`,
    );
  }

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
      (v0 / decayRate) * (Math.exp(-decayRate * tSec) - Math.exp(-decayRate * (tSec + tickSec)));
    const deltaPx = sign * deltaPxAbs;
    cumulativePx += deltaPx;

    ticks.push({ tMs, velocityPxPerSec, deltaPx, cumulativePx });

    if (velocityPxPerSec < REST_VELOCITY_THRESHOLD_PX_PER_SEC && tMs > 0) {
      break;
    }
    tMs += tickIntervalMs;
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
