// Billing service (V-082).
//
// Two customer-facing operations:
//
//   1. Checkout-session — start a paid-tier subscription. Rejects with
//      a 409 (ConflictError) when the account already has an active or
//      trialing subscription. Stripe Checkout in `subscription` mode
//      does NOT dedupe this on its own — without this guard, a second
//      checkout-session call for an already-subscribed customer (e.g. a
//      stale "Change plan" link routing back through Checkout instead
//      of the portal) would silently mint a SECOND concurrent
//      subscription and double-bill the customer. Already-subscribed
//      customers must use the customer portal for plan changes, which
//      prorates an existing subscription in place instead of starting
//      a new one.
//
//   2. Customer portal — open Stripe Customer Portal for self-service
//      plan change / payment-method update / cancellation. Requires
//      the account to have a `stripe_customer_id` set; failure to
//      bootstrap one before portal is a 409.
//
// Plus one read:
//
//   3. GetBillingState — current subscription row (if any). Used by the
//      customer dashboard to render the current plan.
//
// Stripe API access is gated behind `BillingProvider` so tests run
// against an in-memory provider without touching real Stripe.

import type { AccountTier } from '@driftstack/api-types';
import { BadRequestError, ConflictError, NotFoundError } from '../lib/errors.js';
import {
  subscriptionWasNotPaid,
  type SubscriptionPaymentReading,
} from './subscription-payment-state.js';

// ───────────────────────────────────────────────────────────────────────────
// Provider (Stripe SDK boundary)
// ───────────────────────────────────────────────────────────────────────────

export interface BillingProvider {
  /** Look up or create a Stripe customer for this account. Returns the customer id (cus_...). */
  ensureCustomer(args: { accountId: string; email: string; name: string | null }): Promise<string>;

  /** Start a Checkout Session for a recurring subscription. */
  createSubscriptionCheckout(args: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    accountId: string;
    idempotencyKey?: string;
  }): Promise<{ url: string; sessionId: string }>;

  /** Open a Stripe Customer Portal session for the given customer. */
  createPortalSession(args: { customerId: string; returnUrl: string }): Promise<{ url: string }>;

  /**
   * V-758 — pause/resume invoice collection on a subscription, for the account
   * suspension lifecycle. The AUP (§5.2) promises that suspension pauses billing;
   * before this existed the promise was simply untrue — `suspend()` had no billing
   * dependency at all, so a suspended account kept renewing a flat monthly
   * subscription while every authenticated request 403'd.
   *
   * Pausing does NOT change the subscription's `status`: Stripe keeps a
   * pause_collection'd sub `active`, which is why this is safe against the tier
   * mirror (see the C7 note in stripe-webhooks.ts — `downgradeAccountTierToBestRemaining`
   * would otherwise be perturbed). Entitlement during suspension is already denied by
   * the account-status check in auth.ts, not by the subscription.
   */
  pauseSubscriptionCollection(args: { subscriptionId: string }): Promise<void>;

  /** Clear a pause set by {@link pauseSubscriptionCollection}. Must be idempotent. */
  resumeSubscriptionCollection(args: { subscriptionId: string }): Promise<void>;

  /**
   * Live-billing audit #1 — cancel a subscription NOW, for an account being
   * terminated. Prorated by default: Stripe credits the unused part of the period
   * already paid for to the Stripe customer's balance (`prorate=true`,
   * `invoice_now=true` on `DELETE /v1/subscriptions/:id`). `prorate: false` cancels
   * with neither — the caller passes it for a subscription that was not paid
   * ({@link subscriptionWasNotPaid}), whose current period nobody paid for, so there
   * is nothing to credit. It never refunds: whether
   * a refund is owed under the Terms (14.5) is a person's decision, and the
   * termination alerts staff so they can make it.
   *
   * Optional because a provider may not implement it yet. BillingService then
   * refuses to report a termination as clean while a subscription is still
   * collecting — see {@link BillingService.cancelCollectionForAccount}.
   */
  cancelSubscriptionNow?(args: { subscriptionId: string; prorate?: boolean }): Promise<void>;

  /**
   * Owner decision of 2026-09-24 — what the billing provider holds NOW about whether a
   * subscription was paid, read just before a termination cancels it, so the cancel is
   * prorated only for a paid one (see {@link subscriptionWasNotPaid}). Optional: without
   * it, and when the read fails, the stored mirror status decides. A reading that is
   * `partlyUnread` still decides, from what it holds.
   */
  readSubscriptionPaymentState?(args: {
    subscriptionId: string;
  }): Promise<SubscriptionPaymentReading>;
}

