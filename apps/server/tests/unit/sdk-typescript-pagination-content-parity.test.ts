// W422.A (W669-deepened) — drift guard for packages/sdk-typescript/
// src/pagination.ts. V-118 cursor-pagination async-iterator helper.
//
// W669 splits the original 8 it() blocks into 14 focused per-concept
// blocks + pins previously-implicit invariants:
//
//   • V-118 envelope shape pinned per-line: `{ data: T[], next_cursor:
//     string | null }`. The CursorPage<T>.data is `readonly T[]` (not
//     `T[]`) — drift to mutable would let consumer code mutate the
//     page array mid-iteration (which is undefined behavior in the
//     generator pattern).
//   • Hand-rolled bug rationale pinned per-line: 3 specific bugs the
//     helper guards against (off-by-one cursor handoff, forgetting
//     to break on null, double-fetch on first page).
//   • Resource .iterate(opts) thin wrapper rationale pinned.
//   • null-first-cursor invariant — fetchPage is called with `null`
//     for the first page. Drift to undefined would break the
//     conditional-spread pattern in resource iterate() methods.
//   • Stop-on-null termination — `page.next_cursor === null` (strict
//     equality). Drift to `=== undefined` would let undefined cursors
//     loop forever; drift to `!page.next_cursor` would stop on empty
//     string (which the server might legitimately return).
//   • Cursor advance — `cursor = page.next_cursor` AFTER the
//     stop-check. Drift to assigning before stop-check would let an
//     extra page-fetch happen with a null cursor on the last
//     iteration.
//   • Errors propagate — "Errors from `fetchPage` propagate to the
//     caller" framing pinned. Drift to swallowing errors would make
//     debug impossible.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/pagination.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W422.A packages/sdk-typescript/src/pagination.ts content parity', () => {
  const body = read(LIB);

  it('file exists at canonical path + V-118 anchor on the file header', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/V-118: cursor-pagination async-iterator helper\./);
  });

  it('V-118 envelope shape pinned per-line: "Every Driftstack list endpoint returns the same envelope shape: { data: T[], next_cursor: string | null }". CRITICAL: this is the ONE envelope shape every list endpoint MUST follow. Drift to a different envelope shape would force iteratePaginated to be re-implemented per-resource (defeating the point of the shared helper).', () => {
    expect(body).toMatch(
      /Every Driftstack list endpoint returns the same envelope shape:\s*\n?\s*\/\/\s*\{ data: T\[\], next_cursor: string \| null \}/,
    );
  });

  it('Hand-rolled bug rationale pinned per-line — 3 specific bugs the helper guards against: "off-by-one cursor handoff, forgetting to break on null, double-fetch on first page". Each bug is a real failure mode of hand-rolled while-loops. Drift to dropping any one bug from the rationale would lose the motivation for using the helper.', () => {
    expect(body).toMatch(
      /Hand-rolled while-loops over `next_cursor` are easy to write but easy\s*\n?\s*\/\/\s*to bug-on \(off-by-one cursor handoff, forgetting to break on null,\s*\n?\s*\/\/\s*double-fetch on first page\)\. This helper wraps the pattern as an\s*\n?\s*\/\/\s*AsyncGenerator so consumer code reads as `for await \(const item of\s*\n?\s*\/\/\s*client\.sessions\.iterate\(\)\)`\./,
    );
  });

  it('Resource .iterate(opts) thin wrapper rationale pinned: "Resources expose a thin `.iterate(opts)` method that calls `iteratePaginated` with the resource\'s own `list` as `fetchPage`." This is the cross-resource pattern (sessions/profiles/profile-snapshots/audit-log/webhooks/crypto-orders) — drift to inlining iteratePaginated in each resource would defeat the centralization.', () => {
    expect(body).toMatch(
      /Resources expose a thin `\.iterate\(opts\)` method that calls\s*\n?\s*\/\/\s*`iteratePaginated` with the resource's own `list` as `fetchPage`\./,
    );
  });

  it('CRITICAL CursorPage<T> shape — generic + 2 fields. `data: readonly T[]` (NOT `T[]`) — drift to mutable would let consumer code mutate the page array mid-iteration (which is undefined behavior in the async generator pattern). `next_cursor: string | null` — nullable is the load-bearing terminator signal.', () => {
    expect(body).toMatch(
      /\/\*\* Shape of a Driftstack list endpoint response\. \*\/\s*\n?\s*export interface CursorPage<T> \{\s*\n?\s*data: readonly T\[\];\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('iteratePaginated JSDoc — "Lazily walk every page of a cursor-paginated list endpoint" framing pinned. The "Lazily" wording is what tells consumers each page-fetch happens on-demand (vs eagerly fetching all pages upfront).', () => {
    expect(body).toMatch(/\* Lazily walk every page of a cursor-paginated list endpoint\./);
  });

  it("CRITICAL fetchPage contract — pinned per-line: (1) called with `null` for the FIRST page, (2) with each subsequent `next_cursor`, (3) generator stops as soon as `next_cursor` is null, (4) Errors from fetchPage PROPAGATE to the caller (consumer's `try { for await ... } catch`). Drift to swallowing errors would make debug impossible; drift to using `undefined` instead of `null` for the first call would break the conditional-spread pattern in resource iterate() methods.", () => {
    expect(body).toMatch(
      /\*\s*`fetchPage` is called with `null` for the first page and with each\s*\n?\s*\*\s*subsequent `next_cursor`\. The generator stops as soon as\s*\n?\s*\*\s*`next_cursor` is null\. Errors from `fetchPage` propagate to the\s*\n?\s*\*\s*caller \(consumer's `try \{ for await \.\.\. \} catch`\)\./,
    );
  });

  it('In-JSDoc example pattern pinned per-line: `for await (const session of iteratePaginated((cursor) => client.sessions.list(cursor !== null ? { cursor } : {})))`. The `cursor !== null ? { cursor } : {}` conditional-spread is the canonical first-page pattern — drift to passing `{ cursor: null }` (or `{ cursor: undefined }`) would break the server-side query-param parsing.', () => {
    expect(body).toMatch(
      /\*\s*for await \(const session of iteratePaginated\(\(cursor\) =>\s*\n?\s*\*\s*client\.sessions\.list\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\*\s*\)\) \{/,
    );
  });

  it('iteratePaginated signature — `export async function* iteratePaginated<T>(fetchPage: (cursor: string | null) => Promise<CursorPage<T>>): AsyncGenerator<T, void, void>`. CRITICAL: AsyncGenerator return type carries 3 type parameters (yielded=T, returned=void, next-input=void). Drift to dropping the void parameters would silently let consumers pass values to .next() that get ignored.', () => {
    expect(body).toMatch(
      /export async function\* iteratePaginated<T>\(\s*\n?\s*fetchPage: \(cursor: string \| null\) => Promise<CursorPage<T>>,\s*\n?\s*\): AsyncGenerator<T, void, void> \{/,
    );
  });

  it('Loop initialization — `let cursor: string | null = null;` (NOT undefined, NOT empty string). The explicit `string | null` type annotation matches the fetchPage parameter; drift to `let cursor` (untyped) would let TS infer a narrower type that breaks the assignment from page.next_cursor.', () => {
    expect(body).toMatch(/let cursor: string \| null = null;/);
  });

  it("CRITICAL loop body — `while (true) { const page = await fetchPage(cursor); for (const item of page.data) { yield item; } if (page.next_cursor === null) { return; } cursor = page.next_cursor; }`. Order is load-bearing: fetch → yield → check-stop → advance. Drift to checking stop BEFORE yielding would skip the last page's items; drift to advancing BEFORE the stop-check would fetch an extra null-cursor page on the last iteration.", () => {
    expect(body).toMatch(
      /while \(true\) \{\s*\n?\s*const page = await fetchPage\(cursor\);\s*\n?\s*for \(const item of page\.data\) \{\s*\n?\s*yield item;\s*\n?\s*\}\s*\n?\s*if \(page\.next_cursor === null\) \{\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*cursor = page\.next_cursor;/,
    );
  });

  it('Stop condition — `page.next_cursor === null` STRICT equality. Drift to `=== undefined` would let undefined cursors loop forever; drift to `!page.next_cursor` would stop on empty string (which the server might legitimately return for a still-paginating-but-temporarily-empty page) AND on 0 / false (impossible types but still a footgun).', () => {
    expect(body).toMatch(/if \(page\.next_cursor === null\) \{\s*\n?\s*return;\s*\n?\s*\}/);
  });

  it('Cursor advance — `cursor = page.next_cursor;` AFTER the stop-check. This is the load-bearing ordering: if the stop-check passes (next_cursor is null), we return BEFORE assigning. Drift to assigning before stop-check would let an extra page-fetch happen with a null cursor on the last iteration.', () => {
    expect(body).toMatch(
      /if \(page\.next_cursor === null\) \{\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*cursor = page\.next_cursor;/,
    );
  });

  it('Yield pattern — `for (const item of page.data) { yield item; }` (NOT `yield* page.data`). Drift to yield-star would lose the explicit per-item yield (functionally equivalent but the explicit form makes the cursor-handoff readable). The for-of also makes it clear that yield happens for EVERY item, not just the first.', () => {
    expect(body).toMatch(/for \(const item of page\.data\) \{\s*\n?\s*yield item;\s*\n?\s*\}/);
  });
});
