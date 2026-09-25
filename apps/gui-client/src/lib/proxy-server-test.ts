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
  DESKTOP_CREDENTIAL_TALLY_REASON,
  MISSING_API_KEY_NEXT_STEP,
  VPN_PLAN_EXCLUDED_CHECK_NOTICE,
  VPN_PLAN_EXCLUDED_TALLY_REASON,
  VPN_STORE_FAILED_TALLY_REASON,
} from './proxy-check-copy';
import {
  isProxyUsable,
  listProxies as listLocalProxies,
  resolveEndpoint,
  setProxyServerId,
  testProxy as testProxyNatively,
  updateProxy as updateLocalProxy,
  type ProxyConfig,
} from './proxies';
import { isSocks5Probeable, isVpnScheme } from './proxy-scheme';
import {
  capabilityBudgetLeft,
  hasUnmeasuredCapabilityReading,
  isAutomaticServerCheckDue,
  isCapabilityRunInFlight,
  isServerTestInFlight,
  runCapabilityRefresh,
  runSweep,
  withServerTest,
  type CapabilityCheckResult,
  type CapabilityRefreshDeps,
  type CapabilityRefreshReport,
  type SweepDeps,
  type SweepRun,
} from './proxy-probe-sweeper';
import {
  clearFleetFailure,
  deriveProbeViewState,
  ensureServerSeededEntry,
  isAgedReadingShowable,
  isOsFingerprintFresh,
  isQuicProbeFresh,
  isQuicVerdictFresh,
  isUdpVerdictFresh,
  clearCapabilityMaterialUnsynced,
  loadCapabilityAttempts,
  loadProbeCache,
  materialEditCountNow,
  materialEditedAfter,
  materialEditsPending,
  noteCapabilityReadingsNotProduced,
  pruneCapabilityAttempts,
  recordCapabilityAttempt,
  refusesServerOsReading,
  saveEndpointResult,
  saveExitResult,
  saveFleetFailure,
  saveOsFingerprint,
  saveProbeResult,
  saveServerProbeResult,
  seedServerCapabilityReadings,
  seedServerOsFingerprint,
  serverCapabilityReadingsToAdopt,
  verdictMatchesScheme,
  type CachedEndpointVerdict,
  type CachedOsFingerprint,
  type CachedProbe,
  type CapabilityAttemptMap,
  type DatedServerReading,
  type ProbeCacheMap,
  type ProbeViewState,
  type ServerCapabilityReadings,
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
      /** (V5 2026-09-12) — the node did not RUN the QUIC leg on this test
       *  (`quic_detail: "skipped: …"`). Then `quicProbe` above is absent because
       *  NOTHING WAS MEASURED about QUIC — not because a Mac ran the leg and
       *  reached no verdict — and the row's last relay fact stands, exactly as it
       *  does across a control-plane fallback. Only ever `true`: a reply that ran
       *  the leg omits the field rather than claiming `false`. */
      quicLegSkipped?: true;
      /** ⛔ (2026-09-17) — the node RAN the QUIC leg and reached no verdict: it
       *  described the leg (`quic_detail`, not a "skipped: …" one) and sent no
       *  `quic_ok`. The ONLY thing that may retire a stored relay verdict; every
       *  other shape of absence carries it. Only ever `true`, like the field
       *  above: a reply that produced a verdict sends the verdict. */
      quicLegRan?: true;
      /** (V6 2026-09-16) ITEM 3 — the fleet Mac's MEASURED UDP-relay verdict,
       *  present ONLY when the control plane reported one. ⛔ Absent means NOT
       *  MEASURED: on the VPN path the node's `udp_associate: true` is a literal
       *  about the tunnel's nature, and the route drops it (and every explicit
       *  null / skipped leg) rather than let it reach a chip as a reading. A
       *  present `false` is the real thing — a leg that ran and failed — and the
       *  surfaces render it as a negative verdict, distinguishable from absence. */
      udpProbe?: boolean;
      osFingerprint?: OsFingerprint;
      /** (p) 2026-09-16 — when `osFingerprint` was MEASURED, which is not always
       *  when this test ran: a reply whose own test observed no SYN carries the
       *  row's STORED reading with the date it was taken. The cache is stamped
       *  with this, so the one TTL ages a stored reading from its real age —
       *  stamping it "now" would present last week's reading as current, which is
       *  the defect this whole item exists to close. Absent for a reading this
       *  test measured: `at` dates that one, as it always has. */
      osFingerprintAt?: number;
      /** VPN exit parity (b) — the exit the fleet Mac observed through the
       *  proxy/tunnel, when the reply carried one. Persisted as the row's exit
       *  identity (the same cache fields the native exit probe writes for a
       *  SOCKS5 row), which is the only way a VPN row can ever get one. */
      exitObserved?: AccountProxyExitObserved;
      /**
       * The row's STORED Test readings the reply carried, each with the date the
       * SERVER took it — never this reply's time.
       *
       * ⛔ NOT `quicProbe` / `udpProbe` ABOVE, and the separation is the point:
       * those are what THIS test measured, stamped `at` and rendered in the
       * present tense; these may be weeks old. The wire spells the stored QUIC
       * reading `quic_probe` — the very name the fresh one has on the parsed
       * result — so the parse renames it (`stored_quic_probe`) and this type keeps
       * the two apart all the way to the cache, where a stored reading is adopted
       * under the newer-wins rule and a fresh one replaces. Present only for a
       * reading the server could date.
       */
      storedQuicProbe?: DatedServerReading<boolean>;
      storedUdpProbe?: DatedServerReading<boolean>;
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
  'The server did not answer, so the VPN was not tested. The address has changed since the last check; no result yet — try again.';

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

/**
 * (V5 2026-09-12) — the node's own word for "the QUIC leg never ran", read off
 * the reply's `quic_detail`. The fleet node emits it on the VPN path and when
 * the endpoint never answered; the route then omits `quic_ok` beside it
 * (account-me.ts) and the parse refuses one from an older node that still sends
 * `quic_ok:false` (account-proxies.ts) — so by the time a reply reaches here,
 * "skipped" shows ONLY in this string, and a consumer that reads the missing
 * `quic_probe` as "the Mac measured and found none" is reading a hole.
 *
 * ⛔ The prefix is deliberately re-stated here rather than imported from
 * `account-proxies`: that module is hand-mocked with listed factories by ten
 * suites, where a NEW export is `undefined` at every call site (the trap
 * `proxy-check-copy.ts`'s header was written for). The two readings are bound
 * by measurement instead, in
 * tests/unit/a-skipped-quic-leg-is-not-a-relay-verdict.test.ts: one wire body
 * goes through the real parse AND this predicate, and the test fails if either
 * half stops recognising it.
 */
const QUIC_LEG_SKIPPED_PREFIX = 'skipped:';

/** The wire's `observed_via` under the client's name, dropping anything outside
 *  the closed set rather than coercing it. Absent stays absent: a reading with
 *  no stated vantage must not be treated as an exit reading. */
function withObservedVia(fp: OsFingerprint): OsFingerprint {
  const raw = (fp as unknown as Record<string, unknown>).observed_via;
  if (fp.observedVia !== undefined) return fp;
  if (raw !== 'proxy_host' && raw !== 'exit_ip') return fp;
  return { ...fp, observedVia: raw };
}

function quicLegSkipped(detail: string | undefined): boolean {
  return detail !== undefined && detail.startsWith(QUIC_LEG_SKIPPED_PREFIX);
}

/**
 * ⛔ (2026-09-17) Did the node RUN the QUIC leg and reach no verdict?
 *
 * This is the positive evidence the cache now requires before retiring a stored
 * relay verdict, and it is deliberately narrow: the node SAID something about the
 * leg — a `quic_detail` that is not its own "skipped: …" — while sending no
 * `quic_ok`. Anything else (no detail at all, a control-plane fallback, a reply
 * shaped by a route that simply omits the key for a non-measurement) is absence
 * of evidence, and absence must not retire a verdict a customer watched go green.
 *
 * A boolean verdict short-circuits to false: a reply that MEASURED the leg
 * replaces the stored verdict outright and retires nothing.
 */
function quicLegRanWithoutVerdict(quicProbe: unknown, detail: string | undefined): boolean {
  if (typeof quicProbe === 'boolean') return false;
  return detail !== undefined && detail.length > 0 && !quicLegSkipped(detail);
}

/** (V6 2026-09-16) — the same reading for the UDP leg. One predicate, one prefix:
 *  "the node said it did not run this leg" has to mean the same thing for both, or
 *  one of them ends up rendering a hole as a verdict. */
function udpLegSkipped(detail: string | undefined): boolean {
  return detail !== undefined && detail.startsWith(QUIC_LEG_SKIPPED_PREFIX);
}

/**
 * A stored reading and its ISO stamp, as a dated reading — or undefined when the
 * server holds none, or the stamp does not parse. ONE rule for the list and the
 * /test reply: an undatable reading adopts nothing, because it could only ever
 * arrive looking current.
 */
export function datedStoredReading<T>(
  value: T | null | undefined,
  at: string | null | undefined,
): DatedServerReading<T> | undefined {
  if (value === null || value === undefined || typeof at !== 'string') return undefined;
  const parsed = Date.parse(at);
  return Number.isFinite(parsed) ? { value, at: parsed } : undefined;
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
  // The STORED readings, dated by the server. ⛔ Read from `stored_*` only — never
  // from `test.quic_probe`, which is this test's fresh reading (see the type).
  const storedQuic = datedStoredReading(test.stored_quic_probe, test.stored_quic_probe_at);
  const storedUdp = datedStoredReading(test.stored_udp_probe, test.stored_udp_probe_at);
  return {
    kind: 'ok',
    at: now,
    latencyMs: test.latency_ms,
    ...(quic !== undefined
      ? { quicMeasured: quic, quicMeasuredAt: quicVerdictStamp(test.quic_measured_at, now) }
      : {}),
    ...(vantage !== undefined ? { vantage } : {}),
    ...(typeof test.quic_probe === 'boolean' ? { quicProbe: test.quic_probe } : {}),
    ...(quicLegSkipped(test.quic_detail) ? { quicLegSkipped: true as const } : {}),
    ...(quicLegRanWithoutVerdict(test.quic_probe, test.quic_detail)
      ? { quicLegRan: true as const }
      : {}),
    // (V6 2026-09-16) ITEM 3 — the UDP leg. The route has already dropped every
    // non-reading (a VPN row's asserted literal, the node's explicit null, a
    // `udp_detail: "skipped: …"` leg), so a boolean that survives to here is a
    // MEASUREMENT and its absence is "not measured" — never "no UDP". Guarded
    // again anyway against an older control plane that could still pass a false
    // through beside a skipped detail: a false that reaches a chip is a negative
    // verdict about a customer's tunnel that nobody measured.
    ...(typeof test.udp_associate === 'boolean' && !udpLegSkipped(test.udp_detail)
      ? { udpProbe: test.udp_associate }
      : {}),
    // ⛔ NORMALISE THE VANTAGE AT THE WIRE BOUNDARY. The control plane sends
    // `observed_via`; the client type calls it `observedVia`, and passing the
    // wire object through unchanged left the field invisible to every consumer
    // until a cache round-trip renamed it. That gap is exactly one Test wide —
    // the chip would claim a verdict about the exit right after a test and stop
    // claiming it after a restart. One spelling downstream, from here on.
    ...(test.os_fingerprint !== undefined
      ? { osFingerprint: withObservedVia(test.os_fingerprint) }
      : {}),
    // (p) — the reading's own date when the server sent one (a STORED reading it
    // attached because this test observed none), else this test's time. Same rule
    // and the same implementation as the QUIC stamp above, which is named for its
    // first caller rather than for the rule: the server's clock wins when it says
    // when, and the reply time is the fallback for a measurement with no stated
    // date. Only beside a reading — a stamp with nothing to date is meaningless.
    ...(test.os_fingerprint !== undefined && typeof test.os_fingerprint_at === 'string'
      ? { osFingerprintAt: quicVerdictStamp(test.os_fingerprint_at, now) }
      : {}),
    ...(test.exit_observed !== undefined ? { exitObserved: test.exit_observed } : {}),
    ...(storedQuic !== undefined ? { storedQuicProbe: storedQuic } : {}),
    ...(storedUdp !== undefined ? { storedUdpProbe: storedUdp } : {}),
  };
}

/** Ask the control plane to test the proxy from the Mac that runs the profile
 *  (T-1 — `vantage: 'fleet'`). Never throws: a failed request is `unavailable`.
 *
 *  ONE test of an account row at a time, whoever asks (`withServerTest`): every
 *  caller — the grid's Test, the card's, the sweep, the automatic check — comes
 *  through here, so this is the one place the registration cannot be forgotten.
 *  A caller the customer started waits out a test already running against the row;
 *  the automatic callers look first (`isServerTestInFlight`) and do not ask. */
export async function testProxyOnServer(
  baseUrl: string,
  apiKey: string,
  serverId: string,
  now: () => number = () => Date.now(),
): Promise<ServerProbeOutcome> {
  return withServerTest(serverId, async () => {
    const test = await testAccountProxy(baseUrl, apiKey, serverId, { vantage: 'fleet' }).catch(
      () => null,
    );
    return serverProbeOutcome(test, now());
  });
}

/**
 * (p) review — the IN-MEMORY copy of the reading a reply carried, for the grid's
 * own state between the reply and the cache emit that follows it.
 *
 * ⛔ IT LIVES HERE BESIDE THE CACHE WRITE ON PURPOSE. `persistServerProbe` dates the
 * reading by `outcome.osFingerprintAt ?? outcome.at` and `deriveProbeViewState` then
 * ages it by `isOsFingerprintFresh`; the grid's twin of that write did neither, so a
 * STORED reading the server attached to a miss (the server applies no age bound —
 * `storedOsForReply` checks only that the row can be dated) was stamped with the
 * REPLY time and rendered "Measured by Driftstack, just now", full green, for a
 * reading that could be days old — and then blanked when the emit landed and the TTL
 * dropped it. Same date, same TTL, one function: the two cannot drift again.
 *
 * `undefined` means SHOW NOTHING: either the reply carried no reading, or the one it
 * carried is past the TTL, which is exactly what the emit a moment later will say.
 */
export function chipOsFingerprint(
  outcome: ServerProbeOutcome,
  nowMs: number = Date.now(),
): CachedOsFingerprint | undefined {
  if (outcome.kind !== 'ok' || outcome.osFingerprint === undefined) return undefined;
  const rec: CachedOsFingerprint = {
    ...outcome.osFingerprint,
    at: outcome.osFingerprintAt ?? outcome.at,
  };
  return isOsFingerprintFresh(rec, nowMs) ? rec : undefined;
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
    // (h) finding 3 — the sentence is persisted with the stamp, so the card and
    // a remounted grid render the same verdict the view that ran the check did.
    // ⛔ Proxy-accuracy audit G2 (a) — for a SOCKS5 caller (no `adoptExit`) too.
    // It used to write nothing here, so the failure lived only in the grid's
    // memory and the next cache write or display tick rebuilt the row from the
    // store — back to the numbers and the ✓ QUIC the fleet took BEFORE it failed.
    // A SOCKS5 row keeps what THIS Mac measured (its verdict and its exit).
    return saveFleetFailure(proxyId, outcome.at, outcome.reason, {
      keepNativeExit: opts.adoptExit !== true,
    }).catch(() => null);
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
    // (p) — dated by the MEASUREMENT, not by the reply: a stored reading the server
    // attached carries its own date and must age from it, exactly as the QUIC
    // verdict below does. `?? outcome.at` is the fresh case, unchanged.
    latest = await saveOsFingerprint(
      proxyId,
      outcome.osFingerprint,
      outcome.osFingerprintAt ?? outcome.at,
    ).catch(() => null);
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
      // (V5) — WHY there is no relay verdict on this reply: the node skipped the
      // leg (nothing measured → the last one stands) or it ran and produced none
      // (→ the last one goes). The cache cannot tell those apart from an absence.
      quicSkipped: outcome.quicLegSkipped,
      // ⛔ (2026-09-17) …and THIS is the half that was missing, which is why the
      // cache had to guess from absence and guessed "it ran" — throwing away a
      // green verdict on every reply that merely lacked the key. Now the two
      // reasons are both named on the wire's own evidence and the cache retires
      // only on this one.
      quicRan: outcome.quicLegRan,
      // (V6) — the UDP leg. No `skipped` twin is needed: the route emits
      // `udp_associate` if and only if it is a reading, so an absent `udpProbe`
      // IS the non-measurement and the cache keeps what it holds.
      udpProbe: outcome.udpProbe,
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
  // The row's STORED QUIC / UDP readings, adopted under the list adoption's own
  // rules and dated by the SERVER — never by this reply.
  //
  // ⛔ AFTER the write above, on purpose, and through the SAME decision the list
  // sync makes (`serverCapabilityReadingsToAdopt`). A leg this reply measured is
  // already written, dated now, and newer-wins refuses the stored copy. A leg it
  // RAN and reached no verdict on was deliberately removed by
  // `saveServerProbeResult` — while the server, which writes nothing for such a
  // leg, still holds the reading from before; the write left `quicProbeRetiredAt`,
  // and that stamp refuses it here and on every list sync after. (This used to be
  // a test of the reply's vantage, which covered this path only: the next list
  // sync put the retired verdict straight back.) A leg the reply did NOT run — a
  // fallback, a skipped leg — has no answer but the stored one, which is why the
  // server attaches it.
  let withStored: ProbeCacheMap | null = null;
  const entryNow = (withExit ?? next ?? latest)?.[proxyId];
  if (
    entryNow !== undefined &&
    (outcome.storedQuicProbe !== undefined || outcome.storedUdpProbe !== undefined)
  ) {
    withStored = await seedServerCapabilityReadings(proxyId, {
      ...(outcome.storedQuicProbe !== undefined ? { quicProbe: outcome.storedQuicProbe } : {}),
      ...(outcome.storedUdpProbe !== undefined ? { udpProbe: outcome.storedUdpProbe } : {}),
    }).catch(() => null);
  }
  return withStored ?? withExit ?? next ?? latest;
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
export const LIST_TUNNEL_DOWN_REASON = 'The last check could not connect this VPN.';

/** Proxy-accuracy audit G2 (d) — the same, for a SOCKS5 row: the list says
 *  Driftstack's last check could not use it, and carries no cause. */
export const LIST_FLEET_FAILED_REASON = 'Driftstack’s last check could not use this proxy.';

/** Whether this Mac holds a DRIFTSTACK (fleet) answer about a SOCKS5 row taken
 *  after `t`. Only such an answer outranks a failure the list carries — this
 *  Mac's own verdict and exit never do (§4.3). */
function holdsFleetAnswerAfter(existing: CachedProbe, t: number): boolean {
  return (
    existing.measuredFrom === 'fleet' &&
    existing.serverProbeAt !== undefined &&
    existing.serverProbeAt > t
  );
}

/**
 * ⛔ Proxy-accuracy audit G2 (d) — a SOCKS5 row's Driftstack failure reaches
 * EVERY Mac. The server stamps `exit_superseded_at` for every scheme when a fleet
 * test finds the proxy unusable, and lists it; this was adopted for VPN rows only,
 * so a second Mac (or a reinstall) kept adopting the readings from BEFORE the
 * failure and never showed it. §4.3: a fleet failure retires every fleet reading
 * dated before it, on every Mac.
 *
 * The stamp is written through `saveFleetFailure` keeping what THIS Mac measured;
 * on a Mac that never tested the row it lands on a seeded entry, which stays
 * seeded, so the OS and capability adoptions that run after this one refuse every
 * reading dated at or before it. A Driftstack answer this Mac holds from after the
 * stamp outranks the list. The server's explicit clear — no stamp, beside an
 * observation dated after the one held here — lifts it, as on a VPN row.
 */
async function adoptListFleetFailureForSocks5(
  p: ListExitProxyLike,
  row: ListExitRow,
  cache: ProbeCacheMap,
  gate: ListAdoptionGate,
  nowMs: number,
): Promise<{ cache: ProbeCacheMap; wrote: boolean }> {
  let existing = cache[p.id];
  const stampMs = existing?.exitSupersededAt;
  const seenUpAt =
    row.exit_observed?.observed_at !== undefined && row.exit_observed?.observed_at !== null
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
      return { cache: await clearFleetFailure(p.id, stampMs), wrote: true };
    } catch {
      return { cache, wrote: false };
    }
  }
  const serverStamp = listSupersededStamp(row.exit_superseded_at);
  if (serverStamp === undefined) return { cache, wrote: false };
  if (stampMs !== undefined && stampMs >= serverStamp) return { cache, wrote: false };
  if (existing !== undefined && holdsFleetAnswerAfter(existing, serverStamp))
    return { cache, wrote: false };
  try {
    if (existing === undefined) {
      cache = await ensureServerSeededEntry(p.id, nowMs);
      existing = cache[p.id];
      if (existing === undefined) return { cache, wrote: false };
    }
    if (gate.refuses(p.id)) return { cache, wrote: false };
    cache = await saveFleetFailure(
      p.id,
      serverStamp,
      existing.fleetFailureReason ?? LIST_FLEET_FAILED_REASON,
      { keepNativeExit: true },
    );
    return { cache, wrote: true };
  } catch {
    return { cache, wrote: false };
  }
}

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
 * The question the three list adoptions below ask about every row before they
 * write — "was this row edited?" — or `null` for "adopt NOTHING, for anyone".
 *
 * ⛔ A ROW EDITED SINCE THE ACCOUNT LAST RECEIVED IT ADOPTS NOTHING
 * (`materialUnsynced`), for the reason the automatic check leaves it alone: what
 * the account holds for it describes the OLD endpoint. MEASURED: the customer
 * tests a row (the account stores its OS / QUIC / UDP readings, dated), edits its
 * host and saves. `invalidateProbe` deletes the whole entry — every retirement
 * stamp with it — and the view refreshes BEFORE the re-test that pushes the new
 * material, so the list sync found a row with no local entry, which admits
 * everything, and seeded the predecessor's readings onto the edited row in the
 * present tense. The mark is lifted by a successful store of the row
 * (`clearCapabilityMaterialUnsynced`); the account's copy is this row's again then.
 *
 * ⛔ FAILS CLOSED. A ledger that cannot be read does not say "nobody edited
 * anything": it says nothing, and adopting on it re-opens the hole for exactly the
 * row it exists for. The next refresh — seconds away — reads it again.
 *
 * ⛔ THE STORED MARK IS NOT THE WHOLE ANSWER, so the gate asks three more things,
 * all from memory (`pendingMaterialEdits` in the cache says why each exists): was
 * the row pending when this adoption STARTED; was it marked in the ledger as read
 * BEFORE the request as well as after (the view fires the list request and then
 * the store that lifts the mark — a list the server answered from before that
 * store, arriving after the lift, still carries the old endpoint's readings); and
 * has it been edited SINCE this adoption started.
 *
 * `syncListExitObserved` opens ONE gate for all three, so they agree about which
 * rows were edited; an adoption called by itself opens its own, so no caller can
 * adopt round the mark by omission.
 */
export interface ListAdoptionGate {
  /** Ask IMMEDIATELY before each write, with no await between — see
   *  `pendingMaterialEdits`. */
  refuses: (proxyId: string) => boolean;
}

/** What is known before the request goes out. */
interface ListAdoptionEntry {
  editCount: number;
  pending: ReadonlySet<string>;
  marked: CapabilityAttemptMap;
}

async function enterListAdoption(): Promise<ListAdoptionEntry | null> {
  // Both taken synchronously, before the first await.
  const editCount = materialEditCountNow();
  const pending = materialEditsPending();
  try {
    return { editCount, pending, marked: await loadCapabilityAttempts() };
  } catch {
    return null;
  }
}

/** `entry` = what `enterListAdoption` answered before the request; omitted = there
 *  was no request (an adoption called by itself), and one read serves as both. */
async function openListAdoptionGate(
  entry?: ListAdoptionEntry | null,
): Promise<ListAdoptionGate | null> {
  if (entry === null) return null;
  const before = entry ?? (await enterListAdoption());
  if (before === null) return null;
  let marked = before.marked;
  if (entry !== undefined) {
    try {
      marked = await loadCapabilityAttempts();
    } catch {
      return null;
    }
  }
  return {
    refuses: (id) =>
      marked[id]?.materialUnsynced === true ||
      before.marked[id]?.materialUnsynced === true ||
      before.pending.has(id) ||
      materialEditedAfter(id, before.editCount),
  };
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
  /** The gate, when the caller already opened one — see `ListAdoptionGate`.
   *  Omitted = opened here, strictly. */
  given?: ListAdoptionGate,
): Promise<string[]> {
  const written: string[] = [];
  const byServerId = new Map<string, ListExitRow>();
  for (const r of rows) byServerId.set(r.id, r);
  const gate = given ?? (await openListAdoptionGate());
  if (gate === null) return written;
  let cache: ProbeCacheMap;
  try {
    cache = await loadProbeCache();
  } catch {
    return written;
  }
  for (const p of proxies) {
    if (p.serverId === undefined) continue;
    if (!isVpnScheme(p.scheme)) {
      // A SOCKS5 row adopts no EXIT from the list — its own is measured from this
      // Mac — but it does adopt a Driftstack FAILURE (G2 d).
      if (!isSocks5Probeable(p.scheme) || gate.refuses(p.id)) continue;
      const socksRow = byServerId.get(p.serverId);
      if (socksRow === undefined) continue;
      const adopted = await adoptListFleetFailureForSocks5(p, socksRow, cache, gate, nowMs);
      cache = adopted.cache;
      if (adopted.wrote) written.push(p.id);
      continue;
    }
    // Before everything below, the address check included: that is an entry
    // invented for the edited row, for the old endpoint's exit to land on.
    if (gate.refuses(p.id)) continue;
    const row = byServerId.get(p.serverId);
    if (row === undefined) continue;
    // (p) 2026-09-16 — a SERVER-SEEDED entry is not an entry for this purpose. It
    // holds the account list's OS reading and no verdict of any kind, and the exit
    // write below only SHOWS on a VPN row beside a resolved pre-flight — so
    // treating it as "already has an entry" would skip the resolve and leave the
    // exit stored and invisible. Read as absent, the pre-flight below runs and the
    // seeded reading survives it (`saveEndpointResult` carries no server fields
    // across an endpoint it has not resolved before, so the next poll re-seeds it).
    let existing = cache[p.id]?.serverSeeded === true ? undefined : cache[p.id];
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
        // …and asked again after every await from here on: the lookup above can
        // take seconds, and an edit saved meanwhile makes everything below a write
        // of the OLD endpoint's facts (its address first) onto the edited row.
        if (gate.refuses(p.id)) continue;
        // (p) review — ⛔ THIS GUARD MUST AGREE WITH THE READ ABOVE IT. It used to
        // write only when the key was ABSENT, so a SERVER-SEEDED entry — which the
        // read above deliberately treats as absent — made this discard the resolve
        // it had just spent, leave the row with no `endpoint`, and hand the seeded
        // entry back as `existing`. The exit below was then written onto an entry
        // no VPN surface reads (`deriveProbeViewWithEndpointRows` skips a row with
        // no `endpoint`, and the base derivation refuses the placeholder's exit),
        // so the row said "untested" for ever and burned a real DNS resolve every
        // poll. `saveEndpointResult` rebuilds the entry and drops the seeded mark;
        // the next poll's `adoptListOsFingerprint` re-seeds the reading onto the
        // real entry, which is what the comment above already describes.
        if (cache[p.id] === undefined || cache[p.id]?.serverSeeded === true) {
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
    //
    // ⛔ …OR THE STAMP IS HERE AND ITS SENTENCE IS NOT. The stamp crosses every
    // address check now (`saveEndpointResult`); the sentence does not cross one
    // that could not confirm the address. While the stamp was lost with it, the
    // test above re-stamped the row on the next poll and "tunnel down" came back
    // by accident. With the stamp kept — and it is this Mac's reply time, so
    // normally at or after the server's — that test is false for ever, and a VPN
    // whose last full check FAILED read as a plain resolved row until something
    // re-tested it. So: the list still says down, the address resolves again,
    // nothing here was measured since, and the entry says nothing — write the
    // sentence back under the stamp this entry already holds. Not while the
    // address is unresolved: that answer outranks this one on the row, and a card
    // Test whose address check fails is meant to move "tunnel down" off it.
    const heldStamp = existing.exitSupersededAt;
    const stampMissing = heldStamp === undefined || heldStamp < (serverSupersededAt ?? 0);
    const sentenceMissing =
      heldStamp !== undefined &&
      !stampMissing &&
      existing.fleetFailureReason === undefined &&
      existing.endpoint?.resolved === true &&
      !holdsMeasurementAfter(existing, heldStamp);
    if (
      serverSupersededAt !== undefined &&
      (stampMissing || sentenceMissing) &&
      !holdsMeasurementAfter(existing, serverSupersededAt) &&
      !gate.refuses(p.id)
    ) {
      try {
        cache = await saveFleetFailure(
          p.id,
          sentenceMissing ? heldStamp : serverSupersededAt,
          existing.fleetFailureReason ?? LIST_TUNNEL_DOWN_REASON,
        );
        existing = cache[p.id] ?? existing;
      } catch {
        /* best-effort — the refusal below still holds by the server's stamp */
      }
    }
    if (gate.refuses(p.id)) continue;
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

/** (p) — the slice of a list row the OS adoption reads: the row, the reading the
 *  server holds for it, and WHEN that reading was taken. */
export type ListOsRow = Pick<AccountProxyMeta, 'id' | 'os_fingerprint' | 'os_fingerprint_at'>;

/**
 * (p) 2026-09-16 — adopt the OS reading the SERVER holds for each proxy (the
 * account list's `os_fingerprint`) into the same cache field a local test writes,
 * so a proxy fingerprinted on ANOTHER Mac — or before a reinstall — shows its
 * reading here without anyone pressing Test. The control plane is the only thing
 * that can take this reading (it reads the SYN the proxy's own kernel sent to our
 * observer), it has been storing it since N-2, and nothing the customer could see
 * has ever read it back: that is the owner's "we are not saving the OS fingerprint
 * of already checked proxies".
 *
 * ⛔ ONE FRESHNESS RULE. The reading is aged by `isOsFingerprintFresh` against the
 * server's own `os_fingerprint_at`, the same function and the same TTL that age a
 * locally measured one — so a stored reading past the TTL never reaches the
 * present-tense map, whether it was adopted stale or went stale later. (It used to
 * be refused at the door; it is adopted now, up to the aged cap, because past the
 * TTL a reading is shown AGED rather than hidden — see `AgedReadings`.) A reading
 * the server cannot date is REFUSED outright: an undatable reading cannot be aged,
 * and the one thing it must never do is arrive looking current.
 *
 * ⛔ Never rewinds: a reading at or before the one this Mac already holds writes
 * nothing, so a test run here minutes ago outranks the list's copy of an older one
 * (the writer re-checks this under the lock — this check only keeps the returned
 * "written" list honest). And never RESURRECTS: a reading dated at or before a
 * retirement stamp on the entry is refused like a stored QUIC / UDP reading is
 * (`refusesServerOsReading`). Best-effort per proxy; returns the proxy ids written.
 *
 * Every scheme, not just SOCKS5: a VPN row's reading comes from the observer record
 * the fleet node caused through the tunnel, and it is stored on the row like any
 * other. A list row can never carry a CAUSE (`unavailable`) rather than a reading —
 * the wire parser mints those only from a /test reply — so nothing here can turn an
 * explanation into a stored measurement.
 */
export async function adoptListOsFingerprint(
  rows: ReadonlyArray<ListOsRow>,
  proxies: ReadonlyArray<ListExitProxyLike>,
  nowMs: number = Date.now(),
  /** See `ListAdoptionGate`. Omitted = opened here, strictly. */
  given?: ListAdoptionGate,
): Promise<string[]> {
  const written: string[] = [];
  const byServerId = new Map<string, ListOsRow>();
  for (const r of rows) byServerId.set(r.id, r);
  const gate = given ?? (await openListAdoptionGate());
  if (gate === null) return written;
  let cache: ProbeCacheMap;
  try {
    cache = await loadProbeCache();
  } catch {
    return written;
  }
  for (const p of proxies) {
    if (p.serverId === undefined) continue;
    if (gate.refuses(p.id)) continue; // the OLD endpoint's reading
    const row = byServerId.get(p.serverId);
    const fp = row?.os_fingerprint;
    if (row === undefined || fp === null || fp === undefined) continue;
    const at =
      typeof row.os_fingerprint_at === 'string' ? Date.parse(row.os_fingerprint_at) : Number.NaN;
    if (!Number.isFinite(at)) continue;
    // A reading past the thirty-minute TTL is ADOPTED now, up to the aged cap: it
    // does not reach the present-tense map (the derivation ages it by the same
    // function as ever) but it is what the chip shows muted, with its age, and
    // what tells the automatic check that Driftstack re-took this reading two
    // hours ago and the row needs no dial of its own. Past the cap, as before, it
    // leaves no trace. (Every fresh reading is inside the cap, future stamps
    // included, so this one test is the whole gate.)
    if (!isAgedReadingShowable(at, nowMs)) continue;
    // Never rewinds, never resurrects — the writer's own rule, asked here first.
    if (refusesServerOsReading(cache[p.id], at)) continue;
    try {
      cache = await seedServerOsFingerprint(p.id, fp, at);
      written.push(p.id);
    } catch {
      /* best-effort — the next refresh retries */
    }
  }
  return written;
}

/** The slice of a list row the capability adoption reads. */
export type ListCapabilityRow = Pick<
  AccountProxyMeta,
  | 'id'
  | 'quic_measured'
  | 'quic_measured_at'
  | 'stored_quic_probe'
  | 'stored_quic_probe_at'
  | 'stored_udp_probe'
  | 'stored_udp_probe_at'
>;

/**
 * Adopt the QUIC / UDP readings the SERVER holds for each proxy — the live
 * session's `quic_measured`, and what the last Test measured about QUIC and UDP
 * — into the fields a local check writes. The sibling of `adoptListOsFingerprint`
 * above, in the same style and for the same reason: the list has carried
 * `quic_measured` since T-6 and NOTHING read it, so a proxy checked on another
 * Mac, or before a reinstall, showed "not measured" about something Driftstack
 * had measured.
 *
 * ⛔ A server reading replaces a local one only when it is NEWER BY ITS OWN DATE
 * (`serverCapabilityReadingsToAdopt`, re-checked under the write lock); a reading
 * the server cannot date adopts nothing; a field an older server does not send
 * adopts nothing. Readings past the aged cap leave no trace, as for the OS.
 * Freshness is otherwise NOT judged here — the derivation sorts each adopted
 * reading into current, aged or neither by the one rule every reading obeys.
 *
 * ⛔ A row with no `serverId` is never looked at: nothing about it is on the
 * server. Best-effort per proxy; returns the proxy ids written.
 */
export async function adoptListCapabilityReadings(
  rows: ReadonlyArray<ListCapabilityRow>,
  proxies: ReadonlyArray<ListExitProxyLike>,
  nowMs: number = Date.now(),
  /** See `ListAdoptionGate`. Omitted = opened here, strictly. */
  given?: ListAdoptionGate,
): Promise<string[]> {
  const written: string[] = [];
  const byServerId = new Map<string, ListCapabilityRow>();
  for (const r of rows) byServerId.set(r.id, r);
  const gate = given ?? (await openListAdoptionGate());
  if (gate === null) return written;
  let cache: ProbeCacheMap;
  try {
    cache = await loadProbeCache();
  } catch {
    return written;
  }
  // (A `function`, not a generic arrow: a surface scanner parses this file as
  // TSX, where `<T>(` opens an element.)
  function showable<T>(r: DatedServerReading<T> | undefined): DatedServerReading<T> | undefined {
    return r !== undefined && isAgedReadingShowable(r.at, nowMs) ? r : undefined;
  }
  for (const p of proxies) {
    if (p.serverId === undefined) continue;
    if (gate.refuses(p.id)) continue; // the OLD endpoint's readings
    const row = byServerId.get(p.serverId);
    if (row === undefined) continue;
    const quicMeasured = showable(datedStoredReading(row.quic_measured, row.quic_measured_at));
    const quicProbe = showable(datedStoredReading(row.stored_quic_probe, row.stored_quic_probe_at));
    const udpProbe = showable(datedStoredReading(row.stored_udp_probe, row.stored_udp_probe_at));
    const readings: ServerCapabilityReadings = {
      ...(quicMeasured !== undefined ? { quicMeasured } : {}),
      ...(quicProbe !== undefined ? { quicProbe } : {}),
      ...(udpProbe !== undefined ? { udpProbe } : {}),
    };
    // The pre-check keeps `written` honest and a poll from taking the lock for
    // nothing; the writer decides again under the lock.
    if (Object.keys(serverCapabilityReadingsToAdopt(cache[p.id], readings)).length === 0) continue;
    try {
      cache = await seedServerCapabilityReadings(p.id, readings);
      written.push(p.id);
    } catch {
      /* best-effort — the next refresh retries */
    }
  }
  return written;
}

/**
 * D2 — fetch the account proxy list and adopt what the SERVER holds for these
 * rows: the exit it last observed (above) and (p) the OS reading it stored. The
 * views call this fire-and-forget from their refresh; it is `async` so every
 * failure — offline, a 5xx, a mocked-away transport — is a rejection the caller
 * swallows, never a throw inside the refresh that would read as "couldn't load
 * proxies". Skips the request entirely when NO local proxy is synced to the server
 * at all: there would be nothing to adopt either way.
 *
 * ⛔ (p) — the skip used to require a VPN row, because an exit was the only thing
 * worth fetching for. A SOCKS5 row has an OS reading and no exit to adopt, so that
 * condition now excludes exactly the rows this item exists for.
 *
 * The exit adoption runs FIRST on purpose: it is the one that creates a VPN row's
 * endpoint entry, and the reading then lands on top of a real entry rather than on
 * a seeded one.
 */
export async function syncListExitObserved(
  baseUrl: string,
  apiKey: string | null,
  proxies: ReadonlyArray<ListExitProxyLike>,
  nowMs: number = Date.now(),
): Promise<string[]> {
  if (apiKey === null || apiKey.length === 0) return [];
  if (!proxies.some((p) => p.serverId !== undefined)) return [];
  // `nowMs` is taken BEFORE the request (the default binds at the call), so
  // the adoption's K3 guard compares a local stamp with the fetch's start.
  // ⛔ ONE gate for all three adoptions, so they agree about which rows were edited
  // (a mark that lands between two of them would otherwise split one row's
  // readings). The ledger is read on BOTH sides of the request and a row marked in
  // either is refused: after, because an edit saved while the request was in
  // flight is one the list predates; before, because the view sends this request
  // and THEN the store that lifts the mark, and a list answered from before that
  // store can arrive after the lift. Unreadable on either side = nothing is
  // adopted for anyone, and before = no request at all.
  const entry = await enterListAdoption();
  if (entry === null) return [];
  const rows = await listAccountProxies(baseUrl, apiKey);
  const gate = await openListAdoptionGate(entry);
  if (gate === null) return [];
  const exits = await adoptListExitObserved(rows, proxies, nowMs, gate);
  const readings = await adoptListOsFingerprint(rows, proxies, nowMs, gate);
  // …and the QUIC / UDP readings last, for the reason the OS one follows the exit:
  // they land on the real entry the exit adoption made, not on a seeded one.
  const capabilities = await adoptListCapabilityReadings(rows, proxies, nowMs, gate);
  return [...new Set([...exits, ...readings, ...capabilities])];
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
    // ⛔ (V-219) AGED HERE TOO. This overlay re-adds the fields
    // `deriveProbeViewState` dropped for a VPN row, and it must re-add them
    // under the SAME rules — an overlay that restores a field the TTL just
    // removed makes the TTL true of SOCKS5 rows and false of VPN rows, with
    // nothing in either function saying so. The asymmetry was visible on the
    // very next line, which has aged its QUIC verdict since W-30.
    //
    // `isOsFingerprintFresh` keeps a CAUSE regardless of age, so the
    // `vpn_tunnel` placeholder these rows normally carry still renders.
    //
    // …and the AGED arm rides under each fresh one here exactly as it does in the
    // base derivation, for the same reason turned around: an overlay that knew
    // only the fresh maps would make the aged state true of SOCKS5 rows and
    // silently absent for tunnels.
    if (c.osFingerprint !== undefined) {
      if (isOsFingerprintFresh(c.osFingerprint, nowMs)) view.osFingerprints[id] = c.osFingerprint;
      else if (isAgedReadingShowable(c.osFingerprint.at, nowMs))
        view.aged.osFingerprints[id] = { value: c.osFingerprint, atMs: c.osFingerprint.at };
    }
    if (c.serverLatencyMs !== undefined) {
      view.serverLatency[id] = c.serverLatencyMs;
      // ⛔ The date travels WITH the number here too. This overlay runs after the
      // base derivation dropped it for a VPN row, so a number re-added without
      // its stamp is one the sheet can only render as current.
      if (typeof c.serverProbeAt === 'number') view.serverMeasuredAt[id] = c.serverProbeAt;
    }
    if (c.quicMeasured !== undefined) {
      if (isQuicVerdictFresh(c.quicMeasuredAt, nowMs)) view.quicMeasured[id] = c.quicMeasured;
      else if (c.quicMeasuredAt !== undefined && isAgedReadingShowable(c.quicMeasuredAt, nowMs))
        view.aged.quicMeasured[id] = { value: c.quicMeasured, atMs: c.quicMeasuredAt };
    }
    if (c.measuredFrom !== undefined)
      view.serverVantage[id] = {
        measuredFrom: c.measuredFrom,
        ...(c.nodeId !== undefined ? { nodeId: c.nodeId } : {}),
      };
    if (c.quicProbe !== undefined) {
      if (isQuicProbeFresh(c.quicProbeAt, nowMs)) view.quicProbe[id] = c.quicProbe;
      else if (c.quicProbeAt !== undefined && isAgedReadingShowable(c.quicProbeAt, nowMs))
        view.aged.quicProbe[id] = { value: c.quicProbe, atMs: c.quicProbeAt };
    }
    // (V6 2026-09-16) ITEM 3 — and the UDP-relay verdict beside it. This overlay is
    // the ONLY way a VPN row's fleet fields reach a surface (its placeholder
    // `result` is never usable), so a field added to the base derivation and not
    // here is a field that works for SOCKS5 rows and silently does not exist for
    // tunnels — which are the rows this measurement was added for.
    //
    // ⛔ …and it ages the verdict the SAME way the base derivation does (refuter
    // #5). An overlay that re-adds a field the TTL just removed makes the TTL true
    // of SOCKS5 rows and false of VPN rows — with nothing in either function saying
    // so, and for the rows this measurement was added for. The asymmetry is already
    // spelled out two lines up for the QUIC verdict; this is the same rule.
    if (c.udpProbe !== undefined) {
      if (isUdpVerdictFresh(c.udpProbeAt, nowMs)) view.udpProbe[id] = c.udpProbe;
      else if (c.udpProbeAt !== undefined && isAgedReadingShowable(c.udpProbeAt, nowMs))
        view.aged.udpProbe[id] = { value: c.udpProbe, atMs: c.udpProbeAt };
    }
    if (c.exitIp !== undefined) {
      view.exitResults[id] = {
        ip: c.exitIp,
        country: c.exitCountry ?? null,
        ...(c.exitCity !== undefined ? { city: c.exitCity } : {}),
        ...(c.exitRegion !== undefined ? { region: c.exitRegion } : {}),
        ...(c.exitTimezone !== undefined ? { timezone: c.exitTimezone } : {}),
        ...(c.exitAsnOrg !== undefined ? { asn_org: c.exitAsnOrg } : {}),
      };
      // ⛔ The date travels WITH the address, here as well as in the base
      // derivation. This overlay runs AFTER that one and re-adds what it dropped
      // for a VPN row, so an address added back without its stamp is an address a
      // surface can only render as current — which is the whole defect, restored
      // for exactly the rows nobody tested.
      if (typeof c.exitAt === 'number') view.exitSeenAt[id] = c.exitAt;
    }
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
 * (h) finding 3 — the fleet's failure sentence per proxy id, read from the
 * cache so EVERY surface that subscribes to it (the Proxies grid, the profile
 * card) renders the same verdict whichever view ran the check, and a remounted
 * grid does not forget a verdict the cache still holds. Present for any entry
 * whose last fleet answer was a failure; cleared by the cache writers that
 * record a later verdict or a later exit (`saveServerProbeResult`,
 * `saveExitResult`, `clearFleetFailure`), so a sentence still in the store is
 * current by construction.
 *
 * ⛔ This used to require `entry.endpoint !== undefined`, i.e. VPN/HTTP rows
 * only — written when a fleet failure could only belong to a tunnel. (P2)
 * then made a SOCKS5 row's fleet failure a first-class verdict everywhere ELSE:
 * `saveFleetFailure` persists the sentence for ANY row, `applyServerProbeOutcome`
 * puts it on the row the moment the fleet answers, and the pill, the red
 * sentence, the missing-side word, the sort rank and the hero's "needs
 * attention" are all un-gated on the scheme. The hydrator was the one half left
 * behind, so the verdict lived exactly as long as the mount that produced it.
 * MEASURED in the running harness (real ProxiesView, real CSS) on 2026-09-12:
 * a reopened SOCKS5 row whose cache entry held `fleetFailureReason` rendered a
 * green `healthy from this Mac` with the missing side reading `not tested` +
 * "The Mac that runs your profiles has not measured this proxy yet" — a claim
 * about our own instrument that the entry beside it contradicted. Pinned by
 * tests/unit/a-proxy-row-names-both-vantages.test.tsx ("survives a REMOUNT").
 */
export function fleetFailureReasons(cache: ProbeCacheMap): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, c] of Object.entries(cache)) {
    if (c.fleetFailureReason === undefined) continue;
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
      // The account holds this Mac's material again — see `invalidateProbe`.
      await clearCapabilityMaterialUnsynced(p.id).catch(() => undefined);
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
  await clearCapabilityMaterialUnsynced(p.id).catch(() => undefined);
  return { id: created.id, created: true, healed };
}

/** (q) Item 12-memory (A) — the SOCKS5 Test's notice when there is no API key:
 *  the native verdict stands, and the row says which legs did NOT run and why,
 *  instead of a silent '~' QUIC chip whose hint says "run Test" — the loop the
 *  customer was already in. The next step is the one control the GUI has. */
export const SOCKS5_TEST_NO_API_KEY_NOTICE = `Tested from this computer only. ${MISSING_API_KEY_NEXT_STEP} for the full check — QUIC, OS and server latency.`;

/** What the SOCKS5 Test's fleet leg did (`testSocks5RowOnServer`). */
export type Socks5FleetLeg =
  /** The fleet measured this Mac's row as it stands. */
  | { kind: 'tested'; outcome: ServerProbeOutcome; ensured: EnsuredAccountProxy | undefined }
  /** The row could not be pushed and the account's copy may be an older one, so
   *  the fleet was not asked. `error` is the push's own failure. */
  | { kind: 'not_stored'; error: unknown }
  /** Nothing to test on the account (no key, or the row was deleted meanwhile). */
  | { kind: 'no_row' }
  /** The row was edited on this Mac while the fleet measured; the reply
   *  describes the endpoint before the edit and is dropped. */
  | { kind: 'edited_meanwhile' };

/**
 * ⛔ Proxy-accuracy audit G3 (paths-05) — the SOCKS5 Test's fleet leg, in the ONE
 * order that makes its reply describe this Mac's row. The grid and the card both
 * come through here.
 *
 * The server tests the row the ACCOUNT holds. The Test used to push local changes
 * only for a row never stored, so after an edit and Save the fleet measured the
 * OLD host and credentials, and its latency, QUIC and failure landed beside the new
 * endpoint's native result as if both described it. Now:
 *   1. the row is pushed first, every time (for a stored row that is the PUT the
 *      next launch would have sent; it also lifts `materialUnsynced`);
 *   2. if that push fails for a row edited here, the fleet is not asked — the
 *      account's copy is the old endpoint. An UNEDITED stored row still is: the
 *      account holds exactly this material, and a transient PUT failure changes
 *      nothing about it;
 *   3. a reply that returns after the row was edited again on this Mac is dropped.
 */
export async function testSocks5RowOnServer(
  p: ProxyConfig,
  baseUrl: string,
  apiKey: string,
  ensure: (row: ProxyConfig) => Promise<EnsuredAccountProxy | undefined> = (row) =>
    ensureAccountProxyRow(row, baseUrl, apiKey),
): Promise<Socks5FleetLeg> {
  // Taken BEFORE the push: an edit saved at any moment after this is one the
  // fleet's reply cannot describe.
  const editsBefore = materialEditCountNow();
  let ensured: EnsuredAccountProxy | undefined;
  let serverId: string | undefined;
  try {
    ensured = await ensure(p);
    serverId = ensured?.id;
  } catch (error) {
    if (p.serverId === undefined || (await editedOnThisMac(p.id))) {
      return { kind: 'not_stored', error };
    }
    serverId = p.serverId;
  }
  if (serverId === undefined) return { kind: 'no_row' };
  const outcome = await testProxyOnServer(baseUrl, apiKey, serverId);
  if (materialEditedAfter(p.id, editsBefore)) return { kind: 'edited_meanwhile' };
  return { kind: 'tested', outcome, ensured };
}

/** Whether this row holds material the account may not: edited in this app
 *  session, or marked unsynced by an edit before a restart. A ledger that will
 *  not read cannot vouch for the row, so it counts as edited. */
async function editedOnThisMac(proxyId: string): Promise<boolean> {
  if (materialEditsPending().has(proxyId)) return true;
  const attempts = await loadCapabilityAttempts().catch(() => null);
  if (attempts === null) return true;
  return attempts[proxyId]?.materialUnsynced === true;
}

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
  return `Tested from this computer only. Couldn't store this proxy on your account, so the full check (QUIC, OS, server latency) did not run.${said}`;
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
        notice: `Address found. ${DESKTOP_CREDENTIAL_FLEET_TEST_REASON}`,
        tally: DESKTOP_CREDENTIAL_TALLY_REASON,
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
    notice: `Address found. Couldn't save this VPN to your account, so it was not tested.${said}`,
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
  // ⛔ NEVER BESIDE A CAPABILITY RUN — see `isCapabilityRunInFlight`. The address
  // check above has run and stands; only the server test waits. Not stamped: the
  // row stays due, and the run's own plan or the next sweep takes it, from the one
  // purse. (Nothing between this line and the test's own stamp can start a run: the
  // app calls this from inside a sweep only, and a run does not start while a
  // sweep is in flight.)
  if (isCapabilityRunInFlight()) return;
  // ⛔ THE ADDRESS CHECK ABOVE RUNS ON THE SWEEP'S WINDOW; THE SERVER TEST BELOW
  // RUNS ON THE AUTOMATIC CHECK'S, and the two were one until this was measured.
  // The sweep's window is twenty minutes on every window focus, five rows a run; a
  // VPN server test brings a tunnel up for up to 95 s on a machine every customer
  // shares. Gated only by that window, every alt-tab re-tested every saved VPN
  // row — round the capability check's one-VPN cap and its six-hour backoff, and
  // (on an account whose plan excludes it) one refused request per row per focus,
  // for ever. So this leg obeys the SAME ledger, the same two clocks
  // (`isAutomaticServerCheckDue`) and the same purse (`capabilityBudgetLeft`) as
  // the capability run, and a row whose material the account does not hold yet
  // (`materialUnsynced`) is left alone for the reason the planner gives.
  //
  // ⛔ A ledger that cannot be read means the leg does not run: answered as "never
  // attempted" it would be the unbounded dial. The address check above stands.
  let attempts: CapabilityAttemptMap;
  let cache: ProbeCacheMap;
  let rows: ReadonlyArray<ProxyConfig>;
  try {
    [cache, attempts, rows] = await Promise.all([
      loadProbeCache(),
      loadCapabilityAttempts(),
      listLocalProxies(),
    ]);
  } catch {
    return;
  }
  const attempt = attempts[p.id];
  if (attempt?.materialUnsynced === true) return;
  if (!isAutomaticServerCheckDue(cache[p.id], attempt, now())) return;
  const budget = capabilityBudgetLeft(attempts, rows, now());
  if (budget.rows <= 0 || budget.vpn <= 0) return;
  const outcome = await testStoredRowAutomatically(p, creds.baseUrl, creds.apiKey, now);
  if (outcome === null) return;
  if (isAccountRefusal(outcome)) {
    // A fact about the ACCOUNT: every stored row would be refused identically.
    const stored = rows.filter((row) => row.serverId !== undefined).map((row) => row.id);
    await recordCapabilityAttempt([...new Set([p.id, ...stored])], now(), true).catch(
      () => undefined,
    );
  }
  await persistAutomaticServerProbe(p, outcome, now);
}

// ─── The automatic capability check, and the installed schedule's wiring ─────

/** The not_run answers that refuse the ACCOUNT rather than the row: its plan, or
 *  the credential it signed in with ("retrying with this credential cannot change
 *  it"). Both back every row off for the long window. */
function isAccountRefusal(outcome: ServerProbeOutcome): boolean {
  return (
    outcome.kind === 'not_run' &&
    (outcome.why === 'plan_excluded' || outcome.why === 'desktop_credential')
  );
}

/** What of a local row decides WHICH endpoint a server test measured. */
function rowIdentity(p: ProxyConfig): string {
  return JSON.stringify([
    p.scheme ?? null,
    p.host,
    p.port,
    p.username,
    p.password,
    p.serverId ?? null,
    p.openvpn ?? null,
    p.wireguard ?? null,
  ]);
}

/**
 * The one automatic server test of a row the account ALREADY holds — shared by
 * the capability check and the sweep's VPN check. Returns null when nothing may
 * be persisted:
 *
 *   • the row is being tested right now by someone else (their answer is the
 *     fresher one; nothing is stamped, nothing is asked);
 *   • the backoff stamp could not be written (⛔ a check nothing bounds);
 *   • ⛔ THE ROW CHANGED WHILE THE TEST WAS IN FLIGHT. A test lasts 11–95 s and
 *     cannot push local changes (the consent rule), so it measured whatever the
 *     account held when it started. The manual paths discard such a reply by
 *     epoch; this path had no guard, and an edit of the host mid-check landed the
 *     OLD endpoint's OS / QUIC / UDP readings (and a VPN's exit) on the edited
 *     row — where the re-test's own write then carried them forward as current.
 *     The row is re-read AFTER the reply and the reply is dropped when the row is
 *     gone or is no longer the one that was asked about.
 */
async function testStoredRowAutomatically(
  p: ProxyConfig,
  baseUrl: string,
  apiKey: string,
  now: () => number,
): Promise<ServerProbeOutcome | null> {
  if (p.serverId === undefined || isServerTestInFlight(p.serverId)) return null;
  try {
    await recordCapabilityAttempt([p.id], now());
  } catch {
    return null;
  }
  const asked = rowIdentity(p);
  const outcome = await testProxyOnServer(baseUrl, apiKey, p.serverId, now);
  let current: ProxyConfig | undefined;
  try {
    current = (await listLocalProxies()).find((row) => row.id === p.id);
  } catch {
    return null;
  }
  if (current === undefined || rowIdentity(current) !== asked) return null;
  return outcome;
}

/**
 * Persist what an AUTOMATIC check came back with — `persistServerProbe`, the
 * shared step the manual paths use, under two extra rules.
 *
 * ⛔ A ROW WITH NO LOCAL VERDICT ADOPTS A SUCCESS AND NOTHING ELSE. Such a row
 * (no entry, or the `serverSeeded` placeholder the list adoption invents) has
 * never been tested on this Mac, and the customer did not ask for this check. An
 * `ok` reply's readings land on a seeded entry, which asserts nothing about
 * reachability. A `failed` or `not_run` reply writes NOTHING: `saveFleetFailure`
 * rebuilds the entry it is given WITHOUT the `serverSeeded` mark, so the
 * fail-closed placeholder would come back as an ordinary verdict — a red "not
 * reachable" pill and a "could not connect" sentence on a proxy nobody here has
 * tested, painted by a timer. That is the thing `planSweep`'s never-tested rule
 * exists to prevent, arriving through the other door.
 *
 * ⛔ AND A VPN ROW THE CUSTOMER ONLY EVER ADDRESS-CHECKED IS NOT PAINTED "TUNNEL
 * DOWN" BY A TIMER EITHER. A resolved address check is a local verdict, but it
 * says the name resolves — the customer never asked whether the tunnel comes up
 * (the row can be on the account from a launch). A `failed` reply is written only
 * onto an entry that already holds an answer of that kind (`holdsFleetVerdict`):
 * there it replaces a "tunnel up" that has stopped being true.
 *
 * Otherwise a row that HAS a local verdict is persisted exactly as its manual
 * check would be (`adoptExit` for a VPN row, whose only exit is the one
 * Driftstack observes). After a full answer, a reading the row should have and
 * still lacks is recorded as one this proxy does not produce (the planner's
 * `readingsNotProducedAt` rule); a full answer that leaves none missing lifts it.
 */
export async function persistAutomaticServerProbe(
  p: Pick<ProxyConfig, 'id' | 'scheme'>,
  outcome: ServerProbeOutcome,
  now: () => number = () => Date.now(),
): Promise<ProbeCacheMap | null> {
  if (outcome.kind === 'unavailable') return null;
  let entry: CachedProbe | undefined;
  try {
    entry = (await loadProbeCache())[p.id];
  } catch {
    return null;
  }
  const hasLocalVerdict =
    entry !== undefined && verdictMatchesScheme(isSocks5Probeable(p.scheme), entry);
  let written: ProbeCacheMap | null;
  if (hasLocalVerdict) {
    const vpn = isVpnScheme(p.scheme);
    // ⛔ G2 — on every scheme: a timer writes a failure only over an earlier
    // Driftstack answer it replaces, never onto a row nobody asked Driftstack about.
    if (outcome.kind === 'failed' && !holdsFleetVerdict(entry)) return null;
    written = await persistServerProbe(p.id, outcome, { adoptExit: vpn });
  } else {
    if (outcome.kind !== 'ok') return null;
    // A no-op when a (seeded, or wrong-kind) entry is already there.
    await ensureServerSeededEntry(p.id, outcome.at).catch(() => null);
    written = await persistServerProbe(p.id, outcome);
  }
  if (outcome.kind === 'ok') {
    // Judged on the entry AS WRITTEN. No entry (the writes did not land, or the
    // cache could not be read — `loadProbeCache` answers `{}` then) says nothing
    // about what the reply produced, so nothing is noted either way.
    const entryAfter = (written ?? (await loadProbeCache()))[p.id];
    if (entryAfter !== undefined) {
      await noteCapabilityReadingsNotProduced(
        p.id,
        hasUnmeasuredCapabilityReading(p, entryAfter, now()) ? now() : undefined,
      ).catch(() => undefined);
    }
  }
  return written;
}

/**
 * The automatic capability check of ONE row: ask Driftstack to test the row it
 * ALREADY holds, persist what it says, and report what the run needs to know.
 *
 * ⛔⛔ IT NEVER UPLOADS, and the asymmetry with the two user-initiated checks is
 * the rule — the note in `checkEndpointRowForSweep` above is the whole argument.
 * No `ensureAccountProxyRow`, no create, no update: a row with no `serverId` is
 * answered "nothing asked" without a request, because its credentials are
 * device-only until the customer's own Test sends them. The planner never plans
 * such a row; this guard is the second belt, for a caller that is not the planner.
 */
export async function checkCapabilitiesForRow(
  p: ProxyConfig,
  creds: { baseUrl: string; apiKey: string | null },
  now: () => number = () => Date.now(),
): Promise<CapabilityCheckResult> {
  if (creds.apiKey === null || creds.apiKey.length === 0 || p.serverId === undefined)
    return { answered: false, accountRefused: false };
  const asked = rowIdentity(p);
  const outcome = await testProxyOnServer(creds.baseUrl, creds.apiKey, p.serverId, now);
  // ⛔ The reply is about the row AS IT WAS ASKED ABOUT — see
  // `testStoredRowAutomatically`, whose guard this is (the run stamps the ledger
  // and looks for a test in flight itself, before it calls).
  const current = await listLocalProxies()
    .then((rows) => rows.find((row) => row.id === p.id))
    .catch(() => undefined);
  if (current !== undefined && rowIdentity(current) === asked) {
    await persistAutomaticServerProbe(p, outcome, now);
  }
  return {
    answered: outcome.kind !== 'unavailable',
    accountRefused: isAccountRefusal(outcome),
  };
}

/** Where the installed schedule reads the account from — a FUNCTION, called at
 *  each run, so a key entered after launch (or a sign-out) is what the run sees. */
export type ReadSweepCreds = () => { baseUrl: string; apiKey: string | null };

/** The capability run's production deps. */
export function capabilityRefreshDeps(readCreds: ReadSweepCreds): CapabilityRefreshDeps {
  return {
    loadCache: loadProbeCache,
    loadAttempts: loadCapabilityAttempts,
    listProxies: listLocalProxies,
    readCreds,
    recordAttempt: recordCapabilityAttempt,
    pruneAttempts: pruneCapabilityAttempts,
    check: (p, creds) => checkCapabilitiesForRow(p, creds),
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
  };
}

/** The automatic capability check as the app runs it — from the schedule below
 *  and from the Proxies tab opening. Single-flight and backed off inside
 *  `runCapabilityRefresh`, so both callers can fire and forget. */
export function runInstalledCapabilityRefresh(
  readCreds: ReadSweepCreds,
): Promise<CapabilityRefreshReport> {
  return runCapabilityRefresh(capabilityRefreshDeps(readCreds));
}

/**
 * The reachability sweep's production deps FOR ONE RUN.
 *
 * ⛔ Built per run, from the run, because both halves of that were dropped once.
 * The wiring in App.tsx built its deps at mount with no `checkEndpoint` — so
 * every VPN / HTTP row was excluded from every sweep, although
 * `checkEndpointRowForSweep` exists for exactly that — and called
 * `runSweep(deps)` from a `sweep()` that ignored its argument, so the app-open
 * and focus triggers' short window (`ACTIVE_SWEEP_STALE_MS`) was discarded and
 * everything waited the six-hour TTL. Each half had tested machinery behind it
 * and neither was connected. This is the connection, in a function a test can
 * call: tests/unit/the-installed-sweep-passes-its-window-and-checks-vpn-rows.
 */
export function installedSweepDeps(run: SweepRun, readCreds: ReadSweepCreds): SweepDeps {
  return {
    loadCache: loadProbeCache,
    listProxies: listLocalProxies,
    testProxy: (px) =>
      testProxyNatively({
        host: px.host,
        port: px.port,
        username: px.username,
        password: px.password,
      }),
    saveResult: saveProbeResult,
    now: () => Date.now(),
    sleep: (ms) => new Promise<void>((r) => setTimeout(r, ms)),
    checkEndpoint: (px) => checkEndpointRowForSweep(px, readCreds()),
    staleAfterMs: run.staleAfterMs,
  };
}

/**
 * What the installed schedule runs on each trigger: the reachability sweep with
 * the trigger's window, THEN the capability check — after, never beside, so the
 * sweep's fresh verdicts (and the server tests its VPN rows just ran) are what
 * the capability plan reads, and one customer's proxies are never dialled by two
 * loops at once. Never rejects: both halves are best-effort background work.
 *
 * ⛔ "After" holds for a SKIPPED sweep too, and not by anything written here. A
 * trigger that lands while another sweep is still probing (a focus event during
 * the interval's sweep) gets `skipped` back from `runSweep` AT ONCE, and the line
 * below then runs beside that sweep — which is why `runCapabilityRefresh` itself
 * answers `skipped` while a sweep is in flight. The rule lives there so the OTHER
 * trigger (the Proxies tab opening) obeys it as well; the sweep that is running
 * makes its own follow-up call when it ends.
 */
export async function runInstalledSweep(run: SweepRun, readCreds: ReadSweepCreds): Promise<void> {
  await runSweep(installedSweepDeps(run, readCreds)).catch(() => undefined);
  await runInstalledCapabilityRefresh(readCreds).catch(() => undefined);
}
