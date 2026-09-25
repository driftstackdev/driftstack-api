// Background proxy re-check — P-8.
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

import { isProxyUsable, type ProxyConfig, type ProxyTestResult } from './proxies';
import {
  AGED_READING_MAX_MS,
  isProbeStaleAfter,
  PROBE_TTL_MS,
  verdictMatchesScheme,
  type CachedProbe,
  type CapabilityAttemptMap,
  type CapabilityCheckAttempt,
  type ProbeCacheMap,
} from './proxy-probe-cache';
import { isSocks5Probeable, isVpnScheme } from './proxy-scheme';
import {
  CAPABILITY_REFRESH_AFTER_MS,
  CAPABILITY_RETRY_AFTER_MS,
  SWEEP_INTERVAL_MS,
} from './proxy-reading-windows';

// ⛔ The three cadence numbers this module plans against now live in the
// import-free proxy-reading-windows, because the DISPLAY windows are derived from
// them and the cache that applies those windows cannot import this file (it would
// be a cycle — this file imports the cache). Re-exported unchanged so every
// existing importer and test keeps reading them from the sweep that owns them.
export { CAPABILITY_REFRESH_AFTER_MS, CAPABILITY_RETRY_AFTER_MS, SWEEP_INTERVAL_MS };

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

/* How often the driver attempts a sweep — `SWEEP_INTERVAL_MS`, defined in
 * proxy-reading-windows and re-exported above. Chosen against PROBE_TTL_MS: at
 * five proxies per sweep this refreshes twenty per hour, so a normal list stays
 * inside the TTL without the app ever probing in bursts. The first sweep is
 * deferred by one interval rather than fired at startup — launch is the busiest
 * moment for the machine, and nothing is stale-urgent in the first quarter hour.
 * It is ALSO the slack term in the display-window invariant: a reading whose
 * re-take falls due just after a sweep waits a whole slot for the next one. */

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
      // (p) 2026-09-16 — a SERVER-SEEDED entry is the never-tested case, not a
      // stale verdict: it exists only to carry the reading the server holds, and
      // its `result` is a fail-closed placeholder. Reading that placeholder as a
      // failing verdict would hand an unasked probe to every proxy the account
      // list mentions — the exact thing the never-tested rule above forbids.
      if (c.serverSeeded === true) return false;
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

// ─── The automatic CAPABILITY check ──────────────────────────────────────────
//
// The sweep above re-takes REACHABILITY, natively, from this Mac. What a proxy
// can carry — its QUIC and UDP readings, and the OS its stack presents as — is
// measured by Driftstack and was only ever taken when the customer pressed Test.
// Those readings leave the present tense after thirty minutes (rightly), so a
// proxy tested this morning read "not measured" by lunch and nothing would look
// again: the owner's "if it's missing … it should automatically check this proxy".
//
// ⛔ THIS IS NOT A SECOND SWEEP, and its limits are what make it shippable. One
// check dials the customer's proxy for ~11 s (a VPN one can hold a tunnel up for
// 95 s) on a machine every customer shares, so it runs a TRICKLE: three rows a
// run, one of them a VPN at most, each row at most once in six hours whatever
// came back — the cadence Driftstack's own background job settled on after
// rejecting thirty minutes as too costly for the customer's bandwidth.

/* `CAPABILITY_REFRESH_AFTER_MS` / `CAPABILITY_RETRY_AFTER_MS` — this cadence now
 * lives in proxy-reading-windows and is re-exported at the top of this file.
 *
 * ⛔ It used to say "deliberately NOT the thirty-minute display TTL: between the
 * two the reading shows AGED, which costs the customer nothing". That was wrong,
 * and it is the owner's complaint: with a six-hour cadence and a thirty-minute
 * window the AGED state was not the gap between refreshes, it was 92% of the life
 * of every healthy reading, so "green" was the rare state rather than the normal
 * one. The display window is now DERIVED from this number (`MEASURED_READING_TTL_MS`
 * = C + one sweep slot + margin), so lowering the cadence here narrows the window
 * with it and the two can no longer disagree. */

