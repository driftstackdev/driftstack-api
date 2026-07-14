// 6.g — free-tier session-duration auto-destroy sweeper.
//
// The free tier caps a single session at MAX_SESSION_MINUTES_PER_TIER.free
// (20 min) wall-clock. A free session pins an expensive fleet slot, so the
// cap is enforced by an ACTIVE background sweep that frees the slot, NOT
// lazily on next-access (a customer who never touches the session again
// would otherwise hold the slot forever). Paid tiers have a null cap and
// are NEVER auto-destroyed by this sweep.
//
// Compute-at-sweep, no migration: the cap source-of-truth is
// `maxSessionMinutesFor(tier)`. This service materialises the per-tier
// cutoff for every tier that HAS a cap, then asks the repo for active
// sessions older than their tier's cutoff. The repo only knows the
// (tier, expiredBefore) pairs — cap values never leak into the query layer.
//
// Scheduling: registers a `sessions.duration_sweep` handler on the V-202d
// ScheduledJobsService and re-arms itself after each run, same shape as the
// auth-tokens sweeper. Cadence is short (every 2 min) because a 20-min cap
// needs reasonably prompt enforcement — a session is destroyed within ~2
// min of crossing 20 min. The re-arm ignores the current/older run-time
// cohort while deduplicating future successors; bootstrap dedups all pending.
// See `enqueueNextSessionDurationSweep` JSDoc for the full reasoning.

import { type AccountTier, AccountTierSchema } from '@driftstack/api-types';
import { maxSessionMinutesFor, type SessionRepo, type SessionsService } from './sessions.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const SESSION_DURATION_SWEEP_JOB_TYPE = 'sessions.duration_sweep';

/** Re-arm cadence: 2 minutes. See header for the prompt-enforcement rationale. */
export const SESSION_DURATION_SWEEP_INTERVAL_MS = 2 * 60 * 1000;

const MINUTE_MS = 60 * 1000;

/** Per-tick destroy cap so a backlog drains over several ticks, not one. */
const DEFAULT_BATCH_LIMIT = 100;

export interface SessionDurationSweeperDeps {
  readonly repo: SessionRepo;
  readonly sessions: SessionsService;
  readonly logger: Logger;
  /** Override the per-tick destroy cap (defaults to 100). */
  readonly batchLimit?: number;
}

export interface DurationSweepTickResult {
  /** Number of sessions auto-destroyed this tick. */
  readonly destroyed: number;
  /** Number of candidate rows the repo returned this tick. */
  readonly candidates: number;
}

/**
 * Build the set of `(tier, expiredBefore)` cutoffs for every tier that has
 * a non-null cap per `maxSessionMinutesFor`. A row created strictly before
 * its tier's `expiredBefore` has exceeded the cap. Today only `free` has a
 * cap; iterating the full enum means a future capped paid tier is picked up
 * automatically with no sweep change.
 */
export function durationCutoffsFor(now: Date): Array<{ tier: AccountTier; expiredBefore: Date }> {
  const cutoffs: Array<{ tier: AccountTier; expiredBefore: Date }> = [];
  for (const tier of AccountTierSchema.options) {
    const maxMinutes = maxSessionMinutesFor(tier);
    if (maxMinutes === null) continue; // unlimited — never auto-destroyed
    cutoffs.push({ tier, expiredBefore: new Date(now.getTime() - maxMinutes * MINUTE_MS) });
  }
  return cutoffs;
}

export class SessionDurationSweeperService {
  private readonly batchLimit: number;

  constructor(private readonly deps: SessionDurationSweeperDeps) {
    this.batchLimit = deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
  }

