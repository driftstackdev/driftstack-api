// T-27 — the control plane's proxy test, from the FLEET vantage, and how its
// answer lands in the probe cache. ONE implementation for both proxy surfaces.
//
// ⛔ The Proxies grid did all of this inline (ProxiesView.handleTest) and the
// profile card's Test did none of it: it ran the native SOCKS5 probe plus the
// exit-geo probe and stopped, so a card Test could never populate the measured
// QUIC verdict or the fleet relay verdict — the chip stayed `~` no matter how
// many times the customer pressed it (owner #13, drop 1 of 6). Two copies of
// the same twelve-step flow are how the second one came to be missing; the
// flow now lives here and the views only apply the outcome to their state.
//
// The parse of the wire (`testAccountProxy`) and the persistence
// (`saveServerProbeResult`, `saveOsFingerprint`) are unchanged; this module is
// the decision between them, made once.

import {
  createProxy as createAccountProxy,
  deleteProxy as deleteAccountProxy,
  DESKTOP_CREDENTIAL_FLEET_TEST_REASON,
  isDesktopCredentialRefusalDetail,
  isTierRefusalDetail,
  listProxies as listAccountProxies,
  testAccountProxy,
  updateProxy as updateAccountProxy,
  type AccountProxyExitObserved,
  type AccountProxyInput,
  type AccountProxyMeta,
  type AccountProxyScheme,
  type AccountProxyTestNotRun,
  type AccountProxyTestResult,
  type MeasuredQuic,
} from './account-proxies';
import { openvpnAutoStrip } from './openvpn-refusal';
import type { OsFingerprint } from './os-fingerprint-verdict';
import {
  DESKTOP_CREDENTIAL_NEXT_STEP,
  MISSING_API_KEY_NEXT_STEP,
  VPN_PLAN_EXCLUDED_CHECK_NOTICE,
  VPN_PLAN_EXCLUDED_TALLY_REASON,
  VPN_STORE_FAILED_TALLY_REASON,
} from './proxy-check-copy';
import {
  isProxyUsable,
  resolveEndpoint,
  setProxyServerId,
  updateProxy as updateLocalProxy,
  type ProxyConfig,
} from './proxies';
import { isSocks5Probeable, isVpnScheme } from './proxy-scheme';
import {
  clearFleetFailure,
  deriveProbeViewState,
  isQuicVerdictFresh,
  loadProbeCache,
  saveEndpointResult,
  saveExitResult,
  saveFleetFailure,
  saveOsFingerprint,
  saveServerProbeResult,
  type CachedEndpointVerdict,
  type CachedProbe,
  type ProbeCacheMap,
  type ProbeViewState,
} from './proxy-probe-cache';
import { cleanServerVantage, type ServerVantage } from './proxy-vantage';

export type ServerProbeOutcome =
  | {
      kind: 'ok';
      /** When THIS test ran (local clock) — the stamp for everything except the
       *  QUIC verdict, which carries the server's own time (see below). */
      at: number;
      /** T-1 — `null` is a real fleet answer: reached, no timing. The views clear
       *  the stored number on it rather than leaving a stale one beside a fresh
       *  vantage label. */
      latencyMs: number | null;
      quicMeasured?: MeasuredQuic;
      /** T-27 drop 5 — the server's `quic_measured_at` when it sent one, else `at`. */
      quicMeasuredAt?: number;
      vantage?: ServerVantage;
      quicProbe?: boolean;
      osFingerprint?: OsFingerprint;
      /** VPN exit parity (b) — the exit the fleet Mac observed through the
       *  proxy/tunnel, when the reply carried one. Persisted as the row's exit
       *  identity (the same cache fields the native exit probe writes for a
       *  SOCKS5 row), which is the only way a VPN row can ever get one. */
      exitObserved?: AccountProxyExitObserved;
    }
  | {
      /** The server says the proxy is NOT usable from where it measured. The
       *  views drop every server-measured value they hold for the row. */
      kind: 'failed';
      at: number;
      reason: string;
      vantage?: ServerVantage;
    }
  | {
      /** (d) — NOTHING RAN: the control plane refused a VPN test because a live
       *  session holds the tunnel (`live_session`), or the fleet node could not
       *  run the probe (`node_busy` / `node_error`). Not a verdict either way:
       *  the views keep what they hold, show `reason` as a notice (never the red
       *  "tunnel down"), and a sweep counts the row as skipped, not as a tunnel
       *  that is not up. `exitObserved` rides on the live-session refusal — the
       *  exit that session sees — and is adopted like a measured one. */
      kind: 'not_run';
      at: number;
      why: AccountProxyTestNotRun;
      reason: string;
      vantage?: ServerVantage;
      exitObserved?: AccountProxyExitObserved;
    }
  | {
      /** No server answer at all (network, auth, malformed) — the views keep
       *  what they have; nothing here is evidence either way. */
      kind: 'unavailable';
    };

/** (i) I5 — the notice both surfaces show for an `unavailable` outcome. It is
 *  NOT a verdict: the last fleet verdict (the cache's failure sentence, or the
 *  row's measured fields) stands beside it, and it goes when the next check
 *  starts, like every other notice. */
export const SERVER_DID_NOT_ANSWER_NOTICE =
  'The server did not answer, so the tunnel was not tested. The last result stands — try again.';

/** (j) J3 — the I5 notice when the pre-flight resolved the endpoint to a
 *  DIFFERENT address than the last check's: that cache write already dropped
 *  the fleet verdict (`saveEndpointResult` carries it over only for the SAME
 *  address — nothing measured through the old address describes the new one),
 *  so "the last verdict stands" would be false: there is none. Shared by the
 *  grid and the profile card, which run the same pre-flight → fleet sequence
 *  and must say the same thing about the same cache. */
export const ENDPOINT_MOVED_NO_VERDICT_NOTICE =
  'The server did not answer, so the tunnel was not tested. Endpoint moved; no result yet — try again.';

/** (k) K2 — the I5 notice for a row that has NO verdict to stand: no cache
 *  entry before this check, a prior pre-flight that did not resolve (its write
 *  carried nothing), or a resolved entry the fleet never answered with a
 *  verdict (a busy node, a refusal, a row nobody tested). "The last verdict
 *  stands" was false on every one of them — there was none — and it read as
 *  if the row's "endpoint ok" pill were a tunnel verdict. */
// (l) #11 — "result", never the internal "verdict", in every customer sentence.
export const NO_VERDICT_YET_NOTICE = 'The server did not answer; no result yet — try again.';

/** (k) K2 — whether an entry holds a fleet VERDICT about the tunnel: the
 *  cache's failure sentence, or a server-measured field the row shows (a
 *  fleet latency / vantage, an observed exit). The pre-flight verdict
 *  (`endpoint.resolved`) is not one — "endpoint ok" says the name resolves,
 *  not that the tunnel came up. */
