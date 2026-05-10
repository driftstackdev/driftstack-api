// V-530.C — dwell time models + element-region-aware click-position bias.
//
// Third sub-slice of V-530 (per the anti-substitution clause). Extends
// the touch event distributions from V-530.A with two refinements:
//
//   1. Dwell time models — beyond a flat per-class mean, model the dwell
//      distribution shape (lognormal-flavoured for long-tailed dwell, vs
//      tight gaussian for quick taps).
//   2. Element-region-aware click-position bias — within an element,
//      humans don't tap uniformly: buttons get tapped near the visual
//      affordance edge, links near the underlined text region, images
//      near features (face / focal point). This refines the centerBias
//      from V-530.A into a per-region weighted choice.
//
// Sub-slices remaining:
//   - V-530.D (later) — idle-period jitter + multi-touch gesture sequencing.

import type { ElementBounds, ElementClass, TouchEvent } from './types.js';
import { generateTouchEvent } from './touch.js';

/**
 * Dwell-time distribution shape. Real-world tap durations have a heavy
 * right tail (occasional long hold) — a gaussian model under-counts
 * those. Lognormal-flavoured ("log-skewed") models them better.
 *
 * 'tight'  — narrow gaussian around the mean. Snappy taps (button-like).
 * 'normal' — moderate gaussian. Typical mixed interaction.
 * 'long-tailed' — log-skewed; mean unchanged, right tail extended.
 */
export type DwellShape = 'tight' | 'normal' | 'long-tailed';

/** Per-element-class dwell shape. */
export const DWELL_SHAPES: Readonly<Record<ElementClass, DwellShape>> = Object.freeze({
  button: 'tight',
  link: 'tight',
  input: 'normal',
  image: 'long-tailed',
  video: 'long-tailed',
  'scroll-container': 'long-tailed',
  generic: 'normal',
});

/**
 * Within-element click region. Defines a sub-rectangle of the element's
 * bounds where the click probability is biased. Coordinates are
 * fractions of the element's width / height (0..1).
 *
 * Per-class default regions ship below; callers can override for custom
 * components (e.g. a button with a non-centred icon).
 */
export interface ClickRegion {
  /** Region centre as fraction of element bounds (0..1). */
  center: { x: number; y: number };
  /** Region radius as fraction of element bounds (0..1, max 0.5). */
  radius: { x: number; y: number };
  /** Probability weight (relative). The generator normalises across regions. */
  weight: number;
}

/**
 * Per-element-class click-region maps. Each class declares 1+ regions;
 * the generator samples one weighted by `weight` and then samples a
 * position within that region.
 *
 * Real-world taps on a button are tightly clustered near the visual
 * affordance edge (where finger pressure feels "right"), not perfectly
 * centred — but close enough that one centre-biased region captures the
 * essence. Images get 2 regions (centre for focal-point content +
 * upper-half for caption-tap on annotated images).
 */
export const CLICK_REGIONS: Readonly<Record<ElementClass, readonly ClickRegion[]>> = Object.freeze({
  button: [
    {
      center: { x: 0.5, y: 0.5 },
      radius: { x: 0.18, y: 0.22 },
      weight: 1.0,
    },
  ],
  link: [
    // Underlined text region tends to be slightly above element centre
    // (text baseline is above geometric centre for typical link styling).
    {
      center: { x: 0.5, y: 0.45 },
      radius: { x: 0.3, y: 0.2 },
      weight: 1.0,
    },
  ],
  input: [
    // Input click typically lands left-of-centre (placeholder text area).
    {
      center: { x: 0.4, y: 0.5 },
      radius: { x: 0.25, y: 0.18 },
      weight: 1.0,
    },
  ],
  image: [
    // Focal-point centre.
    {
      center: { x: 0.5, y: 0.5 },
      radius: { x: 0.3, y: 0.3 },
      weight: 0.7,
    },
    // Upper-half secondary (caption / annotation taps).
    {
      center: { x: 0.5, y: 0.25 },
      radius: { x: 0.4, y: 0.15 },
      weight: 0.3,
    },
  ],
  video: [
    // Play affordance — typically lower-centre.
    {
      center: { x: 0.5, y: 0.65 },
      radius: { x: 0.2, y: 0.15 },
      weight: 0.8,
    },
    // Upper-right (close/exit affordance).
    {
      center: { x: 0.85, y: 0.15 },
      radius: { x: 0.12, y: 0.12 },
      weight: 0.2,
    },
  ],
  'scroll-container': [
    // Scroll touches initiate uniformly across the surface.
    {
      center: { x: 0.5, y: 0.5 },
      radius: { x: 0.4, y: 0.4 },
      weight: 1.0,
    },
  ],
  generic: [
    {
      center: { x: 0.5, y: 0.5 },
      radius: { x: 0.3, y: 0.3 },
      weight: 1.0,
    },
  ],
});

/**
 * Seed-stable PRNG (mulberry32) — mirror of touch.ts for module-local use.
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

function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Sample a dwell-time multiplier from the requested shape. Mean is 1.0
 * across all shapes; only the distribution shape differs.
 *
 * - tight: gaussian-ish (sum of 3 uniforms), σ ≈ 0.08.
 * - normal: gaussian-ish, σ ≈ 0.18.
 * - long-tailed: log-skewed via exp(N(0, σ)). Right tail extends to ~3x
 *   while preserving mean ≈ 1.0 by the lognormal mean-correction
 *   exp(σ²/2).
 */
