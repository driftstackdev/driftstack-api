// V-530.D — idle-period jitter generator.
//
// Final sub-slice of the V-530 series. Models the "between" time when
// a synthetic persona pauses without interaction — reading a page,
// thinking about a form field, scrolling slowly to take in content.
// Detection vendors fingerprint sessions on the absence of these pauses
// as much as on the presence of taps + scrolls; a session that
// transitions cap-to-cap with zero idle time is the most-obvious bot
// pattern.
//
// Two idle generators ship here:
//
//   - generateIdlePeriod — a single bounded idle interval with an
//     internal jitter pattern (micro-movements, occasional re-focus).
//   - generateIdleSequence — N idle periods interleaved with synthetic
//     "active" markers, suitable for stitching between meaningful
//     interactions in a recipe runner.
//
// Multi-touch gesture sequencing (the other half of V-530.D's
// original scope) is deferred: it's a substantially different model
// (per-finger track interleaving with collision avoidance) and
// belongs in a separate slice. This module covers the idle half.
//
// Like the rest of the package, outputs are deterministic given a
// seed. The PRNG / hash helpers match touch.ts / scroll.ts / dwell.ts
// (mulberry32 + FNV-1a) — keeping seeding shape consistent across
// the package means the same string seed produces the same shape
// regardless of which generator's caller wires it through.

import { requireFinite } from './validation.js';

/**
 * A single idle interval with timestamps in ms since the idle-period
 * start. `microMovements` are jitter-pixel cursor wobbles that the
 * driver can replay against the host's mouse-move event channel.
 * `refocusAt` (if non-null) is a timestamp where the persona briefly
 * re-engaged (typically: minor scroll, fleeting cursor reposition) —
 * helpful for breaking long idles into less-obvious sub-blocks.
 */
export interface IdlePeriod {
  /** Total length of the idle interval (ms). */
  durationMs: number;
  /** Micro-cursor-wobble events during the idle. May be empty. */
  microMovements: ReadonlyArray<{
    tMs: number;
    dxPx: number;
    dyPx: number;
  }>;
  /**
   * Timestamp of a re-focus event during the idle (ms since idle-start).
   * Null when the idle stays uninterrupted.
   */
  refocusAt: number | null;
  /** RNG seed used to generate this idle period. */
  seed: string;
}

/** Class-typical idle defaults. Real personas vary; these are the
 *  centre of the distribution for the named role. */
export interface IdleClassDefaults {
  /** Mean idle duration (ms) for this persona class. */
  meanDurationMs: number;
  /** ± duration jitter (ms). Uniform in the bounded range. */
  durationJitterMs: number;
  /** Mean number of micro-movements during the idle. */
  meanMicroMovementCount: number;
  /** Probability (0..1) of emitting a single re-focus event. */
  refocusProbability: number;
  /** Per-micro-movement magnitude (CSS px) for the jitter wobble. */
  microMovementMagnitudePx: number;
}

export const IDLE_DEFAULTS = Object.freeze({
  // Customer is reading; long idle, occasional cursor jitter, moderate
  // chance of a re-focus pass.
  reading: {
    meanDurationMs: 8_500,
    durationJitterMs: 3_500,
    meanMicroMovementCount: 4,
    refocusProbability: 0.5,
    microMovementMagnitudePx: 6,
  },
  // Customer is thinking about a form field; medium idle, few
  // micro-movements, low refocus probability.
  thinking: {
    meanDurationMs: 3_200,
    durationJitterMs: 1_500,
    meanMicroMovementCount: 1,
    refocusProbability: 0.2,
    microMovementMagnitudePx: 4,
  },
  // Customer is briefly distracted (notification, side-tab); short
  // idle, no micro-movements, high refocus probability when they come
  // back to the page.
  distracted: {
    meanDurationMs: 2_100,
    durationJitterMs: 900,
    meanMicroMovementCount: 0,
    refocusProbability: 0.85,
    microMovementMagnitudePx: 3,
  },
  // Customer is between major interactions; short pause to settle.
  transition: {
    meanDurationMs: 450,
    durationJitterMs: 250,
    meanMicroMovementCount: 0,
    refocusProbability: 0.05,
    microMovementMagnitudePx: 2,
  },
} satisfies Record<IdleClass, IdleClassDefaults>);

export type IdleClass = 'reading' | 'thinking' | 'distracted' | 'transition';

export interface GenerateIdlePeriodOpts {
  /** Persona class — informs distribution defaults. */
  idleClass: IdleClass;
  /** Optional explicit duration override (ms). Overrides class default. */
  durationMs?: number;
  /** Optional seed override (default: per-call deterministic seed). */
  seed?: string;
}

export interface IdleSequenceEntry {
  /** Sequential idle period in the chain. */
  idle: IdlePeriod;
  /** Persona class that drove this idle. */
  idleClass: IdleClass;
  /** Cumulative offset from sequence-start when this idle begins (ms). */
  offsetMs: number;
}

export interface IdleSequence {
  entries: readonly IdleSequenceEntry[];
  /** Total wall-clock duration of the chain (ms). */
  totalDurationMs: number;
  /** RNG seed used to generate the sequence. */
  seed: string;
}

