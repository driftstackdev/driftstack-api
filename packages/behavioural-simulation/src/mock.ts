// V-127 mock implementation. Deterministic outputs so tests can
// assert exact shape without RNG flakiness; same inputs ALWAYS
// produce the same outputs (matches the mock-driver discipline used
// elsewhere in the repo: "deterministic; same inputs → same outputs").
//
// Phase 3 ships a non-mock generator behind the same interface.

import type {
  BehaviouralSimulator,
  GenerateKeyboardCadenceOpts,
  GenerateMouseTrajectoryOpts,
  GenerateScrollPatternOpts,
  GenerateScrollVelocityProfileOpts,
  GenerateTouchEventOpts,
} from './interfaces.js';
import { generateScrollVelocityProfile, type ScrollVelocityProfile } from './scroll.js';
import { generateTouchEvent } from './touch.js';
import { splitGraphemes } from './graphemes.js';
import type {
  BehaviouralProfile,
  KeyboardCadence,
  MouseTrajectory,
  ScrollPattern,
  TouchEvent,
} from './types.js';

const DEFAULT_PROFILES: readonly BehaviouralProfile[] = [
  {
    id: 'casual_browser_us',
    meanKeyDelayMs: 120,
    meanMouseSpeedPxPerMs: 0.4,
    meanScrollPxPerTick: 80,
    pauseProbability: 0.25,
    meanPauseMs: 800,
  },
  {
    id: 'fast_typer_dev',
    meanKeyDelayMs: 60,
    meanMouseSpeedPxPerMs: 0.6,
    meanScrollPxPerTick: 120,
    pauseProbability: 0.1,
    meanPauseMs: 300,
  },
];

/**
 * Bounds on `generateMouseTrajectory`'s `samples` option. There is no non-mock
 * mouse-trajectory implementation in this package — this IS the shipped
 * generator — so it gets the same validation as the other generators here.
 * Lower bound: `samples: 0` divides-by-zero in the `t = i / samples`
 * interpolation below (NaN points), so at least 1 is required. Upper bound:
 * a mouse trajectory realistically never needs more than a few hundred to a
 * low few thousand points (the default is 32; even a very deliberate, slow
 * mouse move sampled at a generous 1 kHz over a couple of seconds is still
 * only ~1-2k points), so 1,000 is a generous-but-bounded ceiling — matching
 * MAX_SAMPLES_PER_FINGER in multi-touch.ts for consistency across the
 * package's `samples`-shaped options.
 */
export const MIN_MOUSE_TRAJECTORY_SAMPLES = 1;
export const MAX_MOUSE_TRAJECTORY_SAMPLES = 1000;

function defaultSeed(label: string, opts: unknown): string {
  // Deterministic seed = label + JSON-stringified opts. Stable across
  // calls with identical args; differs when args differ.
  return `${label}:${JSON.stringify(opts)}`;
}

export class MockBehaviouralSimulator implements BehaviouralSimulator {
  constructor(private readonly profiles: readonly BehaviouralProfile[] = DEFAULT_PROFILES) {}

  generateMouseTrajectory(opts: GenerateMouseTrajectoryOpts): MouseTrajectory {
    if (
      opts.samples !== undefined &&
      (opts.samples < MIN_MOUSE_TRAJECTORY_SAMPLES || opts.samples > MAX_MOUSE_TRAJECTORY_SAMPLES)
    ) {
      throw new Error(
        `generateMouseTrajectory: samples must be between ${MIN_MOUSE_TRAJECTORY_SAMPLES} and ` +
          `${MAX_MOUSE_TRAJECTORY_SAMPLES} (got ${opts.samples})`,
      );
    }
    const samples = opts.samples ?? 32;
    const seed = opts.seed ?? defaultSeed('mouse', opts);
    const dx = opts.to.x - opts.from.x;
    const dy = opts.to.y - opts.from.y;
    // Deterministic linear interpolation — the real Phase 3 path is
    // Bezier with humanlike noise; the mock keeps it linear so tests
    // can assert exact midpoints.
    const points: Array<{ x: number; y: number; tMs: number }> = [];
    const durationMs = 250;
    for (let i = 0; i <= samples; i += 1) {
      const t = i / samples;
      points.push({
        x: opts.from.x + dx * t,
        y: opts.from.y + dy * t,
        tMs: t * durationMs,
      });
    }
    return { from: opts.from, to: opts.to, points, durationMs, seed };
  }

  generateKeyboardCadence(opts: GenerateKeyboardCadenceOpts): KeyboardCadence {
    const seed = opts.seed ?? defaultSeed('kb', { text: opts.text, profileId: opts.profile.id });
    // Deterministic constant delay — real path samples around mean
    // with profile-tuned jitter. Keep one delay per Unicode grapheme so the
    // mock cannot hide lone-surrogate events that the real path rejects.
    const delaysMs = splitGraphemes(opts.text).map(() => opts.profile.meanKeyDelayMs);
    const durationMs = delaysMs.reduce((acc, d) => acc + d, 0);
    return { text: opts.text, delaysMs, durationMs, seed };
  }

  generateScrollPattern(opts: GenerateScrollPatternOpts): ScrollPattern {
    const seed = opts.seed ?? defaultSeed('scroll', opts);
    // Constant per-tick delta (no decay) — real path applies velocity
    // decay + occasional reversal jitter.
    const tickPx = opts.profile.meanScrollPxPerTick;
    const tickCount = Math.max(1, Math.ceil(opts.totalDistancePx / tickPx));
    const ticks: Array<{ deltaPx: number; tMs: number }> = [];
    for (let i = 0; i < tickCount; i += 1) {
      ticks.push({ deltaPx: tickPx, tMs: i * 16 });
    }
    return {
      direction: opts.direction,
      totalDistancePx: tickCount * tickPx,
      ticks,
      durationMs: tickCount * 16,
      seed,
    };
  }

  generateTouchEvent(opts: GenerateTouchEventOpts): TouchEvent {
    // The real touch generator is already deterministic + pure (see
    // `touch.ts`), so the mock surface re-uses it directly rather than
    // shipping a separate constant-output stub. Mock/real parity here means
    // callers don't see a behavioural shift when the real Phase 3 simulator
    // ships behind the same interface.
    return generateTouchEvent(opts);
  }

  generateScrollVelocityProfile(opts: GenerateScrollVelocityProfileOpts): ScrollVelocityProfile {
    // Same parity pattern as generateTouchEvent — the real generator is
    // already deterministic + pure.
    return generateScrollVelocityProfile(opts);
  }

  listProfiles(): readonly BehaviouralProfile[] {
    return this.profiles;
  }
}
