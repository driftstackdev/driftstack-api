// W453.C — drift guard for packages/behavioural-simulation/src/dwell.ts.
// V-530.C dwell time models + element-region-aware click-position
// bias. Drift here either drops the dwell-shape multiplier scaling
// (touch durationMs + sample tMs values stop reflecting the per-
// class distribution shape, long-tailed tap dwells revert to flat
// gaussian — detection signal lost) or breaks the region-local
// bounds shrink (region-aware generator delegates to V-530.A with
// the full element rectangle and position-jitter happens at element
// scale rather than region scale).
//
//   • V-530.C framing pinned + anti-substitution clause reference.
//   • DwellShape 3-value union ('tight' button-like + 'normal' mixed
//     + 'long-tailed' log-skewed for image/video/scroll).
//   • DWELL_SHAPES per-class table (button/link 'tight'; input/generic
//     'normal'; image/video/scroll-container 'long-tailed').
//   • ClickRegion: 3-field (center + radius + weight relative).
//   • CLICK_REGIONS framing pinned: 'Real-world taps on a button are
//     tightly clustered near the visual affordance edge ... Images
//     get 2 regions (centre for focal-point content + upper-half for
//     caption-tap on annotated images).'
//   • CLICK_REGIONS table 7-entry; image 2-region (0.7 focal + 0.3
//     upper) + video 2-region (0.8 play-affordance lower-centre +
//     0.2 upper-right close).
//   • sampleDwellMultiplier 3-shape framing pinned: 'Mean is 1.0
//     across all shapes; only the distribution shape differs.';
//     long-tailed via Box-Muller + lognormal mean-correction.
//   • RegionAwareTouchEvent extends TouchEvent + 3 extra fields
//     (selectedRegionIndex + dwellShape + dwellMultiplier).
//   • generateRegionAwareTouchEvent: throws on bounds <=0; throws on
//     empty regions; weighted region pick; region-local bounds
//     shrink before delegating to generateTouchEvent; dwell-multiplier
//     scales durationMs + per-sample tMs.

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