export interface GenerateIdleSequenceOpts {
  /** Ordered chain of idle classes; one entry per resulting idle. */
  classes: readonly IdleClass[];
  /** Optional seed override (default: per-call deterministic seed). */
  seed?: string;
}

function mulberry32(seedNum: number): () => number {
  let state = seedNum >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashSeed(seed: string): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ⚠️ DETERMINISTIC FALLBACK SEEDS — reference/testing only. Both defaults below
// are derived purely from the input args, so two default-seed calls with the
// same args produce byte-identical idle streams. Intentional for this reference
// layer (reproducible tests). Production callers MUST pass a per-session `seed`
// so sessions don't emit correlated, replayable idle timing (a cross-session
// correlation tell).
function defaultSeed(opts: GenerateIdlePeriodOpts): string {
  return `idle:${opts.idleClass}:${opts.durationMs ?? 'auto'}`;
}

function defaultSequenceSeed(opts: GenerateIdleSequenceOpts): string {
  return `idle-seq:${opts.classes.join(',')}`;
}

/**
 * Generate a single idle period sampled from the class-typical
 * distribution. Deterministic given (idleClass, durationMs?, seed).
 */
export function generateIdlePeriod(opts: GenerateIdlePeriodOpts): IdlePeriod {
  const defaults = IDLE_DEFAULTS[opts.idleClass];
  const seed = opts.seed ?? defaultSeed(opts);
  const rng = mulberry32(hashSeed(seed));

  let durationMs: number;
  if (opts.durationMs !== undefined) {
    // An explicit override bypasses the default-branch Math.max(50, …)
    // clamp below, so validate it here — mirror the scroll-override
    // guard. A non-positive duration yields a degenerate zero/negative-
    // length idle that collapses every micro-movement onto t=0 (and
    // breaks the Math.min(durationMs, …) time clamp).
    requireFinite('generateIdlePeriod: durationMs', opts.durationMs);
    if (opts.durationMs <= 0) {
      throw new Error(
        `generateIdlePeriod: durationMs must be > 0 when set (got ${opts.durationMs})`,
      );
    }
    durationMs = opts.durationMs;
  } else {
    // Triangular-style jitter around the class mean: rng() in [0,1)
    // mapped to ±durationJitterMs. Clamp at 50ms minimum so callers
    // never get a degenerate zero-length idle when they ask for one.
    const jitter = (rng() * 2 - 1) * defaults.durationJitterMs;
    durationMs = Math.max(50, Math.round(defaults.meanDurationMs + jitter));
  }

  // Micro-movement count is Poisson-ish: round(mean + small jitter).
  const microJitter = (rng() - 0.5) * 1.5;
  const microCount = Math.max(0, Math.round(defaults.meanMicroMovementCount + microJitter));

  const microMovements: Array<{ tMs: number; dxPx: number; dyPx: number }> = [];
  for (let i = 0; i < microCount; i += 1) {
    // Distribute micro-movements roughly evenly across the idle, with
    // per-event time jitter so they don't fall on perfect intervals.
    const fraction = (i + 0.5) / microCount;
    const baseTime = fraction * durationMs;
    const timeJitter = (rng() - 0.5) * (durationMs / Math.max(microCount, 1)) * 0.4;
    const tMs = Math.max(0, Math.min(durationMs, Math.round(baseTime + timeJitter)));
    const dxPx = Math.round((rng() * 2 - 1) * defaults.microMovementMagnitudePx);
    const dyPx = Math.round((rng() * 2 - 1) * defaults.microMovementMagnitudePx);
    microMovements.push({ tMs, dxPx, dyPx });
  }

  const refocusRoll = rng();
  let refocusAt: number | null = null;
  if (refocusRoll < defaults.refocusProbability) {
    // Re-focus tends to land in the second half of the idle — the
    // persona "comes back" after the wandering attention.
    const halfMark = durationMs * 0.55;
    const tail = durationMs - halfMark;
    refocusAt = Math.round(halfMark + rng() * tail);
  }

  return { durationMs, microMovements, refocusAt, seed };
}

/**
 * Generate an ordered chain of idle periods. Each entry's `offsetMs`
 * is the cumulative start offset from the sequence root, so callers
 * can replay the chain back-to-back into a session timeline without
 * recomputing offsets.
 */
export function generateIdleSequence(opts: GenerateIdleSequenceOpts): IdleSequence {
  const seed = opts.seed ?? defaultSequenceSeed(opts);
  const entries: IdleSequenceEntry[] = [];
  let cursor = 0;
  for (let i = 0; i < opts.classes.length; i += 1) {
    const cls = opts.classes[i];
    if (cls === undefined) continue;
    // Per-entry seed combines the sequence seed with the index — keeps
    // the chain deterministic but each idle gets its own RNG stream.
    const entrySeed = `${seed}#${i.toString()}`;
    const idle = generateIdlePeriod({ idleClass: cls, seed: entrySeed });
    entries.push({ idle, idleClass: cls, offsetMs: cursor });
    cursor += idle.durationMs;
  }
  return { entries, totalDurationMs: cursor, seed };
}
