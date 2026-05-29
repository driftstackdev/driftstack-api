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

  it('Public surface re-exports: types (9) + interfaces (6) + scroll (3 + 2 values) + dwell (4 + 3 values) + V-530.D idle (7 + 3 values) + V-530.E multi-touch (7 + 4 values) pinned', () => {
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
    expect(body).toMatch(/^export \{ MockBehaviouralSimulator \} from '\.\/mock\.js';$/m);
    expect(body).toMatch(
      /^export \{ generateTouchEvent, TOUCH_DISTRIBUTIONS \} from '\.\/touch\.js';$/m,
    );
    expect(body).toMatch(
      /^export \{ generateScrollVelocityProfile, SCROLL_VELOCITY_DEFAULTS \} from '\.\/scroll\.js';$/m,
    );
    expect(body).toMatch(
      /^export type \{\s*\n\s*ClickRegion,\s*\n\s*DwellShape,\s*\n\s*GenerateRegionAwareTouchOpts,\s*\n\s*RegionAwareTouchEvent,\s*\n\} from '\.\/dwell\.js';/m,
    );
    expect(body).toMatch(
      /^export \{ CLICK_REGIONS, DWELL_SHAPES, generateRegionAwareTouchEvent \} from '\.\/dwell\.js';$/m,
    );
    expect(body).toMatch(/\/\/ V-530\.D — idle-period jitter generator\./);
    expect(body).toMatch(
      /^export type \{\s*\n\s*GenerateIdlePeriodOpts,\s*\n\s*GenerateIdleSequenceOpts,\s*\n\s*IdleClass,\s*\n\s*IdleClassDefaults,\s*\n\s*IdlePeriod,\s*\n\s*IdleSequence,\s*\n\s*IdleSequenceEntry,\s*\n\} from '\.\/idle\.js';/m,
    );
    expect(body).toMatch(
      /^export \{ generateIdlePeriod, generateIdleSequence, IDLE_DEFAULTS \} from '\.\/idle\.js';$/m,
    );
    expect(body).toMatch(/\/\/ V-530\.E — multi-touch gesture sequencing\./);
    expect(body).toMatch(
      /^export type \{\s*\n\s*FingerSample,\s*\n\s*FingerTrack,\s*\n\s*GestureKind,\s*\n\s*GeneratePinchOpts,\s*\n\s*GenerateTwoFingerScrollOpts,\s*\n\s*GenerateThreeFingerSwipeOpts,\s*\n\s*MultiTouchGesture,\s*\n\} from '\.\/multi-touch\.js';/m,
    );
    expect(body).toMatch(
      /^export \{\s*\n\s*generatePinchGesture,\s*\n\s*generateTwoFingerScrollGesture,\s*\n\s*generateThreeFingerSwipeGesture,\s*\n\s*interleaveGestureStream,\s*\n\} from '\.\/multi-touch\.js';/m,
    );
    // V-530.F — keyboard cadence generator (human-realistic typing rhythm).
    expect(body).toMatch(
      /\/\/ V-530\.F — keyboard cadence generator \(human-realistic typing rhythm\)\./,
    );
    expect(body).toMatch(
      /^export \{ generateKeyboardCadence, KEYBOARD_CADENCE_DEFAULTS \} from '\.\/keyboard\.js';$/m,
    );
    // V-530.G — canonical behavioural persona catalogue.
    expect(body).toMatch(
      /\/\/ V-530\.G — canonical behavioural persona catalogue \(file 05 §"Persona model"\)\./,
    );
    expect(body).toMatch(/export type \{ PersonaId \} from '\.\/profiles\.js';/);
    expect(body).toMatch(
      /export \{ DEFAULT_PERSONA_ID, getProfile, listProfiles, PROFILE_CATALOGUE \} from '\.\/profiles\.js';/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
