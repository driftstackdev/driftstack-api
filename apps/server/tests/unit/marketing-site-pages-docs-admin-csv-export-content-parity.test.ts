// W508.C — drift guard for apps/marketing-site/src/pages/docs/admin-csv-export.astro.
// V-718 admin CSV export reference (GET /v1/admin/crypto-orders.csv,
// V-666.AC). Drift here either changes the 11-column shape (would
// break customer reconciliation pipelines built on the column order)
// or weakens the RFC 4180 quoting commitment.
//
//   • V-718 + V-666.AC anchors.
//   • GET /v1/admin/crypto-orders.csv + driftstack_internal_admin
//     scope required (403 without).
//   • 5-filter set: status (6-state enum) + search + account_id +
//     created_after/before (V-666.BY) + limit 1–1000 default 1000.
//   • 11-column ordered shape: order_id + account_id + product +
//     price_cents + price_currency + status + payment_id +
//     customer_note + internal_note + created_at + updated_at.
//   • RFC 4180 quoting + UTF-8 no BOM + \r\n line terminator.
//   • 1000-row max + X-Driftstack-Export-Truncated header.
//   • GUI Download CSV button mints blob URL client-side.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/marketing-site/src/pages/docs/admin-csv-export.astro');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W508.C apps/marketing-site/src/pages/docs/admin-csv-export.astro content parity', () => {
  const body = read(LIB);

  it('V-718 + V-666.AC framing pinned. Re-enabled by slice 187 after verifying the V-718 comment exists at admin-csv-export.astro:4-5', () => {
    expect(body).toMatch(
      /\/\/ V-718 — admin CSV export reference\. Documents the contract for\s*\n?\s*\/\/ GET \/v1\/admin\/crypto-orders\.csv \(V-666\.AC\)\./,
    );
  });

  it("Endpoint shape pinned: 'GET /v1/admin/crypto-orders.csv' + Bearer auth + Accept: text/csv + driftstack_internal_admin scope required + 403 without — pinned so the endpoint URL + Accept-header expectation + scope gating + 403-on-missing-scope all survive (drift to dropping the explicit scope name would create marketing↔scope-enum divergence; drift to a different Accept would create marketing↔server-handler divergence)", () => {
    expect(body).toMatch(/GET \/v1\/admin\/crypto-orders\.csv/);
    expect(body).toMatch(/Authorization: Bearer \$ADMIN_KEY/);
    expect(body).toMatch(/Accept: text\/csv/);
    expect(body).toMatch(
      /Requires an API key with the\s*\n?\s*<code>driftstack_internal_admin<\/code> scope\. A key without\s*\n?\s*that scope receives <code>403 Forbidden<\/code>\./,
    );
  });

  it('5-filter set, 6-state status enum, and date-range behavior pinned', () => {
    expect(body).toMatch(/<code>status<\/code> — one of/);
    expect(body).toMatch(
      /<code>pending<\/code>, <code>confirming<\/code>, <code>paid<\/code>,\s*\n?\s*<code>failed<\/code>, <code>partial<\/code>, <code>cancelled<\/code>\./,
    );
    expect(body).toMatch(/<code>search<\/code> — free-text match across/);
    expect(body).toMatch(/<code>account_id<\/code> — restrict to one account\./);
    expect(body).toMatch(
      /<code>created_after<\/code> \/ <code>created_before<\/code> —\s*\n?\s*ISO-8601 date-range filter\./,
    );
    expect(body).toMatch(/<code>limit<\/code> — integer 1–1000\. Defaults to 1000\./);
  });

  it('Inverted date-range 400 commitment pinned. Re-enabled by slice 237 alongside the V-666.BY anchor restore — the same list-item carries both the V-666.BY anchor + the inverted-date-range guard, so re-enabling both as a pair', () => {
    expect(body).toMatch(
      /<code>created_before<\/code> must be strictly greater than\s*\n?\s*<code>created_after<\/code>; otherwise 400\./,
    );
  });

  it("11-column ordered shape: order_id + account_id + product + price_cents + price_currency + status + payment_id + customer_note + internal_note + created_at + updated_at — pinned so the 11-column contract + the 'header is stable — new columns are appended to the right; existing columns are not removed or reordered without a deprecation window' commitment all survive (drift to reordering columns would break customer reconciliation pipelines that depend on positional parsing)", () => {
    expect(body).toMatch(
      /The header is stable —\s*\n?\s*new columns are appended to the right; existing columns are\s*\n?\s*not removed or reordered without a deprecation window\./,
    );
    expect(body).toMatch(
      /<li><code>order_id<\/code> — Driftstack order ID\s*\n?\s*\(<code>ord_\*<\/code>\)\.<\/li>/,
    );
    expect(body).toMatch(
      /<li><code>account_id<\/code> — owning account, or empty for\s*\n?\s*pre-signup checkouts\.<\/li>/,
    );
    expect(body).toMatch(/<li><code>product<\/code> — SKU paid for\.<\/li>/);
    expect(body).toMatch(
      /<li><code>price_cents<\/code> — fiat-equivalent price at order\s*\n?\s*creation, in minor units\.<\/li>/,
    );
    expect(body).toMatch(
      /<li><code>price_currency<\/code> — three-letter currency\s*\n?\s*\(e\.g\. <code>USD<\/code>, <code>EUR<\/code>\)\.<\/li>/,
    );
    expect(body).toMatch(/<li><code>status<\/code> — terminal or in-flight status\.<\/li>/);
    expect(body).toMatch(
      /<li><code>payment_id<\/code> — NowPayments invoice ID, empty\s*\n?\s*if no IPN has hit\.<\/li>/,
    );
    expect(body).toMatch(
      /<li><code>customer_note<\/code> — customer-supplied note,\s*\n?\s*empty if unset\.<\/li>/,
    );
    expect(body).toMatch(
      /<li><code>internal_note<\/code> — admin-only ops note, empty\s*\n?\s*if unset\.<\/li>/,
    );
    expect(body).toMatch(/<li><code>created_at<\/code> — ISO-8601 UTC timestamp\.<\/li>/);
    expect(body).toMatch(
      /<li><code>updated_at<\/code> — ISO-8601 UTC timestamp of the\s*\n?\s*last state transition\.<\/li>/,
    );
  });

  it('RFC 4180 quoting + UTF-8 no BOM + \\r\\n line-terminator pinned — pinned so the 3-state encoding contract survives (drift to UTF-8-with-BOM would break consumers that use plain-text-UTF-8; drift to dropping the explicit Latin-1 import-fallback hint would orphan Excel users who default to legacy encodings)', () => {
    expect(body).toMatch(/The exporter follows RFC 4180:/);
    expect(body).toMatch(
      /Fields containing <code>,<\/code>, <code>"<\/code>, or\s*\n?\s*a newline are wrapped in double quotes; embedded\s*\n?\s*<code>"<\/code> is doubled \(<code>""<\/code>\)\./,
    );
    expect(body).toMatch(/Line terminator is <code>\\r\\n<\/code>\./);
    expect(body).toMatch(
      /Encoding is UTF-8 with no BOM\. Spreadsheet apps that\s*\n?\s*default to Latin-1 should import explicitly as UTF-8/,
    );
  });

  it("1000-row max + capped-to-most-recently-updated-1000 + no-truncation-header (detect-by-full-1000-row-page) + 'walk the cursor-paginated JSON list and stream rows yourself' fallback pinned — pinned so the 1000-row cap + the explicit no-truncation-header contract (detect a capped result by receiving a full 1000-row page) + cursor-pagination-fallback survive (drift to a different cap would create marketing↔server divergence; drift to claiming a truncation header is set would create marketing↔server divergence since the handler sets none; drift to dropping the fallback would orphan high-volume customers)", () => {
    expect(body).toMatch(
      /The CSV endpoint exports up to <strong>1000 rows<\/strong> per\s*\n?\s*request\. If the filtered scan would return more than 1000 rows,\s*\n?\s*the export is capped at the most-recently-updated 1000\. The CSV\s*\n?\s*endpoint does not set a truncation header, so detect a capped\s*\n?\s*result by checking whether you received a full 1000-row page —\s*\n?\s*if you did, there may be more\./,
    );
    // Anti-drift: the previous content claimed a warning header was set
    // (X-Driftstack-Export-Truncated). The handler sets no such header;
    // ban the old truncation-header framing so it cannot creep back.
    expect(body).not.toMatch(/X-Driftstack-Export-Truncated/);
    expect(body).not.toMatch(/a warning header is set/);
    expect(body).toMatch(
      /For full-history exports beyond 1000 rows, walk the\s*\n?\s*<a href="\/docs\/admin-api-pagination\/">cursor-paginated JSON\s*\n?\s*list<\/a> and stream rows yourself; the CSV endpoint is a\s*\n?\s*convenience for ad-hoc reconciliation, not a bulk-export\s*\n?\s*channel\./,
    );
    expect(body).not.toMatch(/href="\/docs\/admin-api-pagination"/);
  });

  it("GUI Download CSV button + 'mints a blob URL client-side so the download honours the Bearer auth header' pinned — pinned so the GUI-button-uses-blob-URL pattern + the auth-header-preservation rationale survive (drift to documenting a direct-link would surprise customers who try and find the API rejects credential-less direct links; this is the same pattern as the customer-dashboard CSV download)", () => {
    expect(body).toMatch(
      /The admin GUI \(<code>Crypto orders \(admin\)<\/code> view\) has a\s*\n?\s*<strong>Download CSV<\/strong> button that calls this endpoint\s*\n?\s*with whatever <code>status<\/code> and <code>search<\/code>\s*\n?\s*filters are currently active\. The button mints a blob URL\s*\n?\s*client-side so the download honours the Bearer auth header\./,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
