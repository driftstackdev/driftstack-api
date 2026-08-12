// The documented concurrent-insert promise, expressed once.
//
// `apps/docs/src/pages/reference/pagination.md` tells customers that offset
// paging is not supported because "cursor pagination is stable under concurrent
// inserts (page 2 doesn't shift just because page 1 grew); offset pagination
// isn't, and we don't want to expose customers to that footgun."
//
// Seven repos expose keyset pagination and each shipped with a single case — a
// same-key tie group — so the sentence above was unverified against real
// Postgres. It belongs to the SQL rather than to any repo's TypeScript: an
// offset-based rewrite keeps every in-memory test green while duplicating rows
// for anyone driving a list to completion.
//
// Written as a helper because the first two were hand-rolled and both needed a
// correction — one had the repo class name wrong, the other registered cleanup
// against a variable that did not exist in that file. Those are exactly the
// mistakes that repeat across four more call sites. Here each caller supplies
// only the two things that genuinely differ: how to insert a row at a given
// time offset, and how to ask its repo for a page.

import { expect } from 'vitest';

export interface KeysetPage {
  ids: string[];
  nextCursor: string | null;
}

export interface StableUnderInsertsArgs {
  /** Insert one row `offsetMs` after the fixture's base time; return its id. */
  seed: (offsetMs: number) => Promise<string>;
  /** Ask the repo for a page. `cursor` absent means the first page. */
  list: (args: { limit: number; cursor?: string }) => Promise<KeysetPage>;
  /** Names the row kind in failure messages, e.g. "api key". */
  noun: string;
}

/**
 * Seed five rows, take page one, insert three NEWER rows, then finish the walk.
 *
 * Asserts the two failure modes offset paging produces and keyset paging must
 * not: a row returned twice, and a row that existed before the walk being
 * stepped over when the window shifts. Also asserts the loop ended because the
 * repo said so, not because the runaway guard fired — a walk that never
 * terminates would otherwise satisfy both absence checks.
 */
export async function assertStableUnderMidWalkInserts(args: StableUnderInsertsArgs): Promise<void> {
  const originals: string[] = [];
  for (let i = 0; i < 5; i += 1) originals.push(await args.seed(i * 1000));
  expect(new Set(originals).size, `five distinct ${args.noun} rows were seeded`).toBe(5);

  const first = await args.list({ limit: 2 });
  expect(first.ids, `page 1 of the ${args.noun} walk is full`).toHaveLength(2);

  // The list grows: three rows newer than anything returned so far. Under
  // offset paging these shift every later window by three.
  for (let i = 0; i < 3; i += 1) await args.seed(10_000 + i * 1000);

  const seen = [...first.ids];
  let cursor = first.nextCursor;
  let pages = 1;
  for (let guard = 0; guard < 50 && cursor !== null; guard += 1) {
    const page = await args.list({ limit: 2, cursor });
    seen.push(...page.ids);
    cursor = page.nextCursor;
    pages += 1;
  }

  expect(
    seen.filter((id, i) => seen.indexOf(id) !== i),
    `no ${args.noun} may be returned twice — the offset footgun the docs promise customers are spared`,
  ).toEqual([]);
  expect(
    originals.filter((id) => !seen.includes(id)),
    `and no ${args.noun} present before the walk began may be stepped over`,
  ).toEqual([]);
  expect(
    cursor,
    `the ${args.noun} walk terminated on its own, not on the runaway guard`,
  ).toBeNull();
  expect(
    pages,
    `the ${args.noun} walk really paged rather than returning everything at once`,
  ).toBeGreaterThan(1);
}
