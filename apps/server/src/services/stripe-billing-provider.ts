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

import type { BillingProvider } from './billing.js';
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
      ...(args.idempotencyKey !== undefined ? { idempotencyKey: args.idempotencyKey } : {}),
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
}
