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
//     RegionAwareTouchEvent) + defaults/generator/MAX_CLICK_REGIONS.
//   • V-530.D idle-period jitter: comment framing pinned + 7 idle
//     type re-exports + generateIdlePeriod + generateIdleSequence +
//     IDLE_DEFAULTS + MAX_IDLE_SEQUENCE_ENTRIES.
//   • V-530.E multi-touch gesture: comment framing pinned + 7
//     multi-touch type re-exports + generators and allocation caps.

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
      /export type \{\s*BehaviouralProfile,\s*ElementBounds,\s*ElementClass,\s*KeyboardCadence,\s*MouseTrajectory,\s*ScrollPattern,\s*TouchDistribution,\s*TouchEvent,\s*TouchSample,\s*\} from '\.\/types\.js';/,
    );
  });

  it('5 interface re-exports from ./interfaces.js (BehaviouralSimulator + 4 GenerateXxxOpts: KeyboardCadence + MouseTrajectory + ScrollPattern + ScrollVelocityProfile + TouchEvent)', () => {
    expect(body).toMatch(
      /export type \{\s*BehaviouralSimulator,\s*GenerateKeyboardCadenceOpts,\s*GenerateMouseTrajectoryOpts,\s*GenerateScrollPatternOpts,\s*GenerateScrollVelocityProfileOpts,\s*GenerateTouchEventOpts,\s*\} from '\.\/interfaces\.js';/,
    );
  });

  it('3 scroll-velocity types from ./scroll.js (ScrollVelocityClassDefaults + ScrollVelocityProfile + ScrollVelocityTick)', () => {
    expect(body).toMatch(
      /export type \{\s*ScrollVelocityClassDefaults,\s*ScrollVelocityProfile,\s*ScrollVelocityTick,\s*\} from '\.\/scroll\.js';/,
    );
  });

  it('mouse generator + Mock + V-530.A touch + V-530.B scroll velocity value exports', () => {
    // toContain fragments (not closed regexes) so the new samples/tick-rate
    // bound constants (audit fixes BSIM-1/BSIM-3, 2026-07-01) don't break these.
    expect(body).toContain('MAX_MOUSE_TRAJECTORY_SAMPLES,');
    expect(body).toContain('MAX_SCROLL_PATTERN_TICKS,');
    expect(body).toContain('MIN_MOUSE_TRAJECTORY_SAMPLES,');
    expect(body).toMatch(
      /export \{ MAX_SCROLL_PATTERN_TICKS, MockBehaviouralSimulator \} from '\.\/mock\.js';/,
    );
    expect(body).toContain("} from './mock.js';");
    expect(body).toContain('generateMouseTrajectory,');
    expect(body).toContain('MOUSE_ARC_LENGTH_SEGMENTS,');
    expect(body).toContain("} from './mouse.js';");
    expect(body).toMatch(
      /export \{ generateTouchEvent, TOUCH_DISTRIBUTIONS \} from '\.\/touch\.js';/,
    );
    expect(body).toContain('generateScrollVelocityProfile,');
    expect(body).toContain('MIN_TICK_INTERVAL_MS,');
    expect(body).toContain('SCROLL_VELOCITY_DEFAULTS,');
    expect(body).toContain("} from './scroll.js';");
  });

  it('V-530.C dwell+region-aware types, generator, defaults and region cap are exported', () => {
    expect(body).toMatch(
      /export type \{\s*ClickRegion,\s*DwellShape,\s*GenerateRegionAwareTouchOpts,\s*RegionAwareTouchEvent,\s*\} from '\.\/dwell\.js';/,
    );
    expect(body).toContain('CLICK_REGIONS,');
    expect(body).toContain('DWELL_SHAPES,');
    expect(body).toContain('generateRegionAwareTouchEvent,');
    expect(body).toContain('MAX_CLICK_REGIONS,');
    expect(body).toContain("} from './dwell.js';");
  });

  it('V-530.D framing, types, generators, defaults and sequence cap are exported', () => {
    expect(body).toMatch(/\/\/ V-530\.D — idle-period jitter generator\./);
    expect(body).toMatch(
      /export type \{\s*GenerateIdlePeriodOpts,\s*GenerateIdleSequenceOpts,\s*IdleClass,\s*IdleClassDefaults,\s*IdlePeriod,\s*IdleSequence,\s*IdleSequenceEntry,\s*\} from '\.\/idle\.js';/,
    );
    expect(body).toContain('generateIdlePeriod,');
    expect(body).toContain('generateIdleSequence,');
    expect(body).toContain('IDLE_DEFAULTS,');
    expect(body).toContain('MAX_IDLE_SEQUENCE_ENTRIES,');
    expect(body).toContain("} from './idle.js';");
  });

  it("V-530.E framing pinned: 'multi-touch gesture sequencing.' + 7 multi-touch type re-exports + 4 multi-touch generator value exports", () => {
    expect(body).toMatch(/\/\/ V-530\.E — multi-touch gesture sequencing\./);
    expect(body).toMatch(
      /export type \{\s*FingerSample,\s*FingerTrack,\s*GestureKind,\s*GeneratePinchOpts,\s*GenerateTwoFingerScrollOpts,\s*GenerateThreeFingerSwipeOpts,\s*MultiTouchGesture,\s*\} from '\.\/multi-touch\.js';/,
    );
    // toContain fragments so MAX_SAMPLES_PER_FINGER (audit fix BSIM-2,
    // 2026-07-01) doesn't break the pin.
    expect(body).toContain('generatePinchGesture,');
    expect(body).toContain('generateTwoFingerScrollGesture,');
    expect(body).toContain('generateThreeFingerSwipeGesture,');
    expect(body).toContain('interleaveGestureStream,');
    expect(body).toContain('MAX_INTERLEAVED_SAMPLES,');
    expect(body).toContain('MAX_INTERLEAVE_FINGERS,');
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

  it("V-530.H framing pinned: 'typo-aware typing sequence' + 3 type re-exports and bounded replay value exports", () => {
    expect(body).toMatch(
      /\/\/ V-530\.H — typo-aware typing sequence \(file 05 §"Typing behavior"\)\./,
    );
    expect(body).toMatch(
      /export type \{\s*\n\s*GenerateTypingSequenceOpts,\s*\n\s*KeystrokeEvent,\s*\n\s*TypingSequence,\s*\n\} from '\.\/typing-sequence\.js';/,
    );
    expect(body).toMatch(
      /export \{\s*\n\s*DEFAULT_TYPO_PROBABILITY,\s*\n\s*generateTypingSequence,\s*\n\s*MAX_TYPING_REPLAY_EVENTS,\s*\n\s*MAX_TYPING_REPLAY_INSERTED_CODE_UNITS,\s*\n\s*replayTypingSequence,\s*\n\} from '\.\/typing-sequence\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
