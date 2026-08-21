// V-1242 — the defining property of `keysetPage`, stated once.
//
// Six in-memory doubles resolved a pagination cursor with `findIndex` inside the array they had
// ALREADY filtered, then sliced from that index. Every Drizzle repo instead looks the cursor row up
// by id, scoped to the tenancy filter only, and selects rows strictly after it.
//
// The two agree exactly while the cursor row still passes the filter, and `findIndex` returns -1
// the moment it does not — which the slice read as "start from the top". The trigger is never an
// error and never rare: an API key revoked, a session finishing, an override expiring, an account
// suspended, a row purged by retention. The symptom is a page of duplicates.
//
// So the property is not "paging works". It is that the cursor row is allowed to be GONE from the
// visible page and still hold its place. That is the one thing `findIndex`-in-the-filtered-array
// cannot do, and the one thing every arm below checks.
//
// These are the helper's own semantics. Whether a given double passes the right two sets to it is
// a per-double question, answered by that double's contract — see the cursor-survival arm in
// `api-keys-repo-contract.test.ts`, which drives both real implementations.

import { describe, expect, it } from 'vitest';

import { keysetPage } from '../integration/_helpers/keyset-page.js';

interface Row {
  id: string;
  createdAt: Date;
  visible: boolean;
}

const T0 = new Date('2026-08-20T12:00:00.000Z');

/** Ids are uuids because `keysetPage` ignores a cursor that is not one. */
const ID = [
  '00000000-0000-4000-8000-00000000000a',
  '00000000-0000-4000-8000-00000000000b',
  '00000000-0000-4000-8000-00000000000c',
  '00000000-0000-4000-8000-00000000000d',
] as const;

/** Newest first, matching the DESC order every caller sorts into. */
function rows(visible: (i: number) => boolean = () => true): Row[] {
  return ID.map((id, i) => ({
    id,
    createdAt: new Date(T0.getTime() - i * 60_000),
    visible: visible(i),
  })).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
}

const page = (all: Row[], cursor: string | undefined, limit = 2) =>
  keysetPage({
    anchorSet: all,
    rows: all.filter((r) => r.visible),
    cursor,
    limit,
    id: (r) => r.id,
    at: (r) => r.createdAt,
  });

describe('keysetPage', () => {
  it('CRITICAL the cursor holds its place when its own row has left the filtered page. This is the whole reason the helper exists: the anchor is resolved against the tenancy-scoped set, so a row that was revoked, expired, finished or suspended since the previous page still marks where that page ended. Resolving it inside the filtered rows instead yields -1, which reads as "start from the top" and hands the caller a page it has already seen.', () => {
    const all = rows();
    const first = page(all, undefined);
    expect(
      first.items.map((r) => r.id),
      'page one was not the two newest',
    ).toEqual([ID[0], ID[1]]);

    // The row the cursor names stops being visible between the two reads.
    const boundary = all.find((r) => r.id === first.nextCursor);
    expect(boundary, 'page one handed out no usable cursor').toBeDefined();
    if (boundary) boundary.visible = false;

    const second = page(all, first.nextCursor ?? undefined);
    expect(
      second.items.map((r) => r.id),
      'the page restarted from the top once the cursor row left the filter',
    ).toEqual([ID[2], ID[3]]);
  });

  it('CRITICAL adjacent pages partition the visible rows — none repeated, none dropped. Without this the arm above is satisfied by an implementation that simply skips the boundary row, which loses a row per page instead of repeating one.', () => {
    const all = rows();
    const first = page(all, undefined);
    const second = page(all, first.nextCursor ?? undefined);

    expect(
      [...first.items, ...second.items].map((r) => r.id).sort(),
      'the two pages together are not exactly the visible set',
    ).toEqual([...ID].sort());
    expect(
      first.items.filter((r) => second.items.some((o) => o.id === r.id)),
      'a row appeared on both pages',
    ).toEqual([]);
  });

  it('CRITICAL the last page reports hasMore false and hands out no cursor. A non-null cursor on the final page is an infinite loop for any caller that pages until the cursor is null.', () => {
    const all = rows();
    const last = page(all, undefined, 10);

    expect(last.items.length, 'the whole set did not fit in one page').toBe(4);
    expect(last.hasMore, 'the final page claimed there was more').toBe(false);
    expect(last.nextCursor, 'the final page handed out a cursor').toBeNull();
  });

  it('CRITICAL ties on the ordering key fall back to the id, so equal timestamps are neither dropped nor repeated. Rows written in the same millisecond are ordinary — a bulk insert makes a whole page of them — and a timestamp-only boundary either skips them all or returns them forever.', () => {
    const same = ID.map((id) => ({ id, createdAt: T0, visible: true })).sort((a, b) =>
      a.id < b.id ? 1 : -1,
    );
    const first = page(same, undefined);
    const second = page(same, first.nextCursor ?? undefined);

    expect(
      [...first.items, ...second.items].map((r) => r.id).sort(),
      'same-timestamp rows were dropped or repeated across the boundary',
    ).toEqual([...ID].sort());
  });

  it('CRITICAL an unknown cursor yields the FIRST page rather than an empty one, matching every Drizzle repo, where a cursor row that no longer exists contributes no WHERE clause. An empty page would strand the caller somewhere they cannot page off.', () => {
    const all = rows();
    const p = page(all, '00000000-0000-4000-8000-0000000000ff');
    expect(
      p.items.map((r) => r.id),
      'an unknown cursor did not fall back to page one',
    ).toEqual([ID[0], ID[1]]);
  });

  it('CRITICAL a cursor that is not a uuid is IGNORED rather than resolved. `parseUuidCursor` returning undefined contributes no clause on the Drizzle side, so the caller gets page one. The anchor set here deliberately CONTAINS a row whose id is the malformed cursor: without that row the arm passes either way, because a lookup for a non-uuid misses whether or not the guard is there, and the arm would pin nothing. Verified by removing the guard and watching this fail.', () => {
    const all = rows();
    // Positioned between the first and second rows, and not itself visible, so that
    // anchoring on it would return a demonstrably different page from page one.
    all.push({ id: 'not-a-uuid', createdAt: new Date(T0.getTime() - 30_000), visible: false });
    all.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const p = page(all, 'not-a-uuid');
    expect(
      p.items.map((r) => r.id),
      'a malformed cursor was resolved as an anchor instead of being ignored',
    ).toEqual([ID[0], ID[1]]);
  });
});
