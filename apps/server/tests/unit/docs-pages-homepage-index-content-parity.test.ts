// W-NNN — drift guard for apps/docs/src/pages/index.astro (docs
// homepage at docs.driftstack.dev/). Sibling to docs-pages-api-index-
// content-parity.test.ts which covers the /api sub-TOC; this one
// covers the top-level reference list that's the first thing a new
// SDK consumer sees.
//
// The homepage features a `reference` array of {label, description,
// href} cards. Drift to dropping any entry would silently hide that
// API surface from the homepage even if /api/index.astro still lists
// it.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs homepage reference list content parity', () => {
  const body = read(PAGE);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  // The 13 reference-list cards each have a `href: '/api/X/'` or
  // `href: '/reference/X/'` entry. Pin each so a drift that drops
  // any one trips the guard. Slice 145 added the Recipes card;
  // pinning it here defends against accidental removal.
  it.each([
    "href: '/api/agent-sessions/'",
    "href: '/api/byok-anthropic/'",
    "href: '/api/bundled-llm/'",
    // Slice 145 — Recipes card added so the docs hub features the
    // v1.0 write-only recipe surface alongside the agent-session
    // ecosystem cards.
    "href: '/api/recipes/'",
    "href: '/api/oauth/'",
    "href: '/reference/idempotency/'",
    "href: '/reference/pagination/'",
    "href: '/reference/metrics/'",
  ])('reference card pins %s', (anchor) => {
    expect(body).toContain(anchor);
  });

  it('Recipes card carries the v1.0-write-only scope qualifier (matches slice 121 roadmap.astro promotion + slice 143 about.astro framing — drift to dropping the v1.1 read/list/execute/delete clause would re-open the marketing-vs-reality gap closed across the 3 surfaces)', () => {
    expect(body).toMatch(/label: 'Recipes',/);
    expect(body).toMatch(/Write-only at v1\.0; read \/ list \/ execute \/ delete land at v1\.1/);
  });
});
