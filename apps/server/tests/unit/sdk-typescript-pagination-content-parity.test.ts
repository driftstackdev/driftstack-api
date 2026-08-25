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
      /Every Driftstack list endpoint returns the same envelope shape:\s*\/\/\s*\{ data: T\[\], next_cursor: string \| null \}/,
    );
  });

  it('Hand-rolled bug rationale pinned per-line — 3 specific bugs the helper guards against: "off-by-one cursor handoff, forgetting to break on null, double-fetch on first page". Each bug is a real failure mode of hand-rolled while-loops. Drift to dropping any one bug from the rationale would lose the motivation for using the helper.', () => {
    expect(body).toMatch(
      /Hand-rolled while-loops over `next_cursor` are easy to write but easy\s*\/\/\s*to bug-on \(off-by-one cursor handoff, forgetting to break on null,\s*\/\/\s*double-fetch on first page\)\. This helper wraps the pattern as an\s*\/\/\s*AsyncGenerator so consumer code reads as `for await \(const item of\s*\/\/\s*client\.sessions\.iterate\(\)\)`\./,
    );
  });

  it('Resource .iterate(opts) thin wrapper rationale pinned: "Resources expose a thin `.iterate(opts)` method that calls `iteratePaginated` with the resource\'s own `list` as `fetchPage`." This is the cross-resource pattern (sessions/profiles/profile-snapshots/audit-log/webhooks/crypto-orders) — drift to inlining iteratePaginated in each resource would defeat the centralization.', () => {
    expect(body).toMatch(
      /Resources expose a thin `\.iterate\(opts\)` method that calls\s*\/\/\s*`iteratePaginated` with the resource's own `list` as `fetchPage`\./,
    );
  });

  it('CRITICAL CursorPage<T> shape — generic + 2 fields. `data: readonly T[]` (NOT `T[]`) — drift to mutable would let consumer code mutate the page array mid-iteration (which is undefined behavior in the async generator pattern). `next_cursor: string | null` — nullable is the load-bearing terminator signal.', () => {
    expect(body).toMatch(
      /\/\*\* Shape of a Driftstack list endpoint response\. \*\/\s*export interface CursorPage<T> \{\s*data: readonly T\[\];\s*next_cursor: string \| null;\s*\}/,
    );
  });

  it('iteratePaginated JSDoc — "Lazily walk every page of a cursor-paginated list endpoint" framing pinned. The "Lazily" wording is what tells consumers each page-fetch happens on-demand (vs eagerly fetching all pages upfront).', () => {
    expect(body).toMatch(/\* Lazily walk every page of a cursor-paginated list endpoint\./);
  });

  it("CRITICAL fetchPage contract — pinned per-line: (1) called with `null` for the FIRST page, (2) with each subsequent `next_cursor`, (3) generator stops as soon as `next_cursor` is null, (4) Errors from fetchPage PROPAGATE to the caller (consumer's `try { for await ... } catch`). Drift to swallowing errors would make debug impossible; drift to using `undefined` instead of `null` for the first call would break the conditional-spread pattern in resource iterate() methods.", () => {
    expect(body).toMatch(
      /\*\s*`fetchPage` is called with `null` for the first page and with each\s*\*\s*subsequent `next_cursor`\. The generator stops as soon as\s*\*\s*`next_cursor` is null\. Errors from `fetchPage` propagate to the\s*\*\s*caller \(consumer's `try \{ for await \.\.\. \} catch`\)\./,
    );
  });

  it('In-JSDoc example pattern pinned per-line: `for await (const session of iteratePaginated((cursor) => client.sessions.list(cursor !== null ? { cursor } : {})))`. The `cursor !== null ? { cursor } : {}` conditional-spread is the canonical first-page pattern — drift to passing `{ cursor: null }` (or `{ cursor: undefined }`) would break the server-side query-param parsing.', () => {
    expect(body).toMatch(
      /\*\s*for await \(const session of iteratePaginated\(\(cursor\) =>\s*\*\s*client\.sessions\.list\(cursor !== null \? \{ cursor \} : \{\}\),\s*\*\s*\)\) \{/,
    );
  });

  it('iteratePaginated signature — `export async function* iteratePaginated<T>(fetchPage: (cursor: string | null) => Promise<CursorPage<T>>): AsyncGenerator<T, void, void>`. CRITICAL: AsyncGenerator return type carries 3 type parameters (yielded=T, returned=void, next-input=void). Drift to dropping the void parameters would silently let consumers pass values to .next() that get ignored.', () => {
    expect(body).toMatch(
      /export async function\* iteratePaginated<T>\(\s*fetchPage: \(cursor: string \| null\) => Promise<CursorPage<T>>,\s*\): AsyncGenerator<T, void, void> \{/,
    );
  });

  it('Loop initialization — `let cursor: string | null = null;` (NOT undefined, NOT empty string). The explicit `string | null` type annotation matches the fetchPage parameter; drift to `let cursor` (untyped) would let TS infer a narrower type that breaks the assignment from page.next_cursor.', () => {
    expect(body).toMatch(/let cursor: string \| null = null;/);
  });

  it("CRITICAL loop body — `while (true) { const page = await fetchPage(cursor); for (const item of page.data) { yield item; } if (page.next_cursor === null) { return; } ... }`. Order is load-bearing: fetch → yield → check-stop. Drift to checking stop BEFORE yielding would skip the last page's items. (The non-advance guard + cursor advance are pinned separately below.)", () => {
    expect(body).toMatch(
      /while \(true\) \{\s*const page = await fetchPage\(cursor\);\s*for \(const item of page\.data\) \{\s*yield item;\s*\}[\s\S]{0,600}?if \(page\.next_cursor === null \|\| page\.next_cursor === ''\) \{\s*return;\s*\}/,
    );
  });

  it('CRITICAL non-advance guard — `if (page.next_cursor === cursor) { throw new TransportError(...) }` BETWEEN the stop-check and the cursor advance. A keyset cursor always advances, so the same cursor coming back means a buggy server/proxy; without this the loop hangs the caller forever. Drift to dropping it reintroduces the infinite-hang failure mode.', () => {
    expect(body).toMatch(/if \(page\.next_cursor === cursor\) \{/);
    expect(body).toMatch(/throw new TransportError\(/);
    expect(body).toMatch(/pagination did not advance/);
  });

  // The old rationale here read: stopping on an empty string would be wrong
  // because "the server might legitimately return [it] for a
  // still-paginating-but-temporarily-empty page". This server cannot produce
  // that. Every list repo emits `hasMore && last ? <id> : null` — an id is
  // never empty, and if `data` were empty then `last` is undefined and the
  // expression yields null, not "". So an empty cursor is never a keep-going
  // signal; it can only come from a broken server or proxy.
  //
  // Which matters, because treating it as a cursor is not a harmless extra
  // fetch: the server decodes an empty cursor as "first page", so the walk
  // restarts and cycles c1 -> "" -> c1 forever, yielding duplicates, and the
  // non-advance guard below never fires because consecutive cursors differ.
  // sdk-go already stopped on it; this now matches.
  //
  // The `=== undefined` half of the original rationale still stands and is
  // still pinned: strict equality on both branches, never a truthiness test,
  // which would also stop on 0 / false.
  it('Stop condition — null OR empty string ends the walk, both by STRICT equality (never a truthiness test)', () => {
    expect(body).toMatch(
      /if \(page\.next_cursor === null \|\| page\.next_cursor === ''\) \{\s*return;\s*\}/,
    );
    expect(body, 'a truthiness test would also stop on 0 / false').not.toMatch(
      /if \(!page\.next_cursor\)/,
    );
  });

  it('Cursor advance — `cursor = page.next_cursor;` is the loop tail, reached only after BOTH the stop-check (return on null) and the non-advance guard (throw on a repeated cursor) pass. Drift to advancing before the stop-check would fetch an extra null-cursor page on the last iteration.', () => {
    expect(body).toMatch(
      /if \(page\.next_cursor === cursor\) \{\s*throw new TransportError\([\s\S]{0,160}?\);\s*\}\s*cursor = page\.next_cursor;/,
    );
  });

  it('Yield pattern — `for (const item of page.data) { yield item; }` (NOT `yield* page.data`). Drift to yield-star would lose the explicit per-item yield (functionally equivalent but the explicit form makes the cursor-handoff readable). The for-of also makes it clear that yield happens for EVERY item, not just the first.', () => {
    expect(body).toMatch(/for \(const item of page\.data\) \{\s*yield item;\s*\}/);
  });
});
