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
// nightly', account_id null).

import type { CostAlertDispatcher } from './cost-alert-dispatcher.js';
import { billingCycleFromDate, type CostMonitoringService } from './cost-monitoring.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const COST_NIGHTLY_JOB_TYPE = 'cost.recompute_nightly';

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
 */
export function registerCostNightlyJob(opts: RegisterCostNightlyJobOpts): void {
  const now = opts.nowFn ?? Date.now;

  opts.scheduledJobs.register(COST_NIGHTLY_JOB_TYPE, async (_job: ScheduledJobRow) => {
    const tickStart = new Date(now());
    const ids = await opts.accounts.listAllAccountIds();
    if (ids.length === 0) {
      opts.logger.debug?.({ component: 'cost-nightly' }, 'no accounts to evaluate');
      // Even with zero accounts, re-enqueue tomorrow.
      await enqueueNextNightlyRun({ scheduledJobs: opts.scheduledJobs, nowFn: now });
      return;
    }
    const result = await opts.dispatcher.evaluate({
      accountIds: ids,
      billingCycle: billingCycleFromDate(tickStart),
    });
    opts.logger.info?.(
      {
        component: 'cost-nightly',
        accounts: ids.length,
        alerts_fired: result.alertsFired,
        alerts_skipped: result.alertsSkipped,
      },
      'cost nightly recompute complete',
    );
    // Re-arm the next run.
    await enqueueNextNightlyRun({ scheduledJobs: opts.scheduledJobs, nowFn: now });
  });
}

/**
 * Enqueue the next nightly run. Idempotent via the scheduled_jobs
 * dedup flag: if there's already a pending row for this job_type
 * with account_id IS NULL, the enqueue is a no-op.
 */
export async function enqueueNextNightlyRun(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: COST_NIGHTLY_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: nextMidnightUtc(new Date(now)),
    dedupOnAccountAndType: true,
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
