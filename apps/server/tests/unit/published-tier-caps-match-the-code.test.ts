// The per-tier caps published in the customer docs are the caps the server
// enforces — every surface, read as numbers.
//
// SIX pages republish the same two facts. Concurrency appears in
// `guides/concurrency.md`, `api/sessions.md`, `api/usage.md` and
// `guides/session-lifecycle.md`; the profile cap in
// `guides/profile-management.md`, `api/profiles.md` and `api/usage.md` again.
// Forty-eight figures across six files, and nothing read any of them against
// `TIER_CONCURRENT_SESSION_LIMITS` or `PROFILES_PER_TIER`.
//
// Finding them one page per session was the actual problem. Three consecutive
// sessions each turned up one more surface stating the same numbers, so this is
// written surface-driven: adding a seventh page is one row in the table below,
// and the comparison, the tier-completeness check and the floors come with it.
//
// One page was wrong. `guides/session-lifecycle.md` published Enterprise
// concurrency as "Custom" while the server enforces 32 — on a page whose own
// sentence calls these "a hard cap ... exceeding the cap returns 429". Its
// sibling `guides/concurrency.md` states 32 with "contract floor — per-account
// overrides raise it further", so the two guides contradicted each other and an
// enterprise reader had no way to learn which number produces the 429 they will
// actually hit. The profile cap for that tier IS a `custom` sentinel, which is
// where the wrong convention was borrowed from.
//
// This exact failure has history on the concurrency page too:
// `concurrency-doc-parity`'s header records a revision that "asserted tier caps
// (Trial Pack: 2, Solo: 5, API Starter: 10, Team: 20, etc.) that are all higher
// than what the server actually enforces". That was fixed by deleting the stale
// mirror; the guard written afterwards checks the mirror is gone, not that the
// successor is right.
//
// `tier-limits-server-side-parity` does compare these constants numerically —
// against `marketing-site/src/data/pricing.ts`. The docs are surfaces it never
// sees.
//
// Two pages key rows by DISPLAY name — Free, Personal, Team — while the
// constants key by slug. That mapping is derived from `pricing.ts` (`id` /
// `name` pairs), never written out here: a hand-kept mapping goes stale while
// every test stays green, and the failure is silent in the worst way, because
// an unmappable row is skipped and a skipped row looks exactly like a correct
// one. Enterprise publishes "Custom" for profiles against a `custom` sentinel
// and is compared as that, not coerced into a NaN that matches nothing.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PROFILES_PER_TIER, TIER_CONCURRENT_SESSION_LIMITS } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const DOCS = resolve(REPO, 'apps/docs/src/pages');
const PRICING = resolve(REPO, 'apps/marketing-site/src/data/pricing.ts');

type Cap = 'concurrency' | 'profiles';

/**
 * Every page that republishes a tier cap, and which column states what.
 *
 * `column` is the zero-based index among the cells AFTER the tier cell, so a
 * page that adds a Notes column keeps working and a page that reorders its
 * columns fails loudly rather than comparing the wrong pair.
 */
const SURFACES: { file: string; key: 'slug' | 'name'; columns: { column: number; cap: Cap }[] }[] =
  [
    { file: 'guides/concurrency.md', key: 'slug', columns: [{ column: 0, cap: 'concurrency' }] },
    { file: 'api/sessions.md', key: 'slug', columns: [{ column: 0, cap: 'concurrency' }] },
    { file: 'api/profiles.md', key: 'slug', columns: [{ column: 0, cap: 'profiles' }] },
    {
      file: 'api/usage.md',
      key: 'slug',
      columns: [
        { column: 0, cap: 'concurrency' },
        { column: 1, cap: 'profiles' },
      ],
    },
    {
      file: 'guides/profile-management.md',
      key: 'name',
      columns: [{ column: 0, cap: 'profiles' }],
    },
    {
      file: 'guides/session-lifecycle.md',
      key: 'name',
      columns: [{ column: 0, cap: 'concurrency' }],
    },
  ];

const DISPLAY_NAMES = new Set([
  'Free',
  'Personal',
  'Team',
  'Agency',
  'API Starter',
  'API Builder',
  'API Scale',
  'Enterprise',
]);

/** Display name -> tier slug, derived from the pricing data rather than restated. */
function displayNameToSlug(): Map<string, string> {
  const src = readFileSync(PRICING, 'utf8');
  const out = new Map<string, string>();
  for (const m of src.matchAll(/id:\s*'([a-z_]+)',[\s\S]{0,200}?name:\s*'([^']+)'/g)) {
    out.set(m[2]!, m[1]!);
  }
  return out;
}

