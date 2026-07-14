// W595.C — drift guard for packages/behavioural-simulation/src/index.ts.
// Public-surface re-exports.

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

describe('W595.C packages/behavioural-simulation/src/index.ts content parity', () => {
  const body = read(LIB);

  it('Public surface re-exports types, generators, defaults and allocation caps', () => {
    expect(body).toMatch(/\/\/ @driftstack\/behavioural-simulation public surface\./);
    expect(body).toMatch(
      /^export type \{\s*\n\s*BehaviouralProfile,\s*\n\s*ElementBounds,\s*\n\s*ElementClass,\s*\n\s*KeyboardCadence,\s*\n\s*MouseTrajectory,\s*\n\s*ScrollPattern,\s*\n\s*TouchDistribution,\s*\n\s*TouchEvent,\s*\n\s*TouchSample,\s*\n\} from '\.\/types\.js';/m,
    );
    expect(body).toMatch(
      /^export type \{\s*\n\s*BehaviouralSimulator,\s*\n\s*GenerateKeyboardCadenceOpts,\s*\n\s*GenerateMouseTrajectoryOpts,\s*\n\s*GenerateScrollPatternOpts,\s*\n\s*GenerateScrollVelocityProfileOpts,\s*\n\s*GenerateTouchEventOpts,\s*\n\} from '\.\/interfaces\.js';/m,
    );
    expect(body).toMatch(
      /^export type \{\s*\n\s*ScrollVelocityClassDefaults,\s*\n\s*ScrollVelocityProfile,\s*\n\s*ScrollVelocityTick,\s*\n\} from '\.\/scroll\.js';/m,
    );
    // toContain fragments (not a closed single-line regex) so the two new
    // samples-bound constants (audit fix BSIM-3, 2026-07-01) don't break the pin.
    expect(body).toContain('export {');
    expect(body).toContain('MAX_MOUSE_TRAJECTORY_SAMPLES,');
    expect(body).toContain('MAX_SCROLL_PATTERN_TICKS,');
    expect(body).toContain('MIN_MOUSE_TRAJECTORY_SAMPLES,');
    expect(body).toContain('MockBehaviouralSimulator,');
    expect(body).toContain("} from './mock.js';");
    expect(body).toMatch(
      /^export \{ generateTouchEvent, TOUCH_DISTRIBUTIONS \} from '\.\/touch\.js';$/m,
    );
    // toContain fragments so MIN_TICK_INTERVAL_MS (audit fix BSIM-1,
    // 2026-07-01) doesn't break the pin.
    expect(body).toContain('generateScrollVelocityProfile,');
    expect(body).toContain('MIN_TICK_INTERVAL_MS,');
    expect(body).toContain('SCROLL_VELOCITY_DEFAULTS,');
    expect(body).toContain("} from './scroll.js';");
    expect(body).toMatch(
      /^export type \{\s*\n\s*ClickRegion,\s*\n\s*DwellShape,\s*\n\s*GenerateRegionAwareTouchOpts,\s*\n\s*RegionAwareTouchEvent,\s*\n\} from '\.\/dwell\.js';/m,
    );
    expect(body).toContain('CLICK_REGIONS,');
    expect(body).toContain('DWELL_SHAPES,');
    expect(body).toContain('generateRegionAwareTouchEvent,');
    expect(body).toContain('MAX_CLICK_REGIONS,');
    expect(body).toContain("} from './dwell.js';");
    expect(body).toMatch(/\/\/ V-530\.D — idle-period jitter generator\./);
    expect(body).toMatch(
      /^export type \{\s*\n\s*GenerateIdlePeriodOpts,\s*\n\s*GenerateIdleSequenceOpts,\s*\n\s*IdleClass,\s*\n\s*IdleClassDefaults,\s*\n\s*IdlePeriod,\s*\n\s*IdleSequence,\s*\n\s*IdleSequenceEntry,\s*\n\} from '\.\/idle\.js';/m,
    );
    expect(body).toContain('generateIdlePeriod,');
    expect(body).toContain('generateIdleSequence,');
    expect(body).toContain('IDLE_DEFAULTS,');
    expect(body).toContain('MAX_IDLE_SEQUENCE_ENTRIES,');
    expect(body).toContain("} from './idle.js';");
    expect(body).toMatch(/\/\/ V-530\.E — multi-touch gesture sequencing\./);
    expect(body).toMatch(
      /^export type \{\s*\n\s*FingerSample,\s*\n\s*FingerTrack,\s*\n\s*GestureKind,\s*\n\s*GeneratePinchOpts,\s*\n\s*GenerateTwoFingerScrollOpts,\s*\n\s*GenerateThreeFingerSwipeOpts,\s*\n\s*MultiTouchGesture,\s*\n\} from '\.\/multi-touch\.js';/m,
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
    // V-530.F — keyboard cadence generator (human-realistic typing rhythm).
    expect(body).toMatch(
      /\/\/ V-530\.F — keyboard cadence generator \(human-realistic typing rhythm\)\./,
    );
    // toContain fragments so MAX_TEXT_LENGTH (audit fix BSIM-4, 2026-07-01)
    // doesn't break the pin.
    expect(body).toContain('generateKeyboardCadence, KEYBOARD_CADENCE_DEFAULTS, MAX_TEXT_LENGTH');
    expect(body).toContain("from './keyboard.js';");
    // V-530.G — canonical behavioural persona catalogue.
    expect(body).toMatch(
      /\/\/ V-530\.G — canonical behavioural persona catalogue \(file 05 §"Persona model"\)\./,
    );
    expect(body).toMatch(/export type \{ PersonaId \} from '\.\/profiles\.js';/);
    expect(body).toMatch(
      /export \{ DEFAULT_PERSONA_ID, getProfile, listProfiles, PROFILE_CATALOGUE \} from '\.\/profiles\.js';/,
    );
    // V-530.H — typo-aware typing sequence.
    expect(body).toMatch(
      /\/\/ V-530\.H — typo-aware typing sequence \(file 05 §"Typing behavior"\)\./,
    );
    expect(body).toMatch(
      /^export type \{\s*\n\s*GenerateTypingSequenceOpts,\s*\n\s*KeystrokeEvent,\s*\n\s*TypingSequence,\s*\n\} from '\.\/typing-sequence\.js';/m,
    );
    expect(body).toMatch(
      /^export \{\s*\n\s*DEFAULT_TYPO_PROBABILITY,\s*\n\s*generateTypingSequence,\s*\n\s*MAX_TYPING_REPLAY_EVENTS,\s*\n\s*MAX_TYPING_REPLAY_INSERTED_CODE_UNITS,\s*\n\s*replayTypingSequence,\s*\n\} from '\.\/typing-sequence\.js';/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
