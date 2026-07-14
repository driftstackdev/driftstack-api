// W597.C — drift guard for packages/behavioural-simulation/src/multi-touch.ts.
// V-530.E multi-touch gesture sequencing (closes V-530 series).

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

describe('W597.C packages/behavioural-simulation/src/multi-touch.ts content parity', () => {
  const body = read(LIB);

  it('V-530.E framing + V-530.D deferred-multi-touch-half + 3 gestures (pinch + two-finger-scroll + three-finger-swipe) + driver-dispatches-interleaved framing pinned', () => {
    expect(body).toMatch(/\/\/ V-530\.E — multi-touch gesture sequencing\./);
    expect(body).toMatch(/Closes the V-530 series\. V-530\.D shipped idle-period jitter but/);
    expect(body).toMatch(/\/\/ explicitly deferred the multi-touch half\. This module is that/);
    expect(body).toMatch(/\/\/ deferred half: per-finger track interleaving for common multi-/);
    expect(body).toMatch(/\/\/ touch gestures \(pinch, two-finger scroll, three-finger swipe\)\./);
    expect(body).toMatch(/\/\/ Each gesture produces a `MultiTouchGesture` — N synchronized/);
    expect(body).toMatch(/\/\/ `FingerTrack`s, each with its own sample sequence\./);
    expect(body).toMatch(/sample sequence\. The driver/);
    expect(body).toMatch(/\/\/ dispatches the per-finger samples in interleaved order so they/);
    expect(body).toMatch(/\/\/ reach the host with the right \(touch-id, t\) shape\./);
    expect(body).toMatch(/\/\/ Gestures shipped:/);
    expect(body).toMatch(
      /\/\/\s+- generatePinchGesture: two fingers, starting from `startCentre`,/,
    );
    expect(body).toMatch(/\/\/\s+moving APART \(zoom in\) or TOGETHER \(zoom out\)\./);
    expect(body).toMatch(/\/\/\s+- generateTwoFingerScrollGesture: two fingers moving in the same/);
    expect(body).toMatch(/\/\/\s+- generateThreeFingerSwipeGesture: three fingers moving in the/);
    expect(body).toMatch(/\/\/\s+same direction \(gesture macOS \/ iOS use for app switching,/);
    expect(body).toMatch(/\/\/\s+mission control, etc\)\./);
  });

  it('FingerSample + FingerTrack + GestureKind 3-value enum + MultiTouchGesture envelope pinned', () => {
    expect(body).toMatch(
      /^export interface FingerSample \{\s*\n\s*\/\*\* Wall-clock ms since gesture start\. \*\/\s*\n\s*tMs: number;/m,
    );
    expect(body).toMatch(/^export interface FingerTrack \{$/m);
    expect(body).toMatch(
      /\/\*\* Stable id for this finger within the gesture \(1, 2, 3, \.\.\.\)\. \*\//,
    );
    expect(body).toMatch(/fingerId: number;/);
    expect(body).toMatch(/samples: readonly FingerSample\[\];/);
    expect(body).toMatch(
      /^export type GestureKind = 'pinch' \| 'two-finger-scroll' \| 'three-finger-swipe';$/m,
    );
    expect(body).toMatch(/^export interface MultiTouchGesture \{$/m);
    expect(body).toMatch(/kind: GestureKind;/);
    expect(body).toMatch(
      /\/\*\* Ordered per-finger tracks\. Index 0 is "finger 1" by convention\. \*\//,
    );
    expect(body).toMatch(/fingers: readonly FingerTrack\[\];/);
    expect(body).toMatch(
      /\/\*\* Total gesture duration \(max sample tMs across all fingers\)\. \*\//,
    );
  });

  it('GeneratePinchOpts: startCentre + startSpanPx + endSpanPx (>start → zoom in; < → zoom out) + default durationMs=320 + samples ≥ 2 default 12 pinned', () => {
    expect(body).toMatch(/^export interface GeneratePinchOpts \{$/m);
    expect(body).toMatch(
      /\/\*\* Centre point the two fingers start from \+ return relative to\. \*\//,
    );
    expect(body).toMatch(/startCentre: \{ x: number; y: number \};/);
    expect(body).toMatch(/\/\*\* Starting span between the two fingers \(CSS px\)\. \*\//);
    expect(body).toMatch(/startSpanPx: number;/);
    expect(body).toMatch(
      /\/\*\* Ending span between the two fingers \(CSS px\)\. Larger than\s*\n\s*\*\s+startSpanPx → zoom in; smaller → zoom out\. \*\//,
    );
    expect(body).toMatch(/endSpanPx: number;/);
    expect(body).toMatch(/\/\*\* Total gesture duration \(ms\)\. Default 320\. \*\//);
    expect(body).toMatch(/durationMs\?: number;/);
    expect(body).toMatch(/\/\*\* Sample count per finger \(≥ 2\)\. Default 12\. \*\//);
  });

  it('Exported 4 generators: generatePinchGesture + generateTwoFingerScrollGesture + generateThreeFingerSwipeGesture + interleaveGestureStream pinned', () => {
    expect(body).toMatch(/export function generatePinchGesture\(/);
    expect(body).toMatch(/export function generateTwoFingerScrollGesture\(/);
    expect(body).toMatch(/export function generateThreeFingerSwipeGesture\(/);
    expect(body).toMatch(/export function interleaveGestureStream\(/);
  });

  it('centipixel quantization carries an exact safe-coordinate envelope', () => {
    expect(body).toContain(
      'export const MAX_ABS_CENTIPIXEL_COORDINATE = Math.floor(Number.MAX_SAFE_INTEGER / 100) - 1;',
    );
    expect(body).toContain('if (Math.abs(value) > MAX_ABS_CENTIPIXEL_COORDINATE) {');
    expect(body).toContain('must be within the centipixel coordinate envelope');
  });

  it('interleave finger, per-finger and aggregate collection caps are pinned', () => {
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
