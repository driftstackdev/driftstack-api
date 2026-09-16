// ITEM 4 — KEEP A SAVED PROXY'S STATUS AND EXIT IP CURRENT, IN THE BACKGROUND.
//
// The owner's complaint — "we are not saving the OS fingerprint of already
// checked proxies" — is really two problems, and the storage half was already
// fixed: the /:id/test route persists the reading onto `account_proxies`. What is
// missing is that the reading is only ever TAKEN when a person presses Test on
// one machine. On a second Mac, or after a reinstall, the desktop client's
// 30-minute local cache is empty and the row's reading may be months old — the
// exact staleness `agent-sessions.ts` refuses to project into a live cockpit.
//
// This chain re-takes it. Slowly, serially, and with the customer's bandwidth in
// mind, because every refresh is a real TCP connection through THEIR proxy.
//
// ─── WHAT THE CADENCE COSTS THEM ────────────────────────────────────────────
// PROXY_FRESHNESS_REFRESH_INTERVAL_MS is 6 hours: four dials per proxy per day,
// each one a SOCKS5/HTTP handshake plus a ~200-byte echo round-trip, plus (only
// when the probe succeeded and an observer is configured) one more handshake that
// carries no payload at all. That is the lightest cadence that still answers "is
// this proxy alive and where does it exit" for someone opening the app on a
// machine that has never tested it. Anything near the client's own 30-minute
// cache TTL would be dialling a residential proxy 48 times a day to refresh a
// value that does not change that fast, on a connection the customer pays for.
//
// ⚠️⚠️ AND THIS CADENCE DOES NOT REACH THE DESKTOP CHIP. This header used to
// justify 6 hours with "the reading is DATED on the row, so a consumer can always
// say how old it is rather than needing it to be young". That is false of the
// consumer that exists. `apps/gui-client/src/lib/os-fingerprint-verdict.ts`
// OS_FINGERPRINT_TTL_MS is 30 minutes and `proxy-probe-cache.ts` applies it to
// SERVER-SEEDED readings too (`deriveProbeViewState` drops the entry unless
// `isOsFingerprintFresh`), so a reading this sweep keeps at most 6 hours old is
// displayable for 30 of every 360 minutes — the owner's complaint stays visibly
// unfixed ~92% of the wall clock on a second Mac.
//
// The two numbers were chosen apart and they have to be chosen together. The
// cadence is not the half that should move: 30 minutes is the bandwidth cost this
// header rightly refuses, and halving it to an hour still leaves the chip dark
// half the time. The half that should move is the CONSUMER'S TTL FOR A SERVER-
// SEEDED READING — a locally-measured reading is bounded only by when the
// customer last pressed Test, while a server-seeded one is backed by a guaranteed
// re-measurement cadence and arrives with its own date, so it can honestly render
// as "measured 4h ago" where an undated local one could not. That change lives in
// the desktop client, which is another item's surface and carries its own pinned
// arms; it is NOT made here. What IS here is the pin:
// `a-background-proxy-refresh-never-condemns-on-one-failure` reads both constants
// out of their two sources and fails if either moves, so the next person to touch
// one is handed the other. Until the client half lands, what this sweep actually
// delivers is the SERVER-side consumers, which have no TTL: the stored exit the
// /proxies and /test routes return and the OS reading
// `agent-sessions.ts readSessionProxyOsFingerprint` projects into a live cockpit.
//
// And it only dials when nobody else has. A proxy is due only when its STORED
// EXIT is older than that window, so an exit a live session's relay or the
// customer's own Test wrote an hour ago takes this sweep out of the picture
// entirely — a current reading is the goal, not a reading of our own.
//
// ─── WHY THE TICK MUST FINISH FAST ──────────────────────────────────────────
// `scheduled_jobs` claims a job under a 5-MINUTE stale lock. A handler that
// outruns it is re-claimed and RUN AGAIN CONCURRENTLY while the first invocation
// is still going (scheduled-jobs.ts `reportLostLock`). For a sweep that DIALS
// CUSTOMER PROXIES that is not a bookkeeping problem — it is two connections
// through someone's proxy for one scheduled refresh. So the tick carries its own
// wall-clock budget, and the budget is DERIVED FROM THE WIRED PROBE:
//
//   worst case for ONE proxy = probe.effectiveTimeoutMs      (12s at defaults)
//                            + probe.observeWorstCaseMs      (16s, see below)
//                            + PROXY_FRESHNESS_GAP_MS        ( 2s)
//                                                            = 30s at defaults
//   budget = min(PROXY_FRESHNESS_TICK_BUDGET_MS,
//                LEASE − LEASE_SAFETY_MS − worstCasePerProxy)
//   overshoot bound = budget + one proxy's worst case ≤ LEASE − LEASE_SAFETY_MS
//                                                     = 240s against a 300s lease
//
// ⛔ BOTH INPUTS USED TO BE READ FROM MODULE CONSTANTS AND BOTH WERE WRONG.
//   * The probe leg came from the compile-time `DEFAULT_PROBE_TIMEOUT_MS`, but
//     bootstrap.ts passes `DRIFTSTACK_PROXY_PROBE_TIMEOUT_MS` when it is set —
//     env-tunable ON PURPOSE "so the budget can be retuned for slow residential/
//     mobile proxies without a code change". A deployment that raised it to 120s
//     had a real per-proxy ceiling of 138s against a sum that still said 20s.
//   * The observer leg counted ONE 6s budget. `observeOs` arms its budgets in
//     SERIES and then does more network work after them: dial(6s), a second 6s
//     tunnel deadline, then up to two sequential observer lookups at
//     OS_OBSERVER_LOOKUP_TIMEOUT_MS each = 16s, not 6s.
//     (`OS_OBSERVE_WORST_CASE_MS` now states that sum where it can be seen.)
//
// So the sum is taken from the instance that will actually dial, and the budget
// is CLAMPED so `budget + worstCase` cannot reach the lease whatever the env says
// — a deployment that raises the probe timeout shortens the tick instead of
// silently eating the lease's headroom. A probe timeout so large that even ONE
// proxy cannot fit clamps the budget to zero: the tick claims nothing and says
// so, which is the honest outcome and the only one that is not a double-dial.
//
// The budget is checked BEFORE each claim, so the tick can exceed it by at most
// one proxy. When it stops early it RE-ARMS normally: the rows it did not reach
// are still due and the next tick, five minutes later, takes them. Stopping short
// is always cheaper than being run twice.
//
// ─── SHAPE, COPIED FROM THE DESKTOP SWEEPER ─────────────────────────────────
// `apps/gui-client/src/lib/proxy-probe-sweeper.ts` already solved "refresh a list
// of proxies without hammering them": at most 5 per run, a 2s gap, strictly
// SERIAL, never parallel. Parallel probes would finish the tick faster and would
// be exactly wrong — five simultaneous connections is what a customer's provider
// sees as abuse, and the point of a background sweep is to be unnoticeable.
//
// ─── FAILURE IS NOT A VERDICT ───────────────────────────────────────────────
// `db/webhooks-repo.ts` records the precedent this follows: `recordRetry`
// deliberately does NOT bump `consecutive_failures`; only `recordDlq` does. A
// transient failure must not become customer-visible state. Here a failed probe
// writes `freshness_consecutive_failures` and nothing else — not the exit, not
// the fingerprint, not even `updated_at`. Only the THIRD consecutive failure
// (PROXY_FRESHNESS_CONDEMN_AFTER_FAILURES) touches anything a customer can see,
// and then only the `exit_superseded_at` stamp that says "the stored exit was
// contradicted". Three is chosen against the backoff: attempts land at ~6h, ~12h
// and ~18h, so the stamp means "unreachable from here across roughly a day and
// three independent dials", not "we hit a blip". The next success clears it via
// the ordinary exit write, so a provider outage heals itself.
//
// ⛔ THE SWEEP NEVER MARKS A PROXY BAD. There is no `status` column it can flip
// and it does not write one; the strongest thing it can say is that a stored
// exit is stale. A customer whose proxy is fine but momentarily unreachable from
// our network sees NOTHING change.

