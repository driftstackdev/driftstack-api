// V-540.B-12 — E2E walkthrough of GET /v1/billing (read-only).
//
// The POST /v1/billing/* endpoints (create-checkout, portal-session,
// purchase-trial-pack) all proxy to Stripe and require a configured
// Stripe customer id; those paths need Stripe API mocking that's not
// in scope for this slice. The GET /v1/billing read path is a pure
// DB lookup + service.getBillingState() and is fully testable here.
//
// Covered:
//  - GET /v1/billing on a fresh account returns the default state
//    (no subscription, no trial pack).
//  - GET /v1/billing reflects a seeded trial-pack row.
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

interface TrialPackShape {
  active: boolean;
  credit_cents_remaining: number;
  expires_at: string | null;
  redeemed: boolean;
}

interface BillingResponse {
  subscription: SubscriptionShape | null;
  trial_pack: TrialPackShape;
}

test('GET /v1/billing on a fresh account → no subscription, inactive trial pack', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/billing`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as BillingResponse;
  expect(body.subscription).toBeNull();
  expect(body.trial_pack.active).toBe(false);
  expect(body.trial_pack.redeemed).toBe(false);
  expect(body.trial_pack.credit_cents_remaining).toBe(0);
  expect(body.trial_pack.expires_at).toBeNull();
});

test('GET /v1/billing reflects an active trial pack (account columns)', async ({ request }) => {
  const seed = await seedAccount(server.client, { tier: 'trial_pack' });
  const futureExpiry = new Date(Date.now() + 14 * 86_400_000);
  await server.client`
    UPDATE accounts
    SET trial_pack_purchased_at = NOW(),
        trial_pack_credit_cents = 200,
        trial_pack_expires_at = ${futureExpiry},
        trial_pack_redeemed = false
    WHERE id = ${seed.accountId}
  `;

  const res = await request.get(`${server.baseUrl}/v1/billing`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as BillingResponse;
  expect(body.trial_pack.credit_cents_remaining).toBe(200);
  expect(body.trial_pack.expires_at).not.toBeNull();
});

test('GET /v1/billing trial_pack redeemed=true after redemption', async ({ request }) => {
  const seed = await seedAccount(server.client, { tier: 'trial_pack' });
  const futureExpiry = new Date(Date.now() + 14 * 86_400_000);
  await server.client`
    UPDATE accounts
    SET trial_pack_purchased_at = NOW(),
        trial_pack_credit_cents = 0,
        trial_pack_expires_at = ${futureExpiry},
        trial_pack_redeemed = true
    WHERE id = ${seed.accountId}
  `;

  const res = await request.get(`${server.baseUrl}/v1/billing`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as BillingResponse;
  expect(body.trial_pack.redeemed).toBe(true);
  expect(body.trial_pack.active).toBe(false);
});

test('GET /v1/billing returns 401 without auth', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/billing`);
  expect(res.status()).toBe(401);
});