export function holdsFleetVerdict(entry: CachedProbe | undefined): boolean {
  return (
    entry !== undefined &&
    (entry.fleetFailureReason !== undefined ||
      entry.serverProbeAt !== undefined ||
      entry.serverLatencyMs !== undefined ||
      entry.measuredFrom !== undefined)
  );
}

/**
 * (k) K2 — the ONE pick of the `unavailable` notice, for the grid and the
 * card alike, from what the row holds AFTER its pre-flight write:
 *   * the pre-flight resolved a DIFFERENT address → the write dropped the
 *     verdict (J3): "Endpoint moved; no verdict yet";
 *   * the entry before the write held no fleet verdict, or its pre-flight had
 *     not resolved (so the write carried nothing over) → "no verdict yet";
 *   * otherwise the write carried the verdict over, and it stands.
 * `prior` is the entry as it was BEFORE the pre-flight write — the write's
 * carry rule is deterministic (same resolved address → every server field
 * survives), so the prior decides exactly what the row shows beside the
 * notice.
 */
export function unansweredCheckNotice(
  prior: CachedProbe | undefined,
  endpointMoved: boolean,
): string {
  if (endpointMoved) return ENDPOINT_MOVED_NO_VERDICT_NOTICE;
  if (prior?.endpoint?.resolved !== true || !holdsFleetVerdict(prior)) {
    return NO_VERDICT_YET_NOTICE;
  }
  return SERVER_DID_NOT_ANSWER_NOTICE;
}

/**
 * T-27 drop 5 — the stamp a measured QUIC verdict carries.
 *
 * ⛔ Both surfaces stamped `Date.now()` at the moment the /test reply arrived,
 * while the server's `quic_measured_at` — parsed on the wire since T-6 and read
 * by nothing — says when the live session actually observed HTTP/3. Stamping
 * the reply time made a verdict from a session weeks ago look freshly measured
 * on every Test, and the W-30 expiry then aged a time that never happened. The
 * server's clock wins when it sent a parseable one; the reply time is only the
 * fallback for a server that measured but did not say when.
 */
export function quicVerdictStamp(serverAt: string | null | undefined, now: number): number {
  if (typeof serverAt === 'string') {
    const parsed = Date.parse(serverAt);
    if (Number.isFinite(parsed)) return parsed;
  }
  return now;
}

/** Translate the wire result into the outcome both views apply. Pure. */
export function serverProbeOutcome(
  test: AccountProxyTestResult | null,
  now: number,
): ServerProbeOutcome {
  if (test === null) return { kind: 'unavailable' };
  if (!test.ok) {
    const vantage = cleanServerVantage(test.measured_from, undefined);
    // (d) — the discriminator, never the prose: a refusal / could-not-run is
    // its own outcome so no consumer can mistake it for a failed tunnel.
    if (test.not_run !== undefined) {
      return {
        kind: 'not_run',
        at: now,
        why: test.not_run,
        reason: test.reason,
        ...(vantage ? { vantage } : {}),
        ...(test.exit_observed !== undefined ? { exitObserved: test.exit_observed } : {}),
      };
    }
    return { kind: 'failed', at: now, reason: test.reason, ...(vantage ? { vantage } : {}) };
  }
  // T-6 — a value outside the closed set is dropped, never rendered green.
  const quic =
    test.quic_measured === 'h3' || test.quic_measured === 'h2-only'
      ? test.quic_measured
      : undefined;
  // T-1 — the vantage is a closed set; the node id survives only beside 'fleet'.
  const vantage = cleanServerVantage(test.measured_from, test.node_id);
  return {
    kind: 'ok',
    at: now,
    latencyMs: test.latency_ms,
    ...(quic !== undefined
      ? { quicMeasured: quic, quicMeasuredAt: quicVerdictStamp(test.quic_measured_at, now) }
      : {}),
    ...(vantage !== undefined ? { vantage } : {}),
    ...(typeof test.quic_probe === 'boolean' ? { quicProbe: test.quic_probe } : {}),
    ...(test.os_fingerprint !== undefined ? { osFingerprint: test.os_fingerprint } : {}),
    ...(test.exit_observed !== undefined ? { exitObserved: test.exit_observed } : {}),
  };
}

/** Ask the control plane to test the proxy from the Mac that runs the profile
 *  (T-1 — `vantage: 'fleet'`). Never throws: a failed request is `unavailable`. */
export async function testProxyOnServer(
  baseUrl: string,
  apiKey: string,
  serverId: string,
  now: () => number = () => Date.now(),
): Promise<ServerProbeOutcome> {
  const test = await testAccountProxy(baseUrl, apiKey, serverId, { vantage: 'fleet' }).catch(
    () => null,
  );
  return serverProbeOutcome(test, now());
}

/**
 * Persist an `ok` outcome onto the proxy's cache entry. `unavailable` writes
 * nothing — nothing was learned. (d) A `not_run` outcome writes no measurement
 * either (there is none), but the live-session refusal's observed exit IS
 * adopted when the caller asks (`adoptExit`, VPN rows) — it is the exit the row
 * has right now, seen by the session that holds the tunnel.
 *
 * `failed`: for a SOCKS5 caller (no `adoptExit`) it writes nothing — the native
 * probe's entry stands and the view drops what it holds. (h) For a VPN caller
 * the fleet IS the row's verdict, and the entry still carries the PREVIOUS
 * successful fleet fields (the pre-flight carried them over seconds earlier),
 * so a failure that wrote nothing was re-hydrated onto the grid by the next
 * cache emit from any writer: a fleet-labelled latency, an exit and a relay
 * chip beside "tunnel down". `saveFleetFailure` drops them and marks the exit
 * superseded, which the list adoption respects. Returns the cache after the
 * last successful write, or null when nothing was written.
 */
