// V-666.K follow-up — SCHEDULE the abandoned-pending-order sweep.
//
// `CryptoOrdersService.sweepExpiredOrders` has existed and worked for a long
// time, but its only caller was the manual admin route
// (`POST /v1/admin/crypto-orders/sweep`). Nothing ran it on a timer, so an
// order abandoned before payment sat `pending` on the customer's billing page
// FOREVER — visible under "recent orders", with no payment behind it and no
// path to a terminal state unless a staff member happened to trigger a sweep.
//
// That is how a customer ends up reading a stale pending charge they never
// made: prod carried exactly one such row (`ord_88ce0824e00c`, no payment_id,
// no pay_amount — the checkout was opened and never paid) and it would have
// stayed pending indefinitely.
//
// 24h matches the window the admin route already defaults to, and the
// `over_24h` bucket that `getPendingAgeHistogram` documents as "the candidates
// for sweepExpiredOrders". Using anything shorter here would start expiring
// orders operators currently expect to still be live.
//
// Scheduling mirrors crypto-entitlement-expiry-sweeper EXACTLY, including its
// failure posture: a thrown tick is SWALLOWED and logged, then re-armed once.
// Re-throwing would let the poller retry the job while the `finally` also
// re-armed, fanning out duplicate parallel chains; not re-arming at all would
// kill the chain until a process restart, which is the failure this whole
// module exists to prevent. The tick is idempotent — `sweepExpiredOrders`
// re-lists candidates every run, so rows missed by a failed tick are picked up
// by the next one.

import type { CryptoOrdersService } from './crypto-orders.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const CRYPTO_ORDER_EXPIRY_SWEEP_JOB_TYPE = 'crypto.order_expiry_sweep';

/** Re-arm cadence: 15 min. Matches the sibling crypto sweeper. */
export const CRYPTO_ORDER_EXPIRY_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/**
 * Age at which an unpaid pending order is considered abandoned. 24h — the
 * admin route's own default, and the `over_24h` histogram bucket.
 */
export const CRYPTO_ORDER_EXPIRY_OLDER_THAN_MS = 24 * 60 * 60 * 1000;

/** Per-tick cap so a backlog drains over several ticks rather than one. */
export const CRYPTO_ORDER_EXPIRY_BATCH_LIMIT = 500;

export interface RegisterCryptoOrderExpirySweepJobOpts {
  scheduledJobs: ScheduledJobsService;
  service: Pick<CryptoOrdersService, 'sweepExpiredOrders'>;
  logger?: Logger;
  nowFn?: () => number;
}

export function registerCryptoOrderExpirySweepJob(
  opts: RegisterCryptoOrderExpirySweepJobOpts,
): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(CRYPTO_ORDER_EXPIRY_SWEEP_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      const result = await opts.service.sweepExpiredOrders({
        olderThanMs: CRYPTO_ORDER_EXPIRY_OLDER_THAN_MS,
        limit: CRYPTO_ORDER_EXPIRY_BATCH_LIMIT,
      });
      // `capped` means the batch limit was hit and a backlog remains. Logged
      // rather than looped: the next tick continues, and a silent cap would
      // read as "nothing left to sweep".
      if (result.expired > 0 || result.capped) {
        opts.logger?.info?.(
          {
            component: 'crypto-order-sweeper',
            event: 'crypto_order_expiry_sweep_tick',
            expired: result.expired,
            capped: result.capped,
          },
          'crypto order expiry sweep tick',
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      opts.logger?.error?.(
        {
          component: 'crypto-order-sweeper',
          event: 'crypto_order_expiry_sweep_tick_failed',
          err: { message },
        },
        'crypto order expiry sweep tick failed — re-arming; rows retry next tick',
      );
    }
    await enqueueNextCryptoOrderExpirySweep({
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
export async function enqueueNextCryptoOrderExpirySweep(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: CRYPTO_ORDER_EXPIRY_SWEEP_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + CRYPTO_ORDER_EXPIRY_SWEEP_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
