// Proxy probe-result cache — night-arc B (2026-06-12).
//
// The native SOCKS5 probe result (reachability / auth / UDP-associate /
// latency) was previously view-local state in ProxiesView, so profile
// cards couldn't show egress capability. This persists the LAST result
// per proxy id in its own store file so any surface can render it —
// with the honest "untested" state when a proxy has never been probed.
//
// Same store-isolation rationale as profiles-meta.ts: settings.json is
// drift-pinned + owns the key lifecycle; cache data stays out of that
// blast radius. Corrupt/missing entries degrade to "untested".

import { LazyStore } from '@tauri-apps/plugin-store';
import { makeWriteLock } from './store-write-lock';
import { isProxyUsable, type ProxyExitProbeResult, type ProxyTestResult } from './proxies';
import { cleanMeasuredQuic, type MeasuredQuic } from './account-proxies';
import {
  isFingerprintConfidence,
  isFingerprintedOs,
  isOsFingerprintUnavailable,
  type OsFingerprint,
} from './os-fingerprint-verdict';
import { cleanServerVantage, type ProxyVantage, type ServerVantage } from './proxy-vantage';
import {
  attributeSessionProxy,
  makeH3ObservationLedger,
  parseH3Observation,
  type H3BindingLike,
} from './session-h3-observation';

/** N-2 — the control plane's passive OS fingerprint of the proxy's own stack,
 *  with when it was recorded. */
export interface CachedOsFingerprint extends OsFingerprint {
  at: number;
}

/** T-20 — the verdict of a VPN/HTTP row's pre-flight, which is a DNS resolve of
 *  the endpoint (`endpoint_resolve`), not a SOCKS5 handshake. Field names match
 *  the native `EndpointResolveResult`. */
export interface CachedEndpointVerdict {
  resolved: boolean;
  ip: string;
  message: string;
}

export interface CachedProbe {
  result: ProxyTestResult;
  /** Epoch ms when the probe ran. */
  at: number;
  /** T-20 — present when the row's last check was an endpoint resolve rather
   *  than a SOCKS5 probe. `result` is then the fail-closed placeholder (never
   *  usable — see `ENDPOINT_PLACEHOLDER_RESULT`), so every derivation that reads
   *  `result` treats the entry as "not a SOCKS5 verdict", and a surface that
   *  wants to describe the check reads THIS. */
  endpoint?: CachedEndpointVerdict;
  /** E-2 exit-geo (optional — absent until the echo probe succeeds). */
  exitIp?: string;
  exitCountry?: string | null;
  /** T-17 — epoch ms when the exit-geo below was measured. `at` moves on every
   *  native re-test while the geo is preserved across them, so `at` cannot say
   *  how old the exit identity is. Absent on entries written before this field
   *  existed, which `isExitIdentityFresh` reads as NOT fresh. */
  exitAt?: number;
  /** (l) #14 — epoch ms when a native exit probe through a USABLE proxy did
   *  not complete (V-857's "exit geo unavailable" state). Written by
   *  `clearExitResult`, which also drops the exit fields, so a later cache
   *  emit from ANY writer (a fleet test's persist, the sweeper, a list
   *  adoption) reproduces the honest null state instead of re-hydrating the
   *  PREVIOUS exit beside "Tested just now". Cleared by the next exit write. */
  exitProbeFailedAt?: number;
  /** Geo enrichment (2026-06-15) from lumtest through the proxy — best-effort,
   *  absent when lumtest was unreachable. exitCountry stays the baseline. */
  exitCity?: string | null;
  exitRegion?: string | null;
  exitTimezone?: string | null;
  exitAsnOrg?: string | null;
  /** N-2 — absent until the control plane observed the proxy's SYN; preserved
   *  across capability re-tests like the exit-geo. */
  osFingerprint?: CachedOsFingerprint;
  /** T-1 — the SERVER-measured latency (ms) from the control plane's /test
   *  route, measured closer to the fleet than this Mac. Preferred for the
   *  displayed latency when present; preserved across native capability
   *  re-tests like the exit-geo and the OS fingerprint. */
  serverLatencyMs?: number;
  /** T-6 — the QUIC verdict MEASURED in a live session (closed set), with when
   *  it was recorded (epoch ms). Absent = never measured; the chip then stays
   *  inferred ('~') and never renders a green ✓. Preserved across re-tests. */
  quicMeasured?: MeasuredQuic;
  quicMeasuredAt?: number;
  /** T-1 — WHERE serverLatencyMs was measured: 'fleet' (the Mac that runs the
   *  profile; nodeId names it) or 'control_plane' (no fleet Mac was free — the
   *  honest fallback). Absent = a server number recorded before the vantage was
   *  reported, shown under today's plain "server" marker. Travels WITH the
   *  number: a new server result replaces all three, so a fleet label can never
   *  sit beside a control-plane latency. Preserved across native re-tests. */
  measuredFrom?: ProxyVantage;
  nodeId?: string;
  /** T-1 — the fleet Mac's standalone QUIC-relay verdict (true/false), separate
   *  from quicMeasured (a live session's HTTP/3) and never merged with it. */
  quicProbe?: boolean;
  /** (h) — epoch ms when the SERVER test that wrote serverLatencyMs / the
   *  vantage / quicProbe ran. `at` is the row's LAST check (for a VPN row the
   *  DNS pre-flight, which runs before every fleet test and is re-stamped even
   *  when the fleet then REFUSES to measure), so `at` beside a carried-over
   *  fleet number dated a measurement that never happened. Travels with the
   *  server fields: written with them, carried with them, dropped with them. */
  serverProbeAt?: number;
  /** (h) — epoch ms when a fleet test FAILED to bring this VPN tunnel up and
   *  so contradicted the exit the entry held. The exit fields are dropped at
   *  that moment; this stamp survives the next pre-flight and refuses any
   *  observation dated at or before it (the account list's `exit_observed`
   *  still carries the pre-failure session exit), so a dropped exit cannot
   *  be resurrected by a later cache emit. Cleared by the next exit write
   *  dated after it. */
  exitSupersededAt?: number;
  /** (h) finding 3 — the fleet's sentence for that failure ("The proxy did
   *  not answer…"), persisted beside the stamp so EVERY surface that reads
   *  the cache — the Proxies grid after a remount, the profile card for a
   *  Check that ran in the grid — renders the same "tunnel down", not only the
   *  view that happened to run the check. Written with `exitSupersededAt`,
   *  carried by the pre-flight with it, and cleared by the next fleet answer
   *  that is a verdict (`saveServerProbeResult`) or by an exit seen after the
   *  failure (`saveExitResult`); a `not_run` clears neither, because it said
   *  nothing about the tunnel. */
  fleetFailureReason?: string;
}

