// V-530.A — per-element-class touch event distributions.
//
// First module of the Phase 3 real implementation. Slots in behind the same
// `BehaviouralSimulator.generateTouchEvent` interface that the stub mock
// implements; callers do not change. See `interfaces.ts` for the contract.
//
// Distributions are class-typical and derived from a synthetic-persona
// model — NOT from any collected user behaviour. The library carries no
// behavioural training data per AGENTS.md scope.
//
// Sub-slices deferred:
//   - V-530.B (W16) — scroll velocity profiles with decay.
//   - V-530.C (W19) — dwell time models + click-position distributions
//     refined with element-region-aware bias (e.g. button affordance edge).
//   - V-530.D (later) — idle-period jitter + multi-touch gesture sequencing.

import type {
  ElementBounds,
  ElementClass,
  TouchDistribution,
  TouchEvent,
  TouchSample,
} from './types.js';
import { requireFinite } from './validation.js';

/**
 * Per-element-class distribution table. Values are class-typical and chosen
 * to produce visibly distinct touch shapes across classes (a `button` tap
 * differs measurably from a `video` long-touch or a `scroll-container`
 * swipe-start).
 *
 * Property-based tests verify the distributions stay inside their declared
 * ranges and respect element bounds for every seed (see `tests/touch.test.ts`).
 */
export const TOUCH_DISTRIBUTIONS: Readonly<Record<ElementClass, TouchDistribution>> = Object.freeze(
  {
    button: {
      meanDwellMs: 110,
      dwellJitterMs: 30,
      centerBias: { x: 0.5, y: 0.5 },
      positionJitter: { x: 0.15, y: 0.15 },
      meanDriftPx: 1.5,
      sampleCount: 4,
      meanPressure: 0.55,
    },
    link: {
      meanDwellMs: 90,
      dwellJitterMs: 25,
      centerBias: { x: 0.5, y: 0.55 },
      positionJitter: { x: 0.25, y: 0.2 },
      meanDriftPx: 1.0,
      sampleCount: 3,
      meanPressure: 0.45,
    },
    input: {
      meanDwellMs: 140,
      dwellJitterMs: 35,
      centerBias: { x: 0.4, y: 0.5 },
      positionJitter: { x: 0.2, y: 0.15 },
      meanDriftPx: 1.2,
      sampleCount: 4,
      meanPressure: 0.5,
    },
    image: {
      meanDwellMs: 180,
      dwellJitterMs: 60,
      centerBias: { x: 0.5, y: 0.5 },
      positionJitter: { x: 0.35, y: 0.35 },
      meanDriftPx: 2.5,
      sampleCount: 5,
      meanPressure: 0.5,
    },
    video: {
      meanDwellMs: 220,
      dwellJitterMs: 80,
      centerBias: { x: 0.5, y: 0.65 },
      positionJitter: { x: 0.25, y: 0.15 },
      meanDriftPx: 2.0,
      sampleCount: 5,
      meanPressure: 0.55,
    },
    'scroll-container': {
      meanDwellMs: 280,
      dwellJitterMs: 90,
      centerBias: { x: 0.5, y: 0.5 },
      positionJitter: { x: 0.4, y: 0.4 },
      meanDriftPx: 40,
      sampleCount: 8,
      meanPressure: 0.4,
    },
    generic: {
      meanDwellMs: 130,
      dwellJitterMs: 40,
      centerBias: { x: 0.5, y: 0.5 },
      positionJitter: { x: 0.3, y: 0.3 },
      meanDriftPx: 2.0,
      sampleCount: 4,
      meanPressure: 0.5,
    },
  },
);

/**
 * Seeded PRNG (mulberry32). Returns a deterministic float in [0, 1) given
 * a 32-bit unsigned integer state, advancing on each call.
 *
 * Used here because the generator must be reproducible given a string seed —
 * no `Math.random()` allowed — and because pulling in a full PRNG dependency
 * for this single-module slice is unnecessary npm-weight.
 */
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

/**
 * Hash a string seed to a 32-bit unsigned integer using FNV-1a. Stable
 * across runs / engines / Node versions.
 */
