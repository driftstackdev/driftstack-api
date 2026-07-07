// W343.A — drift guard for /docs/error-codes. The page enumerates
// every problem-type slug Driftstack returns. Constraints:
//
//   1. Every page slug must resolve to a PROBLEM_TYPES entry —
//      otherwise the page advertises a slug the server never emits.
//   2. Every PROBLEM_TYPES entry must appear on the page —
//      otherwise customers can't dispatch on a slug their client
//      will receive.
//   3. The advertised response shape (flat type/title/status/detail
//      + extensions, NO `{error:{code,message}}` envelope) must
//      stay pinned — W203 explicitly rewrote this page to fix that
//      fiction.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/error-codes.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W343.A /docs/error-codes ↔ PROBLEM_TYPES parity', () => {
  const body = read(PAGE);

  // Derive the canonical slug set from PROBLEM_TYPES.
  const canonicalSlugs = new Set<string>(
    Object.values(PROBLEM_TYPES).map((u) => u.replace(/^https:\/\/errors\.driftstack\.dev\//, '')),
  );

  // Every `uri: 'slug'` literal in the ERRORS array.
  const pageSlugs = new Set<string>(
    [...body.matchAll(/uri:\s*'([a-z][a-z-]+)'/g)].map((m) => m[1]!),
  );

  it('PROBLEM_TYPES is non-trivially large (canary against accidental enum truncation)', () => {
    expect(canonicalSlugs.size).toBeGreaterThanOrEqual(20);
  });

  it('every page slug is a real PROBLEM_TYPES entry', () => {
    const offenders = [...pageSlugs].filter((s) => !canonicalSlugs.has(s));
    expect(offenders).toEqual([]);
  });

  it('every PROBLEM_TYPES entry is documented on the page', () => {
    const missing = [...canonicalSlugs].filter((s) => !pageSlugs.has(s));
    expect(missing).toEqual([]);
  });

  it('page declares RFC 7807 + application/problem+json framing', () => {
    expect(body).toMatch(/RFC 7807/);
    expect(body).toMatch(/application\/problem\+json/);
  });

  it('canonical example response is the flat shape (not the {error:{…}} envelope)', () => {
    // The example block must show the flat keys type/title/status/
    // detail + retry_after_seconds.
    expect(body).toMatch(/"type":\s*"https:\/\/errors\.driftstack\.dev\/rate-limited"/);
    expect(body).toMatch(/"title":\s*"Too Many Requests"/);
    expect(body).toMatch(/"status":\s*429/);
    expect(body).toMatch(/"retry_after_seconds":\s*12/);
    // Negative guard: the fictional envelope shape must not appear
    // inside the visible body (the frontmatter comment legitimately
    // explains the historical shape, so strip frontmatter first).
    const visible = body.replace(/^---[\s\S]*?---\n/, '');
    expect(visible).not.toMatch(/"error":\s*\{\s*"code"/);
  });

  it('page tells clients to dispatch on type, not status (multi-type status framing)', () => {
    expect(body).toMatch(/dispatch your client logic on\s+<code>type<\/code>/);
    expect(body).toMatch(/the same status can correspond to multiple types/);
  });

  it('stability promise (slugs do not rename without deprecation window) is pinned', () => {
    expect(body).toMatch(
      /Slugs are stable; they will not be renamed without a deprecation\s+window/,
    );
  });

  it('cites the X-Request-Id header as the correlation field for support', () => {
    expect(body).toContain('X-Request-Id');
    expect(body).toContain('developers@driftstack.dev');
  });

  it('cross-links to /docs/rate-limits + the docs concurrency guide (S47 2026-07-07 mirror-deprecation successor) for the two 429 types', () => {
    expect(body).toContain('/docs/rate-limits');
    expect(body).toContain('https://docs.driftstack.dev/guides/concurrency/');
  });
});
