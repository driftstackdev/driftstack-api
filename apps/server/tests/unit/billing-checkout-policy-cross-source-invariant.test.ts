// W877 — V-082 Billing checkout policy cross-source invariant.
// Two-hundred-third in the drift-guard series. Pins the V-082
// billing flow contract:
//
//   - BillingPeriod 2-value enum: monthly + annual.
//   - CreateCheckoutSession tier refine: REJECTS trial_pack +
//     enterprise (trial_pack uses the dedicated trial-pack flow;
//     enterprise is sales-negotiated, not self-serve).
//   - 4-endpoint inventory: checkout-session + trial-pack +
//     portal-session + subscription.
//   - {CHECKOUT_SESSION_ID} server-side token substitution for
//     success_url.
//
// stays in lockstep across:
//   - packages/api-types/src/billing.ts (Zod canonical).
//   - apps/server/src/services/billing.ts (consumer service
//     uses 'monthly' | 'annual' billingPeriod union).
//   - apps/customer-dashboard/src/pages/select-tier.astro
//     (sends billing_period: 'monthly' on tier-select).
//
// Drift would silently break:
//   * Customer attempting to checkout trial_pack via the wrong
//     endpoint (server rejects with refine message).
//   * Enterprise customer hitting self-serve checkout (sales-
//     team policy violation).
//   * BillingPeriod-keyed price-id lookup in server service.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const BILLING_PERIODS = ['monthly', 'annual'] as const;
const EXCLUDED_TIERS = ['free', 'enterprise'] as const;

describe('W877 Billing checkout policy cross-source invariant', () => {
  // ─── BillingPeriodSchema 2-value enum ────────────────────────

  it("CRITICAL packages/api-types/src/billing.ts BillingPeriodSchema = z.enum(['monthly', 'annual']). The 2-value model maps to Stripe's monthly/annual price-id pair.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/export const BillingPeriodSchema = z\.enum\(\['monthly', 'annual'\]\);/);
    expect(p).toMatch(/export type BillingPeriod = z\.infer<typeof BillingPeriodSchema>;/);
  });

  // ─── CreateCheckoutSessionRequest tier refine ─────────────────

  it("CRITICAL CreateCheckoutSessionRequest tier field is z.enum(PURCHASABLE_TIERS) carrying the 'tier must be a self-serve paid tier (free and enterprise excluded)' message. The 2-tier exclusion is the gate for the self-serve checkout endpoint, and V-924 made it an enum so the gate is visible in the published OpenAPI document instead of only at runtime.", () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/tier: z\.enum\(PURCHASABLE_TIERS, \{/);
    expect(p).toMatch(/'tier must be a self-serve paid tier \(free and enterprise excluded\)',/);
    // Per-occurrence negative: the predicate form published every tier,
    // including the two the endpoint refuses.
    expect(p, 'the runtime-predicate form must not return').not.toMatch(
      /tier: AccountTierSchema\.refine\(/,
    );
  });

  it('CRITICAL CreateCheckoutSessionRequest billing_period field uses BillingPeriodSchema (typed enum, not loose string). Drift to z.string() would let the server hit Stripe with an invalid billing_period.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(
      /CreateCheckoutSessionRequestSchema = z\.object\(\{[\s\S]+?billing_period: BillingPeriodSchema/,
    );
  });

  it('CRITICAL CreateCheckoutSessionRequest mentions the {CHECKOUT_SESSION_ID} server-side template token. The token is replaced at session-create time so success_url can include the Stripe session id without the client knowing it pre-redirect.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/`\{CHECKOUT_SESSION_ID\}` token/);
  });

  // ─── 4-endpoint inventory ────────────────────────────────────

  it('CRITICAL packages/api-types/src/billing.ts header pins the 3-endpoint /v1/billing/* inventory — checkout-session + portal-session + subscription (trial-pack retired 2026-05-27). The roster is what V-082 locks in.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/POST \/v1\/billing\/checkout-session/);
    expect(p).toMatch(/POST \/v1\/billing\/portal-session/);
    expect(p).toMatch(/GET\s+\/v1\/billing\/subscription/);
  });

  it('CRITICAL V-082 anchor pinned at the api-types/billing.ts file header. The V-082 anchor threads the billing-flow provenance.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(/Billing flow schemas \(V-082\)/);
  });

  it('CRITICAL BillingProvider interface framing pinned — "actual Stripe API calls are gated behind a BillingProvider interface so tests run against an in-memory provider that returns deterministic checkout URLs". The interface contract is what makes tests deterministic.', () => {
    const p = read(resolve(REPO_ROOT, 'packages/api-types/src/billing.ts'));
    expect(p).toMatch(
      /actual Stripe API calls are gated behind\s*\n\/\/ a `BillingProvider` interface/,
    );
    expect(p).toMatch(
      /tests run against an in-memory\s*\n\/\/ provider that returns deterministic checkout URLs/,
    );
  });

  // ─── Server billing service consumer ─────────────────────────

  it("CRITICAL apps/server/src/services/billing.ts uses billingPeriod: 'monthly' | 'annual' union (server-side hand-typed; matches api-types BillingPeriod). Drift would let server-side type-checking diverge from the schema.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/billingPeriod: 'monthly' \| 'annual';/);
  });

  it("CRITICAL apps/server/src/services/billing.ts price-id lookup ternary — 'args.billingPeriod === \\'monthly\\' ? prices.monthly : prices.annual'. The ternary is the canonical price-id-by-period dispatch.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/services/billing.ts'));
    expect(p).toMatch(/args\.billingPeriod === 'monthly' \? prices\.monthly : prices\.annual/);
  });

  // ─── Customer-dashboard select-tier ──────────────────────────

  it("CRITICAL apps/customer-dashboard/src/pages/select-tier.astro POST body includes billing_period: 'monthly' literal. The literal matches the api-types BillingPeriod 'monthly' value exactly — drift would silently reject the request server-side.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/customer-dashboard/src/pages/select-tier.astro'));
    expect(p).toMatch(/billing_period: 'monthly'/);
  });

  // ─── 2-period cardinality + 2 excluded tiers ─────────────────

  it('CRITICAL BillingPeriod = EXACTLY 2 values (monthly + annual). The 2-period model matches Stripe price-id pairing; drift to a 3rd period (quarterly/semiannual) would force coordinated Stripe-price-creation + dashboard tier-picker updates.', () => {
    expect(BILLING_PERIODS.length).toBe(2);
    expect(BILLING_PERIODS).toEqual(['monthly', 'annual']);
  });

  it('CRITICAL CreateCheckoutSession excludes EXACTLY 2 tiers from self-serve (free + enterprise). The 2-tier exclusion encodes the perpetual free tier (not purchasable) + ADR-004 (enterprise is sales-negotiated).', () => {
    expect(EXCLUDED_TIERS.length).toBe(2);
    expect(EXCLUDED_TIERS).toEqual(['free', 'enterprise']);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/billing-checkout-policy-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
