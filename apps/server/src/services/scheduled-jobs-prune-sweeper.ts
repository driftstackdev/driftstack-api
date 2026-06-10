// W441 — scheduled_jobs retention prune sweeper.
//
// scheduled_jobs accumulates finished rows: the worker sets completed_at /
// failed_at but never deletes them (the W416 partial claim-index keeps the
// claim fast regardless, but storage grows unbounded). This recurring job —
// wired the same way as the session-duration / auth-token sweepers (a self-
// re-arming scheduled_jobs row, restart-safe) — hard-deletes finished rows
// older than the retention window once a day.
//
// PRUNE (not archive) per the founder-delegated retention decision: finished
// scheduled_jobs rows are internal job bookkeeping with no forensic/customer
// value, unlike session_events which archives to R2 (W438).

import type { ScheduledJobsRepo, ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const SCHEDULED_JOBS_PRUNE_JOB_TYPE = 'scheduled_jobs.prune';

/** Re-arm cadence — daily. Finished-row accumulation is slow; daily is ample. */
export const SCHEDULED_JOBS_PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Retention window — finished rows with a terminal timestamp older than this
 *  are deleted. 30 days keeps a generous debugging window for recent failures. */
export const SCHEDULED_JOBS_PRUNE_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export interface RegisterScheduledJobsPruneJobOpts {
  scheduledJobs: ScheduledJobsService;
  repo: ScheduledJobsRepo;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * Wire the prune sweeper onto the ScheduledJobsService. The handler prunes
 * once then re-arms the next run at `now + SCHEDULED_JOBS_PRUNE_INTERVAL_MS`.
 *
 * The re-arm MUST enqueue with `dedup: false` — same reasoning as the session-
 * duration sweeper: the currently-executing job is still locked + not-yet-
 * completed when the handler runs, so a `dedup: true` re-arm would treat it as
 * a pending duplicate, no-op, and the chain would die after one run. A single
 * locked executor processes this job, so one handler run → one next enqueue
 * (no fan-out).
 */
export function registerScheduledJobsPruneJob(opts: RegisterScheduledJobsPruneJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(SCHEDULED_JOBS_PRUNE_JOB_TYPE, async (_job: ScheduledJobRow) => {
    const cutoff = new Date(now() - SCHEDULED_JOBS_PRUNE_RETENTION_MS);
    const deleted = await opts.repo.pruneFinished(cutoff);
    if (deleted > 0) {
      opts.logger.info(
        { component: 'scheduled-jobs-prune', deleted, cutoff: cutoff.toISOString() },
        'pruned finished scheduled_jobs',
      );
    }
    await enqueueNextScheduledJobsPrune({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      dedup: false,
    });
  });
}

/**
 * Enqueue the next prune at `now + SCHEDULED_JOBS_PRUNE_INTERVAL_MS`.
 *
 * `dedup` (default `true`) maps to the repo's `dedupOnAccountAndType`:
 *   - BOOTSTRAP on app start → dedup:true (default). Prevents a restart from
 *     leaving two parallel prune chains.
 *   - RE-ARM from inside the handler → dedup:false (the in-flight job is still
 *     locked + non-completed, so it looks like a pending duplicate; dedup:true
 *     would no-op every re-arm and kill the chain).
 */
export async function enqueueNextScheduledJobsPrune(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  dedup?: boolean;
}): Promise<void> {
  const now = (opts.nowFn ?? Date.now)();
  await opts.scheduledJobs.enqueue({
    jobType: SCHEDULED_JOBS_PRUNE_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + SCHEDULED_JOBS_PRUNE_INTERVAL_MS),
    dedupOnAccountAndType: opts.dedup ?? true,
  });
}