export async function persistServerProbe(
  proxyId: string,
  outcome: ServerProbeOutcome,
  opts: { adoptExit?: boolean } = {},
): Promise<ProbeCacheMap | null> {
  if (outcome.kind === 'failed') {
    if (opts.adoptExit !== true) return null;
    // (h) finding 3 — the sentence is persisted with the stamp, so the card and
    // a remounted grid render the same verdict the view that ran the check did.
    return saveFleetFailure(proxyId, outcome.at, outcome.reason).catch(() => null);
  }
  if (outcome.kind === 'not_run') {
    if (opts.adoptExit !== true || outcome.exitObserved === undefined) return null;
    let cache: ProbeCacheMap;
    try {
      cache = await loadProbeCache();
    } catch {
      return null;
    }
    const existing = cache[proxyId];
    if (existing === undefined) return null; // nothing to attach it to; none invented
    // ⛔ (h) finding 1 — the exit on a refusal is the server's STORED one (what
    // a session saw at `observed_at`), not something this reply measured, so it
    // is dated by the OBSERVATION and passes the same never-rewind /
    // never-resurrect / never-churn / never-downgrade rule the account-list
    // adoption applies to the very same datum. Dating it at the reply time
    // walked it straight past a fleet failure's superseded stamp: a `no_node`
    // seconds after "tunnel down" put the contradicted exit back, stamped
    // fresh enough for the launch to hand its timezone to the next session.
    const at = storedExitStamp(outcome.exitObserved.observed_at, existing, outcome.at);
    if (at === undefined || refusesStoredExit(existing, outcome.exitObserved, at)) return null;
    return adoptObservedExit(proxyId, existing, outcome.exitObserved, at);
  }
  if (outcome.kind !== 'ok') return null;
  let latest: ProbeCacheMap | null = null;
  if (outcome.osFingerprint !== undefined) {
    latest = await saveOsFingerprint(proxyId, outcome.osFingerprint, outcome.at).catch(() => null);
  }
  const next = await saveServerProbeResult(
    proxyId,
    {
      // null CLEARS the persisted number — without this the card would reload
      // the stale one on next launch, after the in-memory drop.
      latencyMs: outcome.latencyMs,
      quicMeasured: outcome.quicMeasured,
      quicMeasuredAt: outcome.quicMeasuredAt,
      measuredFrom: outcome.vantage?.measuredFrom,
      nodeId: outcome.vantage?.nodeId,
      quicProbe: outcome.quicProbe,
    },
    outcome.at,
  ).catch(() => null);
  // VPN exit parity (b) — the fleet-observed exit lands in the SAME cache fields
  // the native exit probe writes for a SOCKS5 row (exitIp/exitCountry/geo +
  // exitAt), so every reader of an exit identity — the grid, the card, the
  // launch's device-clock timezone — sees a VPN row's exit exactly as it sees a
  // SOCKS5 row's. Stamped with THIS test's time, like the native probe stamps
  // its own. Best-effort like the writes above; the server-probe write stands
  // when this one fails.
  // ⛔ Only when the caller asks (VPN rows). A SOCKS5 row's exit is measured
  // NATIVELY from this Mac (lumtest geo + ASN); the server's exit_observed for
  // it carries no geo until every node emits the exit_* keys, and writing it
  // here overwrote real geo with nulls and refreshed exitAt, so the launch
  // handed the device clock a null timezone. And never DOWNGRADE: a server
  // observation with no geo does not replace an entry that already has geo
  // for the same ip.
  let withExit: ProbeCacheMap | null = null;
  if (opts.adoptExit === true && outcome.exitObserved !== undefined) {
    withExit = await adoptObservedExit(
      proxyId,
      (next ?? latest)?.[proxyId],
      outcome.exitObserved,
      outcome.at,
    );
  }
  return withExit ?? next ?? latest;
}

/** The ONE write of a server-observed exit from a /test reply (measured or
 *  refused): never a downgrade, ASN kept for the same ip. Best-effort — null
 *  when nothing was written. */
async function adoptObservedExit(
  proxyId: string,
  existing: CachedProbe | undefined,
  e: AccountProxyExitObserved,
  at: number,
): Promise<ProbeCacheMap | null> {
  if (isExitDowngrade(existing, e)) return null;
  const sameIp = existing?.exitIp === e.ip;
  return saveExitResult(
    proxyId,
    e.ip,
    e.country,
    {
      city: e.city,
      region: e.region,
      timezone: e.timezone,
      asnOrg: sameIp ? (existing?.exitAsnOrg ?? null) : null,
    },
    at,
  ).catch(() => null);
}

/**
 * The ONE never-downgrade rule for a server-observed exit: an observation with
 * no geo does not replace an entry that already has geo for the same ip. Shared
 * by the fleet-test adoption above and the list adoption below, so the two
 * cannot drift.
 */
function isExitDowngrade(
  existing: CachedProbe | undefined,
  incoming: { ip: string; country: string | null; timezone: string | null },
): boolean {
  if (existing === undefined || existing.exitIp !== incoming.ip) return false;
  const incomingHasGeo = incoming.country !== null || incoming.timezone !== null;
  const existingHasGeo =
    (existing.exitCountry ?? null) !== null || (existing.exitTimezone ?? null) !== null;
  return !incomingHasGeo && existingHasGeo;
}

/**
 * (h) finding 1 — the stamp a STORED exit (the account list's `exit_observed`,
 * or the one a `not_run` reply attaches) is adopted under: the observation's
 * own date when the wire carries a parseable one. An UNDATED observation used
 * to be stamped "now" — which is exactly what walks it past a fleet failure's
 * superseded stamp, so while that stamp stands an undated observation cannot
 * be shown to postdate the failure and is refused (`undefined`); with no
 * stamp it is "now", as before. ONE rule for both paths, so the same datum
 * cannot be refused by one and adopted by the other.
 */
function storedExitStamp(
  observedAt: string | null | undefined,
  existing: CachedProbe | undefined,
  nowMs: number,
): number | undefined {
  const parsed = typeof observedAt === 'string' ? Date.parse(observedAt) : Number.NaN;
  if (Number.isFinite(parsed)) return parsed;
  if (existing?.exitSupersededAt !== undefined) return undefined;
  return nowMs;
}

/**
 * The ONE refusal rule for adopting a stored exit onto an existing entry, at
 * `at` (from `storedExitStamp`). Shared by the `not_run` adoption and the
 * account-list adoption — two paths, one decision.
 */
function refusesStoredExit(
  existing: CachedProbe,
  e: { ip: string; country: string | null; timezone: string | null },
  at: number,
  /** (i) I7 — the SERVER's contradiction stamp for this row (the list's
   *  `exit_superseded_at`), when the caller has one. A Mac with no local stamp
   *  (it never ran the failing test) refuses by this one instead. */
  serverSupersededAt?: number,
): boolean {
  const sameIp = existing.exitIp === e.ip;
  // ⛔ Never REWIND, regardless of ip or geo: an observation OLDER than the
  // exit already stored describes an earlier state of the tunnel, and the
  // stored one (a fleet test's, or a fresher session's) already superseded
  // it. The old rule only refused a rewind of the SAME ip/geo, so a list row
  // still carrying last week's exit could overwrite the exit a fleet test
  // measured minutes ago whenever the two ips differed.
  const rewind = existing.exitAt !== undefined && at < existing.exitAt;
  // (h) — …and never RESURRECT: a fleet test that could not bring the tunnel
  // up dropped this row's exit and stamped when; the list (and the server's
  // stored exit on a refusal) still carries the session exit from BEFORE that
  // failure, and an observation dated at or before the stamp is the exit the
  // fleet just contradicted. (The write refuses it too; this keeps the row
  // out of `written` and the in-memory view honest.)
  const superseded =
    (existing.exitSupersededAt !== undefined && at <= existing.exitSupersededAt) ||
    (serverSupersededAt !== undefined && at <= serverSupersededAt);
  // …and never CHURN: the same identity at the same (or an older) stamp is
  // a no-op, so a 15s poll does not rewrite the store every tick.
  const unchanged =
    sameIp &&
    (existing.exitCountry ?? null) === e.country &&
    (existing.exitTimezone ?? null) === e.timezone &&
    existing.exitAt !== undefined &&
    existing.exitAt >= at;
  return rewind || superseded || unchanged || isExitDowngrade(existing, e);
}

