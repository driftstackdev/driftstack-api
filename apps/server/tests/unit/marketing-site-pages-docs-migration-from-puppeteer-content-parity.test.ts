// W521.A — drift guard for apps/marketing-site/src/pages/docs/migration-from-puppeteer.astro.
// V-700 Puppeteer/Playwright migration guide. Drift here either changes
// a concept-mapping row (would create marketing↔SDK divergence) or
// breaks the "arbitrary script eval not exposed" commitment (would
//
// S47 2026-07-07 (founder-approved: mirror deprecation) — SUPERSEDED.
// The legacy marketing mirror page /docs/migration-from-puppeteer is DELETED and
// 301-redirects (apps/marketing-site/public/_redirects) to its
// verified docs successor:
//   https://docs.driftstack.dev/guides/migrate-from-puppeteer/
//   (source: apps/docs/src/pages/guides/migrate-from-puppeteer.md; S29/S37 content batches — every claim
//   re-verified against server source before carry-over. Ongoing
//   content-parity guarding for this topic lives with the docs
//   page's own pin lattice.)
// This file stays as a redirect tombstone so the original guard
// history above remains greppable and the deprecation cannot
// silently regress (page resurrection would shadow the 301 —
// CF Pages serves static assets before _redirects).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(
  REPO_ROOT,
  'apps/marketing-site/src/pages/docs/migration-from-puppeteer.astro',
);
const REDIRECTS = resolve(REPO_ROOT, 'apps/marketing-site/public/_redirects');
const DOCS_SUCCESSOR_SRC = resolve(
  REPO_ROOT,
  'apps/docs/src/pages/guides/migrate-from-puppeteer.md',
);

describe('S47 redirect tombstone — /docs/migration-from-puppeteer → https://docs.driftstack.dev/guides/migrate-from-puppeteer/', () => {
  it('mirror page stays deleted; both _redirects rules (bare + trailing slash) 301 to the live docs successor', () => {
    expect(
      existsSync(PAGE),
      'migration-from-puppeteer.astro must stay deleted — a restored page file would shadow the 301',
    ).toBe(false);

    const rules = readFileSync(REDIRECTS, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split(/\s+/));
    const rule = (from: string) => rules.find((t) => t[0] === from);

    expect(rule('/docs/migration-from-puppeteer'), 'bare-path rule missing').toEqual([
      '/docs/migration-from-puppeteer',
      'https://docs.driftstack.dev/guides/migrate-from-puppeteer/',
      '301',
    ]);
    expect(
      rule('/docs/migration-from-puppeteer/'),
      'trailing-slash rule missing (matching is exact-path)',
    ).toEqual([
      '/docs/migration-from-puppeteer/',
      'https://docs.driftstack.dev/guides/migrate-from-puppeteer/',
      '301',
    ]);
  });

  it('the docs successor source page still exists (a docs-side rename/move must update the redirect target)', () => {
    expect(existsSync(DOCS_SUCCESSOR_SRC)).toBe(true);
  });
});
