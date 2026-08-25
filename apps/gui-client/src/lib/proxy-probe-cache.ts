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
  for (const [id, c] of Object.entries(cache)) {
    testResults[id] = c.result;
    if (typeof c.at === 'number') testedAt[id] = c.at;
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
  return { testResults, exitResults, testedAt };
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

/** The proxy ids whose verdicts a sweep should refresh, oldest FIRST so a
 *  rate-limited sweep spends its budget on the least trustworthy entries.
 *  Untested proxies are not included: this refreshes what has gone off, and a
 *  proxy that has never been tested is the customer's to test. */
export function staleProxyIds(cache: ProbeCacheMap, now: number): string[] {
  return Object.entries(cache)
    .filter(([, c]) => isProbeStale(c.at, now))
    .sort((a, b) => a[1].at - b[1].at)
    .map(([id]) => id);
}

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
  return {
    ...(exitIp !== undefined ? { exitIp } : {}),
    ...(exitCountry !== undefined ? { exitCountry } : {}),
    ...(exitCity !== undefined ? { exitCity } : {}),
    ...(exitRegion !== undefined ? { exitRegion } : {}),
    ...(exitTimezone !== undefined ? { exitTimezone } : {}),
    ...(exitAsnOrg !== undefined ? { exitAsnOrg } : {}),
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
