// W410.B — drift guard for apps/server/src/services/stripe-billing-provider.ts.
// V-088 production BillingProvider backed by hand-rolled StripeApiClient
// (no `stripe` npm SDK dep). Implements V-082 BillingProvider interface.
// Drift here either creates duplicate Stripe customers (race) or breaks
// V-666 trial-pack purchase-kind metadata (lifecycle dispatcher can't
// route the webhook).
//
//   • V-088 framing pinned: implements V-082 BillingProvider via
//     hand-rolled client (no `stripe` npm SDK dep).
//   • Customer-lookup posture pinned: never search Stripe by email;
//     always create fresh Customer + persist stripe_customer_id on
//     accounts row (BillingService.ensureCustomerId path).
//   • Race-avoidance rationale pinned: parallel ensureCustomer calls
//     would otherwise race to create two customers.
//   • ensureCustomer: creates with email + name + metadata
//     {driftstack_account_id}; returns Stripe customer id.
//   • createSubscriptionCheckout: clientReferenceId=accountId + metadata
//     {driftstack_account_id}; returns { url, sessionId }.
//   • createTrialPackCheckout: createOneTimeCheckoutSession +
//     metadata {driftstack_account_id, driftstack_purchase_kind:
//     'trial_pack'} — purchase-kind discriminator for V-202b
//     lifecycle dispatcher.
//   • createPortalSession: { customerId, returnUrl } → { url }.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W410.B apps/server/src/services/stripe-billing-provider.ts content parity', () => {
  const body = read(LIB);

  it('V-088 framing pinned: implements V-082 BillingProvider via hand-rolled StripeApiClient (no `stripe` npm SDK dep)', () => {
    expect(body).toMatch(
      /Production BillingProvider implementation backed by the Stripe API\s*\n?\s*\/\/\s*\(V-088\)\. Implements the V-082 BillingProvider interface using the\s*\n?\s*\/\/\s*hand-rolled StripeApiClient \(no `stripe` npm SDK dep\)\./,
    );
  });

  it('Customer-lookup posture pinned: never search Stripe by email; always create fresh + persist on accounts.stripe_customer_id', () => {
    expect(body).toMatch(
      /Customer lookup: we don't search Stripe for an existing customer by\s*\n?\s*\/\/\s*email\. Instead, we always create a fresh Customer the first time\s*\n?\s*\/\/\s*`ensureCustomer` is called, then persist the Stripe customer id on\s*\n?\s*\/\/\s*`accounts\.stripe_customer_id` \(BillingService\.ensureCustomerId path\)\./,
    );
  });

  it('Race-avoidance rationale pinned: skips lookup-per-checkout + avoids parallel-create race', () => {
    expect(body).toMatch(
      /Future calls find the persisted id and skip this provider entirely\.\s*\n?\s*\/\/\s*This avoids a Stripe lookup-per-checkout and avoids the failure mode\s*\n?\s*\/\/\s*where two parallel ensureCustomer calls would race to create two\s*\n?\s*\/\/\s*customers\./,
    );
  });

  it('Idempotency-Key rationale pinned: the first-call window the persisted-id skip does NOT cover is closed by a per-account Stripe Idempotency-Key', () => {
    expect(body).toMatch(/closed by a Stripe Idempotency-Key/);
    expect(body).toMatch(/keyed by the account id \(`stripe-customer-create:<accountId>`\)/);
    expect(body).toMatch(/never mint a duplicate \(orphaned\) Stripe customer\./);
  });

  it('class StripeBillingProvider implements BillingProvider; client injected', () => {
    expect(body).toMatch(
      /export class StripeBillingProvider implements BillingProvider \{\s*\n?\s*constructor\(private readonly client: StripeApiClient\) \{\}/,
    );
  });

  it('ensureCustomer: email + name + metadata{driftstack_account_id} + per-account idempotencyKey; returns result.id', () => {
    // Discrete pins — the added idempotencyKey + its comment broke the single
    // mega-regex (see feedback_no_long_chain_parity_regex).
    expect(body).toMatch(/async ensureCustomer\(args: \{/);
    expect(body).toMatch(/const result = await this\.client\.createCustomer\(\{/);
    expect(body).toMatch(/email: args\.email,/);
    expect(body).toMatch(/name: args\.name,/);
    expect(body).toMatch(/metadata: \{ driftstack_account_id: args\.accountId \},/);
    expect(body).toMatch(/idempotencyKey: `stripe-customer-create:\$\{args\.accountId\}`,/);
    expect(body).toMatch(/return result\.id;/);
  });

  it('createSubscriptionCheckout: clientReferenceId=accountId + metadata{driftstack_account_id}; returns { url, sessionId }', () => {
    expect(body).toMatch(/async createSubscriptionCheckout\(args: \{/);
    expect(body).toMatch(/idempotencyKey\?: string;/);
    expect(body).toMatch(
      /const result = await this\.client\.createSubscriptionCheckoutSession\(\{/,
    );
    expect(body).toMatch(/clientReferenceId: args\.accountId,/);
    expect(body).toMatch(/metadata: \{ driftstack_account_id: args\.accountId \},/);
    expect(body).toMatch(/\{ idempotencyKey: args\.idempotencyKey \}/);
    expect(body).toMatch(/return \{ url: result\.url, sessionId: result\.id \};/);
  });

  it('createTrialPackCheckout fully removed 2026-05-27 (trial_pack retirement)', () => {
    expect(body).not.toMatch(/createTrialPackCheckout/);
    expect(body).not.toMatch(/trial_pack/);
  });

  it('createPortalSession: { customerId, returnUrl } → { url }', () => {
    expect(body).toMatch(
      /async createPortalSession\(args: \{\s*\n?\s*customerId: string;\s*\n?\s*returnUrl: string;\s*\n?\s*\}\): Promise<\{ url: string \}> \{\s*\n?\s*const result = await this\.client\.createBillingPortalSession\(\{\s*\n?\s*customerId: args\.customerId,\s*\n?\s*returnUrl: args\.returnUrl,\s*\n?\s*\}\);\s*\n?\s*return \{ url: result\.url \};/,
    );
  });

  it('imports: BillingProvider from ./billing + StripeApiClient from ../lib/stripe-api (no `stripe` npm SDK import)', () => {
    expect(body).toMatch(/import type \{ BillingProvider \} from '\.\/billing\.js';/);
    expect(body).toMatch(/import type \{ StripeApiClient \} from '\.\.\/lib\/stripe-api\.js';/);
    expect(body).not.toMatch(/^import .* from 'stripe'/m);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
