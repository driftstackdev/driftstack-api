// V-784 — the five daily sweeps that had no durable schedule.
//
// Eleven recurring sweeps in this server run as self-re-arming `scheduled_jobs`
// rows: the next run is a database row, so it survives a restart, only one
// instance claims it, and `driftstack_scheduled_job_chain_pending{job_type}`
// reports 0 the moment a chain dies. Five did not. They ran on a bare
// `setInterval(fn, 24h)` created during bootstrap, and that has three
// consequences the interval cannot express.
//
// The first is that `setInterval` fires its FIRST tick a full period after it is
// created. A process that restarts more often than once a day never reaches the
// first tick, so those sweeps do not run late — they do not run at all, for as
// long as the deploy cadence stays under 24 hours. Nothing about that state is
// distinguishable from a quiet day.
//
// The second is that the schedule lived only in process memory, so every
// restart threw away whatever progress the timer had made toward the next tick
// and started the 24 hours again.
//
// The third is the one that made the first two invisible. `job-chain-liveness`
// exists precisely so a dead recurring sweep reports 0 instead of reporting
// nothing — its own header says a gauge built from "what the table contains"
// would emit no series for the job type in trouble, and a missing series reads
// as healthy on every dashboard. But its roster is derived from the
// `*_JOB_TYPE` constants the sweepers export, so a sweep that never became a job
// was never on the roster. It was not a dead chain; it was not a chain. The
// watchdog covered exactly the sweeps that had already opted into durability.
//
// Moving these five onto `scheduled_jobs` fixes all three at once, and the third
// automatically: the derived roster check in `job-chain-liveness.test.ts` fails
// until each new `*_JOB_TYPE` below is added to `EXPECTED_RECURRING_JOB_TYPES`.
//
// Shape follows `scheduled-jobs-prune-sweeper.ts` exactly, including the two
// rules that keep a chain alive:
//
//   - the re-arm must happen even when the sweep throws, or an exhausted
//     `maxAttempts` leaves no pending row and the chain is dead until a restart;
//   - the re-arm must NOT be a re-throw-and-re-arm-in-`finally`, or the poller
//     retries the same job and every attempt re-arms, fanning out duplicate
//     parallel chains.
//
// So a failed sweep is swallowed after being logged at error level, and the
// re-arm runs exactly once. Every sweep here is a bounded cutoff scan, so the
// next run redoes anything a failed one missed and nothing is stranded.

import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

/** Privacy §3.10 — 90d post-unsubscribe zero-out of status-subscriber emails. */
export const STATUS_SUBSCRIBER_PURGE_JOB_TYPE = 'status_subscriber.purge';
/** v2-#10/#10.5/#10.6 — webhook signing-secret rotation nag. */
export const WEBHOOK_ROTATION_REMINDER_JOB_TYPE = 'webhook.rotation_reminder';
/** v2-#11/#11.5/#11.6 — BYOK Anthropic API-key rotation nag. */
export const BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE = 'byok_anthropic.rotation_reminder';
/** v2-#28 — 24h-before-grace-expiry last-chance notice for a force-rotation window. */
export const WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE = 'webhook.grace_expiring_notice';
/** v2-#29 — nulls stale `secret_prev` columns past the grace window. */
export const WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE = 'webhook.secret_prev_cleanup';

/** Daily cadence, unchanged from the intervals these replaced. */
export const DAILY_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/**
 * The four chains suppressed by `DRIFTSTACK_DISABLE_KEY_ROTATION_REMINDERS=1`.
 *
 * A deployment with that flag set neither registers nor enqueues them, so the
 * liveness gauge must be told to OMIT them rather than report 0 — 0 means "this
 * chain died" and would page for a sweep that was switched off on purpose.
 */
export const ROTATION_REMINDER_JOB_TYPES: readonly string[] = [
  WEBHOOK_ROTATION_REMINDER_JOB_TYPE,
  BYOK_ANTHROPIC_ROTATION_REMINDER_JOB_TYPE,
  WEBHOOK_GRACE_EXPIRING_NOTICE_JOB_TYPE,
  WEBHOOK_SECRET_PREV_CLEANUP_JOB_TYPE,
];

/** One daily sweep: a job type, a log component, and the work for one tick. */
export interface DailyMaintenanceSweep {
  readonly jobType: string;
  readonly component: string;
  run(now: Date): Promise<void>;
}

export interface RegisterDailyMaintenanceJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweep: DailyMaintenanceSweep;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * Wire one daily sweep onto the ScheduledJobsService. The handler runs the sweep
 * once then re-arms at `now + DAILY_MAINTENANCE_INTERVAL_MS`.
 *
 * A sweep failure is logged and swallowed; see this file's header for why the
 * re-arm cannot be conditional on success and cannot live in a `finally` that
 * re-throws.
 */
export function registerDailyMaintenanceJob(opts: RegisterDailyMaintenanceJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(opts.sweep.jobType, async (job: ScheduledJobRow) => {
    try {
      await opts.sweep.run(new Date(now()));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error?.(
        {
          component: opts.sweep.component,
          event: 'daily_maintenance_sweep_failed',
          jobType: opts.sweep.jobType,
          err: { message },
        },
        'daily maintenance sweep failed — re-arming; the next run redoes anything this one missed',
      );
    }
    await enqueueNextDailyMaintenance({
      scheduledJobs: opts.scheduledJobs,
      jobType: opts.sweep.jobType,
      nowFn: now,
      currentRunAt: job.runAt,
    });
  });
}

/**
 * Enqueue the next run of `jobType` at `now + DAILY_MAINTENANCE_INTERVAL_MS`.
 *
 * Bootstrap omits `currentRunAt` and dedups against ALL pending rows, which is
 * what makes a restart harmless: a pending row from a previous boot keeps its
 * original `runAt` instead of being pushed another 24 hours out. Re-arms pass
 * the current row's `runAt` and dedup only against a later pending successor.
 */
export async function enqueueNextDailyMaintenance(opts: {
  scheduledJobs: ScheduledJobsService;
  jobType: string;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<void> {
  const now = (opts.nowFn ?? Date.now)();
  await opts.scheduledJobs.enqueue({
    jobType: opts.jobType,
    accountId: null,
    payload: {},
    runAt: new Date(now + DAILY_MAINTENANCE_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}

/** Register and arm one sweep. Convenience for the bootstrap call sites. */
export async function wireDailyMaintenanceSweep(
  opts: RegisterDailyMaintenanceJobOpts,
): Promise<void> {
  registerDailyMaintenanceJob(opts);
  await enqueueNextDailyMaintenance({
    scheduledJobs: opts.scheduledJobs,
    jobType: opts.sweep.jobType,
    ...(opts.nowFn === undefined ? {} : { nowFn: opts.nowFn }),
  });
}
