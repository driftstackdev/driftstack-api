// W595.B — drift guard for packages/behavioural-simulation/src/interfaces.ts.

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

describe('W595.B packages/behavioural-simulation/src/interfaces.ts content parity', () => {
  const body = read(LIB);

  it('V-127 stub-interfaces framing + 5 GenerateOpts (Mouse/Keyboard/Scroll/Touch/ScrollVelocity) + BehaviouralSimulator interface (6-method surface) pinned', () => {
    expect(body).toMatch(/\/\/ V-127 stub interfaces\. The Phase 3 real implementation slots in/);
    expect(body).toMatch(/\/\/ here without changing call sites\./);
    expect(body).toMatch(/^import type \{ ScrollVelocityProfile \} from '\.\/scroll\.js';/m);
    expect(body).toMatch(
      /export interface GenerateMouseTrajectoryOpts \{\s*\n?\s*\/\*\* Finite CSS-pixel start coordinate\. \*\/\s*\n?\s*from: \{ x: number; y: number \};\s*\n?\s*\/\*\* Finite CSS-pixel end coordinate\. \*\/\s*\n?\s*to: \{ x: number; y: number \};/,
    );
    expect(body).toMatch(
      /\/\*\* Optional seed override \(defaults to deterministic per-call seed\)\. \*\/\s*\n?\s*seed\?: string;/,
    );
    expect(body).toMatch(
      /\/\*\* Integer sample count in the implementation's bounded range \(default 32\)\. \*\/\s*\n?\s*samples\?: number;/,
    );
    expect(body).toMatch(/^export interface GenerateKeyboardCadenceOpts \{$/m);
    expect(body).toMatch(/\/\*\* Profile whose meanKeyDelayMs \+ jitter shapes the cadence\. \*\//);
    expect(body).toMatch(
      /export interface GenerateScrollPatternOpts \{\s*\n?\s*direction: 'up' \| 'down' \| 'left' \| 'right';\s*\n?\s*\/\*\* Positive finite absolute distance\. \*\/\s*\n?\s*totalDistancePx: number;/,
    );
    expect(body).toMatch(/^export interface GenerateTouchEventOpts \{$/m);
    expect(body).toMatch(/\/\*\* DOM element class the touch targets\. \*\//);
    expect(body).toMatch(
      /\/\*\* Element bounds at touch-start \(CSS px\)\. `width` \+ `height` must be > 0\. \*\//,
    );
    expect(body).toMatch(/^export interface GenerateScrollVelocityProfileOpts \{$/m);
    expect(body).toMatch(/\/\*\* Direction of the scroll\. \*\//);
    expect(body).toMatch(
      /\/\*\* Optional explicit initial velocity \(px\/s\)\. Overrides class default\. \*\//,
    );
    expect(body).toMatch(
      /\/\*\* Optional explicit decay rate \(1\/s\)\. Overrides class default\. \*\//,
    );
    expect(body).toMatch(/\/\*\* Optional tick interval \(ms\)\. Default 16 ms\. \*\//);
  });

  it('BehaviouralSimulator interface: 6 methods (mouse-trajectory + keyboard-cadence + scroll-pattern + V-530.A touch-event + V-530.B scroll-velocity-profile + listProfiles) + Phase-3-real-generators-humanlike-Bezier framing', () => {
    expect(body).toMatch(/\* Behavioural simulator interface\. Phase 3 ships the real generators/);
    expect(body).toMatch(/\* \(humanlike Bezier mouse paths, hand-position-aware keystroke/);
    expect(body).toMatch(/cadence, naturalistic scroll velocity decay\)\. Callers — drivers,/);
    expect(body).toMatch(/recipe runner, GUI client — depend on this interface only\./);
    expect(body).toMatch(/^export interface BehaviouralSimulator \{$/m);
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
      /\* V-530\.A — added in Wave 15\. Sub-slices C \(dwell \+ click-position\),/,
    );
    expect(body).toMatch(/\* D \(idle jitter \+ multi-touch sequencing\) extend the touch surface/);
    expect(body).toMatch(/generateTouchEvent\(opts: GenerateTouchEventOpts\): TouchEvent;/);
    expect(body).toMatch(/\* Produce a scroll velocity profile with exponential decay starting/);
    expect(body).toMatch(/\* from a finger-flick initial velocity\./);
    expect(body).toMatch(/\* `generateScrollPattern` surface — this is the realistic finger-flick/);
    expect(body).toMatch(/\* model\. V-530\.B — added in Wave 16\./);
    expect(body).toMatch(
      /generateScrollVelocityProfile\(opts: GenerateScrollVelocityProfileOpts\): ScrollVelocityProfile;/,
    );
    expect(body).toMatch(/listProfiles\(\): readonly BehaviouralProfile\[\];/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
