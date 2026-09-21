// The closed customer vocabulary for `POST /v1/account/me/proxies/:id/test` —
// the query parameter that picks how the test is run, and the two reason-code
// enums the result carries (`os_fingerprint_unavailable`, `not_run`).
//
// ⛔ WHAT THIS FILE EXISTS TO CLOSE. The route computed its query parameter and
// both reason codes in plain internal words: the query was `?vantage=cp|fleet`
// (`cp` = "control plane", `fleet` = the Mac fleet that runs profiles — both
// names for our own infrastructure), `os_fingerprint_unavailable` could read
// `observer_off` (names our raw-socket observer), and `not_run` could read
// `no_node` / `node_busy` / `node_error` (all name "node", our word for a fleet
// Mac). None of the four says WHAT the customer gets; all four say HOW we built
// it. Same direction as `customer-safe-egress-warnings.ts` next door: a closed
// public vocabulary, mapped at read time, with the internal words kept for
// logs and for the one place that already reads them off the wire —
// `apps/gui-client/src/lib/proxy-vantage.ts` and
// `apps/gui-client/src/lib/account-proxies.ts` parse the ORIGINAL field names
// and values (`measured_from`, `single_host_vantage`, `web_port_vantage`)
// directly off this same response today, so THIS CHANGE IS ADDITIVE ONLY on
// every already-shipped field: nothing already on the wire is renamed or
// removed, and the new customer vocabulary rides beside it.
//
// ⛔ THE QUERY PARAMETER IS THE ONE EXCEPTION TO "MAPPED, NEVER ECHOED
// UNCHANGED". `?vantage=cp|fleet` is INPUT, not output: the old name and
// values are still accepted (nothing that already links to `?vantage=fleet`
// breaks), but only the new `?check=quick|full` is documented from here on,
// per the same "old accepted, new documented" shape the egress-warning file's
// STORAGE side uses (internal codes stored, public codes read out).
//
// ⚠️ THE TWO REASON-CODE ENUMS ARE NOT DEVICE-CONTROLLED STRINGS. Every value
// either enum can hold is produced by THIS repository's own code (the route,
// `classifyVpnProbeFailure`, `observeOs`), each already a closed TypeScript
// union. So unlike `safeguard_failed:<layer>` — 64 free characters a device
// chose — an "unmapped" value here can only mean this file's map and the
// route's union have drifted apart, which is a bug here, not hostile input
// from anywhere. The recorder below still exists (reusing the SAME bounded
// instance the egress-warning map uses, per the owner's instruction to notice
// a new value the moment it is first produced) — it is defence in depth, not
// a defence against a device.

import {
  createUnmappedEgressWarningRecorder,
  type EgressWarningLogger,
  type UnmappedEgressWarningRecorder,
} from './customer-safe-egress-warnings.js';

// ───────────────────────────────────────────────────────────────────────────
// The query parameter: ?check=quick|full, aliasing ?vantage=cp|fleet
// ───────────────────────────────────────────────────────────────────────────

/** The internal value this route has always branched on. Unchanged — this is
 *  what `runControlPlaneProbe` / `runFleetProbe` still key off. */
export type ProxyTestVantage = 'cp' | 'fleet';

/** The customer's word for each vantage: `quick` — a check Driftstack runs
 *  itself, right now. `full` — a check dispatched through the machine that
 *  will actually run your profile, the same path a real session takes.
 *  Published; the only names documented from here on. */
export type ProxyTestCheck = 'quick' | 'full';

/** `check` → `vantage`. The only place this correspondence is written down —
 *  the route, the OpenAPI document, and every guard read it from here. */
export const PUBLIC_PROXY_TEST_CHECK_TO_VANTAGE: Readonly<
  Record<ProxyTestCheck, ProxyTestVantage>
> = {
  quick: 'cp',
  full: 'fleet',
};

/** The reverse of the map above, for the route's OWN provenance fields
 *  (`measured_from`) — see `PUBLIC_PROXY_TEST_MEASURED_FROM` below. */
export const PROXY_TEST_VANTAGE_TO_PUBLIC_CHECK: Readonly<
  Record<ProxyTestVantage, ProxyTestCheck>
> = {
  cp: 'quick',
  fleet: 'full',
};

export const PUBLIC_PROXY_TEST_CHECK_VALUES: readonly ProxyTestCheck[] = ['quick', 'full'];

/** Legacy input values, still accepted — never documented again. */
const LEGACY_VANTAGE_VALUES: readonly ProxyTestVantage[] = ['cp', 'fleet'];

export interface ResolvedProxyTestVantage {
  readonly vantage: ProxyTestVantage;
}
export interface ProxyTestVantageQueryError {
  readonly error: string;
}