  /**
   * One sweep tick: find active sessions past their tier's duration cap and
   * auto-destroy each. Per-session destroy failures are caught + logged so a
   * single stuck driver call doesn't abort the whole batch (the row stays
   * eligible and is retried next tick).
   */
  async tickOnce(now: Date): Promise<DurationSweepTickResult> {
    const tierCutoffs = durationCutoffsFor(now);
    // No capped tiers → nothing to do (defensive; today `free` always caps).
    if (tierCutoffs.length === 0) return { destroyed: 0, candidates: 0 };

    const candidates = await this.deps.repo.listExpiredForAutoDestroy({
      tierCutoffs,
      limit: this.batchLimit,
    });
    if (candidates.length === 0) return { destroyed: 0, candidates: 0 };

    // Resolve each candidate's cap for the destroy-event payload. The repo
    // already guaranteed the tier is capped (it matched a cutoff), but we
    // re-read maxSessionMinutesFor so the recorded `max_session_minutes`
    // value comes from the single source of truth, not the cutoff math.
    const cutoffTiers = new Set(tierCutoffs.map((c) => c.tier));

    let destroyed = 0;
    for (const session of candidates) {
      // Resolve the cap for this session's tier. The candidate came back
      // because its account tier matched a capped cutoff; we don't have the
      // tier on the SessionRecord, so resolve via the matched-tier set:
      // every cutoff tier is capped, so the minimum applicable cap is a safe
      // payload value. In practice only `free` is capped today.
      const maxMinutes = minCapFor(cutoffTiers);
      try {
        const result = await this.deps.sessions.autoDestroyExpired(session, { maxMinutes });
        if (result.destroyed) destroyed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.deps.logger.warn?.(
          {
            component: 'session-duration-sweep',
            session_id: `ses_${session.id}`,
            account_id: session.accountId,
            err: { message },
          },
          'auto-destroy failed for expired session — will retry next tick',
        );
      }
    }

    this.deps.logger.info?.(
      {
        component: 'session-duration-sweep',
        candidates: candidates.length,
        destroyed,
      },
      'session-duration sweep complete',
    );
    return { destroyed, candidates: candidates.length };
  }
}

/**
 * The smallest non-null cap among the supplied tiers. Used for the
 * destroy-event payload when the candidate's exact tier isn't carried on
 * the SessionRecord. Today the only capped tier is `free` (20), so this is
 * always 20; kept general so a future second capped tier degrades safely.
 */
function minCapFor(tiers: ReadonlySet<AccountTier>): number {
  let min = Number.POSITIVE_INFINITY;
  for (const tier of tiers) {
    const cap = maxSessionMinutesFor(tier);
    if (cap !== null && cap < min) min = cap;
  }
  return Number.isFinite(min) ? min : 0;
}

export interface RegisterSessionDurationSweepJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweeper: SessionDurationSweeperService;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * Wire the duration sweeper onto the ScheduledJobsService. The handler runs
 * one tick then re-arms the next run at `now + SESSION_DURATION_SWEEP_
 * INTERVAL_MS`.
 *
 * Re-arms use future-successor dedup: current/older run-time peers are ignored,
 * while an already-pending successor strictly after this run suppresses the
 * enqueue. This survives handler replay without creating parallel chains.
 *
 * Chain survival: the re-arm must run even if `tickOnce` throws. If it did
 * not, a throw would leave no re-arm, the poller would retry the job, and once
 * `maxAttempts` is exhausted the job is markFailed with NO pending sweep row —
 * the self-re-arming chain is then dead until a process restart and NO free
 * session over its cap is ever auto-destroyed again (every lapsed free session
 * pins its fleet slot forever). We therefore SWALLOW a tick failure (logging
 * it) and re-arm exactly once. We must NOT re-throw-and-re-arm-in-`finally`:
 * the poller would retry the same job and each attempt would re-arm →
 * duplicate parallel chains (fan-out). The tick is idempotent — the next tick
 * re-lists any rows this one missed.
 */
export function registerSessionDurationSweepJob(opts: RegisterSessionDurationSweepJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(SESSION_DURATION_SWEEP_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      await opts.sweeper.tickOnce(new Date(now()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error?.(
        {
          component: 'session-duration-sweep',
          event: 'session_duration_sweep_tick_failed',
          err: { message },
        },
        'session-duration sweep tick failed — re-arming; rows retry next tick',
      );
    }
    // This runs outside the try so a thrown tick still re-arms exactly once.
    // Future-successor dedup ignores this current/older run-time cohort.
    await enqueueNextSessionDurationSweep({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue the next duration sweep at `now + SESSION_DURATION_SWEEP_INTERVAL_
 * MS`.
 *
 * Bootstrap omits `currentRunAt` and dedups against all pending rows. Re-arms
 * pass the current row's `runAt` and dedup only against future successors.
 */
export async function enqueueNextSessionDurationSweep(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  /** Current run-time cohort ignored for a crash-safe in-handler re-arm. */
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: SESSION_DURATION_SWEEP_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + SESSION_DURATION_SWEEP_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
