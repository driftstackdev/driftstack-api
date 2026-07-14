// W450.B — drift guard for packages/behavioural-simulation/src/index.ts.
// @driftstack/behavioural-simulation public surface barrel. Drift
// here either drops a V-530.{A,B,C,D,E} surface export (drivers +
// recipe-runner consumers break when the symbol disappears mid-
// refactor) or accidentally re-exports an internal-only sample
// helper (locks the public API to a name that should not have been
// stable).
//
//   • header framing pinned.
//   • 9 type-only re-exports from ./types.js (BehaviouralProfile +
//     ElementBounds + ElementClass + KeyboardCadence + MouseTrajectory
//     + ScrollPattern + TouchDistribution + TouchEvent + TouchSample).
//   • 5 interface re-exports from ./interfaces.js (BehaviouralSimulator
//     + 4 GenerateXxxOpts).
//   • 3 scroll-velocity types from ./scroll.js (ScrollVelocityClass-
//     Defaults + ScrollVelocityProfile + ScrollVelocityTick).
//   • MockBehaviouralSimulator from ./mock.js (value export).
//   • V-530.A touch surface: generateTouchEvent + TOUCH_DISTRIBUTIONS.
//   • V-530.B scroll velocity: generateScrollVelocityProfile +
//     SCROLL_VELOCITY_DEFAULTS.
//   • V-530.C dwell+region-aware click: 4 type re-exports
//     (ClickRegion + DwellShape + GenerateRegionAwareTouchOpts +
//     RegionAwareTouchEvent) + 3 value exports (CLICK_REGIONS +
//     DWELL_SHAPES + generateRegionAwareTouchEvent).
//   • V-530.D idle-period jitter: comment framing pinned + 7 idle
//     type re-exports + generateIdlePeriod + generateIdleSequence +
//     IDLE_DEFAULTS.
//   • V-530.E multi-touch gesture: comment framing pinned + 7
//     multi-touch type re-exports + 4 multi-touch generator value
//     exports (generatePinchGesture + generateTwoFingerScrollGesture
//     + generateThreeFingerSwipeGesture + interleaveGestureStream).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/index.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W450.B packages/behavioural-simulation/src/index.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: '@driftstack/behavioural-simulation public surface.'", () => {
    expect(body).toMatch(/\/\/ @driftstack\/behavioural-simulation public surface\./);
  });

  it('9 type-only re-exports from ./types.js (BehaviouralProfile + ElementBounds + ElementClass + KeyboardCadence + MouseTrajectory + ScrollPattern + TouchDistribution + TouchEvent + TouchSample)', () => {
    expect(body).toMatch(
      /export type \{\s*\n?\s*BehaviouralProfile,\s*\n?\s*ElementBounds,\s*\n?\s*ElementClass,\s*\n?\s*KeyboardCadence,\s*\n?\s*MouseTrajectory,\s*\n?\s*ScrollPattern,\s*\n?\s*TouchDistribution,\s*\n?\s*TouchEvent,\s*\n?\s*TouchSample,\s*\n?\s*\} from '\.\/types\.js';/,
    );
  });

  it('5 interface re-exports from ./interfaces.js (BehaviouralSimulator + 4 GenerateXxxOpts: KeyboardCadence + MouseTrajectory + ScrollPattern + ScrollVelocityProfile + TouchEvent)', () => {
    expect(body).toMatch(
      /export type \{\s*\n?\s*BehaviouralSimulator,\s*\n?\s*GenerateKeyboardCadenceOpts,\s*\n?\s*GenerateMouseTrajectoryOpts,\s*\n?\s*GenerateScrollPatternOpts,\s*\n?\s*GenerateScrollVelocityProfileOpts,\s*\n?\s*GenerateTouchEventOpts,\s*\n?\s*\} from '\.\/interfaces\.js';/,
    );
  });

  it('3 scroll-velocity types from ./scroll.js (ScrollVelocityClassDefaults + ScrollVelocityProfile + ScrollVelocityTick)', () => {
    expect(body).toMatch(
      /export type \{\s*\n?\s*ScrollVelocityClassDefaults,\s*\n?\s*ScrollVelocityProfile,\s*\n?\s*ScrollVelocityTick,\s*\n?\s*\} from '\.\/scroll\.js';/,
    );
  });

  it('Mock + V-530.A touch + V-530.B scroll velocity value exports: MockBehaviouralSimulator + generateTouchEvent + TOUCH_DISTRIBUTIONS + generateScrollVelocityProfile + SCROLL_VELOCITY_DEFAULTS', () => {
    // toContain fragments (not closed regexes) so the new samples/tick-rate
    // bound constants (audit fixes BSIM-1/BSIM-3, 2026-07-01) don't break these.
    expect(body).toContain('MAX_MOUSE_TRAJECTORY_SAMPLES,');
    expect(body).toContain('MAX_SCROLL_PATTERN_TICKS,');
    expect(body).toContain('MIN_MOUSE_TRAJECTORY_SAMPLES,');
    expect(body).toContain('MockBehaviouralSimulator,');
    expect(body).toContain("} from './mock.js';");
    expect(body).toMatch(
      /export \{ generateTouchEvent, TOUCH_DISTRIBUTIONS \} from '\.\/touch\.js';/,
    );
    expect(body).toContain('generateScrollVelocityProfile,');
    expect(body).toContain('MIN_TICK_INTERVAL_MS,');
    expect(body).toContain('SCROLL_VELOCITY_DEFAULTS,');
    expect(body).toContain("} from './scroll.js';");
  });

  it('V-530.C dwell+region-aware: 4 type re-exports (ClickRegion + DwellShape + GenerateRegionAwareTouchOpts + RegionAwareTouchEvent) + 3 value exports (CLICK_REGIONS + DWELL_SHAPES + generateRegionAwareTouchEvent)', () => {
    expect(body).toMatch(
      /export type \{\s*\n?\s*ClickRegion,\s*\n?\s*DwellShape,\s*\n?\s*GenerateRegionAwareTouchOpts,\s*\n?\s*RegionAwareTouchEvent,\s*\n?\s*\} from '\.\/dwell\.js';/,
    );
    expect(body).toMatch(
      /export \{ CLICK_REGIONS, DWELL_SHAPES, generateRegionAwareTouchEvent \} from '\.\/dwell\.js';/,
    );
  });

  it("V-530.D framing pinned: 'idle-period jitter generator.' + 7 idle type re-exports + 3 value exports (generateIdlePeriod + generateIdleSequence + IDLE_DEFAULTS)", () => {
    expect(body).toMatch(/\/\/ V-530\.D — idle-period jitter generator\./);
    expect(body).toMatch(
      /export type \{\s*\n?\s*GenerateIdlePeriodOpts,\s*\n?\s*GenerateIdleSequenceOpts,\s*\n?\s*IdleClass,\s*\n?\s*IdleClassDefaults,\s*\n?\s*IdlePeriod,\s*\n?\s*IdleSequence,\s*\n?\s*IdleSequenceEntry,\s*\n?\s*\} from '\.\/idle\.js';/,
    );
    expect(body).toMatch(
      /export \{ generateIdlePeriod, generateIdleSequence, IDLE_DEFAULTS \} from '\.\/idle\.js';/,
    );
  });

  it("V-530.E framing pinned: 'multi-touch gesture sequencing.' + 7 multi-touch type re-exports + 4 multi-touch generator value exports", () => {
    expect(body).toMatch(/\/\/ V-530\.E — multi-touch gesture sequencing\./);
    expect(body).toMatch(
      /export type \{\s*\n?\s*FingerSample,\s*\n?\s*FingerTrack,\s*\n?\s*GestureKind,\s*\n?\s*GeneratePinchOpts,\s*\n?\s*GenerateTwoFingerScrollOpts,\s*\n?\s*GenerateThreeFingerSwipeOpts,\s*\n?\s*MultiTouchGesture,\s*\n?\s*\} from '\.\/multi-touch\.js';/,
    );
    // toContain fragments so MAX_SAMPLES_PER_FINGER (audit fix BSIM-2,
    // 2026-07-01) doesn't break the pin.
    expect(body).toContain('generatePinchGesture,');
    expect(body).toContain('generateTwoFingerScrollGesture,');
    expect(body).toContain('generateThreeFingerSwipeGesture,');
    expect(body).toContain('interleaveGestureStream,');
    expect(body).toContain('MAX_SAMPLES_PER_FINGER,');
    expect(body).toContain("} from './multi-touch.js';");
  });

  it("V-530.F framing pinned: 'keyboard cadence generator (human-realistic typing rhythm).' + KeyboardCadenceDefaults type + generateKeyboardCadence + KEYBOARD_CADENCE_DEFAULTS value exports", () => {
    expect(body).toMatch(
      /\/\/ V-530\.F — keyboard cadence generator \(human-realistic typing rhythm\)\./,
    );
    expect(body).toMatch(/export type \{ KeyboardCadenceDefaults \} from '\.\/keyboard\.js';/);
    // toContain fragments so MAX_TEXT_LENGTH (audit fix BSIM-4, 2026-07-01)
    // doesn't break the pin.
    expect(body).toContain('generateKeyboardCadence, KEYBOARD_CADENCE_DEFAULTS, MAX_TEXT_LENGTH');
    expect(body).toContain("from './keyboard.js';");
  });

  it("V-530.G framing pinned: 'canonical behavioural persona catalogue' + PersonaId type + DEFAULT_PERSONA_ID + getProfile + listProfiles + PROFILE_CATALOGUE value exports", () => {
    expect(body).toMatch(
      /\/\/ V-530\.G — canonical behavioural persona catalogue \(file 05 §"Persona model"\)\./,
    );
    expect(body).toMatch(/export type \{ PersonaId \} from '\.\/profiles\.js';/);
    expect(body).toMatch(
      /export \{ DEFAULT_PERSONA_ID, getProfile, listProfiles, PROFILE_CATALOGUE \} from '\.\/profiles\.js';/,
    );
  });

  it("V-530.H framing pinned: 'typo-aware typing sequence' + 3 type re-exports (GenerateTypingSequenceOpts + KeystrokeEvent + TypingSequence) + 3 value exports (DEFAULT_TYPO_PROBABILITY + generateTypingSequence + replayTypingSequence)", () => {
    expect(body).toMatch(
      /\/\/ V-530\.H — typo-aware typing sequence \(file 05 §"Typing behavior"\)\./,
    );
    expect(body).toMatch(
      /export type \{\s*\n\s*GenerateTypingSequenceOpts,\s*\n\s*KeystrokeEvent,\s*\n\s*TypingSequence,\s*\n\} from '\.\/typing-sequence\.js';/,
    );
    expect(body).toMatch(
      /export \{\s*\n\s*DEFAULT_TYPO_PROBABILITY,\s*\n\s*generateTypingSequence,\s*\n\s*replayTypingSequence,\s*\n\} from '\.\/typing-sequence\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
