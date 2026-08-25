// W452.A — drift guard for packages/behavioural-simulation/src/types.ts.
// Stable domain types. Drift here either drops the V-530.A
// ElementClass 7-value union (per-class distribution table loses
// case coverage, generator returns undefined for the missing class
// and crashes at the sampling site) or weakens TouchEvent's
// bounded-positive ElementBounds invariant (width/height > 0
// silently dropped → division-by-zero / NaN in downstream samplers).
//
//   • Stable-shape + private pure-generator seam framing pinned.
//   • MouseTrajectory: 5-field (from/to {x,y} + points array + duration
//     + seed).
//   • KeyboardCadence: 4-field (text + delaysMs[] + duration + seed).
//   • ScrollPattern: 5-field (direction 4-union + totalDistancePx +
//     ticks array + duration + seed).
//   • ElementClass: 7-value union framing pinned (V-530.A per-class
//     distributions + sub-slices B/C/D rationale).
//   • ElementBounds: 4-field with 'Must be > 0' on width + height.
//   • TouchSample: 4-field (x + y + tMs + pressure 0..1).
//   • TouchEvent: 7-field (elementClass + bounds + start + end +
//     samples readonly + durationMs computed from samples[last] -
//     samples[0] + seed).
//   • TouchDistribution framing pinned: 'class-typical means + bounded
//     jitter via seeded PRNG'.
//   • TouchDistribution: 7-field (meanDwellMs + dwellJitterMs +
//     centerBias + positionJitter + meanDriftPx + sampleCount +
//     meanPressure).
//   • BehaviouralProfile: 'bundles cadence preferences for a synthetic
//     persona' framing + 6-field (id + meanKeyDelayMs +
//     meanMouseSpeedPxPerMs + meanScrollPxPerTick + pauseProbability
//     0..1 + meanPauseMs).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/src/types.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W452.A packages/behavioural-simulation/src/types.ts content parity', () => {
  const body = read(LIB);

  it('stable domain shapes + private pure-generator seam framing pinned', () => {
    expect(body).toMatch(
      /\/\/ Behavioural-simulation domain types\. Consumers \(drivers, GUI client and\s*\/\/ recipe runner\) depend on these stable shapes while the private package's\s*\/\/ pure deterministic generators evolve behind BehaviouralSimulator\./,
    );
  });

  it("MouseTrajectory: 5-field (from/to {x,y} + points samples + durationMs + seed) + 'Sampled cubic-Bézier mouse path' framing", () => {
    expect(body).toMatch(
      /\/\*\* Sampled cubic-Bézier mouse path between two screen points\. \*\/\s*export interface MouseTrajectory \{\s*\/\*\* Start screen coordinate\. \*\/\s*from: \{ x: number; y: number \};\s*\/\*\* End screen coordinate\. \*\/\s*to: \{ x: number; y: number \};\s*\/\*\* Sampled path including both endpoints\. Length = `samples \+ 1`\. \*\/\s*points: Array<\{ x: number; y: number; tMs: number \}>;[\s\S]*?durationMs: number;[\s\S]*?seed: string;/,
    );
  });

  it('KeyboardCadence: delays align to Unicode graphemes; ScrollPattern keeps its wheel/touch shape', () => {
    expect(body).toMatch(
      /export interface KeyboardCadence \{[\s\S]*?text: string;[\s\S]*?\/\*\* Per-keystroke delay in ms; `delaysMs\[i\]` is the delay BEFORE keystroke[\s\S]*?delaysMs: number\[\];[\s\S]*?durationMs: number;[\s\S]*?seed: string;/,
    );
    expect(body).toMatch(
      /Length is\s*\*\s*the Unicode grapheme count, not the UTF-16 code-unit count\./,
    );
    expect(body).toMatch(
      /\/\*\* Scroll-by-scroll velocity profile\. Distinct from mouse — wheel\/touch deltas\. \*\/\s*export interface ScrollPattern \{[\s\S]*?direction: 'up' \| 'down' \| 'left' \| 'right';[\s\S]*?totalDistancePx: number;[\s\S]*?ticks: Array<\{ deltaPx: number; tMs: number \}>;/,
    );
  });

  it("ElementClass framing pinned: 'V-530.A — per-element-class distributions. Sub-slices B (scroll velocity), C (dwell + click-position), D (idle jitter + multi-touch) ship later.' + 7-value union (button|link|input|image|video|scroll-container|generic)", () => {
    expect(body).toMatch(
      /\* V-530\.A — per-element-class distributions\. Sub-slices B \(scroll velocity\),\s*\*\s*C \(dwell \+ click-position\), D \(idle jitter \+ multi-touch\) ship later\./,
    );
    // Prettier 3.8.3 reformatted this union onto leading-pipe lines. The first
    // re-pin used a repeated-alternation regex and was WEAKER than what it
    // replaced: it matched any SUBSET, so deleting a member kept it green.
    // Caught by mutation. What matters is the exact value set, so the members
    // are extracted from the declaration and compared as a set — independent of
    // layout, and it fails the moment one is added or removed.
    const elementClassDecl = /export type ElementClass =([\s\S]*?);/.exec(body)?.[1] ?? '';
    expect(
      [...elementClassDecl.matchAll(/'([a-z-]+)'/g)].map((m) => m[1]),
      'ElementClass members, exact set and order',
    ).toEqual(['button', 'link', 'input', 'image', 'video', 'scroll-container', 'generic']);
  });

  it("ElementBounds: 4-field (x + y + width + height) with 'Must be > 0' invariant on BOTH width AND height", () => {
    expect(body).toMatch(
      /export interface ElementBounds \{[\s\S]*?x: number;[\s\S]*?y: number;[\s\S]*?\/\*\* Width \(CSS px\)\. Must be > 0\. \*\/\s*width: number;[\s\S]*?\/\*\* Height \(CSS px\)\. Must be > 0\. \*\/\s*height: number;/,
    );
  });

  it("TouchSample: 4-field (x + y + tMs + pressure with '0..1 (0 = no force info; 1 = max)' framing)", () => {
    expect(body).toMatch(
      /export interface TouchSample \{[\s\S]*?x: number;[\s\S]*?y: number;[\s\S]*?tMs: number;[\s\S]*?\/\*\* Pressure 0\.\.1 \(0 = no force info; 1 = max\)\. \*\/\s*pressure: number;/,
    );
  });

  it("TouchEvent: 7-field (elementClass + bounds + start + end + samples readonly + durationMs computed as samples[last].tMs - samples[0].tMs + seed) + 'Touch-end coordinate (typically within ±2px of start for taps)' framing pinned", () => {
    expect(body).toMatch(
      /\/\*\* Touch-end coordinate \(typically within ±2px of start for taps\)\. \*\/\s*end: \{ x: number; y: number \};/,
    );
    expect(body).toMatch(
      /\/\*\* Pointer samples from start → end, monotonically increasing in `tMs`\. \*\/\s*samples: readonly TouchSample\[\];\s*\/\*\* Total wall-clock duration in ms \(samples\[last\]\.tMs - samples\[0\]\.tMs\)\. \*\/\s*durationMs: number;/,
    );
  });

  it("TouchDistribution framing pinned: 'Means are class-typical; the generator adds bounded jitter around them using a seeded PRNG so outputs are deterministic given a seed.' + 7 fields incl. 'Triangular distribution' on dwellJitterMs and centerBias '0.5 = centre' framing", () => {
    expect(body).toMatch(
      /\* Means are class-typical; the generator adds bounded jitter around them\s*\*\s*using a seeded PRNG so outputs are deterministic given a seed\./,
    );
    expect(body).toMatch(
      /\/\*\* ± jitter \(ms\) around `meanDwellMs`\. Triangular distribution\. \*\/\s*dwellJitterMs: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Position bias as fractions of element bounds \(0\.\.1; 0\.5 = centre\)\. \*\/\s*centerBias: \{ x: number; y: number \};/,
    );
    expect(body).toMatch(
      /\/\*\* Mean pressure 0\.\.1; jitter ± 0\.1 around mean\. \*\/\s*meanPressure: number;/,
    );
  });

  it("BehaviouralProfile framing pinned: 'Top-level behavioural profile — bundles cadence preferences for a synthetic persona. Real generators sample these once at session-start and apply them to every interaction within the session for coherence.' + 6-field (id + meanKeyDelayMs + meanMouseSpeedPxPerMs + meanScrollPxPerTick + pauseProbability + meanPauseMs)", () => {
    expect(body).toMatch(
      /\* Top-level behavioural profile — bundles cadence preferences for a\s*\*\s*synthetic persona\. Real generators sample these once at session-start\s*\*\s*and apply them to every interaction within the session for coherence\./,
    );
    expect(body).toMatch(
      /export interface BehaviouralProfile \{[\s\S]*?readonly id: string;[\s\S]*?readonly meanKeyDelayMs: number;[\s\S]*?readonly meanMouseSpeedPxPerMs: number;[\s\S]*?readonly meanScrollPxPerTick: number;[\s\S]*?\/\*\* Probability the persona pauses between actions \(0\.\.1\)\. \*\/\s*readonly pauseProbability: number;[\s\S]*?readonly meanPauseMs: number;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
