// V-779 — recover paid crypto orders whose entitlement never landed.
//
// The IPN handler is a DUAL WRITE across two transactions. `withOrderLock` commits
// `status='paid'` and returns; the tier activator is called afterwards, in its own transaction.
// A process death in that window — OOM, SIGKILL, host loss, or a SIGTERM drain that outlives the
// shutdown deadline — leaves a paying customer with no entitlement and no tier.
//
// It does not self-heal, and that is by design rather than oversight. `firePaid` is computed
// from the LOCKED pre-update status, so a re-delivered IPN finds `status='paid'`, sets
// `firePaid = false`, and skips activation, the `crypto.order.paid` webhook and the receipt
// email. The handler says so itself: "a NowPayments retry would find the order already paid and
// cannot re-drive activation — ops must remediate from the alarm."
//
// The flaw is in that mitigation, not the design: the alarm is raised by a catch around the
// activator call, so a failure THROWN by the activator alarms, and an abrupt death between the
// commit and the call raises nothing. Silent, permanent, and on a customer who has paid.
//
// The population is not hypothetical. `migrations/0100_crypto_entitlements.sql` backfilled
// exactly this predicate once. Nothing made it recurring — this is that.
//
// Safe to run repeatedly: `activateCryptoEntitlement` takes the account row FOR UPDATE and the
// entitlement insert is `onConflictDoNothing({ target: cryptoEntitlements.orderId })`, so a
// second pass over an order that has since been activated is a no-op.

import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { CryptoOrderTierActivator } from './crypto-orders.js';

export const CRYPTO_ENTITLEMENT_RECONCILE_JOB_TYPE = 'crypto.entitlement_reconcile';

/** Hourly. The window this closes is a crash, so hours of exposure is the thing to bound. */
export const CRYPTO_ENTITLEMENT_RECONCILE_INTERVAL_MS = 60 * 60 * 1000;

/** Bounded per tick so a long-neglected backlog cannot hold the poller. */
const DEFAULT_BATCH_LIMIT = 100;

export interface CryptoEntitlementReconcileRepo {
  listPaidOrdersMissingEntitlement(limit: number): Promise<
    Array<{
      orderId: string;
      accountId: string;
      product: string;
      paymentId: string | null;
      paidAt: Date;
    }>
  >;
}

export interface CryptoEntitlementReconcileDeps {
  readonly repo: CryptoEntitlementReconcileRepo;
  readonly activator: CryptoOrderTierActivator;
  readonly logger?: {
    info?: (obj: Record<string, unknown>, msg: string) => void;
    error?: (obj: Record<string, unknown>, msg: string) => void;
  };
  readonly batchLimit?: number;
}

export interface CryptoEntitlementReconcileResult {
  readonly found: number;
  readonly recovered: number;
  readonly failed: number;
  /**
   * True when the batch limit was hit, so more MAY remain for the next tick.
   *
   * V-1799 — this used to assert that more DO remain. It cannot know: the repo
   * query fetches at most `limit` with no lookahead, so a batch holding exactly
   * `limit` orders and no others is indistinguishable from a truncated one.
   * `sweepExpired` states the same flag honestly ("more may remain") and this
   * now matches it. Nothing reads this field today — the job discards the
   * result — which is precisely why the wording is worth correcting before
   * something starts to.
   */
  readonly capped: boolean;
}

export class CryptoEntitlementReconcileSweeper {
  constructor(private readonly deps: CryptoEntitlementReconcileDeps) {}

  async tickOnce(): Promise<CryptoEntitlementReconcileResult> {
    const limit = this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
    const orders = await this.deps.repo.listPaidOrdersMissingEntitlement(limit);

    let recovered = 0;
    let failed = 0;
    for (const order of orders) {
      // Per-order isolation, mirroring the expiry sweeper: one bad order must not strand the
      // rest of a batch, and every statement here is idempotent so a failure simply retries.
      try {
        await this.deps.activator.activateTierForPaidOrder({
          account_id: order.accountId,
          order_id: order.orderId,
          product: order.product,
          payment_id: order.paymentId,
          paid_at: order.paidAt.toISOString(),
        });
        recovered += 1;
      } catch (err) {
        failed += 1;
        this.deps.logger?.error?.(
          {
            component: 'crypto-entitlement-reconcile',
            event: 'crypto_entitlement_reconcile_failed',
            order_id: order.orderId,
            account_id: order.accountId,
            err: { message: err instanceof Error ? err.message : String(err) },
          },
          'paid crypto order could not be reconciled into an entitlement — the customer has paid and has no tier; retries next tick',
        );
      }
    }

    // Finding ANY order here means the dual write was interrupted, which is worth a line even
    // when the recovery succeeds — it is the only signal that the window was hit at all.
    if (orders.length > 0) {
      this.deps.logger?.info?.(
        {
          component: 'crypto-entitlement-reconcile',
          event: 'crypto_entitlement_reconcile_tick',
          found: orders.length,
          recovered,
          failed,
        },
        'recovered paid crypto order(s) whose entitlement never landed',
      );
    }

    return { found: orders.length, recovered, failed, capped: orders.length >= limit };
  }
}

export interface RegisterCryptoEntitlementReconcileOpts {
  readonly scheduledJobs: ScheduledJobsService;
  readonly sweeper: CryptoEntitlementReconcileSweeper;
  readonly logger?: { error?: (obj: Record<string, unknown>, msg: string) => void };
  readonly nowFn?: () => number;
}

export function registerCryptoEntitlementReconcileJob(
  opts: RegisterCryptoEntitlementReconcileOpts,
): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(
    CRYPTO_ENTITLEMENT_RECONCILE_JOB_TYPE,
    async (job: ScheduledJobRow) => {
      try {
        await opts.sweeper.tickOnce();
      } catch (err) {
        opts.logger?.error?.(
          {
            component: 'crypto-entitlement-reconcile',
            event: 'crypto_entitlement_reconcile_tick_failed',
            err: { message: err instanceof Error ? err.message : String(err) },
          },
          'crypto entitlement reconcile tick failed — re-arming; orders retry next tick',
        );
      }
      // Re-arm unconditionally: a chain that stops re-arming stops recovering paid customers,
      // silently, until the next process restart.
      await enqueueNextCryptoEntitlementReconcile({
        scheduledJobs: opts.scheduledJobs,
        nowFn: now,
        currentRunAt: job.runAt,
      });
    },
  );
}

export async function enqueueNextCryptoEntitlementReconcile(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: CRYPTO_ENTITLEMENT_RECONCILE_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + CRYPTO_ENTITLEMENT_RECONCILE_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
