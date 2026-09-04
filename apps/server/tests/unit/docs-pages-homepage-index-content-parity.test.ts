// W-NNN — drift guard for apps/docs/src/pages/index.astro (docs
// homepage at docs.driftstack.io/). Sibling to docs-pages-api-index-
// content-parity.test.ts which covers the /api sub-TOC; this one
// covers the top-level reference reachability that's the first thing
// a new SDK consumer sees.
//
// S22.5 (2026-07-06, Stoplight redesign final slice) — the homepage's
// hand-kept 13-card `reference` array is SUPERSEDED by DOC_NAV-derived
// section cards: index.astro imports DOC_NAV and renders one card per
// section, so no API surface can be silently hidden from the homepage
// without first being dropped from the tree itself (which
// docs-data-nav-content-parity + doc-nav-href-integrity guard). The
// per-href pins therefore re-point at src/data/nav.ts, and the
// homepage assertion pins the DOC_NAV-derived rendering. The Recipes
// v1.0/v1.1 scope clause this suite defended now rides the /api index
// page (still verbatim there, alongside api/recipes.md +
// sdk/installation.md).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/index.astro');
const NAV = resolve(REPO_ROOT, 'apps/docs/src/data/nav.ts');
const API_INDEX = resolve(REPO_ROOT, 'apps/docs/src/pages/api/index.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('docs homepage reference list content parity', () => {
  const body = read(PAGE);
  const nav = read(NAV);
  const apiIndex = read(API_INDEX);

  it('file exists at canonical path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  it('S22.5 — homepage renders every DOC_NAV section (cards derive labels/hrefs/page counts from the tree source, so homepage coverage tracks the tree 1:1)', () => {
    expect(body).toMatch(/import \{ DOC_NAV \} from '\.\.\/data\/nav';/);
    expect(body).toMatch(/const sections = DOC_NAV\.map\(\(s\) => \(\{/);
    expect(body).toMatch(/sections\.map\(\(s\) => \(/);
  });

  // The reference surfaces this suite pinned on the homepage's card
  // grid stay pinned in DOC_NAV (which the homepage section cards +
  // the left tree render on every page). Slice 145 added the Recipes
  // entry; pinning it here defends against accidental removal.
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
  ])('DOC_NAV pins %s (rendered on the homepage via section cards + the tree)', (anchor) => {
    expect(nav).toContain(anchor);
  });

  it('Recipes surface carries the v1.0/v1.1 scope qualifier on the /api index (matches slice 121 roadmap.astro promotion + slice 143 about.astro framing — drift to dropping the create/list/read/delete-at-v1.0 + execute-only-at-v1.1 clause would re-open the marketing-vs-reality gap closed across the 3 surfaces). S22.5: re-pointed from the superseded homepage card to api/index.astro, where the clause appears verbatim.', () => {
    expect(apiIndex).toMatch(/<a href="\/api\/recipes\/">Recipes<\/a>/);
    // `1c9f80b24` replaced the prelaunch version promise with a present-tense
    // contract. The load-bearing claim is unchanged — create/list/read/delete
    // exist and execution does not — but it must not be restated as a dated
    // roadmap commitment, so the shipped copy is pinned as-is.
    expect(apiIndex).toMatch(
      /The current API supports create \/ list \/ read \/ delete;\s+it does not expose recipe execution\./,
    );
    // Ban the superseded "Write-only at v1.0" framing and any return to a
    // version-dated promise for recipe execution.
    expect(apiIndex).not.toMatch(/Write-only at v1\.0/);
    expect(apiIndex).not.toMatch(/lands at v1\.1/);
    expect(body).not.toMatch(/Write-only at v1\.0/);
  });
});
