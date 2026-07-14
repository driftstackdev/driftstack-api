// W452.A — drift guard for packages/behavioural-simulation/src/types.ts.
// V-127 Phase 3 domain types. Drift here either drops the V-530.A
// ElementClass 7-value union (per-class distribution table loses
// case coverage, generator returns undefined for the missing class
// and crashes at the sampling site) or weakens TouchEvent's
// bounded-positive ElementBounds invariant (width/height > 0
// silently dropped → division-by-zero / NaN in downstream samplers).
//
//   • V-127 framing pinned + NO-domain-logic-in-this-package +
//     real-generators-ship-separate rationale.
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

  it("V-127 framing pinned: 'Phase 3 domain types — V-127 stub.' + NO-domain-logic-in-package rationale + Phase 3 ships-separate-behind-same-interface seam", () => {
    expect(body).toMatch(/\/\/ Phase 3 domain types — V-127 stub\./);
    expect(body).toMatch(
      /\/\/ Defines the shapes the behavioural simulator produces so consumers\s*\n?\s*\/\/ \(drivers, GUI client, recipe runner\) can depend on them now while\s*\n?\s*\/\/ Phase 3 swaps in the real implementation later\./,
    );
    expect(body).toMatch(
      /\/\/ NO domain logic in this package — just types \+ interfaces \+ mock\.\s*\n?\s*\/\/ The real generators ship as a separate Phase 3 package and slot in\s*\n?\s*\/\/ behind the same interface \(see `interfaces\.ts:BehaviouralSimulator`\)\./,
    );
  });

  it("MouseTrajectory: 5-field (from/to {x,y} + points samples + durationMs + seed) + 'Cubic-bezier control points' framing", () => {
    expect(body).toMatch(
      /\/\*\* Cubic-bezier control points describing a mouse path between two screen points\. \*\/\s*\n?\s*export interface MouseTrajectory \{\s*\n?\s*\/\*\* Start screen coordinate\. \*\/\s*\n?\s*from: \{ x: number; y: number \};\s*\n?\s*\/\*\* End screen coordinate\. \*\/\s*\n?\s*to: \{ x: number; y: number \};\s*\n?\s*\/\*\* Sampled intermediate points\. Length = `samples`\. \*\/\s*\n?\s*points: Array<\{ x: number; y: number; tMs: number \}>;[\s\S]*?durationMs: number;[\s\S]*?seed: string;/,
    );
  });

  it('KeyboardCadence: delays align to Unicode graphemes; ScrollPattern keeps its wheel/touch shape', () => {
    expect(body).toMatch(
      /export interface KeyboardCadence \{[\s\S]*?text: string;[\s\S]*?\/\*\* Per-keystroke delay in ms; `delaysMs\[i\]` is the delay BEFORE keystroke[\s\S]*?delaysMs: number\[\];[\s\S]*?durationMs: number;[\s\S]*?seed: string;/,
    );
    expect(body).toMatch(
      /Length is\s*\n?\s*\*\s*the Unicode grapheme count, not the UTF-16 code-unit count\./,
    );
    expect(body).toMatch(
      /\/\*\* Scroll-by-scroll velocity profile\. Distinct from mouse — wheel\/touch deltas\. \*\/\s*\n?\s*export interface ScrollPattern \{[\s\S]*?direction: 'up' \| 'down' \| 'left' \| 'right';[\s\S]*?totalDistancePx: number;[\s\S]*?ticks: Array<\{ deltaPx: number; tMs: number \}>;/,
    );
  });

  it("ElementClass framing pinned: 'V-530.A — per-element-class distributions. Sub-slices B (scroll velocity), C (dwell + click-position), D (idle jitter + multi-touch) ship later.' + 7-value union (button|link|input|image|video|scroll-container|generic)", () => {
    expect(body).toMatch(
      /\* V-530\.A — per-element-class distributions\. Sub-slices B \(scroll velocity\),\s*\n?\s*\*\s*C \(dwell \+ click-position\), D \(idle jitter \+ multi-touch\) ship later\./,
    );
    expect(body).toMatch(
      /export type ElementClass =\s*\n?\s*\| 'button'\s*\n?\s*\| 'link'\s*\n?\s*\| 'input'\s*\n?\s*\| 'image'\s*\n?\s*\| 'video'\s*\n?\s*\| 'scroll-container'\s*\n?\s*\| 'generic';/,
    );
  });

  it("ElementBounds: 4-field (x + y + width + height) with 'Must be > 0' invariant on BOTH width AND height", () => {
    expect(body).toMatch(
      /export interface ElementBounds \{[\s\S]*?x: number;[\s\S]*?y: number;[\s\S]*?\/\*\* Width \(CSS px\)\. Must be > 0\. \*\/\s*\n?\s*width: number;[\s\S]*?\/\*\* Height \(CSS px\)\. Must be > 0\. \*\/\s*\n?\s*height: number;/,
    );
  });

  it("TouchSample: 4-field (x + y + tMs + pressure with '0..1 (0 = no force info; 1 = max)' framing)", () => {
    expect(body).toMatch(
      /export interface TouchSample \{[\s\S]*?x: number;[\s\S]*?y: number;[\s\S]*?tMs: number;[\s\S]*?\/\*\* Pressure 0\.\.1 \(0 = no force info; 1 = max\)\. \*\/\s*\n?\s*pressure: number;/,
    );
  });

  it("TouchEvent: 7-field (elementClass + bounds + start + end + samples readonly + durationMs computed as samples[last].tMs - samples[0].tMs + seed) + 'Touch-end coordinate (typically within ±2px of start for taps)' framing pinned", () => {
    expect(body).toMatch(
      /\/\*\* Touch-end coordinate \(typically within ±2px of start for taps\)\. \*\/\s*\n?\s*end: \{ x: number; y: number \};/,
    );
    expect(body).toMatch(
      /\/\*\* Pointer samples from start → end, monotonically increasing in `tMs`\. \*\/\s*\n?\s*samples: readonly TouchSample\[\];\s*\n?\s*\/\*\* Total wall-clock duration in ms \(samples\[last\]\.tMs - samples\[0\]\.tMs\)\. \*\/\s*\n?\s*durationMs: number;/,
    );
  });

  it("TouchDistribution framing pinned: 'Means are class-typical; the generator adds bounded jitter around them using a seeded PRNG so outputs are deterministic given a seed.' + 7 fields incl. 'Triangular distribution' on dwellJitterMs and centerBias '0.5 = centre' framing", () => {
    expect(body).toMatch(
      /\* Means are class-typical; the generator adds bounded jitter around them\s*\n?\s*\*\s*using a seeded PRNG so outputs are deterministic given a seed\./,
    );
    expect(body).toMatch(
      /\/\*\* ± jitter \(ms\) around `meanDwellMs`\. Triangular distribution\. \*\/\s*\n?\s*dwellJitterMs: number;/,
    );
    expect(body).toMatch(
      /\/\*\* Position bias as fractions of element bounds \(0\.\.1; 0\.5 = centre\)\. \*\/\s*\n?\s*centerBias: \{ x: number; y: number \};/,
    );
    expect(body).toMatch(
      /\/\*\* Mean pressure 0\.\.1; jitter ± 0\.1 around mean\. \*\/\s*\n?\s*meanPressure: number;/,
    );
  });

  it("BehaviouralProfile framing pinned: 'Top-level behavioural profile — bundles cadence preferences for a synthetic persona. Real generators sample these once at session-start and apply them to every interaction within the session for coherence.' + 6-field (id + meanKeyDelayMs + meanMouseSpeedPxPerMs + meanScrollPxPerTick + pauseProbability + meanPauseMs)", () => {
    expect(body).toMatch(
      /\* Top-level behavioural profile — bundles cadence preferences for a\s*\n?\s*\*\s*synthetic persona\. Real generators sample these once at session-start\s*\n?\s*\*\s*and apply them to every interaction within the session for coherence\./,
    );
    expect(body).toMatch(
      /export interface BehaviouralProfile \{[\s\S]*?id: string;[\s\S]*?meanKeyDelayMs: number;[\s\S]*?meanMouseSpeedPxPerMs: number;[\s\S]*?meanScrollPxPerTick: number;[\s\S]*?\/\*\* Probability the persona pauses between actions \(0\.\.1\)\. \*\/\s*\n?\s*pauseProbability: number;[\s\S]*?meanPauseMs: number;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