/** …and after the PLAN refusal, which no retry can change until the account does. */
export const CAPABILITY_PLAN_EXCLUDED_RETRY_MS = 24 * 60 * 60 * 1000;

/** Rows checked per run, and how many of them may be VPN rows. */
export const CAPABILITY_MAX_PER_RUN = 3;
export const CAPABILITY_MAX_VPN_PER_RUN = 1;

/**
 * The newest datable stamp among the readings that answer ONE question about a
 * row, or undefined when none of them can be dated — which is "never measured":
 * a reading with no date is shown by nothing, fresh or aged. A reading past the
 * aged cap is likewise shown by nothing, so it counts for nothing here either.
 */
function newestReadingAt(
  stamps: ReadonlyArray<number | undefined>,
  now: number,
): number | undefined {
  let newest: number | undefined;
  for (const t of stamps) {
    if (t === undefined || !Number.isFinite(t) || now - t >= AGED_READING_MAX_MS) continue;
    if (newest === undefined || t > newest) newest = t;
  }
  return newest;
}

/**
 * When each reading THIS KIND OF ROW can have was last taken — `undefined` per
 * reading for "never". Which readings a row can have is decided by its scheme,
 * because asking for one it cannot produce would plan the row for ever:
 *
 *   • a SOCKS5 row: its OS reading and its QUIC reading (the live session's or
 *     the Test's, whichever is newer — they answer one question). Its UDP state
 *     is the native check's own relay verdict (`udp_relay`: a datagram through
 *     the proxy's relay, never the bare ASSOCIATE grant — proxy-accuracy audit
 *     G1), which the reachability sweep keeps current; there is nothing of
 *     Driftstack's to re-take.
 *   • a VPN row: its QUIC and UDP readings. It has NO OS reading to take — there
 *     is no proxy stack behind a tunnel to fingerprint — and says so from its
 *     scheme, so OS is never a reason to bring a tunnel up.
 *
 * An OS entry that is a CAUSE rather than a reading answers the question for
 * good when no retry can change it (`vpn_tunnel`, `observer_off`); only
 * `not_observed` — the one cause a retry can clear — ages like a reading.
 */
function capabilityReadingStamps(
  p: Pick<ProxyConfig, 'scheme'>,
  entry: CachedProbe | undefined,
  now: number,
): Array<number | undefined> {
  const quic = newestReadingAt(
    [
      entry?.quicMeasured !== undefined ? entry.quicMeasuredAt : undefined,
      entry?.quicProbe !== undefined ? entry.quicProbeAt : undefined,
    ],
    now,
  );
  if (isVpnScheme(p.scheme)) {
    const udp = newestReadingAt(
      [entry?.udpProbe !== undefined ? entry.udpProbeAt : undefined],
      now,
    );
    return [quic, udp];
  }
  const fp = entry?.osFingerprint;
  const settledCause = fp?.unavailable === 'vpn_tunnel' || fp?.unavailable === 'observer_off';
  const os = settledCause ? now : newestReadingAt([fp?.at], now);
  return [os, quic];
}

/** The window the run budget is counted over. One sweep interval, so the steady
 *  schedule gets exactly the per-run budget it always had and every OTHER trigger
 *  (window focus, the Proxies tab opening) spends from the same purse. */
export const CAPABILITY_BUDGET_WINDOW_MS = SWEEP_INTERVAL_MS;

/** How long a "Driftstack answered in full and this reading was still missing"
 *  mark stands before the blank counts as never-measured again. */