interface Row {
  slug: string;
  cells: string[];
}

/** Tier rows of one page, keyed by slug however the page spells them. */
function rowsOf(surface: (typeof SURFACES)[number], names: Map<string, string>): Row[] {
  const md = readFileSync(resolve(DOCS, surface.file), 'utf8');
  const out: Row[] = [];
  for (const line of md.split('\n')) {
    const m =
      surface.key === 'slug'
        ? /^\|\s*`([a-z_]+)`\s*\|(.+)\|\s*$/.exec(line)
        : /^\|\s*([A-Z][A-Za-z ]+?)\s*\|(.+)\|\s*$/.exec(line);
    if (m === null) continue;
    const label = m[1]!;
    if (surface.key === 'name' && !DISPLAY_NAMES.has(label)) continue;
    const slug = surface.key === 'slug' ? label : names.get(label);
    if (slug === undefined) continue;
    out.push({ slug, cells: (m[2] ?? '').split('|').map((c) => c.trim()) });
  }
  return out;
}

const CAPS: Record<Cap, Record<string, number | string>> = {
  concurrency: TIER_CONCURRENT_SESSION_LIMITS,
  profiles: PROFILES_PER_TIER,
};

describe('the tier caps published across the docs match the code', () => {
  it('CRITICAL every surface parsed a full tier table, and every display name resolved. A comparison walks only the rows it found, so a reformatted page or an unmappable name reports its caps verified having read none of them.', () => {
    const names = displayNameToSlug();
    expect(names.size, 'display-name to slug pairs derived from pricing.ts').toBeGreaterThanOrEqual(
      7,
    );
    const tierCount = Object.keys(TIER_CONCURRENT_SESSION_LIMITS).length;
    const short = SURFACES.filter((s) => rowsOf(s, names).length !== tierCount).map(
      (s) => `${s.file}: ${String(rowsOf(s, names).length)} of ${String(tierCount)} tiers`,
    );
    expect(short, 'page(s) whose tier table did not parse in full:').toEqual([]);

    // A display-name page whose labels stopped resolving would parse to zero
    // rows and be caught above — this states the mapping direction explicitly
    // so the reason is visible in the failure rather than inferred.
    const unmapped = SURFACES.filter((s) => s.key === 'name').flatMap((s) => {
      const md = readFileSync(resolve(DOCS, s.file), 'utf8');
      return [...md.matchAll(/^\|\s*([A-Z][A-Za-z ]+?)\s*\|/gm)]
        .map((m) => m[1]!)
        .filter((n) => DISPLAY_NAMES.has(n) && !names.has(n))
        .map((n) => `${s.file}: ${n}`);
    });
    expect(unmapped.sort(), 'display name(s) with no tier in pricing.ts:').toEqual([]);
  });

  it('CRITICAL every published cap on every surface equals what the server enforces. Six pages restate these numbers; before this only two of them were read, and each session of looking turned up another page saying the same thing unchecked.', () => {
    const names = displayNameToSlug();
    const wrong: string[] = [];
    for (const surface of SURFACES) {
      for (const row of rowsOf(surface, names)) {
        for (const col of surface.columns) {
          const claimed = (row.cells[col.column] ?? '').replace(/,/g, '');
          if (claimed === '') continue;
          const enforced = CAPS[col.cap][row.slug];
          const agrees =
            claimed === 'Custom' ? enforced === 'custom' : String(enforced) === claimed;
          if (!agrees) {
            wrong.push(
              `${surface.file} ${row.slug} ${col.cap}: page says ${claimed}, server enforces ${String(enforced)}`,
            );
          }
        }
      }
    }
    expect(wrong.sort(), 'published cap(s) the server does not enforce:').toEqual([]);
  });

  it('CRITICAL every tier the server knows appears on every surface that publishes that cap. A tier missing from a page is a customer with no published cap at all, and an omission is invisible to a comparison that only walks the rows a page happens to have.', () => {
    const names = displayNameToSlug();
    const missing: string[] = [];
    for (const surface of SURFACES) {
      const published = new Set(rowsOf(surface, names).map((r) => r.slug));
      for (const cap of new Set(surface.columns.map((c) => c.cap))) {
        for (const tier of Object.keys(CAPS[cap])) {
          if (!published.has(tier)) missing.push(`${surface.file}: ${tier} (${cap})`);
        }
      }
    }
    expect(missing.sort(), 'tier(s) absent from a page that publishes their cap:').toEqual([]);
  });
});
