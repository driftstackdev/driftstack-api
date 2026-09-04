// W509.C — drift guard for apps/marketing-site/src/pages/docs/pagination.astro.
// V-695 cursor-pagination developer docs (customer-facing list endpoints).
// Drift here either breaks the (data, has_more, next_cursor) envelope
// shape (would create marketing↔SDK divergence) or weakens the
// opaque-cursor commitment (would let clients depend on cursor format).
//
//   • V-695 doc-comment framing.
//   • limit 1-100 default 50 + cursor opaque + first-request omit.
//   • Response envelope: data + has_more + next_cursor.
//   • Sort order: created_at DESC + id DESC tiebreak.
//   • Cursor stability: opaque + indefinitely valid + deletion graceful.
//   • Filter composition: cursor encodes context; switching = new cursor.
//   • No total-count + GET /v1/account/me profile_count alternative.
//   • Rate limit: global bucket + 429 with retry-after / RFC 7807 type.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/pagination.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W509.C apps/marketing-site/src/pages/docs/pagination.astro content parity', () => {
  const body = read(LIB);

  it("V-695 framing pinned: 'pagination developer docs. Covers the cursor-based pagination pattern used across all list endpoints. Companion to /docs/api-quickstart.' — pinned so the V-695 anchor + /docs/api-quickstart companion + 'all list endpoints' scope all survive (drift to softening 'all' would let customers question which endpoints paginate)", () => {
    expect(body).toMatch(
      /\/\/ V-695 — pagination developer docs\. Covers the cursor-based pagination\s*\/\/ pattern used across all list endpoints\. Companion to https:\/\/docs\.driftstack\.io\/quickstart-curl\/\./,
    );
  });

  it("Why-cursors-not-offsets rationale pinned: 'Offset pagination (page=3&size=50) gets unreliable when the underlying list mutates between requests — newly-inserted rows shift indexes and pages can repeat or skip items.' — pinned so the offset-breaks-on-insert rationale survives (drift to softening would let offset-pagination creep back into customer expectations)", () => {
    expect(body).toMatch(
      /Offset pagination \(<code>page=3&amp;size=50<\/code>\) gets unreliable\s*when the underlying list mutates between requests — newly-inserted\s*rows shift indexes and pages can repeat or skip items\./,
    );
  });

  it("limit + cursor query-parameter contract pinned: 'limit — page size, integer 1-100. Defaults to 50. Hard cap at 100; values above are rejected with 400.' + 'cursor — opaque string returned by the previous page. Omit on the first request.' — pinned so the 1-100 range + default-50 + 100-cap-with-400 + omit-on-first-request rules survive (drift to a different default/cap would create marketing↔server-validation divergence; drift to dropping 'rejected with 400' would let customers think >100 silently clamps)", () => {
    expect(body).toMatch(
      /<code>limit<\/code> — page size, integer 1-100\. Defaults to\s*<strong>50<\/strong>\. Hard cap at 100; values above are rejected\s*with 400\./,
    );
    expect(body).toMatch(
      /<code>cursor<\/code> — opaque string returned by the previous\s*page\. Omit on the first request\./,
    );
  });

  it('Response envelope 3-field shape: data + has_more (boolean) + next_cursor (string when has_more=true, null otherwise) — pinned so the 3-field envelope contract stays consistent across the SDK + REST surface (drift to renaming has_more would create marketing↔server divergence; drift to dropping next_cursor on terminal pages would force clients to check has_more twice)', () => {
    expect(body).toMatch(
      /<strong><code>data<\/code><\/strong> — array of resources, at\s*most <code>limit<\/code> entries\./,
    );
    expect(body).toMatch(
      /<strong><code>has_more<\/code><\/strong> — boolean\. <code>true<\/code>\s*when there are more pages, <code>false<\/code> on the final page\./,
    );
    expect(body).toMatch(
      /<strong><code>next_cursor<\/code><\/strong> — string when\s*<code>has_more<\/code> is true; <code>null<\/code> on the final\s*page\. Pass it as <code>cursor<\/code> on the next request\./,
    );
  });

  it("Sort order pinned: 'All list endpoints sort by created_at DESC with id DESC as the tiebreaker. New resources appear on the first page; older resources page off the back. If you need a different order (e.g. oldest-first or by name), fetch the full list and sort client-side — server-side sort overrides aren't currently supported.' — pinned so the created_at DESC + id DESC tiebreaker + 'no server-side sort overrides' commitment survive (drift to claiming server-side sort would over-promise; drift to changing the tiebreaker would create marketing↔SQL divergence)", () => {
    expect(body).toMatch(
      /All list endpoints sort by <code>created_at DESC<\/code> with\s*<code>id DESC<\/code> as the tiebreaker\./,
    );
    expect(body).toMatch(/server-side sort overrides aren't\s*currently supported\./);
  });

  it("Cursor-stability 3-rule: opaque + indefinitely valid + deletion-graceful — pinned so the 3-rule cursor-stability contract survives (drift to expiring cursors would break the 'persist a cursor and resume days later' use-case; drift to surfacing a deletion error would force clients to handle an unexpected error path)", () => {
    expect(body).toMatch(
      /Don't parse or modify cursor strings — the encoding is not\s*a stable API surface and may change\./,
    );
    expect(body).toMatch(
      /Cursors are valid <strong>indefinitely<\/strong>\. You can\s*persist a cursor and resume iteration days later\./,
    );
    expect(body).toMatch(
      /If a cursor's referenced row is deleted, the next page\s*starts from the closest row in sort order; no error is\s*raised\./,
    );
  });

  it("Filter composition: 'cursor encodes the filter context, so paging through filtered results is consistent. Switching filters mid-iteration requires a new cursor (omit cursor on the first filtered request).' — pinned so the cursor-encodes-filter + switch-filters-requires-new-cursor commitment survives (drift to silently mixing filters mid-walk would create subtle correctness bugs in client code)", () => {
    expect(body).toMatch(
      /Filters compose with pagination — the cursor encodes the\s*filter context, so paging through filtered results is\s*consistent\. Switching filters mid-iteration requires a new\s*cursor \(omit <code>cursor<\/code> on the first filtered request\)\./,
    );
  });

  it("No-total-counts framing pinned: 'List responses do not include a total-count field. Computing total counts on large tables is expensive and most clients don't need it. If you need a count for a specific resource, the resource's dedicated endpoint exposes it (e.g. GET /v1/account/me carries profile_count for the current account).' — pinned so the explicit no-total-count commitment + the GET /v1/account/me + profile_count fallback survive (drift to claiming total counts would force expensive server queries; drift to dropping the /account/me alternative would orphan customers needing a count)", () => {
    expect(body).toMatch(/List responses do <strong>not<\/strong> include a total-count\s*field\./);
    expect(body).toMatch(
      /<code>GET \/v1\/account\/me<\/code> carries\s*<code>profile_count<\/code> for the current account/,
    );
  });

  it("Rate-limit 429 + retry-after framing: 'List requests count against the global bucket' + 'a 429 (type URI https://errors.driftstack.dev/rate-limited), back off and retry; the Retry-After header and the retry_after_seconds extension both tell you for how long.' — pinned so the global-bucket + RFC 7807 type URI + dual-signal (header + JSON extension) commitments survive (drift to dropping the explicit RFC-7807 type URI would orphan customers from routing on it; drift to claiming a different bucket would create marketing↔rate-limit-policy divergence)", () => {
    expect(body).toMatch(/List requests count against the <code>global<\/code> bucket/);
    expect(body).toMatch(/<code>https:\/\/errors\.driftstack\.dev\/rate-limited<\/code>/);
    expect(body).toMatch(
      /the <code>Retry-After<\/code> header and the\s*<code>retry_after_seconds<\/code> extension both tell you for\s*how long\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