export const CAPABILITY_NOT_PRODUCED_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * ⛔ THE BUDGET IS A RATE, NOT A PER-CALL CAP. MEASURED with it per call: three
 * back-to-back runs at one instant checked nine of nine rows, because the per-row
 * backoff only stops the SAME row repeating and each new run took the next three.
 * A run fires on every window focus, so after an upgrade (every relay verdict
 * undated → every row "never measured") a few alt-tabs dialled the whole saved
 * list through the customer's proxies, one VPN tunnel per focus event.
 *
 * What is left of the budget is read off the ledger itself — every automatic
 * check, the reachability sweep's VPN one included, stamps it BEFORE asking — so
 * it survives a restart and needs no second record to drift from the first.
 */
export function capabilityBudgetLeft(
  attempts: CapabilityAttemptMap,
  proxies: ReadonlyArray<ProxyConfig>,
  now: number,
  max: number = CAPABILITY_MAX_PER_RUN,
  maxVpn: number = CAPABILITY_MAX_VPN_PER_RUN,
): { rows: number; vpn: number } {
  const vpnIds = new Set(proxies.filter((p) => isVpnScheme(p.scheme)).map((p) => p.id));
  let rows = 0;
  let vpn = 0;
  for (const [id, a] of Object.entries(attempts)) {
    const age = now - a.capabilityCheckAttemptedAt;
    // (A stamp from the future is a clock that moved; it spends nothing.)
    if (a.capabilityCheckAttemptedAt <= 0 || age < 0 || age >= CAPABILITY_BUDGET_WINDOW_MS)
      continue;
    rows += 1;
    if (vpnIds.has(id)) vpn += 1;
  }
  return { rows: Math.max(0, max - rows), vpn: Math.max(0, maxVpn - vpn) };
}

/**
 * Whether the app will EVER check this row by itself as things stand — the
 * standing half of the plan, with no clock in it except the account refusal's.
 * The planner opens with it, and the grid reads it to decide whether an aged
 * chip may promise "It will be rechecked automatically." (a promise made to a row
 * this returns false for is a customer told to wait for nothing).
 *
 * ⛔ THE CONSENT RULE COMES FIRST AND NOTHING BELOW IT CAN RE-ADMIT A ROW. A
 * proxy with no `serverId` has never been stored on the account: its credentials
 * are device-only until the customer's own act (pressing Test / Check) uploads
 * them, and a background timer is not that act — see the note in
 * `checkEndpointRowForSweep`. Such a row is never planned, so it is never sent.
 *
 * Then, in order:
 *   • the scheme must be one Driftstack tests on request here — SOCKS5 or a VPN
 *     (an HTTP row gets its address check alone, on the grid and in the sweep);
 *   • a row whose local material CHANGED since the account last received it
 *     (`materialUnsynced`): the check never uploads, so it would test the OLD
 *     endpoint and write its readings onto the edited row;
 *   • a row whose LOCAL verdict is a failing one is the reachability sweep's
 *     business: nothing can be measured through a proxy that is down, and a
 *     check that says so again is a dial spent to learn nothing;
 *   • a VPN row must hold a resolved address check: that is the only thing its
 *     readings are ever shown beside, and a tunnel is too costly to bring up for
 *     a reading no surface would render. (A SOCKS5 row with no local verdict IS
 *     admitted — its OS reading shows on a row nobody has tested here.)
 *   • and an ACCOUNT refusal (its plan, its credential) inside its 24 h window:
 *     every row would be refused identically.
 */
