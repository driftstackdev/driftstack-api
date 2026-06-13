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
import type { ProxyTestResult } from './proxies';

export interface CachedProbe {
  result: ProxyTestResult;
  /** Epoch ms when the probe ran. */
  at: number;
  /** E-2 exit-geo (optional — absent until the echo probe succeeds). */
  exitIp?: string;
  exitCountry?: string | null;
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
  return {
    ...(exitIp !== undefined ? { exitIp } : {}),
    ...(exitCountry !== undefined ? { exitCountry } : {}),
    at: r.at,
    result: {
      reachable: res.reachable,
      auth_ok: res.auth_ok,
      udp_associate: res.udp_associate,
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
export async function saveProbeResult(
  proxyId: string,
  result: ProxyTestResult,
  at: number,
): Promise<ProbeCacheMap> {
  const all = await loadProbeCache();
  // Preserve any prior exit-geo: the capability probe and the exit probe
  // run separately; a capability re-test must not erase known geo.
  const prior = all[proxyId];
  all[proxyId] = {
    result,
    at,
    ...(prior?.exitIp !== undefined ? { exitIp: prior.exitIp } : {}),
    ...(prior?.exitCountry !== undefined ? { exitCountry: prior.exitCountry } : {}),
  };
  await getStore().set(KEY, all);
  await getStore().save();
  return all;
}

/** Persist a successful exit-geo probe onto the proxy's cache entry. */
export async function saveExitResult(
  proxyId: string,
  exitIp: string,
  exitCountry: string | null,
): Promise<ProbeCacheMap> {
  const all = await loadProbeCache();
  const prior = all[proxyId];
  if (prior === undefined) return all; // exit probe only runs after a capability probe
  all[proxyId] = { ...prior, exitIp, exitCountry };
  await getStore().set(KEY, all);
  await getStore().save();
  return all;
}
