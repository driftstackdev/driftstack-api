// Billing service (V-082).
//
// Two customer-facing operations:
//
//   1. Checkout-session — start a paid-tier subscription. Idempotent
//      from the customer's perspective: hitting create twice for the
//      same tier returns two valid Checkout URLs (Stripe handles the
//      "user already has a sub" path inside Checkout).
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
  }): Promise<{ url: string; sessionId: string }>;

  /** Open a Stripe Customer Portal session for the given customer. */
  createPortalSession(args: { customerId: string; returnUrl: string }): Promise<{ url: string }>;
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
   * Returns the active or most-recent subscription for the account, or
   * null if none. "Active" here is loose — caller filters by status if
   * needed.
   */
  findCurrentSubscription(accountId: string): Promise<SubscriptionMirror | null>;
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
  }): Promise<{ url: string; sessionId: string }> {
    const account = await this.repo.getAccount(args.accountId);
    if (account === null) throw new NotFoundError('Account not found.');

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
}