/** The slice of a list row the adoption reads: the row, its stored exit, and
 *  (i) I7 — when a fleet verdict contradicted that exit, if ever. */
export type ListExitRow = Pick<AccountProxyMeta, 'id' | 'exit_observed' | 'exit_superseded_at'>;

/** (i) I7 — the sentence a Mac that never ran the failing test shows for a
 *  tunnel the list says a fleet check found down. Names no cause — the list
 *  carries the contradiction's date, not the node's reason. */
export const LIST_TUNNEL_DOWN_REASON = 'The last fleet check could not bring this tunnel up.';

/** The list's `exit_superseded_at`, as a time — or undefined when the row was
 *  never contradicted, the server predates the field, or the value is not a
 *  date (a malformed stamp refuses nothing). */
function listSupersededStamp(raw: string | null | undefined): number | undefined {
  if (typeof raw !== 'string') return undefined;
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Whether an entry holds a server-measured field dated AFTER `t` — an exit or
 *  a fleet probe this Mac saw later than the contradiction the list reports. */
function holdsMeasurementAfter(existing: CachedProbe, t: number): boolean {
  return (
    (existing.exitAt !== undefined && existing.exitAt > t) ||
    (existing.serverProbeAt !== undefined && existing.serverProbeAt > t)
  );
}

/** The slice of a local proxy the list adoption reads: which server row it is,
 *  whether it is a tunnel, and the endpoint its pre-flight resolves. */
export interface ListExitProxyLike {
  id: string;
  serverId?: string;
  scheme?: AccountProxyScheme;
  host: string;
  port: number;
}

/**
 * D2 — adopt the exit the SERVER last observed through each VPN proxy (from the
 * account proxy list's `exit_observed`) into the same cache fields the fleet
 * test and the native exit probe write, so a VPN row shows its exit — and the
 * launch's device-clock timezone reads it — without anyone pressing Test. A
 * live session through a tunnel is the ONLY exit identity that row can have
 * between tests; this is how it reaches the cards.
 *
 * ⛔ VPN rows ONLY. A SOCKS5 row's exit is measured NATIVELY from this Mac
 * (lumtest geo + ASN); the server's observation for it is at best a duplicate
 * and at worst geo-less, and writing it would overwrite real geo with nulls
 * (the same rule persistServerProbe's `adoptExit` enforces). Never DOWNGRADE
 * (same rule as above), and never REWIND: an observation whose `observed_at`
 * is OLDER than the exit already stored writes nothing — regardless of
 * whether the ip or geo differ (a fleet test measured minutes ago outranks a
 * list row still carrying last week's session exit) — and the same identity
 * at the same stamp writes nothing either, so a 15s poll does not rewrite the
 * store every tick. Best-effort per proxy; returns the proxy ids written, for
 * the guard.
 *
 * ⛔ A VPN row with NO cache entry on THIS Mac (a second Mac, a fresh install —
 * the very case a session-observed exit exists for) is not skipped: the exit
 * write rides on an entry (saveExitResult invents none, and the endpoint-row
 * overlay shows an exit only beside a RESOLVED pre-flight), so the row's
 * endpoint pre-flight — the same DNS resolve Test runs first — is run once
 * here and stored as its honest verdict, and the exit lands on top of it.
 * Nothing is fabricated: an endpoint that does not resolve stores as
 * unresolved (the exit is written but stays hidden, exactly as after a Test),
 * and once an entry exists no resolve runs again. Only for a row that HAS an
 * observation to adopt, so a SOCKS5-only or never-observed pool costs no
 * lookup.
 */
export async function adoptListExitObserved(
  rows: ReadonlyArray<ListExitRow>,
  proxies: ReadonlyArray<ListExitProxyLike>,
  /** The clock for an undated observation — and (k) K3 — the time the list
   *  was FETCHED, or earlier: the list is a snapshot from no later than this,
   *  so a local stamp at or after it postdates everything the list says.
   *  `syncListExitObserved` takes it before the request; a caller handing in
   *  a list it fetched earlier must pass that earlier time, not "now". */
  nowMs: number = Date.now(),
): Promise<string[]> {
  const written: string[] = [];
  const byServerId = new Map<string, ListExitRow>();
  for (const r of rows) byServerId.set(r.id, r);
  let cache: ProbeCacheMap;
  try {
    cache = await loadProbeCache();
  } catch {
    return written;
  }
  for (const p of proxies) {
    if (p.serverId === undefined || !isVpnScheme(p.scheme)) continue;
    const row = byServerId.get(p.serverId);
    if (row === undefined) continue;
    let existing = cache[p.id];
    // (k) K3 — the server's EXPLICIT clear reaches this Mac. The list carries
    // `exit_superseded_at: null` (the key present, the value the literal null
    // — an absent key is an older server and says nothing) beside an entry
    // that still holds a stamp: a later fleet verdict found the tunnel UP and
    // the server spent the contradiction. Until now only an ADOPTABLE exit
    // dated after the stamp could lift the sentence here, so a clear whose
    // exit this Mac refuses (the server kept its stored geo and re-dated
    // nothing) left "tunnel down" standing on every Mac but the one that ran
    // the UP test. Guarded by the fetch: a list fetched at `nowMs` is a
    // snapshot from no later than that, so a stamp this Mac wrote at or after
    // it (its own failing test landed while the poll was in flight) is not
    // something the list could know about, and is kept. Runs before the
    // observation gate below so a row whose exit this Mac then refuses is
    // still cleared, and before the adoption so the exit it carries is dated
    // against no stamp.
    // (k) review — a null stamp alone is NOT evidence: a row the server never
    // stamped (or whose stamp write failed) lists null too, and honouring it
    // erased this Mac's own fresh failure on the next poll. Clear only beside
    // POSITIVE evidence: an observation the server dated AFTER the local stamp
    // (the tunnel was seen up since). The lock re-checks against that stamp.
    const stampMs = existing?.exitSupersededAt;
    const seenUpAt =
      row.exit_observed !== null &&
      row.exit_observed !== undefined &&
      row.exit_observed.observed_at !== null
        ? Date.parse(row.exit_observed.observed_at)
        : Number.NaN;
    if (
      existing !== undefined &&
      stampMs !== undefined &&
      row.exit_superseded_at === null &&
      Number.isFinite(seenUpAt) &&
      seenUpAt > stampMs
    ) {
      try {
        cache = await clearFleetFailure(p.id, stampMs);
        existing = cache[p.id] ?? existing;
      } catch {
        /* best-effort — the next poll carries the same null */
      }
    }
    const e = row.exit_observed;
    if (e === null || e === undefined) continue;
    const serverSupersededAt = listSupersededStamp(row.exit_superseded_at);
    if (existing === undefined) {
      try {
        const r = await resolveEndpoint(p.host, p.port);
        // Re-read: a Test that completed while the resolve ran already wrote a
        // fuller entry (pre-flight + fleet fields), which this must not replace.
        cache = await loadProbeCache();
        if (cache[p.id] === undefined) {
          cache = await saveEndpointResult(
            p.id,
            { resolved: r.resolved, ip: r.ip, message: r.message },
            nowMs,
          );
        }
        existing = cache[p.id];
      } catch {
        /* best-effort — the next refresh retries; no entry is invented */
      }
      if (existing === undefined) continue;
    }
    // (i) I7 — the server's contradiction reaches THIS Mac: when the list
    // says a fleet verdict found the tunnel down at T and this entry holds no
    // stamp at or after T — and nothing it holds was measured AFTER T (a later
    // successful test here outranks a list poll that has not caught up) — the
    // entry is stamped exactly as the Mac that ran the failing test stamped
    // its own: every server-measured field goes, the exit is superseded at T,
    // and the write path's own guard now agrees with this refusal. The
    // sentence is the one this entry already holds, else a plain one — the
    // list carries the date of the contradiction, not the node's prose.
    // Idempotent: once stamped at T the next poll matches nothing here.
    if (
      serverSupersededAt !== undefined &&
      (existing.exitSupersededAt === undefined || existing.exitSupersededAt < serverSupersededAt) &&
      !holdsMeasurementAfter(existing, serverSupersededAt)
    ) {
      try {
        cache = await saveFleetFailure(
          p.id,
          serverSupersededAt,
          existing.fleetFailureReason ?? LIST_TUNNEL_DOWN_REASON,
        );
        existing = cache[p.id] ?? existing;
      } catch {
        /* best-effort — the refusal below still holds by the server's stamp */
      }
    }
    // (h) — dated by the observation, and the shared refusal rule (rewind /
    // resurrect / churn / downgrade) decides — see `refusesStoredExit`.
    const at = storedExitStamp(e.observed_at, existing, nowMs);
    if (at === undefined || refusesStoredExit(existing, e, at, serverSupersededAt)) continue;
    const sameIp = existing.exitIp === e.ip;
    try {
      cache = await saveExitResult(
        p.id,
        e.ip,
        e.country,
        {
          // The list carries no city/region/ASN: for the SAME ip the fleet
          // test's resolution of them still describes this exit; a new ip
          // starts clean rather than wearing the old ip's city.
          city: sameIp ? (existing.exitCity ?? null) : null,
          region: sameIp ? (existing.exitRegion ?? null) : null,
          timezone: e.timezone,
          asnOrg: sameIp ? (existing.exitAsnOrg ?? null) : null,
        },
        at,
      );
      written.push(p.id);
    } catch {
      /* best-effort — the next refresh retries */
    }
  }
  return written;
}

/**
 * D2 — fetch the account proxy list and adopt its observed exits (above). The
 * views call this fire-and-forget from their refresh; it is `async` so every
 * failure — offline, a 5xx, a mocked-away transport — is a rejection the caller
 * swallows, never a throw inside the refresh that would read as "couldn't load
 * proxies". Skips the request entirely when no local VPN proxy is synced to the
 * server: there would be nothing to adopt, and a SOCKS5-only account should not
 * pay a list round-trip per poll for it.
 */
export async function syncListExitObserved(
  baseUrl: string,
  apiKey: string | null,
  proxies: ReadonlyArray<ListExitProxyLike>,
  nowMs: number = Date.now(),
): Promise<string[]> {
  if (apiKey === null || apiKey.length === 0) return [];
  if (!proxies.some((p) => p.serverId !== undefined && isVpnScheme(p.scheme))) return [];
  // `nowMs` is taken BEFORE the request (the default binds at the call), so
  // the adoption's K3 guard compares a local stamp with the fetch's start.
  const rows = await listAccountProxies(baseUrl, apiKey);
  return adoptListExitObserved(rows, proxies, nowMs);
}

/**
 * VPN exit parity (b) — whether a cache entry's SERVER-measured fields (fleet
 * latency + vantage, the observed exit, the OS fingerprint, the QUIC-relay
 * verdict) describe a proxy the fleet found usable, and so may be shown.
 *
 * A SOCKS5 row: its native verdict decides, as it always has (no fleet number
 * beside a red "unreachable" pill). An endpoint row (OpenVPN/WireGuard): its
 * `result` is the fail-closed placeholder and is NEVER usable — by design, so
 * nothing reads it as a SOCKS5 pass — which also hid every server field the
 * fleet probe wrote for it. The honest predicate for that row is the endpoint
 * verdict itself: `saveEndpointResult` drops every server field on each
 * pre-flight, so a server field on a resolved endpoint row can only have come
 * from the fleet probe that followed THAT pre-flight.
 */
export function serverVerdictUsable(entry: CachedProbe): boolean {
  if (entry.endpoint !== undefined) return entry.endpoint.resolved;
  return isProxyUsable(entry.result);
}

/**
 * The derived probe view with the fleet-measured fields of resolved ENDPOINT
 * rows overlaid. `deriveProbeViewState` gates every server field on
 * `isProxyUsable(result)`, which a VPN row's placeholder never satisfies; this
 * applies `serverVerdictUsable` for those rows and leaves SOCKS5 rows exactly as
 * derived (the vacuity: a cache with no endpoint rows comes back unchanged). Both
 * proxy surfaces read THIS, so the rule cannot drift between them.
 *
 * The placeholder `result` of an endpoint row is also dropped from `testResults`
 * — it is not a SOCKS5 verdict and must not count as a tested-but-unhealthy
 * proxy anywhere; the row's health is `endpointResults` (the pre-flight) plus the
 * server fields.
 */
export function deriveProbeViewWithEndpointRows(
  cache: ProbeCacheMap,
  nowMs: number = Date.now(),
): ProbeViewState & { endpointResults: Record<string, CachedEndpointVerdict> } {
  const view = deriveProbeViewState(cache, nowMs);
  const endpointResults: Record<string, CachedEndpointVerdict> = {};
  for (const [id, c] of Object.entries(cache)) {
    if (c.endpoint === undefined) continue;
    endpointResults[id] = c.endpoint;
    delete view.testResults[id];
    if (!serverVerdictUsable(c)) continue;
    if (c.osFingerprint !== undefined) view.osFingerprints[id] = c.osFingerprint;
    if (c.serverLatencyMs !== undefined) view.serverLatency[id] = c.serverLatencyMs;
    if (c.quicMeasured !== undefined && isQuicVerdictFresh(c.quicMeasuredAt, nowMs))
      view.quicMeasured[id] = c.quicMeasured;
    if (c.measuredFrom !== undefined)
      view.serverVantage[id] = {
        measuredFrom: c.measuredFrom,
        ...(c.nodeId !== undefined ? { nodeId: c.nodeId } : {}),
      };
    if (c.quicProbe !== undefined) view.quicProbe[id] = c.quicProbe;
    if (c.exitIp !== undefined)
      view.exitResults[id] = {
        ip: c.exitIp,
        country: c.exitCountry ?? null,
        ...(c.exitCity !== undefined ? { city: c.exitCity } : {}),
        ...(c.exitRegion !== undefined ? { region: c.exitRegion } : {}),
        ...(c.exitTimezone !== undefined ? { timezone: c.exitTimezone } : {}),
        ...(c.exitAsnOrg !== undefined ? { asn_org: c.exitAsnOrg } : {}),
      };
  }
  return { ...view, endpointResults };
}

/**
 * (h) — when each ENDPOINT row's server-measured fields were measured, for the
 * grid's "Tested" column. `ProbeViewState.testedAt` is the entry's `at`, which
 * for a VPN row is the DNS pre-flight — re-stamped before EVERY fleet test,
 * including one the control plane then refused (`not_run`), so "Tested just
 * now" sat beside a "tunnel up" pill and a fleet latency measured an hour
 * earlier. Keyed only for rows that still hold a server field beside the
 * stamp: after a failure drops them the pre-flight's own time is the honest
 * date of what the row shows. SOCKS5 rows are not keyed — their `at` IS the
 * native verdict's time.
 */
export function serverProbeStamps(cache: ProbeCacheMap): Record<string, number> {
  const stamps: Record<string, number> = {};
  for (const [id, c] of Object.entries(cache)) {
    if (c.endpoint === undefined) continue;
    if (
      c.serverProbeAt !== undefined &&
      (c.serverLatencyMs !== undefined || c.measuredFrom !== undefined)
    ) {
      stamps[id] = c.serverProbeAt;
      continue;
    }
    // (h) finding 3/5 — a fleet FAILURE is a fleet answer too, and it is the
    // one the row shows: "checked" dates it, not the pre-flight before it.
    if (c.fleetFailureReason !== undefined && c.exitSupersededAt !== undefined) {
      stamps[id] = c.exitSupersededAt;
    }
  }
  return stamps;
}

/**
 * (h) finding 3 — the fleet's failure sentence per VPN proxy id, read from the
 * cache so EVERY surface that subscribes to it (the Proxies grid, the profile
 * card) renders the same "tunnel down" whichever view ran the check, and a
 * remounted grid does not forget a verdict the cache still holds. Present only
 * for an endpoint entry whose last fleet answer was a failure; cleared by the
 * cache writers that record a later verdict or a later exit.
 */
export function fleetFailureReasons(cache: ProbeCacheMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, c] of Object.entries(cache)) {
    if (c.endpoint === undefined || c.fleetFailureReason === undefined) continue;
    out[id] = c.fleetFailureReason;
  }
  return out;
}

