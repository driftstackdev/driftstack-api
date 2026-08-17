// Splitting an id list so a single statement never exceeds the driver's
// bind-parameter limit.
//
// `inArray(col, ids)` binds one parameter per id. postgres-js refuses a
// statement carrying more than 65534 of them — measured against our own server:
// 60000 ids succeed, 70000 raise `MAX_PARAMETERS_EXCEEDED`. Every place that
// derives an id list from a query result or a listing is therefore capped by
// how much data has accumulated, not by anything in the code.
//
// That failure mode is quiet in exactly the wrong way. The three known sites are
// all retention or cleanup work that runs on a backlog:
//
//   audit archive       uploads to R2 and writes its ledger row BEFORE deleting,
//                       so an oversized window left the rows in place with the
//                       archive already written, and the next run re-selected
//                       the same set plus whatever had accrued.
//   subscriber purge    the V-295c3 90-day erasure of the email column on
//                       unsubscribed rows — a privacy commitment that simply
//                       stops being kept.
//   orphan blob reaper  wrapped so it NEVER throws, so it would log and continue
//                       having done nothing, forever.
//
// In all three the sweep is what bounds the table, so the failure grows the very
// backlog that triggers it.
//
// 10_000 matches the batch size AuditArchiveService already declares, and leaves
// a wide margin under the limit.

/** Ids per statement. Must stay well under the 65534 bind-parameter ceiling. */
export const ID_BIND_CHUNK = 10_000;

/**
 * Split `ids` into chunks small enough to bind in one statement.
 *
 * Returns `[]` for an empty input, so `for (const chunk of chunkIds(ids))`
 * performs no work rather than emitting `IN ()`.
 */
export function chunkIds(ids: readonly string[]): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += ID_BIND_CHUNK) {
    out.push([...ids.slice(i, i + ID_BIND_CHUNK)]);
  }
  return out;
}
