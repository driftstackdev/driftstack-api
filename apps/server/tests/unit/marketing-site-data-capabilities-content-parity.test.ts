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

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

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
      /\/\/ Source: parent driftstack repo `\/docs\/progress\/phase-2\.md`\s*\n?\s*\/\/ cumulative-rig snapshot \(probes-with-iPhone-reference denominator,\s*\n?\s*\/\/ not raw — raw includes ref=None pinned post-V-141 capture and is\s*\n?\s*\/\/ NOT the marketing-surface number\)\./,
    );
  });

  it("Update-protocol framing pinned: 'when Agent 1 closes a cumulative-rig batch that moves the numerator or denominator, founder relays the new values to Agent 2 in next interaction; Agent 2 lands the update as a Tier 1 maintenance commit (no founder review needed for factual technical state).'", () => {
    expect(body).toMatch(
      /\/\/ Update protocol: when Agent 1 closes a cumulative-rig batch that\s*\n?\s*\/\/ moves the numerator or denominator, founder relays the new values\s*\n?\s*\/\/ to Agent 2 in next interaction; Agent 2 lands the update as a\s*\n?\s*\/\/ Tier 1 maintenance commit \(no founder review needed for factual\s*\n?\s*\/\/ technical state\)\./,
    );
  });

  it("Last-update timestamp pinned: '2026-05-03 founder confirmation'", () => {
    expect(body).toMatch(/\/\/ Last update: 2026-05-03 founder confirmation\./);
  });

  it("CUMULATIVE_RIG export: `as const` literal-type lock + 5 fields pinned (surfacesMatched 1252 + surfacesMeasured 1253 + matchRatePercentage 99.9 + archetypeReference 'iPhone 16 Pro / iOS 18.7 / Safari 26.4' + lastUpdated '2026-05-03')", () => {
    expect(body).toMatch(
      /export const CUMULATIVE_RIG = \{\s*\n?\s*\/\*\* Surfaces matching the iPhone reference fingerprint exactly\. \*\/\s*\n?\s*surfacesMatched: 1252,\s*\n?\s*\/\*\* Surfaces measured against the iPhone reference \(excludes ref=None\)\. \*\/\s*\n?\s*surfacesMeasured: 1253,\s*\n?\s*\/\*\* Pre-rounded percentage for marketing-headline display\. \*\/\s*\n?\s*matchRatePercentage: 99\.9,\s*\n?\s*\/\*\* Reference archetype the cumulative rig measures against\. \*\/\s*\n?\s*archetypeReference: 'iPhone 16 Pro \/ iOS 18\.7 \/ Safari 26\.4',\s*\n?\s*\/\*\* ISO-8601 date of the last numerator\/denominator update\. \*\/\s*\n?\s*lastUpdated: '2026-05-03',\s*\n?\s*\} as const;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