// ───────────────────────────────────────────────────────────────────────────
// Repo (account-side reads + subscription mirror)
// ───────────────────────────────────────────────────────────────────────────

export interface BillingAccountSnapshot {
  id: string;
  email: string;
  name: string | null;
  tier: AccountTier;
  stripeCustomerId: string | null;
}

export interface SubscriptionMirror {
  id: string;
  accountId: string;
  stripeSubscriptionId: string;
  stripePriceId: string;
  tier: AccountTier;
  status:
    | 'incomplete'
    | 'incomplete_expired'
    | 'trialing'
    | 'active'
    | 'past_due'
    | 'canceled'
    | 'unpaid'
    | 'paused';
  currentPeriodEnd: Date | null;
  cancelAtPeriodEnd: boolean;
  canceledAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/** A paid crypto term that has not ended. */
export interface RunningCryptoTerm {
  tier: AccountTier;
  expiresAt: Date;
}

/**
 * What an account is still paying for, read before an admin changes its tier
 * (live-billing audit #6): a tier set by hand while either of these is live is
 * undone by the next Stripe event or crypto recompute.
 */
export interface LiveBilling {
  /** Stripe subscriptions still collecting (`active` | `trialing` | `past_due`). */
  collectingSubscriptions: Array<{
    stripeSubscriptionId: string;
    status: SubscriptionMirror['status'];
    tier: AccountTier;
  }>;
  /** Paid crypto terms that have not ended. */
  cryptoTerms: RunningCryptoTerm[];
}

/**
 * A change that had to reach EVERY collecting subscription of an account — a
 * pause, a resume, a cancellation — reached only some of them. Thrown after all
 * of them were tried, so one Stripe refusal never stops the rest; it carries
 * which were done and which were not, so the caller can record both.
 */
export class SubscriptionCollectionError extends Error {
  /**
   * For a cancellation: the ids in `done` cancelled WITHOUT proration (not paid, decision
   * of 2026-09-24), so a termination that partly failed still records which of the
   * subscriptions it did cancel were given no credit. Empty for a pause or a resume.
   */
  readonly doneWithoutProration: readonly string[];
  /**
   * For a cancellation: the ids whose payment state could not be read from the provider
   * in full, so the stored status (or what part of it was read) decided whether they
   * were paid. Empty for a pause or a resume.
   */
  readonly paymentStateUnread: readonly string[];
  constructor(
    readonly action: 'pause' | 'resume' | 'cancel',
    /** Stripe subscription ids the change reached. */
    readonly done: readonly string[],
    /** Stripe subscription ids it did not reach. */
    readonly failed: readonly string[],
    message: string,
    options?: {
      cause?: unknown;
      doneWithoutProration?: readonly string[];
      paymentStateUnread?: readonly string[];
    },
  ) {
    super(
      message,
      options !== undefined && 'cause' in options ? { cause: options.cause } : undefined,
    );
    this.name = 'SubscriptionCollectionError';
    this.doneWithoutProration = options?.doneWithoutProration ?? [];
    this.paymentStateUnread = options?.paymentStateUnread ?? [];
  }
}

export interface BillingRepo {
  getAccount(accountId: string): Promise<BillingAccountSnapshot | null>;
  setStripeCustomerId(args: { accountId: string; customerId: string }): Promise<void>;
  /**
   * Returns the MOST-RECENT subscription row for the account by `created_at`,
   * whatever its status, or null if none. Backs customer-facing copy like "your
   * last subscription was canceled on X".
   *
   * V-741 — NOT usable as a double-subscribe guard, which is what it was doing.
   * It answers "is the newest row active?", and the guard needs "does this
   * account have ANY active subscription?". Use {@link findActiveSubscription}
   * for that. (The previous doc here said "the active or most-recent
   * subscription", which the implementation never did — it is only ever
   * most-recent.)
   */
  findCurrentSubscription(accountId: string): Promise<SubscriptionMirror | null>;
  /**
   * V-767 — the subscription whose collection is still running (`active` | `trialing` |
   * `past_due`). The only correct lookup for a billing-pause: see the note on the repo method.
   */
  findCollectingSubscription(accountId: string): Promise<SubscriptionMirror | null>;
  /**
   * EVERY subscription whose collection is still running (`active` | `trialing` |
   * `past_due`), newest first. An account can hold more than one — re-checkout is allowed
   * while a subscription is past_due — so a pause, a resume or a termination that reaches
   * only the newest leaves the other one billing (live-billing audit #4).
   */
  findCollectingSubscriptions(accountId: string): Promise<SubscriptionMirror[]>;
  /**
   * The account's paid crypto terms that have not ended (`expires_at` after now), latest
   * ending first. A term floors the account's tier while it runs.
   */
  findRunningCryptoTerms(accountId: string): Promise<RunningCryptoTerm[]>;
  /**
   * V-741 — any `active` or `trialing` subscription for the account, or null.
   *
   * Filters the SET rather than picking a row by recency and inspecting it.
   * `created_at` is frozen at the moment the FIRST webhook for a subscription
   * was inserted (upsertSubscription's set-clause deliberately omits it), so row
   * recency does not track subscription recency: a replayed or out-of-order
   * event for an old, canceled subscription lands with a LATER `created_at` than
   * a live one. There is no per-account uniqueness on `subscriptions` (only
   * `stripe_subscription_id` is unique), so several rows per account are normal.
   */
  findActiveSubscription(accountId: string): Promise<SubscriptionMirror | null>;
}

// ───────────────────────────────────────────────────────────────────────────
// Tier → Stripe price id map
// ───────────────────────────────────────────────────────────────────────────

export interface TierPrices {
  monthly: string;
  annual: string;
}

export type TierPriceMap = Partial<Record<AccountTier, TierPrices>>;

export interface BillingServiceConfig {
  /** Map of self-serve paid tier to monthly + annual Stripe price ids. */
  tierPrices: TierPriceMap;
  /** Default success / cancel URLs (customer dashboard). */
  defaultSuccessUrl: string;
  defaultCancelUrl: string;
  /** URL Stripe redirects back to after the customer portal closes. */
  portalReturnUrl: string;
}

// ───────────────────────────────────────────────────────────────────────────
// Service
// ───────────────────────────────────────────────────────────────────────────

export class BillingService {
  constructor(
    private readonly repo: BillingRepo,
    private readonly provider: BillingProvider,
    private readonly config: BillingServiceConfig,
  ) {}

