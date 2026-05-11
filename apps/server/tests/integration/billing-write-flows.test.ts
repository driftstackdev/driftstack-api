// V-540.B-14 — integration tests for multi-step billing write flows.
//
// V-540.B-13 (W43) covered the validation gate at the route layer
// against the Playwright e2e harness. V-540.B-13's matching unit
// coverage covered the single-call happy paths. This file extends
// the integration suite (vitest + in-memory Stripe provider) with
// the multi-step write flows that exercise the customer-reuse +
// upgrade + concurrent-purchase semantics.
//
// The full real-Stripe-test-mode e2e harness lands when V-540.B-15
// wires the BillingService into the Playwright helper; the
// scenarios here are the contract that the e2e harness must keep
// satisfied.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

interface CheckoutResponse {
  checkout_url: string;
  checkout_session_id: string;
}

describe('V-540.B-14 multi-step checkout flows', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('two checkouts for the same account reuse the same Stripe customer', async () => {
    fx = await buildTestApp();
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_starter', billing_period: 'monthly' },
    });
    expect(first.statusCode).toBe(200);
    const customerId1 = fx.billingProvider.state.checkoutSessions[0]?.customerId;
    expect(customerId1).toBeDefined();

    // Same account starts a second checkout (e.g. switching tiers).
    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_builder', billing_period: 'annual' },
    });
    expect(second.statusCode).toBe(200);
    const customerId2 = fx.billingProvider.state.checkoutSessions[1]?.customerId;
    expect(customerId2).toBe(customerId1);
    expect(fx.billingProvider.state.customers.size).toBe(1);
  });

  it('annual checkout uses the annual price for that tier', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_scale', billing_period: 'annual' },
    });
    expect(res.statusCode).toBe(200);
    expect(fx.billingProvider.state.checkoutSessions[0]?.priceId).toBe('price_api_scale_annual');
  });

  it('trial-pack then subscription checkout — both succeed; same customer', async () => {
    fx = await buildTestApp();
    const t = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/trial-pack',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(t.statusCode).toBe(200);

    const s = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_starter', billing_period: 'monthly' },
    });
    expect(s.statusCode).toBe(200);

    const customers = [...fx.billingProvider.state.customers.values()];
    expect(customers).toHaveLength(1);
    const sessions = fx.billingProvider.state.checkoutSessions;
    expect(sessions).toHaveLength(2);
    expect(sessions[0]?.kind).toBe('trial_pack');
    expect(sessions[1]?.kind).toBe('subscription');
  });

  it('portal-session reuses the customer from prior checkout (idempotent)', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_starter', billing_period: 'monthly' },
    });
    const p1 = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/portal-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(p1.statusCode).toBe(200);
    const p2 = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/portal-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(p2.statusCode).toBe(200);
    expect(fx.billingProvider.state.portalSessions).toHaveLength(2);
    // Both portal sessions point at the SAME Stripe customer.
    const customerIds = new Set(fx.billingProvider.state.portalSessions.map((s) => s.customerId));
    expect(customerIds.size).toBe(1);
  });

  it('returns 400 on an unrecognised tier; provider state unchanged', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'enterprise_legacy_v0', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(400);
    expect(fx.billingProvider.state.checkoutSessions).toHaveLength(0);
    expect(fx.billingProvider.state.customers.size).toBe(0);
  });

  it('trial-pack 409 after purchase — second call leaves state unchanged', async () => {
    fx = await buildTestApp();
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/trial-pack',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(first.statusCode).toBe(200);
    // Apply the purchase server-side (simulates webhook landing).
    fx.billingRepo.applyTrialPackPurchase(fx.accountId, {
      creditCents: 299,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/trial-pack',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(second.statusCode).toBe(409);
    expect(second.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Conflict);
    // The 409 path must NOT create another Stripe checkout session.
    expect(fx.billingProvider.state.checkoutSessions).toHaveLength(1);
  });
});

describe('V-540.B-14 checkout response shape', () => {
  let fx: TestAppFixture;
  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('returns checkout_url + checkout_session_id together', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_builder', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CheckoutResponse>();
    expect(typeof body.checkout_url).toBe('string');
    expect(typeof body.checkout_session_id).toBe('string');
    expect(body.checkout_session_id).toMatch(/^cs_test_/);
  });
});