export function isCapabilityRowCheckable(
  p: ProxyConfig,
  entry: CachedProbe | undefined,
  attempt: CapabilityCheckAttempt | undefined,
  now: number,
  hasApiKey: boolean,
): boolean {
  if (!hasApiKey) return false;
  if (p.serverId === undefined) return false; // ⛔ never uploaded → never sent
  const vpn = isVpnScheme(p.scheme);
  if (!vpn && !isSocks5Probeable(p.scheme)) return false;
  if (attempt?.materialUnsynced === true) return false;
  // A verdict of the wrong kind for this scheme (or a server-seeded entry) is
  // not a local verdict — `verdictMatchesScheme` is the one reading of that.
  const local =
    entry !== undefined && verdictMatchesScheme(isSocks5Probeable(p.scheme), entry)
      ? entry
      : undefined;
  if (local !== undefined) {
    const failing =
      local.fleetFailureReason !== undefined ||
      (local.endpoint !== undefined ? !local.endpoint.resolved : !isProxyUsable(local.result));
    if (failing) return false;
  }
  if (vpn && local === undefined) return false;
  if (
    attempt?.planExcluded === true &&
    now - attempt.capabilityCheckAttemptedAt < CAPABILITY_PLAN_EXCLUDED_RETRY_MS
  )
    return false;
  return true;
}

/** The rows an aged chip may promise a recheck for — `isCapabilityRowCheckable`
 *  over a list, keyed by proxy id. Absent = name the button instead. */
export function capabilityRecheckPromises(
  cache: ProbeCacheMap,
  attempts: CapabilityAttemptMap,
  proxies: ReadonlyArray<ProxyConfig>,
  now: number,
  hasApiKey: boolean,
): Record<string, true> {
  const out: Record<string, true> = {};
  for (const p of proxies) {
    if (isCapabilityRowCheckable(p, cache[p.id], attempts[p.id], now, hasApiKey)) out[p.id] = true;
  }
  return out;
}

/**
 * Whether an automatic SERVER check of this row is due, by the two clocks that
 * bound one — shared by the planner and by the reachability sweep's VPN check
 * (`checkEndpointRowForSweep`), so the sweep cannot be the door the backoff is
 * walked round through:
 *
 *   • BACKOFF: never within `CAPABILITY_RETRY_AFTER_MS` of the last automatic
 *     attempt, whatever came back; 24 h after an account refusal;
 *   • and never within `CAPABILITY_REFRESH_AFTER_MS` of the last time Driftstack
 *     ANSWERED for the row (`serverProbeAt` — a Test the customer pressed counts):
 *     every leg that can be taken has just been taken.
 */
export function isAutomaticServerCheckDue(
  entry: CachedProbe | undefined,
  attempt: CapabilityCheckAttempt | undefined,
  now: number,
): boolean {
  if (attempt !== undefined) {
    const wait =
      attempt.planExcluded === true ? CAPABILITY_PLAN_EXCLUDED_RETRY_MS : CAPABILITY_RETRY_AFTER_MS;
    if (now - attempt.capabilityCheckAttemptedAt < wait) return false;
  }
  return !(
    entry?.serverProbeAt !== undefined && now - entry.serverProbeAt < CAPABILITY_REFRESH_AFTER_MS
  );
}

/** Whether a reading this kind of row should have is missing from its entry —
 *  what the automatic check reads AFTER a full answer to learn that this proxy
 *  does not produce it (`readingsNotProducedAt`). */
export function hasUnmeasuredCapabilityReading(
  p: Pick<ProxyConfig, 'scheme'>,
  entry: CachedProbe | undefined,
  now: number,
): boolean {
  return capabilityReadingStamps(p, entry, now).some((t) => t === undefined);
}

export interface PlanCapabilityOptions {
  /** ⛔ Without an API key nothing can be asked of Driftstack: the plan is empty. */
  hasApiKey: boolean;
  max?: number;
  maxVpn?: number;
  /** Plan as if nothing had been spent in the budget window. ONLY for questions
   *  about eligibility (which rows an account refusal applies to; whether ONE row
   *  is still eligible when its turn comes) — never for what a run will send. */
  ignoreBudget?: boolean;
}

