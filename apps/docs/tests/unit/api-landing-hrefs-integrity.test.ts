// W335.A — drift guard for docs /api landing page links. Every
// internal href on the page must resolve to a docs page file under
// apps/docs/src/pages/. Catches drift when the page lists a doc
// section that doesn't exist yet (or has been renamed).

import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/api/index.astro');
const DOCS_PAGES = resolve(REPO_ROOT, 'apps/docs/src/pages');

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

const docsUrls = new Set<string>();
for (const f of walk(DOCS_PAGES)) {
  if (!/\.(md|astro)$/.test(f)) continue;
  const rel = f.slice(DOCS_PAGES.length).replace(/\\/g, '/');
  let route = rel.replace(/\.(md|astro)$/, '');
  if (route.endsWith('/index')) route = route.slice(0, -'/index'.length);
  docsUrls.add(route);
  docsUrls.add(route + '/');
}

describe('W335.A docs /api landing href integrity', () => {
  const body = read(PAGE);
  const hrefs = [...body.matchAll(/href="(\/[A-Za-z0-9/_-]+)"/g)].map((m) => m[1]!);

  it('extracts at least 10 hrefs from the page', () => {
    expect(hrefs.length).toBeGreaterThanOrEqual(10);
  });

  it('every internal href resolves to a docs page', () => {
    const offenders = hrefs.filter((h) => !docsUrls.has(h) && !docsUrls.has(h.replace(/\/$/, '')));
    expect(offenders).toEqual([]);
  });
});
