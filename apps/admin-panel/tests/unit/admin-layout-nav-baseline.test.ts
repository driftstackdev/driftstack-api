// W336.C — drift guard for AdminLayout sidebar nav. Each navItem
// href must resolve to a real admin-panel page file. Catches drift
// if a page gets renamed/removed without the nav update.

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LAYOUT = resolve(REPO_ROOT, 'apps/admin-panel/src/layouts/AdminLayout.astro');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/admin-panel/src/pages');

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
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
  if (!/\.astro$/.test(f)) continue;
  const rel = f.slice(PAGES_DIR.length).replace(/\\/g, '/');
  let route = rel.replace(/\.astro$/, '');
  if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);
  if (route === '') route = '/';
  pagesUrls.add(route);
}

describe('W336.C AdminLayout sidebar nav baseline', () => {
  const body = read(LAYOUT);
  const navHrefs = [...body.matchAll(/href:\s*'(\/[A-Za-z0-9/_-]*)'/g)].map((m) => m[1]!);

  it('extracts at least 8 admin nav items', () => {
    expect(navHrefs.length).toBeGreaterThanOrEqual(8);
  });

  it('every admin nav href resolves to a real admin page', () => {
    const offenders = navHrefs.filter((h) => !pagesUrls.has(h));
    expect(offenders).toEqual([]);
  });

  it('nav covers the canonical admin surfaces', () => {
    for (const expected of [
      '/accounts',
      '/audit-log',
      '/incidents',
      '/status-subscribers',
      '/sessions',
      '/api-keys',
      '/webhook-dlq',
      '/rate-limit-overrides',
    ]) {
      expect(navHrefs).toContain(expected);
    }
    expect(navHrefs).not.toContain('/leads');
  });
});
