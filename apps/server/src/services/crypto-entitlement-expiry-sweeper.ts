// Audit-1 C1 — crypto entitlement expiry sweeper.
//
// A crypto tier entitlement (crypto_entitlements) grants a tier for a fixed
// 31-day window. When the last unexpired entitlement for an account lapses, the
// account must fall back to whatever it is still genuinely entitled to (a live
// Stripe subscription, another still-valid crypto entitlement, or free) — the
// mirror of how Stripe cancellations downgrade. This scheduled sweeper runs
// every 15 min, finds newly-expired entitlements, recomputes each affected
// account's tier via the SAME downgradeAccountTierToBestRemaining path Stripe
// uses (whose union already excludes the just-expired rows), and marks them
// processed.
//
// Idempotency (work-then-mark): a crash after the recompute but before the mark
// re-lists the same rows next tick; the recompute is a pure function of the
// current DB state, so it produces previousTier === appliedTier (no second
// downgrade, no duplicate email) and then marks. Never mark-then-work.
//
// Scheduling mirrors session-duration-sweeper EXACTLY: the bootstrap enqueue
// dedups all pending rows; in-handler re-arms ignore the current/older
// run-time cohort but still deduplicate future successors.

import type { StripeWebhooksRepo } from './stripe-webhooks.js';
import type { AccountLifecycleService } from './account-lifecycle.js';
import type { AuthCache } from './auth-cache.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';

export const CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_JOB_TYPE = 'crypto.entitlement_expiry_sweep';

/** Re-arm cadence: 15 minutes (entitlement expiry is day-scale; no urgency). */
export const CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Per-tick cap so a backlog drains over several ticks, not one. */
const DEFAULT_BATCH_LIMIT = 200;

export type CryptoEntitlementSweeperRepo = Pick<
  StripeWebhooksRepo,
  | 'listExpiredUnprocessedCryptoEntitlements'
  | 'markCryptoEntitlementsProcessed'
  | 'downgradeAccountTierToBestRemaining'
>;

export interface CryptoEntitlementExpirySweeperDeps {
  readonly repo: CryptoEntitlementSweeperRepo;
  readonly logger: Logger;
  /** Best-effort — a real tier change emits subscription.tier_changed (audit + email). */
  readonly accountLifecycle?: AccountLifecycleService | null;
  /** Best-effort — invalidate the account cache on a real tier change. */
  readonly authCache?: AuthCache | null;
  /** Override the per-tick cap (defaults to 200). */
  readonly batchLimit?: number;
}

export interface CryptoEntitlementSweepTickResult {
  /** Expired-and-unprocessed entitlement rows handled this tick. */
  readonly processed: number;
  /** Accounts whose tier actually changed this tick. */
  readonly downgraded: number;
}

export class CryptoEntitlementExpirySweeperService {
  constructor(private readonly deps: CryptoEntitlementExpirySweeperDeps) {}

