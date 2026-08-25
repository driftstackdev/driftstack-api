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
//
// S18 (2026-07-04) additive extension — DEVICE_SUPPORT, the device-
// support fact registry derived from the api-types ARCHETYPE_REGISTRY
// (customer-selectable catalog = status 'launch' | 'available').
// Cross-source invariants below import the registry itself so a
// catalog change fails here instead of silently stranding the
// marketing numbers.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';
import { DEVICE_SUPPORT } from '../../src/data/capabilities.ts';

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
      /probes-with-iPhone-reference denominator,\s*\/\/\s*not raw — raw includes ref=None pinned post-V-141 capture and is\s*\/\/\s*NOT the marketing-surface number/,
    );
  });

  it('update-protocol pinned (Agent 1 → founder → Agent 2 Tier-1 maintenance)', () => {
    expect(body).toMatch(
      /Update protocol: when Agent 1 closes a cumulative-rig batch that\s*\/\/\s*moves the numerator or denominator/,
    );
    expect(body).toMatch(
      /Tier 1 maintenance commit \(no founder review needed for factual\s*\/\/\s*technical state\)/,
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

describe('S18 marketing-site src/data/capabilities.ts DEVICE_SUPPORT fact registry', () => {
  const body = read(DATA);
  const catalog = ARCHETYPE_REGISTRY.filter(
    (a) => a.status === 'launch' || a.status === 'available',
  );

  it('derivation-source comment names the api-types ARCHETYPE_REGISTRY + the catalog scope + the derivation date', () => {
    expect(body).toMatch(/Derivation source: packages\/api-types\/src\/common\.ts/);
    expect(body).toMatch(/ARCHETYPE_REGISTRY — the customer-selectable catalog \(entries with/);
    expect(body).toMatch(/status 'launch' \| 'available'/);
    expect(body).toMatch(/Values re-derived from the registry on 2026-07-04\./);
  });

  it('homepage curated-subset note pinned (the proof section intentionally names the flagship subset; it is NOT bound to DEVICE_SUPPORT)', () => {
    expect(body).toMatch(/NB the homepage proof section/);
    expect(body).toMatch(
      /intentionally names the flagship\s*\/\/\s*subset as curated marketing copy; it is NOT bound to this constant\./,
    );
  });

  it('exports DEVICE_SUPPORT as a const-asserted readonly object with 5 fields', () => {
    expect(body).toMatch(/export const DEVICE_SUPPORT = \{/);
    expect(body).toMatch(/archetypeCount: 81,/);
    expect(body).toMatch(/deviceFamilies: 'iPhone 13 → 17 Pro Max',/);
    expect(body).toMatch(/iosVersions: '18\.6 \/ 18\.7',/);
    expect(body).toMatch(/safariVersions: '18\.6–26\.5',/);
    expect(body).toMatch(/derivedOn: '2026-07-04',/);
  });

  it('cross-source invariant: archetypeCount matches the api-types registry customer-selectable catalog (status launch | available)', () => {
    expect(DEVICE_SUPPORT.archetypeCount).toBe(catalog.length);
  });

  it('cross-source invariant: deviceFamilies endpoints are real catalog devices (iPhone 13 floor, iPhone 17 Pro Max ceiling)', () => {
    const devices = new Set(catalog.map((a) => a.device));
    expect(devices.has('iPhone 13')).toBe(true);
    expect(devices.has('iPhone 17 Pro Max')).toBe(true);
    expect(DEVICE_SUPPORT.deviceFamilies).toBe('iPhone 13 → 17 Pro Max');
  });

  it('cross-source invariant: iosVersions covers exactly the iOS versions present in the catalog', () => {
    const ios = [...new Set(catalog.map((a) => a.iosVersion))].sort();
    expect(ios).toEqual(['18.6', '18.7']);
    expect(DEVICE_SUPPORT.iosVersions).toBe(ios.join(' / '));
  });

  it('cross-source invariant: safariVersions span endpoints match the min/max Safari versions in the catalog', () => {
    const safari = [...new Set(catalog.map((a) => a.safariVersion))].sort(
      (a, b) => Number(a) - Number(b),
    );
    expect(safari).toEqual(['18.6', '26.0', '26.3', '26.4', '26.5']);
    expect(DEVICE_SUPPORT.safariVersions).toBe(`${safari[0]}–${safari[safari.length - 1]}`);
  });

  it('CUMULATIVE_RIG lastUpdated is NOT restamped by the DEVICE_SUPPORT derivation (the rig snapshot stays founder-attested 2026-05-03)', () => {
    expect(body).toMatch(/lastUpdated: '2026-05-03',/);
  });
});
