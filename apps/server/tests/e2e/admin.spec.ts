// E2E admin endpoints — POST/GET/DELETE /v1/api-keys, GET /v1/usage.
// Exercises the Drizzle ApiKeysRepo + UsageRepo against real Postgres.

import { test, expect } from '@playwright/test';
import { PROBLEM_TYPES } from '@driftstack/api-types';
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

// ── POST /v1/api-keys ──────────────────────────────────────────────────────

test('POST /v1/api-keys: 201 returns plaintext + key metadata', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(seed.plaintext),
    data: { name: 'ci-key', scopes: ['read', 'write'] },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(typeof body.plaintext).toBe('string');
  expect((body.plaintext as string).startsWith('ds_live_')).toBe(true);
  expect(body.id).toMatch(/^key_[0-9a-f-]{36}$/);
  expect(body.scopes).toEqual(['read', 'write']);
});

test('POST /v1/api-keys: 403 when admin scope missing', async ({ request }) => {
  const seed = await seedAccount(server.client, { scopes: ['read', 'write'] });
  const res = await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(seed.plaintext),
    data: { name: 'x', scopes: ['read'] },
  });
  expect(res.status()).toBe(403);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
});

test('POST /v1/api-keys: 400 with empty scopes', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(seed.plaintext),
    data: { name: 'x', scopes: [] },
  });
  expect(res.status()).toBe(400);
});

test('POST /v1/api-keys: a free account cannot mint an ordinary API key at all', async ({
  request,
}) => {
  // This test used to assert that a free account minting a key got a `ds_test_`
  // prefix. That premise is retired and unreachable by ANY path:
  // `createApiKey` calls requireTierFeature(tier, 'apiAccess') unless the key
  // BEING MINTED carries `cli_device` provenance, so free can only ever produce
  // a device credential — not through an API key (refused at auth), not through
  // the free-desktop allowlist (POST /v1/api-keys is not on it), and not
  // through a dashboard web session (the service gate is independent of auth).
  //
  // Asserting the refusal is the honest replacement. The `ds_test_` prefix rule
  // itself still exists and is exercised where it is actually reachable, via
  // the device-code flow.
  const signup = await request.post(`${server.baseUrl}/v1/auth/signup`, {
    data: {
      email: `free-key-${Date.now().toString(36)}@driftstack.test`,
      password: 'correct horse battery staple',
    },
  });
  expect(signup.status()).toBe(200);
  const token = ((await signup.json()) as { debug_token: string }).debug_token;
  const verify = await request.post(`${server.baseUrl}/v1/auth/verify-email`, {
    data: { token },
  });
  expect(verify.status()).toBe(200);
  const session = ((await verify.json()) as { session: { token: string } }).session;

  const res = await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(session.token),
    data: { name: 'free-key', scopes: ['read'] },
  });
  expect(res.status()).toBe(403);
});

// ── GET /v1/api-keys ───────────────────────────────────────────────────────

test('GET /v1/api-keys: lists keys, never includes plaintext', async ({ request }) => {
  const seed = await seedAccount(server.client);
  // Create a second key alongside the seeded one.
  await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(seed.plaintext),
    data: { name: 'second', scopes: ['read'] },
  });

  const res = await request.get(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: Array<Record<string, unknown>> };
  expect(body.data.length).toBeGreaterThanOrEqual(2);
  for (const k of body.data) {
    expect(k.plaintext).toBeUndefined();
    expect(k.id).toMatch(/^key_/);
  }
  // Field-name absence is the weaker half. `k.plaintext === undefined` still
  // holds if the key leaks under ANY other name — `key`, `token`, `secret`, or
  // echoed inside a debug field — so assert the secret VALUE is absent from the
  // whole response, which no rename can satisfy.
  expect(await res.text(), 'the list response must not contain the key itself').not.toContain(
    seed.plaintext,
  );
});

// ── DELETE /v1/api-keys/:id ────────────────────────────────────────────────

test('DELETE /v1/api-keys/:id: 204 + idempotent re-delete', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const create = await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(seed.plaintext),
    data: { name: 'doomed', scopes: ['read'] },
  });
  const created = (await create.json()) as { id: string };

  const del1 = await request.delete(`${server.baseUrl}/v1/api-keys/${created.id}`, {
    headers: authHeader(seed.plaintext),
  });
  expect(del1.status()).toBe(204);

  const del2 = await request.delete(`${server.baseUrl}/v1/api-keys/${created.id}`, {
    headers: authHeader(seed.plaintext),
  });
  expect(del2.status()).toBe(204);
});

test('DELETE /v1/api-keys/:id: 404 for unknown id', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.delete(
    `${server.baseUrl}/v1/api-keys/key_00000000-0000-4000-8000-000000000999`,
    { headers: authHeader(seed.plaintext) },
  );
  expect(res.status()).toBe(404);
});

test('DELETE /v1/api-keys/:id: 403 when admin scope missing', async ({ request }) => {
  const seed = await seedAccount(server.client, { scopes: ['read', 'write'] });
  const res = await request.delete(`${server.baseUrl}/v1/api-keys/key_${seed.apiKeyId}`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(403);
});

// ── GET /v1/usage ──────────────────────────────────────────────────────────

test('GET /v1/usage: zero totals + null quotas for fresh scale-tier account', async ({
  request,
}) => {
  // Per ADR-004 / V-073: paid tiers are concurrent-only; per-op quotas
  // are intentionally null across the board (the `session_minute` meter
  // is preserved as a ledger primitive but not gated). The customer-
  // visible signal is "no per-meter cap at this tier."
  const seed = await seedAccount(server.client, { tier: 'api_scale' });
  const res = await request.get(`${server.baseUrl}/v1/usage`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.tier).toBe('api_scale');
  expect((body.totals as Record<string, number>).navigate).toBe(0);
  expect((body.quotas as Record<string, number | null>).navigate).toBeNull();
});

test('GET /v1/usage: enterprise tier returns null quotas', async ({ request }) => {
  const seed = await seedAccount(server.client, { tier: 'enterprise' });
  const res = await request.get(`${server.baseUrl}/v1/usage`, {
    headers: authHeader(seed.plaintext),
  });
  const body = (await res.json()) as { quotas: Record<string, number | null> };
  expect(body.quotas.navigate).toBeNull();
  expect(body.quotas.session_minute).toBeNull();
});

test('GET /v1/usage: aggregates totals from usage_records via DB', async ({ request }) => {
  const seed = await seedAccount(server.client, { tier: 'api_starter' });
  // Insert usage rows directly — exercises the DrizzleUsageRepo aggregation
  // path against real Postgres (count(*)::int group by record_type).
  await server.client`
    INSERT INTO usage_records (account_id, record_type, quantity)
    VALUES (${seed.accountId}, 'navigate', 12),
           (${seed.accountId}, 'navigate', 3),
           (${seed.accountId}, 'interact', 5)
  `;

  const res = await request.get(`${server.baseUrl}/v1/usage`, {
    headers: authHeader(seed.plaintext),
  });
  const body = (await res.json()) as { totals: Record<string, number> };
  expect(body.totals.navigate).toBe(15);
  expect(body.totals.interact).toBe(5);
  expect(body.totals.wait).toBe(0);
});
