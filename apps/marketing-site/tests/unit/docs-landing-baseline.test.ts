// W331.B — drift guard for marketing /docs landing page card grid.
// Cards link to a curated set of sub-pages. Every card href must
// resolve to a real file under apps/marketing-site/src/pages/.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs.astro');
const PAGES_DIR = resolve(REPO_ROOT, 'apps/marketing-site/src/pages');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

function pageExists(href: string): boolean {
  // Strip leading slash; the marketing pages dir doesn't carry one.
  const rel = href.replace(/^\//, '').replace(/\/$/, '');
  // Try .astro + .md + subdir-index.
  return [
    resolve(PAGES_DIR, rel + '.astro'),
    resolve(PAGES_DIR, rel + '.md'),
    resolve(PAGES_DIR, rel, 'index.astro'),
    resolve(PAGES_DIR, rel, 'index.md'),
  ].some((p) => existsSync(p));
}

describe('W331.B /docs landing card-grid baseline', () => {
  const body = read(PAGE);
  const cards = [...body.matchAll(/href="(\/[A-Za-z0-9/_-]+)"/g)].map((m) => m[1]!);

  it('finds at least 4 card links', () => {
    expect(cards.length).toBeGreaterThanOrEqual(4);
  });

  it('every card href resolves to an existing marketing page', () => {
    const offenders = cards.filter((h) => !pageExists(h));
    expect(offenders).toEqual([]);
  });
});
