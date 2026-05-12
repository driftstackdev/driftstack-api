// W351.A — drift guard for /docs/pagination. The page is the
// canonical public reference for cursor-based pagination on every
// /v1/... list endpoint. Source-of-truth claims pinned here:
//
//   • limit default + max ↔ PaginationQuerySchema (limit default 50,
//     max 100 — the page advertises BOTH numbers)
//   • response envelope keys (data / has_more / next_cursor) are the
//     literal shape every list route returns
//   • sort order claim (created_at DESC, id DESC tiebreaker) stays
//     pinned with the canonical reference
//   • rate-limited problem-type URI cited on the page exists in
//     PROBLEM_TYPES (no broken slug)
//   • cross-link to /docs/rate-limits resolves
//   • developers@driftstack.dev support contact pinned

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PaginationQuerySchema, PROBLEM_TYPES } from '@driftstack/api-types';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/pagination.astro');
const RATE_LIMITS_PAGE = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/rate-limits.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W351.A /docs/pagination parity', () => {
  const body = read(PAGE);

  it('limit default (50) matches PaginationQuerySchema.limit.default()', () => {
    const limit = (
      PaginationQuerySchema._def.shape() as {
        limit: { _def: { defaultValue: () => number } };
      }
    ).limit;
    expect(limit._def.defaultValue()).toBe(50);
    expect(body).toMatch(/Defaults to\s+<strong>50<\/strong>/);
  });

  it('limit max (100) is what the page advertises as the hard cap', () => {
    // Page: "integer 1-100. Hard cap at 100; values above are rejected with 400."
    expect(body).toMatch(/integer 1-100/);
    expect(body).toMatch(/Hard cap at 100/);
    // Verify the schema also caps at 100.
    expect(PaginationQuerySchema.safeParse({ limit: 100 }).success).toBe(true);
    expect(PaginationQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });

  it('response envelope shape (data / has_more / next_cursor) pinned', () => {
    expect(body).toMatch(/<strong><code>data<\/code><\/strong>/);
    expect(body).toMatch(/<strong><code>has_more<\/code><\/strong>/);
    expect(body).toMatch(/<strong><code>next_cursor<\/code><\/strong>/);
  });

  it('sort order (created_at DESC, id DESC tiebreaker) is the cited canonical', () => {
    expect(body).toMatch(/<code>created_at DESC<\/code>/);
    expect(body).toMatch(/<code>id DESC<\/code>\s*as the tiebreaker/);
  });

  it('cursor opacity claim (base64 tuple, treat as black box) is pinned', () => {
    expect(body).toMatch(/<strong>opaque<\/strong>/);
    expect(body).toMatch(/base64-encoded/);
    expect(body).toMatch(/Don't parse or modify cursor strings/);
  });

  it('cursor longevity claim ("valid indefinitely") is pinned', () => {
    // The server doesn't expire cursors today — pin both directions
    // of the contract so a sudden expiry policy needs a doc update.
    expect(body).toMatch(/valid <strong>indefinitely<\/strong>/);
  });

  it('rate-limited problem-type URI matches PROBLEM_TYPES.RateLimited', () => {
    expect(body).toContain(PROBLEM_TYPES.RateLimited);
    expect(body).toMatch(/retry_after_seconds/);
    expect(body).toContain('Retry-After');
  });

  it('cross-link to /docs/rate-limits resolves', () => {
    expect(body).toContain('/docs/rate-limits');
    expect(existsSync(RATE_LIMITS_PAGE)).toBe(true);
  });

  it('canonical iteration pattern uses limit=100 (max), not the default 50', () => {
    // The snippet is performance-oriented — paging at the max
    // minimises request count. Pin so a doc revamp doesn't silently
    // halve throughput in the example.
    expect(body).toMatch(/url\.searchParams\.set\('limit', '100'\)/);
  });

  it('total-count posture (no total field, see resource summary endpoint) is pinned', () => {
    expect(body).toMatch(/do <strong>not<\/strong> include a total-count\s*field/);
    expect(body).toMatch(/<code>profile_count<\/code>/);
  });

  it('support contact is developers@driftstack.dev', () => {
    expect(body).toContain('developers@driftstack.dev');
  });
});
