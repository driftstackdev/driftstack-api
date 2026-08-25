// W474.B — drift guard for apps/gui-client/src/lib/use-admin-crypto-orders-list.ts.
// V-534.AG useAdminCryptoOrdersList + V-534.AW cursor pagination
// + V-666.D admin orders + V-666.T status/search/account filters
// + V-666.AS payment_id exact match + V-666.AA admin-only
// internal_note + V-666.AM cursor + V-666.BY date-range. Drift
// here either drops the V-666.AA internal_note? field on
// AdminCryptoOrder (admin GUI loses the internal-note column —
// support can't see the bookkeeping note they typed yesterday)
// or breaks the admin-scope framing (a non-admin api key
// silently gets blank list instead of a clear 403 error).
//
//   • V-534.AG framing pinned: 'useAdminCryptoOrdersList hook.' +
//     'Wraps GET /v1/admin/crypto-orders (V-666.D + V-666.T).
//     Admin-only surface — caller must have an API key with the
//     `driftstack_internal_admin` scope; non-admin keys get a 403
//     which surfaces as an error state. Supports the V-666.T
//     status + search filters via opts; refetch picks up the
//     latest opts.'
//   • V-534.AW framing pinned: 'cursor pagination (V-666.AM).'
//   • AdminCryptoOrder extends CryptoOrderData with account_id
//     nullable + customer_note? nullable + V-666.AA internal_note?
//     nullable.
//   • AdminCryptoOrdersListData + ListApiResponse + 5-variant state
//     with loading_more{data}.
//   • UseAdminCryptoOrdersListOpts 8-field: manual + limit +
//     status nullable + search nullable + accountId nullable +
//     V-666.AS paymentId nullable + V-666.BY createdAfter/Before
//     nullable.
//   • buildUrl: 7 filter params with trim()-and-length>0 guards
//     on string filters + cursor; useCallback deps include all
//     7 filters; loadMore appends.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-admin-crypto-orders-list.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W474.B apps/gui-client/src/lib/use-admin-crypto-orders-list.ts content parity', () => {
  const body = read(LIB);

  it("V-534.AG framing pinned: 'V-534.AG — useAdminCryptoOrdersList hook.' + admin-scope framing 'Wraps GET /v1/admin/crypto-orders (V-666.D + V-666.T). Admin-only surface — caller must have an API key with the `driftstack_internal_admin` scope; non-admin keys get a 403 which surfaces as an error state. Supports the V-666.T status + search filters via opts; refetch picks up the latest opts.' — pinned so a non-admin key gets a clear 403 surface instead of a silent blank list", () => {
    expect(body).toMatch(/\/\/ V-534\.AG — useAdminCryptoOrdersList hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/admin\/crypto-orders \(V-666\.D \+ V-666\.T\)\. Admin-only\s*\/\/ surface — caller must have an API key with the\s*\/\/ `driftstack_internal_admin` scope; non-admin keys get a 403 which\s*\/\/ surfaces as an error state\. Supports the V-666\.T status \+ search\s*\/\/ filters via opts; refetch picks up the latest opts\./,
    );
  });

  it("V-534.AW cursor-pagination framing pinned: 'cursor pagination (V-666.AM). When the server returns a non-null `next_cursor`, the caller can invoke `loadMore` to append the next page in place. Changing any filter resets the pagination state (the next fetch starts from the first page).'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.AW — cursor pagination \(V-666\.AM\)\. When the server returns\s*\/\/ a non-null `next_cursor`, the caller can invoke `loadMore` to\s*\/\/ append the next page in place\. Changing any filter resets the\s*\/\/ pagination state \(the next fetch starts from the first page\)\./,
    );
  });

  it("AdminCryptoOrder extends CryptoOrderData with account_id nullable + customer_note? 'Customer-side bookkeeping note (also surfaced to the customer).' + V-666.AA internal_note? 'admin-only internal note. Not visible to the customer.' — pinned so the admin-only note column doesn't get dropped or the visibility annotation reverted", () => {
    expect(body).toMatch(
      /export interface AdminCryptoOrder extends CryptoOrderData \{\s*account_id: string \| null;\s*\/\*\* Customer-side bookkeeping note \(also surfaced to the customer\)\. \*\/\s*customer_note\?: string \| null;\s*\/\*\* V-666\.AA — admin-only internal note\. Not visible to the customer\. \*\/\s*internal_note\?: string \| null;\s*\}/,
    );
  });

  it('AdminCryptoOrdersListData {orders + nextCursor nullable V-666.AM} + ListApiResponse internal type with next_cursor? + AdminCryptoOrdersListState 5-variant with loading_more{data}', () => {
    expect(body).toMatch(
      /export interface AdminCryptoOrdersListData \{\s*orders: AdminCryptoOrder\[\];\s*\/\*\* V-666\.AM — opaque cursor for the next page, or null on the terminal page\. \*\/\s*nextCursor: string \| null;\s*\}/,
    );
    expect(body).toMatch(
      /interface ListApiResponse \{\s*orders: AdminCryptoOrder\[\];\s*next_cursor\?: string \| null;\s*\}/,
    );
    expect(body).toMatch(
      /export type AdminCryptoOrdersListState =\s*\| \{ kind: 'idle' \}\s*\| \{ kind: 'loading' \}\s*\| \{ kind: 'ready'; data: AdminCryptoOrdersListData \}\s*\| \{ kind: 'loading_more'; data: AdminCryptoOrdersListData \}\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it("UseAdminCryptoOrdersListOpts 8-field: manual? + limit? 'Page size override; server caps at 200.' + status? V-666.T + search? V-666.T 'Free-text search across order_id / product / customer_note' + accountId? + paymentId? V-666.AS 'exact-match payment_id filter' + createdAfter?/createdBefore? V-666.BY date-range", () => {
    expect(body).toMatch(
      /\/\*\* Page size override; server caps at 200\. \*\/\s*limit\?: number;\s*\/\*\* Filter to one status \(V-666\.T\)\. \*\/\s*status\?: AdminCryptoOrder\['status'\] \| 'cancelled' \| null;\s*\/\*\* Free-text search across order_id \/ product \/ customer_note \(V-666\.T\)\. \*\/\s*search\?: string \| null;\s*\/\*\* Filter to a specific account_id\. \*\/\s*accountId\?: string \| null;\s*\/\*\* V-666\.AS — exact-match payment_id filter\. \*\/\s*paymentId\?: string \| null;\s*\/\*\* V-666\.BY — ISO 8601 lower bound on created_at \(inclusive\)\. \*\/\s*createdAfter\?: string \| null;\s*\/\*\* V-666\.BY — ISO 8601 upper bound on created_at \(exclusive\)\. \*\/\s*createdBefore\?: string \| null;/,
    );
  });

  it('Opts normalization: limit pass-through + status/search/accountId/paymentId/createdAfter/createdBefore ?? null defaults; buildUrl URL `${baseUrl}/v1/admin/crypto-orders` + 7 filter params with trim()-and-length>0 guards on the 5 string filters + cursor; useCallback deps [settings.baseUrl, limit, status, search, accountId, paymentId, createdAfter, createdBefore]', () => {
    expect(body).toMatch(
      /const limit = opts\.limit;\s*const status = opts\.status \?\? null;\s*const search = opts\.search \?\? null;\s*const accountId = opts\.accountId \?\? null;\s*const paymentId = opts\.paymentId \?\? null;\s*const createdAfter = opts\.createdAfter \?\? null;\s*const createdBefore = opts\.createdBefore \?\? null;/,
    );
    expect(body).toMatch(
      /const url = new URL\(`\$\{baseUrl\}\/v1\/admin\/crypto-orders`\);\s*if \(limit !== undefined\) url\.searchParams\.set\('limit', limit\.toString\(\)\);\s*if \(status !== null\) url\.searchParams\.set\('status', status\);\s*if \(search !== null && search\.trim\(\)\.length > 0\) \{\s*url\.searchParams\.set\('search', search\.trim\(\)\);\s*\}\s*if \(accountId !== null && accountId\.trim\(\)\.length > 0\) \{\s*url\.searchParams\.set\('account_id', accountId\.trim\(\)\);\s*\}\s*if \(paymentId !== null && paymentId\.trim\(\)\.length > 0\) \{\s*url\.searchParams\.set\('payment_id', paymentId\.trim\(\)\);\s*\}/,
    );
    expect(body).toMatch(
      /if \(createdAfter !== null && createdAfter\.trim\(\)\.length > 0\) \{\s*url\.searchParams\.set\('created_after', createdAfter\.trim\(\)\);\s*\}\s*if \(createdBefore !== null && createdBefore\.trim\(\)\.length > 0\) \{\s*url\.searchParams\.set\('created_before', createdBefore\.trim\(\)\);\s*\}\s*if \(cursor !== null\) url\.searchParams\.set\('cursor', cursor\);/,
    );
    expect(body).toMatch(
      /\[settings\.baseUrl, limit, status, search, accountId, paymentId, createdAfter, createdBefore\]/,
    );
  });

  it('loadMore: ready/cursor/single-flight/apiKey guards + baseline loading_more + deadline transport + sequence-gated APPEND orders and refreshed nextCursor', () => {
    expect(body).toMatch(
      /if \(state\.kind !== 'ready'\) return;\s*if \(state\.data\.nextCursor === null\) return;\s*if \(refreshInFlightRef\.current \|\| pageInFlightRef\.current\) return;\s*if \(!settings\.apiKey\) \{[\s\S]*?const baseline = state\.data;\s*pageInFlightRef\.current = true;[\s\S]*?setState\(\{ kind: 'loading_more', data: baseline \}\);/,
    );
    expect(body).toMatch(
      /const res = await fetchWithDeadline\(buildUrl\(baseline\.nextCursor\)\.toString\(\), \{\s*method: 'GET',\s*signal: controller\.signal,[\s\S]*?if \(sequence === sequenceRef\.current\) \{\s*setState\(\{\s*kind: 'ready',\s*data: \{\s*orders: \[\.\.\.baseline\.orders, \.\.\.body\.orders\],\s*nextCursor: body\.next_cursor \?\? null,/,
    );
  });

  it('refresh and page lanes are lifecycle-safe: refresh is single-flight, supersedes pagination, and dependency/unmount cleanup aborts both + invalidates state writes', () => {
    expect(body).toMatch(/if \(refreshInFlightRef\.current\) return;/);
    expect(body).toMatch(
      /pageRequestRef\.current\?\.abort\(\);\s*pageRequestRef\.current = null;\s*pageInFlightRef\.current = false;/,
    );
    expect(body).toMatch(
      /useEffect\(\s*\(\) => \(\) => \{\s*sequenceRef\.current \+= 1;\s*refreshRequestRef\.current\?\.abort\(\);\s*pageRequestRef\.current\?\.abort\(\);[\s\S]*?\},\s*\[settings\.apiKey, buildUrl\],/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