/**
 * Which rows this run should ask Driftstack to check, in order. Pure — `now`
 * injected, no I/O — so every exclusion below is testable.
 *
 * A row must be CHECKABLE at all (`isCapabilityRowCheckable` — the consent rule
 * and the standing exclusions live there) and DUE (`isAutomaticServerCheckDue` —
 * the two clocks). What remains is ELIGIBLE when at least one of its readings was
 * never taken or is older than `CAPABILITY_REFRESH_AFTER_MS`.
 *
 * ⛔ "NEVER TAKEN" STOPS COUNTING ONCE DRIFTSTACK HAS ANSWERED IN FULL AND THE
 * READING WAS STILL MISSING (`readingsNotProducedAt`, for
 * `CAPABILITY_NOT_PRODUCED_RETRY_MS`). A VPN's QUIC leg is skipped today, so its
 * QUIC reading stays blank whatever is asked; counted as never-measured it
 * re-planned every saved VPN row, and brought a tunnel up, every six hours for
 * ever. The row is then planned on its DATED readings alone, like any other.
 *
 * SCOPE, stated: which readings count is decided per scheme in
 * `capabilityReadingStamps` — a SOCKS5 row's UDP state is the native handshake's
 * and is not re-taken here; an HTTP row is not planned at all.
 *
 * Never-measured rows first (the customer is looking at a blank), then the oldest
 * reading first; ties go to the row attempted longest ago, so a long list rotates
 * instead of starving its tail. At most `max` rows and `maxVpn` VPN rows PER
 * BUDGET WINDOW (`capabilityBudgetLeft`), not per call.
 */
export function planCapabilityRefresh(
  cache: ProbeCacheMap,
  attempts: CapabilityAttemptMap,
  proxies: ReadonlyArray<ProxyConfig>,
  now: number,
  opts: PlanCapabilityOptions,
): ProxyConfig[] {
  if (!opts.hasApiKey) return [];
  const spendable =
    opts.ignoreBudget === true
      ? { rows: opts.max ?? CAPABILITY_MAX_PER_RUN, vpn: opts.maxVpn ?? CAPABILITY_MAX_VPN_PER_RUN }
      : capabilityBudgetLeft(attempts, proxies, now, opts.max, opts.maxVpn);
  const max = spendable.rows;
  const maxVpn = spendable.vpn;
  if (max <= 0) return [];
  const candidates: Array<{ p: ProxyConfig; never: boolean; oldest: number; attemptedAt: number }> =
    [];
  for (const p of proxies) {
    const entry = cache[p.id];
    const attempt = attempts[p.id];
    if (!isCapabilityRowCheckable(p, entry, attempt, now, true)) continue;
    if (!isAutomaticServerCheckDue(entry, attempt, now)) continue;
    const stamps = capabilityReadingStamps(p, entry, now);
    const notProduced =
      attempt?.readingsNotProducedAt !== undefined &&
      now - attempt.readingsNotProducedAt < CAPABILITY_NOT_PRODUCED_RETRY_MS;
    const never = !notProduced && stamps.some((t) => t === undefined);
    const dated = stamps.filter((t): t is number => t !== undefined);
    if (!never && dated.length === 0) continue; // nothing this row produces is due
    const oldest = dated.length > 0 ? Math.min(...dated) : now;
    if (!never && now - oldest < CAPABILITY_REFRESH_AFTER_MS) continue;
    candidates.push({
      p,
      never,
      oldest,
      attemptedAt: attempt?.capabilityCheckAttemptedAt ?? Number.NEGATIVE_INFINITY,
    });
  }
  candidates.sort((a, b) => {
    if (a.never !== b.never) return a.never ? -1 : 1;
    if (!a.never && a.oldest !== b.oldest) return a.oldest - b.oldest;
    return a.attemptedAt - b.attemptedAt;
  });
  const plan: ProxyConfig[] = [];
  let vpnPlanned = 0;
  for (const c of candidates) {
    if (plan.length >= max) break;
    if (isVpnScheme(c.p.scheme)) {
      if (vpnPlanned >= maxVpn) continue; // over the VPN cap: the slot goes to the next row
      vpnPlanned += 1;
    }
    plan.push(c.p);
  }
  return plan;
}

