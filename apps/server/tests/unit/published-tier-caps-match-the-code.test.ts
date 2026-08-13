// The per-tier caps published in the customer guides are the caps the server
// enforces — read as numbers, from the pages customers actually land on.
//
// Two guides publish a full tier table each: `guides/concurrency.md` gives the
// concurrent-session cap for all eight tiers, and `guides/profile-management.md`
// gives the profile cap. Sixteen figures, and nothing compares either table to
// `TIER_CONCURRENT_SESSION_LIMITS` or `PROFILES_PER_TIER`.
//
// This exact failure has already happened on one of these pages. The header of
// `concurrency-doc-parity` records that a previous revision "asserted tier caps
// (Trial Pack: 2, Solo: 5, API Starter: 10, Team: 20, etc.) that are all higher
// than what the server actually enforces" — customers sizing work against those
// numbers hit refusals they had planned around. It was resolved by deleting the
// stale marketing mirror, and that guard now checks the mirror is gone and the
// successor exists. It does not read the successor's numbers, and neither does
// anything else: both files mention the constants only in comments.
//
// `tier-limits-server-side-parity` does compare these constants numerically —
// against `marketing-site/src/data/pricing.ts`. The docs guides are a third
// surface it never sees.
//
// This is the third page in three fires with the same shape: names or existence
// checked, values not. A content-parity pin proves a page still says what it
// said; only reading the numbers says whether it was ever true.
//
// The profile table is keyed by DISPLAY name — Free, Personal, Team — while the
// constants are keyed by slug. The mapping is derived from
// `pricing.ts` (`id` / `name` pairs), never written out here, because a
// hand-kept mapping is the thing that goes stale while every test stays green.
// Enterprise publishes "Custom" against a `custom` sentinel, so it is compared
// as that rather than forced into a number.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROFILES_PER_TIER, TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const CONCURRENCY = resolve(REPO, 'apps/docs/src/pages/guides/concurrency.md');
const PROFILES = resolve(REPO, 'apps/docs/src/pages/guides/profile-management.md');
const PRICING = resolve(REPO, 'apps/marketing-site/src/data/pricing.ts');

/** Display name -> tier slug, derived from the pricing data rather than restated. */
function displayNameToSlug(): Map<string, string> {
  const src = readFileSync(PRICING, 'utf8');
  const out = new Map<string, string>();
  for (const m of src.matchAll(/id:\s*'([a-z_]+)',[\s\S]{0,200}?name:\s*'([^']+)'/g)) {
    out.set(m[2]!, m[1]!);
  }
  return out;
}

/** `| `slug` | 24 |` rows — the concurrency guide keys by slug. */
function capsBySlug(file: string): Map<string, number> {
  const out = new Map<string, number>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\|\s*`([a-z_]+)`\s*\|\s*([\d,]+)\s*\|/.exec(line);
    if (m !== null) out.set(m[1]!, Number(m[2]!.replace(/,/g, '')));
  }
  return out;
}

/** `| Personal | 10 |` rows — the profile guide keys by display name. */
function capsByDisplayName(file: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const m = /^\|\s*([A-Z][A-Za-z ]+?)\s*\|\s*([\d,]+|Custom)\s*\|/.exec(line);
    if (m !== null && m[1] !== 'Tier') out.set(m[1]!, m[2]!.replace(/,/g, ''));
  }
  return out;
}

describe('the tier caps published in the guides match the code', () => {
  it('CRITICAL both tables and the name mapping parsed. Every comparison below reports disagreement, and an empty table disagrees with nothing — a reformatted page would report its caps verified having read none of them.', () => {
    const concurrency = capsBySlug(CONCURRENCY);
    const profiles = capsByDisplayName(PROFILES);
    const names = displayNameToSlug();

    expect(concurrency.size, 'tier rows parsed from the concurrency guide').toBe(
      Object.keys(TIER_CONCURRENT_SESSION_LIMITS).length,
    );
    expect(profiles.size, 'tier rows parsed from the profile guide').toBe(
      Object.keys(PROFILES_PER_TIER).length,
    );
    expect(names.size, 'display-name to slug pairs derived from pricing.ts').toBeGreaterThanOrEqual(
      7,
    );
    // Every display name on the profile page must resolve, or the comparison
    // below silently skips the rows it cannot map — which looks identical to
    // finding them all correct.
    expect(
      [...profiles.keys()].filter((n) => !names.has(n)).sort(),
      'display name(s) on the profile page with no tier in pricing.ts:',
    ).toEqual([]);
  });

  it('CRITICAL every published concurrent-session cap is the cap enforced. This page has already shipped caps higher than the server allowed — the guard written after that incident checks the stale mirror is gone, not that the successor is right.', () => {
    const published = capsBySlug(CONCURRENCY);
    const actual = TIER_CONCURRENT_SESSION_LIMITS as Record<string, number>;
    const wrong = [...published.entries()]
      .filter(([slug, cap]) => actual[slug] !== cap)
      .map(
        ([slug, cap]) =>
          `${slug}: page says ${String(cap)}, server enforces ${String(actual[slug])}`,
      )
      .sort();
    expect(wrong, 'published concurrency cap(s) the server does not enforce:').toEqual([]);
  });

  it('CRITICAL every published profile cap is the cap enforced. Enterprise publishes "Custom" against the `custom` sentinel and is compared as that, rather than coerced into a number that would quietly become NaN and match nothing.', () => {
    const published = capsByDisplayName(PROFILES);
    const names = displayNameToSlug();
    const actual = PROFILES_PER_TIER as Record<string, number | string>;
    const wrong: string[] = [];
    for (const [display, claimed] of published) {
      const slug = names.get(display);
      if (slug === undefined) continue;
      const enforced = actual[slug];
      const agrees = claimed === 'Custom' ? enforced === 'custom' : String(enforced) === claimed;
      if (!agrees) {
        wrong.push(
          `${display} (${slug}): page says ${claimed}, server enforces ${String(enforced)}`,
        );
      }
    }
    expect(wrong.sort(), 'published profile cap(s) the server does not enforce:').toEqual([]);
  });

  it('CRITICAL every tier the server knows is published in both guides. A tier absent from a page is a customer with no published cap at all, and the omission is invisible in a comparison that only walks the rows the page happens to have.', () => {
    const concurrency = capsBySlug(CONCURRENCY);
    const profiles = capsByDisplayName(PROFILES);
    const names = displayNameToSlug();
    const publishedProfileSlugs = new Set(
      [...profiles.keys()].map((n) => names.get(n)).filter((s): s is string => s !== undefined),
    );
    expect(
      Object.keys(TIER_CONCURRENT_SESSION_LIMITS)
        .filter((t) => !concurrency.has(t))
        .sort(),
      'tier(s) missing from the concurrency guide:',
    ).toEqual([]);
    expect(
      Object.keys(PROFILES_PER_TIER)
        .filter((t) => !publishedProfileSlugs.has(t))
        .sort(),
      'tier(s) missing from the profile guide:',
    ).toEqual([]);
  });
});
