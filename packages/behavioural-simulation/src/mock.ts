// V-127 mock implementation. Deterministic outputs so tests can
// assert exact shape without RNG flakiness; same inputs ALWAYS
// produce the same outputs (matches CLAUDE.md mock-driver discipline:
// "deterministic; same inputs → same outputs").
//
// Phase 3 ships a non-mock generator behind the same interface.

import type {
  BehaviouralSimulator,
  GenerateKeyboardCadenceOpts,
  GenerateMouseTrajectoryOpts,
  GenerateScrollPatternOpts,
} from './interfaces.js';
import type {
  BehaviouralProfile,
  KeyboardCadence,
  MouseTrajectory,
  ScrollPattern,
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

function defaultSeed(label: string, opts: unknown): string {
  // Deterministic seed = label + JSON-stringified opts. Stable across
  // calls with identical args; differs when args differ.
  return `${label}:${JSON.stringify(opts)}`;
}

export class MockBehaviouralSimulator implements BehaviouralSimulator {
  constructor(private readonly profiles: readonly BehaviouralProfile[] = DEFAULT_PROFILES) {}

  generateMouseTrajectory(opts: GenerateMouseTrajectoryOpts): MouseTrajectory {
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
    // with profile-tuned jitter.
    const delaysMs = Array.from({ length: opts.text.length }, () => opts.profile.meanKeyDelayMs);
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

  listProfiles(): readonly BehaviouralProfile[] {
    return this.profiles;
  }
}