import type { AccountProxiesRepo, AccountProxyRow } from '../db/account-proxies-repo.js';
import type { Logger } from '../lib/logger.js';
import type {
  OsObservation,
  ProbeProxyDescriptor,
  ProxyProbeResult,
} from './proxy-connectivity-probe.js';
import { DEFAULT_PROBE_TIMEOUT_MS, OS_OBSERVE_WORST_CASE_MS } from './proxy-connectivity-probe.js';
import { SCHEDULED_JOB_STALE_LOCK_MS } from '../db/scheduled-jobs-repo.js';
import {
  customerOsFingerprintReason,
  exitObservationUpdates,
  osFingerprintUpdates,
  readingWasTakenThroughCurrentIdentity,
  type ObservedOsFingerprint,
} from './proxy-reading-persist.js';
import type { ScheduledJobRow, ScheduledJobsService } from './scheduled-jobs.js';

export const PROXY_FRESHNESS_JOB_TYPE = 'proxy.freshness_refresh';

/** Re-arm cadence for the CHAIN. Five minutes is how often the sweep looks for
 *  work, not how often a proxy is dialled — that is the refresh interval below.
 *  Short enough that a small deployment's proxies all get through in a few ticks;
 *  a tick with nothing due does one indexed query and stops. */
export const PROXY_FRESHNESS_CHAIN_INTERVAL_MS = 5 * 60 * 1000;

