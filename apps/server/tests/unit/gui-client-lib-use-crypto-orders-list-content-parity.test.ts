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
      /\/\/ Wraps GET \/v1\/billing\/crypto-orders \(V-666\.G\) for the GUI history\s*\n?\s*\/\/ view\. Returns the caller account's own orders, newest first\. Auto-\s*\n?\s*\/\/ fetches on mount; manual mode \+ refetch\(\) supported\./,
    );
  });

  it("V-534.BT cursor-pagination framing pinned: 'cursor pagination (V-666.BU). When the server returns a non-null `next_cursor`, the caller can invoke `loadMore` to append the next page in place. Changing any filter resets pagination.'", () => {
    expect(body).toMatch(
      /\/\/ V-534\.BT — cursor pagination \(V-666\.BU\)\. When the server returns a\s*\n?\s*\/\/ non-null `next_cursor`, the caller can invoke `loadMore` to append\s*\n?\s*\/\/ the next page in place\. Changing any filter resets pagination\./,
    );
  });

  it("CryptoOrdersListData 2-field (orders: CryptoOrderData[] + nextCursor nullable V-666.BU 'opaque cursor for the next page, or null on the terminal page.'); ListApiResponse with next_cursor? optional+nullable for older-build wire-compat; CryptoOrdersListState 5-variant with loading_more{data} preserving baseline", () => {
    expect(body).toMatch(
      /export interface CryptoOrdersListData \{\s*\n?\s*orders: CryptoOrderData\[\];\s*\n?\s*\/\*\* V-666\.BU — opaque cursor for the next page, or null on the terminal page\. \*\/\s*\n?\s*nextCursor: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /interface ListApiResponse \{\s*\n?\s*orders: CryptoOrderData\[\];\s*\n?\s*next_cursor\?: string \| null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /export type CryptoOrdersListState =\s*\n?\s*\| \{ kind: 'idle' \}\s*\n?\s*\| \{ kind: 'loading' \}\s*\n?\s*\| \{ kind: 'ready'; data: CryptoOrdersListData \}\s*\n?\s*\| \{ kind: 'loading_more'; data: CryptoOrdersListData \}\s*\n?\s*\| \{ kind: 'error'; message: string \};/,
    );
  });

  it("UseCryptoOrdersListOpts: manual? + limit? 'Page size override; server caps at 100. Default unset = server default (50).' + status? 6-value union V-666.BR + createdAfter? V-666.BX inclusive + createdBefore? V-666.BX exclusive", () => {
    expect(body).toMatch(
      /export interface UseCryptoOrdersListOpts \{\s*\n?\s*\/\*\* Disable auto-fetch on mount\. Default false\. \*\/\s*\n?\s*manual\?: boolean;\s*\n?\s*\/\*\* Page size override; server caps at 100\. Default unset = server default \(50\)\. \*\/\s*\n?\s*limit\?: number;\s*\n?\s*\/\*\* V-666\.BR — server-side single-status filter\. Omit for all statuses\. \*\/\s*\n?\s*status\?: 'pending' \| 'confirming' \| 'paid' \| 'failed' \| 'partial' \| 'cancelled';\s*\n?\s*\/\*\* V-666\.BX — ISO 8601 lower bound on created_at \(inclusive\)\. \*\/\s*\n?\s*createdAfter\?: string;\s*\n?\s*\/\*\* V-666\.BX — ISO 8601 upper bound on created_at \(exclusive\)\. \*\/\s*\n?\s*createdBefore\?: string;\s*\n?\s*\}/,
    );
  });

  it('buildUrl: URL ${baseUrl}/v1/billing/crypto-orders + limit set (.toString()) + status set + created_after/created_before set when defined && length>0 + cursor set when !== null; useCallback deps [settings.baseUrl, opts.limit, opts.status, opts.createdAfter, opts.createdBefore]', () => {
    expect(body).toMatch(
      /const url = new URL\(`\$\{baseUrl\}\/v1\/billing\/crypto-orders`\);\s*\n?\s*if \(opts\.limit !== undefined\) url\.searchParams\.set\('limit', opts\.limit\.toString\(\)\);\s*\n?\s*if \(opts\.status !== undefined\) url\.searchParams\.set\('status', opts\.status\);\s*\n?\s*if \(opts\.createdAfter !== undefined && opts\.createdAfter\.length > 0\) \{\s*\n?\s*url\.searchParams\.set\('created_after', opts\.createdAfter\);\s*\n?\s*\}\s*\n?\s*if \(opts\.createdBefore !== undefined && opts\.createdBefore\.length > 0\) \{\s*\n?\s*url\.searchParams\.set\('created_before', opts\.createdBefore\);\s*\n?\s*\}\s*\n?\s*if \(cursor !== null\) url\.searchParams\.set\('cursor', cursor\);/,
    );
    expect(body).toMatch(
      /\[settings\.baseUrl, opts\.limit, opts\.status, opts\.createdAfter, opts\.createdBefore\]/,
    );
  });

  it("loadMore: state.kind !== 'ready' guard + nextCursor === null guard + apiKey guard + baseline snapshot then requestGenRef claim (const gen = ++requestGenRef.current) before setState loading_more + orders [...baseline.orders, ...body.orders] APPEND (not replace) + nextCursor refreshed from body.next_cursor ?? null — pinned so 'Load more' appends instead of replacing and a superseded slow response can't clobber newer data", () => {
    expect(body).toMatch(
      /const loadMore = useCallback\(async \(\): Promise<void> => \{\s*\n?\s*if \(state\.kind !== 'ready'\) return;\s*\n?\s*if \(state\.data\.nextCursor === null\) return;\s*\n?\s*if \(!settings\.apiKey\) \{\s*\n?\s*setState\(\{ kind: 'error', message: 'No API key configured\.' \}\);\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*const baseline = state\.data;\s*\n?\s*\/\/ Claim a fresh generation; a subsequent filter refetch \(or this call\) supersedes\.\s*\n?\s*const gen = \+\+requestGenRef\.current;\s*\n?\s*setState\(\{ kind: 'loading_more', data: baseline \}\);/,
    );
    expect(body).toMatch(
      /setState\(\{\s*\n?\s*kind: 'ready',\s*\n?\s*data: \{\s*\n?\s*orders: \[\.\.\.baseline\.orders, \.\.\.body\.orders\],\s*\n?\s*nextCursor: body\.next_cursor \?\? null,\s*\n?\s*\},\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
