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
  type OsFingerprint,
} from './os-fingerprint-verdict';
import { cleanServerVantage, type ProxyVantage, type ServerVantage } from './proxy-vantage';

/** N-2 — the control plane's passive OS fingerprint of the proxy's own stack,
 *  with when it was recorded. */
export interface CachedOsFingerprint extends OsFingerprint {
  at: number;
}

export interface CachedProbe {
  result: ProxyTestResult;
  /** Epoch ms when the probe ran. */
  at: number;
  /** E-2 exit-geo (optional — absent until the echo probe succeeds). */
  exitIp?: string;
  exitCountry?: string | null;
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
export function deriveProbeViewState(cache: ProbeCacheMap): ProbeViewState {
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
    if (c.quicMeasured !== undefined && isProxyUsable(c.result)) quicMeasured[id] = c.quicMeasured;
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
  return probeFreshness(at, now) === 'stale';
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
  return { os: f.os, confidence: f.confidence, reason: f.reason, at: f.at };
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
  return {
    ...(exitIp !== undefined ? { exitIp } : {}),
    ...(exitCountry !== undefined ? { exitCountry } : {}),
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

export async function loadProbeCache(): Promise<ProbeCacheMap> {
  try {
    const raw = await getStore().get<Record<string, unknown>>(KEY);
    if (typeof raw !== 'object' || raw === null) return {};
    const out: ProbeCacheMap = {};
    for (const [id, entry] of Object.entries(raw)) {
      const clean = cleanEntry(entry);
      if (id.length > 0 && clean !== null) out[id] = clean;
    }
    return out;
  } catch {
    return {};
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
): Promise<ProbeCacheMap> {
  return writeLock(async () => {
    const all = await loadProbeCache();
    const prior = all[proxyId];
    if (prior === undefined) return all; // exit probe only runs after a capability probe
    all[proxyId] = {
      ...prior,
      exitIp,
      exitCountry,
      exitCity: geo.city ?? null,
      exitRegion: geo.region ?? null,
      exitTimezone: geo.timezone ?? null,
      exitAsnOrg: geo.asnOrg ?? null,
    };
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
      osFingerprint: { os: fp.os, confidence: fp.confidence, reason: fp.reason, at },
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
    const { measuredFrom: _m, nodeId: _n, quicProbe: _q, ...kept } = prior;
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
      ...(typeof server.quicProbe === 'boolean' ? { quicProbe: server.quicProbe } : {}),
    };
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
