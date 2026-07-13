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
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'checkout-attempt-123',
      },
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
    expect(fx.billingProvider.state.checkoutSessions[0]?.idempotencyKey).toBe(
      'checkout-attempt-123',
    );
  });

  it('400 rejects an invalid Idempotency-Key before creating Checkout', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: {
        authorization: `Bearer ${fx.plaintext}`,
        'idempotency-key': 'contains whitespace',
      },
      payload: { tier: 'api_builder', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail: string }>().detail).toContain('Invalid Idempotency-Key');
    expect(fx.billingProvider.state.checkoutSessions).toHaveLength(0);
  });

  it('403 when the key lacks admin:billing scope (write-only key)', async () => {
    fx = await buildTestApp({ scopes: ['read', 'write'] });
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_builder', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(403);
    const body = res.json<{ detail: string }>();
    expect(body.detail).toContain('admin:billing');
  });

  it('400 ValidationFailed for tier=free', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'free', billing_period: 'monthly' },
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

  // Double-subscribe guard (route-level): an already-subscribed
  // customer hitting checkout-session a second time — e.g. the
  // dashboard's "Change plan"/"Upgrade"/"Downgrade" buttons routing
  // through /select-tier instead of the customer portal — must be
  // rejected, not silently mint a second concurrent Stripe
  // subscription (double billing). Service-level status coverage
  // (active/trialing blocked; past_due/canceled/etc allowed) lives in
  // tests/unit/billing.test.ts; this confirms the route surfaces the
  // ConflictError as an actual 409 HTTP response.
  it('409 Conflict when the account already has an active subscription (double-subscribe guard)', async () => {
    fx = await buildTestApp();
    seedActiveSubscription(fx, { tier: 'api_builder', status: 'active' });

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_scale', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json<{ type: string }>().type).toBe(PROBLEM_TYPES.Conflict);
    // No second Checkout session was started.
    expect(fx.billingProvider.state.checkoutSessions).toHaveLength(0);
  });

  it('200 still allowed when the existing subscription is canceled (not currently billed)', async () => {
    fx = await buildTestApp();
    seedActiveSubscription(fx, { tier: 'api_builder', status: 'canceled' });

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_scale', billing_period: 'monthly' },
    });
    expect(res.statusCode).toBe(200);
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

// v2-#26 — dashboard-friendly redirect variant. Same underlying
// createPortalSession() call as POST /v1/billing/portal-session; the
// difference is the response shape (302 + Location header rather than
// 200 + JSON body). Lets a customer-dashboard `<a href=…>` link
// initiate the portal flow without intermediate JS.
describe('GET /v1/account/me/billing-portal (v2-#26)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('302 redirects to the Stripe portal URL after a customer exists', async () => {
    fx = await buildTestApp();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/billing/checkout-session',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { tier: 'api_starter', billing_period: 'monthly' },
    });

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/billing-portal',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toMatch(/^https:\/\/billing.stripe.example\/p\//);
  });

  it('409 Conflict when no Stripe customer has been provisioned yet (same error semantics as the POST variant)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/me/billing-portal',
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

  it('200 returns null subscription on a fresh account', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<BillingState>();
    expect(body.subscription).toBeNull();
  });

  it('V-666.BW sets Cache-Control: no-store, private', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store, private');
  });

  // S46 2026-07-07 (founder-approved) — read:billing scope floor. The route
  // previously had NO scope gate (any authenticated key could read billing
  // state). Per V-481, broad `read` and `account_owner` (the web-session /
  // dashboard scope set) satisfy the granular requirement; a write-only key
  // does not.
  it('S46: 403 for a write-only key (read:billing scope floor)', async () => {
    fx = await buildTestApp({ scopes: ['write'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ detail: string }>().detail).toContain('read:billing');
  });

  it('S46: 200 for a granular read:billing key (exact scope)', async () => {
    fx = await buildTestApp({ scopes: ['read:billing'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('S46: 200 for a broad read-only key (V-481 broad-satisfies-granular)', async () => {
    fx = await buildTestApp({ scopes: ['read'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
  });

  it('S46: 200 for an account_owner key (the dashboard web-session scope set carries read+write+account_owner)', async () => {
    fx = await buildTestApp({ scopes: ['account_owner'] });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/billing',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
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

  // V-326c — GET /v1/billing honors the X-Driftstack-Account act-as
  // header like /v1/usage. A team member acting as the owner reads the
  // OWNER's subscription, so the Billing page agrees with the rest of the
  // dashboard instead of silently showing the member's own (empty) plan.
  describe('X-Driftstack-Account act-as context', () => {
    const TEAM_OWNER_ID = '00000000-0000-4000-8000-000000000d01';
    const TEAM_MEMBERSHIP_ID = '00000000-0000-4000-8000-000000000d02';

    it("returns the OWNER's subscription when a team member acts as the owner (not the member's own)", async () => {
      fx = await buildTestApp();
      // Caller is a member of the owner's team.
      fx.authRepo.setTeamMemberships(fx.accountId, [
        { membershipId: TEAM_MEMBERSHIP_ID, ownerAccountId: TEAM_OWNER_ID, role: 'member' },
      ]);
      // Owner exists in the billing repo + has an active api_scale sub.
      fx.billingRepo.upsertAccount({
        id: TEAM_OWNER_ID,
        email: 'owner@driftstack.local',
        name: 'Owner',
        tier: 'api_scale',
        stripeCustomerId: 'cus_owner_test',
      });
      fx.billingRepo.upsertSubscription({
        id: 'sub_owner_d01',
        accountId: TEAM_OWNER_ID,
        stripeSubscriptionId: 'sub_test_owner_d01',
        stripePriceId: 'price_api_scale_monthly',
        tier: 'api_scale',
        status: 'active',
        currentPeriodEnd: new Date('2026-07-01T00:00:00Z'),
        cancelAtPeriodEnd: false,
        canceledAt: null,
        createdAt: new Date('2026-06-01T00:00:00Z'),
        updatedAt: new Date('2026-06-01T00:00:00Z'),
      });
      // The member has NO subscription of their own.
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/billing',
        headers: {
          authorization: `Bearer ${fx.plaintext}`,
          'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
        },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json<BillingState>();
      expect(body.subscription).not.toBeNull();
      expect(body.subscription?.tier).toBe('api_scale');
      expect(body.subscription?.status).toBe('active');
    });

    it('fails closed (4xx, not 200) when acting as an account the caller is not a member of', async () => {
      fx = await buildTestApp();
      seedActiveSubscription(fx, { tier: 'api_builder' });
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/billing',
        headers: {
          authorization: `Bearer ${fx.plaintext}`,
          'x-driftstack-account': `acc_${TEAM_OWNER_ID}`,
        },
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    });

    it("self-scope (no header) still returns the caller's own subscription", async () => {
      fx = await buildTestApp();
      seedActiveSubscription(fx, { tier: 'api_builder' });
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/billing',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<BillingState>().subscription?.tier).toBe('api_builder');
    });
  });
});
