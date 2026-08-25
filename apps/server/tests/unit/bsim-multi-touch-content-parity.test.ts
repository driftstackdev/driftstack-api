// W454.A — drift guard for packages/behavioural-simulation/src/multi-touch.ts.
// V-530.E multi-touch gesture sequencing. Drift here either drops
// the interleaveGestureStream sort (per-finger samples reach the
// driver out of order, host receives an impossible gesture
// chronology) or breaks the buildLinearTrack jitter loop (back-to-
// back gestures produce pixel-perfect identical tracks — the
// detection signal the package exists to defeat).
//
//   • V-530.E framing pinned + 'Closes the V-530 series. V-530.D
//     shipped idle-period jitter but explicitly deferred the multi-
//     touch half.'
//   • 3-gesture catalogue: generatePinchGesture + generateTwoFinger
//     ScrollGesture + generateThreeFingerSwipeGesture.
//   • FingerSample: 4-field (tMs + x + y + pressure 0..1).
//   • FingerTrack: 4-field (fingerId 1/2/3 + start + end + samples
//     readonly).
//   • GestureKind union ('pinch'|'two-finger-scroll'|'three-finger-
//     swipe').
//   • MultiTouchGesture: 4-field (kind + fingers readonly + durationMs
//     'max sample tMs across all fingers' + seed).
//   • GeneratePinchOpts: startCentre + startSpanPx + endSpanPx
//     'Larger than startSpanPx → zoom in; smaller → zoom out' +
//     durationMs default 320 + samples default 12.
//   • GenerateTwoFingerScrollOpts: fingerSeparationPx default 80,
//     durationMs default 220, samples default 10.
//   • GenerateThreeFingerSwipeOpts: fingerSeparationPx default 60,
//     durationMs default 280; centre finger at opts.start.
//   • mulberry32 + FNV-1a (PRNG-shape consistency with rest of
//     package).
//   • dirVector: 4-case (up→{0,-1}, down→{0,1}, left→{-1,0},
//     right→{1,0}).
//   • buildLinearTrack: samples >= 2 invariant; positional jitter
//     ±0.75 framing pinned 'so back-to-back gestures don't reproduce
//     pixel-perfect identical tracks (detectors love that)';
//     pressure ramp 'fraction < 0.15 ? fraction / 0.15 : 1'.
//   • Pinch: finger 1 left of centre, finger 2 right; horizontal
//     pinch.
//   • Three-finger swipe: centre finger at start; 3 fingers laid out
//     horizontally with ±sep on each side.
//   • interleaveGestureStream: time-ordered with stable tie-break on
//     fingerId ascending.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/multi-touch.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W454.A packages/behavioural-simulation/src/multi-touch.ts content parity', () => {
  const body = read(LIB);

  it("V-530.E framing pinned: 'V-530.E — multi-touch gesture sequencing.' + 'Closes the V-530 series. V-530.D shipped idle-period jitter but explicitly deferred the multi-touch half. This module is that deferred half: per-finger track interleaving for common multi-touch gestures (pinch, two-finger scroll, three-finger swipe).'", () => {
    expect(body).toMatch(/\/\/ V-530\.E — multi-touch gesture sequencing\./);
    expect(body).toMatch(
      /\/\/ Closes the V-530 series\. V-530\.D shipped idle-period jitter but\s*\/\/ explicitly deferred the multi-touch half\. This module is that\s*\/\/ deferred half: per-finger track interleaving for common multi-\s*\/\/ touch gestures \(pinch, two-finger scroll, three-finger swipe\)\./,
    );
  });

  it('3-gesture catalogue framing pinned: pinch (APART = zoom in, TOGETHER = zoom out) + two-finger-scroll + three-finger-swipe (macOS / iOS app switching, mission control)', () => {
    expect(body).toMatch(
      /\/\/\s*- generatePinchGesture: two fingers, starting from `startCentre`,\s*\/\/\s*moving APART \(zoom in\) or TOGETHER \(zoom out\)\./,
    );
    expect(body).toMatch(
      /\/\/\s*- generateTwoFingerScrollGesture: two fingers moving in the same\s*\/\/\s*direction by `distancePx`\./,
    );
    expect(body).toMatch(
      /\/\/\s*- generateThreeFingerSwipeGesture: three fingers moving in the\s*\/\/\s*same direction \(gesture macOS \/ iOS use for app switching,\s*\/\/\s*mission control, etc\)\./,
    );
  });

  it("FingerSample: 4-field (tMs + x + y + pressure 0..1); FingerTrack: 4-field (fingerId 'within the gesture (1, 2, 3, ...)' + start + end + samples readonly); GestureKind 3-union; MultiTouchGesture: 4-field with 'max sample tMs across all fingers' framing on durationMs", () => {
    expect(body).toMatch(
      /export interface FingerSample \{[\s\S]*?tMs: number;[\s\S]*?x: number;[\s\S]*?y: number;[\s\S]*?pressure: number;/,
    );
    expect(body).toMatch(
      /export interface FingerTrack \{[\s\S]*?\/\*\* Stable id for this finger within the gesture \(1, 2, 3, \.\.\.\)\. \*\/\s*fingerId: number;[\s\S]*?start: \{ x: number; y: number \};[\s\S]*?end: \{ x: number; y: number \};[\s\S]*?samples: readonly FingerSample\[\];/,
    );
    expect(body).toMatch(
      /export type GestureKind = 'pinch' \| 'two-finger-scroll' \| 'three-finger-swipe';/,
    );
    expect(body).toMatch(
      /export interface MultiTouchGesture \{[\s\S]*?kind: GestureKind;[\s\S]*?\/\*\* Ordered per-finger tracks\. Index 0 is "finger 1" by convention\. \*\/\s*fingers: readonly FingerTrack\[\];[\s\S]*?\/\*\* Total gesture duration \(max sample tMs across all fingers\)\. \*\/\s*durationMs: number;[\s\S]*?seed: string;/,
    );
  });

  it("GeneratePinchOpts: 'Larger than startSpanPx → zoom in; smaller → zoom out' framing pinned; durationMs default 320; samples default 12 (≥ 2); GenerateTwoFingerScrollOpts: fingerSeparationPx default 80, durationMs default 220, samples default 10; GenerateThreeFingerSwipeOpts: fingerSeparationPx default 60, durationMs default 280", () => {
    expect(body).toMatch(
      /\/\*\* Ending span between the two fingers \(CSS px\)\. Larger than\s*\*\s*startSpanPx → zoom in; smaller → zoom out\. \*\/\s*endSpanPx: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Total gesture duration \(ms\)\. Default 320\. \*\/\s*durationMs\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Sample count per finger \(≥ 2\)\. Default 12\. \*\/\s*samples\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Distance between the two fingers \(CSS px\)\. Default 80\. \*\/\s*fingerSeparationPx\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Total gesture duration \(ms\)\. Default 220\. \*\/\s*durationMs\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Distance between adjacent fingers \(CSS px\)\. Default 60\. \*\/\s*fingerSeparationPx\?: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Total gesture duration \(ms\)\. Default 280\. \*\/\s*durationMs\?: number;/,
    );
  });

  it('dirVector: 4-case direction→{dx,dy} (up→{0,-1}, down→{0,1}, left→{-1,0}, right→{1,0})', () => {
    expect(body).toMatch(
      /function dirVector\(dir: 'up' \| 'down' \| 'left' \| 'right'\): \{ dx: number; dy: number \} \{\s*switch \(dir\) \{\s*case 'up':\s*return \{ dx: 0, dy: -1 \};\s*case 'down':\s*return \{ dx: 0, dy: 1 \};\s*case 'left':\s*return \{ dx: -1, dy: 0 \};\s*case 'right':\s*return \{ dx: 1, dy: 0 \};/,
    );
  });

  it('buildLinearTrack validates an integer 2..MAX sample count, preserves exact endpoints, jitters only the interior path and ramps pressure', () => {
    expect(body).toMatch(
      /if \(!Number\.isInteger\(opts\.samples\) \|\| opts\.samples < 2\) \{\s*throw new Error\(\s*`buildLinearTrack: samples must be an integer >= 2 \(got \$\{String\(opts\.samples\)\}\)`,\s*\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(opts\.samples > MAX_SAMPLES_PER_FINGER\) \{\s*throw new Error\(\s*`buildLinearTrack: samples must be <= \$\{MAX_SAMPLES_PER_FINGER\} \(got \$\{opts\.samples\}\)`,\s*\);\s*\}/,
    );
    expect(body).toMatch(/const n = opts\.samples;/);
    expect(body).toMatch(
      /\/\/ Light positional jitter so back-to-back gestures don't reproduce\s*\/\/ pixel-perfect identical tracks \(detectors love that\)\./,
    );
    expect(body).toMatch(
      /const isEndpoint = i === 0 \|\| i === n - 1;\s*const jitterX = isEndpoint \? 0 : \(opts\.rng\(\) - 0\.5\) \* 1\.5;\s*const jitterY = isEndpoint \? 0 : \(opts\.rng\(\) - 0\.5\) \* 1\.5;/,
    );
    expect(body).toMatch(
      /\/\/ Pressure ramps up briefly then plateaus\.\s*const pressure = fraction < 0\.15 \? fraction \/ 0\.15 : 1;/,
    );
  });

  it("generatePinchGesture: horizontal pinch ('finger 1 left, finger 2 right'); fingerId 1 left/finger 2 right; halfStart/halfEnd centre offsets; defaultSeed = `pinch:${startSpan}->${endSpan}`", () => {
    expect(body).toMatch(
      /const seed = opts\.seed \?\? `pinch:\$\{opts\.startSpanPx\}->\$\{opts\.endSpanPx\}`;/,
    );
    expect(body).toMatch(/\/\/ Horizontal pinch — finger 1 left, finger 2 right\./);
    expect(body).toMatch(
      /const finger1 = buildLinearTrack\(\{\s*fingerId: 1,\s*start: \{ x: opts\.startCentre\.x - halfStart, y: opts\.startCentre\.y \},\s*end: \{ x: opts\.startCentre\.x - halfEnd, y: opts\.startCentre\.y \},/,
    );
    expect(body).toMatch(
      /const finger2 = staggerTrackStart\(\s*buildLinearTrack\(\{\s*fingerId: 2,\s*start: \{ x: opts\.startCentre\.x \+ halfStart, y: opts\.startCentre\.y \},\s*end: \{ x: opts\.startCentre\.x \+ halfEnd, y: opts\.startCentre\.y \},/,
    );
    expect(body).toMatch(/kind: 'pinch',\s*fingers: \[finger1, finger2\],/);
  });

  it('generateTwoFingerScrollGesture: f2Start = f1Start + {sep, 0}; both fingers translate by dir × distancePx; defaultSeed = `two-finger-scroll:${direction}:${distancePx}`', () => {
    expect(body).toMatch(
      /const seed = opts\.seed \?\? `two-finger-scroll:\$\{opts\.direction\}:\$\{String\(opts\.distancePx\)\}`;/,
    );
    expect(body).toMatch(
      /const f1Start = \{ x: opts\.start\.x, y: opts\.start\.y \};\s*const f2Start = \{ x: opts\.start\.x \+ sep, y: opts\.start\.y \};/,
    );
    expect(body).toMatch(
      /const f1End = \{\s*x: f1Start\.x \+ dir\.dx \* opts\.distancePx,\s*y: f1Start\.y \+ dir\.dy \* opts\.distancePx,\s*\};/,
    );
    expect(body).toMatch(/kind: 'two-finger-scroll',\s*fingers: \[finger1, finger2\],/);
  });

  it("generateThreeFingerSwipeGesture framing pinned: 'Three fingers laid out horizontally; centre finger at opts.start.' + 3-finger array map; fingerStarts = [-sep, 0, +sep]; defaultSeed = `three-finger-swipe:${direction}:${distancePx}`", () => {
    expect(body).toMatch(
      /const seed = opts\.seed \?\? `three-finger-swipe:\$\{opts\.direction\}:\$\{String\(opts\.distancePx\)\}`;/,
    );
    expect(body).toMatch(
      /\/\/ Three fingers laid out horizontally; centre finger at opts\.start\./,
    );
    expect(body).toMatch(
      /const fingerStarts = \[\s*\{ x: opts\.start\.x - sep, y: opts\.start\.y \},\s*\{ x: opts\.start\.x, y: opts\.start\.y \},\s*\{ x: opts\.start\.x \+ sep, y: opts\.start\.y \},\s*\];/,
    );
    expect(body).toMatch(/kind: 'three-finger-swipe',\s*fingers,/);
  });

  it("interleaveGestureStream framing pinned: 'Interleave per-finger samples into a single time-ordered stream with stable ordering on ties (finger-id ascending). Useful for drivers that need a single dispatch queue.' + sort key (tMs, fingerId asc)", () => {
    expect(body).toMatch(
      /\/\*\* Interleave per-finger samples into a single time-ordered stream\s*\*\s*with stable ordering on ties \(finger-id ascending\)\. Useful for\s*\*\s*drivers that need a single dispatch queue\. \*\//,
    );
    expect(body).toMatch(
      /stream\.sort\(\(a, b\) => \{\s*if \(a\.tMs !== b\.tMs\) return a\.tMs - b\.tMs;\s*return a\.fingerId - b\.fingerId;\s*\}\);/,
    );
  });

  it('Round-to-2-decimal coordinate + pressure quantization in buildLinearTrack (Math.round(x * 100) / 100); tMs rounded to integer ms', () => {
    expect(body).toMatch(/tMs: Math\.round\(opts\.durationMs \* fraction\),/);
    expect(body).toMatch(/x: Math\.round\(x \* 100\) \/ 100,/);
    expect(body).toMatch(/y: Math\.round\(y \* 100\) \/ 100,/);
    expect(body).toMatch(/pressure: Math\.round\(pressure \* 100\) \/ 100,/);
  });

  it('centipixel quantization rejects coordinates outside its safe derived envelope', () => {
    expect(body).toContain(
      'export const MAX_ABS_CENTIPIXEL_COORDINATE = Math.floor(Number.MAX_SAFE_INTEGER / 100) - 1;',
    );
    expect(body).toContain('if (Math.abs(value) > MAX_ABS_CENTIPIXEL_COORDINATE) {');
    expect(body).toContain('must be within the centipixel coordinate envelope');
  });

  it('external interleave collections are capped before copy and sort', () => {
    expect(body).toContain('export const MAX_INTERLEAVE_FINGERS = 10;');
    expect(body).toContain('export const MAX_INTERLEAVED_SAMPLES = 5000;');
    expect(body).toContain('if (gesture.fingers.length > MAX_INTERLEAVE_FINGERS) {');
    expect(body).toContain('if (finger.samples.length > MAX_SAMPLES_PER_FINGER) {');
    expect(body).toContain('if (totalSamples > MAX_INTERLEAVED_SAMPLES) {');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
