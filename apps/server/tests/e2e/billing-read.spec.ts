// V-540.B-12 — E2E walkthrough of GET /v1/billing (read-only).
//
// The POST /v1/billing/* endpoints (create-checkout, portal-session)
// all proxy to Stripe and require a configured Stripe customer id;
// those paths need Stripe API mocking that's not in scope for this
// slice. The GET /v1/billing read path is a pure DB lookup +
// service.getBillingState() and is fully testable here.
//
// Covered:
//  - GET /v1/billing on a fresh account returns the default state
//    (no subscription).
//  - GET /v1/billing 401 without Authorization.

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

interface SubscriptionShape {
  id: string;
  status: string;
  tier: string;
  current_period_start: string;
  current_period_end: string;
}

interface BillingResponse {
  subscription: SubscriptionShape | null;
}

test('GET /v1/billing on a fresh account → no subscription', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/billing`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as BillingResponse;
  expect(body.subscription).toBeNull();
});

test('GET /v1/billing returns 401 without auth', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/billing`);
  expect(res.status()).toBe(401);
});