export type ProbeCacheMap = Record<string, CachedProbe>;

/**
 * How long a probe result is treated as still describing the proxy.
 *
 * Six hours is chosen against the ONE path that acts on the cache without
 * re-testing: bulk launch. Single launch always re-probes (`ProfilesView` —
 * "Re-test the proxy NOW rather than trusting whatever the cache remembers"),
 * but bulk deliberately skips that, because probing N proxies serially would
 * stall the batch. So the cache is load-bearing exactly there, and this bounds
 * how old a verdict a batch can act on.
 *
 * Not shorter: every expiry costs a real TCP + SOCKS5 handshake per proxy, and
 * a residential endpoint that rotates within six hours will be caught by the
 * launch-time gate anyway. Not longer: a lapsed plan or a changed ruleset is
 * invisible until something tests it, and "healthy" from last week is a claim
 * we cannot support.
 */
/** The three view-shaped maps both proxy surfaces render from. */
export interface ProbeViewState {
  testResults: Record<string, ProxyTestResult>;
  exitResults: Record<string, ProxyExitProbeResult | null>;
  testedAt: Record<string, number>;
  /** N-2 — only for proxies whose last capability probe was usable (the
   *  exit-geo rule): no OS verdict beside a red "unreachable" pill. */
  osFingerprints: Record<string, CachedOsFingerprint>;
  /** T-1 — the server-measured latency, surfaced only while the proxy is usable
   *  (same rule as the exit-geo: no server number beside a dead proxy). */
  serverLatency: Record<string, number>;
  /** T-6 — the measured QUIC verdict, surfaced only while the proxy is usable. */
  quicMeasured: Record<string, MeasuredQuic>;
  /** T-1 — where serverLatency was measured (+ the node), same usable-only rule. */
  serverVantage: Record<string, ServerVantage>;
  /** T-1 — the fleet Mac's QUIC-relay verdict, same usable-only rule. */
  quicProbe: Record<string, boolean>;
}

/**
 * Derive the render state from a cache snapshot. Pure, and extracted so the
 * mount path and the change-subscription path cannot drift apart — before P-8
 * this lived inline in `ProxiesView.refresh`, and a background sweep updating
 * the cache had no way to reuse it.
 *
 * ⛔ Exit-geo is re-hydrated ONLY when the last capability probe was healthy.
 * `saveProbeResult` deliberately preserves prior exit-geo across a failed
 * re-test (capability and exit probes are separate calls), so a proxy that was
 * healthy and then went down would otherwise render its old exit IP and country
 * flag beside a red "unreachable" pill — "exits from US 1.2.3.4" for a dead
 * proxy. This is the one rule in the derivation that is not a transcription.
 */
/**
 * W-30 — how long a MEASURED QUIC verdict stays current.
 *
 * ⛔ The verdict is written when a live session observes an HTTP/3 handshake, and
 * it never expired. The signal underneath it could not expire either: the node's
 * `h3ConnectionObserved` is backed by an insert-only set and can never return to
 * false, so "this proxy did h3 once" was being rendered as the MEASURED chip —
 * the strongest mark this UI makes, deliberately distinguished from the inferred
 * `~`. A relay that dies keeps its green tick for the life of the install.
 *
 * 1800s = SIX re-emit cadences. The fleet re-emits a capability report every 300s
 * ±20%, so the worst-case honest gap is 360s and six leaves five clear intervals
 * of slack. ⚠️ Deliberately generous, because the two errors are not symmetric:
 * downgrading a LIVE proxy to inferred is a visible wrong answer on a working
 * setup, while holding a stale verdict a few minutes longer is the state that
 * shipped for months. Better slow to weaken a claim than quick to make a false one.
 *
 * ⚠️ Derived from the BUILD cadence, not from observed arrival times: arrival
 * carries queue and `lsof` jitter the sweep's own gate never controls, and gaps of
 * 236s have been measured below the 240s build floor for that reason.
 */
export const QUIC_VERDICT_TTL_MS = 30 * 60 * 1000;

/**
 * Is a measured QUIC verdict still current?
 *
 * ⛔ An ABSENT timestamp is NOT fresh. We cannot establish when it was taken, and
 * "we could not tell" must render as the inferred `~` rather than as a pass —
 * the same rule the chip already applies to a never-measured proxy. It self-heals:
 * the next observation stamps a time.
 */
export function isQuicVerdictFresh(atMs: number | undefined, nowMs: number): boolean {
  if (typeof atMs !== 'number') return false;
  return nowMs - atMs < QUIC_VERDICT_TTL_MS;
}

/**
 * T-17 — how long a probed EXIT IDENTITY (ip / country / timezone) stays current.
 *
 * ⛔ `exitTimezone` never expired. The simulator's status-bar clock is set from
 * it at launch, so a residential exit that rotated to another zone since the
 * last probe put the wrong time on the device for the whole session — the
 * owner's #3. Thirty minutes matches `QUIC_VERDICT_TTL_MS` above: both describe
 * something measured THROUGH the proxy that the proxy can change underneath us,
 * and a launch is the one moment the value is acted on. Not shorter: every
 * re-probe is a real request through the proxy at the customer's cost.
 */
export const EXIT_IDENTITY_TTL_MS = 30 * 60 * 1000;

/** Is a probed exit identity still current? Same rule as the QUIC verdict: an
 *  ABSENT timestamp is not fresh — we cannot say when it was taken — and the
 *  launch path then re-probes once, which stamps one. */
export function isExitIdentityFresh(atMs: number | undefined, nowMs: number): boolean {
  if (typeof atMs !== 'number') return false;
  return nowMs - atMs < EXIT_IDENTITY_TTL_MS;
}

/**
 * T-20 — the `result` stored beside an endpoint verdict.
 *
 * Every field that could read as a SOCKS5 pass is false, so `isProxyUsable`
 * is false, no exit-geo / fingerprint / QUIC verdict is surfaced for it, and
 * a cache reader that predates `endpoint` sees a proxy that is not usable
 * rather than one that is. The message is the resolve's own sentence.
 */
export function endpointPlaceholderResult(endpoint: CachedEndpointVerdict): ProxyTestResult {
  return {
    reachable: false,
    auth_ok: false,
    udp_associate: false,
    can_route: false,
    connect_reply: 0xff,
    latency_ms: 0,
    message: endpoint.message,
  };
}

