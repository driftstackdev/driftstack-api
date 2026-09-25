// Account-state mutations (admin-only).
//
// These services back the admin endpoints under /v1/admin/accounts/:id
// (tier change, suspend, unsuspend). Each mutation invalidates the auth
// cache for the target account so cached AccountContext reads pick up
// the new state on the next request (D-020 + D-025 cache invalidation
// pattern).
//
// Audit logging is the route's responsibility — the route writes the
// audit row in the same handler that calls the service. The service
// stays focused on the mutation; the route owns the request/response
// envelope.

import type { AccountTier } from '@driftstack/api-types';
import type { AccountContext } from './auth.js';
import type { AccountRow } from './auth.js';
import type { AuthCache } from './auth-cache.js';
import type { LiveBilling } from './billing.js';
import { refreshCreditsAfter, type CreditsRefresher } from './credit-grants.js';
import { ConflictError } from '../lib/errors.js';
import { NotFoundError, requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';
import type { SentryClient } from '../lib/sentry.js';

export interface ListAccountsArgs {
  /** Cursor is the prior page's last `id` (created_at desc + id desc tie-break). */
  cursor?: string;
  limit?: number;
  /** Filter by account status. Default: no filter. */
  status?: 'active' | 'suspended' | 'deleted';
  /** Filter by tier. Default: no filter. */
  tier?: AccountTier;
  /** Substring filter on email (lowercased). Default: no filter. */
  emailContains?: string;
}

export interface ListAccountsPage {
  data: AccountRow[];
  hasMore: boolean;
  nextCursor: string | null;
}

/**
 * What an admin may send with a tier change beyond the tier itself. Declared
 * with the repo interface rather than beside its Drizzle implementation, the
 * same direction as `ListAccountsArgs`: the in-memory double and the production
 * repo both implement this file.
 */
export interface SetAccountTierOptions {
  /**
   * Whole credits a month for an Enterprise agreement, written as the account's
   * `contract` override. Required to put an account that is ON CREDITS onto
   * Enterprise — that plan has no standard allowance — and ignored for every
   * other tier and for a legacy account.
   */
  readonly monthlyCredits?: number;
  /** The admin API key that asked, kept on the override for the audit trail. */
  readonly setByKeyId?: string | null;
  readonly note?: string;
}

export interface AccountsAdminRepo {
  findById(id: string): Promise<AccountRow | null>;
  setTier(
    id: string,
    tier: AccountTier,
    at: Date,
    opts?: SetAccountTierOptions,
  ): Promise<AccountRow | null>;
  setStatus(
    id: string,
    status: 'active' | 'suspended' | 'deleted',
    at: Date,
  ): Promise<AccountRow | null>;
  list(args: ListAccountsArgs): Promise<ListAccountsPage>;
  countByStatus(status: 'active' | 'suspended' | 'deleted'): Promise<number>;
  /** Account count grouped by tier — every AccountTier present, zero-filled. Sums to the total row count (all statuses). */
  countByTier(): Promise<Record<AccountTier, number>>;
  /** Count of accounts created at or after `since` (inclusive). Used for signup-window stats. */
  countCreatedSince(since: Date): Promise<number>;
}

/** New-signup counts over rolling windows (UTC). `today` = since 00:00:00 UTC; 7d/30d are now-minus-N-days. */
export interface SignupWindowCounts {
  today: number;
  last_7d: number;
  last_30d: number;
}

/** Minimal sessions-service surface the suspend-reclaim path depends on. */
export interface SuspendSessionReclaimer {
  destroyAllForAccount(accountId: string): Promise<number>;
}

/**
 * V-758 — minimal billing surface the suspension lifecycle depends on. The AUP §5.2 tells
 * customers that suspension pauses billing; until this dep existed the promise was untrue,
 * because `suspend()` had no billing dependency of any kind and a suspended account kept
 * renewing a flat monthly subscription while every authenticated request 403'd.
 *
 * Deliberately narrow and structural, like the reclaimers above: this service should not
 * learn the whole BillingService surface to pause an invoice.
 */
export interface BillingCollectionPauser {
  pauseCollectionForAccount(accountId: string): Promise<'paused' | 'no_subscription'>;
  resumeCollectionForAccount(accountId: string): Promise<'resumed' | 'no_subscription'>;
  /**
   * Live-billing audit #1 — cancel every subscription still collecting, at once, for an
   * account being TERMINATED: a paid one prorated, one that was not paid without
   * proration (owner decision of 2026-09-24; subscription-payment-state.ts). Resolves with the Stripe
   * subscription ids cancelled (empty when nothing was collecting) and, when the pauser
   * knows it, the subset cancelled without proration; rejects when any was not, carrying
   * `done` / `failed` id lists when it knows them (BillingService's
   * SubscriptionCollectionError).
   *
   * Optional only so a pauser built before this existed still compiles. A pauser WITHOUT
   * it makes every termination record `billing_cancel` as failed and alert staff — a
   * subscription that may still be charging is never skipped in silence.
   */
  cancelCollectionForAccount?(accountId: string): Promise<{
    cancelled: string[];
    cancelledWithoutProration?: string[];
    /** Ids whose payment state could not be read, so their stored status decided. */
    paymentStateUnread?: string[];
  }>;
  /**
   * Live-billing audit #6 — what the account is still paying for. When present, an admin
   * tier change is refused while a Stripe subscription is collecting or a crypto term has
   * not ended. Absent ⇒ a tier change behaves exactly as before.
   */
  liveBillingForAccount?(accountId: string): Promise<LiveBilling>;
}

/**
 * Where the termination alerts go (live-billing audit #1): Sentry's message capture.
 * Every alert sent through it names NO account, customer or subscription — the server
 * log line beside it does, for the person who follows it up.
 */
export type BillingAlerts = Pick<SentryClient, 'captureMessage'>;

/**
 * GDPR Article 17 — minimal auth-flows-service surface the delete-
 * reclaim path depends on. Bulk-revokes every dashboard web session
 * for the account (no exclusion — contrast with the customer "sign
 * out everywhere else" flow, which keeps the calling session alive).
 */
export interface DeleteWebSessionReclaimer {
  /** `staffAccountId` is who the account's log names: this is a staff reclaim. */
  revokeAllWebSessionsForAccount(
    accountId: string,
    now: Date,
    staffAccountId: string,
  ): Promise<number>;
}

/** GDPR Article 17 — minimal api-keys-service surface the delete-reclaim path depends on. */
export interface DeleteApiKeyReclaimer {
  revokeAllForAccount(ctx: AccountContext, accountId: string): Promise<number>;
  /** V-727 — keys this account minted on OTHER accounts, which the by-account
   *  reclaim above cannot see. */
  revokeAllMintedByAccount(ctx: AccountContext, minterAccountId: string): Promise<number>;
}

/** GDPR Article 17 — minimal webhooks-service surface the delete-reclaim path depends on. */
export interface DeleteWebhookReclaimer {
  deleteAllForAccount(ctx: AccountContext, accountId: string): Promise<number>;
}

export class AccountsAdminService {
  constructor(
    private readonly repo: AccountsAdminRepo,
    private readonly authCache: AuthCache | null = null,
    private readonly sessions: SuspendSessionReclaimer | null = null,
    private readonly webSessions: DeleteWebSessionReclaimer | null = null,
    private readonly apiKeys: DeleteApiKeyReclaimer | null = null,
    private readonly webhooks: DeleteWebhookReclaimer | null = null,
    /**
     * Optional structured logger. Every reclaim below is deliberately
     * best-effort — the status mutation is already committed and the auth path
     * already blocks a suspended/deleted account — but swallowing the failure
     * SILENTLY is what let a GDPR Article 17 termination report success having
     * reclaimed nothing. Omitted ⇒ no log; the reclaims still run.
     */
    private readonly logger: {
      error?: (obj: Record<string, unknown>, msg: string) => void;
      warn?: (obj: Record<string, unknown>, msg: string) => void;
    } | null = null,
    /**
     * V-758 — optional so every existing construction site and test double keeps working;
     * when absent, suspension behaves exactly as before and the pause is simply skipped.
     * Production wires it (bootstrap.ts) — an unwired pauser would make the AUP promise
     * untrue again, silently, which is why the wiring is asserted in the tests.
     */
    private readonly billing: BillingCollectionPauser | null = null,
    /**
     * Grants monthly AI credits from paid coverage. Null while AI credits are
     * switched off, and then a tier change does exactly what it did.
     */
    private readonly credits: CreditsRefresher | null = null,
    /**
     * Live-billing audit #1 — where a termination tells staff that a subscription was
     * cancelled (so they can decide whether a refund is owed under the Terms, 14.5) or
     * could NOT be cancelled (so they cancel it by hand). Null ⇒ the server log alone.
     */
    private readonly alerts: BillingAlerts | null = null,
  ) {}

  /**
   * Run one best-effort reclaim step.
   *
   * The failure must not fail the surrounding admin action: the status
   * mutation is already committed, and `auth.ts` rejects every new request
   * from a suspended/deleted account regardless of whether a given step
   * landed. That is why these are swallowed, and it stays true here.
   *
   * What changes is that the failure is now RECORDED. A swallowed reclaim is
   * the difference between "terminated" and "terminated with live credentials
   * still authenticating on another account", and nothing else in the system
   * writes that down — the admin action returns success either way.
   */
  private async reclaim(
    step: string,
    accountId: string,
    run: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await run();
    } catch (err) {
      try {
        this.logger?.error?.(
          {
            component: 'admin-accounts',
            event: 'account_reclaim_failed',
            step,
            account_id: accountId,
            err,
          },
          `account reclaim step "${step}" failed — the status change is committed but this surface was not reclaimed and needs reconciling`,
        );
      } catch {
        // Swallow; logging is best-effort and must not fail the admin action.
      }
    }
  }

  async getAccount(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const row = await this.repo.findById(accountId);
    if (!row) throw new NotFoundError(`Account "${accountId}" not found.`);
    return row;
  }

  async list(ctx: AccountContext, args: ListAccountsArgs): Promise<ListAccountsPage> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.list(args);
  }

  async countByStatus(
    ctx: AccountContext,
    status: 'active' | 'suspended' | 'deleted',
  ): Promise<number> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.countByStatus(status);
  }

  async countByTier(ctx: AccountContext): Promise<Record<AccountTier, number>> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    return this.repo.countByTier();
  }

  // Signup counts over rolling windows. Windowing lives here (not the repo)
  // so the repo stays a primitive countCreatedSince(since); `now` is injected
  // by the caller for deterministic tests. `today` is from 00:00:00 UTC.
  async signupCounts(ctx: AccountContext, now: Date): Promise<SignupWindowCounts> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const startOfToday = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
    );
    const sevenDaysAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const [today, last_7d, last_30d] = await Promise.all([
      this.repo.countCreatedSince(startOfToday),
      this.repo.countCreatedSince(sevenDaysAgo),
      this.repo.countCreatedSince(thirtyDaysAgo),
    ]);
    return { today, last_7d, last_30d };
  }

  /**
   * `opts.monthlyCredits` is the Enterprise contract's figure. The repo refuses
   * Enterprise without it on an account that is on credits, and writes it as
   * that account's `contract` override in the same transaction as the tier —
   * so the plan and the allowance it is worth never exist apart.
   */
  async changeTier(
    ctx: AccountContext,
    accountId: string,
    newTier: AccountTier,
    opts: SetAccountTierOptions = {},
  ): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    await this.refuseWhileStillPaying(accountId, newTier);
    const updated = await this.repo.setTier(accountId, newTier, new Date(), {
      ...opts,
      setByKeyId: opts.setByKeyId ?? ctx.apiKey.id,
    });
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    // Best-effort, and last: the tier change is committed and must not be failed
    // by this. A tier grants no credits by itself (only paid coverage does), so
    // this grants whatever the account was already owed and had not got, and
    // reconciles the current month against a plan that has just changed.
    await refreshCreditsAfter(this.credits, accountId, {
      trigger: 'admin_tier_change',
      rethrowTransient: false,
      logger: this.logger,
    });
    return updated;
  }

  /**
   * Live-billing audit #6 — a tier set here while the account still pays by card or by
   * crypto does not last: the subscription's next event (a cancel-at-period-end update,
   * its `deleted`) resets the tier from Stripe, and the crypto expiry sweep recomputes it
   * when a term ends. So the change is refused, saying what to end first; Enterprise moves
   * are made after cancelling.
   *
   * Naming the tier the account already holds is not a change — Stripe has nothing to
   * undo — and is not refused (an Enterprise contract amendment re-sends the same tier).
   * With no live-billing reader wired a tier change behaves exactly as before.
   *
   * Read before the write, not inside its transaction: a subscription created between the
   * two is not seen. That window is a Checkout completing in the same instant as an admin
   * action on the same account.
   */
  private async refuseWhileStillPaying(accountId: string, newTier: AccountTier): Promise<void> {
    const billing = this.billing;
    if (billing?.liveBillingForAccount === undefined) return;
    const current = await this.repo.findById(accountId);
    // An absent account is reported by setTier as a 404, exactly as before.
    if (current === null || current.tier === newTier) return;
    const live = await billing.liveBillingForAccount(accountId);
    if (live.collectingSubscriptions.length > 0) {
      const ids = live.collectingSubscriptions.map((s) => s.stripeSubscriptionId);
      throw new ConflictError(
        `Account "${accountId}" has a Stripe subscription that is still collecting (${ids.join(', ')}). ` +
          'A tier set here would be undone by its next event. Cancel the subscription first, then change the tier.',
        { resource: 'subscription', stripe_subscription_ids: ids },
      );
    }
    if (live.cryptoTerms.length > 0) {
      const endsAt = live.cryptoTerms[0]!.expiresAt.toISOString().slice(0, 10);
      throw new ConflictError(
        `Account "${accountId}" has a paid crypto term that runs until ${endsAt}. ` +
          'A tier set here would be undone when that term is recomputed. Refund the crypto order first, or change the tier after the term ends.',
        {
          resource: 'crypto_entitlement',
          expires_at: live.cryptoTerms[0]!.expiresAt.toISOString(),
        },
      );
    }
  }

  async suspend(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const updated = await this.repo.setStatus(accountId, 'suspended', new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    // Reclaim the account's still-running browser sessions so they stop
    // consuming the driver while suspended. Auth already blocks every new
    // request from a suspended account (auth.ts) — this frees the in-flight
    // compute. Best-effort: the suspend mutation is already committed, and
    // the duration sweep mops up any straggler if reclaim fails.
    const suspendSessions = this.sessions;
    if (suspendSessions) {
      // Never fails the suspend; reported so a straggling live session that
      // only the duration sweep will eventually mop up is not invisible.
      await this.reclaim('sessions', accountId, () =>
        suspendSessions.destroyAllForAccount(accountId),
      );
    }
    // V-758 — honour the AUP §5.2 "billing pauses" promise. Best-effort like every other
    // step here: the suspension itself is already committed and must not be undone by a
    // Stripe outage. But a FAILURE here is the one that costs the customer money — they
    // keep being invoiced for a service that 403s — so it goes through the same alarm,
    // which names the step, rather than being swallowed.
    const pauser = this.billing;
    if (pauser) {
      await this.reclaim('billing_pause', accountId, () =>
        pauser.pauseCollectionForAccount(accountId),
      );
    }
    return updated;
  }

  async unsuspend(ctx: AccountContext, accountId: string): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const updated = await this.repo.setStatus(accountId, 'active', new Date());
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);
    await this.invalidateCache(accountId);
    // V-758 — symmetric resume. This is not optional politeness: pausing collection
    // without ever clearing it would leave a reinstated customer permanently unbilled,
    // which is a worse defect than the one the pause fixes. Same best-effort + named
    // alarm, so a failed resume is visible rather than becoming silent free service.
    const pauser = this.billing;
    if (pauser) {
      await this.reclaim('billing_resume', accountId, () =>
        pauser.resumeCollectionForAccount(accountId),
      );
    }
    return updated;
  }

  /**
   * GDPR Article 17 — admin-triggered account termination. Mirrors
   * suspend()'s shape: set status, then best-effort reclaim every
   * live surface tied to the account. Each reclaim step is
   * independently try/caught exactly like suspend()'s session
   * reclaim — the status mutation is already committed by the time
   * any reclaim runs, and the auth-path 'deleted' checks (auth.ts
   * slowPathApiKey / slowPathWebSession) already block every new
   * request regardless of whether a given reclaim step fully lands.
   * No distributed transaction: same best-effort consistency
   * guarantee as suspend(), just extended to more surfaces.
   *
   * Order: sessions → web sessions → API keys → webhooks → billing →
   * cache invalidation (last, so the cache is only dropped once the
   * full reclaim sweep has been attempted).
   *
   * `auditRecord` — the admin audit row's payload, when the route hands it in.
   * The billing step writes into it which Stripe subscriptions it cancelled and
   * which it could not, so the admin audit trail says what termination did to
   * the customer's billing. The route writes the row AFTER this returns.
   */
  async deleteAccount(
    ctx: AccountContext,
    accountId: string,
    auditRecord?: Record<string, unknown>,
  ): Promise<AccountRow> {
    throwIfMissingScope(ctx, 'driftstack_internal_admin');
    const now = new Date();
    const updated = await this.repo.setStatus(accountId, 'deleted', now);
    if (!updated) throw new NotFoundError(`Account "${accountId}" not found.`);

    // Each step never fails the delete, and each now records its own failure.
    // Naming the step matters: "the account was terminated" is true whichever
    // of these did not land, and only the step tells an operator whether live
    // API keys are still authenticating or a browser is merely still running.
    const sessions = this.sessions;
    if (sessions) {
      await this.reclaim('sessions', accountId, () => sessions.destroyAllForAccount(accountId));
    }
    const webSessions = this.webSessions;
    if (webSessions) {
      await this.reclaim('web_sessions', accountId, () =>
        webSessions.revokeAllWebSessionsForAccount(accountId, now, ctx.account.id),
      );
    }
    const apiKeys = this.apiKeys;
    if (apiKeys) {
      await this.reclaim('api_keys', accountId, () => apiKeys.revokeAllForAccount(ctx, accountId));
      // V-727 — also the keys this account minted on OTHER accounts. The call
      // above filters on account_id and so reclaims only the credentials ON
      // this account; a team member's keys live on the OWNER's account and
      // authenticate as the owner, so terminating the member left them
      // working. Same hole V-726 closed for member removal, different door.
      //
      // This is the step whose silent failure is NOT masked by the auth-path
      // 'deleted' check: those keys authenticate as a still-active account.
      await this.reclaim('api_keys_minted_elsewhere', accountId, () =>
        apiKeys.revokeAllMintedByAccount(ctx, accountId),
      );
    }
    const webhooks = this.webhooks;
    if (webhooks) {
      await this.reclaim('webhooks', accountId, () => webhooks.deleteAllForAccount(ctx, accountId));
    }
    // Live-billing audit #1 — Stripe kept charging a terminated account every month,
    // and the customer could no longer sign in to cancel. Same failure handling as
    // suspend's pause: never fails the termination, never silent.
    const billing = this.billing;
    if (billing) {
      await this.reclaim('billing_cancel', accountId, () =>
        this.cancelBillingOnTermination(billing, accountId, auditRecord),
      );
    }

    await this.invalidateCache(accountId);
    return updated;
  }

  /**
   * Cancel every subscription still collecting, at once. A paid one is prorated — the
   * unused part of the period becomes a credit on the Stripe customer; one that was not
   * paid is not (owner decision of 2026-09-24: past due or unpaid, its latest invoice
   * not paid, or collection paused without billing and no paid invoice for the period —
   * nothing is credited and no final invoice is raised). A subscription paid for its
   * current period is prorated even when the account was suspended part-way through it.
   * Nothing is refunded automatically.
   * Records what happened in the audit payload, logs it WITH the account, and alerts staff
   * WITHOUT it: a cancellation so they can refund under the Terms (14.5) if one is owed, a
   * failure so they cancel by hand. A failure is rethrown for `reclaim` to record as
   * `account_reclaim_failed` / `billing_cancel`.
   */
  private async cancelBillingOnTermination(
    billing: BillingCollectionPauser,
    accountId: string,
    auditRecord: Record<string, unknown> | undefined,
  ): Promise<void> {
    let cancelled: string[];
    let cancelledWithoutProration: string[];
    let paymentStateUnread: string[];
    try {
      if (billing.cancelCollectionForAccount === undefined) {
        throw new Error(
          'no subscription canceller is wired, so a subscription of this terminated account may still be charging',
        );
      }
      const outcome = await billing.cancelCollectionForAccount(accountId);
      cancelled = outcome.cancelled;
      cancelledWithoutProration = outcome.cancelledWithoutProration ?? [];
      paymentStateUnread = outcome.paymentStateUnread ?? [];
    } catch (err) {
      const done = idsOf(err, 'done');
      const failed = idsOf(err, 'failed');
      const doneWithoutProration = idsOf(err, 'doneWithoutProration');
      const unread = idsOf(err, 'paymentStateUnread');
      if (auditRecord !== undefined) {
        auditRecord.stripe_subscriptions_cancelled = done;
        auditRecord.stripe_subscriptions_not_cancelled = failed.length > 0 ? failed : 'unknown';
        // The no-credit record survives a partial failure too (decision of 2026-09-24).
        if (doneWithoutProration.length > 0) {
          auditRecord.stripe_subscriptions_cancelled_without_proration = doneWithoutProration;
        }
        if (unread.length > 0) auditRecord.stripe_subscriptions_payment_state_unread = unread;
      }
      this.alert({
        message:
          'Terminating an account could not cancel its Stripe subscription, so it may still be charging. ' +
          'Cancel it in Stripe by hand and check whether a refund is owed under the Terms (14.5). ' +
          'The account is named in the server log (account_reclaim_failed, step billing_cancel).',
        level: 'error',
        fingerprint: ['billing', 'terminated_account_subscription_not_cancelled'],
        tags: { kind: 'terminated_account_subscription_not_cancelled' },
        extra: { cancelled: done.length, not_cancelled: failed.length },
      });
      throw err;
    }
    if (auditRecord !== undefined) {
      auditRecord.stripe_subscriptions_cancelled = cancelled;
      if (cancelledWithoutProration.length > 0) {
        auditRecord.stripe_subscriptions_cancelled_without_proration = cancelledWithoutProration;
      }
      // Whether these were paid was decided from the stored status: Stripe could not be read.
      if (paymentStateUnread.length > 0) {
        auditRecord.stripe_subscriptions_payment_state_unread = paymentStateUnread;
      }
    }
    if (cancelled.length === 0) return;
    const allUnpaid = cancelledWithoutProration.length === cancelled.length;
    try {
      this.logger?.warn?.(
        {
          component: 'admin-accounts',
          event: 'terminated_account_subscription_cancelled',
          account_id: accountId,
          stripe_subscription_ids: cancelled,
          cancelled_without_proration: cancelledWithoutProration,
          payment_state_unread: paymentStateUnread,
        },
        allUnpaid
          ? 'terminated account: unpaid Stripe subscription(s) cancelled at once, without proration — no credit given for the unpaid period'
          : 'terminated account: Stripe subscription(s) cancelled at once, the unused paid period credited to the Stripe customer (an unpaid one without proration) — check whether a refund is owed (Terms 14.5)',
      );
    } catch {
      // Logging is best-effort and must not fail the admin action.
    }
    const unreadNote =
      paymentStateUnread.length > 0
        ? ' Stripe could not be read in full for some of them, so whether they were paid was decided ' +
          'from their stored status or from the part that could be read; check those in Stripe.'
        : '';
    this.alert({
      message:
        (allUnpaid
          ? "A terminated account's unpaid Stripe subscription (past due, unpaid, with its latest invoice " +
            'not paid, or paused without billing and not paid for the period) was cancelled at once, without ' +
            'proration, so no credit was given for its unpaid period and any open or draft invoice was left ' +
            'as it was. Decide in Stripe whether that invoice should be voided. The account is named in the server log ' +
            '(terminated_account_subscription_cancelled).'
          : "A terminated account's Stripe subscription was cancelled at once, and the unused part of its " +
            'paid period was credited to the Stripe customer (an unpaid one, if any, without proration). ' +
            'Nothing was refunded: check whether a refund is owed under the Terms (14.5). The account is ' +
            'named in the server log (terminated_account_subscription_cancelled).') + unreadNote,
      level: 'warning',
      fingerprint: ['billing', 'terminated_account_subscription_cancelled'],
      tags: { kind: 'terminated_account_subscription_cancelled' },
      extra: {
        cancelled: cancelled.length,
        cancelled_without_proration: cancelledWithoutProration.length,
        payment_state_unread: paymentStateUnread.length,
      },
    });
  }

  private alert(message: Parameters<BillingAlerts['captureMessage']>[0]): void {
    try {
      this.alerts?.captureMessage(message);
    } catch {
      // Fire-and-forget, like every Sentry call: the termination stands regardless.
    }
  }

  private async invalidateCache(accountId: string): Promise<void> {
    if (!this.authCache) return;
    try {
      await this.authCache.invalidateAccount(accountId);
    } catch {
      // Cache failures must not propagate as admin-action failures —
      // the underlying mutation is committed. The next auth-path read
      // will TTL out the stale entry within 30s in the worst case.
    }
  }
}

/** The subscription ids a SubscriptionCollectionError says were (not) reached; [] otherwise. */
function idsOf(
  err: unknown,
  which: 'done' | 'failed' | 'doneWithoutProration' | 'paymentStateUnread',
): string[] {
  if (typeof err !== 'object' || err === null) return [];
  const ids = (err as Record<string, unknown>)[which];
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === 'string') : [];
}
