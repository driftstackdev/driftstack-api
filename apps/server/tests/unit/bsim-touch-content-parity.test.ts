// W452.C — drift guard for packages/behavioural-simulation/src/touch.ts.
// V-530.A per-element-class touch event distributions. Drift here
// either drops the 7-entry TOUCH_DISTRIBUTIONS table (a class falls
// through to `undefined` and crashes at the sampling site) or
// breaks the mulberry32+FNV-1a deterministic PRNG (test seed
// outputs flake across runs / Node versions) or weakens the
// bounds-clip on startX/startY/endX/endY (samples escape the
// element rectangle, breaking the property-based invariant that
// tests assert).
//
//   • V-530.A framing pinned + Phase 3 real-implementation +
//     sub-slices B/C/D rationale.
//   • NO-collected-behavioural-data framing pinned.
//   • TOUCH_DISTRIBUTIONS: 7-class Object.freeze table; framing
//     'class-typical and chosen to produce visibly distinct touch
//     shapes across classes'.
//   • mulberry32 PRNG framing pinned: 'Returns a deterministic
//     float in [0, 1) given a 32-bit unsigned integer state' +
//     'no Math.random() allowed' + 'pulling in a full PRNG
//     dependency for this single-module slice is unnecessary
//     npm-weight'.
//   • hashSeed: FNV-1a 32-bit; 'Stable across runs / engines /
//     Node versions' framing pinned.
//   • defaultSeed: `touch:${elementClass}:${JSON.stringify(bounds)}`.
//   • generateTouchEvent: throws on width/height <= 0; pure-function
//     determinism framing pinned.
//   • position generation: biased centre + symmetric jitter + bounds-
//     clip via clip() helper.
//   • drift: triangular(0, meanDrift, 2*meanDrift) magnitude × random
//     unit-circle direction.
//   • dwell + pressure: triangular jitter + bounded clip.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/touch.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W452.C packages/behavioural-simulation/src/touch.ts content parity', () => {
  const body = read(LIB);

  it("V-530.A framing pinned: 'V-530.A — per-element-class touch event distributions.' + 'First module of the Phase 3 real implementation. Slots in behind the same BehaviouralSimulator.generateTouchEvent interface that the stub mock implements; callers do not change.'", () => {
    expect(body).toMatch(/\/\/ V-530\.A — per-element-class touch event distributions\./);
    expect(body).toMatch(
      /\/\/ First module of the Phase 3 real implementation\. Slots in behind the same\s*\n?\s*\/\/ `BehaviouralSimulator\.generateTouchEvent` interface that the stub mock\s*\n?\s*\/\/ implements; callers do not change\. See `interfaces\.ts` for the contract\./,
    );
  });

  it("NO-collected-behavioural-data framing pinned: 'Distributions are class-typical and derived from a synthetic-persona model — NOT from any collected user behaviour. The library carries no behavioural training data per AGENTS.md scope.'", () => {
    expect(body).toMatch(
      /\/\/ Distributions are class-typical and derived from a synthetic-persona\s*\n?\s*\/\/ model — NOT from any collected user behaviour\. The library carries no\s*\n?\s*\/\/ behavioural training data per AGENTS\.md scope\./,
    );
  });

  it('Sub-slices deferred framing pinned: V-530.B (W16) scroll velocity decay + V-530.C (W19) dwell+click-position element-region-aware bias + V-530.D idle-period jitter + multi-touch gesture sequencing', () => {
    expect(body).toMatch(
      /\/\/ Sub-slices deferred:\s*\n?\s*\/\/\s*- V-530\.B \(W16\) — scroll velocity profiles with decay\.\s*\n?\s*\/\/\s*- V-530\.C \(W19\) — dwell time models \+ click-position distributions\s*\n?\s*\/\/\s*refined with element-region-aware bias \(e\.g\. button affordance edge\)\.\s*\n?\s*\/\/\s*- V-530\.D \(later\) — idle-period jitter \+ multi-touch gesture sequencing\./,
    );
  });

  it("TOUCH_DISTRIBUTIONS framing pinned: 'Per-element-class distribution table. Values are class-typical and chosen to produce visibly distinct touch shapes across classes (a button tap differs measurably from a video long-touch or a scroll-container swipe-start).' + Object.freeze + Readonly<Record<ElementClass, TouchDistribution>>", () => {
    expect(body).toMatch(
      /\* Per-element-class distribution table\. Values are class-typical and chosen\s*\n?\s*\*\s*to produce visibly distinct touch shapes across classes \(a `button` tap\s*\n?\s*\*\s*differs measurably from a `video` long-touch or a `scroll-container`\s*\n?\s*\*\s*swipe-start\)\./,
    );
    expect(body).toMatch(
      /export const TOUCH_DISTRIBUTIONS: Readonly<Record<ElementClass, TouchDistribution>> = Object\.freeze\(/,
    );
  });

  it('TOUCH_DISTRIBUTIONS: 7-class entries (button 110ms + link 90ms + input 140ms + image 180ms + video 220ms with centerBias y:0.65 + scroll-container 280ms with meanDriftPx:40 + generic 130ms)', () => {
    expect(body).toMatch(
      /button: \{\s*\n?\s*meanDwellMs: 110,[\s\S]*?meanPressure: 0\.55,\s*\n?\s*\},/,
    );
    expect(body).toMatch(/link: \{\s*\n?\s*meanDwellMs: 90,/);
    expect(body).toMatch(/input: \{\s*\n?\s*meanDwellMs: 140,/);
    expect(body).toMatch(/image: \{\s*\n?\s*meanDwellMs: 180,/);
    expect(body).toMatch(
      /video: \{\s*\n?\s*meanDwellMs: 220,[\s\S]*?centerBias: \{ x: 0\.5, y: 0\.65 \},/,
    );
    expect(body).toMatch(
      /'scroll-container': \{\s*\n?\s*meanDwellMs: 280,[\s\S]*?meanDriftPx: 40,[\s\S]*?sampleCount: 8,/,
    );
    expect(body).toMatch(/generic: \{\s*\n?\s*meanDwellMs: 130,/);
  });

  it("mulberry32 PRNG framing pinned: 'Returns a deterministic float in [0, 1) given a 32-bit unsigned integer state, advancing on each call.' + 'no Math.random() allowed' + 'pulling in a full PRNG dependency for this single-module slice is unnecessary npm-weight'", () => {
    expect(body).toMatch(
      /\* Seeded PRNG \(mulberry32\)\. Returns a deterministic float in \[0, 1\) given\s*\n?\s*\*\s*a 32-bit unsigned integer state, advancing on each call\./,
    );
    expect(body).toMatch(
      /\* Used here because the generator must be reproducible given a string seed —\s*\n?\s*\*\s*no `Math\.random\(\)` allowed — and because pulling in a full PRNG dependency\s*\n?\s*\*\s*for this single-module slice is unnecessary npm-weight\./,
    );
    expect(body).toMatch(
      /function mulberry32\(seedNum: number\): \(\) => number \{\s*\n?\s*let state = seedNum >>> 0;[\s\S]*?state = \(state \+ 0x6d2b79f5\) >>> 0;[\s\S]*?return \(\(t \^ \(t >>> 14\)\) >>> 0\) \/ 4294967296;/,
    );
  });

  it("hashSeed FNV-1a 32-bit framing pinned: 'Hash a string seed to a 32-bit unsigned integer using FNV-1a. Stable across runs / engines / Node versions.' + FNV offset 0x811c9dc5 + FNV prime 0x01000193", () => {
    expect(body).toMatch(
      /\* Hash a string seed to a 32-bit unsigned integer using FNV-1a\. Stable\s*\n?\s*\*\s*across runs \/ engines \/ Node versions\./,
    );
    expect(body).toMatch(
      /function hashSeed\(seed: string\): number \{\s*\n?\s*let h = 0x811c9dc5;[\s\S]*?h \^= seed\.charCodeAt\(i\);\s*\n?\s*h = Math\.imul\(h, 0x01000193\);/,
    );
  });

  it('defaultSeed: `touch:${elementClass}:${JSON.stringify(bounds)}` format', () => {
    expect(body).toMatch(
      /function defaultSeed\(opts: \{ elementClass: ElementClass; bounds: ElementBounds \}\): string \{\s*\n?\s*return `touch:\$\{opts\.elementClass\}:\$\{JSON\.stringify\(opts\.bounds\)\}`;\s*\n?\s*\}/,
    );
  });

  it("generateTouchEvent framing pinned: 'Pure function: identical (elementClass, bounds, seed) inputs always produce identical output.' + throws on width<=0 || height<=0 with bounds context in error message", () => {
    expect(body).toMatch(
      /\* Generate a touch event sampled from the per-class distribution\. Pure\s*\n?\s*\*\s*function: identical \(elementClass, bounds, seed\) inputs always produce\s*\n?\s*\*\s*identical output\./,
    );
    expect(body).toMatch(
      /if \(opts\.bounds\.width <= 0 \|\| opts\.bounds\.height <= 0\) \{\s*\n?\s*throw new Error\(\s*\n?\s*`generateTouchEvent: element bounds must have positive width \+ height ` \+\s*\n?\s*`\(got width=\$\{opts\.bounds\.width\}, height=\$\{opts\.bounds\.height\}\)`,\s*\n?\s*\);/,
    );
  });

  it('position generation: biased centre + symmetric jitter; uniformSigned = rng() * 2 - 1; startX/Y/endX/Y clipped via clip() to bounds rectangle', () => {
    expect(body).toMatch(/const uniformSigned = \(\): number => rng\(\) \* 2 - 1;/);
    expect(body).toMatch(
      /const biasX = opts\.bounds\.x \+ opts\.bounds\.width \* dist\.centerBias\.x;\s*\n?\s*const biasY = opts\.bounds\.y \+ opts\.bounds\.height \* dist\.centerBias\.y;/,
    );
    expect(body).toMatch(
      /const startX = clip\(biasX \+ jitterX, opts\.bounds\.x, opts\.bounds\.x \+ opts\.bounds\.width\);\s*\n?\s*const startY = clip\(biasY \+ jitterY, opts\.bounds\.y, opts\.bounds\.y \+ opts\.bounds\.height\);/,
    );
  });

  it('drift: random unit-circle direction × triangular(0, meanDrift, 2*meanDrift) magnitude; cos/sin angle decomposition; endX/endY bounds-clipped', () => {
    expect(body).toMatch(
      /\/\/ Drift: random unit-circle direction times triangular\(0, meanDrift, 2\*meanDrift\)\.\s*\n?\s*const angle = rng\(\) \* Math\.PI \* 2;\s*\n?\s*const driftMag = \(rng\(\) \+ rng\(\)\) \* dist\.meanDriftPx;[\s\S]*?\/\/ triangular \[0, 2\*mean\]/,
    );
    expect(body).toMatch(
      /const endX = clip\(\s*\n?\s*startX \+ Math\.cos\(angle\) \* driftMag,\s*\n?\s*opts\.bounds\.x,\s*\n?\s*opts\.bounds\.x \+ opts\.bounds\.width,\s*\n?\s*\);/,
    );
  });

  it('dwell + pressure: triangular sum-of-uniforms jitter; durationMs = max(1, meanDwell + jitter); meanPressure ± uniform(-0.1, 0.1) clipped to [0,1]; per-sample pressure noise ±0.05', () => {
    expect(body).toMatch(
      /\/\/ Dwell duration: mean ± triangular jitter \(sum of two uniforms - 1\)\.\s*\n?\s*const dwellJitter = \(rng\(\) \+ rng\(\) - 1\) \* dist\.dwellJitterMs;\s*\n?\s*const durationMs = Math\.max\(1, dist\.meanDwellMs \+ dwellJitter\);/,
    );
    expect(body).toMatch(
      /\/\/ Pressure: mean ± uniform\(-0\.1, 0\.1\), clipped to \[0, 1\]\.\s*\n?\s*const meanPressureJitter = uniformSigned\(\) \* 0\.1;\s*\n?\s*const basePressure = clip\(dist\.meanPressure \+ meanPressureJitter, 0, 1\);/,
    );
    expect(body).toMatch(/pressure: clip\(basePressure \+ uniformSigned\(\) \* 0\.05, 0, 1\),/);
  });

  it('samples: monotonic tMs from 0 to durationMs; sampleCount===1 edge-case sets t=0; clip() helper bounded by [lo, hi]', () => {
    expect(body).toMatch(
      /const t = dist\.sampleCount === 1 \? 0 : i \/ \(dist\.sampleCount - 1\);/,
    );
    expect(body).toMatch(
      /function clip\(value: number, lo: number, hi: number\): number \{\s*\n?\s*if \(value < lo\) return lo;\s*\n?\s*if \(value > hi\) return hi;\s*\n?\s*return value;\s*\n?\s*\}/,
    );
  });

  it('finite bounds must also have finitely representable right and bottom edges', () => {
    expect(body).toContain(
      "requireFinite('generateTouchEvent: bounds right edge', opts.bounds.x + opts.bounds.width);",
    );
    expect(body).toContain(
      "requireFinite('generateTouchEvent: bounds bottom edge', opts.bounds.y + opts.bounds.height);",
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
