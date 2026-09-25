// Production BillingProvider implementation backed by the Stripe API
// (V-088). Implements the V-082 BillingProvider interface using the
// hand-rolled StripeApiClient (no `stripe` npm SDK dep).
//
// Customer lookup: we don't search Stripe for an existing customer by
// email. Instead, we always create a fresh Customer the first time
// `ensureCustomer` is called, then persist the Stripe customer id on
// `accounts.stripe_customer_id` (BillingService.ensureCustomerId path).
// Future calls find the persisted id and skip this provider entirely.
// This avoids a Stripe lookup-per-checkout and avoids the failure mode
// where two parallel ensureCustomer calls would race to create two
// customers.
//
// The FIRST-call window the persisted-id skip does NOT cover — two parallel
// ensureCustomer calls, or a retry after the Stripe create succeeded but the
// stripe_customer_id DB-write failed — is closed by a Stripe Idempotency-Key
// keyed by the account id (`stripe-customer-create:<accountId>`): Stripe
// returns the SAME Customer for a repeated key (~24h), so a race/retry can
// never mint a duplicate (orphaned) Stripe customer.

import { createHash } from 'node:crypto';
import type { BillingProvider } from './billing.js';
import type { SubscriptionPaymentReading } from './subscription-payment-state.js';
import type { StripeApiClient } from '../lib/stripe-api.js';

export class StripeBillingProvider implements BillingProvider {
  constructor(private readonly client: StripeApiClient) {}

  async ensureCustomer(args: {
    accountId: string;
    email: string;
    name: string | null;
  }): Promise<string> {
    const result = await this.client.createCustomer({
      email: args.email,
      name: args.name,
      metadata: { driftstack_account_id: args.accountId },
      // Idempotent per account: a retry or parallel call returns the same
      // Stripe Customer instead of minting a duplicate/orphan (see header).
      idempotencyKey: `stripe-customer-create:${args.accountId}`,
    });
    return result.id;
  }

  async createSubscriptionCheckout(args: {
    customerId: string;
    priceId: string;
    successUrl: string;
    cancelUrl: string;
    accountId: string;
    idempotencyKey?: string;
  }): Promise<{ url: string; sessionId: string }> {
    const result = await this.client.createSubscriptionCheckoutSession({
      customerId: args.customerId,
      priceId: args.priceId,
      successUrl: args.successUrl,
      cancelUrl: args.cancelUrl,
      clientReferenceId: args.accountId,
      metadata: { driftstack_account_id: args.accountId },
      // V-780 — scope the customer's key to the account before it reaches Stripe.
      //
      // Driftstack calls Stripe with ONE platform secret key and no Stripe-Account header, so
      // every idempotency key lands in a single global namespace. Forwarding the customer's key
      // raw means Stripe binds it to that request's exact parameters: the same customer reusing
      // the key after changing tier or success_url gets `idempotency_error` (400), and two
      // accounts that happen to pick the same string collide. It fails CLOSED — Stripe refuses
      // rather than replaying another account's session, so there is no cross-tenant leak — but
      // it hard-blocks the paid-signup path for ~24h until the key ages out.
      //
      // Its sibling above already does this (`stripe-customer-create:${accountId}`); this call
      // was the one that did not.
      //
      // The customer part is HASHED rather than concatenated: both this API and Stripe cap keys
      // at 255 chars, so prefixing a maximum-length key would push it over and start failing for
      // a new reason. sha256 keeps it deterministic — the same key from the same account still
      // replays, which is the property the customer is promised.
      ...(args.idempotencyKey !== undefined
        ? {
            idempotencyKey: `checkout:${args.accountId}:${createHash('sha256')
              .update(args.idempotencyKey)
              .digest('hex')
              .slice(0, 32)}`,
          }
        : {}),
    });
    return { url: result.url, sessionId: result.id };
  }

  async createPortalSession(args: {
    customerId: string;
    returnUrl: string;
  }): Promise<{ url: string }> {
    const result = await this.client.createBillingPortalSession({
      customerId: args.customerId,
      returnUrl: args.returnUrl,
    });
    return { url: result.url };
  }

  async pauseSubscriptionCollection(args: { subscriptionId: string }): Promise<void> {
    await this.client.setSubscriptionPauseCollection({
      subscriptionId: args.subscriptionId,
      pause: true,
    });
  }

  async resumeSubscriptionCollection(args: { subscriptionId: string }): Promise<void> {
    await this.client.setSubscriptionPauseCollection({
      subscriptionId: args.subscriptionId,
      pause: false,
    });
  }

  /**
   * Cancel now (see StripeApiClient.cancelSubscription): prorated unless
   * `prorate: false` — the caller says so for a subscription that was not paid
   * (subscription-payment-state.ts): a replaced one (security sweep #11) and,
   * on account termination, any one (owner decision of 2026-09-24).
   */
  async cancelSubscriptionNow(args: { subscriptionId: string; prorate?: boolean }): Promise<void> {
    await this.client.cancelSubscription({
      subscriptionId: args.subscriptionId,
      ...(args.prorate !== undefined ? { prorate: args.prorate } : {}),
    });
  }

  /**
   * Owner decision of 2026-09-24 — the subscription's status, its `pause_collection`
   * behavior and its latest invoice's status, as Stripe holds them now. The latest
   * invoice is read by its id (the subscription carries only the id unless expanded).
   * Throws when the subscription cannot be read or has no status; the caller then
   * decides from the stored status. When only the latest invoice cannot be read, what
   * was read is kept: its status is null and the reading is `partlyUnread`.
   */
  async readSubscriptionPaymentState(args: {
    subscriptionId: string;
  }): Promise<SubscriptionPaymentReading> {
    const sub = await this.client.getSubscription(args.subscriptionId);
    if (typeof sub.status !== 'string') {
      throw new Error('Stripe returned a subscription with no status');
    }
    const pause = sub.pause_collection;
    const behavior =
      pause !== null && typeof pause === 'object'
        ? (pause as { behavior?: unknown }).behavior
        : null;
    const latest = sub.latest_invoice;
    let latestInvoiceStatus: unknown = null;
    let partlyUnread = false;
    if (typeof latest === 'string' && latest.length > 0) {
      try {
        latestInvoiceStatus = (await this.client.getInvoice(latest)).status;
      } catch {
        partlyUnread = true;
      }
    } else if (latest !== null && typeof latest === 'object') {
      latestInvoiceStatus = (latest as { status?: unknown }).status;
    }
    return {
      status: sub.status,
      pauseCollectionBehavior: typeof behavior === 'string' ? behavior : null,
      latestInvoiceStatus: typeof latestInvoiceStatus === 'string' ? latestInvoiceStatus : null,
      ...(partlyUnread ? { partlyUnread: true } : {}),
    };
  }
}