/**
 * T-20 — does a cached entry hold a verdict of the kind THIS row can earn?
 *
 * A SOCKS5 verdict on a VPN row is what the un-gated probe wrote before the
 * fix: a handshake the endpoint never speaks, recorded as "unreachable". It is
 * evidence about the probe, not the proxy, so a surface must read it as
 * untested and the auto-probe must run the right check in its place. The
 * reverse holds too: a row switched from VPN to SOCKS5 keeps an endpoint
 * verdict that says nothing about the listener it now is.
 */
export function verdictMatchesScheme(socks5Probeable: boolean, entry: CachedProbe): boolean {
  return socks5Probeable ? entry.endpoint === undefined : entry.endpoint !== undefined;
}

export function deriveProbeViewState(
  cache: ProbeCacheMap,
  nowMs: number = Date.now(),
): ProbeViewState {
  const testResults: Record<string, ProxyTestResult> = {};
  const exitResults: Record<string, ProxyExitProbeResult | null> = {};
  const testedAt: Record<string, number> = {};
  const osFingerprints: Record<string, CachedOsFingerprint> = {};
  const serverLatency: Record<string, number> = {};
  const quicMeasured: Record<string, MeasuredQuic> = {};
  const serverVantage: Record<string, ServerVantage> = {};
  const quicProbe: Record<string, boolean> = {};
  for (const [id, c] of Object.entries(cache)) {
    testResults[id] = c.result;
    if (typeof c.at === 'number') testedAt[id] = c.at;
    if (c.osFingerprint !== undefined && isProxyUsable(c.result))
      osFingerprints[id] = c.osFingerprint;
    if (c.serverLatencyMs !== undefined && isProxyUsable(c.result))
      serverLatency[id] = c.serverLatencyMs;
    // W-30 — a verdict older than its TTL is dropped here rather than at the chip,
    // so every consumer ages identically: the Proxies grid, the profile card, and
    // anything added later. Falling out of this map is exactly "never measured",
    // which the chip already renders as the inferred `~`.
    if (
      c.quicMeasured !== undefined &&
      isProxyUsable(c.result) &&
      isQuicVerdictFresh(c.quicMeasuredAt, nowMs)
    )
      quicMeasured[id] = c.quicMeasured;
    // T-1 — the vantage only means something beside the server number it
    // labels, so it follows the same usable-only rule; the node id rides with it.
    if (c.measuredFrom !== undefined && isProxyUsable(c.result))
      serverVantage[id] = {
        measuredFrom: c.measuredFrom,
        ...(c.nodeId !== undefined ? { nodeId: c.nodeId } : {}),
      };
    if (c.quicProbe !== undefined && isProxyUsable(c.result)) quicProbe[id] = c.quicProbe;
    if (c.exitIp !== undefined && isProxyUsable(c.result)) {
      exitResults[id] = {
        ip: c.exitIp,
        country: c.exitCountry ?? null,
        ...(c.exitCity !== undefined ? { city: c.exitCity } : {}),
        ...(c.exitRegion !== undefined ? { region: c.exitRegion } : {}),
        ...(c.exitTimezone !== undefined ? { timezone: c.exitTimezone } : {}),
        ...(c.exitAsnOrg !== undefined ? { asn_org: c.exitAsnOrg } : {}),
      };
    } else if (c.exitProbeFailedAt !== undefined && isProxyUsable(c.result)) {
      // (l) #14 — V-857's third state, reproduced from the cache: the proxy
      // is usable and the exit probe did not complete. `null`, not absent, so
      // an emit renders "exit geo unavailable" rather than "run Test".
      exitResults[id] = null;
    }
  }
  return {
    testResults,
    exitResults,
    testedAt,
    osFingerprints,
    serverLatency,
    quicMeasured,
    serverVantage,
    quicProbe,
  };
}

export const PROBE_TTL_MS = 6 * 60 * 60 * 1000;

/** What a cached verdict is still worth. `untested` and `stale` are distinct:
 *  one has no evidence, the other has evidence we no longer trust, and the two
 *  deserve different words in front of a customer. */
export type ProbeFreshness = 'untested' | 'fresh' | 'stale';

/**
 * Classify a cached probe by age. Pure — `now` is injected — so every boundary
 * is testable without a clock.
 *
 * ⚠️ A timestamp in the FUTURE reads as fresh, which is what we want: it means
 * the host clock moved backwards (DST, an NTP correction, a VM resume), not
 * that the probe is old. Treating it as stale would re-probe every proxy the
 * customer owns on every clock adjustment.
 *
 * That behaviour falls out of the comparison — a negative age is below any
 * positive TTL — so there is deliberately NO special case for it here. An
 * earlier revision had an explicit `if (age < 0) return 'fresh'` guard; a
 * mutation test showed it could be deleted with no test failing, because it
 * could never change the result. It is gone rather than kept as decoration:
 * a branch that cannot alter behaviour still reads as load-bearing.
 */
export function probeFreshness(at: number | undefined, now: number): ProbeFreshness {
  if (at === undefined || !Number.isFinite(at)) return 'untested';
  return now - at >= PROBE_TTL_MS ? 'stale' : 'fresh';
}

/** True when a cached verdict is too old to present as current. `untested` is
 *  NOT stale — there is nothing to have gone off. */
export function isProbeStale(at: number | undefined, now: number): boolean {
  return isProbeStaleAfter(at, now, PROBE_TTL_MS);
}

/** (q) Item 13(c) — the same rule under a caller-chosen age: the sweep's
 *  app-open / focus triggers refresh rows older than a SHORT window (a green
 *  row probed 5 h ago that has since gone down stayed green on every open),
 *  while the steady interval and the display keep `PROBE_TTL_MS`. Same three
 *  answers as `probeFreshness`: undated / non-finite is NOT stale (nothing to
 *  have gone off), a future stamp is fresh (the clock moved, not the proxy). */
export function isProbeStaleAfter(at: number | undefined, now: number, ttlMs: number): boolean {
  if (at === undefined || !Number.isFinite(at)) return false;
  return now - at >= ttlMs;
}

// The "which proxies should a sweep refresh" selection lives ONLY in
// `planSweep` (proxy-probe-sweeper.ts). A simpler `staleProxyIds` used to sit
// here with zero callers; it was NOT a duplicate but a weaker version — it lacked
// the sweeper's three correctness exclusions (a deleted proxy's lingering entry,
// a non-SOCKS5 proxy a SOCKS5 handshake cannot probe informatively, and the
// failure-retry window), so any future caller reaching for it would have swept
// a customer's VPN fleet dead or probed a removed host. One selection, one
// definition: use `planSweep`.

const STORE_FILE = 'proxy-probe-cache.json';
const KEY = 'probes';

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
}

type ProbeCacheListener = (cache: ProbeCacheMap) => void;
const listeners = new Set<ProbeCacheListener>();

