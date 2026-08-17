// V-118: cursor-pagination async-iterator helper.
//
// Every Driftstack list endpoint returns the same envelope shape:
//   { data: T[], next_cursor: string | null }
//
// Hand-rolled while-loops over `next_cursor` are easy to write but easy
// to bug-on (off-by-one cursor handoff, forgetting to break on null,
// double-fetch on first page). This helper wraps the pattern as an
// AsyncGenerator so consumer code reads as `for await (const item of
// client.sessions.iterate())`.
//
// Resources expose a thin `.iterate(opts)` method that calls
// `iteratePaginated` with the resource's own `list` as `fetchPage`.

import { TransportError } from './errors.js';

/** Shape of a Driftstack list endpoint response. */
export interface CursorPage<T> {
  data: readonly T[];
  next_cursor: string | null;
}

/**
 * Lazily walk every page of a cursor-paginated list endpoint.
 *
 * `fetchPage` is called with `null` for the first page and with each
 * subsequent `next_cursor`. The generator stops as soon as
 * `next_cursor` is null. Errors from `fetchPage` propagate to the
 * caller (consumer's `try { for await ... } catch`).
 *
 * @example
 *   for await (const session of iteratePaginated((cursor) =>
 *     client.sessions.list(cursor !== null ? { cursor } : {}),
 *   )) {
 *     // ...
 *   }
 */
export async function* iteratePaginated<T>(
  fetchPage: (cursor: string | null) => Promise<CursorPage<T>>,
): AsyncGenerator<T, void, void> {
  let cursor: string | null = null;
  while (true) {
    const page = await fetchPage(cursor);
    for (const item of page.data) {
      yield item;
    }
    // An empty-string cursor is 'no more pages', not a cursor. Treating it as
    // one restarts the walk: the server decodes an empty cursor as 'first
    // page', so the iterator cycles c1 -> '' -> c1 forever, yielding
    // duplicates. The repeated-cursor guard below cannot catch that, because
    // consecutive cursors differ. sdk-go already stops here (advanceCursor:
    // "next is nil or '' -> last page").
    if (page.next_cursor === null || page.next_cursor === '') {
      return;
    }
    // Guard against a non-advancing cursor. Keyset pagination always returns a
    // strictly-new next_cursor, so the SAME cursor coming back means a server /
    // proxy / cache bug. Without this the loop would spin forever and hang the
    // caller's process; surface a clear error instead of an undiagnosable hang.
    if (page.next_cursor === cursor) {
      throw new TransportError(
        'pagination did not advance: the server returned the same cursor twice',
        0,
      );
    }
    cursor = page.next_cursor;
  }
}