/** How long ONE proxy is left alone between background refreshes. See the header
 *  for what four dials a day buys and why nothing shorter is justified. */
export const PROXY_FRESHNESS_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Proxies per tick. The desktop sweeper's SWEEP_MAX_PER_RUN, deliberately the
 *  same number: it is the batch size that has been probing customer proxies in
 *  production without complaint. */
export const PROXY_FRESHNESS_MAX_PER_TICK = 5;

/** Gap between probes. The desktop sweeper's SWEEP_GAP_MS. */
export const PROXY_FRESHNESS_GAP_MS = 2_000;

/** Wall-clock budget for one tick, BEFORE the lease clamp below. See the
 *  header's arithmetic — this number only means anything beside the lease. */
export const PROXY_FRESHNESS_TICK_BUDGET_MS = 120_000;

/** Slack left unused at the end of the lease. The tick must not merely fit the
 *  lease, it must finish with room for the settle write to commit — and
 *  `scheduled-jobs.ts` treats a handler that outran its lease as HAVING RUN TWICE
 *  (`settle` is fenced on `locked_by` and returns false). A minute is cheap
 *  insurance against a slow settle on a loaded database. */
export const PROXY_FRESHNESS_LEASE_SAFETY_MS = 60_000;

/**
 * The longest ONE proxy can take, computed from the probe that will actually
 * dial it: its effective (possibly env-raised) connectivity deadline, the real
 * worst case of its OS observation, and the gap that follows.
 *
 * ⛔ NOT from module constants. `DEFAULT_PROBE_TIMEOUT_MS` is the default, not
 * the wired value (bootstrap makes it env-tunable), and `OS_OBSERVE_TIMEOUT_MS`
 * is ONE of the three budgets `observeOs` can spend in series. A ceiling taken
 * from either is a number about a probe this job is not using — and the lease
 * argument in the header is only as true as this sum.
 *
 * A probe that exposes neither accessor (a hand-written fake in a test) falls
 * back to the defaults, which is the same ceiling the constants used to assert.
 */
export function proxyFreshnessWorstCasePerProxyMs(probe: ProxyFreshnessProbe): number {
  const probeLeg = probe.effectiveTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const observeLeg =
    probe.observeWorstCaseMs ??
    (typeof probe.observeOs === 'function' ? OS_OBSERVE_WORST_CASE_MS : 0);
  return probeLeg + observeLeg + PROXY_FRESHNESS_GAP_MS;
}

/**
 * The budget this tick may actually spend, clamped so that
 * `budget + worstCasePerProxy ≤ lease − safety` HOLDS FOR EVERY WIRED PROBE.
 *
 * Returns 0 — claim nothing — when a single proxy's ceiling already exceeds the
 * safe window. That is a real configuration (a probe timeout past ~222s) and the
 * only safe answer to it: a tick that cannot guarantee it will finish inside the
 * lease must not start, because the scheduler's response to an overrun is to run
 * the handler AGAIN, concurrently, dialling the customer's proxy a second time.
 */