/**
 * Subscribe to cache writes. Returns an unsubscribe.
 *
 * Both views keep the cache in local state, and before this there was nothing
 * to tell them it had moved — so a background refresh would update the store
 * and leave every open surface rendering the OLD verdict. That is worse than
 * not sweeping at all: the customer would be reading a value we know to be
 * superseded while believing it current.
 */
export function subscribeProbeCache(fn: ProbeCacheListener): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Notify subscribers. Iterates a COPY, so a listener that unsubscribes itself
 *  during the callback cannot mutate the set mid-iteration; and a throwing
 *  listener is contained, because a broken subscriber must not turn a
 *  successful cache write into a failed one. */
function emitProbeCache(cache: ProbeCacheMap): void {
  for (const fn of [...listeners]) {
    try {
      fn(cache);
    } catch {
      /* a subscriber's fault is not the writer's problem */
    }
  }
}

// Serialize read-modify-write mutations so concurrent probes/invalidations
// can't clobber each other (defense-in-depth; the UI also gates one test at a
// time).
const writeLock = makeWriteLock();

/** N-2 — a stored fingerprint is kept only when every field is one the verdict
 *  can render; a value outside the closed set (a newer server, a corrupt store)
 *  drops the fingerprint, never the whole entry, and never defaults to green. */
function cleanOsFingerprint(raw: unknown): CachedOsFingerprint | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const f = raw as Record<string, unknown>;
  if (!isFingerprintedOs(f.os) || !isFingerprintConfidence(f.confidence)) return undefined;
  if (typeof f.reason !== 'string' || typeof f.at !== 'number') return undefined;
  // (o) O3 — the CAUSE survives the reload. This allowlist is the only way a field
  // outlives a load, so dropping it here would re-open the dead end on the next app
  // start: the placeholder would come back as a bare `os: 'unknown'` and the chip
  // would say "we looked and could not tell" about a row nothing ever looked at.
  // ⛔ `measuring` is deliberately NOT admitted — it is an in-flight UI sentinel, and
  // a persisted one would claim a probe was running across a restart.
  const unavailable = isOsFingerprintUnavailable(f.unavailable) ? f.unavailable : undefined;
  return {
    os: f.os,
    confidence: f.confidence,
    reason: f.reason,
    at: f.at,
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

/** T-20 — a stored endpoint verdict is kept only when every field is present
 *  and typed; anything else is undefined, never a half-verdict. */
function cleanEndpointVerdict(raw: unknown): CachedEndpointVerdict | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined;
  const e = raw as Record<string, unknown>;
  if (typeof e.resolved !== 'boolean' || typeof e.ip !== 'string' || typeof e.message !== 'string')
    return undefined;
  return { resolved: e.resolved, ip: e.ip, message: e.message };
}

function cleanEntry(raw: unknown): CachedProbe | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const r = raw as Record<string, unknown>;
  const res = r.result as Record<string, unknown> | undefined;
  if (typeof r.at !== 'number' || typeof res !== 'object' || res === null) return null;
  if (
    typeof res.reachable !== 'boolean' ||
    typeof res.auth_ok !== 'boolean' ||
    typeof res.udp_associate !== 'boolean' ||
    typeof res.latency_ms !== 'number' ||
    typeof res.message !== 'string'
  ) {
    return null;
  }
  const exitIp = typeof r.exitIp === 'string' ? r.exitIp : undefined;
  const exitCountry =
    typeof r.exitCountry === 'string' || r.exitCountry === null ? r.exitCountry : undefined;
  const optStr = (v: unknown): string | null | undefined =>
    typeof v === 'string' || v === null ? v : undefined;
  const exitCity = optStr(r.exitCity);
  const exitRegion = optStr(r.exitRegion);
  const exitTimezone = optStr(r.exitTimezone);
  const exitAsnOrg = optStr(r.exitAsnOrg);
  const osFingerprint = cleanOsFingerprint(r.osFingerprint);
  const serverLatencyMs = typeof r.serverLatencyMs === 'number' ? r.serverLatencyMs : undefined;
  // T-6 — a stored QUIC verdict outside the closed set is dropped, never coerced
  // (a corrupt store or a newer server must not resurrect as a green chip).
  const quicMeasured = cleanMeasuredQuic(r.quicMeasured) ?? undefined;
  const quicMeasuredAt =
    quicMeasured !== undefined && typeof r.quicMeasuredAt === 'number'
      ? r.quicMeasuredAt
      : undefined;
  // T-1 — a stored vantage outside the closed set is dropped (the number then
  // renders under the plain "server" marker), never shown under a label it did
  // not earn; the node id survives only beside 'fleet'. A stored relay verdict
  // is kept only as a boolean — a string "true" is not a measurement.
  const vantage = cleanServerVantage(r.measuredFrom, r.nodeId);
  const quicProbe = typeof r.quicProbe === 'boolean' ? r.quicProbe : undefined;
  // T-17 — the exit identity's own stamp; absent reads as "not fresh".
  const exitAt = typeof r.exitAt === 'number' ? r.exitAt : undefined;
  // (l) #14 — the failed-exit-probe stamp; same allowlist rule as below.
  const exitProbeFailedAt =
    typeof r.exitProbeFailedAt === 'number' ? r.exitProbeFailedAt : undefined;
  // (h) — the server test's own stamp, and the fleet-failure stamp that keeps
  // a dropped exit from being adopted back. ⛔ This allowlist is the ONLY way a
  // field survives a load: a field written but not read here is gone on the
  // next emit, which is exactly a superseded exit coming back.
  const serverProbeAt = typeof r.serverProbeAt === 'number' ? r.serverProbeAt : undefined;
  const exitSupersededAt = typeof r.exitSupersededAt === 'number' ? r.exitSupersededAt : undefined;
  const fleetFailureReason =
    typeof r.fleetFailureReason === 'string' && r.fleetFailureReason.length > 0
      ? r.fleetFailureReason
      : undefined;
  // T-20 — an endpoint verdict is kept only whole; a partial one is dropped and
  // the entry then reads as a (non-usable) SOCKS5 verdict, which is the
  // conservative reading for both kinds of row.
  const endpoint = cleanEndpointVerdict(r.endpoint);
  return {
    ...(endpoint !== undefined ? { endpoint } : {}),
    ...(exitIp !== undefined ? { exitIp } : {}),
    ...(exitCountry !== undefined ? { exitCountry } : {}),
    ...(exitAt !== undefined ? { exitAt } : {}),
    ...(exitProbeFailedAt !== undefined ? { exitProbeFailedAt } : {}),
    ...(exitCity !== undefined ? { exitCity } : {}),
    ...(exitRegion !== undefined ? { exitRegion } : {}),
    ...(exitTimezone !== undefined ? { exitTimezone } : {}),
    ...(exitAsnOrg !== undefined ? { exitAsnOrg } : {}),
    ...(osFingerprint !== undefined ? { osFingerprint } : {}),
    ...(serverLatencyMs !== undefined ? { serverLatencyMs } : {}),
    ...(quicMeasured !== undefined ? { quicMeasured } : {}),
    ...(quicMeasuredAt !== undefined ? { quicMeasuredAt } : {}),
    ...(vantage !== undefined ? { measuredFrom: vantage.measuredFrom } : {}),
    ...(vantage?.nodeId !== undefined ? { nodeId: vantage.nodeId } : {}),
    ...(quicProbe !== undefined ? { quicProbe } : {}),
    ...(serverProbeAt !== undefined ? { serverProbeAt } : {}),
    ...(exitSupersededAt !== undefined ? { exitSupersededAt } : {}),
    ...(fleetFailureReason !== undefined ? { fleetFailureReason } : {}),
    at: r.at,
    result: {
      reachable: res.reachable,
      auth_ok: res.auth_ok,
      udp_associate: res.udp_associate,
      // A cache written before routing was measured has no verdict to restore.
      // Default to NOT usable rather than inheriting a green badge from an era
      // when "healthy" meant "authenticated" — a stale optimistic verdict is
      // the failure this whole change exists to end.
      can_route: typeof res.can_route === 'boolean' ? res.can_route : false,
      connect_reply: typeof res.connect_reply === 'number' ? res.connect_reply : 0xff,
      latency_ms: res.latency_ms,
      message: res.message,
    },
  };
}

