// Live-billing audit #3 — the past-due grace sweep.
//
// A failed renewal puts a Stripe subscription in `past_due`. The account keeps
// the paid plan for PAST_DUE_GRACE_DAYS from then (the published terms, 8.5,
// promise at least seven days' written notice before a suspension for
// non-payment; the payment-failure email is that notice), because the tier
// recompute counts a past_due subscription inside its grace as still granting.
// When the grace runs out and Stripe sends nothing — it can leave a subscription
// past_due for weeks while it retries — no event would ever take the plan away.
// This sweep does: every 15 minutes it lists the past_due spells whose grace is
// over and that it has not yet processed, recomputes each account's tier through
// the SAME downgradeAccountTierToBestRemaining the webhook uses (the spell no
// longer counts, so the account drops to its best remaining access: another
// subscription, a crypto term, or free), and marks the spells processed.
//
// Idempotent (work-then-mark, as the crypto expiry sweep): a crash after the
// recompute and before the mark re-lists the same spells next tick, and the
// recompute is a pure function of the current rows, so it changes nothing twice
// and emits nothing twice. A spell is marked only while it is still the spell
// that was listed, so a subscription that recovered in between is left alone.
//
// Failures alert. One account's failure never stops the others; its spells stay
// unmarked and are retried next tick, and staff are told (no identifiers in the
// alert; the log line carries them). A tick that fails as a whole is logged and
// alerted, and the chain re-arms anyway.

import type { StripeWebhooksRepo } from './stripe-webhooks.js';
import type { AccountLifecycleService } from './account-lifecycle.js';
import type { AuthCache } from './auth-cache.js';
import type { ScheduledJobsService, ScheduledJobRow } from './scheduled-jobs.js';
import type { Logger } from '../lib/logger.js';
import type { SentryClient } from '../lib/sentry.js';

export const PAST_DUE_GRACE_SWEEP_JOB_TYPE = 'billing.past_due_grace_sweep';

/** Re-arm cadence: 15 minutes (the grace is seven days; a quarter hour late is fine). */
export const PAST_DUE_GRACE_SWEEP_INTERVAL_MS = 15 * 60 * 1000;

/** Per-tick cap so a backlog drains over several ticks, not one. */
const DEFAULT_BATCH_LIMIT = 200;

export type PastDueGraceSweeperRepo = Pick<
  StripeWebhooksRepo,
  'listPastDueGraceEnded' | 'markPastDueGraceEnded' | 'downgradeAccountTierToBestRemaining'
>;

export interface PastDueGraceSweeperDeps {
  readonly repo: PastDueGraceSweeperRepo;
  readonly logger: Logger;
  /** Where a failure is alerted. Optional; the log line is written either way. */
  readonly sentry?: Pick<SentryClient, 'captureMessage'> | null;
  /** Best-effort — a real tier change emits subscription.tier_changed (audit + email). */
  readonly accountLifecycle?: AccountLifecycleService | null;
  /** Best-effort — invalidate the account cache on a real tier change. */
  readonly authCache?: AuthCache | null;
  /** Override the per-tick cap (defaults to 200). */
  readonly batchLimit?: number;
}

export interface PastDueGraceSweepTickResult {
  /** Past_due spells processed (and marked) this tick. */
  readonly processed: number;
  /** Accounts whose tier actually changed this tick. */
  readonly downgraded: number;
  /** Accounts whose recompute failed; their spells are retried next tick. */
  readonly failed: number;
}

export class PastDueGraceSweeperService {
  constructor(private readonly deps: PastDueGraceSweeperDeps) {}