describe('W453.C packages/behavioural-simulation/src/dwell.ts content parity', () => {
  const body = read(LIB);

  it("V-530.C framing pinned: 'V-530.C — dwell time models + element-region-aware click-position bias.' + 'Third sub-slice of V-530 (per the anti-substitution clause).' + two-refinement framing (dwell distribution shape + element-region-aware click bias)", () => {
    expect(body).toMatch(
      /\/\/ V-530\.C — dwell time models \+ element-region-aware click-position bias\./,
    );
    expect(body).toMatch(
      /\/\/ Third sub-slice of V-530 \(per the anti-substitution clause\)\. Extends\s*\/\/ the touch event distributions from V-530\.A with two refinements:/,
    );
    expect(body).toMatch(
      /\/\/\s*1\. Dwell time models — beyond a flat per-class mean, model the dwell\s*\/\/\s*distribution shape \(lognormal-flavoured for long-tailed dwell, vs\s*\/\/\s*tight gaussian for quick taps\)\./,
    );
    expect(body).toMatch(
      /\/\/\s*2\. Element-region-aware click-position bias — within an element,\s*\/\/\s*humans don't tap uniformly: buttons get tapped near the visual\s*\/\/\s*affordance edge, links near the underlined text region, images\s*\/\/\s*near features \(face \/ focal point\)\./,
    );
  });

  it("DwellShape 3-value union ('tight'|'normal'|'long-tailed'); per-shape framing pinned 'tight — narrow gaussian around the mean. Snappy taps (button-like).' + 'long-tailed — log-skewed; mean unchanged, right tail extended.'", () => {
    expect(body).toMatch(
      /\*\s*'tight'\s*— narrow gaussian around the mean\. Snappy taps \(button-like\)\.\s*\*\s*'normal' — moderate gaussian\. Typical mixed interaction\.\s*\*\s*'long-tailed' — log-skewed; mean unchanged, right tail extended\./,
    );
    expect(body).toMatch(/export type DwellShape = 'tight' \| 'normal' \| 'long-tailed';/);
  });

  it("DWELL_SHAPES 7-entry per-class table: button/link 'tight'; input/generic 'normal'; image/video/scroll-container 'long-tailed'; Object.freeze + Readonly<Record<ElementClass, DwellShape>>", () => {
    expect(body).toMatch(
      /export const DWELL_SHAPES: Readonly<Record<ElementClass, DwellShape>> = Object\.freeze\(\{\s*button: 'tight',\s*link: 'tight',\s*input: 'normal',\s*image: 'long-tailed',\s*video: 'long-tailed',\s*'scroll-container': 'long-tailed',\s*generic: 'normal',\s*\}\);/,
    );
  });

  it("ClickRegion: 3-field (center fraction + radius fraction 'max 0.5' + weight relative 'generator normalises across regions')", () => {
    expect(body).toMatch(
      /export interface ClickRegion \{[\s\S]*?\/\*\* Region centre as fraction of element bounds \(0\.\.1\)\. \*\/\s*center: \{ x: number; y: number \};[\s\S]*?\/\*\* Region radius as fraction of element bounds \(0\.\.1, max 0\.5\)\. \*\/\s*radius: \{ x: number; y: number \};[\s\S]*?\/\*\* Probability weight \(relative\)\. The generator normalises across regions\. \*\/\s*weight: number;/,
    );
  });

  it('CLICK_REGIONS framing pinned: \'Real-world taps on a button are tightly clustered near the visual affordance edge (where finger pressure feels "right"), not perfectly centred — but close enough that one centre-biased region captures the essence. Images get 2 regions (centre for focal-point content + upper-half for caption-tap on annotated images).\'', () => {
    expect(body).toMatch(
      /\*\s*Real-world taps on a button are tightly clustered near the visual\s*\*\s*affordance edge \(where finger pressure feels "right"\), not perfectly\s*\*\s*centred — but close enough that one centre-biased region captures the\s*\*\s*essence\. Images get 2 regions \(centre for focal-point content \+\s*\*\s*upper-half for caption-tap on annotated images\)\./,
    );
  });

  it('CLICK_REGIONS table: button 1-region (0.5,0.5, radius 0.18×0.22, weight 1.0); link 1-region with 0.45 y-offset (text baseline above geometric centre rationale); input 1-region at 0.4 x (placeholder text area rationale); image 2-region (0.7 focal-point + 0.3 upper); video 2-region (0.8 play lower + 0.2 close upper-right); scroll-container 1-region; generic 1-region', () => {
    expect(body).toMatch(
      /button: \[\s*\{\s*center: \{ x: 0\.5, y: 0\.5 \},\s*radius: \{ x: 0\.18, y: 0\.22 \},\s*weight: 1\.0,\s*\},\s*\],/,
    );
    expect(body).toMatch(
      /\/\/ Underlined text region tends to be slightly above element centre\s*\/\/ \(text baseline is above geometric centre for typical link styling\)\./,
    );
    expect(body).toMatch(
      /\/\/ Input click typically lands left-of-centre \(placeholder text area\)\./,
    );
    expect(body).toMatch(
      /image: \[[\s\S]*?\/\/ Focal-point centre\.[\s\S]*?weight: 0\.7,[\s\S]*?\/\/ Upper-half secondary \(caption \/ annotation taps\)\.[\s\S]*?weight: 0\.3,/,
    );
    expect(body).toMatch(
      /video: \[[\s\S]*?\/\/ Play affordance — typically lower-centre\.[\s\S]*?weight: 0\.8,[\s\S]*?\/\/ Upper-right \(close\/exit affordance\)\.[\s\S]*?weight: 0\.2,/,
    );
    expect(body).toMatch(/\/\/ Scroll touches initiate uniformly across the surface\./);
  });

  it("sampleDwellMultiplier framing pinned: 'Mean is 1.0 across all shapes; only the distribution shape differs.' + tight σ≈0.08 + normal σ≈0.18 + long-tailed via lognormal exp(N(0, σ)) with E[X]=1 mean-correction (μ=-σ²/2)", () => {
    expect(body).toMatch(
      /\*\s*Sample a dwell-time multiplier from the requested shape\. Mean is 1\.0\s*\*\s*across all shapes; only the distribution shape differs\./,
    );
    expect(body).toMatch(
      /\*\s*- tight: gaussian-ish \(sum of 3 uniforms\), σ ≈ 0\.08\.\s*\*\s*- normal: gaussian-ish, σ ≈ 0\.18\.\s*\*\s*- long-tailed: log-skewed via exp\(N\(0, σ\)\)\. Right tail extends to ~3x\s*\*\s*while preserving mean ≈ 1\.0 by the lognormal mean-correction\s*\*\s*exp\(σ²\/2\)\./,
    );
    expect(body).toMatch(
      /\/\/ Lognormal with E\[X\] = exp\(μ \+ σ²\/2\)\. To get mean = 1, set μ = -σ²\/2\.\s*return Math\.exp\(-\(\(sigma \* sigma\) \/ 2\) \+ sigma \* z\);/,
    );
  });

  it('Box-Muller long-tailed sampling: u1=max(rng(), 1e-9) (avoid log(0)); z=sqrt(-2*log(u1))*cos(2*PI*u2); sigma=0.4', () => {
    expect(body).toMatch(
      /\/\/ Box-Muller → normal\(0, 1\); shape via lognormal\.\s*const u1 = Math\.max\(rng\(\), 1e-9\);\s*const u2 = rng\(\);\s*const z = Math\.sqrt\(-2 \* Math\.log\(u1\)\) \* Math\.cos\(2 \* Math\.PI \* u2\);\s*const sigma = 0\.4;/,
    );
  });

  it("RegionAwareTouchEvent extends TouchEvent + 3 extra fields (selectedRegionIndex 0-indexed 'Lets callers report or test the region-weighting empirically' + dwellShape + dwellMultiplier 1.0=at-class-mean framing)", () => {
    expect(body).toMatch(
      /export interface RegionAwareTouchEvent extends TouchEvent \{[\s\S]*?\/\*\*\s*\*\s*Which region \(0-indexed into the class's region map\) the click landed\s*\*\s*in\. Lets callers report or test the region-weighting empirically\.\s*\*\/\s*selectedRegionIndex: number;[\s\S]*?dwellShape: DwellShape;[\s\S]*?\/\*\* The dwell multiplier sampled \(1\.0 = at-class-mean\)\. \*\/\s*dwellMultiplier: number;/,
    );
  });

  it('generateRegionAwareTouchEvent: throws on width/height <= 0 with bounds context; throws on empty regions; seed = `region-touch:${elementClass}:${JSON.stringify(bounds)}`', () => {
    expect(body).toMatch(
      /if \(opts\.bounds\.width <= 0 \|\| opts\.bounds\.height <= 0\) \{\s*throw new Error\(\s*`generateRegionAwareTouchEvent: bounds must have positive width \+ height ` \+\s*`\(got width=\$\{opts\.bounds\.width\}, height=\$\{opts\.bounds\.height\}\)`,\s*\);/,
    );
    expect(body).toMatch(
      /if \(regions\.length === 0\) \{\s*throw new Error\(\s*`generateRegionAwareTouchEvent: at least one region required for \$\{opts\.elementClass\}`,/,
    );
    expect(body).toMatch(
      /const seed = opts\.seed \?\? `region-touch:\$\{opts\.elementClass\}:\$\{JSON\.stringify\(opts\.bounds\)\}`;/,
    );
  });

  it('Weighted region selection: totalWeight reduce sum; rng() * totalWeight; subtract weights; first non-positive subtracts wins; init regionIndex to last (defensive)', () => {
    expect(body).toMatch(
      /const totalWeight = regions\.reduce\(\(acc, r\) => acc \+ r\.weight, 0\);\s*requirePositiveFinite\('generateRegionAwareTouchEvent: total region weight', totalWeight\);\s*let pick = rng\(\) \* totalWeight;\s*let regionIndex = regions\.length - 1;\s*for \(let i = 0; i < regions\.length; i \+= 1\) \{[\s\S]*?pick -= r\.weight;\s*if \(pick <= 0\) \{\s*regionIndex = i;\s*break;\s*\}/,
    );
  });

  it('custom region maps are capped before iteration and their aggregate weight stays finite', () => {
    expect(body).toContain('export const MAX_CLICK_REGIONS = 64;');
    expect(body).toContain('if (regions.length > MAX_CLICK_REGIONS) {');
    expect(body).toContain(
      "requirePositiveFinite('generateRegionAwareTouchEvent: total region weight', totalWeight);",
    );
  });

  it('Region-local bounds shrink: regionLeft/Top via centre - radius; regionWidth/Height via radius × 2; max(1, ...) floor; passes shrunken bounds to generateTouchEvent with region-suffixed seed', () => {
    expect(body).toMatch(
      /const regionLeft = opts\.bounds\.x \+ opts\.bounds\.width \* \(region\.center\.x - region\.radius\.x\);\s*const regionTop = opts\.bounds\.y \+ opts\.bounds\.height \* \(region\.center\.y - region\.radius\.y\);\s*const regionWidth = opts\.bounds\.width \* region\.radius\.x \* 2;\s*const regionHeight = opts\.bounds\.height \* region\.radius\.y \* 2;/,
    );
    expect(body).toMatch(
      /const regionBounds: ElementBounds = \{\s*x: regionLeft,\s*y: regionTop,\s*width: Math\.max\(1, regionWidth\),\s*height: Math\.max\(1, regionHeight\),\s*\};/,
    );
    expect(body).toMatch(/seed: `\$\{seed\}:region\$\{regionIndex\}`,/);
  });

  it("Dwell-multiplier application: durationMs scaled by multiplier (max(1, ...)); per-sample tMs scaled; bounds restored to original element's bounds in result framing pinned 'Bounds stay the original element's bounds — the start/end coords are inside the region but bounds describes the targeted element.'", () => {
    expect(body).toMatch(
      /const scaledDuration = Math\.max\(1, baseTouch\.durationMs \* dwellMultiplier\);\s*const scaledSamples = baseTouch\.samples\.map\(\(s\) => \(\{\s*\.\.\.s,\s*\.\.\.clipToElement\(s\),\s*tMs: s\.tMs \* dwellMultiplier,\s*\}\)\);/,
    );
    expect(body).toMatch(
      /\/\/ Bounds stay the original element's bounds — the start\/end coords\s*\/\/ are inside the region but bounds describes the targeted element\.\s*bounds: opts\.bounds,/,
    );
    // The emitted start/end/samples are CLIPPED to opts.bounds (the real element),
    // not just the region-widened bounds — so a sub-2px target can't escape.
    expect(body).toMatch(
      /start: clipToElement\(baseTouch\.start\),\s*end: clipToElement\(baseTouch\.end\),/,
    );
    expect(body).toMatch(
      /return \{\s*\.\.\.baseTouch,[\s\S]*?samples: scaledSamples,\s*durationMs: scaledDuration,\s*selectedRegionIndex: regionIndex,\s*dwellShape,\s*dwellMultiplier,\s*\};/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