/**
 * T-27 / W-30 — the persisted cache's schema version, and the one migration.
 *
 * ⛔ `quicMeasuredAt` was added in 3e4de3a36 together with the rule that an
 * ABSENT timestamp is NOT fresh. Every measured verdict persisted before that
 * commit has no timestamp, so on every install that had ever seen a green chip
 * the fix turned it into `~` and nothing would ever restore it: the stamp is
 * only written by a NEW server result or a NEW live observation, and the owner
 * item (#13, "QUIC never green") is exactly the customer who had one stored.
 *
 * The backfill stamps such an entry with its own `at` — the last time anything
 * was measured for that proxy — so it ages from a time we actually recorded
 * rather than being discarded. It runs ONCE, keyed on this version in the same
 * store: after the migration, an entry with a verdict and no stamp is once more
 * "we could not tell", and the not-fresh rule stands for it. A read-time
 * default would have weakened that rule for every entry forever.
 */
export const PROBE_CACHE_SCHEMA_VERSION = 2;
const SCHEMA_KEY = 'probes_schema';

/** The one-time W-30 backfill, pure over a cleaned map. Returns the entries
 *  it changed (by id) so the caller can persist exactly those. Exported for
 *  the guard; production reaches it only through `loadProbeCache`. */
export function backfillQuicMeasuredAt(cache: ProbeCacheMap, loadTimeMs: number): string[] {
  const changed: string[] = [];
  for (const [id, c] of Object.entries(cache)) {
    if (c.quicMeasured === undefined || c.quicMeasuredAt !== undefined) continue;
    // `at` is the entry's own last-measured time; a non-finite one (a NaN that
    // survived `typeof === 'number'`) falls back to the load time rather than
    // stamping a value that no arithmetic can age.
    c.quicMeasuredAt = Number.isFinite(c.at) ? c.at : loadTimeMs;
    changed.push(id);
  }
  return changed;
}

export async function loadProbeCache(): Promise<ProbeCacheMap> {
  try {
    const raw = await getStore().get<Record<string, unknown>>(KEY);
    if (typeof raw !== 'object' || raw === null) return {};
    const out: ProbeCacheMap = {};
    for (const [id, entry] of Object.entries(raw)) {
      const clean = cleanEntry(entry);
      if (id.length > 0 && clean !== null) out[id] = clean;
    }
    await migrateOnce(out);
    return out;
  } catch {
    return {};
  }
}

/** Run the schema migration exactly once per store. Deliberately NOT under the
 *  write lock: every locked mutation calls `loadProbeCache` while holding it and
 *  the lock is not re-entrant. The write is idempotent, so the unlocked mount
 *  read racing a locked save can only write the same backfilled content twice.
 *  A store that refuses the write leaves the version unset; the migration then
 *  simply runs again on the next load, still producing the same result. */
async function migrateOnce(cache: ProbeCacheMap): Promise<void> {
  const store = getStore();
  const version = await store.get<unknown>(SCHEMA_KEY);
  if (typeof version === 'number' && version >= PROBE_CACHE_SCHEMA_VERSION) return;
  const changed = backfillQuicMeasuredAt(cache, Date.now());
  try {
    // Only the migrated entries are written back — an unrelated entry the
    // cleaner dropped is left in the store exactly as every load before this
    // one left it.
    if (changed.length > 0) {
      const raw = (await store.get<Record<string, unknown>>(KEY)) ?? {};
      for (const id of changed) raw[id] = cache[id];
      await store.set(KEY, raw);
    }
    await store.set(SCHEMA_KEY, PROBE_CACHE_SCHEMA_VERSION);
    await store.save();
  } catch {
    /* the in-memory map is already backfilled; the version stays unset and the
       migration retries on the next load */
  }
}

/** Record a probe result. `at` injected by the caller (Date.now()) so the
 *  function stays trivially testable. */
