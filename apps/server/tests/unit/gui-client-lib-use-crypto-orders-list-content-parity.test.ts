// W474.A — drift guard for apps/gui-client/src/lib/use-crypto-orders-list.ts.
// V-534.W useCryptoOrdersList hook + V-534.BT cursor pagination
// (V-666.BU). Drift here either drops the loading_more variant
// (loadMore replaces orders instead of appending — user clicks
// 'Load more' and loses the page they were already looking at)
// or breaks the next_cursor ?? null snake→camel mapping (server
// sends next_cursor:null but the wire field nextCursor stays
// undefined and 'Load more' button never disappears on terminal
// page).
//
//   • V-534.W framing pinned: 'useCryptoOrdersList hook.' + 'Wraps
//     GET /v1/billing/crypto-orders (V-666.G) for the GUI history
//     view. Returns the caller account's own orders, newest first.
//     Auto-fetches on mount; manual mode + refetch() supported.'
//   • V-534.BT framing pinned: 'cursor pagination (V-666.BU). When
//     the server returns a non-null `next_cursor`, the caller can
//     invoke `loadMore` to append the next page in place. Changing
//     any filter resets pagination.'
//   • CryptoOrdersListData {orders + nextCursor nullable V-666.BU}.
//   • CryptoOrdersListState 5-variant with loading_more{data}
//     preserving baseline.
//   • UseCryptoOrdersListOpts: manual + limit + status 6-union +
//     createdAfter/createdBefore V-666.BX.
//   • buildUrl: limit + status + created_after/created_before
//     (length>0) + cursor; loadMore guards on state.kind==='ready'
//     + nextCursor!==null + apiKey; orders [...baseline.orders,
//     ...body.orders] append.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/gui-client/src/lib/use-crypto-orders-list.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W474.A apps/gui-client/src/lib/use-crypto-orders-list.ts content parity', () => {
  const body = read(LIB);

  it("V-534.W framing pinned: 'V-534.W — useCryptoOrdersList hook.' + 'Wraps GET /v1/billing/crypto-orders (V-666.G) for the GUI history view. Returns the caller account's own orders, newest first. Auto-fetches on mount; manual mode + refetch() supported.'", () => {
    expect(body).toMatch(/\/\/ V-534\.W — useCryptoOrdersList hook\./);
    expect(body).toMatch(
      /\/\/ Wraps GET \/v1\/billing\/crypto-orders \(V-666\.G\) for the GUI history\s*\/\/ view\. Returns the caller account's own orders, newest first\. Auto-\s*\/\/ fetches on mount; manual mode \+ refetch\(\) supported\./,
    );
  });

  it("V-534.BT cursor-pagination framing pinned: 'cursor pagination (V-666.BU). When the server returns a non-null `next_cursor`, the caller can invoke `loadMore` to append the next page in place. Changing any filter resets pagination.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.BT — cursor pagination \(V-666\.BU\)\. When the server returns a\s*\/\/ non-null `next_cursor`, the caller can invoke `loadMore` to append\s*\/\/ the next page in place\. Changing any filter resets pagination\./,
    );
  });

  it("CryptoOrdersListData 2-field (orders: CryptoOrderData[] + nextCursor nullable V-666.BU 'opaque cursor for the next page, or null on the terminal page.'); ListApiResponse with next_cursor? optional+nullable for older-build wire-compat; CryptoOrdersListState 5-variant with loading_more{data} preserving baseline", () => {
    expect(body).toMatch(
      /export interface CryptoOrdersListData \{\s*orders: CryptoOrderData\[\];\s*\/\*\* V-666\.BU — opaque cursor for the next page, or null on the terminal page\. \*\/\s*nextCursor: string \| null;\s*\}/,
    );
    expect(body).toMatch(
      /interface ListApiResponse \{\s*orders: CryptoOrderData\[\];\s*next_cursor\?: string \| null;\s*\}/,
    );
    expect(body).toMatch(
      /export type CryptoOrdersListState =\s*\| \{ kind: 'idle' \}\s*\| \{ kind: 'loading' \}\s*\| \{ kind: 'ready'; data: CryptoOrdersListData \}\s*\| \{ kind: 'loading_more'; data: CryptoOrdersListData \}\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it("UseCryptoOrdersListOpts: manual? + limit? 'Page size override; server caps at 100. Default unset = server default (50).' + status? 6-value union V-666.BR + createdAfter? V-666.BX inclusive + createdBefore? V-666.BX exclusive", () => {
    expect(body).toMatch(
      /export interface UseCryptoOrdersListOpts \{\s*\/\*\* Disable auto-fetch on mount\. Default false\. \*\/\s*manual\?: boolean;\s*\/\*\* Page size override; server caps at 100\. Default unset = server default \(50\)\. \*\/\s*limit\?: number;\s*\/\*\* V-666\.BR — server-side single-status filter\. Omit for all statuses\. \*\/\s*status\?: 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial' \| 'cancelled';\s*\/\*\* V-666\.BX — ISO 8601 lower bound on created_at \(inclusive\)\. \*\/\s*createdAfter\?: string;\s*\/\*\* V-666\.BX — ISO 8601 upper bound on created_at \(exclusive\)\. \*\/\s*createdBefore\?: string;\s*\}/,
    );
  });

  it('buildUrl: URL ${baseUrl}/v1/billing/crypto-orders + limit set (.toString()) + status set + created_after/created_before set when defined && length>0 + cursor set when !== null; useCallback deps [settings.baseUrl, opts.limit, opts.status, opts.createdAfter, opts.createdBefore]', () => {
    expect(body).toMatch(
      /const url = new URL\(`\$\{baseUrl\}\/v1\/billing\/crypto-orders`\);\s*if \(opts\.limit !== undefined\) url\.searchParams\.set\('limit', opts\.limit\.toString\(\)\);\s*if \(opts\.status !== undefined\) url\.searchParams\.set\('status', opts\.status\);\s*if \(opts\.createdAfter !== undefined && opts\.createdAfter\.length > 0\) \{\s*url\.searchParams\.set\('created_after', opts\.createdAfter\);\s*\}\s*if \(opts\.createdBefore !== undefined && opts\.createdBefore\.length > 0\) \{\s*url\.searchParams\.set\('created_before', opts\.createdBefore\);\s*\}\s*if \(cursor !== null\) url\.searchParams\.set\('cursor', cursor\);/,
    );
    expect(body).toMatch(
      /\[settings\.baseUrl, opts\.limit, opts\.status, opts\.createdAfter, opts\.createdBefore\]/,
    );
  });

  it('loadMore appends without duplicate cursor dispatch while refresh/page lanes are deadline-bounded and lifecycle-aborted', () => {
    expect(body).toContain("if (state.kind !== 'ready') return;");
    expect(body).toContain('if (state.data.nextCursor === null) return;');
    expect(body).toContain('if (refreshInFlightRef.current || pageInFlightRef.current) return;');
    expect(body).toContain('pageInFlightRef.current = true;');
    expect(body).toContain("setState({ kind: 'loading_more', data: baseline });");
    expect(body).toContain('fetchWithDeadline(buildUrl(baseline.nextCursor).toString(), {');
    expect(body).toContain('signal: controller.signal,');
    expect(body).toContain('refreshRequestRef.current?.abort();');
    expect(body).toContain('pageRequestRef.current?.abort();');
    expect(body).toMatch(
      /setState\(\{\s*kind: 'ready',\s*data: \{\s*orders: \[\.\.\.baseline\.orders, \.\.\.body\.orders\],\s*nextCursor: body\.next_cursor \?\? null,\s*\},\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
