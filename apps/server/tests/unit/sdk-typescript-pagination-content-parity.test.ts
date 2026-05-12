// W422.A — drift guard for packages/sdk-typescript/src/pagination.ts.
// V-118 cursor-pagination async-iterator helper. Wraps the
// `{data, next_cursor}` envelope pattern as an AsyncGenerator so SDK
// consumers can `for await (const item of client.sessions.iterate())`.
// Drift here either drops the null-termination (loop never exits) or
// breaks the cursor-handoff invariant (skipped/duplicate pages).
//
//   • V-118 framing pinned: cursor-pagination async-iterator;
//     resource .iterate(opts) thin wrapper around iteratePaginated.
//   • Envelope: { data: readonly T[], next_cursor: string | null }.
//   • fetchPage(null) for first page; subsequent calls with
//     next_cursor; stop on null; errors propagate to consumer's
//     try/catch.
//   • AsyncGenerator<T, void, void> return type pinned.

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

  it('V-118 framing pinned: cursor-pagination async-iterator helper; every list endpoint has {data, next_cursor} envelope', () => {
    expect(body).toMatch(/V-118: cursor-pagination async-iterator helper\./);
    expect(body).toMatch(
      /Every Driftstack list endpoint returns the same envelope shape:\s*\n?\s*\/\/\s*\{ data: T\[\], next_cursor: string \| null \}/,
    );
  });

  it('Off-by-one / null-termination / double-fetch hand-rolled bug rationale pinned', () => {
    expect(body).toMatch(
      /Hand-rolled while-loops over `next_cursor` are easy to write but easy\s*\n?\s*\/\/\s*to bug-on \(off-by-one cursor handoff, forgetting to break on null,\s*\n?\s*\/\/\s*double-fetch on first page\)\. This helper wraps the pattern as an\s*\n?\s*\/\/\s*AsyncGenerator so consumer code reads as `for await \(const item of\s*\n?\s*\/\/\s*client\.sessions\.iterate\(\)\)`\./,
    );
  });

  it('Resource .iterate(opts) thin wrapper rationale pinned: calls iteratePaginated with the resource own list as fetchPage', () => {
    expect(body).toMatch(
      /Resources expose a thin `\.iterate\(opts\)` method that calls\s*\n?\s*\/\/\s*`iteratePaginated` with the resource's own `list` as `fetchPage`\./,
    );
  });

  it('CursorPage<T>: { data: readonly T[]; next_cursor: string | null } envelope shape', () => {
    expect(body).toMatch(
      /\/\*\* Shape of a Driftstack list endpoint response\. \*\/\s*\n?\s*export interface CursorPage<T> \{\s*\n?\s*data: readonly T\[\];\s*\n?\s*next_cursor: string \| null;\s*\n?\s*\}/,
    );
  });

  it('iteratePaginated: async generator T,void,void return type; null cursor first call; stop on next_cursor === null; errors propagate', () => {
    expect(body).toMatch(/\* Lazily walk every page of a cursor-paginated list endpoint\./);
    expect(body).toMatch(
      /\*\s*`fetchPage` is called with `null` for the first page and with each\s*\n?\s*\*\s*subsequent `next_cursor`\. The generator stops as soon as\s*\n?\s*\*\s*`next_cursor` is null\. Errors from `fetchPage` propagate to the\s*\n?\s*\*\s*caller \(consumer's `try \{ for await \.\.\. \} catch`\)\./,
    );
    expect(body).toMatch(
      /export async function\* iteratePaginated<T>\(\s*\n?\s*fetchPage: \(cursor: string \| null\) => Promise<CursorPage<T>>,\s*\n?\s*\): AsyncGenerator<T, void, void> \{/,
    );
  });

  it('Loop body: cursor=null init + while(true) + fetchPage(cursor) + yield each page.data item + return on next_cursor===null + cursor=next_cursor advance', () => {
    expect(body).toMatch(
      /let cursor: string \| null = null;\s*\n?\s*while \(true\) \{\s*\n?\s*const page = await fetchPage\(cursor\);\s*\n?\s*for \(const item of page\.data\) \{\s*\n?\s*yield item;\s*\n?\s*\}\s*\n?\s*if \(page\.next_cursor === null\) \{\s*\n?\s*return;\s*\n?\s*\}\s*\n?\s*cursor = page\.next_cursor;/,
    );
  });

  it('Example: for await (const session of iteratePaginated((cursor) => client.sessions.list(cursor !== null ? { cursor } : {})))', () => {
    expect(body).toMatch(
      /\*\s*for await \(const session of iteratePaginated\(\(cursor\) =>\s*\n?\s*\*\s*client\.sessions\.list\(cursor !== null \? \{ cursor \} : \{\}\),\s*\n?\s*\*\s*\)\) \{/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
