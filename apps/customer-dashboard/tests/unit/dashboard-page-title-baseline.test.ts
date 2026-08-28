// W287.B — drift guard for customer-dashboard page titles. Every
// .astro page under src/pages must wrap its body in DashboardLayout
// and pass a non-empty title prop. Catches drift where a new page
// renders with the default/empty title.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGES = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
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

describe('W287.B customer-dashboard page-title baseline', () => {
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

  it('every page passes a non-empty title prop to DashboardLayout (string literal OR dynamic expression)', () => {
    const offenders: string[] = [];
    for (const f of pages) {
      const body = read(f);
      // Match either title="..." string-literal OR title={...} expression.
      const stringForm = body.match(/<DashboardLayout\b[^>]*\btitle=["']([^"']*)["']/);
      const exprForm = body.match(/<DashboardLayout\b[^>]*\btitle=\{([^}]+)\}/);
      const titleStr = stringForm?.[1] ?? '';
      const titleExpr = exprForm?.[1]?.trim() ?? '';
      if (titleStr.length === 0 && titleExpr.length === 0) {
        offenders.push(f.slice(REPO_ROOT.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no two pages share an identical string-literal title (dynamic-expression titles excluded — they vary per request)', () => {
    const titles: { file: string; title: string }[] = [];
    for (const f of pages) {
      const body = read(f);
      const m = body.match(/<DashboardLayout\b[^>]*\btitle=["']([^"']+)["']/);
      if (m) {
        titles.push({ file: f.slice(REPO_ROOT.length + 1), title: m[1]! });
      }
    }
    const seen = new Map<string, string>();
    const dupes: { title: string; files: string[] }[] = [];
    for (const t of titles) {
      if (seen.has(t.title)) {
        dupes.push({ title: t.title, files: [seen.get(t.title)!, t.file] });
      } else {
        seen.set(t.title, t.file);
      }
    }
    expect(dupes).toEqual([]);
  });
});
