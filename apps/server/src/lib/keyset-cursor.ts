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

/**
 * Composite (created_at, id) keyset cursor for the webhook-delivery listings.
 *
 * The old cursor was `created_at.toISOString()` alone, paginated with
 * `WHERE created_at < cursor ORDER BY created_at DESC`. That SILENTLY DROPS
 * rows that share the boundary row's created_at (bulk-enqueued deliveries
 * routinely land in the same millisecond): every row with `created_at = T`
 * beyond the page limit is neither returned on the current page nor matched by
 * the next page's strict `created_at < T`. The fix is to break the tie on the
 * row id — encode BOTH values and paginate on the composite key.
 */
export interface DeliveryCursor {
  createdAt: Date;
  /** null when decoding a legacy created_at-only cursor (still in flight across
   *  the deploy) — the caller then falls back to the plain created_at filter. */
  id: string | null;
}

/** ISO timestamps and UUIDs both contain no `_`, so `<iso>_<uuid>` round-trips
 *  unambiguously on the first underscore. */
export function encodeDeliveryCursor(createdAt: Date, id: string): string {
  return `${createdAt.toISOString()}_${id}`;
}

/**
 * The exact shape `Date.prototype.toISOString()` emits for a four-digit year,
 * which is the only shape `encodeDeliveryCursor` can produce.
 *
 * `new Date(...)` alone is not a sufficient check, and the gap is reachable: it
 * accepts values Postgres will not store, so the tampered cursor this module
 * exists to neutralise still reached the query and failed it. Two concrete
 * shapes, both verified against the running database —
 *
 *   `0000-01-01T00:00:00.000Z`     parses in JS; there is no year zero, so
 *                                  Postgres raises "date/time field value out
 *                                  of range".
 *   `-271821-04-20T00:00:00.000Z`  parses in JS (the extended ±YYYYYY form);
 *                                  Postgres raises "time zone displacement out
 *                                  of range".
 *
 * Either one turned `GET /v1/webhooks/:id/deliveries` into a 500 — the exact
 * outcome the header above says this file converts into a graceful first page.
 *
 * The lower bound is 1970 rather than year 1 because a cursor can only ever have
 * come from a row this system created, so anything before the epoch is
 * hand-crafted by definition. Postgres would accept years 1..1969 happily; they
 * are refused here because they cannot be legitimate, not because they break.
 */
const ISO_UTC_MS_RE = /^(\d{4})-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Decode a delivery cursor. A malformed/tampered created_at → null (first page,
 * matching the prior "invalid cursor → first page" contract). A missing or
 * malformed id tiebreaker → id:null (legacy created_at-only behaviour), never a
 * throw — so an old in-flight cursor keeps working after this ships.
 */
export function decodeDeliveryCursor(cursor: string | undefined): DeliveryCursor | null {
  if (cursor === undefined) return null;
  const sep = cursor.indexOf('_');
  const isoPart = sep === -1 ? cursor : cursor.slice(0, sep);
  const idPart = sep === -1 ? null : cursor.slice(sep + 1);
  const match = ISO_UTC_MS_RE.exec(isoPart);
  if (!match || Number(match[1]) < 1970) return null;
  const createdAt = new Date(isoPart);
  if (Number.isNaN(createdAt.getTime())) return null;
  const id = idPart !== null && UUID_RE.test(idPart) ? idPart : null;
  return { createdAt, id };
}
