// V-127 stub interfaces. The Phase 3 real implementation slots in
// here without changing call sites.

import type {
  BehaviouralProfile,
  KeyboardCadence,
  MouseTrajectory,
  ScrollPattern,
} from './types.js';

export interface GenerateMouseTrajectoryOpts {
  from: { x: number; y: number };
  to: { x: number; y: number };
  /** Optional seed override (defaults to deterministic per-call seed). */
  seed?: string;
  /** Number of intermediate samples to emit (default 32). */
  samples?: number;
}

export interface GenerateKeyboardCadenceOpts {
  text: string;
  /** Profile whose meanKeyDelayMs + jitter shapes the cadence. */
  profile: BehaviouralProfile;
  seed?: string;
}

export interface GenerateScrollPatternOpts {
  direction: 'up' | 'down' | 'left' | 'right';
  totalDistancePx: number;
  profile: BehaviouralProfile;
  seed?: string;
}

/**
 * Behavioural simulator interface. Phase 3 ships the real generators
 * (humanlike Bezier mouse paths, hand-position-aware keystroke
 * cadence, naturalistic scroll velocity decay). Callers — drivers,
 * recipe runner, GUI client — depend on this interface only.
 */
export interface BehaviouralSimulator {
  /** Produce a sampled mouse path from `from` to `to`. */
  generateMouseTrajectory(opts: GenerateMouseTrajectoryOpts): MouseTrajectory;

  /** Produce per-keystroke timings for a string typed by `profile`. */
  generateKeyboardCadence(opts: GenerateKeyboardCadenceOpts): KeyboardCadence;

  /** Produce a scroll velocity profile in the requested direction. */
  generateScrollPattern(opts: GenerateScrollPatternOpts): ScrollPattern;

  /** Convenience: returns the simulator's loaded profile catalogue. */
  listProfiles(): readonly BehaviouralProfile[];
}