// ─── (q) Items 2 / 12-memory (A) / 13(a)(c)(d) — the account row every proxy
// surface shares, and the background check for a VPN/HTTP row ───────────────

/**
 * (q) Items 2 / 13(a) — the wire body for a local proxy's account_proxies row,
 * with a STORED refusable OpenVPN blob normalised the way the paste / upload
 * path already normalises a NEW one (`openvpnAutoStrip`: `script-security >= 2`
 * lowered to 1, script directives removed — inert on Driftstack, where the
 * fleet forces `--script-security 1` and never runs user scripts).
 *
 * ⛔ MEASURED: the three launch/sync chokepoints (ProfilesView.ensureServerProxy,
 * AgentChatView.ensureServerProxyId, ProxiesView.pushLocalMaterialToAccount)
 * each forwarded `p.openvpn` VERBATIM, so a row pasted on a build before the
 * strip existed — the owner's own `72.65.206.209_…_resvpn.ovpn` with
 * `script-security 2` on line 46 — 400'd on EVERY launch from the grid and the
 * chat (`Line 46: "script-security 2" — Driftstack does not run scripts…`) until
 * it was opened in Edit AND re-saved; the editor's mount heal rewrote only the
 * draft. One builder for all three, so the body a launch PUTs is the body a
 * Check PUTs is the body a paste would have saved.
 *
 * `healedOpenvpn` is the stripped blob when the strip CHANGED it — the caller
 * persists it to the local row once, so the next launch is byte-identical and
 * the heal is not repeated on every sync. Null when the stored blob is already
 * what the control plane accepts (a clean row is forwarded byte for byte — the
 * vacuity the mount heal already pins) and for every other scheme. The strip
 * never invents missing material: an external cert/key reference is untouched
 * and still earns the server's own honest refusal.
 */
