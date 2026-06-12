// Keyset pagination cursors that are a bare row UUID (the `id` of the last row
// on the prior page) get looked up against a `uuid` Postgres column to resolve
// the (created_at, id) keyset anchor. A malformed (non-UUID) cursor — only
// reachable from a hand-crafted request, never from our own `next_cursor` —
// would make Postgres raise `invalid input syntax for type uuid` on that
// lookup, surfacing as a 500. Guard the value before it reaches the column.

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Return the cursor only when it is UUID-shaped (the form every `next_cursor`
 * we emit takes); otherwise `undefined`, so the caller skips the keyset anchor
 * and starts from the first page. This matches the existing "cursor row not
 * found → first page" semantics and the in-memory repos' behaviour, turning a
 * malformed-cursor 500 into a graceful first-page response. The downstream
 * `WHERE account_id = …` filter is independent of the cursor, so this is purely
 * a robustness fix — it never widens what a caller can read.
 */
export function parseUuidCursor(cursor: string | undefined): string | undefined {
  if (cursor === undefined) return undefined;
  return UUID_RE.test(cursor) ? cursor : undefined;
}
