// W597.A — drift guard for packages/behavioural-simulation/src/dwell.ts.
// V-530.C dwell time models + region-aware click-position bias.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/dwell.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W597.A packages/behavioural-simulation/src/dwell.ts content parity', () => {
  const body = read(LIB);

  it('V-530.C framing + 2 refinements (dwell-shape + region-aware click bias) + V-530.D deferral pinned', () => {
    expect(body).toMatch(
      /\/\/ V-530\.C — dwell time models \+ element-region-aware click-position bias\./,
    );
    expect(body).toMatch(/\/\/ Third sub-slice of V-530 \(per the anti-substitution clause\)\./);
    expect(body).toMatch(
      /\/\/\s+1\. Dwell time models — beyond a flat per-class mean, model the dwell/,
    );
    expect(body).toMatch(
      /\/\/\s+distribution shape \(lognormal-flavoured for long-tailed dwell, vs/,
    );
    expect(body).toMatch(/\/\/\s+tight gaussian for quick taps\)\./);
    expect(body).toMatch(/\/\/\s+2\. Element-region-aware click-position bias/);
    expect(body).toMatch(
      /\/\/\s+- V-530\.D \(later\) — idle-period jitter \+ multi-touch gesture sequencing\./,
    );
  });

  it('DwellShape 3-value enum (tight/normal/long-tailed) + DWELL_SHAPES per-class assignment + ClickRegion + CLICK_REGIONS per-class arrays pinned', () => {
    expect(body).toMatch(/^export type DwellShape = 'tight' \| 'normal' \| 'long-tailed';$/m);
    expect(body).toMatch(
      /\* 'tight'\s+— narrow gaussian around the mean\. Snappy taps \(button-like\)\./,
    );
    expect(body).toMatch(/\* 'normal' — moderate gaussian\. Typical mixed interaction\./);
    expect(body).toMatch(/\* 'long-tailed' — log-skewed; mean unchanged, right tail extended\./);
    expect(body).toMatch(
      /export const DWELL_SHAPES: Readonly<Record<ElementClass, DwellShape>> = Object\.freeze\(\{\s*\n\s*button: 'tight',\s*\n\s*link: 'tight',\s*\n\s*input: 'normal',\s*\n\s*image: 'long-tailed',\s*\n\s*video: 'long-tailed',\s*\n\s*'scroll-container': 'long-tailed',\s*\n\s*generic: 'normal',\s*\n\}\);/,
    );
    expect(body).toMatch(/^export interface ClickRegion \{$/m);
    expect(body).toMatch(/center: \{ x: number; y: number \};/);
    expect(body).toMatch(
      /\/\*\* Region radius as fraction of element bounds \(0\.\.1, max 0\.5\)\. \*\//,
    );
    expect(body).toMatch(/weight: number;/);
    expect(body).toMatch(
      /export const CLICK_REGIONS: Readonly<Record<ElementClass, readonly ClickRegion\[\]>> = Object\.freeze\(/,
    );
    expect(body).toMatch(/\/\/ Underlined text region tends to be slightly above element centre/);
    expect(body).toMatch(
      /\/\/ Input click typically lands left-of-centre \(placeholder text area\)\./,
    );
    expect(body).toMatch(/\/\/ Focal-point centre\./);
    expect(body).toMatch(/\/\/ Upper-half secondary \(caption \/ annotation taps\)\./);
    expect(body).toMatch(/\/\/ Play affordance — typically lower-centre\./);
    expect(body).toMatch(/\/\/ Upper-right \(close\/exit affordance\)\./);
    expect(body).toMatch(/\/\/ Scroll touches initiate uniformly across the surface\./);
  });

  it('sampleDwellMultiplier 3-shape: tight σ≈0.08 + normal σ≈0.18 + long-tailed Box-Muller→lognormal exp(μ+σ²/2)=1 via μ=-σ²/2 + σ=0.4 + min-clamp 0.5; mean=1.0 invariant pinned', () => {
    expect(body).toMatch(
      /\* Sample a dwell-time multiplier from the requested shape\. Mean is 1\.0/,
    );
    expect(body).toMatch(/\* across all shapes; only the distribution shape differs\./);
    expect(body).toMatch(/\* - tight: gaussian-ish \(sum of 3 uniforms\), σ ≈ 0\.08\./);
    expect(body).toMatch(/\* - normal: gaussian-ish, σ ≈ 0\.18\./);
    expect(body).toMatch(
      /\* - long-tailed: log-skewed via exp\(N\(0, σ\)\)\. Right tail extends to ~3x/,
    );
    expect(body).toMatch(/\* {3}while preserving mean ≈ 1\.0 by the lognormal mean-correction/);
    expect(body).toMatch(/\* {3}exp\(σ²\/2\)\./);
    expect(body).toMatch(
      /function sampleDwellMultiplier\(rng: \(\) => number, shape: DwellShape\): number \{/,
    );
    expect(body).toMatch(/case 'tight': \{/);
    expect(body).toMatch(/return Math\.max\(0\.5, 1 \+ u \* 0\.08\);/);
    expect(body).toMatch(/case 'normal': \{/);
    expect(body).toMatch(/return Math\.max\(0\.5, 1 \+ u \* 0\.18\);/);
    expect(body).toMatch(/case 'long-tailed': \{/);
    expect(body).toMatch(/\/\/ Box-Muller → normal\(0, 1\); shape via lognormal\./);
    expect(body).toMatch(
      /const z = Math\.sqrt\(-2 \* Math\.log\(u1\)\) \* Math\.cos\(2 \* Math\.PI \* u2\);/,
    );
    expect(body).toMatch(/const sigma = 0\.4;/);
    expect(body).toMatch(
      /\/\/ Lognormal with E\[X\] = exp\(μ \+ σ²\/2\)\. To get mean = 1, set μ = -σ²\/2\./,
    );
    expect(body).toMatch(/return Math\.exp\(-\(\(sigma \* sigma\) \/ 2\) \+ sigma \* z\);/);
  });

  it('GenerateRegionAwareTouchOpts + RegionAwareTouchEvent extends TouchEvent + generateRegionAwareTouchEvent: bounds-positive throws + region-weighted-pick + region-local-bounds + reuses V-530.A generateTouchEvent + dwell-multiplier scales durationMs + sample tMs', () => {
    expect(body).toMatch(/^export interface GenerateRegionAwareTouchOpts \{$/m);
    expect(body).toMatch(/Optional custom region map\. Overrides the per-class default\./);
    expect(body).toMatch(/^export interface RegionAwareTouchEvent extends TouchEvent \{$/m);
    expect(body).toMatch(/selectedRegionIndex: number;/);
    expect(body).toMatch(/dwellShape: DwellShape;/);
    expect(body).toMatch(/dwellMultiplier: number;/);
    expect(body).toMatch(/\* Generate a region-aware touch event\. Builds on V-530\.A's/);
    expect(body).toMatch(/\*\s+- Picking one ClickRegion weighted by `weight`\./);
    expect(body).toMatch(/\*\s+- Computing region-local bounds within the element\./);
    expect(body).toMatch(/\*\s+- Calling `generateTouchEvent` against the region-local bounds/);
    expect(body).toMatch(/\* Deterministic given \(elementClass, bounds, regions\?, seed\)\./);
    expect(body).toMatch(
      /export function generateRegionAwareTouchEvent\(\s*\n\s*opts: GenerateRegionAwareTouchOpts,\s*\n\): RegionAwareTouchEvent \{/,
    );
    expect(body).toMatch(
      /requireFinite\(`generateRegionAwareTouchEvent: bounds\.\$\{name\}`, value\);/,
    );
    expect(body).toMatch(
      /requirePositiveFinite\(`generateRegionAwareTouchEvent: region \$\{i\.toString\(\)\} weight`, r\.weight\);/,
    );
    expect(body).toMatch(
      /`generateRegionAwareTouchEvent: bounds must have positive width \+ height ` \+/,
    );
    expect(body).toMatch(
      /`generateRegionAwareTouchEvent: at least one region required for \$\{opts\.elementClass\}`/,
    );
    expect(body).toMatch(/\/\/ Pick a region weighted by `weight`\./);
    expect(body).toMatch(
      /const totalWeight = regions\.reduce\(\(acc, r\) => acc \+ r\.weight, 0\);/,
    );
    expect(body).toMatch(/\/\/ Compute region-local bounds within the element\./);
    expect(body).toMatch(
      /const regionLeft = opts\.bounds\.x \+ opts\.bounds\.width \* \(region\.center\.x - region\.radius\.x\);/,
    );
    expect(body).toMatch(
      /\/\/ Generate a touch event against the region bounds\. Reuse V-530\.A\./,
    );
    expect(body).toMatch(/const baseTouch = generateTouchEvent\(\{/);
    expect(body).toMatch(
      /\/\/ Apply dwell-shape multiplier on top of V-530\.A's per-class jitter\./,
    );
    expect(body).toMatch(/const dwellShape = DWELL_SHAPES\[opts\.elementClass\];/);
    expect(body).toMatch(
      /const scaledDuration = Math\.max\(1, baseTouch\.durationMs \* dwellMultiplier\);/,
    );
    expect(body).toMatch(/tMs: s\.tMs \* dwellMultiplier,/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