export function accountProxyInputFor(p: ProxyConfig): {
  input: AccountProxyInput;
  healedOpenvpn: string | null;
} {
  const healed = p.openvpn !== undefined ? openvpnAutoStrip(p.scheme, p.openvpn.config_blob) : null;
  const openvpn =
    p.openvpn === undefined
      ? undefined
      : healed === null
        ? p.openvpn
        : { ...p.openvpn, config_blob: healed.config };
  return {
    input: {
      label: p.label,
      scheme: p.scheme ?? 'socks5',
      host: p.host,
      port: p.port,
      username: p.username,
      password: p.password,
      ...(openvpn !== undefined ? { openvpn } : {}),
      ...(p.wireguard !== undefined ? { wireguard: p.wireguard } : {}),
    },
    healedOpenvpn: healed === null ? null : healed.config,
  };
}

/** (q) — write the healed blob back to the LOCAL row (same fields, only the
 *  OpenVPN block changes), so the heal happens once. */
export function persistHealedOpenvpn(p: ProxyConfig, config: string): Promise<ProxyConfig | null> {
  return updateLocalProxy(p.id, {
    label: p.label,
    host: p.host,
    port: p.port,
    username: p.username,
    password: p.password,
    ...(p.scheme !== undefined ? { scheme: p.scheme } : {}),
    ...(p.openvpn !== undefined ? { openvpn: { ...p.openvpn, config_blob: config } } : {}),
    ...(p.wireguard !== undefined ? { wireguard: p.wireguard } : {}),
  });
}

