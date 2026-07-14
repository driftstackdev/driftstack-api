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
 * Re-arms ignore current/older run-time peers but dedup against future
 * successors, keeping the chain alive and collapsing handler replay.
 *
 * Chain survival: the re-arm must run even if the prune throws. If it did not,
 * a throw would leave no re-arm, the poller would retry the job, and once
 * `maxAttempts` is exhausted the job is markFailed with NO pending prune row —
 * the self-re-arming chain is then dead until a process restart and
 * scheduled_jobs storage grows unbounded forever. We therefore SWALLOW a prune
 * failure (logging it) and re-arm exactly once. We must NOT re-throw-and-re-arm-
 * in-`finally`: the poller would retry the same job and each attempt would
 * re-arm → duplicate parallel chains (fan-out). The prune is idempotent — the
 * next run re-deletes any rows this one missed (pruneFinished is a bounded
 * delete-by-cutoff, so nothing is stranded).
 */
export function registerScheduledJobsPruneJob(opts: RegisterScheduledJobsPruneJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(SCHEDULED_JOBS_PRUNE_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      const cutoff = new Date(now() - SCHEDULED_JOBS_PRUNE_RETENTION_MS);
      const deleted = await opts.repo.pruneFinished(cutoff);
      if (deleted > 0) {
        opts.logger.info(
          { component: 'scheduled-jobs-prune', deleted, cutoff: cutoff.toISOString() },
          'pruned finished scheduled_jobs',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error?.(
        {
          component: 'scheduled-jobs-prune',
          event: 'scheduled_jobs_prune_failed',
          err: { message },
        },
        'scheduled_jobs prune failed — re-arming; rows retry next run',
      );
    }
    await enqueueNextScheduledJobsPrune({
      scheduledJobs: opts.scheduledJobs,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue the next prune at `now + SCHEDULED_JOBS_PRUNE_INTERVAL_MS`.
 *
 * Bootstrap omits `currentRunAt` and dedups all pending rows. Re-arms pass the
 * current row's `runAt` and dedup only against a later pending successor.
 */
export async function enqueueNextScheduledJobsPrune(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<void> {
  const now = (opts.nowFn ?? Date.now)();
  await opts.scheduledJobs.enqueue({
    jobType: SCHEDULED_JOBS_PRUNE_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + SCHEDULED_JOBS_PRUNE_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
