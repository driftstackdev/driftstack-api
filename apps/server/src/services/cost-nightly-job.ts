// V-541.E — nightly cost-recompute scheduled-job wiring.
//
// Registers a `cost.recompute_nightly` handler against the existing
// V-202d ScheduledJobsService. Pulls the account list to evaluate
// from a pluggable provider (production wires it to the accounts
// table; tests pass a stub). Each tick evaluates the cost service +
// dispatches threshold-state-change alerts via the V-541.C
// CostAlertDispatcher.
//
// Cadence: bootstrap calls `enqueueNextNightlyRun()` on app start
// and after each successful run. Re-enqueue is idempotent via the
// V-202d dedup-on-account-and-type flag (job_type 'cost.recompute_
// nightly', account_id null). Re-arms ignore current/older run-time peers
// and collapse future successors; bootstrap dedups all pending rows.

import type { CostAlertDispatcher } from './cost-alert-dispatcher.js';
import { billingCycleFromDate, type CostMonitoringService } from './cost-monitoring.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const COST_NIGHTLY_JOB_TYPE = 'cost.recompute_nightly';

/**
 * C12 — the billing cycle a nightly tick should evaluate. The nightly run
 * fires just after midnight to recompute the day that just ended, so it must
 * evaluate the cycle of the PREVIOUS instant, not of `tick` itself: on the
 * 1st of a month `billingCycleFromDate(tick)` returns the just-started (empty)
 * cycle and the previous month's LAST day is never evaluated — a threshold
 * crossing on month-end could never alert.
 *
 * Anchor = the last instant of the previous UTC day (day-floor minus 1 ms).
 * Mid-month this is the same YYYY-MM as the tick (behaviour unchanged); on the
 * 1st it resolves to the previous month, so that run evaluates the full prior
 * cycle including its final day. We deliberately do NOT use the tick itself
 * (misses the last day) nor `job.runAt` (retries reschedule run_at to
 * now+backoff, so it isn't reliably midnight).
 */
export function cycleAnchorForTick(tick: Date): Date {
  const dayStartMs = Date.UTC(tick.getUTCFullYear(), tick.getUTCMonth(), tick.getUTCDate());
  return new Date(dayStartMs - 1);
}

export interface AccountIdProvider {
  /** Return the full set of account ids to evaluate in this tick. */
  listAllAccountIds(): Promise<readonly string[]>;
}

export interface RegisterCostNightlyJobOpts {
  scheduledJobs: ScheduledJobsService;
  service: CostMonitoringService;
  dispatcher: CostAlertDispatcher;
  accounts: AccountIdProvider;
  logger: Logger;
  /** Test seam — defaults to `Date.now`. */
  nowFn?: () => number;
}

/**
 * Wire the nightly-recompute handler onto the ScheduledJobsService.
 * Idempotent: re-registering replaces the previous handler.
 *
 * Chain survival: the re-arm must run even if the tick's work
 * (`listAllAccountIds` / `dispatcher.evaluate`) throws. If it did not, a throw
 * would leave no re-arm, the poller would retry the job, and once `maxAttempts`
 * is exhausted the job is markFailed with NO pending nightly row — the
 * self-re-arming chain is then dead until a process restart and cost alerting
 * silently stops forever (no threshold crossing ever alerts again). We
 * therefore SWALLOW a tick failure (logging it) and re-arm exactly once. We
 * must NOT re-throw-and-re-arm-in-`finally`: the poller would retry the same
 * job and each attempt would re-arm → duplicate parallel chains (fan-out). The
 * tick is idempotent (a pure recompute of current DB state), so the next tick
 * re-evaluates whatever this one missed.
 */
export function registerCostNightlyJob(opts: RegisterCostNightlyJobOpts): void {
  const now = opts.nowFn ?? Date.now;

  opts.scheduledJobs.register(COST_NIGHTLY_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      const tickStart = new Date(now());
      const ids = await opts.accounts.listAllAccountIds();
      if (ids.length === 0) {
        opts.logger.debug?.({ component: 'cost-nightly' }, 'no accounts to evaluate');
        // Even with zero accounts, re-enqueue tomorrow using future-successor dedup.
        await enqueueNextNightlyRun({
          scheduledJobs: opts.scheduledJobs,
          nowFn: now,
          currentRunAt: job.runAt,
        });
        return;
      }
      const result = await opts.dispatcher.evaluate({
        accountIds: ids,
        // C12 — evaluate the cycle of the day that just ended, so a month-end
        // threshold crossing is caught (see cycleAnchorForTick).
        billingCycle: billingCycleFromDate(cycleAnchorForTick(tickStart)),
      });
      opts.logger.info?.(
        {
          component: 'cost-nightly',
          accounts: ids.length,
          alerts_fired: result.alertsFired,
          alerts_skipped: result.alertsSkipped,
          // W378 — alert sends now fail per-account-isolated (evaluate no longer
          // throws on a send error), so a channel outage surfaces here instead of
          // killing the re-arm chain below. Non-zero → an alert sink is degraded.
          alerts_errored: result.alertsErrored,
          ...(result.alertsErrored > 0 ? { alert_errors: result.errors } : {}),
        },
        'cost nightly recompute complete',
      );
      // Re-arm the next run using future-successor dedup.
      await enqueueNextNightlyRun({
        scheduledJobs: opts.scheduledJobs,
        nowFn: now,
        currentRunAt: job.runAt,
      });
    } catch (err) {
      // Chain survival: SWALLOW a tick failure (do NOT re-throw) and re-arm
      // exactly once here. If the work above throws (listAllAccountIds /
      // dispatcher.evaluate) the in-branch re-arm never ran; without this catch
      // the throw would propagate, the poller would retry to maxAttempts, then
      // markFailed leaves NO pending nightly row → the self-re-arming chain is
      // dead until a process restart and cost alerting silently stops forever.
      // We must NOT re-throw-and-re-arm-in-`finally` (fan-out: every poller
      // retry would re-arm → duplicate parallel chains). The tick is idempotent
      // (a pure recompute of current DB state), so the next tick re-evaluates
      // whatever this one missed.
      const message = err instanceof Error ? err.message : String(err);
      opts.logger.error?.(
        {
          component: 'cost-nightly',
          event: 'cost_nightly_tick_failed',
          err: { message },
        },
        'cost nightly recompute tick failed — re-arming; the next tick re-evaluates',
      );
      await enqueueNextNightlyRun({
        scheduledJobs: opts.scheduledJobs,
        nowFn: now,
        currentRunAt: job.runAt,
      });
    }
  });
}

/**
 * Enqueue the next nightly run. Idempotent via the scheduled_jobs
 * dedup flag: if there's already a pending row for this job_type
 * with account_id IS NULL, the enqueue is a no-op.
 *
 * Bootstrap omits `currentRunAt` and dedups all pending rows. Re-arms pass
 * the current row's run time and dedup only later pending successors.
 */
export async function enqueueNextNightlyRun(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  /** Current run-time cohort ignored for a crash-safe in-handler re-arm. */
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: COST_NIGHTLY_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: nextMidnightUtc(new Date(now)),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}

/**
 * Returns the next UTC midnight strictly after `now`. Used so the
 * nightly run lands at a predictable wall-clock time for ops.
 */
export function nextMidnightUtc(now: Date): Date {
  const next = new Date(now.getTime());
  next.setUTCHours(0, 0, 0, 0);
  next.setUTCDate(next.getUTCDate() + 1);
  return next;
}