  async createCheckoutSession(args: {
    accountId: string;
    tier: AccountTier;
    billingPeriod: 'monthly' | 'annual';
    successUrl?: string;
    cancelUrl?: string;
    idempotencyKey?: string;
  }): Promise<{ url: string; sessionId: string }> {
    const account = await this.repo.getAccount(args.accountId);
    if (account === null) throw new NotFoundError('Account not found.');

    // Double-subscribe guard — see the file header. A customer with an
    // active or trialing subscription must change plans via the portal
    // (createPortalSession), not by starting a brand-new Checkout
    // session. past_due / canceled / incomplete subscriptions are NOT
    // blocked here: those aren't currently being billed, so letting the
    // customer re-checkout to recover is the right behavior.
    // V-741 — ask whether ANY active subscription exists, not whether the newest
    // ROW happens to be active. The old form read one row by `created_at` desc
    // with no status filter, so a canceled row that sorted newer than a live
    // active one made the guard pass and Checkout minted a SECOND concurrently
    // billed subscription — the exact harm this file's header describes. Nothing
    // collapses the duplicate afterwards, and the rank-aware tier recompute keeps
    // `accounts.tier` looking correct, so it does not surface anywhere.
    const existingSubscription = await this.repo.findActiveSubscription(args.accountId);
    if (existingSubscription !== null) {
      throw new ConflictError(
        'Account already has an active subscription. Use the customer portal to change plans instead of starting a new checkout.',
        {
          resource: 'subscription',
          existing_tier: existingSubscription.tier,
          existing_status: existingSubscription.status,
        },
      );
    }

    const prices = this.config.tierPrices[args.tier];
    if (prices === undefined) {
      throw new BadRequestError(
        `Tier "${args.tier}" is not self-serve via Checkout. Contact sales for enterprise.`,
      );
    }
    const priceId = args.billingPeriod === 'monthly' ? prices.monthly : prices.annual;

    const customerId = await this.ensureCustomerId(account);

    return this.provider.createSubscriptionCheckout({
      accountId: account.id,
      customerId,
      priceId,
      successUrl: args.successUrl ?? this.config.defaultSuccessUrl,
      cancelUrl: args.cancelUrl ?? this.config.defaultCancelUrl,
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
    });
  }

  async createPortalSession(accountId: string): Promise<{ url: string }> {
    const account = await this.repo.getAccount(accountId);
    if (account === null) throw new NotFoundError('Account not found.');

    if (account.stripeCustomerId === null) {
      throw new ConflictError(
        'Account has no Stripe customer record yet. Complete a checkout flow first.',
        { resource: 'stripe_customer' },
      );
    }

    return this.provider.createPortalSession({
      customerId: account.stripeCustomerId,
      returnUrl: this.config.portalReturnUrl,
    });
  }

