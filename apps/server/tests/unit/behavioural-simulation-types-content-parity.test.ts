// W595.A — drift guard for packages/behavioural-simulation/src/types.ts.
// V-127 stub + V-530.A per-element-class distributions framing.

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

describe('W595.A packages/behavioural-simulation/src/types.ts content parity', () => {
  const body = read(LIB);

  it('V-127 Phase-3 stub framing + NO-domain-logic-types-only contract + types-interfaces-mock-only pinned', () => {
    expect(body).toMatch(/\/\/ Phase 3 domain types — V-127 stub\./);
    expect(body).toMatch(/\/\/ Defines the shapes the behavioural simulator produces so consumers/);
    expect(body).toMatch(
      /\/\/ \(drivers, GUI client, recipe runner\) can depend on them now while/,
    );
    expect(body).toMatch(/\/\/ Phase 3 swaps in the real implementation later\./);
    expect(body).toMatch(
      /\/\/ NO domain logic in this package — just types \+ interfaces \+ mock\./,
    );
    expect(body).toMatch(/\/\/ The real generators ship as a separate Phase 3 package and slot in/);
    expect(body).toMatch(
      /\/\/ behind the same interface \(see `interfaces\.ts:BehaviouralSimulator`\)\./,
    );
  });

  it('MouseTrajectory + KeyboardCadence + ScrollPattern types: from/to+points+durationMs+seed; text+delaysMs+durationMs+seed; direction-enum+totalDistancePx+ticks+durationMs+seed pinned', () => {
    expect(body).toMatch(
      /\/\*\* Cubic-bezier control points describing a mouse path between two screen points\. \*\//,
    );
    expect(body).toMatch(/^export interface MouseTrajectory \{$/m);
    expect(body).toMatch(/from: \{ x: number; y: number \};/);
    expect(body).toMatch(/to: \{ x: number; y: number \};/);
    expect(body).toMatch(/points: Array<\{ x: number; y: number; tMs: number \}>;/);
    expect(body).toMatch(/durationMs: number;/);
    expect(body).toMatch(/seed: string;/);
    expect(body).toMatch(/^export interface KeyboardCadence \{$/m);
    expect(body).toMatch(/text: string;/);
    expect(body).toMatch(/delaysMs: number\[\];/);
    expect(body).toMatch(/^export interface ScrollPattern \{$/m);
    expect(body).toMatch(/direction: 'up' \| 'down' \| 'left' \| 'right';/);
    expect(body).toMatch(/totalDistancePx: number;/);
    expect(body).toMatch(/ticks: Array<\{ deltaPx: number; tMs: number \}>;/);
  });

  it('V-530.A ElementClass enum (7-value) + ElementBounds + TouchSample + TouchEvent + TouchDistribution + per-class-distributions-comment pinned', () => {
    expect(body).toMatch(
      /\/\*\*\s*\n \* The DOM element class a touch interaction targets\. Distributions differ\s*\n \* per class — a `button` tap is short and central; a `video` tap may dwell\s*\n \* longer and bias toward the play affordance; a `scroll-container` touch\s*\n \* begins a swipe rather than completing a tap\.\s*\n \*\s*\n \* V-530\.A — per-element-class distributions\. Sub-slices B \(scroll velocity\),\s*\n \* C \(dwell \+ click-position\), D \(idle jitter \+ multi-touch\) ship later\./m,
    );
    expect(body).toMatch(
      /^export type ElementClass =\s*\n\s*'button' \| 'link' \| 'input' \| 'image' \| 'video' \| 'scroll-container' \| 'generic';/m,
    );
    expect(body).toMatch(/^export interface ElementBounds \{$/m);
    expect(body).toMatch(/\/\*\* Width \(CSS px\)\. Must be > 0\. \*\//);
    expect(body).toMatch(/^export interface TouchSample \{$/m);
    expect(body).toMatch(/\/\*\* Pressure 0\.\.1 \(0 = no force info; 1 = max\)\. \*\//);
    expect(body).toMatch(/pressure: number;/);
    expect(body).toMatch(/^export interface TouchEvent \{$/m);
    expect(body).toMatch(/elementClass: ElementClass;/);
    expect(body).toMatch(/samples: readonly TouchSample\[\];/);
    expect(body).toMatch(/^export interface TouchDistribution \{$/m);
    expect(body).toMatch(
      /\/\*\* ± jitter \(ms\) around `meanDwellMs`\. Triangular distribution\. \*\//,
    );
    expect(body).toMatch(/dwellJitterMs: number;/);
    expect(body).toMatch(/centerBias: \{ x: number; y: number \};/);
    expect(body).toMatch(/positionJitter: \{ x: number; y: number \};/);
    expect(body).toMatch(/meanDriftPx: number;/);
    expect(body).toMatch(/sampleCount: number;/);
    expect(body).toMatch(/meanPressure: number;/);
  });

  it('BehaviouralProfile (id + meanKeyDelayMs + meanMouseSpeedPxPerMs + meanScrollPxPerTick + pauseProbability + meanPauseMs) — synthetic-persona cadence bundle pinned', () => {
    expect(body).toMatch(/\* Top-level behavioural profile — bundles cadence preferences for a/);
    expect(body).toMatch(
      /\* synthetic persona\. Real generators sample these once at session-start/,
    );
    expect(body).toMatch(
      /\* and apply them to every interaction within the session for coherence\./,
    );
    expect(body).toMatch(/^export interface BehaviouralProfile \{$/m);
    expect(body).toMatch(/readonly id: string;/);
    expect(body).toMatch(/readonly meanKeyDelayMs: number;/);
    expect(body).toMatch(/readonly meanMouseSpeedPxPerMs: number;/);
    expect(body).toMatch(/readonly meanScrollPxPerTick: number;/);
    expect(body).toMatch(/readonly pauseProbability: number;/);
    expect(body).toMatch(/readonly meanPauseMs: number;/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
