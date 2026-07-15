// V-127 mock implementation. Deterministic outputs so tests can
// assert exact shape without RNG flakiness; same inputs ALWAYS
// produce the same outputs (matches the mock-driver discipline used
// elsewhere in the repo: "deterministic; same inputs → same outputs").
//
// Pure deterministic mouse, touch and scroll-velocity generators already
// exist, so this reference simulator delegates to them for mock/real parity.

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
import { MAX_TEXT_LENGTH } from './keyboard.js';
import { generateMouseTrajectory } from './mouse.js';
import { requireFinite, requirePositiveFinite } from './validation.js';
import type {
  BehaviouralProfile,
  KeyboardCadence,
  MouseTrajectory,
  ScrollPattern,
  TouchEvent,
} from './types.js';

function immutableProfileSnapshot(
  profiles: readonly BehaviouralProfile[],
): readonly BehaviouralProfile[] {
  return Object.freeze(profiles.map((profile) => Object.freeze({ ...profile })));
}

const DEFAULT_PROFILES: readonly BehaviouralProfile[] = immutableProfileSnapshot([
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
]);

/** Bound the constant-tick mock's only caller-controlled allocation. */
export const MAX_SCROLL_PATTERN_TICKS = 10_000;

function defaultSeed(label: string, opts: unknown): string {
  // Deterministic seed = label + JSON-stringified opts. Stable across
  // calls with identical args; differs when args differ.
  return `${label}:${JSON.stringify(opts)}`;
}

export class MockBehaviouralSimulator implements BehaviouralSimulator {
  private readonly profiles: readonly BehaviouralProfile[];

  constructor(profiles: readonly BehaviouralProfile[] = DEFAULT_PROFILES) {
    this.profiles = immutableProfileSnapshot(profiles);
  }

  generateMouseTrajectory(opts: GenerateMouseTrajectoryOpts): MouseTrajectory {
    // The real mouse generator is deterministic + pure, so delegating keeps
    // consumer behavior identical on the mock and direct function surfaces.
    return generateMouseTrajectory(opts);
  }

  generateKeyboardCadence(opts: GenerateKeyboardCadenceOpts): KeyboardCadence {
    requirePositiveFinite(
      'MockBehaviouralSimulator.generateKeyboardCadence: profile.meanKeyDelayMs',
      opts.profile.meanKeyDelayMs,
    );
    if (opts.text.length > MAX_TEXT_LENGTH) {
      throw new Error(
        `MockBehaviouralSimulator.generateKeyboardCadence: text must be <= ` +
          `${MAX_TEXT_LENGTH} characters (got ${opts.text.length})`,
      );
    }
    const seed = opts.seed ?? defaultSeed('kb', { text: opts.text, profileId: opts.profile.id });
    // Deterministic constant delay — real path samples around mean
    // with profile-tuned jitter. Keep one delay per Unicode grapheme so the
    // mock cannot hide lone-surrogate events that the real path rejects.
    const delaysMs = splitGraphemes(opts.text).map(() => opts.profile.meanKeyDelayMs);
    const durationMs = delaysMs.reduce((acc, d) => acc + d, 0);
    requireFinite('MockBehaviouralSimulator.generateKeyboardCadence: durationMs', durationMs);
    return { text: opts.text, delaysMs, durationMs, seed };
  }

  generateScrollPattern(opts: GenerateScrollPatternOpts): ScrollPattern {
    requirePositiveFinite(
      'MockBehaviouralSimulator.generateScrollPattern: totalDistancePx',
      opts.totalDistancePx,
    );
    requirePositiveFinite(
      'MockBehaviouralSimulator.generateScrollPattern: profile.meanScrollPxPerTick',
      opts.profile.meanScrollPxPerTick,
    );
    const seed = opts.seed ?? defaultSeed('scroll', opts);
    // Constant per-tick delta (no decay) except for the exact final remainder —
    // real path applies velocity decay + occasional reversal jitter.
    const tickPx = opts.profile.meanScrollPxPerTick;
    const tickCount = Math.max(1, Math.ceil(opts.totalDistancePx / tickPx));
    if (tickCount > MAX_SCROLL_PATTERN_TICKS) {
      throw new Error(
        `MockBehaviouralSimulator.generateScrollPattern: tick count must be <= ` +
          `${MAX_SCROLL_PATTERN_TICKS} (got ${tickCount})`,
      );
    }
    const sign = opts.direction === 'up' || opts.direction === 'left' ? -1 : 1;
    const ticks: Array<{ deltaPx: number; tMs: number }> = [];
    let emittedDistancePx = 0;
    for (let i = 0; i < tickCount; i += 1) {
      const magnitudePx = i === tickCount - 1 ? opts.totalDistancePx - emittedDistancePx : tickPx;
      ticks.push({ deltaPx: sign * magnitudePx, tMs: i * 16 });
      emittedDistancePx += magnitudePx;
    }
    return {
      direction: opts.direction,
      totalDistancePx: opts.totalDistancePx,
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