export interface EnsuredAccountProxy {
  /** The account_proxies row id — the `proxy_id` a launch passes, the id a Test asks the fleet about. */
  id: string;
  /** True when this call CREATED the row (the local row now carries `serverId`). */
  created: boolean;
  /** True when a stored refusable OpenVPN blob was normalised on the way (and persisted locally). */
  healed: boolean;
}

/**
 * (q) Item 12-memory (A) — ensure the local proxy has a server-side
 * account_proxies row (encrypted under the account TMK, owner-scoped) and
 * return its id. ONE implementation for the launch (ProfilesView), the chat's
 * launch (AgentChatView) and — new — the Test paths of the grid and the card.
 *
 * ⛔ MEASURED: the row was created ONLY by a launch, so a SOCKS5 proxy added on
 * the Proxies tab and Tested before its first launch greened natively and then
 * skipped the fleet leg in silence (`p.serverId === undefined`, no else): no
 * QUIC relay verdict, no OS fingerprint, no fleet latency, and a chip telling
 * the customer to "run Test … to confirm" — the owner's "my proxy has QUIC but
 * it's not detecting it". A Test with an API key now stores the row first.
 *
 * Creates on first use (caching the id on the local proxy), refreshes on later
 * calls so an edited host/credential/config stays current server-side, and
 * self-heals a stale cached id (the row was deleted server-side → the PUT
 * 404s) by re-creating. Any other error is real and is thrown. Returns
 * undefined when there is no API key (nothing can be stored without one).
 */
export async function ensureAccountProxyRow(
  p: ProxyConfig,
  baseUrl: string,
  apiKey: string | null,
): Promise<EnsuredAccountProxy | undefined> {
  if (apiKey === null || apiKey.length === 0) return undefined;
  const { input, healedOpenvpn } = accountProxyInputFor(p);
  // Heal ONCE, locally, before the wire. Best-effort: the body below carries
  // the stripped blob whether or not the local write landed, so a launch never
  // 400s on a line the fleet would have ignored anyway.
  if (healedOpenvpn !== null) await persistHealedOpenvpn(p, healedOpenvpn).catch(() => null);
  const healed = healedOpenvpn !== null;
  if (p.serverId !== undefined) {
    try {
      await updateAccountProxy(baseUrl, apiKey, p.serverId, input);
      return { id: p.serverId, created: false, healed };
    } catch (err) {
      // Stale cached serverId: the account_proxies row was deleted server-side
      // (e.g. during a DB recovery), so the PUT 404s. Self-heal by clearing the
      // stale id and re-creating below, instead of failing the sync forever.
      if ((err as { status?: number }).status !== 404) throw err;
    }
  }
  const created = await createAccountProxy(baseUrl, apiKey, input);
  // ⛔ (V4 follow-up 2026-09-12) — THE REMOTE ROW NOW EXISTS. Everything after
  // this line is bookkeeping on THIS Mac, and neither of its two failure modes
  // may be reported as "we could not store your VPN".
  //
  //   * `null` — `setProxyServerId` finds no local row (`idx < 0`) and returns
  //     null SILENTLY. That happens when the proxy was DELETED while this check
  //     was in flight, and a VPN check runs up to 90s: the create lands, the id
  //     write is a no-op, and `ProxiesView.removeOne` already ran with
  //     `serverId === undefined` so it never asked the server to delete
  //     anything. An `account_proxies` row holding the customer's OpenVPN
  //     configuration / WireGuard private key then survives a deletion the
  //     customer watched succeed — a credential-hygiene leak, and newly
  //     reachable for VPN rows because these checks now create. Undo our own
  //     create and answer `undefined` (nothing to test).
  //   * a THROW — the Tauri store write failed. The remote store SUCCEEDED, so
  //     the caller must not print "Couldn't store this VPN on your account":
  //     that is false, and it is the wrong half of the system. The id is
  //     returned and this check runs. Residual, named rather than hidden: the
  //     next check creates a SECOND row (nothing recorded the first id). That is
  //     strictly better than today, where the same duplicate happened AND the
  //     customer was told the opposite of what occurred.
  //
  // ⚠️ `null` is the CONTRACT ("No-op if the local proxy is gone. Returns the
  // updated row"), not a void: six test doubles in this repo stubbed it as one,
  // and two suites went red here rather than silently — which is the direction
  // to keep. The one false positive it admits is a transient empty store read
  // (`listProxyMetadataUnlocked` answers `[]` for a non-array value), which
  // would delete a good row and report "not stored"; that is recoverable on the
  // next check and strictly better than leaving a VPN key behind.
  const recorded = await setProxyServerId(p.id, created.id).catch(() => undefined);
  if (recorded === null) {
    await deleteAccountProxy(baseUrl, apiKey, created.id).catch(() => undefined);
    return undefined;
  }
  return { id: created.id, created: true, healed };
}

/** (q) Item 12-memory (A) — the SOCKS5 Test's notice when there is no API key:
 *  the native verdict stands, and the row says which legs did NOT run and why,
 *  instead of a silent '~' QUIC chip whose hint says "run Test" — the loop the
 *  customer was already in. The next step is the one control the GUI has. */
export const SOCKS5_TEST_NO_API_KEY_NOTICE = `Tested from this Mac only. ${MISSING_API_KEY_NEXT_STEP} from the test Mac too — that is where QUIC, the OS fingerprint and the fleet latency are measured.`;

/** (q) Item 12-memory (A) — the SOCKS5 Test's notice when the row could not be
 *  stored on the account (the create/refresh threw), so the fleet leg did not
 *  run. Names the cause in the server's words when it gave one; never "check
 *  your address" for a call that did not reach the server. */
export function socks5FleetTestNotStoredNotice(err: unknown): string {
  const detail = (err as { detail?: unknown } | null)?.detail;
  const said =
    typeof detail === 'string' && detail.length > 0
      ? ` Driftstack said: ${detail}`
      : ' The server did not answer; try Test again.';
  return `Tested from this Mac only. Couldn't store this proxy on your account, so the test Mac did not test it (QUIC, OS fingerprint, fleet latency).${said}`;
}

