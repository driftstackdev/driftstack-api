// Integration tests for V-082 billing flow surface (/v1/billing/*).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { seedActiveSubscription } from './_helpers/scenarios.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

interface CheckoutResponse {
  checkout_url: string;
  checkout_session_id: string;
}

interface BillingState {
  subscription: {
    tier: string;
    status: string;
    stripe_subscription_id: string;
  } | null;
  trial_pack: {
    active: boolean;
    credit_cents_remaining: number | null;
    expires_at: string | null;
    redeemed: boolean;
  };
}

describe('POST /v1/billing/checkout-session', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 returns a Checkout URL for a paid tier', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_builder', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<CheckoutResponse>();
    expect(body.checkout_url).toMatch(/^https:\/\/checkout.stripe.example\//);
    expect(body.checkout_session_id).toMatch(/^cs_test_/);

    // Provider state recorded the checkout session.
    expect(fx.billingProvider.state.checkoutSessions).toHaveLength(1);
    expect(fx.billingProvider.state.checkoutSessions[0]?.kind).toBe('subscription');
    expect(fx.billingProvider.state.checkoutSessions[0]?.priceId).toBe('price_api_builder_monthly');
  });

  it('400 ValidationFailed for tier=trial_pack', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'trial_pack', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.ValidationFailed);
  });

  it('400 ValidationFailed for tier=enterprise', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'enterprise', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('reuses the same Stripe customer across two checkouts', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_starter', billing_period: 'monthly' },
    });
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_builder', billing_period: 'annual' },
    });
    expect(fx.billingProvider.state.customers.size).toBe(1);
    expect(fx.billingProvider.state.checkoutSessions).toHaveLength(2);
  });

  // V-248 / V-246-P1-001 — return URL allowlist regression tests.
  it('200 with success_url + cancel_url on the allowlist', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        tier: 'api_builder',
        billing_period: 'monthly',
        success_url: 'https://app.driftstack.dev/billing/success',
        cancel_url: 'https://app.driftstack.dev/billing/cancel',
      },
    });
    expect(res.statusCode).toBe(200);
  });

  it('400 when success_url is off-allowlist (e.g. attacker.com)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        tier: 'api_builder',
        billing_period: 'monthly',
        success_url: 'https://attacker.example.com/phishing',
      },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ detail?: string }>();
    expect(body.detail ?? '').toContain('success_url');
    expect(body.detail ?? '').toContain('allowlist');
  });

  it('400 when cancel_url is malformed', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {
        tier: 'api_builder',
        billing_period: 'monthly',
        cancel_url: 'not a real url',
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/billing/trial-pack', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 returns a Checkout URL for the one-time trial pack', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/trial-pack',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(200);
    expect(fx.billingProvider.state.checkoutSessions[0]?.kind).toBe('trial_pack');
    expect(fx.billingProvider.state.checkoutSessions[0]?.priceId).toBe('price_trial_pack_one_time');
  });

  it('409 Conflict when trial pack already purchased', async () => {
    fx = await buildTestApp();
    fx.billingRepo.applyTrialPackPurchase(fx.accountId, {
      creditCents: 299,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/trial-pack',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Conflict);
  });
});

describe('POST /v1/billing/portal-session', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 returns a portal URL after a Stripe customer exists', async () => {
    fx = await buildTestApp();
    // Bootstrap a customer via a checkout session first.
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_starter', billing_period: 'monthly' },
    });

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/portal-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ portal_url: string }>().portal_url).toMatch(
      /^https:\/\/billing.stripe.example\/p\//,
    );
  });

  it('409 Conflict when no Stripe customer has been provisioned yet', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/portal-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('GET /v1/billing', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 returns null subscription + inactive trial-pack on a fresh account', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<BillingState>();
    expect(body.subscription).toBeNull();
    expect(body.trial_pack.active).toBe(false);
    expect(body.trial_pack.redeemed).toBe(false);
  });

  it('reflects an active trial-pack purchase', async () => {
    fx = await buildTestApp();
    fx.billingRepo.applyTrialPackPurchase(fx.accountId, {
      creditCents: 299,
      expiresAt: new Date(Date.now() + 14 * 24 * 60 * 60 * 1000),
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<BillingState>();
    expect(body.trial_pack.active).toBe(true);
    expect(body.trial_pack.credit_cents_remaining).toBe(299);
    expect(body.trial_pack.expires_at).toBeTruthy();
  });

  it('reflects a subscription mirror row', async () => {
    fx = await buildTestApp();
    seedActiveSubscription(fx, { tier: 'api_builder' });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    const body = res.json<BillingState>();
    expect(body.subscription).not.toBeNull();
    expect(body.subscription?.tier).toBe('api_builder');
    expect(body.subscription?.status).toBe('active');
  });
});
