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
//   • Update protocol pinned (fingerprint work → founder relay → this repo
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

  it('update-protocol pinned (fingerprint work → founder → this repo Tier-1 maintenance)', () => {
    expect(body).toMatch(
      /Update protocol: when the fingerprint work closes a cumulative-rig batch\s*\/\/\s*that moves the numerator or denominator/,
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
    expect(body).toMatch(/Values re-derived from the registry on 2026-09-14\./);
  });

  it('homepage curated-subset note pinned (the proof section intentionally names the flagship subset; it is NOT bound to DEVICE_SUPPORT)', () => {
    expect(body).toMatch(/NB the homepage proof section/);
    expect(body).toMatch(
      /intentionally names the flagship\s*\/\/\s*subset as curated marketing copy; it is NOT bound to this constant\./,
    );
  });

  it('exports DEVICE_SUPPORT with the THREE counts, each carrying the claim it supports', () => {
    expect(body).toMatch(/export const DEVICE_SUPPORT = \{/);
    expect(body).toMatch(/forkCaptureCount: \d+,/);
    expect(body).toMatch(/verifiedCount: \d+,/);
    expect(body).toMatch(/selectableCount: \d+,/);
    expect(body).toMatch(/deviceFamilies: 'iPhone 13 → 17 Pro Max',/);
    expect(body).toMatch(/iosVersions: '18\.4\.1 \/ 18\.6 \/ 18\.7',/);
    expect(body).toMatch(/safariVersions: '18\.4–26\.6',/);
    expect(body).toMatch(/derivedOn: '2026-09-14',/);
  });

  // ⛔ 2026-09-14 — `archetypeCount` was ONE number serving three different
  // claims, and the trust page rendered it inside "the same methodology runs
  // against every archetype in the catalog". That asserts the rig was RUN; it
  // has been run against 5. Each count is now bound to its own population, and
  // the ordering below is what stops one being substituted for another.
  it('cross-source invariant: selectableCount matches the registry customer-selectable catalog (status launch | available)', () => {
    expect(DEVICE_SUPPORT.selectableCount).toBe(catalog.length);
  });

  it('CRITICAL cross-source invariant: verifiedCount counts the bit-identical registry rows — the EVIDENCE population, which is strictly smaller than the selectable one', () => {
    const verified = ARCHETYPE_REGISTRY.filter((a) => a.lifecycle === 'bit_identical').length;
    expect(DEVICE_SUPPORT.verifiedCount).toBe(verified);
    expect(DEVICE_SUPPORT.verifiedCount).toBeLessThan(DEVICE_SUPPORT.selectableCount);
  });

  it('CRITICAL the three counts stay strictly ordered fork-capture < verified < selectable, so no claim can quietly inherit another’s number', () => {
    expect(DEVICE_SUPPORT.forkCaptureCount).toBeGreaterThan(0);
    expect(DEVICE_SUPPORT.forkCaptureCount).toBeLessThan(DEVICE_SUPPORT.verifiedCount);
    expect(DEVICE_SUPPORT.verifiedCount).toBeLessThan(DEVICE_SUPPORT.selectableCount);
  });

  it('cross-source invariant: deviceFamilies endpoints are real catalog devices (iPhone 13 floor, iPhone 17 Pro Max ceiling)', () => {
    const devices = new Set(catalog.map((a) => a.device));
    expect(devices.has('iPhone 13')).toBe(true);
    expect(devices.has('iPhone 17 Pro Max')).toBe(true);
    expect(DEVICE_SUPPORT.deviceFamilies).toBe('iPhone 13 → 17 Pro Max');
  });

  // ⛔ Ordered by (major, minor, patch), NOT by `Number(a) - Number(b)`. That
  // comparator worked only while every version had one dot: `Number('26.6.1')`
  // is NaN, so a point release would have sorted arbitrarily and the span
  // endpoints below would have been whichever two happened to land at the ends.
  // The catalog carries three-component versions on both axes now — Safari
  // 26.6.1, iOS 18.4.1.
  const versionKey = (v: string): number => {
    const [a = 0, b = 0, c = 0] = v.split('.').map((n) => Number(n) || 0);
    return a * 1_000_000 + b * 1_000 + c;
  };

  it('cross-source invariant: iosVersions covers exactly the iOS versions present in the catalog', () => {
    // Derived, not listed. A hardcoded list here is a second copy of the catalog
    // that goes stale the next time an archetype is published — which is exactly
    // how the registry itself fell 24 entries behind.
    const ios = [...new Set(catalog.map((a) => a.iosVersion))].sort(
      (a, b) => versionKey(a) - versionKey(b),
    );
    expect(
      ios.length,
      'the catalog has no iOS versions — this check would be vacuous',
    ).toBeGreaterThan(1);
    expect(DEVICE_SUPPORT.iosVersions).toBe(ios.join(' / '));
  });

  it('cross-source invariant: safariVersions span endpoints match the min/max Safari versions in the catalog', () => {
    const safari = [...new Set(catalog.map((a) => a.safariVersion))].sort(
      (a, b) => versionKey(a) - versionKey(b),
    );
    expect(safari.length, 'no Safari versions — vacuous').toBeGreaterThan(1);
    expect(DEVICE_SUPPORT.safariVersions).toBe(`${safari[0]}–${safari[safari.length - 1]}`);
  });

  it('CUMULATIVE_RIG lastUpdated is NOT restamped by the DEVICE_SUPPORT derivation (the rig snapshot stays founder-attested 2026-05-03)', () => {
    expect(body).toMatch(/lastUpdated: '2026-05-03',/);
  });
});
