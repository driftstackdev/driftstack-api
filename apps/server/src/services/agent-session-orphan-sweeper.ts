// 2026-06-19 — orphaned agent-session reaper (wall-clock backstop).
//
// Agent sessions only flip to `closed` on an explicit DELETE or on budget
// exhaustion. When a worker dies mid-session, the row lingers status='active'
// forever — which is why "sessions still say open on every once-opened
// session". This sweeper is the permanent BACKSTOP: it bulk-closes any session
// that has been `active` longer than a generous wall-clock lifetime cap,
// stamping closed_reason='orphaned-lifetime' + closed_at=now.
//
// This is intentionally COARSE. No legitimate interactive/agent session runs
// for the 12h default cap, so the only rows it touches are genuinely-orphaned
// ones. The precise real-time fix (the worker reporting session-end) is a
// separate, worker-side path; this backstop guarantees a dead session closes
// within ~1h of the cap regardless.
//
// Lifetime cap: DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS (default 12),
// applied to created_at (NOT updated_at — a chatty session that keeps appending
// transcript is still capped at the absolute lifetime, which is the safe
// behaviour for a backstop).
//
// Scheduling: hourly. Mirrors the profile-trash-purge sweeper's scheduled-jobs
// shape — registerAgentSessionOrphanReapJob wires it into the poller and
// re-arms after each run (dedup OFF on the in-handler re-arm — see the
// auth-tokens-sweeper / profile-trash-purge JSDoc for the locked-in-flight-job
// reasoning). Hourly (not daily) so an orphaned row closes within ~1h of the
// cap rather than waiting up to a day.

import type { AgentSessionsRepo } from './agent-sessions.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const AGENT_SESSION_ORPHAN_REAP_JOB_TYPE = 'agent_session.orphan_reap';

const DEFAULT_MAX_LIFETIME_HOURS = 12;
/** Upper sanity bound for the operator-set lifetime cap (30 days). Anything
 *  above this is treated as a fat-finger and falls back to the default so the
 *  backstop can never be silently disabled (see resolveMaxLifetimeHours). */
const MAX_REASONABLE_LIFETIME_HOURS = 24 * 30;
const HOUR_MS = 60 * 60 * 1000;

/**
 * Read the lifetime cap (in hours) from the environment, falling back to the
 * generous 12h default. A non-finite / non-positive value falls back too, so a
 * fat-fingered env var can never disable the backstop or push the cutoff into
 * the future.
 */
export function resolveMaxLifetimeHours(
  env: Record<string, string | undefined> = process.env,
): number {
  const raw = env.DRIFTSTACK_AGENT_SESSION_MAX_LIFETIME_HOURS;
  if (raw === undefined) return DEFAULT_MAX_LIFETIME_HOURS;
  const parsed = Number(raw);
  // Reject non-finite / non-positive AND absurdly-large values. Without the
  // upper bound a fat-fingered "120000" (a plausible typo for 12) silently
  // DISABLES the backstop — the cutoff (now − maxLifetimeMs) lands ~13 years in
  // the past so no session is ever old enough to reap — the exact outcome the
  // doc above promises is impossible. 30 days is far above any legitimate cap
  // (the default is 12h) while keeping the guard's stated invariant.
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_REASONABLE_LIFETIME_HOURS) {
    return DEFAULT_MAX_LIFETIME_HOURS;
  }
  return parsed;
}

export interface AgentSessionOrphanSweeperDeps {
  readonly repo: AgentSessionsRepo;
  /** Hours a session may stay `active` before the backstop closes it. Defaults to 12. */
  readonly maxLifetimeHours?: number;
}

export interface AgentSessionOrphanReapResult {
  readonly reaped: number;
}

export class AgentSessionOrphanSweeperService {
  private readonly maxLifetimeMs: number;

  constructor(private readonly deps: AgentSessionOrphanSweeperDeps) {
    this.maxLifetimeMs = (deps.maxLifetimeHours ?? resolveMaxLifetimeHours()) * HOUR_MS;
  }