  async tickOnce(now: Date): Promise<CryptoEntitlementSweepTickResult> {
    const limit = this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
    const rows = await this.deps.repo.listExpiredUnprocessedCryptoEntitlements({
      asOf: now,
      limit,
    });
    if (rows.length === 0) return { processed: 0, downgraded: 0 };

    // Group by account — one recompute per account even if several of its
    // entitlements expired together. Keep one orderId per account for the emit.
    const byAccount = new Map<string, { orderId: string; ids: string[] }>();
    for (const r of rows) {
      const existing = byAccount.get(r.accountId);
      if (existing) existing.ids.push(r.id);
      else byAccount.set(r.accountId, { orderId: r.orderId, ids: [r.id] });
    }

    let downgraded = 0;
    const failedAccounts = new Set<string>();
    for (const [accountId, group] of byAccount) {
      // Per-account isolation: one account's recompute/emit failure must not
      // abort the whole tick or strand the OTHER accounts (and, crucially, must
      // not mark the failed account's rows processed below). A failed account's
      // rows are left unprocessed so the next tick re-lists and retries them —
      // the same "will retry next tick" contract session-duration-sweeper uses.
      try {
        // The union computation floors against UNEXPIRED entitlements only, so
        // the just-expired rows are automatically excluded — the account drops
        // to its best remaining Stripe sub / other valid entitlement / free.
        const { previousTier, appliedTier } =
          await this.deps.repo.downgradeAccountTierToBestRemaining({
            accountId,
            fallbackTier: 'free',
            at: now,
          });
        if (previousTier !== appliedTier) {
          downgraded += 1;
          if (this.deps.authCache) {
            try {
              await this.deps.authCache.invalidateAccount(accountId);
            } catch {
              /* best-effort — the tier write is committed; cache TTLs out */
            }
          }
          if (this.deps.accountLifecycle) {
            await this.deps.accountLifecycle.emit(accountId, {
              kind: 'subscription.tier_changed',
              fromTier: previousTier,
              toTier: appliedTier,
              effectiveAt: now,
              cryptoOrderId: group.orderId,
            });
          }
          this.deps.logger.info(
            {
              component: 'crypto-entitlement-sweeper',
              event: 'crypto_entitlement_expired_downgrade',
              account_id: accountId,
              order_id: group.orderId,
              from_tier: previousTier,
              to_tier: appliedTier,
            },
            'crypto entitlement expired — account tier recomputed to best remaining',
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failedAccounts.add(accountId);
        this.deps.logger.warn?.(
          {
            component: 'crypto-entitlement-sweeper',
            event: 'crypto_entitlement_downgrade_failed',
            account_id: accountId,
            order_id: group.orderId,
            err: { message },
          },
          'crypto entitlement downgrade failed for account — will retry next tick',
        );
      }
    }

    // Mark AFTER the recompute so a crash before this replays an idempotent
    // recompute rather than skipping the downgrade. Only mark rows whose account
    // processed cleanly; a failed account's rows stay unprocessed and are
    // re-listed next tick. The mark itself stays OUTSIDE the per-account guard
    // so a mark failure still propagates (crash-idempotency: the whole batch
    // replays next tick, not silently skipped).
    const idsToMark = rows.filter((r) => !failedAccounts.has(r.accountId)).map((r) => r.id);
    if (idsToMark.length > 0) {
      await this.deps.repo.markCryptoEntitlementsProcessed({
        ids: idsToMark,
        at: now,
      });
    }
    return { processed: idsToMark.length, downgraded };
  }
}

export interface RegisterCryptoEntitlementExpirySweepJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweeper: CryptoEntitlementExpirySweeperService;
  /** Test seam — defaults to Date.now. */
  nowFn?: () => number;
  /** Best-effort — logs a swallowed tick failure (chain survival, see below). */
  logger?: Logger;
}

/**
 * Wire the sweeper onto the ScheduledJobsService. Re-arms ignore the
 * current/older run-time cohort but dedup against later successors.
 *
 * Chain survival: the re-arm must run even if `tickOnce` throws. If it did not,
 * a throw would leave no re-arm, the poller would retry the job, and once
 * `maxAttempts` is exhausted the job is markFailed with NO pending sweep row —
 * the self-re-arming chain is then dead until a process restart and NO crypto
 * entitlement ever expires again (every lapsed customer keeps a paid tier for
 * free). We therefore SWALLOW a tick failure (logging it) and re-arm exactly
 * once. We must NOT re-throw-and-re-arm-in-`finally`: the poller would retry the
 * same job and each attempt would re-arm → duplicate parallel chains (fan-out).
 * The tick is idempotent — the next tick re-lists any rows this one missed.
 */
export function registerCryptoEntitlementExpirySweepJob(
  opts: RegisterCryptoEntitlementExpirySweepJobOpts,
): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(
    CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_JOB_TYPE,
    async (job: ScheduledJobRow) => {
      try {
        await opts.sweeper.tickOnce(new Date(now()));
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        opts.logger?.error?.(
          {
            component: 'crypto-entitlement-sweeper',
            event: 'crypto_entitlement_sweep_tick_failed',
            err: { message },
          },
          'crypto entitlement sweep tick failed — re-arming; rows retry next tick',
        );
      }
      await enqueueNextCryptoEntitlementExpirySweep({
        scheduledJobs: opts.scheduledJobs,
        nowFn: now,
        currentRunAt: job.runAt,
      });
    },
  );
}

/**
 * Enqueue the next sweep at `now + interval`. Bootstrap dedups all pending;
 * re-arms dedup only against successors after `currentRunAt`.
 */
export async function enqueueNextCryptoEntitlementExpirySweep(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + CRYPTO_ENTITLEMENT_EXPIRY_SWEEP_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
