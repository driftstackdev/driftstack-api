// Who acted: the acting key id of a request, as the two columns every table
// that records it now carries, and back again.
//
// A request is authenticated either by an API key or by a signed-in browser (a
// web session: the admin panel and the customer dashboard both sign in that
// way). `ctx.apiKey.id` is the key's own uuid for the first and the synthetic
// `wsk_<web session uuid>` for the second (services/auth.ts). Every table that
// records the acting key held it in a `uuid` column — most with a foreign key to
// `api_keys` — so a web session's id could not be written at all, and every
// action a signed-in browser took went unrecorded or failed outright (migration
// 0138 has the whole story).
//
// Each such table now has its `…_key_id` column (the `api_keys` row that acted)
// and a `…_web_session_id` sibling (the `web_sessions` row that acted, with no
// foreign key: an audit row outlives the session it names). This module is the
// ONE place that turns the acting id into those columns and back:
//
//   · a WRITER calls `actingKeyColumns(id)`. A bare uuid is a key; `wsk_<uuid>`
//     is a web session; anything else THROWS, before it can reach a column the
//     database would refuse it from — the in-memory test repositories call the
//     same function, so a fixture with a made-up id fails the way production
//     would instead of passing where production cannot;
//   · a READER calls `actingKeyIdFromColumns(keyId, webSessionId)` and gets back
//     the very string the auth context had, so no reader's type changes and a row
//     read back compares equal to `ctx.apiKey.id`;
//   · a PUBLISHED response that carries the acting key names it with
//     `publicActingKeyId`: `key_<uuid>` for a key, as it always has, and
//     `wsk_<uuid>` for a web session — never `key_wsk_<uuid>`, which would name
//     a key that does not exist.

/** The uuid's own 8-4-4-4-12 shape; a width alone would admit 36 dashes. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** What `services/auth.ts` puts before a web session's id in `ctx.apiKey.id`. */
export const WEB_SESSION_ACTING_KEY_PREFIX = 'wsk_';

/** The two actor columns of one row. At most one is set. */
export interface ActingKeyColumns {
  /** The `api_keys` row that acted, or null when a web session did. */
  readonly keyId: string | null;
  /** The `web_sessions` row that acted, or null when an API key did. */
  readonly webSessionId: string | null;
}

const NO_ACTOR: ActingKeyColumns = { keyId: null, webSessionId: null };

/**
 * The columns an acting key id is written to. Throws a RangeError for anything
 * that is neither a uuid nor `wsk_<uuid>` — that value would otherwise reach a
 * `uuid` column and fail there, after the change it records.
 */
export function actingKeyColumns(actingKeyId: string): ActingKeyColumns {
  if (typeof actingKeyId === 'string') {
    if (UUID_RE.test(actingKeyId)) return { keyId: actingKeyId.toLowerCase(), webSessionId: null };
    if (actingKeyId.startsWith(WEB_SESSION_ACTING_KEY_PREFIX)) {
      const session = actingKeyId.slice(WEB_SESSION_ACTING_KEY_PREFIX.length);
      if (UUID_RE.test(session)) return { keyId: null, webSessionId: session.toLowerCase() };
    }
  }
  throw new RangeError(
    `not an acting key id: ${JSON.stringify(actingKeyId)} is neither an API key id (a uuid) nor a web session's (wsk_<uuid>)`,
  );
}

/** As {@link actingKeyColumns}, for a column that may record no actor (a system write). */
export function optionalActingKeyColumns(actingKeyId: string | null | undefined): ActingKeyColumns {
  return actingKeyId === null || actingKeyId === undefined
    ? NO_ACTOR
    : actingKeyColumns(actingKeyId);
}

/**
 * The acting key id a row's two actor columns record — the string the auth
 * context had — or null when the row records no actor. Throws when both are set:
 * the database refuses that row, so reading one means something else is wrong.
 */
export function actingKeyIdFromColumns(
  keyId: string | null,
  webSessionId: string | null,
): string | null {
  if (keyId !== null && webSessionId !== null) {
    throw new RangeError('a row names both an API key and a web session as the one that acted');
  }
  if (webSessionId !== null) return `${WEB_SESSION_ACTING_KEY_PREFIX}${webSessionId}`;
  return keyId;
}

/** As {@link actingKeyIdFromColumns}, for a row that must name who acted. */
export function requiredActingKeyIdFromColumns(
  keyId: string | null,
  webSessionId: string | null,
): string {
  const acting = actingKeyIdFromColumns(keyId, webSessionId);
  if (acting === null) {
    throw new RangeError(
      'a row that must name who acted names neither an API key nor a web session',
    );
  }
  return acting;
}

/**
 * How a published response names the acting key: `key_<uuid>` for an API key
 * (its public id everywhere else in the API) and `wsk_<uuid>` for a web session.
 */
export function publicActingKeyId(actingKeyId: string): string {
  const { keyId, webSessionId } = actingKeyColumns(actingKeyId);
  return keyId !== null ? `key_${keyId}` : `${WEB_SESSION_ACTING_KEY_PREFIX}${webSessionId ?? ''}`;
}