function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// ⚠️ DETERMINISTIC FALLBACK SEED — reference/testing only. This default is
// derived purely from the input args, so two default-seed calls with the same
// args produce BYTE-IDENTICAL event streams. That is intentional for this
// reference layer (reproducible tests). Production callers MUST pass a
// per-session `seed` (e.g. the session id) so concurrent/sequential sessions
// don't emit correlated, replayable streams — a cross-session correlation tell.
function defaultSeed(opts: { elementClass: ElementClass; bounds: ElementBounds }): string {
  return `touch:${opts.elementClass}:${JSON.stringify(opts.bounds)}`;
}

/**
 * Generate a touch event sampled from the per-class distribution. Pure
 * function: identical (elementClass, bounds, seed) inputs always produce
 * identical output.
 */
export function generateTouchEvent(opts: {
  elementClass: ElementClass;
  bounds: ElementBounds;
  seed?: string;
}): TouchEvent {
  for (const [name, value] of [
    ['x', opts.bounds.x],
    ['y', opts.bounds.y],
    ['width', opts.bounds.width],
    ['height', opts.bounds.height],
  ] as const) {
    requireFinite(`generateTouchEvent: bounds.${name}`, value);
  }
  if (opts.bounds.width <= 0 || opts.bounds.height <= 0) {
    throw new Error(
      `generateTouchEvent: element bounds must have positive width + height ` +
        `(got width=${opts.bounds.width}, height=${opts.bounds.height})`,
    );
  }
  requireFinite('generateTouchEvent: bounds right edge', opts.bounds.x + opts.bounds.width);
  requireFinite('generateTouchEvent: bounds bottom edge', opts.bounds.y + opts.bounds.height);

  const dist = TOUCH_DISTRIBUTIONS[opts.elementClass];
  const seed = opts.seed ?? defaultSeed(opts);
  const rng = mulberry32(hashSeed(seed));

  // Helper: uniform in [-1, 1).
  const uniformSigned = (): number => rng() * 2 - 1;

  // Position: biased centre + symmetric jitter, clipped to bounds.
  const biasX = opts.bounds.x + opts.bounds.width * dist.centerBias.x;
  const biasY = opts.bounds.y + opts.bounds.height * dist.centerBias.y;
  const jitterX = opts.bounds.width * dist.positionJitter.x * uniformSigned();
  const jitterY = opts.bounds.height * dist.positionJitter.y * uniformSigned();
  const startX = clip(biasX + jitterX, opts.bounds.x, opts.bounds.x + opts.bounds.width);
  const startY = clip(biasY + jitterY, opts.bounds.y, opts.bounds.y + opts.bounds.height);

  // Drift: random unit-circle direction times triangular(0, meanDrift, 2*meanDrift).
  const angle = rng() * Math.PI * 2;
  const driftMag = (rng() + rng()) * dist.meanDriftPx; // triangular [0, 2*mean]
  const endX = clip(
    startX + Math.cos(angle) * driftMag,
    opts.bounds.x,
    opts.bounds.x + opts.bounds.width,
  );
  const endY = clip(
    startY + Math.sin(angle) * driftMag,
    opts.bounds.y,
    opts.bounds.y + opts.bounds.height,
  );

  // Dwell duration: mean ± triangular jitter (sum of two uniforms - 1).
  const dwellJitter = (rng() + rng() - 1) * dist.dwellJitterMs;
  const durationMs = Math.max(1, dist.meanDwellMs + dwellJitter);

  // Pressure: mean ± uniform(-0.1, 0.1), clipped to [0, 1].
  const meanPressureJitter = uniformSigned() * 0.1;
  const basePressure = clip(dist.meanPressure + meanPressureJitter, 0, 1);

  // Build samples: monotonically increasing tMs from 0 to durationMs.
  const samples: TouchSample[] = [];
  for (let i = 0; i < dist.sampleCount; i += 1) {
    const t = dist.sampleCount === 1 ? 0 : i / (dist.sampleCount - 1);
    samples.push({
      x: startX + (endX - startX) * t,
      y: startY + (endY - startY) * t,
      tMs: t * durationMs,
      pressure: clip(basePressure + uniformSigned() * 0.05, 0, 1),
    });
  }

  return {
    elementClass: opts.elementClass,
    bounds: opts.bounds,
    start: { x: startX, y: startY },
    end: { x: endX, y: endY },
    samples,
    durationMs,
    seed,
  };
}

function clip(value: number, lo: number, hi: number): number {
  if (value < lo) return lo;
  if (value > hi) return hi;
  return value;
}