  async tickOnce(now: Date): Promise<AgentSessionOrphanReapResult> {
    const cutoff = new Date(now.getTime() - this.maxLifetimeMs);
    // Audit 2026-07-01 (MEDIUM) — like worker-disconnect-reaper.ts's bulk
    // close, this backstop does NOT evict the reaped sessions' entries from
    // session-page-state-store.ts: reapOrphanedActiveBefore only returns a row
    // COUNT, not the affected ids, and there's no cheap id here to call
    // store.delete() with (a repo signature change to return them is out of
    // scope for this fix). Safe regardless: GET /:id/page-state cross-checks
    // the session's live `status` — flipped to 'closed' by this same
    // statement — before it ever reads the page-state store, so a reaped
    // session can't serve a stale cached pageState even though this store
    // entry lingers (until its own age bound / LRU cap evicts it).
    const reaped = await this.deps.repo.reapOrphanedActiveBefore(cutoff);
    return { reaped };
  }
}

export interface RegisterAgentSessionOrphanReapJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweeper: AgentSessionOrphanSweeperService;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * Wire the reaper onto the ScheduledJobsService.
 *
 * Chain survival: the re-arm MUST run even if `tickOnce` throws. If it did not,
 * a throw would leave no re-arm, the poller would retry the job, and once
 * `maxAttempts` is exhausted the job is markFailed with NO pending reap row —
 * the self-re-arming chain is then dead until a process restart and NO orphaned
 * session is ever closed again (every worker that dies mid-session leaves a row
 * stuck `active` forever, the exact "sessions still say open" symptom this
 * backstop exists to cure). We therefore SWALLOW a tick failure (logging it) and
 * re-arm exactly once. We must NOT re-throw-and-re-arm-in-`finally`: the poller
 * would retry the same job and each attempt would re-arm → duplicate parallel
 * chains (fan-out). The tick is idempotent (a bulk close by wall-clock cutoff) —
 * the next tick re-reaps any rows this one missed.
 *
 * The re-arm enqueues with dedup OFF — the in-flight (still-locked,
 * not-yet-completed) job would otherwise be seen as a pending duplicate and
 * block the re-enqueue, killing the chain. See the profile-trash-purge JSDoc.
 */
export function registerAgentSessionOrphanReapJob(
  opts: RegisterAgentSessionOrphanReapJobOpts,
): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(AGENT_SESSION_ORPHAN_REAP_JOB_TYPE, async (_job: ScheduledJobRow) => {
    try {
      const result = await opts.sweeper.tickOnce(new Date(now()));
      opts.logger.info?.(
        { component: 'agent-session-orphan-reap', reaped: result.reaped },
        'agent-session orphan reap sweep complete',
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error?.(
        {
          component: 'agent-session-orphan-reap',
          event: 'agent_session_orphan_reap_tick_failed',
          err: { message },
        },
        'agent-session orphan reap tick failed — re-arming; rows retry next tick',
      );
    }
    // Re-arm OUTSIDE the try so it ALWAYS runs — a swallowed tick failure above
    // must never skip the re-arm (that is the chain-death this guard prevents).
    await enqueueNextAgentSessionOrphanReap({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      dedup: false,
    });
  });
}

/**
 * Enqueue the next reap at the top of the next hour strictly after `now`.
 * dedup:true for the bootstrap enqueue (one chain across restarts); dedup:false
 * for the in-handler re-arm (the current job is still locked + non-completed,
 * so dedup:true would no-op every re-arm and kill the chain).
 */
export async function enqueueNextAgentSessionOrphanReap(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  dedup?: boolean;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: AGENT_SESSION_ORPHAN_REAP_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: nextReapRunAt(new Date(now)),
    dedupOnAccountAndType: opts.dedup ?? true,
  });
}

/** Returns the top of the next hour strictly after `now`. */
export function nextReapRunAt(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCMinutes(0, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCHours(next.getUTCHours() + 1);
  }
  return next;
}
