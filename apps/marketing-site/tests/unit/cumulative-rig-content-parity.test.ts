// W384.A — drift guard for marketing-site src/data/capabilities.ts.
// This file's CUMULATIVE_RIG constant is the load-bearing
// fingerprint-fidelity claim that drives every marketing-surface
// "99.9% / 1252-of-1253" headline. Drift in numerator or
// denominator without rolling forward the founder-attested
// snapshot would silently lie. Existing fingerprint-claim-baseline
// guards positioning copy but not the numbers.
//
//   • CUMULATIVE_RIG: 5 fields (surfacesMatched / surfacesMeasured
//     / matchRatePercentage / archetypeReference / lastUpdated).
//   • surfacesMatched = 1252.
//   • surfacesMeasured = 1253 (denominator excludes ref=None).
//   • matchRatePercentage = 99.9.
//   • archetypeReference = 'iPhone 16 Pro / iOS 18.7 / Safari 26.4'.
//   • lastUpdated = '2026-05-03' (ISO date).
//   • Source provenance: parent driftstack repo /docs/progress/
//     phase-2.md cumulative-rig snapshot.
//   • Update protocol pinned (Agent 1 → founder relay → Agent 2
//     Tier 1 maintenance commit).
//   • Probes-with-iPhone-reference denominator framing pinned
//     (raw includes ref=None pinned post-V-141 and is NOT
//     the marketing-surface number).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DATA = resolve(REPO_ROOT, 'apps/marketing-site/src/data/capabilities.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W384.A marketing-site src/data/capabilities.ts CUMULATIVE_RIG content parity', () => {
  const body = read(DATA);

  it('source-of-truth provenance: parent driftstack repo /docs/progress/phase-2.md cumulative-rig snapshot', () => {
    expect(body).toMatch(/Source: parent driftstack repo `\/docs\/progress\/phase-2\.md`/);
    expect(body).toMatch(/cumulative-rig snapshot/);
  });

  it('denominator framing: probes-with-iPhone-reference (NOT raw, NOT ref=None)', () => {
    expect(body).toMatch(
      /probes-with-iPhone-reference denominator,\s*\n?\s*\/\/\s*not raw — raw includes ref=None pinned post-V-141 capture and is\s*\n?\s*\/\/\s*NOT the marketing-surface number/,
    );
  });

  it('update-protocol pinned (Agent 1 → founder → Agent 2 Tier-1 maintenance)', () => {
    expect(body).toMatch(
      /Update protocol: when Agent 1 closes a cumulative-rig batch that\s*\n?\s*\/\/\s*moves the numerator or denominator/,
    );
    expect(body).toMatch(
      /Tier 1 maintenance commit \(no founder review needed for factual\s*\n?\s*\/\/\s*technical state\)/,
    );
  });

  it('"Last update: 2026-05-03 founder confirmation." pinned', () => {
    expect(body).toMatch(/Last update: 2026-05-03 founder confirmation/);
  });

  it('exports CUMULATIVE_RIG as a const-asserted readonly object', () => {
    expect(body).toMatch(/export const CUMULATIVE_RIG = \{/);
    expect(body).toMatch(/\} as const;/);
  });

  it('surfacesMatched = 1252 (numerator)', () => {
    expect(body).toMatch(/surfacesMatched: 1252,/);
    expect(body).toMatch(/Surfaces matching the iPhone reference fingerprint exactly\./);
  });

  it('surfacesMeasured = 1253 (denominator, excludes ref=None)', () => {
    expect(body).toMatch(/surfacesMeasured: 1253,/);
    expect(body).toMatch(/Surfaces measured against the iPhone reference \(excludes ref=None\)\./);
  });

  it('matchRatePercentage = 99.9 (pre-rounded headline number)', () => {
    expect(body).toMatch(/matchRatePercentage: 99\.9,/);
    expect(body).toMatch(/Pre-rounded percentage for marketing-headline display\./);
  });

  it('archetypeReference = "iPhone 16 Pro / iOS 18.7 / Safari 26.4"', () => {
    expect(body).toMatch(/archetypeReference: 'iPhone 16 Pro \/ iOS 18\.7 \/ Safari 26\.4',/);
    expect(body).toMatch(/Reference archetype the cumulative rig measures against\./);
  });

  it('lastUpdated = "2026-05-03" (ISO-8601 date)', () => {
    expect(body).toMatch(/lastUpdated: '2026-05-03',/);
    expect(body).toMatch(/ISO-8601 date of the last numerator\/denominator update\./);
  });

  it('match-rate ratio sanity: surfacesMatched / surfacesMeasured ≈ matchRatePercentage', () => {
    const numerator = body.match(/surfacesMatched: (\d+),/)?.[1];
    const denominator = body.match(/surfacesMeasured: (\d+),/)?.[1];
    const percentage = body.match(/matchRatePercentage: ([\d.]+),/)?.[1];
    expect(numerator).toBeTruthy();
    expect(denominator).toBeTruthy();
    expect(percentage).toBeTruthy();
    const ratio = (Number(numerator) / Number(denominator)) * 100;
    // Allow 0.05% tolerance for the published pre-rounded headline number.
    expect(Math.abs(ratio - Number(percentage))).toBeLessThan(0.05);
  });

  it('data file exists at canonical path', () => {
    expect(existsSync(DATA)).toBe(true);
  });
});
