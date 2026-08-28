// W335.C — drift guard for DashboardLayout sidebar nav. Each
// navItem href must resolve to a real page file under
// apps/customer-dashboard/src/pages/. Catches drift if a page is
// renamed/removed without updating the nav, or vice versa.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/customer-dashboard/src/layouts/DashboardLayout.astro');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir))
    throw new Error(
      `walk root is missing: ${dir} — a sweep over a missing tree reports nothing to sweep, which reads as clean; if the tree moved, update the root`,
    );
  for (const e of readdirSync(dir)) {
    const full = resolve(dir, e);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const pagesUrls = new Set<string>();
for (const f of walk(PAGES_DIR)) {
  if (!/\.(astro|md)$/.test(f)) continue;
  const rel = f.slice(PAGES_DIR.length).replace(/\\/g, '/');
  let route = rel.replace(/\.(astro|md)$/, '');
  if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);
  if (route === '') route = '/';
  pagesUrls.add(route);
}

describe('W335.C DashboardLayout sidebar nav baseline', () => {
  const body = read(LAYOUT);
  const navHrefs = [...body.matchAll(/href:\s*'(\/[A-Za-z0-9/_-]*)'/g)].map((m) => m[1]!);

  it('extracts at least 8 nav items', () => {
    expect(navHrefs.length).toBeGreaterThanOrEqual(8);
  });

  it('every sidebar href resolves to a real dashboard page', () => {
    const offenders = navHrefs.filter((h) => !pagesUrls.has(h));
    expect(offenders).toEqual([]);
  });

  it('nav covers the canonical customer-facing surfaces (2026-07-02 account-portal IA — operational surfaces live in the desktop GUI, not the web nav)', () => {
    for (const expected of [
      '/',
      '/api-keys',
      '/webhooks',
      '/usage',
      '/billing',
      '/audit-log',
      '/team',
      '/security',
      '/settings',
    ]) {
      expect(navHrefs).toContain(expected);
    }
  });
});
