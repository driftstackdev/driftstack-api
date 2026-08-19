// W433.C — drift guard for packages/api-types/src/billing.ts.
// V-082 billing-flow public contract: Stripe checkout/portal/
// subscription-read + ADR-003 trial-pack. Drift here either breaks
// the BillingProvider seam (in-memory deterministic test provider
// stops matching the schema) or widens CreateCheckoutSession's
// tier accept-set to trial_pack/enterprise (one is a one-time, one
// is enterprise-negotiated — neither belongs on self-serve checkout).
//
//   • V-082 framing pinned + 4 endpoints listed (POST checkout-
//     session + POST trial-pack + POST portal-session + GET
//     subscription).
//   • Scaffolding seam pinned: BillingProvider interface gates
//     real Stripe; tests use in-memory deterministic provider.
//   • BillingPeriod enum: monthly | annual.
//   • CreateCheckoutSession tier refine: rejects trial_pack +
//     enterprise (self-serve paid tier only).
//   • Trial-pack rationale pinned: ADR-003 one-time $2.99 +
//     14d expiry + 299c credit + webhook-driven provisioning.
//   • SubscriptionStatus enum: 8 Stripe-mirror values
//     (incomplete/incomplete_expired/trialing/active/past_due/
//     canceled/unpaid/paused).
//   • TrialPackState: active boolean + credit_cents_remaining
//     nullable int + expires_at nullable + redeemed.
//   • GetBillingStateResponse: subscription nullable + trial_pack.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/billing.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W433.C packages/api-types/src/billing.ts content parity', () => {
  const body = read(LIB);

  it('V-082 framing pinned + 3 endpoints listed (POST checkout-session/portal-session + GET subscription) + trial_pack retirement note', () => {
    expect(body).toMatch(/\/\/ Billing flow schemas \(V-082\)\./);
    expect(body).toMatch(
      /\/\/ Endpoints exposed under \/v1\/billing\/\*:\s*\n?\s*\/\/\s*- POST \/v1\/billing\/checkout-session\s+\(start a paid-tier subscription\)\s*\n?\s*\/\/\s*- POST \/v1\/billing\/portal-session\s+\(open Stripe Customer Portal\)\s*\n?\s*\/\/\s*- GET\s+\/v1\/billing\/subscription\s+\(current subscription state\)/,
    );
    expect(body).toMatch(/The one-time \$2\.99 trial_pack was retired 2026-05-27 in favour of a/);
  });

  it('BillingProvider seam rationale pinned: scaffolding-time Stripe calls gated behind interface; in-memory deterministic test provider returns checkout URLs / customer IDs', () => {
    expect(body).toMatch(
      /\/\/ At scaffolding time, the actual Stripe API calls are gated behind\s*\n?\s*\/\/ a `BillingProvider` interface so tests run against an in-memory\s*\n?\s*\/\/ provider that returns deterministic checkout URLs \/ customer IDs\./,
    );
  });

  it("imports: z + AccountTierSchema + Iso8601Schema + PURCHASABLE_TIERS from './common.js' (V-924 — the shared purchasable-tier tuple backs the checkout enum)", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{ AccountTierSchema, Iso8601Schema, PURCHASABLE_TIERS \} from '\.\/common\.js';/,
    );
  });

  it("BillingPeriod enum: 'monthly' | 'annual'", () => {
    expect(body).toMatch(/export const BillingPeriodSchema = z\.enum\(\['monthly', 'annual'\]\);/);
    expect(body).toMatch(/export type BillingPeriod = z\.infer<typeof BillingPeriodSchema>;/);
  });

  it('CreateCheckoutSessionRequest: tier is the PURCHASABLE_TIERS enum, which REJECTS free + enterprise (self-serve paid tier only) — V-924: an enum rather than a refine, so the exclusion survives into the published OpenAPI document; billing_period + optional success/cancel URLs with {CHECKOUT_SESSION_ID} server-side substitution comment', () => {
    expect(body).toMatch(
      /\* Target tier\. Must be a self-serve paid tier \(not 'free' or 'enterprise'\)\./,
    );
    expect(body).toMatch(
      /tier: z\.enum\(PURCHASABLE_TIERS, \{\s*\n?\s*message: 'tier must be a self-serve paid tier \(free and enterprise excluded\)',\s*\n?\s*\}\),/,
    );
    // Per-occurrence negative. A refine is a runtime predicate that JSON Schema
    // cannot represent, so the generated spec published all eight tiers and
    // advertised two that the route answers with 400.
    expect(body, 'the refine form must not return').not.toMatch(
      /tier: AccountTierSchema\.refine\(/,
    );
    expect(body).toMatch(/billing_period: BillingPeriodSchema,/);
    expect(body).toMatch(
      /\*\s*Where Stripe redirects on success\. The `\{CHECKOUT_SESSION_ID\}` token\s*\n?\s*\*\s*is replaced server-side\. Defaults to the configured success URL when\s*\n?\s*\*\s*omitted\./,
    );
    expect(body).toMatch(/success_url: z\.string\(\)\.url\(\)\.optional\(\),/);
    expect(body).toMatch(/cancel_url: z\.string\(\)\.url\(\)\.optional\(\),/);
  });

  it('CreateCheckoutSessionResponse: checkout_url + checkout_session_id (echoed for client-side correlation)', () => {
    expect(body).toMatch(
      /export const CreateCheckoutSessionResponseSchema = z\.object\(\{\s*\n?\s*checkout_url: z\.string\(\)\.url\(\),\s*\n?\s*\/\*\* Stripe checkout session id\. Echoed for client-side correlation\. \*\/\s*\n?\s*checkout_session_id: z\.string\(\),\s*\n?\s*\}\);/,
    );
  });

  it('CreatePortalSessionResponse: portal_url only', () => {
    expect(body).toMatch(
      /export const CreatePortalSessionResponseSchema = z\.object\(\{\s*\n?\s*portal_url: z\.string\(\)\.url\(\),\s*\n?\s*\}\);/,
    );
  });

  it('SubscriptionStatus enum: 8 Stripe-mirror values (incomplete/incomplete_expired/trialing/active/past_due/canceled/unpaid/paused)', () => {
    expect(body).toMatch(
      /export const SubscriptionStatusSchema = z\.enum\(\[\s*\n?\s*'incomplete',\s*\n?\s*'incomplete_expired',\s*\n?\s*'trialing',\s*\n?\s*'active',\s*\n?\s*'past_due',\s*\n?\s*'canceled',\s*\n?\s*'unpaid',\s*\n?\s*'paused',\s*\n?\s*\]\);/,
    );
  });

  it('Subscription shape: tier + status + stripe_subscription_id + nullable current_period_end + cancel_at_period_end + nullable canceled_at + created_at + updated_at', () => {
    expect(body).toMatch(
      /export const SubscriptionSchema = z\.object\(\{\s*\n?\s*tier: AccountTierSchema,\s*\n?\s*status: SubscriptionStatusSchema,\s*\n?\s*stripe_subscription_id: z\.string\(\),\s*\n?\s*current_period_end: Iso8601Schema\.nullable\(\),\s*\n?\s*cancel_at_period_end: z\.boolean\(\),\s*\n?\s*canceled_at: Iso8601Schema\.nullable\(\),\s*\n?\s*created_at: Iso8601Schema,\s*\n?\s*updated_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
  });

  it('GetBillingStateResponse: subscription nullable only (trial_pack state removed)', () => {
    expect(body).toMatch(
      /export const GetBillingStateResponseSchema = z\.object\(\{\s*\n?\s*subscription: SubscriptionSchema\.nullable\(\),\s*\n?\s*\}\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