function sampleDwellMultiplier(rng: () => number, shape: DwellShape): number {
  switch (shape) {
    case 'tight': {
      const u = (rng() + rng() + rng() - 1.5) / Math.sqrt(0.25);
      return Math.max(0.5, 1 + u * 0.08);
    }
    case 'normal': {
      const u = (rng() + rng() + rng() - 1.5) / Math.sqrt(0.25);
      return Math.max(0.5, 1 + u * 0.18);
    }
    case 'long-tailed': {
      // Box-Muller → normal(0, 1); shape via lognormal.
      const u1 = Math.max(rng(), 1e-9);
      const u2 = rng();
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
      const sigma = 0.4;
      // Lognormal with E[X] = exp(μ + σ²/2). To get mean = 1, set μ = -σ²/2.
      return Math.exp(-((sigma * sigma) / 2) + sigma * z);
    }
  }
}

export interface GenerateRegionAwareTouchOpts {
  elementClass: ElementClass;
  bounds: ElementBounds;
  /**
   * Optional custom region map. Overrides the per-class default. Useful
   * for components with non-standard affordance layout (e.g. a button
   * with an icon on the left edge).
   */
  regions?: readonly ClickRegion[];
  /** Optional seed override. */
  seed?: string;
}

/** Result of the region-aware touch generator. */
export interface RegionAwareTouchEvent extends TouchEvent {
  /**
   * Which region (0-indexed into the class's region map) the click landed
   * in. Lets callers report or test the region-weighting empirically.
   */
  selectedRegionIndex: number;
  /** The dwell-shape applied. */
  dwellShape: DwellShape;
  /** The dwell multiplier sampled (1.0 = at-class-mean). */
  dwellMultiplier: number;
}

/**
 * Generate a region-aware touch event. Builds on V-530.A's
 * `generateTouchEvent` by:
 *   - Picking one ClickRegion weighted by `weight`.
 *   - Computing region-local bounds within the element.
 *   - Calling `generateTouchEvent` against the region-local bounds (so
 *     the V-530.A position-jitter logic operates inside the region, not
 *     the full element).
 *   - Sampling a dwell-shape multiplier and scaling the touch's
 *     durationMs + sample tMs values proportionally.
 *
 * Deterministic given (elementClass, bounds, regions?, seed).
 */
export function generateRegionAwareTouchEvent(
  opts: GenerateRegionAwareTouchOpts,
): RegionAwareTouchEvent {
  if (opts.bounds.width <= 0 || opts.bounds.height <= 0) {
    throw new Error(
      `generateRegionAwareTouchEvent: bounds must have positive width + height ` +
        `(got width=${opts.bounds.width}, height=${opts.bounds.height})`,
    );
  }

  const regions = opts.regions ?? CLICK_REGIONS[opts.elementClass];
  if (regions.length === 0) {
    throw new Error(
      `generateRegionAwareTouchEvent: at least one region required for ${opts.elementClass}`,
    );
  }

  const seed = opts.seed ?? `region-touch:${opts.elementClass}:${JSON.stringify(opts.bounds)}`;
  const rng = mulberry32(hashSeed(seed));

  // Pick a region weighted by `weight`.
  const totalWeight = regions.reduce((acc, r) => acc + r.weight, 0);
  let pick = rng() * totalWeight;
  let regionIndex = regions.length - 1;
  for (let i = 0; i < regions.length; i += 1) {
    const r = regions[i];
    if (r === undefined) continue;
    pick -= r.weight;
    if (pick <= 0) {
      regionIndex = i;
      break;
    }
  }
  const region = regions[regionIndex];
  if (region === undefined) {
    // Unreachable — regions.length >= 1 is enforced above + regionIndex is
    // initialised to a valid index. The check exists for type narrowing.
    throw new Error('generateRegionAwareTouchEvent: region selection failed');
  }

  // Compute region-local bounds within the element.
  const regionLeft = opts.bounds.x + opts.bounds.width * (region.center.x - region.radius.x);
  const regionTop = opts.bounds.y + opts.bounds.height * (region.center.y - region.radius.y);
  const regionWidth = opts.bounds.width * region.radius.x * 2;
  const regionHeight = opts.bounds.height * region.radius.y * 2;
  const regionBounds: ElementBounds = {
    x: regionLeft,
    y: regionTop,
    width: Math.max(1, regionWidth),
    height: Math.max(1, regionHeight),
  };

  // Generate a touch event against the region bounds. Reuse V-530.A.
  const baseTouch = generateTouchEvent({
    elementClass: opts.elementClass,
    bounds: regionBounds,
    seed: `${seed}:region${regionIndex}`,
  });

  // Apply dwell-shape multiplier on top of V-530.A's per-class jitter.
  const dwellShape = DWELL_SHAPES[opts.elementClass];
  const dwellMultiplier = sampleDwellMultiplier(rng, dwellShape);
  const scaledDuration = Math.max(1, baseTouch.durationMs * dwellMultiplier);
  const scaledSamples = baseTouch.samples.map((s) => ({
    ...s,
    tMs: s.tMs * dwellMultiplier,
  }));

  return {
    ...baseTouch,
    // Bounds stay the original element's bounds — the start/end coords
    // are inside the region but bounds describes the targeted element.
    bounds: opts.bounds,
    samples: scaledSamples,
    durationMs: scaledDuration,
    selectedRegionIndex: regionIndex,
    dwellShape,
    dwellMultiplier,
  };
}