/** What one automatic check came to, as far as the RUN needs to know. */
export interface CapabilityCheckResult {
  /** Driftstack answered (anything). False = the request never got a reply. */
  answered: boolean;
  /** The answer was a refusal of the ACCOUNT — its plan, or the credential it
   *  signed in with. Every other row would be refused identically. */
  accountRefused: boolean;
}

/** Everything the capability run touches, injected like `SweepDeps`. */
export interface CapabilityRefreshDeps {
  loadCache: () => Promise<ProbeCacheMap>;
  /** ⛔ Must REJECT when the ledger cannot be read (`loadCapabilityAttempts`
   *  does): an unreadable ledger answered as `{}` reads "nothing was ever
   *  attempted", and the run would dial every row. */
  loadAttempts: () => Promise<CapabilityAttemptMap>;
  listProxies: () => Promise<ReadonlyArray<ProxyConfig>>;
  /** Read at RUN time, never captured: the key the customer signed in with an
   *  hour after launch is the one that must be used. */
  readCreds: () => { baseUrl: string; apiKey: string | null };
  /** Stamp the backoff for these rows. ⛔ A rejection aborts the row: a check
   *  whose attempt could not be recorded is a check nothing will ever bound. */
  recordAttempt: (proxyIds: string[], at: number, planExcluded: boolean) => Promise<unknown>;
  /** Drop ledger records of proxies that no longer exist. Best-effort. */
  pruneAttempts?: (liveProxyIds: string[]) => Promise<unknown>;
  /** Ask Driftstack to check ONE already-stored row and persist what it says
   *  (`checkCapabilitiesForRow` in lib/proxy-server-test). ⛔ Must never store,
   *  create or update the row on the account — see the consent rule above. */
  check: (
    p: ProxyConfig,
    creds: { baseUrl: string; apiKey: string },
  ) => Promise<CapabilityCheckResult>;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}

export interface CapabilityRefreshReport {
  checked: string[];
  failed: string[];
  skippedBusy: string[];
  /** Planned rows that were no longer eligible when their turn came — tested by
   *  the customer meanwhile, edited, deleted, stamped by another path, or left
   *  without budget because another path spent it since the plan was made. */
  skippedChanged: string[];
  /** True when a run (or a reachability sweep) was in flight and this call did
   *  nothing. */
  skipped: boolean;
}

let capabilityInFlight = false;

/**
 * Whether an automatic capability run is in flight — the OTHER half of "after,
 * never beside". The run has always refused to start while a sweep is probing;
 * nothing told the sweep about a run, and a run lasts minutes (11–95 s a row), so
 * a window focus during one started a full sweep beside it. MEASURED: the sweep's
 * VPN check read the ledger live, found budget, stamped and tested its row; the
 * run then reached its own planned VPN row, re-validated it as still eligible,
 * and tested that too — four rows and two tunnels inside one window, possibly at
 * once, against "at most three rows and one VPN, whoever asks".
 *
 * ⛔ ONLY the sweep's SERVER test consults this (`checkEndpointRowForSweep`). The
 * sweep itself still runs beside a capability run on purpose: its native
 * handshakes and address checks are what keep the verdicts a bulk launch trusts
 * young, and parking them behind a multi-minute run on every focus would starve
 * the thing the sweep exists for. The row it skips is not stamped, so the run's
 * own follow-up — or the next sweep — takes it from the same purse.
 */
export function isCapabilityRunInFlight(): boolean {
  return capabilityInFlight;
}

