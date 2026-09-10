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
  listProxies as listAccountProxies,
  testAccountProxy,
  type AccountProxyExitObserved,
  type AccountProxyMeta,
  type AccountProxyScheme,
  type AccountProxyTestNotRun,
  type AccountProxyTestResult,
  type MeasuredQuic,
} from './account-proxies';
import type { OsFingerprint } from './os-fingerprint-verdict';
import { isProxyUsable, resolveEndpoint } from './proxies';
import { isVpnScheme } from './proxy-scheme';
import {
  deriveProbeViewState,
  isQuicVerdictFresh,
  loadProbeCache,
  saveEndpointResult,
  saveExitResult,
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
 * Persist an `ok` outcome onto the proxy's cache entry. `failed` and
 * `unavailable` write nothing — the native probe's entry stands, and the views
 * decide what to drop from their own state. (d) A `not_run` outcome writes no
 * measurement either (there is none), but the live-session refusal's observed
 * exit IS adopted when the caller asks (`adoptExit`, VPN rows) — it is the exit
 * the row has right now, seen by the session that holds the tunnel. Returns the
 * cache after the last successful write, or null when nothing was written.
 */
export async function persistServerProbe(
  proxyId: string,
  outcome: ServerProbeOutcome,
  opts: { adoptExit?: boolean } = {},
): Promise<ProbeCacheMap | null> {
  if (outcome.kind === 'not_run') {
    if (opts.adoptExit !== true || outcome.exitObserved === undefined) return null;
    let cache: ProbeCacheMap;
    try {
      cache = await loadProbeCache();
    } catch {
      return null;
    }
    return adoptObservedExit(proxyId, cache[proxyId], outcome.exitObserved, outcome.at);
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
  rows: ReadonlyArray<Pick<AccountProxyMeta, 'id' | 'exit_observed'>>,
  proxies: ReadonlyArray<ListExitProxyLike>,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const written: string[] = [];
  const byServerId = new Map<string, Pick<AccountProxyMeta, 'id' | 'exit_observed'>>();
  for (const r of rows) byServerId.set(r.id, r);
  let cache: ProbeCacheMap;
  try {
    cache = await loadProbeCache();
  } catch {
    return written;
  }
  for (const p of proxies) {
    if (p.serverId === undefined || !isVpnScheme(p.scheme)) continue;
    const e = byServerId.get(p.serverId)?.exit_observed;
    if (e === null || e === undefined) continue;
    let existing = cache[p.id];
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
    const parsed = e.observed_at === null ? Number.NaN : Date.parse(e.observed_at);
    const at = Number.isFinite(parsed) ? parsed : nowMs;
    const sameIp = existing.exitIp === e.ip;
    // ⛔ Never REWIND, regardless of ip or geo: an observation OLDER than the
    // exit already stored describes an earlier state of the tunnel, and the
    // stored one (a fleet test's, or a fresher session's) already superseded
    // it. The old rule only refused a rewind of the SAME ip/geo, so a list row
    // still carrying last week's exit could overwrite the exit a fleet test
    // measured minutes ago whenever the two ips differed.
    const rewind = existing.exitAt !== undefined && at < existing.exitAt;
    // …and never CHURN: the same identity at the same (or an older) stamp is
    // a no-op, so a 15s poll does not rewrite the store every tick.
    const unchanged =
      sameIp &&
      (existing.exitCountry ?? null) === e.country &&
      (existing.exitTimezone ?? null) === e.timezone &&
      existing.exitAt !== undefined &&
      existing.exitAt >= at;
    if (rewind || unchanged || isExitDowngrade(existing, e)) continue;
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
