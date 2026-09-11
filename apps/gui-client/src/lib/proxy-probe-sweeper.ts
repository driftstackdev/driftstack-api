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
import { isProbeStaleAfter, PROBE_TTL_MS, type ProbeCacheMap } from './proxy-probe-cache';
import { isSocks5Probeable } from './proxy-scheme';

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

/** N3 (owner: "auto update proxy states more often ... when opening application") —
 *  how long after the app opens the FIRST sweep fires. The interval alone deferred it a
 *  full 15 min; this brings fresh data on open while still staying OFF the busy launch
 *  moment (not fired synchronously at mount). Must be < SWEEP_INTERVAL_MS. */
export const STARTUP_SWEEP_DELAY_MS = 20 * 1000;

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
 * ⛔ The native SOCKS5 handshake (`testProxy`) is sent to SOCKS5 rows ONLY, and
 * this is a correctness rule rather than a preference. An `openvpn` or
 * `wireguard` proxy exposes its endpoint on `host`/`port` for DISPLAY, and a
 * SOCKS5 handshake against it does not fail informatively — it fails as
 * "unreachable"; a background sweep that sent it would silently mark a
 * customer's entire VPN fleet dead, unasked. `http` fails the greeting the
 * same way.
 *
 * (q) Item 13(c) — those rows are NOT dropped any more; they are planned for
 * THEIR OWN check (the endpoint pre-flight + the fleet tunnel test — the same
 * routine the grid's Check runs) when the runner has one (`endpointRows`),
 * and the runner dispatches by scheme. MEASURED before this: `planSweep`
 * dropped every non-SOCKS5 row and nothing else ever re-checked one, so for a
 * customer whose proxies are all VPN rows (the owner's) the app-open, focus and
 * 15-min refresh did nothing at all. Without a checker they stay out of the
 * plan, so they can never consume the budget of a sweep that cannot check them.
 *
 * `staleAfterMs` (default `PROBE_TTL_MS`) is the age past which a verdict is
 * refreshed. The steady interval keeps the TTL; the app-open / focus triggers
 * pass a SHORT window (`ACTIVE_SWEEP_STALE_MS`), because a green row probed 5 h
 * ago that has since gone down stayed green on every open and focus until the
 * 6 h TTL — "auto update proxy states when opening the application" refreshed
 * nothing a customer could see. The failure retry window is unchanged.
 *
 * ⛔ NEVER-TESTED proxies are excluded. This refreshes verdicts that have gone
 * off; a proxy with no verdict has nothing to have gone off, and probing one
 * unasked would turn "untested" into a result the customer did not request and
 * may not want (an unpaid or lapsed endpoint answers a probe with an auth
 * failure that then shows as a hard red). For an endpoint row that means an
 * entry with a pre-flight verdict (`endpoint`) — one the customer once checked.
 *
 * ⛔ Cache entries for proxies that no longer exist are excluded — a deleted
 * proxy's entry can linger between an `invalidateProbe` failure and a reload,
 * and probing a host the customer has removed is indefensible.
 */
export interface PlanSweepOptions {
  /** Age past which a verdict is refreshed. Default `PROBE_TTL_MS`. */
  staleAfterMs?: number;
  /** Plan VPN/HTTP rows for their endpoint/fleet check (the runner has one). Default false. */
  endpointRows?: boolean;
}

export function planSweep(
  cache: ProbeCacheMap,
  proxies: ReadonlyArray<ProxyConfig>,
  now: number,
  max: number = SWEEP_MAX_PER_RUN,
  opts: PlanSweepOptions = {},
): ProxyConfig[] {
  if (max <= 0) return [];
  const staleAfterMs = opts.staleAfterMs ?? PROBE_TTL_MS;
  const byId = new Map(proxies.map((p) => [p.id, p]));
  return Object.entries(cache)
    .filter(([id, c]) => {
      const p = byId.get(id);
      if (p === undefined) return false; // deleted proxy, lingering entry
      if (!isSocks5Probeable(p.scheme)) {
        // T-20 — never the SOCKS5 handshake for these; their own check, or nothing.
        if (opts.endpointRows !== true) return false;
        if (c.endpoint === undefined) return false; // never checked → not refreshed unasked
        // An unresolved endpoint or a fleet "tunnel down" is this row's failing
        // verdict, retried on the failure window like a SOCKS5 "unreachable".
        const failing = !c.endpoint.resolved || c.fleetFailureReason !== undefined;
        if (failing && now - c.at >= SWEEP_FAILURE_RETRY_MS) return true;
        return isProbeStaleAfter(c.at, now, staleAfterMs);
      }
      // A failing verdict is retried after SWEEP_FAILURE_RETRY_MS instead of
      // waiting out the full positive TTL — see the constant above. Display
      // freshness is untouched: the badge keeps showing the failure until a
      // retry actually overturns it.
      if (c.result.reachable === false && now - c.at >= SWEEP_FAILURE_RETRY_MS) return true;
      return isProbeStaleAfter(c.at, now, staleAfterMs);
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
  /** (q) Item 13(c) — the check for a VPN/HTTP row (the endpoint pre-flight +
   *  the fleet tunnel test, persisting its own writes —
   *  `checkEndpointRowForSweep` in lib/proxy-server-test). When absent, those
   *  rows are not planned at all; they are never handed to `testProxy`. */
  checkEndpoint?: (p: ProxyConfig) => Promise<void>;
  /** (q) Item 13(c) — the trigger's staleness window (see `planSweep`). */
  staleAfterMs?: number;
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
  /** (l) #15 — planned proxies left alone because a user-initiated probe
   *  held them when their turn came; the next sweep re-plans from its write. */
  skippedBusy: string[];
}

let inFlight = false;

/**
 * (l) #15 — the SOCKS5 proxies a probe is running against RIGHT NOW, whoever
 * started it: this sweep, the grid's Test, the card's Test, the pre-launch
 * probe. One handshake per proxy at a time.
 *
 * ⛔ Not a nicety. The sweep fires on every window focus (N3) — exactly when a
 * customer returning to the app clicks Test on the stale row the plan just
 * selected — and the two handshakes then overlap: the file's own note says
 * parallel probes through consumer endpoints skew each other's latency, and
 * whichever `saveProbeResult` lands LAST wins regardless of which measurement
 * is fresher, so a sweep probe that started earlier but timed out later
 * overwrote the customer's just-shown healthy verdict with "Not reachable" a
 * few seconds after they read it, with no user action.
 *
 * The sweep SKIPS a claimed proxy (the user's probe is the fresher answer and
 * the next sweep re-plans from its write); a user-initiated probe AWAITS a
 * sweep's probe on the same proxy and then runs its own, so the customer's
 * click is never dropped and its verdict is the one that lands last.
 */
const probesInFlight = new Map<string, Promise<void>>();

/** Whether a probe against this proxy is running now (any caller). */
export function isProxyProbeInFlight(proxyId: string): boolean {
  return probesInFlight.has(proxyId);
}

/**
 * Run `probe` as THE probe for this proxy: waits for any probe already running
 * against it (a sweep's, or another surface's) to finish first, then holds the
 * claim until `probe` settles. The sweep checks the claim and skips; a user
 * caller queues behind it. Errors propagate to the caller; the claim is always
 * released.
 */
export async function withProxyProbe<T>(proxyId: string, probe: () => Promise<T>): Promise<T> {
  // Queue behind whatever holds the claim (its outcome is not ours to inspect).
  while (probesInFlight.has(proxyId)) {
    await probesInFlight.get(proxyId)?.catch(() => undefined);
  }
  let release!: () => void;
  const claim = new Promise<void>((resolve) => {
    release = resolve;
  });
  probesInFlight.set(proxyId, claim);
  try {
    return await probe();
  } finally {
    // Only drop OUR claim: a queued caller may not have replaced it yet, but
    // if it has, that entry is theirs.
    if (probesInFlight.get(proxyId) === claim) probesInFlight.delete(proxyId);
    release();
  }
}

/**
 * Run one sweep. Single-flight: a second call while one is running returns
 * `skipped` rather than queueing, because a queued sweep would run against a
 * cache the first one is still rewriting.
 *
 * ⚠️ Re-plans nothing mid-flight. The plan is computed once, up front, from one
 * consistent read of the cache and the proxy list. Recomputing between probes
 * would let a sweep that is writing fresh timestamps observe its own writes and
 * shrink its own worklist.
 *
 * (l) #15 — but it DOES re-check the per-proxy claim before each probe: a
 * proxy a user-initiated Test / pre-launch probe holds by then is skipped
 * (reported in `skippedBusy`), never probed a second time underneath them.
 */
export async function runSweep(deps: SweepDeps): Promise<SweepReport> {
  if (inFlight) return { refreshed: [], failed: [], skipped: true, skippedBusy: [] };
  inFlight = true;
  const refreshed: string[] = [];
  const failed: string[] = [];
  const skippedBusy: string[] = [];
  try {
    const [cache, proxies] = await Promise.all([deps.loadCache(), deps.listProxies()]);
    const checkEndpoint = deps.checkEndpoint;
    const plan = planSweep(cache, proxies, deps.now(), SWEEP_MAX_PER_RUN, {
      ...(deps.staleAfterMs !== undefined ? { staleAfterMs: deps.staleAfterMs } : {}),
      endpointRows: checkEndpoint !== undefined,
    });
    for (let i = 0; i < plan.length; i += 1) {
      const p = plan[i] as ProxyConfig;
      // Pause BETWEEN probes, never before the first — a sweep should not sit
      // idle for two seconds to do one probe.
      if (i > 0) await deps.sleep(SWEEP_GAP_MS);
      if (isProxyProbeInFlight(p.id)) {
        skippedBusy.push(p.id);
        continue;
      }
      try {
        // (q) Item 13(c) — dispatch by SCHEME, under the same claim and budget:
        // a VPN/HTTP row goes to its own check (planned only when one exists),
        // never to the SOCKS5 handshake.
        if (!isSocks5Probeable(p.scheme)) {
          if (checkEndpoint === undefined) continue; // unreachable: not planned without one
          await withProxyProbe(p.id, () => checkEndpoint(p));
          refreshed.push(p.id);
          continue;
        }
        await withProxyProbe(p.id, async () => {
          const result = await deps.testProxy(p);
          await deps.saveResult(p.id, result, deps.now());
        });
        refreshed.push(p.id);
      } catch {
        // Deliberately swallowed per-proxy: one unreachable host must not
        // abandon the rest of the sweep, and a failed probe is not a verdict.
        failed.push(p.id);
      }
    }
    return { refreshed, failed, skipped: false, skippedBusy };
  } finally {
    inFlight = false;
  }
}

/** The host surface installProxySweepSchedule needs — window timers + focus and
 *  document visibility. Abstracted so the schedule is unit-testable without a DOM
 *  (a fake host records what was scheduled and drives the listeners). */
export interface SweepScheduleHost {
  setTimeout: (fn: () => void, ms: number) => number;
  clearTimeout: (id: number) => void;
  setInterval: (fn: () => void, ms: number) => number;
  clearInterval: (id: number) => void;
  addFocus: (fn: () => void) => void;
  removeFocus: (fn: () => void) => void;
  addVisibility: (fn: () => void) => void;
  removeVisibility: (fn: () => void) => void;
  isVisible: () => boolean;
}

/**
 * N3 — schedule proxy-state refreshes on THREE triggers, all calling the SAME
 * single-flight `sweep`:
 *   1. a STAGGERED startup sweep (STARTUP_SWEEP_DELAY_MS — sooner than the full
 *      interval so opening the app updates data, but off the busy launch moment);
 *   2. the steady SWEEP_INTERVAL_MS interval (unchanged);
 *   3. a sweep whenever the window regains focus / the document becomes visible.
 *
 * The focus trigger is safe because `planSweep` only refreshes entries already
 * past their window (or a due failure retry): a sweep on focus therefore touches
 * genuinely-stale rows only, never fresh or unlooked-at ones — the concern that
 * removed an earlier unconditional onFocus refresh. Returns a cleanup that clears
 * both timers and removes both listeners.
 *
 * (q) Item 13(c) — each trigger hands the sweep ITS staleness window
 * (`SweepRun`): the startup and focus/visibility triggers a SHORT one
 * (`ACTIVE_SWEEP_STALE_MS`), the steady interval the full `PROBE_TTL_MS`.
 * MEASURED before this: all three gated on the 6 h TTL, so a SOCKS5 row tested
 * under 6 h ago refreshed on neither open nor focus — the owner-visible refresh
 * of a healthy-looking row was unchanged at 6 h by the three triggers. A
 * zero-arg `sweep` still type-checks and keeps the TTL on every trigger.
 */
export type SweepTrigger = 'startup' | 'interval' | 'focus';

export interface SweepRun {
  trigger: SweepTrigger;
  /** The window `planSweep` should use for this run (→ `SweepDeps.staleAfterMs`). */
  staleAfterMs: number;
}

/** (q) Item 13(c) — how old a verdict may be before an app-open / focus sweep
 *  refreshes it. Between the 15-min failure-retry floor and the 6 h TTL: a
 *  customer returning to the app sees rows re-checked when the last check is
 *  older than a coffee break, without a handshake storm on every alt-tab. */
export const ACTIVE_SWEEP_STALE_MS = 20 * 60 * 1000;

/** The staleness window each trigger passes — the interval keeps the TTL. */
export function staleAfterForTrigger(trigger: SweepTrigger): number {
  return trigger === 'interval' ? PROBE_TTL_MS : ACTIVE_SWEEP_STALE_MS;
}

export function installProxySweepSchedule(
  sweep: (run: SweepRun) => void,
  host: SweepScheduleHost,
): () => void {
  const fire = (trigger: SweepTrigger): void => {
    sweep({ trigger, staleAfterMs: staleAfterForTrigger(trigger) });
  };
  const startup = host.setTimeout(() => fire('startup'), STARTUP_SWEEP_DELAY_MS);
  const interval = host.setInterval(() => fire('interval'), SWEEP_INTERVAL_MS);
  const onActive = (): void => {
    if (host.isVisible()) fire('focus');
  };
  host.addFocus(onActive);
  host.addVisibility(onActive);
  return () => {
    host.clearTimeout(startup);
    host.clearInterval(interval);
    host.removeFocus(onActive);
    host.removeVisibility(onActive);
  };
}

/** Test seam — resets the single-flight latch (and the per-proxy claims)
 *  between cases. */
export function __resetSweepLatchForTests(): void {
  inFlight = false;
  probesInFlight.clear();
}