/**
 * The account rows Driftstack is being asked to test RIGHT NOW, whoever asked:
 * the grid's Test, the card's, the sweep's VPN check, this run. Keyed on the
 * ACCOUNT row id, because that is what the request names.
 *
 * ⛔ SEPARATE FROM `probesInFlight` ON PURPOSE. That claim makes user callers
 * QUEUE, and the pre-launch probe takes it: held across a server test (30 s for a
 * SOCKS5 row, 95 s for a VPN) it let a background timer stall a profile launch
 * with nothing on screen to say why. And it never covered what it needed to — the
 * manual Test claims only its native handshake, then asks Driftstack OUTSIDE the
 * claim, so the run could not see the customer's own server test and sent a
 * second one through the same proxy beside it. Every server test registers here
 * (`testProxyOnServer` does it for all of them). An AUTOMATIC caller that finds
 * the row taken skips it; the customer's own test waits for an automatic one to
 * finish and then runs — two tests at once through one proxy is how the second
 * gets "busy" for an answer, and that must never be the one they pressed.
 */
const serverTestsInFlight = new Map<string, Promise<void>>();

/** Whether Driftstack is being asked to test this account row now (any caller). */
export function isServerTestInFlight(serverId: string): boolean {
  return serverTestsInFlight.has(serverId);
}

/** Run `test` as THE server test of this account row: waits for one already
 *  running against it, then holds the registration until `test` settles. */
export async function withServerTest<T>(serverId: string, test: () => Promise<T>): Promise<T> {
  while (serverTestsInFlight.has(serverId)) {
    await serverTestsInFlight.get(serverId)?.catch(() => undefined);
  }
  let release!: () => void;
  const claim = new Promise<void>((resolve) => {
    release = resolve;
  });
  serverTestsInFlight.set(serverId, claim);
  try {
    return await test();
  } finally {
    if (serverTestsInFlight.get(serverId) === claim) serverTestsInFlight.delete(serverId);
    release();
  }
}

/**
 * Run one automatic capability check. Single-flight like `runSweep` — the two
 * triggers (after each reachability sweep; the Proxies tab opening) can land
 * together, and opening the tab twice must not check a row twice. The latch
 * covers the overlap; the backoff stamp, written BEFORE each request, covers the
 * second open that arrives after the first has finished; and the budget is a
 * rate (`capabilityBudgetLeft`), so a burst of triggers spends one purse.
 *
 * ⛔ It does not run BESIDE a reachability sweep: the installed schedule runs it
 * after each one, and a trigger that lands while a sweep is still probing (the
 * tab opening, a second focus) is answered `skipped` — one customer's proxies are
 * not dialled by two loops at once, and the sweep's own follow-up covers it.
 *
 * Serial with `SWEEP_GAP_MS` between rows. ⛔ EACH ROW IS RE-VALIDATED WHEN ITS
 * TURN COMES, from a fresh read of the row, its entry and its ledger record: a
 * run lasts minutes (11–95 s a row), and a row the customer tested, edited or
 * deleted meanwhile must not be dialled on the strength of a plan made before.
 * (`runSweep` does not re-plan because it would observe its own writes; here a
 * row's only own write is its stamp, made AFTER its re-validation.) A row under a
 * native probe or a server test right now is skipped, unstamped — that test is
 * the fresher answer. The per-proxy probe claim is consulted and NOT held: see
 * `serverTestsInFlight`.
 *
 * Two outcomes end the RUN, not just the row: no reply at all (the server is not
 * answering — spending the other rows' six-hour backoff to learn that twice more
 * helps nobody), and an account refusal: every other eligible row would be
 * refused identically, so they are all stamped with it in one write rather than
 * each costing a request to find out.
 */