export function proxyFreshnessEffectiveBudgetMs(args: {
  configuredBudgetMs: number;
  worstCasePerProxyMs: number;
  leaseMs?: number;
}): number {
  const lease = args.leaseMs ?? SCHEDULED_JOB_STALE_LOCK_MS;
  const safeWindow = lease - PROXY_FRESHNESS_LEASE_SAFETY_MS - args.worstCasePerProxyMs;
  return Math.max(0, Math.min(args.configuredBudgetMs, safeWindow));
}

/** Consecutive background failures before the stored exit is marked contradicted.
 *  Three, ~18h apart under the backoff. */
export const PROXY_FRESHNESS_CONDEMN_AFTER_FAILURES = 3;

/** Cap on the linear failure backoff: a proxy that keeps failing is retried at
 *  interval × min(failures + 1, this) — so 6h, 12h, 18h, then 24h forever. A
 *  proxy the customer switched off in March is dialled once a day, not four
 *  times, and it never falls out of the sweep entirely (it must be able to come
 *  back on its own the moment it is switched on again). */
export const PROXY_FRESHNESS_MAX_BACKOFF_STEPS = 4;

/** The probe surface this job needs. `observeOs` is optional because the OS
 *  observer is off on deployments with no DS_OS_OBSERVER_HOST, and an absent
 *  observer must mean "no OS reading this round", never a failed refresh. */
export interface ProxyFreshnessProbe {
  probe(descriptor: ProbeProxyDescriptor): Promise<ProxyProbeResult>;
  observeOs?(descriptor: ProbeProxyDescriptor, exitIp?: string): Promise<OsObservation>;
  /** This instance's effective `probe()` deadline. `ProxyConnectivityProbe`
   *  exposes it because bootstrap can raise it from the environment, and the
   *  tick's lease arithmetic must be done against the probe that will dial. */
  readonly effectiveTimeoutMs?: number;
  /** The most one `observeOs` call can spend on this instance — 0 when no
   *  observer is configured, so a deployment without one budgets nothing. */
  readonly observeWorstCaseMs?: number;
}

/** Resolves a claimed row to something dialable. `AccountProxiesService`. */
export interface ProxyFreshnessResolver {
  resolveProbeDescriptor(args: {
    proxyId: string;
    accountId: string;
  }): Promise<ProbeProxyDescriptor | null>;
}

export interface ProxyFreshnessTickDeps {
  proxies: Pick<
    AccountProxiesRepo,
    'claimDueForFreshnessRefresh' | 'findById' | 'update' | 'recordFreshnessFailure'
  >;
  resolver: ProxyFreshnessResolver;
  /** Undefined on a deployment with no probe wired (a fixture, or no master
   *  key): the tick claims nothing and does nothing. */
  probe?: ProxyFreshnessProbe | undefined;
  logger?: Logger;
  nowFn?: () => number;
  /** Injectable so a test does not spend the real 2s gap. */
  sleepFn?: (ms: number) => Promise<void>;
  maxPerTick?: number;
  budgetMs?: number;
}