export function saveProbeResult(
  proxyId: string,
  result: ProxyTestResult,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    // Preserve any prior exit-geo: the capability probe and the exit probe
    // run separately; a capability re-test must not erase known geo.
    const prior = all[proxyId];
    all[proxyId] = {
      result,
      at,
      ...(prior?.exitIp !== undefined ? { exitIp: prior.exitIp } : {}),
      ...(prior?.exitCountry !== undefined ? { exitCountry: prior.exitCountry } : {}),
      ...(prior?.exitCity !== undefined ? { exitCity: prior.exitCity } : {}),
      ...(prior?.exitRegion !== undefined ? { exitRegion: prior.exitRegion } : {}),
      ...(prior?.exitTimezone !== undefined ? { exitTimezone: prior.exitTimezone } : {}),
      ...(prior?.exitAsnOrg !== undefined ? { exitAsnOrg: prior.exitAsnOrg } : {}),
      // T-17 — the exit identity's own stamp travels with the geo it dates.
      ...(prior?.exitAt !== undefined ? { exitAt: prior.exitAt } : {}),
      // (l) #14 — and so does the failed-probe stamp: a capability re-test
      // says nothing about the exit, so the null state it recorded stands.
      ...(prior?.exitProbeFailedAt !== undefined
        ? { exitProbeFailedAt: prior.exitProbeFailedAt }
        : {}),
      ...(prior?.osFingerprint !== undefined ? { osFingerprint: prior.osFingerprint } : {}),
      // T-1/T-6 — the server latency and measured QUIC ride a separate call (the
      // control plane /test), so a native capability re-test must not erase them,
      // exactly like the exit-geo and the OS fingerprint above.
      ...(prior?.serverLatencyMs !== undefined ? { serverLatencyMs: prior.serverLatencyMs } : {}),
      ...(prior?.quicMeasured !== undefined ? { quicMeasured: prior.quicMeasured } : {}),
      ...(prior?.quicMeasuredAt !== undefined ? { quicMeasuredAt: prior.quicMeasuredAt } : {}),
      // T-1 — the vantage, its node, and the fleet QUIC-relay verdict label the
      // server number above; they survive a native re-test with it.
      ...(prior?.measuredFrom !== undefined ? { measuredFrom: prior.measuredFrom } : {}),
      ...(prior?.nodeId !== undefined ? { nodeId: prior.nodeId } : {}),
      ...(prior?.quicProbe !== undefined ? { quicProbe: prior.quicProbe } : {}),
      ...(prior?.serverProbeAt !== undefined ? { serverProbeAt: prior.serverProbeAt } : {}),
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/** Persist a successful exit-geo probe onto the proxy's cache entry. The geo
 *  enrichment (city/region/timezone/asnOrg) is best-effort — pass null when
 *  lumtest was unreachable; the ip/country baseline still records. */
export function saveExitResult(
  proxyId: string,
  exitIp: string,
  exitCountry: string | null,
  geo: {
    city?: string | null;
    region?: string | null;
    timezone?: string | null;
    asnOrg?: string | null;
  } = {},
  /** T-17 — when the exit was measured. Defaults to now; injected by tests. */
  at: number = Date.now(),
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all; // exit probe only runs after a capability probe
    // (h) — an observation dated at or before the fleet failure that dropped
    // this row's exit describes the tunnel BEFORE it went down; it is not
    // adopted, whoever offers it. A later one clears the stamp: the tunnel
    // was seen up again.
    if (prior.exitSupersededAt !== undefined && at <= prior.exitSupersededAt) return all;
    // …and an exit seen AFTER the failure is the tunnel seen up: the failure
    // verdict goes with the stamp (finding 3 — the sentence lives here now).
    // (l) #14 — a measured exit is the answer the failed probe lacked.
    const {
      exitSupersededAt: _superseded,
      fleetFailureReason: _failure,
      exitProbeFailedAt: _probeFailed,
      ...kept
    } = prior;
    all[proxyId] = {
      ...kept,
      exitIp,
      exitCountry,
      exitCity: geo.city ?? null,
      exitRegion: geo.region ?? null,
      exitTimezone: geo.timezone ?? null,
      exitAsnOrg: geo.asnOrg ?? null,
      exitAt: at,
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * (l) #14 — record that a native exit probe through a USABLE proxy did not
 * complete. The entry's exit fields go (they were an EARLIER probe's answer,
 * and `saveProbeResult` had just carried them across this Test's capability
 * write) and `exitProbeFailedAt` is stamped, so the derivation emits the null
 * "exit geo unavailable" state from now on instead of the previous exit. Rides
 * on an existing entry; none is invented. Cleared by the next `saveExitResult`.
 */
export function clearExitResult(proxyId: string, at: number = Date.now()): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    const {
      exitIp: _ip,
      exitCountry: _country,
      exitCity: _city,
      exitRegion: _region,
      exitTimezone: _tz,
      exitAsnOrg: _asn,
      exitAt: _exitAt,
      ...kept
    } = prior;
    all[proxyId] = { ...kept, exitProbeFailedAt: at };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/** N-2 — persist the control plane's passive OS fingerprint onto the proxy's
 *  cache entry. Like the exit-geo it rides on an existing capability entry and
 *  is preserved across re-tests; a proxy with no entry has nothing to attach
 *  it to, and none is invented. */
export function saveOsFingerprint(
  proxyId: string,
  fp: OsFingerprint,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    all[proxyId] = {
      ...prior,
      // (o) O3 — the reported cause is written beside the reading it stands in for;
      // without it the next load reproduces a bare `unknown` and the dead-end hint.
      osFingerprint: {
        os: fp.os,
        confidence: fp.confidence,
        reason: fp.reason,
        at,
        ...(fp.unavailable !== undefined ? { unavailable: fp.unavailable } : {}),
      },
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/** T-1/T-6 — persist the control plane's server-measured latency and the QUIC
 *  verdict it measured in the /test session onto the proxy's cache entry. Like
 *  the exit-geo and OS fingerprint it rides on an existing capability entry (the
 *  native probe ran first) and is preserved across re-tests; a proxy with no
 *  entry has nothing to attach to, and none is invented. The QUIC verdict is a
 *  closed set — a value outside it is dropped, never stored as a would-be green
 *  chip; a fresh valid verdict updates the prior one, and an absent one keeps
 *  the last measurement rather than erasing it.
 *
 *  T-1 — the vantage (measuredFrom + nodeId) and the fleet QUIC-relay verdict
 *  (quicProbe) describe THIS measurement, not the proxy's history, so unlike
 *  quicMeasured they are REPLACED by every server result: present → stored,
 *  absent → removed. A control-plane fallback after a fleet run must not keep
 *  wearing the fleet label or the fleet relay chip — that is the silent fallback
 *  the owner item forbids. The vantage itself is a closed set (see
 *  proxy-vantage.ts); a value outside it stores as "unlabelled". */
export function saveServerProbeResult(
  proxyId: string,
  server: {
    /** T-1 — a number STORES, `null` CLEARS, `undefined` leaves what is there.
     *  Three answers, not two: a fleet result can be ok with no timing, and
     *  merging that with "nothing new this time" is what leaves a stale number
     *  on the card after a measurement that produced none. */
    latencyMs?: number | null;
    quicMeasured?: MeasuredQuic | null;
    quicMeasuredAt?: number;
    measuredFrom?: ProxyVantage;
    nodeId?: string;
    quicProbe?: boolean;
  },
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    const quic = cleanMeasuredQuic(server.quicMeasured) ?? undefined;
    const vantage = cleanServerVantage(server.measuredFrom, server.nodeId);
    // (h) finding 3 — a server VERDICT replaces the fleet-failure sentence
    // too: this is the "next fleet answer" that clears it.
    const {
      measuredFrom: _m,
      nodeId: _n,
      quicProbe: _q,
      fleetFailureReason: _failure,
      ...kept
    } = prior;
    // An explicit null erases the stored number so it cannot outlive the
    // measurement that failed to produce one. `undefined` deliberately does not.
    if (server.latencyMs === null) delete kept.serverLatencyMs;
    all[proxyId] = {
      ...kept,
      ...(typeof server.latencyMs === 'number' ? { serverLatencyMs: server.latencyMs } : {}),
      ...(quic !== undefined
        ? { quicMeasured: quic, quicMeasuredAt: server.quicMeasuredAt ?? at }
        : {}),
      ...(vantage !== undefined ? { measuredFrom: vantage.measuredFrom } : {}),
      ...(vantage?.nodeId !== undefined ? { nodeId: vantage.nodeId } : {}),
      // (q) Item 3 residual — the relay verdict is REPLACED by a fleet answer
      // (present → stored, absent → the Mac ran and produced none → removed),
      // but a CONTROL-PLANE fallback measured nothing about QUIC: the server
      // never emits `quic_ok` off that path, so erasing here turned a green
      // relay chip back to '~' with no cause named, on a fleet miss the
      // customer did not cause. The fleet's last relay fact stands; the
      // vantage/node above still flip to the control plane, so the fallback
      // itself is never silent.
      ...(typeof server.quicProbe === 'boolean'
        ? { quicProbe: server.quicProbe }
        : vantage?.measuredFrom === 'control_plane' && typeof prior.quicProbe === 'boolean'
          ? { quicProbe: prior.quicProbe }
          : {}),
      // (h) — when THIS server test ran, so a VPN row's "Tested" can date the
      // fleet number it shows rather than the pre-flight that preceded a
      // refusal.
      serverProbeAt: at,
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * (h) — record that a fleet test FAILED to bring a VPN row's tunnel up.
 *
 * ⛔ A failed fleet verdict used to write NOTHING, on the theory that the
 * native probe's entry stands and the views drop what they hold. For a VPN row
 * the fleet IS the verdict, and the entry still held the previous SUCCESSFUL
 * fleet fields (carried over by the pre-flight that ran seconds earlier), so
 * the very next cache emit from ANY writer — a SOCKS5 row's Test, the
 * background sweeper — re-hydrated the grid with a fleet-labelled latency, an
 * exit IP and a relay chip beside the red "tunnel down"; and a Re-check of the
 * failed row flashed "tunnel up" for the whole fleet wait.
 *
 * Every server-measured field goes (latency, vantage, node, relay verdict, OS
 * fingerprint, the live session's QUIC verdict, the exit and its geo) and the
 * exit is marked SUPERSEDED at `at`: the account list still carries the exit
 * the last session saw through this tunnel, and the list adoption must not
 * put it back. The verdict triple (`result` / `at` / `endpoint`) is untouched —
 * the endpoint DID resolve; what failed is the tunnel behind it. Rides on an
 * existing entry; none is invented.
 */
export function saveFleetFailure(
  proxyId: string,
  at: number,
  /** (h) finding 3 — the fleet's sentence, persisted so every surface that
   *  reads this entry (the grid after a remount, the profile card for a check
   *  the grid ran) renders the same "tunnel down". Empty = no sentence. */
  reason = '',
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    all[proxyId] = {
      result: prior.result,
      at: prior.at,
      ...(prior.endpoint !== undefined ? { endpoint: prior.endpoint } : {}),
      exitSupersededAt: at,
      ...(reason.length > 0 ? { fleetFailureReason: reason } : {}),
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * T-20 — record a VPN/HTTP row's endpoint pre-flight.
 *
 * Stored as an `endpoint` verdict beside the fail-closed placeholder `result`,
 * so `isProxyUsable` and every derivation built on it read "not a SOCKS5
 * verdict" — never a fake pass, and never the un-gated probe's false
 * "unreachable" either. Replaces any SOCKS5 verdict the row held (that verdict
 * was the bug), and carries NOTHING over from it: its exit-geo and server-side
 * fields were measured through a SOCKS5 listener this row does not have.
 *
 * ⛔ (g) A prior ENDPOINT entry is a different case. Its server-measured fields
 * (fleet latency + vantage, the QUIC-relay verdict, the OS fingerprint, the
 * observed exit, a live session's QUIC verdict) came from the fleet probe or
 * the session that followed an EARLIER pre-flight of this very row, and they
 * are carried over when the new verdict is RESOLVED. The grid's Check runs
 * this pre-flight BEFORE it asks the fleet, so without the carry-over a test
 * the control plane REFUSED (`not_run` — a live session holds the tunnel, the
 * node was busy) erased every field the last measurement had written, and the
 * row that "kept what it holds" had nothing left to hold. An UNRESOLVED
 * endpoint still drops them all: nothing can be measured through a dead
 * endpoint, and a number beside "unresolved" would read as current.
 *
 * ⛔ (g-followup) The carry-over is keyed on the ADDRESS, not merely on the
 * entry's shape: the prior entry must itself be a RESOLVED endpoint whose `ip`
 * equals the one just resolved. A hostname that now answers with a different
 * address is a server that was never measured — its predecessor's fleet
 * latency, vantage, relay verdict, OS fingerprint and exit would render as
 * current on the grid (the overlay keys on `endpoint.resolved` alone), and a
 * fleet reply that writes nothing (`not_run` / `unavailable` / `failed`) would
 * leave them there. A changed address drops every server-measured field.
 */
/** The fields of an entry that a fleet probe or a live session wrote — every
 *  optional member except the verdict itself (`result` / `at` / `endpoint`).
 *  Listed by name so a new server-measured field must be added HERE to survive
 *  a pre-flight, rather than surviving by accident of a spread. */
function serverMeasuredFields(
  prior: CachedProbe,
): Omit<Partial<CachedProbe>, 'result' | 'at' | 'endpoint'> {
  const {
    exitIp,
    exitCountry,
    exitAt,
    exitProbeFailedAt,
    exitCity,
    exitRegion,
    exitTimezone,
    exitAsnOrg,
    osFingerprint,
    serverLatencyMs,
    quicMeasured,
    quicMeasuredAt,
    measuredFrom,
    nodeId,
    quicProbe,
    serverProbeAt,
    exitSupersededAt,
    fleetFailureReason,
  } = prior;
  const kept = {
    exitIp,
    exitCountry,
    exitAt,
    exitProbeFailedAt,
    exitCity,
    exitRegion,
    exitTimezone,
    exitAsnOrg,
    osFingerprint,
    serverLatencyMs,
    quicMeasured,
    quicMeasuredAt,
    measuredFrom,
    nodeId,
    quicProbe,
    serverProbeAt,
    // (h) — the superseded stamp is itself a fleet verdict about this row's
    // exit and must outlive the pre-flight that precedes the next test — and
    // so must its sentence (finding 3): "tunnel down" stays on every surface
    // until THIS check answers, exactly as the grid's in-memory copy did.
    exitSupersededAt,
    fleetFailureReason,
  };
  // Absent stays absent: an `undefined` member would still be a key in the
  // stored object (and in a toEqual), where the entry never had one.
  for (const k of Object.keys(kept) as (keyof typeof kept)[]) {
    if (kept[k] === undefined) delete kept[k];
  }
  return kept;
}

export function saveEndpointResult(
  proxyId: string,
  endpoint: CachedEndpointVerdict,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    const carried =
      endpoint.resolved &&
      prior?.endpoint !== undefined &&
      prior.endpoint.resolved &&
      prior.endpoint.ip === endpoint.ip
        ? serverMeasuredFields(prior)
        : {};
    all[proxyId] = {
      ...carried,
      result: endpointPlaceholderResult(endpoint),
      at,
      endpoint: { resolved: endpoint.resolved, ip: endpoint.ip, message: endpoint.message },
    };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/**
 * T-27 — record a QUIC verdict OBSERVED in a live session (the session's
 * capability report said an HTTP/3 connection completed through this proxy).
 *
 * Touches only the verdict and its stamp. `saveServerProbeResult` is the wrong
 * tool here on purpose: it REPLACES the vantage, node and relay verdict with
 * every call (present → stored, absent → removed), and a live observation
 * carries none of them — routing it through there would strip the fleet label
 * off a latency it did not re-measure. Monotone: a stamp older than the one
 * stored is ignored, so a late-arriving poll cannot rewind a fresher verdict.
 * Rides on an existing entry like every other enrichment; none is invented.
 */
export function saveObservedQuic(
  proxyId: string,
  quic: MeasuredQuic,
  at: number,
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    if (prior.quicMeasuredAt !== undefined && prior.quicMeasuredAt > at) return all;
    all[proxyId] = { ...prior, quicMeasured: quic, quicMeasuredAt: at };
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

// T-27 — one ledger per process: a latched `h3_connection_observed` is stamped
// once per session; a rising `h3_connection_count` re-stamps.
const h3Ledger = makeH3ObservationLedger();

/** The slice of a listed agent session the live-h3 consumer reads. The SDK
 *  types `capability_report` without the h3 fields; it is parsed as `unknown`. */
export interface LiveSessionLike {
  id: string;
  capability_report?: unknown;
}

/**
 * T-27 (drop 2) — turn the live sessions' capability reports into stored QUIC
 * verdicts on the proxies they launched through.
 *
 * Called from the profile hub's agent-session list poll — the MAIN app, on
 * purpose. The simulator is a separate macOS bundle (`dev.driftstack.simulator`)
 * with its own store directory, so a cache write from SimulatorWindow would
 * land in a file the profile cards never read; the hub's poll already carries
 * every live session's `capability_report` and is the one consumer whose store
 * IS the cards' store. Best-effort per session: a proxy with no cache entry
 * attaches nothing (and stays un-committed in the ledger, so the next poll
 * after a probe writes it), and one failed write does not stop the others.
 * Returns the proxy ids written, for the guard.
 */
export async function recordLiveH3Observations(
  sessions: ReadonlyArray<LiveSessionLike>,
  bindings: ReadonlyArray<H3BindingLike>,
  proxies: ReadonlyArray<{ id: string }>,
  nowMs: number = Date.now(),
): Promise<string[]> {
  const written: string[] = [];
  for (const s of sessions) {
    const obs = parseH3Observation(s.capability_report);
    if (obs === null) continue;
    const proxyId = attributeSessionProxy(s.id, bindings, proxies);
    if (proxyId === null) continue;
    const at = h3Ledger.plan(s.id, obs, nowMs);
    if (at === null) continue;
    try {
      const cache = await saveObservedQuic(proxyId, 'h3', at);
      const stored = cache[proxyId];
      // Committed only when the verdict is actually on the entry: no entry, or
      // a fresher stamp already there, leaves the session to be re-read later.
      if (stored?.quicMeasured === 'h3' && (stored.quicMeasuredAt ?? -1) >= at) {
        h3Ledger.commit(s.id, obs);
        written.push(proxyId);
      }
    } catch {
      /* best-effort — the next poll retries */
    }
  }
  return written;
}

/**
 * (k) K3 — the server's EXPLICIT clear of a fleet failure, adopted from the
 * account list: `exit_superseded_at: null` beside a stamp this entry holds.
 *
 * ⛔ Until this writer existed the only thing that could lift a fleet-failure
 * sentence on a Mac that did not run the next (UP) test was `saveExitResult`
 * with an observation dated after the stamp — so a later UP verdict whose exit
 * the list adoption REFUSES (the server kept its stored geo and only cleared
 * the stamp; the observation is still dated before the failure) left the
 * second Mac reading "tunnel down" indefinitely, while the server's own row
 * said the contradiction was spent. This drops the stamp and its sentence and
 * touches nothing else: the verdict triple stays, and there is no exit or
 * latency to restore — the list adoption that follows writes those if the
 * list carries them. Rides on an existing entry; none is invented. Idempotent:
 * an entry with no stamp is returned unchanged, with no store write.
 */
export function clearFleetFailure(proxyId: string, notAfterMs?: number): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all;
    if (prior.exitSupersededAt === undefined && prior.fleetFailureReason === undefined) return all;
    // (k) review — the caller decided on a SNAPSHOT; a failure this Mac wrote
    // since (a newer stamp) must survive the clear it did not know about.
    if (
      notAfterMs !== undefined &&
      prior.exitSupersededAt !== undefined &&
      prior.exitSupersededAt > notAfterMs
    )
      return all;
    const { exitSupersededAt: _superseded, fleetFailureReason: _failure, ...kept } = prior;
    all[proxyId] = kept;
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}

/** Drop a proxy's cached probe (capability + exit-geo). Called when the
 *  proxy's connection details change — the cached reachability/UDP/exit-IP
 *  no longer describes the live endpoint, so showing it on profile cards
 *  would be dishonest — and when a proxy is deleted, so its entry can't
 *  linger (and a future re-minted id can't inherit stale geo). Idempotent:
 *  a no-op (no store write) when the proxy has no cached probe. */
export function invalidateProbe(proxyId: string): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    if (all[proxyId] === undefined) return all;
    delete all[proxyId];
    await getStore().set(KEY, all);
    await getStore().save();
    emitProbeCache(all);
    return all;
  });
}