  async tickOnce(now: Date): Promise<PastDueGraceSweepTickResult> {
    const limit = this.deps.batchLimit ?? DEFAULT_BATCH_LIMIT;
    const rows = await this.deps.repo.listPastDueGraceEnded({ asOf: now, limit });
    if (rows.length === 0) return { processed: 0, downgraded: 0, failed: 0 };

    // One recompute per account, however many of its spells ended together.
    const idsByAccount = new Map<string, string[]>();
    for (const r of rows) {
      const ids = idsByAccount.get(r.accountId);
      if (ids) ids.push(r.id);
      else idsByAccount.set(r.accountId, [r.id]);
    }

    let downgraded = 0;
    const failedAccounts = new Set<string>();
    for (const accountId of idsByAccount.keys()) {
      try {
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
              /* best-effort — the tier write is committed; the cache TTLs out */
            }
          }
          if (this.deps.accountLifecycle) {
            await this.deps.accountLifecycle.emit(accountId, {
              kind: 'subscription.tier_changed',
              fromTier: previousTier,
              toTier: appliedTier,
              effectiveAt: now,
            });
          }
          this.deps.logger.info(
            {
              component: 'past-due-grace-sweeper',
              event: 'past_due_grace_ended_downgrade',
              account_id: accountId,
              from_tier: previousTier,
              to_tier: appliedTier,
            },
            'past-due grace ended — account tier recomputed to best remaining',
          );
        }
      } catch (err) {
        failedAccounts.add(accountId);
        this.deps.logger.error(
          {
            component: 'past-due-grace-sweeper',
            event: 'past_due_grace_downgrade_failed',
            account_id: accountId,
            err: { message: err instanceof Error ? err.message : String(err) },
          },
          'past-due grace ended but the account could not be downgraded — will retry next tick',
        );
      }
    }
    if (failedAccounts.size > 0) {
      this.alert(
        'past_due_grace_downgrade_failed',
        'A subscription past its seven days of past-due grace could not be taken off its paid ' +
          'plan; the sweep retries it every tick. Find the account in the server log.',
      );
    }

    // Mark AFTER the recompute, and only the spells of accounts that recomputed
    // cleanly. A failing mark propagates: the whole batch is re-listed next tick.
    const idsToMark = [...idsByAccount]
      .filter(([accountId]) => !failedAccounts.has(accountId))
      .flatMap(([, ids]) => ids);
    if (idsToMark.length > 0) {
      await this.deps.repo.markPastDueGraceEnded({ ids: idsToMark, asOf: now });
    }
    return { processed: idsToMark.length, downgraded, failed: failedAccounts.size };
  }

  /** An id-free alert; the log line beside it carries the ids. */
  alert(
    kind: 'past_due_grace_downgrade_failed' | 'past_due_grace_sweep_failed',
    message: string,
  ): void {
    try {
      this.deps.sentry?.captureMessage({
        message,
        level: 'error',
        fingerprint: ['billing', kind],
        tags: { kind },
      });
    } catch {
      /* the log line is the record */
    }
  }
}

export interface RegisterPastDueGraceSweepJobOpts {
  scheduledJobs: ScheduledJobsService;
  sweeper: PastDueGraceSweeperService;
  /** Test seam — defaults to Date.now. */
  nowFn?: () => number;
  /** Logs a swallowed tick failure (chain survival, see below). */
  logger?: Logger;
}

/**
 * Wire the sweep onto the ScheduledJobsService — the crypto expiry sweep's
 * pattern exactly. Chain survival: a tick that throws is logged, ALERTED and
 * swallowed, and the job re-arms exactly once; re-throwing would let the poller
 * retry the job and each attempt re-arm (parallel chains), and a job that
 * exhausted its attempts with no successor would end the chain, after which no
 * past-due grace would ever end again.
 */
export function registerPastDueGraceSweepJob(opts: RegisterPastDueGraceSweepJobOpts): void {
  const now = opts.nowFn ?? Date.now;
  opts.scheduledJobs.register(PAST_DUE_GRACE_SWEEP_JOB_TYPE, async (job: ScheduledJobRow) => {
    try {
      await opts.sweeper.tickOnce(new Date(now()));
    } catch (err) {
      opts.logger?.error?.(
        {
          component: 'past-due-grace-sweeper',
          event: 'past_due_grace_sweep_tick_failed',
          err: { message: err instanceof Error ? err.message : String(err) },
        },
        'past-due grace sweep tick failed — re-arming; spells retry next tick',
      );
      opts.sweeper.alert(
        'past_due_grace_sweep_failed',
        'The past-due grace sweep failed a whole tick; it re-arms and retries, but until it ' +
          'succeeds no subscription past its seven days of grace loses its paid plan.',
      );
    }
    await enqueueNextPastDueGraceSweep({
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
export async function enqueueNextPastDueGraceSweep(opts: {
  scheduledJobs: ScheduledJobsService;
  nowFn?: () => number;
  currentRunAt?: Date;
}): Promise<{ enqueued: boolean }> {
  const now = (opts.nowFn ?? Date.now)();
  return opts.scheduledJobs.enqueue({
    jobType: PAST_DUE_GRACE_SWEEP_JOB_TYPE,
    accountId: null,
    payload: {},
    runAt: new Date(now + PAST_DUE_GRACE_SWEEP_INTERVAL_MS),
    dedupOnAccountAndType: true,
    ...(opts.currentRunAt === undefined ? {} : { dedupAfterRunAt: opts.currentRunAt }),
  });
}
