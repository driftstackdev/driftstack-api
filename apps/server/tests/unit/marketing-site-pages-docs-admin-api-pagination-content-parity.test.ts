// W508.B — drift guard for apps/marketing-site/src/pages/docs/admin-api-pagination.astro.
// V-717 admin-API endpoint pagination reference (V-666.AM crypto
// implementation). Drift here either breaks the endpoint matrix,
// cursor-opaque contract, or the crypto-specific
// (created_at, order_id) anchoring.
//
//   • V-717 + V-666.AM anchors.
//   • Cursor-vs-offset rationale + created_at DESC + order_id tiebreak.
//   • next_cursor response field (string OR null).
//   • Walk loop pattern: while next_cursor !== null.
//   • limit default 50 + max 200.
//   • Filter composition: status + search + account_id.
//   • Cursor lifetime: 1000-row window + 51-row overflow probe.
//   • Validation errors: >512 chars → 400; malformed → empty.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/admin-api-pagination.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W508.B apps/marketing-site/src/pages/docs/admin-api-pagination.astro content parity', () => {
  const body = read(LIB);

  it('V-717 + V-666.AM framing pins the current matrix and crypto-order implementation', () => {
    expect(body).toMatch(
      /\/\/ V-717 — admin-API pagination reference\. Documents the current\s*\n?\s*\/\/ endpoint matrix plus the cursor convention introduced by V-666\.AM\s*\n?\s*\/\/ on \/v1\/admin\/crypto-orders\./,
    );
  });

  it('crypto-order cursor-vs-offset rationale and anchor remain scoped and pinned', () => {
    expect(body).toMatch(/Why crypto orders use cursors, not offsets/);
    expect(body).toMatch(
      /Offset pagination \(<code>\?page=2<\/code>\) is convenient but breaks\s*\n?\s*when rows are inserted or removed between page requests/,
    );
    expect(body).toMatch(
      /crypto-order list\s*\n?\s*orders rows by <code>created_at DESC<\/code> with\s*\n?\s*<code>order_id<\/code> as the tiebreaker/,
    );
    expect(body).toMatch(
      /A cursor anchored to the\s*\n?\s*last seen <code>\(created_at, order_id\)<\/code> pair gives a\s*\n?\s*stable walk/,
    );
  });

  it("next_cursor contract pinned: 'next_cursor is a string when at least one more row exists beyond the page; null when the page reaches the end of the list.' + default limit=50 + max 200 — pinned so the 2-state next_cursor type (string-or-null) + the limit-default-50/max-200 commitments survive (drift to a different default/max would create marketing↔server-validation divergence; drift to softening the null-on-last-page would force clients to detect end differently)", () => {
    expect(body).toMatch(
      /<code>next_cursor<\/code> is a string when at least one more\s*\n?\s*row exists beyond the page; <code>null<\/code> when the page\s*\n?\s*reaches the end of the list\./,
    );
    expect(body).toMatch(
      /default <code>limit=50<\/code>; max\s*\n?\s*<code>200<\/code> on this endpoint/,
    );
  });

  it("Cursor-opacity contract pinned: 'Stop when next_cursor is null. Do not try to parse the cursor — its internal shape is not part of the contract and may change between releases. Treat it as opaque bytes.' — pinned so the don't-parse-cursor + may-change-between-releases commitments survive (drift to documenting the cursor's internal shape would let clients build dependencies on it and break on every release)", () => {
    expect(body).toMatch(
      /Stop when <code>next_cursor<\/code> is <code>null<\/code>\. Do not\s*\n?\s*try to parse the cursor — its internal shape is not part of\s*\n?\s*the contract and may change between releases\. Treat it as\s*\n?\s*opaque bytes\./,
    );
  });

  it("Filter composition framing: 'Pagination composes with the existing filter parameters (status, search, account_id). Send the same filter values on every page request' + 'Changing a filter mid-walk is undefined — always start a fresh walk (drop the cursor) when filters change.' — pinned so the 3-filter (status + search + account_id) composition + the drop-cursor-on-filter-change commitment survive (drift to dropping the mid-walk-undefined warning would let clients hit subtle correctness bugs)", () => {
    expect(body).toMatch(
      /Pagination composes with the existing filter parameters\s*\n?\s*\(<code>status<\/code>, <code>search<\/code>,\s*\n?\s*<code>account_id<\/code>\)\./,
    );
    expect(body).toMatch(
      /Changing a filter mid-walk is undefined —\s*\n?\s*always start a fresh walk \(drop the cursor\) when filters\s*\n?\s*change\./,
    );
  });

  it("Cursor lifetime framing: 'Cursors are not signed and do not expire on a timer' + 'default 1000 rows on filtered queries, 51 rows on the unfiltered first page — the limit + 1 overflow probe' + 'falls out of the window, the server returns an empty page with next_cursor: null' — pinned so the not-signed + no-timer-expire + 1000-row-filtered-window + 51-row-unfiltered-overflow-probe + benign-empty-on-window-overflow commitments survive (drift to changing the window-size would create marketing↔server divergence; drift to dropping 'empty page on overflow' would force clients to handle an unexpected error)", () => {
    expect(body).toMatch(
      /Cursors are not signed and do not expire on a timer; the\s*\n?\s*server treats them as the literal\s*\n?\s*<code>\(created_at, order_id\)<\/code> pair to seek past\./,
    );
    expect(body).toMatch(
      /default 1000 rows on filtered\s*\n?\s*queries, 51 rows on the unfiltered first page — the\s*\n?\s*<code>limit \+ 1<\/code> overflow probe/,
    );
    expect(body).toMatch(
      /If you walk slowly enough that the anchor row falls out of\s*\n?\s*the window, the server returns an empty page with\s*\n?\s*<code>next_cursor: null<\/code>\./,
    );
  });

  it("Validation errors 2-rule: cursor >512 chars → 400 + malformed cursor → empty page with next_cursor:null — pinned so the 2-rule cursor-validation framing + the 'server prefers benign empty over surfacing decode internals' rationale survive (drift to surfacing decode internals would leak cursor-format details that clients shouldn't depend on)", () => {
    expect(body).toMatch(
      /A cursor longer than 512 characters returns\s*\n?\s*<code>400 Bad Request<\/code>\./,
    );
    expect(body).toMatch(
      /A malformed cursor \(not valid base64url JSON of\s*\n?\s*<code>&#123;ts, id&#125;<\/code>\) returns an empty page with\s*\n?\s*<code>next_cursor: null<\/code>; the server prefers a benign\s*\n?\s*empty result over surfacing decode internals\./,
    );
  });

  it('current route matrix, offset exception, and crypto-only detail scope are pinned', () => {
    for (const route of [
      '/v1/admin/accounts',
      '/v1/admin/sessions',
      '/v1/admin/api-keys',
      '/v1/admin/audit-log',
      '/v1/admin/crypto-orders',
      '/v1/admin/webhook-dlq',
      '/v1/admin/rate-limit-overrides',
    ]) {
      expect(body).toContain(`<code>GET ${route}</code>`);
    }
    expect(body).toContain('<code>GET /v1/admin/status-subscribers</code>');
    expect(body).toMatch(/accepts <code>limit<\/code> and <code>offset<\/code>/);
    expect(body).toMatch(/without a\s*<code>next_cursor<\/code> field/);
    expect(body).toMatch(/details above apply specifically to crypto orders/);
    expect(body).not.toMatch(/will roll out|assume an\s*endpoint does NOT paginate/i);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
