// Background proxy re-check — Wave 3 / P-8.
//
// WHY THIS EXISTS, precisely: single launch already re-probes the proxy at
// launch time ("Re-test the proxy NOW rather than trusting whatever the cache
// remembers", ProfilesView). BULK launch deliberately does not — probing N
// proxies serially would stall the whole batch — so it acts on whatever the
// cache holds, with no bound on how old that is. This keeps the cache young
// enough that trusting it is defensible.
//
// It is therefore NOT a UI nicety. It is the thing that makes the one
// cache-trusting path safe.

import type { ProxyConfig, ProxyTestResult } from './proxies';
import { isProbeStale, type ProbeCacheMap } from './proxy-probe-cache';

/** Proxies re-probed per sweep. Each is a real TCP + SOCKS5 handshake against
 *  someone else's infrastructure, so a sweep is deliberately a trickle rather
 *  than a burst: five covers a normal list within a few sweeps and never looks
 *  like a scan to the provider. */
export const SWEEP_MAX_PER_RUN = 5;

/** Gap between probes inside one sweep. Serial with a pause, never parallel —
 *  a dozen simultaneous handshakes from one host is exactly the shape a
 *  provider rate-limits, and being rate-limited would produce false
 *  "unreachable" verdicts, which is worse than not sweeping at all. */
export const SWEEP_GAP_MS = 2_000;

/** How often the driver attempts a sweep. Chosen against PROBE_TTL_MS: at five
 *  proxies per sweep this refreshes twenty per hour, so a normal list stays
 *  inside the TTL without the app ever probing in bursts. The first sweep is
 *  deferred by one interval rather than fired at startup — launch is the
 *  busiest moment for the machine, and nothing is stale-urgent in the first
 *  quarter hour. */
export const SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * V-2168 — how long a FAILING verdict stands before the sweeper retries it.
 * A failure is negative caching and must expire faster than the 6h positive
 * TTL: the owner's proxies are mobile-carrier exits where one transient
 * handshake failure (or a probe that "could not be scheduled") wrote a durable
 * red "Not reachable" badge that nothing would revisit for six hours — it
 * survived reload (the cache is disk-persisted and re-read at mount) and only
 * a manual Retest cleared it. One sweep interval is the natural floor: the
 * next pass after the failure re-checks it.
 */
export const SWEEP_FAILURE_RETRY_MS = 15 * 60 * 1000;

/**
 * Which proxies this sweep should re-probe, oldest verdict FIRST so a capped
 * sweep spends its budget on the least trustworthy entries.
 *
 * Pure — `now` injected, no I/O — so every exclusion below is testable.
 *
 * ⛔ SOCKS5 ONLY, and this is a correctness rule rather than a preference.
 * `testProxy` performs a SOCKS5 handshake. An `openvpn` or `wireguard` proxy
 * exposes its endpoint on `host`/`port` for DISPLAY, and a SOCKS5 handshake
 * against it does not fail informatively — it fails as "unreachable". A manual
 * Test does that too, but that is one deliberate click on one proxy; a
 * background sweep would silently mark a customer's entire VPN fleet dead, on
 * its own initiative, with no one having asked for it. `http` is excluded for
 * the same reason.
 *
 * ⛔ NEVER-TESTED proxies are excluded. This refreshes verdicts that have gone
 * off; a proxy with no verdict has nothing to have gone off, and probing one
 * unasked would turn "untested" into a result the customer did not request and
 * may not want (an unpaid or lapsed endpoint answers a probe with an auth
 * failure that then shows as a hard red).
 *
 * ⛔ Cache entries for proxies that no longer exist are excluded — a deleted
 * proxy's entry can linger between an `invalidateProbe` failure and a reload,
 * and probing a host the customer has removed is indefensible.
 */
export function planSweep(
  cache: ProbeCacheMap,
  proxies: ReadonlyArray<ProxyConfig>,
  now: number,
  max: number = SWEEP_MAX_PER_RUN,
): ProxyConfig[] {
  if (max <= 0) return [];
  const byId = new Map(proxies.map((p) => [p.id, p]));
  return Object.entries(cache)
    .filter(([id, c]) => {
      const p = byId.get(id);
      if (p === undefined) return false; // deleted proxy, lingering entry
      if (p.scheme !== undefined && p.scheme !== 'socks5') return false; // not SOCKS5-probeable
      // A failing verdict is retried after SWEEP_FAILURE_RETRY_MS instead of
      // waiting out the full positive TTL — see the constant above. Display
      // freshness is untouched: the badge keeps showing the failure until a
      // retry actually overturns it.
      if (c.result.reachable === false && now - c.at >= SWEEP_FAILURE_RETRY_MS) return true;
      return isProbeStale(c.at, now);
    })
    .sort((a, b) => a[1].at - b[1].at) // oldest verdict first
    .slice(0, max)
    .map(([id]) => byId.get(id) as ProxyConfig);
}

/** Everything the sweep touches, injected so the runner is testable without
 *  Tauri, a clock, or a network. */
export interface SweepDeps {
  loadCache: () => Promise<ProbeCacheMap>;
  listProxies: () => Promise<ReadonlyArray<ProxyConfig>>;
  testProxy: (p: ProxyConfig) => Promise<ProxyTestResult>;
  saveResult: (id: string, result: ProxyTestResult, at: number) => Promise<ProbeCacheMap>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface SweepReport {
  /** Proxies actually re-probed and recorded. */
  refreshed: string[];
  /** Probes that threw. A probe that could not RUN is not a verdict, so these
   *  are NOT written to the cache — the previous entry stands and stays stale,
   *  and the next sweep will try again. */
  failed: string[];
  /** True when a sweep was already running and this call did nothing. */
  skipped: boolean;
}

let inFlight = false;

/**
 * Run one sweep. Single-flight: a second call while one is running returns
 * `skipped` rather than queueing, because a queued sweep would run against a
 * cache the first one is still rewriting.
 *
 * ⚠️ Re-plans nothing mid-flight. The plan is computed once, up front, from one
 * consistent read of the cache and the proxy list. Recomputing between probes
 * would let a sweep that is writing fresh timestamps observe its own writes and
 * shrink its own worklist.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  if (inFlight) return { refreshed: [], failed: [], skipped: true };
  inFlight = true;
  const refreshed: string[] = [];
  const failed: string[] = [];
  try {
    const [cache, proxies] = await Promise.all([deps.loadCache(), deps.listProxies()]);
    const plan = planSweep(cache, proxies, deps.now());
    for (let i = 0; i < plan.length; i += 1) {
      const p = plan[i] as ProxyConfig;
      // Pause BETWEEN probes, never before the first — a sweep should not sit
      // idle for two seconds to do one probe.
      if (i > 0) await deps.sleep(SWEEP_GAP_MS);
      try {
        const result = await deps.testProxy(p);
        await deps.saveResult(p.id, result, deps.now());
        refreshed.push(p.id);
      } catch {
        // Deliberately swallowed per-proxy: one unreachable host must not
        // abandon the rest of the sweep, and a failed probe is not a verdict.
        failed.push(p.id);
      }
    }
    return { refreshed, failed, skipped: false };
  } finally {
    inFlight = false;
  }
}

/** Test seam — resets the single-flight latch between cases. */
export function __resetSweepLatchForTests(): void {
  inFlight = false;
}