  async getBillingState(accountId: string): Promise<{
    subscription: SubscriptionMirror | null;
  }> {
    const account = await this.repo.getAccount(accountId);
    if (account === null) throw new NotFoundError('Account not found.');

    const subscription = await this.repo.findCurrentSubscription(accountId);
    return { subscription };
  }

  // ──────────────── helpers ────────────────

  private async ensureCustomerId(account: BillingAccountSnapshot): Promise<string> {
    if (account.stripeCustomerId !== null) return account.stripeCustomerId;
    const customerId = await this.provider.ensureCustomer({
      accountId: account.id,
      email: account.email,
      name: account.name,
    });
    await this.repo.setStripeCustomerId({ accountId: account.id, customerId });
    return customerId;
  }

  /**
   * V-758 — pause invoice collection for an account being suspended, honouring the AUP
   * §5.2 promise that "billing pauses". Returns which case applied so the caller can
   * report it: a free-tier or never-subscribed account has nothing to pause, and that is
   * a normal outcome, not a failure.
   *
   * V-767 — uses findCollectingSubscription. The original V-758 implementation used
   * findCurrentSubscription, and half of that reasoning was right: a `past_due` sub is exactly
   * the one you most want to stop dunning, and findActiveSubscription would have skipped it.
   * The other half was wrong. findCurrentSubscription applies NO status filter — it is the
   * dashboard's "your last subscription was canceled on X" helper — so it also returned
   * `canceled` / `unpaid` / `incomplete_expired` rows. Two consequences, both live:
   *
   *   1. Suspending an account whose only subscription is canceled called Stripe's pause on a
   *      canceled subscription, which errors, which raised `account_reclaim_failed` on every
   *      such suspension — training an operator to ignore the one alarm that matters.
   *   2. Worse, per the V-741 note on the repo: `created_at` is frozen at first-webhook
   *      insert, so a replayed event for an OLD canceled subscription can sort newer than a
   *      live one. The pause then hit the canceled row and the LIVE subscription kept billing
   *      a suspended customer — the exact AUP §5.2 promise this method exists to keep.
   *
   * Live-billing audit #4 — EVERY collecting subscription, not the newest. An account can
   * hold two (re-checkout is allowed while one is past_due), and a pause that reached only
   * the newest left the other one billing a suspended customer. Each is tried even when
   * another fails; any failure is thrown afterwards ({@link SubscriptionCollectionError}),
   * naming what was and was not paused.
   */
  async pauseCollectionForAccount(accountId: string): Promise<'paused' | 'no_subscription'> {
    const subs = await this.repo.findCollectingSubscriptions(accountId);
    if (subs.length === 0) return 'no_subscription';
    await this.applyToEach('pause', subs, (subscriptionId) =>
      this.provider.pauseSubscriptionCollection({ subscriptionId }),
    );
    return 'paused';
  }

  /** Inverse of {@link pauseCollectionForAccount}, for the unsuspend path. Idempotent. */
  async resumeCollectionForAccount(accountId: string): Promise<'resumed' | 'no_subscription'> {
    const subs = await this.repo.findCollectingSubscriptions(accountId);
    if (subs.length === 0) return 'no_subscription';
    await this.applyToEach('resume', subs, (subscriptionId) =>
      this.provider.resumeSubscriptionCollection({ subscriptionId }),
    );
    return 'resumed';
  }

