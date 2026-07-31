// Behavioural-simulation domain types. Consumers (drivers, GUI client and
// recipe runner) depend on these stable shapes while the private package's
// pure deterministic generators evolve behind BehaviouralSimulator.

/** Sampled cubic-Bézier mouse path between two screen points. */
export interface MouseTrajectory {
  /** Start screen coordinate. */
  from: { x: number; y: number };
  /** End screen coordinate. */
  to: { x: number; y: number };
  /** Sampled path including both endpoints. Length = `samples + 1`. */
  points: Array<{ x: number; y: number; tMs: number }>;
  /** Total wall-clock duration of the trajectory in ms. */
  durationMs: number;
  /** RNG seed used to generate this trajectory (for reproducibility). */
  seed: string;
}

/** Per-keystroke timing for a typed string. */
export interface KeyboardCadence {
  /** The string typed. */
  text: string;
  /** Per-keystroke delay in ms; `delaysMs[i]` is the delay BEFORE keystroke
   *  `i` (so `delaysMs[0]` is the latency to the first keypress). Length is
   *  the Unicode grapheme count, not the UTF-16 code-unit count. */
  delaysMs: number[];
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** RNG seed used to generate this cadence. */
  seed: string;
}

/** Scroll-by-scroll velocity profile. Distinct from mouse — wheel/touch deltas. */
export interface ScrollPattern {
  /** Direction: 'up', 'down', 'left', 'right'. */
  direction: 'up' | 'down' | 'left' | 'right';
  /** Total distance scrolled (pixels). */
  totalDistancePx: number;
  /** Per-tick deltas + timestamps. */
  ticks: Array<{ deltaPx: number; tMs: number }>;
  /** Total wall-clock duration in ms. */
  durationMs: number;
  /** RNG seed used to generate this pattern. */
  seed: string;
}

/**
 * The DOM element class a touch interaction targets. Distributions differ
 * per class — a `button` tap is short and central; a `video` tap may dwell
 * longer and bias toward the play affordance; a `scroll-container` touch
 * begins a swipe rather than completing a tap.
 *
 * V-530.A — per-element-class distributions. Sub-slices B (scroll velocity),
 * C (dwell + click-position), D (idle jitter + multi-touch) ship later.
 */
export type ElementClass =
  | 'button'
  | 'link'
  | 'input'
  | 'image'
  | 'video'
  | 'scroll-container'
  | 'generic';

/** Rectangular DOM bounds for the touched element (CSS-pixel coordinates). */
export interface ElementBounds {
  /** Left edge (CSS px). */
  x: number;
  /** Top edge (CSS px). */
  y: number;
  /** Width (CSS px). Must be > 0. */
  width: number;
  /** Height (CSS px). Must be > 0. */
  height: number;
}

/** Single pointer sample within a touch sequence. */
export interface TouchSample {
  /** Screen x (CSS px). */
  x: number;
  /** Screen y (CSS px). */
  y: number;
  /** Wall-clock time since touch-start (ms). */
  tMs: number;
  /** Pressure 0..1 (0 = no force info; 1 = max). */
  pressure: number;
}

/**
 * A complete touch interaction — touch-start through touch-end, including
 * any small drift/wobble during the dwell phase.
 */
export interface TouchEvent {
  /** Element class the touch targeted (informs distributions). */
  elementClass: ElementClass;
  /** Element bounds at touch-start. */
  bounds: ElementBounds;
  /** Touch-start coordinate (within bounds, biased by class). */
  start: { x: number; y: number };
  /** Touch-end coordinate (typically within ±2px of start for taps). */
  end: { x: number; y: number };
  /** Pointer samples from start → end, monotonically increasing in `tMs`. */
  samples: readonly TouchSample[];
  /** Total wall-clock duration in ms (samples[last].tMs - samples[0].tMs). */
  durationMs: number;
  /** RNG seed used to generate this event. */
  seed: string;
}

/**
 * Per-class touch-distribution parameters. Each `ElementClass` resolves to
 * one `TouchDistribution`; the simulator samples from it to produce a
 * concrete `TouchEvent`.
 *
 * Means are class-typical; the generator adds bounded jitter around them
 * using a seeded PRNG so outputs are deterministic given a seed.
 */
export interface TouchDistribution {
  /** Mean dwell duration (ms) — touch-start → touch-end. */
  meanDwellMs: number;
  /** ± jitter (ms) around `meanDwellMs`. Triangular distribution. */
  dwellJitterMs: number;
  /** Position bias as fractions of element bounds (0..1; 0.5 = centre). */
  centerBias: { x: number; y: number };
  /** ± jitter around the biased centre, as fractions of bounds (0..1). */
  positionJitter: { x: number; y: number };
  /** Mean drift between touch-start and touch-end (CSS px). */
  meanDriftPx: number;
  /** Number of intermediate samples between start and end (inclusive). */
  sampleCount: number;
  /** Mean pressure 0..1; jitter ± 0.1 around mean. */
  meanPressure: number;
}

/**
 * Top-level behavioural profile — bundles cadence preferences for a
 * synthetic persona. Real generators sample these once at session-start
 * and apply them to every interaction within the session for coherence.
 */
export interface BehaviouralProfile {
  /** Stable identifier for this profile (e.g. `'casual_browser_us'`). */
  readonly id: string;
  /** Mean inter-keystroke delay (ms). Real generators add jitter around this. */
  readonly meanKeyDelayMs: number;
  /** Mean mouse travel speed (px/ms). */
  readonly meanMouseSpeedPxPerMs: number;
  /** Mean scroll velocity (px/tick). */
  readonly meanScrollPxPerTick: number;
  /** Probability the persona pauses between actions (0..1). */
  readonly pauseProbability: number;
  /** Mean pause duration when one fires (ms). */
  readonly meanPauseMs: number;
}