export async function runCapabilityRefresh(
  deps: CapabilityRefreshDeps,
): Promise<CapabilityRefreshReport> {
  const nothing = (skipped: boolean): CapabilityRefreshReport => ({
    checked: [],
    failed: [],
    skippedBusy: [],
    skippedChanged: [],
    skipped,
  });
  if (capabilityInFlight || inFlight) return nothing(true);
  capabilityInFlight = true;
  const report = nothing(false);
  try {
    const { baseUrl, apiKey } = deps.readCreds();
    if (apiKey === null || apiKey.length === 0) return report;
    const creds = { baseUrl, apiKey };
    const read = (): Promise<[ProbeCacheMap, CapabilityAttemptMap, ReadonlyArray<ProxyConfig>]> =>
      Promise.all([deps.loadCache(), deps.loadAttempts(), deps.listProxies()]);
    const [cache, attempts, proxies] = await read();
    // ⛔ Never on an EMPTY list: a transient empty read of the proxy store would
    // otherwise wipe every row's backoff, and there is nothing to plan anyway.
    if (proxies.length > 0) {
      await deps.pruneAttempts?.(proxies.map((p) => p.id)).catch(() => undefined);
    }
    const plan = planCapabilityRefresh(cache, attempts, proxies, deps.now(), { hasApiKey: true });
    for (let i = 0; i < plan.length; i += 1) {
      const planned = plan[i] as ProxyConfig;
      if (i > 0) await deps.sleep(SWEEP_GAP_MS);
      let stop = false;
      try {
        const [cacheNow, attemptsNow, proxiesNow] =
          i === 0 ? [cache, attempts, proxies] : await read();
        const p = proxiesNow.find((row) => row.id === planned.id);
        const stillEligible =
          p !== undefined &&
          planCapabilityRefresh(cacheNow, attemptsNow, [p], deps.now(), {
            hasApiKey: true,
            ignoreBudget: true,
          }).length === 1;
        if (p === undefined || !stillEligible) {
          report.skippedChanged.push(planned.id);
          continue;
        }
        // ⛔ …AND THE PURSE IS RE-READ TOO, from the same fresh ledger. The question
        // above is asked with `ignoreBudget` because it is about ONE row's
        // eligibility (the run's own earlier stamps must not make a one-row plan
        // come back empty for the wrong reason) — but that also made the run deaf to
        // anything ANOTHER path spent since the plan was made, and the plan's
        // budget was a promise about a ledger minutes old. Counted here instead:
        // what is left is read off the ledger as it stands, which holds this run's
        // own stamps (each written before its request) beside everyone else's, so
        // nothing is counted twice and nothing is missed. This row's own record
        // cannot be inside the window — it would not be due.
        const left = capabilityBudgetLeft(attemptsNow, proxiesNow, deps.now());
        if (left.rows <= 0 || (isVpnScheme(p.scheme) && left.vpn <= 0)) {
          report.skippedChanged.push(planned.id);
          continue;
        }
        if (
          isProxyProbeInFlight(p.id) ||
          (p.serverId !== undefined && isServerTestInFlight(p.serverId))
        ) {
          report.skippedBusy.push(p.id);
          continue;
        }
        // ⛔ Stamped BEFORE the request: a check that hangs, throws, or is cut
        // off by the app quitting must still have used its turn.
        await deps.recordAttempt([p.id], deps.now(), false);
        const result = await deps.check(p, creds);
        if (result.accountRefused) {
          const everyEligible = planCapabilityRefresh(
            cacheNow,
            attemptsNow,
            proxiesNow,
            deps.now(),
            {
              hasApiKey: true,
              max: Number.POSITIVE_INFINITY,
              maxVpn: Number.POSITIVE_INFINITY,
              ignoreBudget: true,
            },
          ).map((row) => row.id);
          await deps.recordAttempt([...new Set([p.id, ...everyEligible])], deps.now(), true);
          stop = true;
        } else if (!result.answered) {
          stop = true;
        }
        report.checked.push(p.id);
      } catch {
        // One row's failure must not abandon the rest — the `runSweep` rule.
        report.failed.push(planned.id);
      }
      if (stop) break;
    }
    return report;
  } finally {
    capabilityInFlight = false;
  }
}

/** Test seam — resets the single-flight latches (and the per-proxy claims)
 *  between cases. */
export function __resetSweepLatchForTests(): void {
  inFlight = false;
  capabilityInFlight = false;
  probesInFlight.clear();
  serverTestsInFlight.clear();
}
