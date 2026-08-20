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
import type { ProxyTestResult } from './proxies';

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

const STORE_FILE = 'proxy-probe-cache.json';
const KEY = 'probes';

let store: LazyStore | null = null;
function getStore(): LazyStore {
  if (store === null) {
    store = new LazyStore(STORE_FILE);
  }
  return store;
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
    return all;
  });
}
