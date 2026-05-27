// V-540.B-15 — happy-path E2E for the billing write surface.
//
// V-540.B-13 covered the validation gate (400 paths). This spec
// covers the post-validation path — the request body is valid, URLs
// are allowlisted, and the request makes it through to the
// BillingService → InMemoryBillingProvider chain. Asserts: route
// returns 200; checkout URL shape matches the stub; provider state
// records the call.
//
// Real Stripe never fires in e2e — the in-memory provider stub is
// the boundary. Real-Stripe-test-mode E2Es require STRIPE_TEST_API_KEY
// in CI and are deferred to V-540.B-16.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

test('checkout-session 200 with subscription kind + monthly price', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_builder',
      billing_period: 'monthly',
      success_url: 'http://localhost:5173/billing/success',
      cancel_url: 'http://localhost:5173/billing/cancel',
    },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { checkout_url: string; checkout_session_id: string };
  expect(body.checkout_url).toMatch(/^https:\/\/checkout\.stripe\.example\//);
  expect(body.checkout_session_id).toMatch(/^cs_test_/);

  expect(server.billingProvider.state.checkoutSessions).toHaveLength(1);
  const session = server.billingProvider.state.checkoutSessions[0];
  expect(session?.kind).toBe('subscription');
  expect(session?.priceId).toBe('price_api_builder_monthly');
});

test('checkout-session 200 with annual price for api_scale tier', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_scale',
      billing_period: 'annual',
      success_url: 'http://localhost:5173/billing/success',
      cancel_url: 'http://localhost:5173/billing/cancel',
    },
  });
  expect(res.status()).toBe(200);
  expect(server.billingProvider.state.checkoutSessions[0]?.priceId).toBe('price_api_scale_annual');
});

// The one-time trial-pack purchase flow was retired 2026-05-27: the
// perpetual free tier is the default for every new account and needs no
// purchase step, so there is no POST /v1/billing/* route to "start free."

test('two checkouts on the same account reuse the same Stripe customer', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const first = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_starter',
      billing_period: 'monthly',
      success_url: 'http://localhost:5173/billing/success',
      cancel_url: 'http://localhost:5173/billing/cancel',
    },
  });
  expect(first.status()).toBe(200);
  const second = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_builder',
      billing_period: 'annual',
      success_url: 'http://localhost:5173/billing/success',
      cancel_url: 'http://localhost:5173/billing/cancel',
    },
  });
  expect(second.status()).toBe(200);
  const sessions = server.billingProvider.state.checkoutSessions;
  expect(sessions).toHaveLength(2);
  expect(sessions[0]?.customerId).toBe(sessions[1]?.customerId);
  expect(server.billingProvider.state.customers.size).toBe(1);
});

test('portal-session 200 after a customer has been provisioned via checkout', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_starter',
      billing_period: 'monthly',
      success_url: 'http://localhost:5173/billing/success',
      cancel_url: 'http://localhost:5173/billing/cancel',
    },
  });
  const res = await request.post(`${server.baseUrl}/v1/billing/portal-session`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  expect(server.billingProvider.state.portalSessions).toHaveLength(1);
});

test('GET /v1/billing reports null subscription for a fresh free-tier account', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/billing`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  // GetBillingStateResponse is { subscription } only since the trial-pack
  // retirement — the free tier carries no billing-state envelope.
  const body = (await res.json()) as { subscription: unknown };
  expect(body.subscription).toBeNull();
});
