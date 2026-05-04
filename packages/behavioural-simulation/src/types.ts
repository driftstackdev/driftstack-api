// Phase 3 domain types — V-127 stub.
//
// Defines the shapes the behavioural simulator produces so consumers
// (drivers, GUI client, recipe runner) can depend on them now while
// Phase 3 swaps in the real implementation later.
//
// NO domain logic in this package — just types + interfaces + mock.
// The real generators ship as a separate Phase 3 package and slot in
// behind the same interface (see `interfaces.ts:BehaviouralSimulator`).

/** Cubic-bezier control points describing a mouse path between two screen points. */
export interface MouseTrajectory {
  /** Start screen coordinate. */
  from: { x: number; y: number };
  /** End screen coordinate. */
  to: { x: number; y: number };
  /** Sampled intermediate points. Length = `samples`. */
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
  /** Inter-keystroke delay in ms, length = `text.length`. */
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
 * Top-level behavioural profile — bundles cadence preferences for a
 * synthetic persona. Real generators sample these once at session-start
 * and apply them to every interaction within the session for coherence.
 */
export interface BehaviouralProfile {
  /** Stable identifier for this profile (e.g. `'casual_browser_us'`). */
  id: string;
  /** Mean inter-keystroke delay (ms). Real generators add jitter around this. */
  meanKeyDelayMs: number;
  /** Mean mouse travel speed (px/ms). */
  meanMouseSpeedPxPerMs: number;
  /** Mean scroll velocity (px/tick). */
  meanScrollPxPerTick: number;
  /** Probability the persona pauses between actions (0..1). */
  pauseProbability: number;
  /** Mean pause duration when one fires (ms). */
  meanPauseMs: number;
}
