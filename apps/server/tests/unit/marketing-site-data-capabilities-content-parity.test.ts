// W462.C — drift guard for apps/marketing-site/src/data/capabilities.ts.
// Cumulative-rig marketing-surface snapshot. Drift here either
// swaps the denominator (probes-with-iPhone-reference vs raw
// including ref=None pinned post-V-141) — marketing publishes the
// wrong public match-rate number, regulator/legal exposure since
// these figures are claimed in marketing copy — or breaks the
// `as const` literal-type lock that downstream pages rely on for
// narrow string-literal types.
//
//   • Cumulative-rig framing pinned: 'Cumulative-rig snapshot for
//     marketing-surface display.' + Source 'parent driftstack repo
//     /docs/progress/phase-2.md cumulative-rig snapshot' +
//     denominator distinction 'probes-with-iPhone-reference
//     denominator, not raw — raw includes ref=None pinned post-
//     V-141 capture and is NOT the marketing-surface number.'
//   • Update-protocol framing pinned: 'when Agent 1 closes a
//     cumulative-rig batch that moves the numerator or
//     denominator, founder relays the new values to Agent 2 in
//     next interaction; Agent 2 lands the update as a Tier 1
//     maintenance commit (no founder review needed for factual
//     technical state).'
//   • Last-update timestamp pinned: '2026-05-03 founder confirmation'.
//   • CUMULATIVE_RIG: as const literal with 5 fields pinned:
//     surfacesMatched 1252 + surfacesMeasured 1253 +
//     matchRatePercentage 99.9 + archetypeReference 'iPhone 16 Pro
//     / iOS 18.7 / Safari 26.4' + lastUpdated '2026-05-03'.
//   • S18 (2026-07-04): DEVICE_SUPPORT fact registry pinned —
//     derivation-source comment (api-types ARCHETYPE_REGISTRY,
//     customer-selectable catalog) + 5 fields + the homepage
//     curated-subset note, with a cross-source invariant importing
//     the registry so archetypeCount can't drift from what the
//     platform actually ships.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ARCHETYPE_REGISTRY } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/data/capabilities.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W462.C apps/marketing-site/src/data/capabilities.ts content parity', () => {
  const body = read(LIB);

  it("Cumulative-rig framing pinned: 'Cumulative-rig snapshot for marketing-surface display.' + Source 'parent driftstack repo /docs/progress/phase-2.md cumulative-rig snapshot (probes-with-iPhone-reference denominator, not raw — raw includes ref=None pinned post-V-141 capture and is NOT the marketing-surface number).'", () => {
    expect(body).toMatch(/\/\/ Cumulative-rig snapshot for marketing-surface display\./);
    expect(body).toMatch(
      /\/\/ Source: parent driftstack repo `\/docs\/progress\/phase-2\.md`\s*\/\/ cumulative-rig snapshot \(probes-with-iPhone-reference denominator,\s*\/\/ not raw — raw includes ref=None pinned post-V-141 capture and is\s*\/\/ NOT the marketing-surface number\)\./,
    );
  });

  it("Update-protocol framing pinned: 'when Agent 1 closes a cumulative-rig batch that moves the numerator or denominator, founder relays the new values to Agent 2 in next interaction; Agent 2 lands the update as a Tier 1 maintenance commit (no founder review needed for factual technical state).'", () => {
    expect(body).toMatch(
      /\/\/ Update protocol: when Agent 1 closes a cumulative-rig batch that\s*\/\/ moves the numerator or denominator, founder relays the new values\s*\/\/ to Agent 2 in next interaction; Agent 2 lands the update as a\s*\/\/ Tier 1 maintenance commit \(no founder review needed for factual\s*\/\/ technical state\)\./,
    );
  });

  it("Last-update timestamp pinned: '2026-05-03 founder confirmation'", () => {
    expect(body).toMatch(/\/\/ Last update: 2026-05-03 founder confirmation\./);
  });

  it("CUMULATIVE_RIG export: `as const` literal-type lock + 5 fields pinned (surfacesMatched 1252 + surfacesMeasured 1253 + matchRatePercentage 99.9 + archetypeReference 'iPhone 16 Pro / iOS 18.7 / Safari 26.4' + lastUpdated '2026-05-03')", () => {
    expect(body).toMatch(
      /export const CUMULATIVE_RIG = \{\s*\/\*\* Surfaces matching the iPhone reference fingerprint exactly\. \*\/\s*surfacesMatched: 1252,\s*\/\*\* Surfaces measured against the iPhone reference \(excludes ref=None\)\. \*\/\s*surfacesMeasured: 1253,\s*\/\*\* Pre-rounded percentage for marketing-headline display\. \*\/\s*matchRatePercentage: 99\.9,\s*\/\*\* Reference archetype the cumulative rig measures against\. \*\/\s*archetypeReference: 'iPhone 16 Pro \/ iOS 18\.7 \/ Safari 26\.4',\s*\/\*\* ISO-8601 date of the last numerator\/denominator update\. \*\/\s*lastUpdated: '2026-05-03',\s*\} as const;/,
    );
  });

  it("S18 DEVICE_SUPPORT derivation-source comment pinned: 'Derivation source: packages/api-types/src/common.ts ARCHETYPE_REGISTRY — the customer-selectable catalog' + 'Values re-derived from the registry on 2026-07-04.' + the update-only-by-re-reading-the-registry rule", () => {
    expect(body).toMatch(/\/\/ Derivation source: packages\/api-types\/src\/common\.ts/);
    expect(body).toMatch(
      /\/\/ ARCHETYPE_REGISTRY — the customer-selectable catalog \(entries with\s*\/\/ status 'launch' \| 'available'/,
    );
    expect(body).toMatch(/Values re-derived from the registry on 2026-07-04\./);
    expect(body).toMatch(
      /Update them ONLY\s*\/\/ by re-reading ARCHETYPE_REGISTRY — never by editing prose first/,
    );
  });

  it('S18 homepage curated-subset note pinned: the proof section intentionally names the flagship subset (iPhone 15 Pro / 16 Pro / 17 lineup) as curated marketing copy — NOT bound to DEVICE_SUPPORT; full-catalog claims (e.g. /roadmap) bind here', () => {
    expect(body).toMatch(/\/\/ NB the homepage proof section/);
    expect(body).toMatch(
      /intentionally names the flagship\s*\/\/ subset as curated marketing copy; it is NOT bound to this constant\./,
    );
    expect(body).toMatch(/Full-catalog claims \(e\.g\. \/roadmap\) bind here\./);
  });

  it("S18 DEVICE_SUPPORT export: `as const` literal with 5 fields pinned (archetypeCount 81 + deviceFamilies 'iPhone 13 → 17 Pro Max' + iosVersions '18.6 / 18.7' + safariVersions '18.6–26.5' + derivedOn '2026-07-04')", () => {
    expect(body).toMatch(
      /export const DEVICE_SUPPORT = \{\s*\/\*\* Customer-selectable archetypes \(registry status 'launch' \| 'available'\)\. \*\/\s*archetypeCount: 81,\s*\/\*\* Device-model span of the catalog \(19 iPhone models between the endpoints\)\. \*\/\s*deviceFamilies: 'iPhone 13 → 17 Pro Max',\s*\/\*\* iOS versions present in the catalog\. \*\/\s*iosVersions: '18\.6 \/ 18\.7',\s*\/\*\* Safari version span present in the catalog \(18\.6, 26\.0, 26\.3, 26\.4, 26\.5\)\. \*\/\s*safariVersions: '18\.6–26\.5',\s*\/\*\* ISO-8601 date the values above were last re-derived from the registry\. \*\/\s*derivedOn: '2026-07-04',\s*\} as const;/,
    );
  });

  it('S18 cross-source invariant: the pinned archetypeCount matches the api-types ARCHETYPE_REGISTRY customer-selectable catalog (status launch | available)', () => {
    const catalogCount = ARCHETYPE_REGISTRY.filter(
      (a) => a.status === 'launch' || a.status === 'available',
    ).length;
    const pinned = body.match(/archetypeCount: (\d+),/)?.[1];
    expect(pinned).toBeTruthy();
    expect(Number(pinned)).toBe(catalogCount);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
