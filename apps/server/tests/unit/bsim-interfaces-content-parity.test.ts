// W450.C — drift guard for packages/behavioural-simulation/src/interfaces.ts.
// Stable interfaces. Drift here either drops one of the 6
// BehaviouralSimulator methods (drivers + recipe-runner + GUI client
// would compile-fail at the consumer site mid-refactor) or
// silently widens an Opts shape with a required field (existing
// callers stop compiling without a deliberate migration commit).
//
//   • Stable pure-generator seam framing pinned.
//   • imports: ScrollVelocityProfile from ./scroll; 7 type-only
//     from ./types.
//   • GenerateMouseTrajectoryOpts: from/to {x,y} + required profile
//     + optional seed + optional samples (default 32).
//   • GenerateKeyboardCadenceOpts: text + profile (BehaviouralProfile)
//     + optional seed.
//   • GenerateScrollPatternOpts: direction enum (up|down|left|right)
//     + totalDistancePx + profile + optional seed.
//   • GenerateTouchEventOpts: elementClass + bounds (width+height>0)
//     + optional seed.
//   • GenerateScrollVelocityProfileOpts: direction + elementClass +
//     optional initialVelocityPxPerSec + optional decayRate + optional
//     tickIntervalMs (default 16) + optional seed.
//   • BehaviouralSimulator framing pinned: 'Phase 3 ships the real
//     generators (humanlike Bezier mouse paths, hand-position-aware
//     keystroke cadence, naturalistic scroll velocity decay).'
//   • 6 methods: generateMouseTrajectory + generateKeyboardCadence +
//     generateScrollPattern + generateTouchEvent (V-530.A wave 15) +
//     generateScrollVelocityProfile (V-530.B wave 16; distinct from
//     constant-tick generateScrollPattern — finger-flick model) +
//     listProfiles convenience.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/interfaces.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W450.C packages/behavioural-simulation/src/interfaces.ts content parity', () => {
  const body = read(LIB);

  it('stable pure-generator seam framing pinned', () => {
    expect(body).toMatch(
      /\/\/ Stable behavioural-simulation interfaces\. Pure generators slot in behind\s*\/\/ this seam while callers keep one coherent contract\./,
    );
  });

  it('imports: ScrollVelocityProfile type from ./scroll; 7 type-only from ./types (BehaviouralProfile + ElementBounds + ElementClass + KeyboardCadence + MouseTrajectory + ScrollPattern + TouchEvent)', () => {
    expect(body).toMatch(/import type \{ ScrollVelocityProfile \} from '\.\/scroll\.js';/);
    expect(body).toMatch(
      /import type \{\s*BehaviouralProfile,\s*ElementBounds,\s*ElementClass,\s*KeyboardCadence,\s*MouseTrajectory,\s*ScrollPattern,\s*TouchEvent,\s*\} from '\.\/types\.js';/,
    );
  });

  it('GenerateMouseTrajectoryOpts: from/to {x,y} + required profile + optional seed/samples', () => {
    expect(body).toMatch(
      /export interface GenerateMouseTrajectoryOpts \{\s*\/\*\* Finite CSS-pixel start coordinate\. \*\/\s*from: \{ x: number; y: number \};\s*\/\*\* Finite CSS-pixel end coordinate\. \*\/\s*to: \{ x: number; y: number \};\s*\/\*\* Profile whose mean mouse speed determines trajectory duration\. \*\/\s*profile: BehaviouralProfile;/,
    );
    expect(body).toMatch(
      /\/\*\* Optional seed override \(defaults to deterministic per-call seed\)\. \*\/\s*seed\?: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Integer sample count in the implementation's bounded range \(default 32\)\. \*\/\s*samples\?: number;/,
    );
  });

  it("GenerateKeyboardCadenceOpts: 'Profile whose meanKeyDelayMs + jitter shapes the cadence.' framing pinned; text + profile (BehaviouralProfile) + optional seed", () => {
    expect(body).toMatch(
      /export interface GenerateKeyboardCadenceOpts \{\s*text: string;\s*\/\*\* Profile whose meanKeyDelayMs \+ jitter shapes the cadence\. \*\/\s*profile: BehaviouralProfile;\s*seed\?: string;\s*\}/,
    );
  });

  it('GenerateScrollPatternOpts: direction union (up|down|left|right) + totalDistancePx + profile + optional seed', () => {
    expect(body).toMatch(
      /export interface GenerateScrollPatternOpts \{\s*direction: 'up' \| 'down' \| 'left' \| 'right';\s*\/\*\* Positive finite absolute distance\. \*\/\s*totalDistancePx: number;\s*profile: BehaviouralProfile;\s*seed\?: string;\s*\}/,
    );
  });

  it("GenerateTouchEventOpts: elementClass + bounds CSS-px 'width + height must be > 0' framing pinned + optional seed", () => {
    expect(body).toMatch(
      /\/\*\* DOM element class the touch targets\. \*\/\s*elementClass: ElementClass;\s*\/\*\* Element bounds at touch-start \(CSS px\)\. `width` \+ `height` must be > 0\. \*\/\s*bounds: ElementBounds;/,
    );
  });

  it('GenerateScrollVelocityProfileOpts: direction + elementClass + optional initialVelocityPxPerSec + optional decayRate (1/s) + optional tickIntervalMs default 16 + optional seed', () => {
    expect(body).toMatch(
      /\/\*\* Direction of the scroll\. \*\/\s*direction: 'up' \| 'down' \| 'left' \| 'right';\s*\/\*\* Element class the scroll initiates from \(informs defaults\)\. \*\/\s*elementClass: ElementClass;\s*\/\*\* Optional explicit initial velocity \(px\/s\)\. Overrides class default\. \*\/\s*initialVelocityPxPerSec\?: number;\s*\/\*\* Optional explicit decay rate \(1\/s\)\. Overrides class default\. \*\/\s*decayRate\?: number;\s*\/\*\* Optional tick interval \(ms\)\. Default 16 ms\. \*\/\s*tickIntervalMs\?: number;/,
    );
  });

  it("BehaviouralSimulator framing pinned: 'Phase 3 ships the real generators (humanlike Bezier mouse paths, hand-position-aware keystroke cadence, naturalistic scroll velocity decay). Callers — drivers, recipe runner, GUI client — depend on this interface only.'", () => {
    expect(body).toMatch(
      /\* Behavioural simulator interface\. Phase 3 ships the real generators\s*\*\s*\(humanlike Bezier mouse paths, hand-position-aware keystroke\s*\*\s*cadence, naturalistic scroll velocity decay\)\. Callers — drivers,\s*\*\s*recipe runner, GUI client — depend on this interface only\./,
    );
  });

  it('6 BehaviouralSimulator methods: generateMouseTrajectory + generateKeyboardCadence + generateScrollPattern + generateTouchEvent (V-530.A wave 15 framing) + generateScrollVelocityProfile (V-530.B wave 16 framing; finger-flick decay distinct from constant-tick) + listProfiles convenience', () => {
    expect(body).toMatch(
      /generateMouseTrajectory\(opts: GenerateMouseTrajectoryOpts\): MouseTrajectory;/,
    );
    expect(body).toMatch(
      /generateKeyboardCadence\(opts: GenerateKeyboardCadenceOpts\): KeyboardCadence;/,
    );
    expect(body).toMatch(
      /generateScrollPattern\(opts: GenerateScrollPatternOpts\): ScrollPattern;/,
    );
    expect(body).toMatch(
      /\* V-530\.A — added in Wave 15\. Sub-slices C \(dwell \+ click-position\),\s*\*\s*D \(idle jitter \+ multi-touch sequencing\) extend the touch surface\s*\*\s*in later waves\.[\s\S]*?generateTouchEvent\(opts: GenerateTouchEventOpts\): TouchEvent;/,
    );
    expect(body).toMatch(
      /\* Produce a scroll velocity profile with exponential decay starting\s*\*\s*from a finger-flick initial velocity\. Distinct from the constant-tick\s*\*\s*`generateScrollPattern` surface — this is the realistic finger-flick\s*\*\s*model\. V-530\.B — added in Wave 16\.[\s\S]*?generateScrollVelocityProfile\(opts: GenerateScrollVelocityProfileOpts\): ScrollVelocityProfile;/,
    );
    expect(body).toMatch(
      /\/\*\* Convenience: returns the simulator's loaded profile catalogue\. \*\/\s*listProfiles\(\): readonly BehaviouralProfile\[\];/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
