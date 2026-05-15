// W943 — V-088 StripeBillingProvider cross-source invariant. Two-
// hundred-sixty-ninth in the drift-guard series. Pins the production
// BillingProvider implementation:
//
//   V-088 anchor — 'Production BillingProvider implementation backed
//   by the Stripe API (V-088). Implements the V-082 BillingProvider
//   interface using the hand-rolled StripeApiClient (no stripe npm
//   SDK dep)'.
//
//   No-search-by-email customer-lookup rationale:
//     - 'we don't search Stripe for an existing customer by email.
//       Instead, we always create a fresh Customer the first time
//       ensureCustomer is called, then persist the Stripe customer
//       id on accounts.stripe_customer_id'.
//     - 'Future calls find the persisted id and skip this provider
//       entirely. This avoids a Stripe lookup-per-checkout and avoids
//       the failure mode where two parallel ensureCustomer calls
//       would race to create two customers'.
//
//   StripeBillingProvider implements BillingProvider — 4 methods:
//     - ensureCustomer → client.createCustomer.
//     - createSubscriptionCheckout → client.createSubscriptionCheckout
//       Session.
//     - createTrialPackCheckout → client.createOneTimeCheckoutSession.
//     - createPortalSession → client.createBillingPortalSession.
//
//   driftstack_account_id metadata propagation on all 3
//     customer/session create paths — gives Stripe webhooks a
//     stable account-id back-pointer.
//
//   Trial-pack purchase carries 2 metadata keys —
//     driftstack_account_id + driftstack_purchase_kind: 'trial_pack'.
//
//   clientReferenceId set to accountId on both checkout sessions —
//     Stripe-native cross-reference in addition to metadata.
//
// stays in lockstep across
// apps/server/src/services/stripe-billing-provider.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W943 V-088 StripeBillingProvider cross-source invariant', () => {
  // ─── V-088 anchor + V-082 implementation framing ─────────────

  it("CRITICAL apps/server/src/services/stripe-billing-provider.ts header pins V-088 anchor — 'Production BillingProvider implementation backed by the Stripe API (V-088). Implements the V-082 BillingProvider interface using the hand-rolled StripeApiClient (no stripe npm SDK dep)'. The V-088 + V-082 + no-SDK chain is the architecture provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(/Production BillingProvider implementation backed by the Stripe API/);
    expect(p).toMatch(/\(V-088\)\. Implements the V-082 BillingProvider interface using the/);
    expect(p).toMatch(/hand-rolled StripeApiClient \(no `stripe` npm SDK dep\)/);
  });

  // ─── No-search-by-email customer-lookup rationale ────────────

  it("CRITICAL no-search-by-email framing — 'we don't search Stripe for an existing customer by email. Instead, we always create a fresh Customer the first time ensureCustomer is called, then persist the Stripe customer id on accounts.stripe_customer_id (BillingService.ensureCustomerId path). Future calls find the persisted id and skip this provider entirely. This avoids a Stripe lookup-per-checkout and avoids the failure mode where two parallel ensureCustomer calls would race to create two customers'. The persisted-id-skips-provider design avoids both latency + race conditions.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(/Customer lookup: we don't search Stripe for an existing customer by/);
    expect(p).toMatch(/email\. Instead, we always create a fresh Customer the first time/);
    expect(p).toMatch(/`ensureCustomer` is called, then persist the Stripe customer id on/);
    expect(p).toMatch(/`accounts\.stripe_customer_id` \(BillingService\.ensureCustomerId path\)\./);
    expect(p).toMatch(/Future calls find the persisted id and skip this provider entirely\./);
    expect(p).toMatch(/This avoids a Stripe lookup-per-checkout and avoids the failure mode/);
    expect(p).toMatch(/where two parallel ensureCustomer calls would race to create two/);
    expect(p).toMatch(/customers\./);
  });

  // ─── implements BillingProvider + 4 methods ──────────────────

  it('CRITICAL StripeBillingProvider implements BillingProvider — declares 4 methods matching the V-082 interface: ensureCustomer + createSubscriptionCheckout + createTrialPackCheckout + createPortalSession. The 4-method 1:1 mapping is the V-088/V-082 contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(/export class StripeBillingProvider implements BillingProvider \{/);
    expect(p).toMatch(/async ensureCustomer\(args: \{/);
    expect(p).toMatch(/async createSubscriptionCheckout\(args: \{/);
    expect(p).toMatch(/async createTrialPackCheckout\(args: \{/);
    expect(p).toMatch(/async createPortalSession\(args: \{/);
  });

  // ─── Method-to-StripeApiClient delegation map ────────────────

  it('CRITICAL method-to-client delegation — ensureCustomer → this.client.createCustomer + createSubscriptionCheckout → this.client.createSubscriptionCheckoutSession + createTrialPackCheckout → this.client.createOneTimeCheckoutSession + createPortalSession → this.client.createBillingPortalSession. The 4-method 1:1 delegation keeps the provider thin.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(/await this\.client\.createCustomer\(/);
    expect(p).toMatch(/await this\.client\.createSubscriptionCheckoutSession\(/);
    expect(p).toMatch(/await this\.client\.createOneTimeCheckoutSession\(/);
    expect(p).toMatch(/await this\.client\.createBillingPortalSession\(/);
  });

  // ─── driftstack_account_id metadata propagation ──────────────

  it("CRITICAL driftstack_account_id metadata propagation — every customer / session create path attaches 'metadata: { driftstack_account_id: args.accountId, ... }'. The metadata gives Stripe webhooks a stable account-id back-pointer.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    // 3 places: ensureCustomer + createSubscriptionCheckout + createTrialPackCheckout.
    const matches = p.match(/driftstack_account_id: args\.accountId/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(3);
  });

  // ─── Trial-pack 2-key metadata ───────────────────────────────

  it("CRITICAL trial-pack metadata has 2 keys — driftstack_account_id + driftstack_purchase_kind: 'trial_pack'. The 2-key metadata is what lets Stripe webhooks distinguish trial-pack one-time purchases from subscription Checkouts.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(
      /driftstack_account_id: args\.accountId,\s*\n\s+driftstack_purchase_kind: 'trial_pack',/,
    );
  });

  it('CRITICAL trial-pack uses createOneTimeCheckoutSession — NOT createSubscriptionCheckoutSession. The one-time-vs-subscription split matches the ADR-003 trial-pack-is-not-a-sub design.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(
      /async createTrialPackCheckout\(args: \{[\s\S]+?await this\.client\.createOneTimeCheckoutSession\(\{/,
    );
  });

  // ─── clientReferenceId set on both checkouts ─────────────────

  it('CRITICAL both checkouts set clientReferenceId: args.accountId — Stripe-native cross-reference in addition to metadata. The 2-field cross-reference (clientReferenceId + metadata.driftstack_account_id) gives webhooks 2 ways to back-resolve the account.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    // 2 places: createSubscriptionCheckout + createTrialPackCheckout.
    const matches = p.match(/clientReferenceId: args\.accountId,/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  // ─── ensureCustomer arg shape ────────────────────────────────

  it('CRITICAL ensureCustomer takes 3 args — accountId + email + name (nullable). The 3-field args are exactly what V-082 BillingProvider.ensureCustomer declares; drift would break interface conformance.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(
      /async ensureCustomer\(args: \{\s*\n\s*accountId: string;\s*\n\s*email: string;\s*\n\s*name: string \| null;\s*\n\s*\}\): Promise<string>/,
    );
  });

  // ─── ensureCustomer return is Stripe customer id ─────────────

  it('CRITICAL ensureCustomer returns result.id from createCustomer (Stripe cus_ id). The id-return matches BillingProvider.ensureCustomer Promise<string> contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(
      /const result = await this\.client\.createCustomer\([\s\S]+?return result\.id;/,
    );
  });

  // ─── Checkout return shape — { url, sessionId } ──────────────

  it('CRITICAL checkout methods return { url: result.url, sessionId: result.id }. The 2-field return shape matches BillingProvider.createSubscriptionCheckout + createTrialPackCheckout return contracts; drift would break route-layer redirect handling.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    // 2 places: createSubscriptionCheckout + createTrialPackCheckout.
    const matches = p.match(/return \{ url: result\.url, sessionId: result\.id \};/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  // ─── createPortalSession returns single-field { url } ────────

  it('CRITICAL createPortalSession returns { url: result.url } — single-field (no sessionId; portal is one-shot redirect). The 1-field return matches BillingProvider.createPortalSession Promise<{ url }> contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(/return \{ url: result\.url \};/);
  });

  // ─── 5-field createSubscriptionCheckout args ─────────────────

  it('CRITICAL createSubscriptionCheckout takes 5 args — customerId + priceId + successUrl + cancelUrl + accountId. The 5-arg shape matches V-082 BillingProvider interface; drift would break interface conformance.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(
      /async createSubscriptionCheckout\(args: \{\s*\n\s*customerId: string;\s*\n\s*priceId: string;\s*\n\s*successUrl: string;\s*\n\s*cancelUrl: string;\s*\n\s*accountId: string;\s*\n\s*\}\)/,
    );
  });

  // ─── StripeApiClient type import (no SDK dep) ────────────────

  it("CRITICAL imports StripeApiClient type from lib/stripe-api — no 'stripe' npm package dependency. The lib-only import enforces the V-088 hand-rolled-SDK decision.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(/import type \{ StripeApiClient \} from '\.\.\/lib\/stripe-api\.js';/);
    // No raw 'stripe' or '@stripe' npm import.
    expect(p).not.toMatch(/from 'stripe'/);
    expect(p).not.toMatch(/from '@stripe\//);
  });

  it('CRITICAL imports BillingProvider type from billing.ts — type-only import keeps the runtime free of cyclic dependency on the service that owns the interface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/stripe-billing-provider.ts'));
    expect(p).toMatch(/import type \{ BillingProvider \} from '\.\/billing\.js';/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/stripe-billing-provider-v088-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
