// W299.B — drift guard for customer-dashboard date formatting.
// Pages render API timestamps that arrive as ISO-8601 strings.
// They should be converted via `new Date(...).toLocaleString()` or
// similar — NOT cast to a raw string for display. Catches drift
// where a page shows `2026-05-09T14:30:00.000Z` raw to the user.
//
// Heuristic: any inline `2026-05-...` literal (or other YYYY-MM-DD
// hard-coded date) within visible DOM is suspect.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const pages = walk(PAGES).filter((f) => /\.astro$/.test(f));

describe('W299.B customer-dashboard date-formatting baseline', () => {
  it('CRITICAL the walk found the pages — every assertion below is over `pages`', () => {
    // `walk` returns [] for a missing directory, so a moved or renamed root makes
    // every arm in this file pass over an empty list: zero pages have zero
    // offenders. The named member is the part that cannot be satisfied by an
    // empty walk, and unlike a count it does not churn as pages are added.
    expect(pages.length).toBeGreaterThan(12);
    expect(
      pages.some((f) => f.endsWith('billing.astro')),
      'the dashboard pages root produced nothing — the walk did not reach it',
    ).toBe(true);
  });

  it('pages that touch dates use toLocaleString / toLocaleDateString for display', () => {
    // Any page that mentions a `created_at` / `*_at` field should
    // also use a locale-aware formatter somewhere — not raw string
    // concatenation to display the ISO timestamp.
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      if (!/\b\w+_at\b/.test(body)) continue;
      // Subscription page is V-134 stub w/ mock data, exempt.
      if (/subscription\.astro$/.test(f)) continue;
      // `Date.parse(...)` counts too: a page may consume a `*_at` value purely
      // as a numeric deadline for timer arithmetic and never render it. The
      // old allowlist matched the literal `Date(`, which `Date.parse(` does not
      // contain, so select-tier.astro — which parses `expires_at` into an
      // expiry deadline and never puts it in the DOM — was a false positive.
      if (
        !/toLocaleString|toLocaleDateString|toLocaleTimeString|Intl\.DateTimeFormat|Date\(|Date\.parse\(/.test(
          body,
        )
      ) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});
