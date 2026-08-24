// Arc 6 docs.pagination — `apps/docs/src/pages/reference/pagination.md`
// content parity. Pins the canonical cursor contract so a future
// refactor that introduces a different pagination shape on any
// endpoint breaks CI loudly.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/docs/src/pages/reference/pagination.md');

describe('Arc 6 docs.pagination — pagination reference parity', () => {
  it('page exists at the expected path', () => {
    expect(existsSync(PAGE)).toBe(true);
  });

  const body = readFileSync(PAGE, 'utf8');

  it('frontmatter declares layout + title + description', () => {
    expect(body).toMatch(/layout: \.\.\/\.\.\/layouts\/DocLayout\.astro/);
    expect(body).toMatch(/title: Pagination/);
    expect(body).toMatch(/description: .*cursor-based pagination/i);
  });

  it('documents the request-shape query parameters (limit + cursor)', () => {
    expect(body).toMatch(/`limit`/);
    expect(body).toMatch(/`cursor`/);
  });

  it('documents the response-shape `data` + `next_cursor` (with null on last page)', () => {
    expect(body).toMatch(/"data":/);
    expect(body).toMatch(/"next_cursor":/);
    expect(body).toMatch(/`null` when the page is the last/);
  });

  it('V-1511 the limit-bounds section does not claim a single number the spec contradicts. It said `Default: 50 on every list endpoint` and named `200` as the top maximum. The document publishes several distinct defaults and a ceiling above the one the page named. Every distinct default and maximum the spec publishes must appear on the page, so a new rail with its own page size cannot leave this section quietly wrong.', () => {
    const spec = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'packages/sdk-python/openapi.json'), 'utf8'),
    ) as { paths: Record<string, Record<string, { parameters?: Record<string, unknown>[] }>> };

    const defaults = new Set<number>();
    const maxima = new Set<number>();
    for (const ops of Object.values(spec.paths)) {
      for (const op of Object.values(ops)) {
        for (const raw of op.parameters ?? []) {
          if (raw['in'] !== 'query' || raw['name'] !== 'limit') continue;
          const schema = raw['schema'] as { default?: number; maximum?: number } | undefined;
          if (typeof schema?.default === 'number') defaults.add(schema.default);
          if (typeof schema?.maximum === 'number') maxima.add(schema.maximum);
        }
      }
    }
    // Reports an absence, so an empty parse would pass having compared nothing.
    expect(defaults.size, 'distinct published `limit` defaults').toBeGreaterThanOrEqual(2);
    expect(maxima.size, 'distinct published `limit` maxima').toBeGreaterThanOrEqual(2);

    const missing = [
      ...[...defaults].map((n) => [`default ${String(n)}`, n] as const),
      ...[...maxima].map((n) => [`maximum ${String(n)}`, n] as const),
    ]
      .filter(([, n]) => !new RegExp(`\`${String(n)}\``).test(body))
      .map(([label]) => label)
      .sort();
    expect(
      missing,
      'the spec publishes these `limit` values and the page never mentions them:',
    ).toEqual([]);
    expect(body).not.toMatch(/Default: `50` on every list endpoint/);
  });

  it('declares cursor opacity (do not parse)', () => {
    expect(body).toMatch(/do not (try to )?parse/i);
    expect(body).toMatch(/opaque/);
  });

  it('canonical drive-to-completion loop in all 3 SDKs (TS / Python / Go). S36 2026-07-07 (fable-truth-audit): the Go example now compiles against the real SDK — query type is *ListAuditLogQuery (ListAuditOpts never existed), List takes a pointer, and AuditLogListPage.NextCursor is *string so the loop nil-checks + derefs it.', () => {
    expect(body).toMatch(/### TypeScript/);
    expect(body).toMatch(/### Python/);
    expect(body).toMatch(/### Go/);
    // Each must check next_cursor for null and break.
    expect(body).toMatch(/if \(!page\.next_cursor\) break;/);
    expect(body).toMatch(/if not page\.next_cursor:/);
    expect(body).toMatch(/&driftstack\.ListAuditLogQuery\{/);
    expect(body).toMatch(/if page\.NextCursor == nil \|\| \*page\.NextCursor == ""/);
    expect(body).toMatch(/cursor = \*page\.NextCursor/);
    // Negative pin — the fictional type must not come back.
    expect(body).not.toMatch(/ListAuditOpts/);
  });

  it('rejects offset/page-number pagination explicitly (stability rationale)', () => {
    expect(body).toMatch(/Offset \/ page-number pagination is not supported/i);
    expect(body).toMatch(/stable under concurrent inserts/i);
  });

  it('documents stability semantics under inserts + deletes', () => {
    expect(body).toMatch(/Stability under writes/);
    expect(body).toMatch(/Stability under deletes/);
  });

  it('documents the anti-patterns customers commonly fall into', () => {
    expect(body).toMatch(/Anti-patterns/);
    expect(body).toMatch(/Don't decode the cursor/);
    expect(body).toMatch(/Don't loop without an exit condition/);
  });

  it('linked from reference/errors.md cross-references section', () => {
    const errors = readFileSync(
      resolve(REPO_ROOT, 'apps/docs/src/pages/reference/errors.md'),
      'utf8',
    );
    expect(errors).toMatch(/\/reference\/pagination/);
  });

  it('reachable from the docs landing via the DOC_NAV Platform-reference section (S22.5 2026-07-06: the landing renders section cards derived from DOC_NAV instead of a hand-kept card grid, so the page is reachable iff its tree entry exists — pinned here in nav.ts, in lockstep with docs-data-nav-content-parity)', () => {
    const idx = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/index.astro'), 'utf8');
    expect(idx).toMatch(/import \{ DOC_NAV \} from '\.\.\/data\/nav';/);
    expect(idx).toMatch(/const sections = DOC_NAV\.map\(/);
    const nav = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/data/nav.ts'), 'utf8');
    expect(nav).toMatch(/\{ href: '\/reference\/pagination\/', label: 'Pagination' \}/);
  });
});
