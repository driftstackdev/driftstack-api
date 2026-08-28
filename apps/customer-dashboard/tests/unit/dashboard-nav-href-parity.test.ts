// W281.A — drift guard for DashboardLayout nav items. Every nav
// href in the layout must resolve to a real page file under
// src/pages. Catches the regression class where a page is renamed
// but the nav still points to the old slug, or where a nav item is
// added for a page that doesn't exist yet.

import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, relative } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');
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

// Build the page URL set.
const pageUrls = new Set<string>(['/']);
for (const f of walk(PAGES).filter((f) => /\.astro$/.test(f))) {
  const rel = relative(PAGES, f).replace(/\\/g, '/');
  const url = '/' + rel.replace(/\.astro$/, '').replace(/(^|\/)index$/, '');
  pageUrls.add(url.endsWith('/') ? url.slice(0, -1) || '/' : url);
}

describe('W281.A DashboardLayout nav-item ↔ page parity', () => {
  const layout = read(LAYOUT);
  const navHrefs = [...layout.matchAll(/\{\s*href:\s*['"]([^'"]+)['"]\s*,\s*label:/g)].map(
    (m) => m[1]!,
  );

  it('layout declares the expected primary nav items', () => {
    expect(navHrefs.length).toBeGreaterThan(5);
    expect(navHrefs).toContain('/');
    expect(navHrefs).toContain('/billing');
    expect(navHrefs).toContain('/api-keys');
  });

  it('every nav href resolves to a real page file', () => {
    const offenders = navHrefs.filter((h) => !pageUrls.has(h));
    expect(offenders).toEqual([]);
  });
});