/**
 * Resolve the request's vantage from BOTH query parameters. `check` (the
 * documented one) wins when present and valid; `vantage` (the legacy one) is
 * read only when `check` is absent, so an old integration that only ever sent
 * `?vantage=fleet` keeps working byte-for-byte. Either name present with a
 * value outside its own closed set is a 400 — same posture the route already
 * had for `vantage` alone. Neither present defaults to `quick` / `cp`, exactly
 * today's default.
 */
export function resolveProxyTestVantage(
  query: Record<string, unknown>,
): ResolvedProxyTestVantage | ProxyTestVantageQueryError {
  const rawCheck = query['check'];
  if (rawCheck !== undefined) {
    if (typeof rawCheck === 'string' && isProxyTestCheck(rawCheck)) {
      return { vantage: PUBLIC_PROXY_TEST_CHECK_TO_VANTAGE[rawCheck] };
    }
    return { error: 'The `check` query parameter must be one of: quick, full.' };
  }
  const rawVantage = query['vantage'];
  if (rawVantage !== undefined) {
    if (typeof rawVantage === 'string' && isLegacyVantage(rawVantage)) {
      return { vantage: rawVantage };
    }
    return { error: 'The `vantage` query parameter must be one of: cp, fleet.' };
  }
  return { vantage: 'cp' };
}

function isProxyTestCheck(value: string): value is ProxyTestCheck {
  return (PUBLIC_PROXY_TEST_CHECK_VALUES as readonly string[]).includes(value);
}
function isLegacyVantage(value: string): value is ProxyTestVantage {
  return (LEGACY_VANTAGE_VALUES as readonly string[]).includes(value);
}

// ───────────────────────────────────────────────────────────────────────────
// The shared recorder — reused, not re-invented
// ───────────────────────────────────────────────────────────────────────────

/**
 * The SAME bounded per-process recorder shape `customer-safe-egress-warnings.ts`
 * exports — a fresh, independent instance (its own map, its own cap), so a
 * flood on one vocabulary cannot crowd out the other's log lines or its count.
 * Reusing the FACTORY rather than hand-rolling a second bounded map is the
 * point: one implementation of "count everything, log a new key once, fold
 * the rest into an overflow bucket past the cap" for every place this repo
 * needs it.
 */
export const unmappedProxyTestVocabulary: UnmappedEgressWarningRecorder =
  createUnmappedEgressWarningRecorder();

// ───────────────────────────────────────────────────────────────────────────
// os_fingerprint_unavailable
// ───────────────────────────────────────────────────────────────────────────

/**
 * Internal cause → the customer's word for it. All three are produced by THIS
 * route (`osFingerprintFields` / `vpnOsFingerprintFields` in
 * `routes/account-me.ts`) — never device input.
 *
 *   `vpn_tunnel`    → `not_available_for_vpn` — an OpenVPN/WireGuard proxy has
 *                      no single TCP endpoint of its own to read a stack from.
 *                      PERMANENT: no retry changes it.
 *   `not_observed`  → `not_captured` — the reading was attempted and produced
 *                      nothing this time. RETRYABLE: a later Test may succeed.
 *   `observer_off`  → `not_offered_here` — this deployment does not take this
 *                      reading at all. PERMANENT for this deployment.
 *
 * ⛔ CLOSED, AND CLOSED IS THE SAFETY PROPERTY, same as `PUBLIC_EGRESS_WARNINGS`
 * next door: the vocabulary parity guard
 * (`tests/unit/a-public-proxy-test-result-cannot-ship-undocumented.test.ts`)
 * fails until a new value here is documented in every place a customer reads
 * it.
 */
export const PUBLIC_OS_FINGERPRINT_UNAVAILABLE: Readonly<Record<string, string>> = {
  vpn_tunnel: 'not_available_for_vpn',
  not_observed: 'not_captured',
  observer_off: 'not_offered_here',
};

export const PUBLIC_OS_FINGERPRINT_UNAVAILABLE_CODES: readonly string[] = [
  ...new Set(Object.values(PUBLIC_OS_FINGERPRINT_UNAVAILABLE)),
].sort();

/**
 * Map an internal `os_fingerprint_unavailable` cause to the public one, or
 * `null` when the map and the route's own union have drifted (recorded, never
 * thrown — a response must still go out). A dropped cause is safe here: the
 * field is entirely optional and its absence already means "no cause
 * reported" per the field's own contract (see `AccountProxyOsFingerprintSchema`
 * doc comment) — never "a fingerprint is present".
 */
export function publicOsFingerprintUnavailable(
  internal: string,
  logger?: EgressWarningLogger,
): string | null {
  const mapped = Object.prototype.hasOwnProperty.call(PUBLIC_OS_FINGERPRINT_UNAVAILABLE, internal)
    ? PUBLIC_OS_FINGERPRINT_UNAVAILABLE[internal]
    : undefined;
  if (mapped !== undefined) return mapped;
  unmappedProxyTestVocabulary.record(
    [`os_fingerprint_unavailable:${safeVocabToken(internal)}`],
    logger,
  );
  return null;
}

