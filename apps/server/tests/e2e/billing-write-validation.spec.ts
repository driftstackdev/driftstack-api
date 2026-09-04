// V-540.B-13 — E2E for the validation + allowlist surface of the
// POST /v1/billing/* write routes.
//
// Real Stripe checkout / trial-pack / portal-session calls need a
// live Stripe test-mode harness (real `STRIPE_API_KEY` + a customer
// row with a non-null `stripeCustomerId`); those happy-path E2Es are
// V-540.B-14 / 15 territory and gated on the Stripe test-mode setup.
//
// This spec covers the validation gate that runs BEFORE the Stripe
// API call:
//  - return_url allowlist (V-248). Malformed URL, off-allowlist origin
//    both reject 400.
//  - Zod body validation. Missing/unknown tier rejects 400.
//  - Auth gate. Unauthorized callers get 401 from the requireAuth
//    middleware BEFORE the body parser runs.
//
// The Stripe call never fires in any of these scenarios — the route
// short-circuits on the validation step.

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

// ────────────────────────────────────────────────────────────────────────
// POST /v1/billing/checkout-session — validation
// ────────────────────────────────────────────────────────────────────────

test('checkout-session 400 on malformed success_url', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_builder',
      billing_period: 'monthly',
      success_url: 'not a url',
      cancel_url: 'https://app.driftstack.io/cancel',
    },
  });
  expect(res.status()).toBe(400);
});

test('checkout-session 400 on off-allowlist success_url origin', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_builder',
      billing_period: 'monthly',
      success_url: 'https://attacker.example.com/success',
      cancel_url: 'https://app.driftstack.io/cancel',
    },
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as { detail?: string };
  expect(body.detail ?? '').toMatch(/allowlist/i);
});

test('checkout-session 400 on off-allowlist cancel_url origin', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_builder',
      billing_period: 'monthly',
      success_url: 'https://app.driftstack.io/success',
      cancel_url: 'https://phish.example.com/cancel',
    },
  });
  expect(res.status()).toBe(400);
});

test('checkout-session 400 on missing tier', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: { billing_period: 'monthly' },
  });
  expect(res.status()).toBe(400);
});

test('checkout-session 400 on unknown tier', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: { tier: 'not_a_real_tier', billing_period: 'monthly' },
  });
  expect(res.status()).toBe(400);
});

test('checkout-session 401 without auth', async ({ request }) => {
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    data: { tier: 'api_builder', billing_period: 'monthly' },
  });
  expect(res.status()).toBe(401);
});

// The POST /v1/billing/trial-pack route was retired 2026-05-27 with the
// one-time trial pack; the perpetual free tier needs no purchase step, so
// there is nothing to validate here anymore.

// ────────────────────────────────────────────────────────────────────────
// POST /v1/billing/portal-session — auth only (no body validation)
// ────────────────────────────────────────────────────────────────────────

test('portal-session 401 without auth', async ({ request }) => {
  const res = await request.post(`${server.baseUrl}/v1/billing/portal-session`);
  expect(res.status()).toBe(401);
});

// ────────────────────────────────────────────────────────────────────────
// Allowlist positive — accepted origins
// ────────────────────────────────────────────────────────────────────────

test('checkout-session accepts https://app.driftstack.io URL (allowlist hit)', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  // The body is valid + URLs are allowlisted. The route then forwards
  // to Stripe; in the test env Stripe is stubbed so we expect either
  // 200 (stub returns a URL) or a 5xx if the stub is missing. The
  // assertion below is "not a validation 400" — the validation gate
  // accepted the input.
  const res = await request.post(`${server.baseUrl}/v1/billing/checkout-session`, {
    headers: authHeader(seed.plaintext),
    data: {
      tier: 'api_builder',
      billing_period: 'monthly',
      success_url: 'https://app.driftstack.io/billing/success',
      cancel_url: 'https://app.driftstack.io/billing/cancel',
    },
  });
  expect(res.status()).not.toBe(400);
  // Don't assert 200 — the stripe stub configuration is an
  // implementation detail of the test harness, not a contract.
});