  /**
   * Live-billing audit #1 — for an account being TERMINATED: cancel every subscription
   * still collecting, now (see {@link BillingProvider.cancelSubscriptionNow}). Owner
   * decision of 2026-09-24: a subscription that was not paid ({@link subscriptionWasNotPaid},
   * read from the provider just before its cancel) is cancelled WITHOUT proration and
   * without a final invoice, so no credit is given for a period nobody paid for; a paid
   * one is cancelled prorated, so its unused paid time is credited.
   *
   * When the provider cannot say (it has no reader, or the read fails), the stored
   * status decides; when it can say only in part (the latest invoice could not be
   * read), what it did read decides. Either way the id is reported in
   * `paymentStateUnread` so the termination can record it. A failed read never stops
   * the cancel: a subscription left charging a terminated customer is the worse outcome.
   *
   * Resolves with the Stripe subscription ids cancelled — empty when nothing was
   * collecting, which is a normal outcome — the subset cancelled without proration, and
   * the ids whose payment state could not be read. Throws {@link SubscriptionCollectionError}
   * when any was NOT cancelled, including when the provider cannot cancel at all: a
   * subscription left charging a terminated customer must never read as a clean
   * termination.
   */
  async cancelCollectionForAccount(accountId: string): Promise<{
    cancelled: string[];
    cancelledWithoutProration: string[];
    paymentStateUnread: string[];
  }> {
    const subs = await this.repo.findCollectingSubscriptions(accountId);
    if (subs.length === 0) {
      return { cancelled: [], cancelledWithoutProration: [], paymentStateUnread: [] };
    }
    const provider = this.provider;
    if (provider.cancelSubscriptionNow === undefined) {
      throw new SubscriptionCollectionError(
        'cancel',
        [],
        subs.map((s) => s.stripeSubscriptionId),
        'this billing provider cannot cancel a subscription, so the terminated account may still be charged',
      );
    }
    const unpaid = new Set<string>();
    const unread: string[] = [];
    let cancelled: string[];
    try {
      cancelled = await this.applyToEach('cancel', subs, async (subscriptionId, sub) => {
        const notPaid = await this.wasNotPaid(sub, unread);
        if (notPaid) unpaid.add(subscriptionId);
        await provider.cancelSubscriptionNow!({ subscriptionId, prorate: !notPaid });
      });
    } catch (err) {
      // Some were cancelled and some were not: say which of the cancelled ones were
      // given no credit, as the clean outcome below does.
      if (!(err instanceof SubscriptionCollectionError)) throw err;
      throw new SubscriptionCollectionError(err.action, err.done, err.failed, err.message, {
        cause: err.cause,
        doneWithoutProration: err.done.filter((id) => unpaid.has(id)),
        paymentStateUnread: unread,
      });
    }
    return {
      cancelled,
      cancelledWithoutProration: cancelled.filter((id) => unpaid.has(id)),
      paymentStateUnread: unread,
    };
  }

  /**
   * Owner decision of 2026-09-24 — whether `sub` was not paid, from what the provider
   * holds now, or from the stored status when the provider cannot say. A failed read,
   * or one that is `partlyUnread`, adds the id to `unread`.
   */
  private async wasNotPaid(sub: SubscriptionMirror, unread: string[]): Promise<boolean> {
    const read = this.provider.readSubscriptionPaymentState?.bind(this.provider);
    if (read === undefined) return subscriptionWasNotPaid({ status: sub.status });
    let reading: SubscriptionPaymentReading;
    try {
      reading = await read({ subscriptionId: sub.stripeSubscriptionId });
    } catch {
      unread.push(sub.stripeSubscriptionId);
      return subscriptionWasNotPaid({ status: sub.status });
    }
    if (reading.partlyUnread === true) unread.push(sub.stripeSubscriptionId);
    return subscriptionWasNotPaid(reading);
  }

  /**
   * Live-billing audit #6 — what the account is still paying for: Stripe subscriptions
   * still collecting and crypto terms that have not ended. An admin tier change is refused
   * while either is live, because the next Stripe event or crypto recompute would undo it.
   */
  async liveBillingForAccount(accountId: string): Promise<LiveBilling> {
    const [subs, cryptoTerms] = await Promise.all([
      this.repo.findCollectingSubscriptions(accountId),
      this.repo.findRunningCryptoTerms(accountId),
    ]);
    return {
      collectingSubscriptions: subs.map((s) => ({
        stripeSubscriptionId: s.stripeSubscriptionId,
        status: s.status,
        tier: s.tier,
      })),
      cryptoTerms,
    };
  }

  /** Apply one Stripe change to each subscription in turn; throw afterwards if any failed. */
  private async applyToEach(
    action: 'pause' | 'resume' | 'cancel',
    subs: readonly SubscriptionMirror[],
    apply: (subscriptionId: string, sub: SubscriptionMirror) => Promise<void>,
  ): Promise<string[]> {
    const done: string[] = [];
    const failed: string[] = [];
    let firstError: unknown = null;
    for (const sub of subs) {
      try {
        await apply(sub.stripeSubscriptionId, sub);
        done.push(sub.stripeSubscriptionId);
      } catch (err) {
        failed.push(sub.stripeSubscriptionId);
        firstError ??= err;
      }
    }
    if (failed.length > 0) {
      throw new SubscriptionCollectionError(
        action,
        done,
        failed,
        `could not ${action} ${String(failed.length)} of ${String(subs.length)} collecting subscription(s)`,
        { cause: firstError },
      );
    }
    return done;
  }
}