// ───────────────────────────────────────────────────────────────────────────
// not_run
// ───────────────────────────────────────────────────────────────────────────

/**
 * Internal cause → the customer's word for it. Five internal causes fold to
 * three public ones — the same MERGING move `customer-safe-egress-warnings.ts`
 * makes for `safeguards_unreported` / `safeguards_expectation_unreported`:
 * `node_busy`, `node_error` and `no_node` are three different places OUR side
 * of a full check fell short, and a customer can do exactly one thing about
 * any of them — try again shortly, or contact support if it persists.
 *
 *   `live_session`   → `live_session` — unchanged. Already WHAT, not HOW: it
 *                       names a fact about the customer's own account (another
 *                       session is using this VPN), not a mechanism of ours.
 *   `unresolvable`   → `config_unresolvable` — reuses the EXACT word the
 *                       "Why a launch is refused" table already publishes for
 *                       the identical fact (a stored proxy configuration that
 *                       cannot be used, so nothing was dialled) — one word for
 *                       one fact across both surfaces, not two.
 *   `node_busy`      → `check_unavailable` — merged.
 *   `node_error`     → `check_unavailable` — merged.
 *   `no_node`        → `check_unavailable` — merged.
 *
 * ⛔ NEVER DROPPED. `not_run` is not a list a client reads item-by-item like
 * `warnings` — the docs tell a customer to branch on its PRESENCE before
 * treating `ok:false` as a verdict about their proxy at all. Omitting it on an
 * unmapped cause would misrepresent a check that did not run as a real failed
 * verdict, which is worse than publishing nothing: every unmapped cause still
 * lands on `check_unavailable`, the safest true statement available ("we could
 * not complete the check"), and is recorded so the drift is noticed.
 */
export const PUBLIC_PROXY_TEST_NOT_RUN: Readonly<Record<string, string>> = {
  live_session: 'live_session',
  unresolvable: 'config_unresolvable',
  node_busy: 'check_unavailable',
  node_error: 'check_unavailable',
  no_node: 'check_unavailable',
};

export const PUBLIC_PROXY_TEST_NOT_RUN_CODES: readonly string[] = [
  ...new Set(Object.values(PUBLIC_PROXY_TEST_NOT_RUN)),
].sort();

/** The fallback every unmapped `not_run` cause lands on — see "NEVER DROPPED"
 *  above. Exported so the guard and the route read the SAME constant rather
 *  than two copies of the string. */
export const PROXY_TEST_NOT_RUN_FALLBACK = 'check_unavailable';

export function publicProxyTestNotRun(internal: string, logger?: EgressWarningLogger): string {
  const mapped = Object.prototype.hasOwnProperty.call(PUBLIC_PROXY_TEST_NOT_RUN, internal)
    ? PUBLIC_PROXY_TEST_NOT_RUN[internal]
    : undefined;
  if (mapped !== undefined) return mapped;
  unmappedProxyTestVocabulary.record([`not_run:${safeVocabToken(internal)}`], logger);
  return PROXY_TEST_NOT_RUN_FALLBACK;
}

// ───────────────────────────────────────────────────────────────────────────
// A safe token for the recorder, for the same reason the file next door has
// one — this repo's own future code is still code a typo can touch.
// ───────────────────────────────────────────────────────────────────────────

const SAFE_VOCAB_TOKEN_RE = /^[a-z0-9_]{1,64}$/;

function safeVocabToken(value: string): string {
  return SAFE_VOCAB_TOKEN_RE.test(value) ? value : 'unprintable';
}

// ───────────────────────────────────────────────────────────────────────────
// single_host_vantage / web_port_vantage aliases
// ───────────────────────────────────────────────────────────────────────────

/**
 * `single_host_vantage` / `web_port_vantage` name "vantage" — the exact word
 * the customer-copy rule forbids — in the field name itself, not just in a
 * value. Unlike the two reason-code enums above, these are BOOLEANS with no
 * unmapped case to guard: the new fields are the SAME values under customer
 * names, added beside the originals (kept, unrenamed, for
 * `apps/gui-client`'s existing readers).
 *
 *   `single_host_vantage` → `direct_reading` — true only when the address we
 *   dialled, the address that answered, and the address your traffic exits
 *   from are one machine, so nothing sat between what we read and what a
 *   website would see.
 *   `web_port_vantage` → `website_like_reading` — true when the reading was
 *   taken the same way a real website connection is: a literal address on
 *   the standard secure-web port, not a name that could route to shared
 *   infrastructure.
 */
export const PUBLIC_OS_FINGERPRINT_VANTAGE_FIELDS = {
  single_host_vantage: 'direct_reading',
  web_port_vantage: 'website_like_reading',
} as const;
