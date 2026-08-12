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
   * Uses findCurrentSubscription (not findActiveSubscription) on purpose: a `past_due`
   * sub is exactly the one you most want to stop dunning while the account is suspended.
   */
  async pauseCollectionForAccount(accountId: string): Promise<'paused' | 'no_subscription'> {
    const sub = await this.repo.findCurrentSubscription(accountId);
    if (sub === null) return 'no_subscription';
    await this.provider.pauseSubscriptionCollection({ subscriptionId: sub.stripeSubscriptionId });
    return 'paused';
  }

  /** Inverse of {@link pauseCollectionForAccount}, for the unsuspend path. Idempotent. */
  async resumeCollectionForAccount(accountId: string): Promise<'resumed' | 'no_subscription'> {
    const sub = await this.repo.findCurrentSubscription(accountId);
    if (sub === null) return 'no_subscription';
    await this.provider.resumeSubscriptionCollection({ subscriptionId: sub.stripeSubscriptionId });
    return 'resumed';
  }
}
