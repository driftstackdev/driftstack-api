// V-540.B-3 — E2E for the V-541.B admin cost-monitoring routes.

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
  server.costUsageByAccount.clear();
});

test('GET /v1/admin/cost/accounts/:id — requires internal-admin scope', async ({ request }) => {
  // Exercise the expired V-174 bridge directly: legacy customer `admin`
  // retains own-account authority but must never cross into staff APIs.
  const seed = await seedAccount(server.client, { scopes: ['read', 'write', 'admin'] });
  const res = await request.get(`${server.baseUrl}/v1/admin/cost/accounts/${seed.accountId}`, {
    headers: authHeader(seed.plaintext),
  });
  expect([401, 403]).toContain(res.status());
});

test('GET /v1/admin/cost/accounts/:id — 200 with breakdown for a populated account', async ({
  request,
}) => {
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  server.costUsageByAccount.set(admin.accountId, {
    sessionMinutes: 120,
    storageGbMonths: 10,
    egressGb: 1,
    emailSends: 5,
    llmInputTokens: 1000,
    llmOutputTokens: 1000,
  });
  const res = await request.get(
    `${server.baseUrl}/v1/admin/cost/accounts/${admin.accountId}?billing_cycle=2026-05`,
    { headers: authHeader(admin.plaintext) },
  );
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    account_id: string;
    billing_cycle: string;
    tier: string;
    breakdown: { totalCents: number; computeCents: number; thresholdState: string };
  };
  expect(body.account_id).toBe(admin.accountId);
  expect(body.billing_cycle).toBe('2026-05');
  expect(body.breakdown.computeCents).toBe(120);
  expect(body.breakdown.totalCents).toBeGreaterThan(0);
  expect(['under-soft', 'between-soft-and-hard', 'over-hard']).toContain(
    body.breakdown.thresholdState,
  );
});

test('GET /v1/admin/cost/accounts/:id — 404 when the account has no usage in the cycle', async ({
  request,
}) => {
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  // costUsageByAccount intentionally empty for admin.accountId.
  const res = await request.get(
    `${server.baseUrl}/v1/admin/cost/accounts/${admin.accountId}?billing_cycle=2026-05`,
    { headers: authHeader(admin.plaintext) },
  );
  expect(res.status()).toBe(404);
});

test('GET /v1/admin/cost/overview — sorts by total cost descending', async ({ request }) => {
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const a = await seedAccount(server.client);
  const b = await seedAccount(server.client);
  const c = await seedAccount(server.client);
  server.costUsageByAccount.set(a.accountId, {
    sessionMinutes: 100,
    storageGbMonths: 0,
    egressGb: 0,
    emailSends: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
  });
  server.costUsageByAccount.set(b.accountId, {
    sessionMinutes: 10_000,
    storageGbMonths: 0,
    egressGb: 0,
    emailSends: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
  });
  server.costUsageByAccount.set(c.accountId, {
    sessionMinutes: 1_000,
    storageGbMonths: 0,
    egressGb: 0,
    emailSends: 0,
    llmInputTokens: 0,
    llmOutputTokens: 0,
  });
  const url = `${server.baseUrl}/v1/admin/cost/overview?billing_cycle=2026-05&account_ids=${a.accountId},${b.accountId},${c.accountId}`;
  const res = await request.get(url, { headers: authHeader(admin.plaintext) });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    summaries: Array<{ account_id: string; breakdown: { totalCents: number } }>;
  };
  expect(body.summaries.map((s) => s.account_id)).toEqual([b.accountId, c.accountId, a.accountId]);
});

test('GET /v1/admin/cost/overview — 400 on empty account_ids', async ({ request }) => {
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const res = await request.get(`${server.baseUrl}/v1/admin/cost/overview?account_ids=`, {
    headers: authHeader(admin.plaintext),
  });
  expect(res.status()).toBe(400);
});
