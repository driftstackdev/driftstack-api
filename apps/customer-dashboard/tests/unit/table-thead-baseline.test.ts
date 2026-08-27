// W298.B — accessibility baseline for customer-dashboard <table>
// elements. Every table should declare a <thead> with semantic
// <th scope="col"> headers so screen readers announce column
// names per cell. Catches drift where a new table ships without
// proper header markup.

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

describe('W298.B customer-dashboard <table> thead baseline', () => {
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

  it('every <table> tag has at least one matching <thead> in the file', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      const tableCount = (body.match(/<table\b/g) || []).length;
      const theadCount = (body.match(/<thead\b/g) || []).length;
      // Allow tables without thead if there's none at all (no tables).
      if (tableCount > 0 && theadCount < tableCount) {
        offenders.push(
          `${f.slice(REPO_ROOT.length + 1)}: ${tableCount} table(s), ${theadCount} thead(s)`,
        );
      }
    }
    expect(offenders).toEqual([]);
  });
});
