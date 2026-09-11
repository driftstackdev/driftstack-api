// T-27 (drop 2 of 6) — the LIVE in-session QUIC signal, read off a session's
// capability report.
//
// The server exposes `h3_connection_observed` on `capability_report` on purpose
// (session-capability-report-store.ts: "the customer's honest answer to 'does
// my proxy actually carry HTTP/3'"), and the desktop dropped it: the report
// parser kept manual_input / streaming / egress and nothing else, so a session
// that had just carried HTTP/3 through the customer's proxy left the chip on
// that proxy at `~`. This module is the parser (pure, shared by the session
// control layer and the profile hub's list poll), the attribution of a session
// to the proxy it launched through, and the memory that keeps a LATCHED
// boolean from re-stamping a verdict on every poll.
//
// ⛔ Two facts about the signal shape everything below (W-29/W-30):
//   • `h3_connection_observed` is latched node-side — an insert-only set, it
//     can never return to false — so it answers "ever this session", not "now".
//     It is stamped ONCE per session, from the first report that carries it.
//   • `h3_connection_count` (projected to the customer report since (o) O2 —
//     nullable, absent from older servers) is monotone; its RATE is the liveness
//     the boolean lacks. When
//     present, an increase re-stamps; an unchanged count writes nothing.
//   An absent key means "leave today's behaviour alone"; a 0 is a measurement.

export interface H3Observation {
  /** The report's `timestamp` (server time), when parseable. */
  at?: number;
  /** `h3_connection_count` when the report carried one. */
  count?: number;
}

/**
 * The h3 observation a capability report carries, or null when it carries
 * none — an absent field, `null`, `false`, a count of 0 with no observed flag,
 * or a report that is not an object all read as "not observed".
 */
export function parseH3Observation(report: unknown): H3Observation | null {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return null;
  const r = report as Record<string, unknown>;
  const count = parseH3Count(report);
  const observed = r.h3_connection_observed === true || (count !== undefined && count > 0);
  if (!observed) return null;
  const at = typeof r.timestamp === 'string' ? Date.parse(r.timestamp) : Number.NaN;
  return {
    ...(Number.isFinite(at) ? { at } : {}),
    ...(count !== undefined ? { count } : {}),
  };
}

/**
 * The report's `h3_connection_count` when it carried a finite number — a ZERO
 * included. The store projects `frame.h3ConnectionCount ?? null` (never `?? 0`)
 * precisely so that a zero stays what the node measured ("this session has
 * carried no HTTP/3 connection yet") and an absent key stays "nothing measured";
 * this reader keeps both apart the same way. `undefined` for absent / null /
 * non-finite / a non-object report.
 */
export function parseH3Count(report: unknown): number | undefined {
  if (report === null || typeof report !== 'object' || Array.isArray(report)) return undefined;
  const v = (report as Record<string, unknown>).h3_connection_count;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

/**
 * (q) Item 11 residual — the three states the cockpit's HTTP/3 readout can be in.
 *
 *   'observed'     the latched flag is `true`, or a positive count crossed —
 *                  HTTP/3 was carried this session (the green verdict);
 *   'none-yet'     a MEASURED count of 0 without the flag — the node counted and
 *                  found no HTTP/3 connection so far. This is a measurement, not
 *                  an absence: the store's own contract (session-capability-
 *                  report-store.ts) says a zero is one, and `parseH3Observation`
 *                  deliberately returns null for it (a zero is not evidence that
 *                  the PROXY carries QUIC, so the ledger stamps nothing) — but
 *                  the READOUT must not fold it back into "not observed";
 *   'not-observed' the report carried neither — nothing in this repo can prove
 *                  the fork build is measuring, so this says "not observed",
 *                  never "measuring…" (the (o) O4 argument that renamed the OS
 *                  readout), and never "no HTTP/3".
 */
export type H3ReadoutState = 'observed' | 'none-yet' | 'not-observed';

export function h3ReadoutState(
  report: { h3_connection_observed?: true; h3_connection_count?: number } | null,
): H3ReadoutState {
  if (report === null) return 'not-observed';
  const count = report.h3_connection_count;
  if (report.h3_connection_observed === true || (count !== undefined && count > 0)) {
    return 'observed';
  }
  if (count === 0) return 'none-yet';
  return 'not-observed';
}

/** The slice of a profile binding the attribution needs. */
export interface H3BindingLike {
  profileId: string;
  defaultProxyId: string | null;
  currentSessionId: string | null;
}

/**
 * The proxy a live session launched through, by the SAME rule the launch used
 * to pick it (`ProfilesView.pickProxy`): the binding's explicit default when it
 * still exists, else the first saved proxy; an explicit default that has since
 * been deleted attributes to NOTHING rather than to a different exit. Null when
 * no binding names the session — a session started elsewhere is not this
 * install's evidence about any of its proxies.
 */
export function attributeSessionProxy(
  sessionId: string,
  bindings: ReadonlyArray<H3BindingLike>,
  proxies: ReadonlyArray<{ id: string }>,
): string | null {
  const binding = bindings.find((b) => b.currentSessionId === sessionId);
  if (binding === undefined) return null;
  if (binding.defaultProxyId !== null) {
    return proxies.some((p) => p.id === binding.defaultProxyId) ? binding.defaultProxyId : null;
  }
  return proxies[0]?.id ?? null;
}

export interface H3ObservationLedger {
  /** The stamp to write for this session's observation, or null when it has
   *  already been recorded and nothing moved since. */
  plan(sessionId: string, obs: H3Observation, nowMs: number): number | null;
  /** Remember that the planned write landed. Separate from `plan` so a write
   *  that found no cache entry to attach to is retried on the next poll. */
  commit(sessionId: string, obs: H3Observation): void;
}

/** Per-session memory of what has been stamped. One per process; the memory
 *  lives exactly as long as the polls that feed it. */
export function makeH3ObservationLedger(): H3ObservationLedger {
  // sessionId → the count at the last commit, or -1 when only the boolean was seen.
  const seen = new Map<string, number>();
  return {
    plan(sessionId, obs, nowMs) {
      const last = seen.get(sessionId);
      if (last === undefined) return obs.at ?? nowMs;
      // A rising count is the one signal that says "still carrying h3 NOW".
      if (obs.count !== undefined && obs.count > last) return obs.at ?? nowMs;
      return null;
    },
    commit(sessionId, obs) {
      seen.set(sessionId, obs.count ?? -1);
    },
  };
}