/**
 * (V2 2026-09-12) — the VPN check's twin of the sentence above, for the row's
 * notice AND the Test-all tally, picked TOGETHER so the two can never name
 * different reasons for the same refusal.
 *
 * ⚠️ SCOPE OF THAT CLAIM, corrected 2026-09-12 (V4 follow-up). `tally` has NO
 * consumer in `apps/gui-client/src` yet: the only caller of this function is the
 * profile card (`ProfilesView.runFleetTestForRow`), which reads `.notice`, and
 * the Test-all tally lives in `ProxiesView` — the proxy area's file, where the
 * patch that would read it has not landed. So the two-surfaces guarantee is a
 * property this function MAKES POSSIBLE, not one in effect; today `tally` is
 * exercised only by its own unit arm. Do not cite it as shipped behaviour until
 * `ProxiesView`'s VPN arm calls this.
 *
 * ⛔ MEASURED, and it is the whole of the owner's "nothing showing": a VPN row's
 * check returned at `p.serverId === undefined` on all four surfaces (the grid's
 * Check, Test-all, the profile card's Check VPN, the background sweep) and NO
 * VPN path ever set `serverId` — `ensureAccountProxyRow` has exactly one
 * `createProxy` call site in this app and its three callers are the two launches
 * and the SOCKS5 Test arms. So a launch was the only thing that could store a
 * VPN row, the check told the customer to launch one, and the launch was the
 * half of the report that was failing: a closed loop in which the measurement
 * that would explain the failure can never be taken. The checks store the row
 * themselves now (the same `ensureAccountProxyRow` the SOCKS5 Test has called
 * since (q) 12-memory (A)); this names the cause when that store is refused.
 *
 * Three causes, three sentences, discriminated by the SERVER's own contract
 * (status + the problem `detail` the shared discriminators match) — never by
 * prose this module reproduces:
 *   * the TIER refusal (`vpnEgress` off) — a plan sentence of our own, because
 *     the server's detail names an internal flag and a retry cannot help;
 *   * the free-desktop ROUTE POLICY refusal — the credential, not the plan;
 *   * anything else — the server's `detail` when it gave one, exactly as the
 *     SOCKS5 sibling above does for the same request on the same route.
 *
 * ⛔ EXCEPT AN UNRECOGNISED 403, which echoes NOTHING (V4 follow-up
 * 2026-09-12). The two 403s above are the only ones this module can name, and
 * every other 403 on this route is an AUTHORISATION fact whose `detail` names
 * internals: a key without the `account_owner` scope answers `This action
 * requires the "account_owner" scope.` (errors-helpers), a suspended account and
 * a denied device likewise. Echoing it put the GUI one server-side copy edit
 * away from printing the exact class of string the plan sentence exists to keep
 * off the screen — the tier branch is matched by a REGEX over server prose one
 * module over, so a reworded tier sentence falls through to here and the flag
 * name appears after all. A non-403 detail is still echoed on purpose: there it
 * is usually about the customer's own configuration (a 400 naming the offending
 * `.ovpn` line), which is the same reflection the launch dialog makes for the
 * same class of cause, for the same reason.
 */
export function vpnStoreRefusal(err: unknown): { notice: string; tally: string } {
  const status = (err as { status?: unknown } | null)?.status;
  const rawDetail = (err as { detail?: unknown } | null)?.detail;
  const detail = typeof rawDetail === 'string' && rawDetail.length > 0 ? rawDetail : undefined;
  if (status === 403) {
    if (isTierRefusalDetail(detail)) {
      return { notice: VPN_PLAN_EXCLUDED_CHECK_NOTICE, tally: VPN_PLAN_EXCLUDED_TALLY_REASON };
    }
    if (isDesktopCredentialRefusalDetail(detail)) {
      return {
        notice: `Endpoint resolves. ${DESKTOP_CREDENTIAL_FLEET_TEST_REASON}`,
        tally: DESKTOP_CREDENTIAL_NEXT_STEP,
      };
    }
  }
  const said =
    status === 403
      ? // See the ⛔ note above: an unrecognised 403 is an authorisation fact
        // whose detail names internals. Say what the customer can do instead.
        ' Your account is not allowed to store it — check your plan and API key in Settings.'
      : detail !== undefined
        ? ` Driftstack said: ${detail}`
        : ' The server did not answer; try the check again.';
  return {
    notice: `Endpoint resolves. Couldn't store this VPN on your account, so the tunnel was not tested.${said}`,
    tally: VPN_STORE_FAILED_TALLY_REASON,
  };
}

/**
 * (q) Item 13(c) — the background sweep's check for a VPN / HTTP row: the SAME
 * two legs the grid's Check runs (`ProxiesView.handleCheckEndpoint`) — the DNS
 * pre-flight of the endpoint, persisted as the row's endpoint verdict, then for
 * a resolved VPN row stored on the account the fleet test, persisted with the
 * observed exit adopted (VPN rows have no other exit). Never the native SOCKS5
 * handshake (T-20 — it can only read "unreachable" against a UDP endpoint).
 *
 * ⛔ MEASURED: `planSweep` dropped every non-SOCKS5 row, and no timer or focus
 * trigger ever called the endpoint check — so for a customer whose proxies are
 * VPN rows (the owner's), the app-open / focus / 15-min refresh did nothing at
 * all. Same preconditions as the grid, silently: a sweep the customer did not
 * ask for must not write a notice (it writes only what it measured). An HTTP
 * row gets the pre-flight alone, as on the grid. Errors propagate so the sweep
 * counts the row as `failed` (a check that could not run is not a verdict).
 */
export async function checkEndpointRowForSweep(
  p: ProxyConfig,
  creds: { baseUrl: string; apiKey: string | null },
  now: () => number = () => Date.now(),
): Promise<void> {
  if (isSocks5Probeable(p.scheme)) return; // a SOCKS5 row has its own probe
  const r = await resolveEndpoint(p.host, p.port);
  await saveEndpointResult(p.id, { resolved: r.resolved, ip: r.ip, message: r.message }, now());
  if (!r.resolved || !isVpnScheme(p.scheme)) return;
  // (V2 2026-09-12) — ⛔ THE SWEEP DELIBERATELY DOES NOT STORE THE ROW, and this
  // asymmetry with the two user-initiated checks (which now do) is the rule, not
  // an oversight of the same shape as the one they just fixed.
  //
  // The rule being applied: a local proxy's material is "device-only, never
  // uploaded" until the customer does something that uploads it on purpose —
  // `account_proxies` is described, in the server's own probe service, as "the
  // SEPARATE org-level proxy population the customer uploaded to the control
  // plane on purpose … uploading a proxy to the CP for dispatch IS that
  // consent". Pressing Check / Test on a row is that act (the customer asked for
  // a measurement only the test Mac can make, and the app already told them to
  // launch a session to get it, which uploads strictly more). A 20-minute
  // background timer is not: it would ship a customer's VPN keys to the control
  // plane with no act at all, which would make that sentence false.
  //
  // A row the customer HAS checked since this landed is already stored, so the
  // sweep refreshes it like any other; only a row last checked on an older build
  // stays un-measured here, and its next Check stores it.
  if (creds.apiKey === null || creds.apiKey.length === 0 || p.serverId === undefined) return;
  const outcome = await testProxyOnServer(creds.baseUrl, creds.apiKey, p.serverId);
  await persistServerProbe(p.id, outcome, { adoptExit: true });
}
