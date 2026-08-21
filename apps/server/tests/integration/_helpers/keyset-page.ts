// V-1242 — the one keyset-paging implementation for the in-memory doubles.
//
// Every Drizzle repo that pages does it the same way: look the cursor row up BY ID, scoped to the
// TENANCY filter only, then select rows strictly after it in `(createdAt DESC, id DESC)` order.
// Several doubles instead resolved the cursor with `findIndex` inside the array they had already
// filtered, and sliced from that index.
//
// Those two agree exactly while the cursor row still passes the filter. `findIndex` returns -1 when
// it does not, which the slice read as "start from the top" — so page two came back as page one and
// the caller saw rows it had already been given. Depending on the listing, the trigger is a staff
// action (an account suspended, an API key revoked), an ordinary clock tick (an override expiring,
// a session finishing), or a retention purge. It is never an error; it is a page of duplicates.
//
// The distinction this helper exists to hold is between the two row sets:
//
//   anchorSet   rows the CURSOR may be resolved against — tenancy scope only. The cursor row is
//               explicitly allowed to have left the visible page since it was issued.
//   rows        the fully filtered, DESC-sorted page source.
//
// Collapsing those two into one set is the entire defect. The in-memory profiles double already
// carried this fix under a "FIX 3" comment describing the same pagination loop; it was applied
// once and never swept, which is why this is a shared function rather than a seventh copy.

import { parseUuidCursor } from '../../../src/lib/keyset-cursor.js';

export interface KeysetPageArgs<T> {
  /** Tenancy-scoped rows the cursor is resolved against — NOT the filtered page source. */
  anchorSet: readonly T[];
  /** The filtered page source, already sorted newest-first by the same key as `at`/`id`. */
  rows: readonly T[];
  cursor: string | undefined;
  limit: number;
  id: (row: T) => string;
  /** The DESC-ordered key: `createdAt` for most listings, `timestamp` for the audit logs. */
  at: (row: T) => Date;
}

export interface KeysetPageResult<T> {
  items: T[];
  hasMore: boolean;
  nextCursor: string | null;
}

export function keysetPage<T>(args: KeysetPageArgs<T>): KeysetPageResult<T> {
  const { anchorSet, rows, cursor, limit, id, at } = args;

  let rest: readonly T[] = rows;
  // A non-uuid cursor is ignored rather than rejected, matching every Drizzle repo:
  // `parseUuidCursor` returning undefined contributes no WHERE clause, so the caller
  // gets page one instead of an error.
  if (cursor !== undefined && parseUuidCursor(cursor) !== undefined) {
    const anchor = anchorSet.find((r) => id(r) === cursor);
    // An unknown cursor also falls through to page one — the row may have been hard
    // deleted, and stranding the caller on a blank page they cannot page off is worse
    // than restarting.
    if (anchor !== undefined) {
      const anchorAt = at(anchor).getTime();
      const anchorId = id(anchor);
      rest = rows.filter((r) => {
        const t = at(r).getTime();
        return t < anchorAt || (t === anchorAt && id(r) < anchorId);
      });
    }
  }

  const items = rest.slice(0, limit);
  const hasMore = rest.length > limit;
  const last = items[items.length - 1];
  return { items, hasMore, nextCursor: hasMore && last !== undefined ? id(last) : null };
}