export interface ProxyFreshnessTickResult {
  claimed: number;
  refreshed: number;
  failed: number;
  skipped: number;
  stoppedAtBudget: boolean;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * One sweep tick. Exported so the budget and the per-proxy decisions can be
 * driven directly, without a scheduler in the way.
 *
 * Claims ONE row at a time rather than a batch of five. That is not a
 * simplification — it is what makes the budget honest: a batch claim stamps the
 * attempt on every row it takes, so a tick that stopped early would leave rows
 * marked "attempted" that were never dialled, and they would wait a full refresh
 * interval for a probe that never happened.
 */
export async function runProxyFreshnessTick(
  deps: ProxyFreshnessTickDeps,
): Promise<ProxyFreshnessTickResult> {
  const now = deps.nowFn ?? Date.now;
  const sleep = deps.sleepFn ?? defaultSleep;
  const maxPerTick = deps.maxPerTick ?? PROXY_FRESHNESS_MAX_PER_TICK;
  const startedAt = now();
  const result: ProxyFreshnessTickResult = {
    claimed: 0,
    refreshed: 0,
    failed: 0,
    skipped: 0,
    stoppedAtBudget: false,
  };
  const probe = deps.probe;
  if (probe === undefined) return result;
  // Both from the probe that will actually dial, never from module defaults —
  // see the header and `proxyFreshnessWorstCasePerProxyMs`.
  const worstCasePerProxyMs = proxyFreshnessWorstCasePerProxyMs(probe);
  const budgetMs = proxyFreshnessEffectiveBudgetMs({
    configuredBudgetMs: deps.budgetMs ?? PROXY_FRESHNESS_TICK_BUDGET_MS,
    worstCasePerProxyMs,
  });

  for (let i = 0; i < maxPerTick; i += 1) {
    // Before the claim, never after: a row is only stamped as attempted if this
    // tick is actually going to dial it.
    if (now() - startedAt + worstCasePerProxyMs > budgetMs) {
      result.stoppedAtBudget = true;
      deps.logger?.info?.(
        {
          component: 'proxy-freshness',
          event: 'proxy_freshness_tick_budget_reached',
          elapsedMs: now() - startedAt,
          budgetMs,
          worstCasePerProxyMs,
          probed: result.claimed,
        },
        'proxy freshness tick stopped at its budget — remaining proxies stay due for the next tick',
      );
      break;
    }
    if (i > 0) await sleep(PROXY_FRESHNESS_GAP_MS);
    const row = await deps.proxies.claimDueForFreshnessRefresh({
      now: new Date(now()),
      refreshIntervalMs: PROXY_FRESHNESS_REFRESH_INTERVAL_MS,
      maxBackoffSteps: PROXY_FRESHNESS_MAX_BACKOFF_STEPS,
    });
    if (row === null) break; // nothing due — the ordinary case on a quiet deployment
    result.claimed += 1;
    const outcome = await refreshOneProxy(row, { ...deps, probe }, now);
    result[outcome] += 1;
  }
  return result;
}

/**
 * Refresh one claimed proxy. Never throws: a single bad row must not end the
 * tick, because the tick is what re-arms the chain.
 */
async function refreshOneProxy(
  row: AccountProxyRow,
  deps: ProxyFreshnessTickDeps & { probe: ProxyFreshnessProbe },
  now: () => number,
): Promise<'refreshed' | 'failed' | 'skipped'> {
  // ⛔ VPN rows are EXCLUDED, and this is the second of two places that says so
  // (the claim's SQL predicate is the first). Not an oversight and not a
  // stylistic duplicate: bringing an OpenVPN/WireGuard tunnel up requires a
  // FLEET NODE — the control plane cannot dial one, which is why the /test
  // route dispatches VPN tests to a Mac. A background VPN refresh therefore
  // needs node dispatch, a free-node policy and a "do not bring up a second
  // tunnel on an account that allows one" rule (see the route's live-session
  // refusal). That is its own item. Until then a VPN row is never claimed here,
  // and if one ever reaches this function through a changed predicate it is
  // skipped rather than dialled with a CONNECT that cannot work.
  if (row.scheme !== 'socks5' && row.scheme !== 'http') {
    deps.logger?.info?.(
      {
        component: 'proxy-freshness',
        event: 'proxy_freshness_skipped_scheme',
        proxyId: row.id,
        scheme: row.scheme,
      },
      'proxy freshness: a VPN row needs a fleet node to bring its tunnel up — not refreshable here',
    );
    return 'skipped';
  }

  // The instant our dial began. Everything the customer's own Test writes after
  // this beats what we are about to measure — see `yieldToReadingsAfter`.
  const probeStartedAt = new Date(now());
  let descriptor: ProbeProxyDescriptor | null;
  try {
    descriptor = await deps.resolver.resolveProbeDescriptor({
      proxyId: row.id,
      accountId: row.accountId,
    });
  } catch (err) {
    // An unsafe host throws (UnsafeProxyHostError). Nothing was measured and the
    // proxy is not at fault, so this is a SKIP, not a failure: counting it would
    // eventually stamp `exit_superseded_at` on a row whose only problem is that
    // we refuse to dial it.
    deps.logger?.info?.(
      {
        component: 'proxy-freshness',
        event: 'proxy_freshness_unresolvable',
        proxyId: row.id,
        err: { message: err instanceof Error ? err.message : String(err) },
      },
      'proxy freshness: the row could not be resolved to a dialable descriptor — skipped, not failed',
    );
    return 'skipped';
  }
  if (descriptor === null) return 'skipped';

  const probeResult = await deps.probe.probe(descriptor);
  if (!probeResult.ok) {
    // ⛔ The whole failure path, and it writes ONE counter. No exit, no
    // fingerprint, no `updated_at`. See the header: a background miss is not a
    // verdict about the customer's proxy.
    const recorded = await deps.proxies.recordFreshnessFailure({
      id: row.id,
      accountId: row.accountId,
      at: new Date(now()),
      condemnAfterFailures: PROXY_FRESHNESS_CONDEMN_AFTER_FAILURES,
      // The condemn side of `yieldToReadingsAfter`: a customer whose own Test
      // succeeded while our dial was in flight must not have their fresh reading
      // contradicted by our older, failed one. Same instant the success path
      // yields to, passed to the same effect.
      probeStartedAt,
    });
    deps.logger?.info?.(
      {
        component: 'proxy-freshness',
        event: 'proxy_freshness_probe_failed',
        proxyId: row.id,
        reason: probeResult.reason,
        consecutiveFailures: recorded?.consecutiveFailures,
        exitSuperseded: recorded !== null && recorded.exitSupersededAt !== null,
      },
      'proxy freshness: background probe failed — attempt recorded, customer-visible state untouched',
    );
    return 'failed';
  }

  // The OS reading is best-effort and deliberately second: it costs another
  // handshake through the customer's proxy and is worth nothing if the proxy did
  // not answer the first one. A throw here is the observer tunnel failing, which
  // is not a proxy failure — the connectivity probe already passed — so it leaves
  // the fingerprint alone and the refresh still counts as a success.
  let observedOs: ObservedOsFingerprint | undefined;
  if (typeof deps.probe.observeOs === 'function') {
    try {
      const observation = await deps.probe.observeOs(descriptor, probeResult.exitIdentity?.ip);
      if (observation.observed) {
        observedOs = {
          os: observation.os,
          confidence: observation.confidence,
          // The CUSTOMER-facing sentence, not the probe's diagnostic string: the
          // /proxies list parses this jsonb through the published schema and
          // shows `reason` to a person. The technical one is in the log below.
          reason: customerOsFingerprintReason(observation.os),
          observed_ip: observation.observedIp,
          observed_via: observation.via,
          single_host_vantage: observation.singleHostVantage,
          web_port_vantage: observation.webPortVantage,
        };
        deps.logger?.info?.(
          {
            component: 'proxy-freshness',
            event: 'proxy_freshness_os_observed',
            proxyId: row.id,
            os: observation.os,
            confidence: observation.confidence,
            reason: observation.reason,
          },
          'proxy freshness: os fingerprint observed',
        );
      }
    } catch (err) {
      deps.logger?.info?.(
        {
          component: 'proxy-freshness',
          event: 'proxy_freshness_os_observation_failed',
          proxyId: row.id,
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'proxy freshness: os observation failed — the stored fingerprint is left as it was',
      );
    }
  }

  // Re-read before writing. The row in hand is up to ~18 seconds old, and in that
  // window the customer may have pressed Test (a newer reading, which must win),
  // repointed the proxy (our reading is of the old machine — rule 4 below) or
  // deleted it (nothing to write). All three decisions need the CURRENT row, and
  // `findById` is owner-scoped so a deleted row simply reads null.
  const current = await deps.proxies.findById({ id: row.id, accountId: row.accountId });
  if (current === null) return 'skipped';

  // ⛔ Rule 4 — the row must still point where we dialled. A customer PUT inside
  // our ~18-second window repoints the row AND clears its readings in one
  // statement (`proxyReadingsInvalidatedByEdit`), so a write landing after it
  // would restore a reading of the PREVIOUS machine, dated after the move, onto
  // a row the customer just fixed. `yieldToReadingsAfter` cannot catch that: the
  // invalidation NULLS the stored timestamps and a null yields to nothing.
  // Skipped, not failed — the proxy did nothing wrong, and the edit made the row
  // due again, so the next tick measures the machine it now points at.
  if (!readingWasTakenThroughCurrentIdentity(row, current)) {
    deps.logger?.info?.(
      {
        component: 'proxy-freshness',
        event: 'proxy_freshness_row_repointed',
        proxyId: row.id,
      },
      'proxy freshness: the proxy was edited while the probe was in flight — the reading describes the previous address and is discarded',
    );
    return 'skipped';
  }

  const exitUpdates = exitObservationUpdates({
    incoming:
      probeResult.exitIdentity === undefined
        ? undefined
        : {
            ip: probeResult.exitIdentity.ip,
            // The echo normalises an unknown country to 'XX'; storing that would
            // put a fake country on the row, so it is read as "no country".
            country:
              probeResult.exitIdentity.country === 'XX' ? null : probeResult.exitIdentity.country,
            timezone: probeResult.exitIdentity.timezone,
          },
    observedVia: 'probe',
    at: new Date(now()),
    row: current,
    yieldToReadingsAfter: probeStartedAt,
  });
  const osUpdates = osFingerprintUpdates({
    observed: observedOs,
    at: new Date(now()),
    row: current,
    yieldToReadingsAfter: probeStartedAt,
  });

  // One write. The counter reset rides with the readings because the proxy
  // answered — whatever streak it was on is over, even if neither vantage
  // produced a value this round.
  const updates = {
    ...(exitUpdates ?? {}),
    ...(osUpdates ?? {}),
    ...(current.freshnessConsecutiveFailures === 0 ? {} : { freshnessConsecutiveFailures: 0 }),
  };
  // ⛔ AN EMPTY UPDATE IS NOT A NO-OP — it bumps `updated_at`. Both repo
  // implementations stamp it unconditionally (`.set({ ...updates, updatedAt: new
  // Date() })`), and `updated_at` is PUBLISHED on the proxy metadata
  // (account-me.ts `updated_at: r.updatedAt.toISOString()`, read by the desktop
  // client), so a tick that measured NOTHING would report an edit that never
  // happened. That is reachable on the success path today: the probe's own
  // `{ ok: true, detail: exitIdentityMissDetail(tail) }` branch answers ok with
  // no `exitIdentity`, and with no DS_OS_OBSERVER_HOST (the default) there is no
  // OS reading either — so both helpers correctly return null and the spread is
  // `{}`. The FAILURE path has been guarded against exactly this since it was
  // written, with its own arm; this is the same rule on the other branch.
  if (Object.keys(updates).length > 0) {
    await deps.proxies.update({ id: row.id, accountId: row.accountId, updates });
  }
  return 'refreshed';
}

export interface RegisterProxyFreshnessJobOpts extends Omit<ProxyFreshnessTickDeps, 'nowFn'> {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
}

/**
 * Register the self-re-arming freshness chain.
 *
 * Failure posture is the one every sibling sweeper uses, and the comments say
 * why: a thrown tick is SWALLOWED, logged, and the successor is armed ONCE,
 * after the catch. Re-throwing would let the poller retry the job while this
 * also re-armed, fanning out duplicate parallel chains — and duplicate chains
 * here mean duplicate dials through customer proxies. Not re-arming at all
 * would kill the chain until a process restart, silently, with nothing erroring
 * at the moment it matters.
 */
export function registerProxyFreshnessJob(opts: RegisterProxyFreshnessJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(PROXY_FRESHNESS_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      const tick = await runProxyFreshnessTick(opts);
      if (tick.claimed > 0 || tick.stoppedAtBudget) {
        opts.logger?.info?.(
          {
            component: 'proxy-freshness',
            event: 'proxy_freshness_tick',
            ...tick,
          },
          'proxy freshness tick',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger?.error?.(
        {
          component: 'proxy-freshness',
          event: 'proxy_freshness_tick_failed',
          err: { message },
        },
        'proxy freshness tick failed — re-arming; due proxies are picked up by the next tick',
      );
    }
    await enqueueNextProxyFreshnessRefresh({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue the next sweep at `now + interval`. Bootstrap dedups all pending;
 * re-arms dedup only against successors after `currentRunAt`.
 */
export async function enqueueNextProxyFreshnessRefresh(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: PROXY_FRESHNESS_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + PROXY_FRESHNESS_CHAIN_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
