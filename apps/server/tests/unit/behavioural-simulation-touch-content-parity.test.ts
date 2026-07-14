// W596.A — drift guard for packages/behavioural-simulation/src/touch.ts.
// V-530.A per-element-class touch event distributions + deterministic
// mulberry32 PRNG + FNV-1a seed hash.

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

describe('W596.A packages/behavioural-simulation/src/touch.ts content parity', () => {
  const body = read(LIB);

  it('V-530.A framing + synthetic-persona model + NO-collected-user-behaviour AGENTS.md scope rationale + sub-slice B/C/D deferral pinned', () => {
    expect(body).toMatch(/\/\/ V-530\.A — per-element-class touch event distributions\./);
    expect(body).toMatch(
      /First module of the Phase 3 real implementation\. Slots in behind the same/,
    );
    expect(body).toMatch(/`BehaviouralSimulator\.generateTouchEvent` interface that the stub mock/);
    expect(body).toMatch(
      /\/\/ Distributions are class-typical and derived from a synthetic-persona/,
    );
    expect(body).toMatch(
      /\/\/ model — NOT from any collected user behaviour\. The library carries no/,
    );
    expect(body).toMatch(/\/\/ behavioural training data per AGENTS\.md scope\./);
    expect(body).toMatch(/\/\/ Sub-slices deferred:/);
    expect(body).toMatch(/\/\/\s+- V-530\.B \(W16\) — scroll velocity profiles with decay\./);
    expect(body).toMatch(
      /\/\/\s+- V-530\.C \(W19\) — dwell time models \+ click-position distributions/,
    );
    expect(body).toMatch(
      /\/\/\s+- V-530\.D \(later\) — idle-period jitter \+ multi-touch gesture sequencing\./,
    );
  });

  it('TOUCH_DISTRIBUTIONS Object.freeze table: 7 ElementClass entries (button/link/input/image/video/scroll-container/generic) with class-typical values pinned', () => {
    expect(body).toMatch(
      /export const TOUCH_DISTRIBUTIONS: Readonly<Record<ElementClass, TouchDistribution>> = Object\.freeze\(/,
    );
    expect(body).toMatch(/button: \{\s*\n\s*meanDwellMs: 110,/);
    expect(body).toMatch(/dwellJitterMs: 30,/);
    expect(body).toMatch(/centerBias: \{ x: 0\.5, y: 0\.5 \},/);
    expect(body).toMatch(/link: \{\s*\n\s*meanDwellMs: 90,/);
    expect(body).toMatch(/input: \{\s*\n\s*meanDwellMs: 140,/);
    expect(body).toMatch(/image: \{\s*\n\s*meanDwellMs: 180,/);
    expect(body).toMatch(/video: \{\s*\n\s*meanDwellMs: 220,/);
    expect(body).toMatch(/centerBias: \{ x: 0\.5, y: 0\.65 \},/);
    expect(body).toMatch(/'scroll-container': \{\s*\n\s*meanDwellMs: 280,/);
    expect(body).toMatch(/meanDriftPx: 40,/);
    expect(body).toMatch(/generic: \{\s*\n\s*meanDwellMs: 130,/);
  });

  it('mulberry32 PRNG + FNV-1a hashSeed + defaultSeed `touch:{class}:{bounds}` framing pinned (NO Math.random; deterministic-given-string-seed)', () => {
    expect(body).toMatch(
      /\* Seeded PRNG \(mulberry32\)\. Returns a deterministic float in \[0, 1\) given/,
    );
    expect(body).toMatch(/\* a 32-bit unsigned integer state, advancing on each call\./);
    expect(body).toMatch(
      /\* Used here because the generator must be reproducible given a string seed —/,
    );
    expect(body).toMatch(/\* no `Math\.random\(\)` allowed/);
    expect(body).toMatch(/^function mulberry32\(seedNum: number\): \(\) => number \{$/m);
    expect(body).toMatch(/let state = seedNum >>> 0;/);
    expect(body).toMatch(/state = \(state \+ 0x6d2b79f5\) >>> 0;/);
    expect(body).toMatch(/return \(\(t \^ \(t >>> 14\)\) >>> 0\) \/ 4294967296;/);
    expect(body).toMatch(/\* Hash a string seed to a 32-bit unsigned integer using FNV-1a\./);
    expect(body).toMatch(/^function hashSeed\(seed: string\): number \{$/m);
    expect(body).toMatch(/let h = 0x811c9dc5;/);
    expect(body).toMatch(/h = Math\.imul\(h, 0x01000193\);/);
    expect(body).toMatch(
      /function defaultSeed\(opts: \{ elementClass: ElementClass; bounds: ElementBounds \}\): string \{/,
    );
    expect(body).toMatch(
      /return `touch:\$\{opts\.elementClass\}:\$\{JSON\.stringify\(opts\.bounds\)\}`;/,
    );
  });

  it('generateTouchEvent pure-function: bounds-width/height>0 throws + biased-centre+symmetric-jitter clipped + drift via unit-circle direction × triangular[0,2×mean] + dwell mean±triangular-jitter (sum of 2 uniforms - 1) + pressure mean±uniform(-0.1,0.1) clipped [0,1] + sampleCount monotonic tMs', () => {
    expect(body).toMatch(
      /\* Generate a touch event sampled from the per-class distribution\. Pure/,
    );
    expect(body).toMatch(
      /\* function: identical \(elementClass, bounds, seed\) inputs always produce/,
    );
    expect(body).toMatch(/\* identical output\./);
    expect(body).toMatch(
      /export function generateTouchEvent\(opts: \{\s*\n\s*elementClass: ElementClass;\s*\n\s*bounds: ElementBounds;\s*\n\s*seed\?: string;\s*\n\}\): TouchEvent \{/,
    );
    expect(body).toMatch(/\['x', opts\.bounds\.x\],[\s\S]*?\['height', opts\.bounds\.height\],/);
    expect(body).toMatch(/requireFinite\(`generateTouchEvent: bounds\.\$\{name\}`, value\);/);
    expect(body).toMatch(
      /if \(opts\.bounds\.width <= 0 \|\| opts\.bounds\.height <= 0\) \{\s*\n\s*throw new Error\(/,
    );
    expect(body).toMatch(
      /`generateTouchEvent: element bounds must have positive width \+ height ` \+/,
    );
    expect(body).toMatch(/const dist = TOUCH_DISTRIBUTIONS\[opts\.elementClass\];/);
    expect(body).toMatch(/const rng = mulberry32\(hashSeed\(seed\)\);/);
    expect(body).toMatch(/\/\/ Helper: uniform in \[-1, 1\)\./);
    expect(body).toMatch(/const uniformSigned = \(\): number => rng\(\) \* 2 - 1;/);
    expect(body).toMatch(/\/\/ Position: biased centre \+ symmetric jitter, clipped to bounds\./);
    expect(body).toMatch(
      /const biasX = opts\.bounds\.x \+ opts\.bounds\.width \* dist\.centerBias\.x;/,
    );
    expect(body).toMatch(
      /\/\/ Drift: random unit-circle direction times triangular\(0, meanDrift, 2\*meanDrift\)\./,
    );
    expect(body).toMatch(
      /const driftMag = \(rng\(\) \+ rng\(\)\) \* dist\.meanDriftPx; \/\/ triangular \[0, 2\*mean\]/,
    );
    expect(body).toMatch(
      /\/\/ Dwell duration: mean ± triangular jitter \(sum of two uniforms - 1\)\./,
    );
    expect(body).toMatch(/const dwellJitter = \(rng\(\) \+ rng\(\) - 1\) \* dist\.dwellJitterMs;/);
    expect(body).toMatch(/const durationMs = Math\.max\(1, dist\.meanDwellMs \+ dwellJitter\);/);
    expect(body).toMatch(/\/\/ Pressure: mean ± uniform\(-0\.1, 0\.1\), clipped to \[0, 1\]\./);
    expect(body).toMatch(/const meanPressureJitter = uniformSigned\(\) \* 0\.1;/);
    expect(body).toMatch(/pressure: clip\(basePressure \+ uniformSigned\(\) \* 0\.05, 0, 1\),/);
    expect(body).toMatch(
      /^function clip\(value: number, lo: number, hi: number\): number \{\s*\n\s*if \(value < lo\) return lo;\s*\n\s*if \(value > hi\) return hi;\s*\n\s*return value;\s*\n\}/m,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
