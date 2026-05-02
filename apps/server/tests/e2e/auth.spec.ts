// E2E auth pipeline — happy path + every documented error case via real HTTP.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

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

test('authenticated GET returns 200 with x-request-id and x-ratelimit-remaining', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['x-request-id']).toBeTruthy();
  expect(res.headers()['x-ratelimit-remaining']).toBeTruthy();
});

test('401 Unauthorized when Authorization header is missing', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/sessions`);
  expect(res.status()).toBe(401);
  expect(res.headers()['content-type']).toMatch(/application\/problem\+json/);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.Unauthorized);
});

test('401 Unauthorized when Authorization header is malformed', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: { Authorization: 'Basic abc' },
  });
  expect(res.status()).toBe(401);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.Unauthorized);
});

test('401 InvalidKey for an unknown but well-formed key', async ({ request }) => {
  await seedAccount(server.client); // seed something else so the prefix lookup runs
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: { Authorization: 'Bearer ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
  });
  expect(res.status()).toBe(401);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.InvalidKey);
});

test('401 RevokedKey when the key has revoked_at set', async ({ request }) => {
  const seed = await seedAccount(server.client);
  // Revoke directly via DB to mirror what the admin endpoint does.
  await server.client`
    UPDATE api_keys SET revoked_at = NOW() WHERE id = ${seed.apiKeyId}
  `;
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(401);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.RevokedKey);
});

test('401 ExpiredKey when expires_at is in the past', async ({ request }) => {
  const seed = await seedAccount(server.client);
  await server.client`
    UPDATE api_keys SET expires_at = NOW() - INTERVAL '1 day' WHERE id = ${seed.apiKeyId}
  `;
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(401);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.ExpiredKey);
});

test('403 Forbidden when account is suspended', async ({ request }) => {
  const seed = await seedAccount(server.client, { status: 'suspended' });
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(403);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
});

test('401 InvalidKey when account is deleted (no information leak)', async ({ request }) => {
  const seed = await seedAccount(server.client, { status: 'deleted' });
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(401);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.InvalidKey);
});

test('successful auth populates last_used_at via Drizzle UPDATE', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const before = await server.client`
    SELECT last_used_at FROM api_keys WHERE id = ${seed.apiKeyId}
  `;
  expect(before[0]?.last_used_at).toBeNull();

  await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });

  const after = await server.client`
    SELECT last_used_at FROM api_keys WHERE id = ${seed.apiKeyId}
  `;
  // postgres-js raw template-literal queries return timestamps as ISO strings
  // (not Date objects — Drizzle is what attaches type parsers). Verify the
  // column is non-null and parseable as a recent-ish Date.
  const lastUsed = after[0]?.last_used_at;
  expect(lastUsed).toBeTruthy();
  const parsed = new Date(lastUsed as string);
  expect(parsed.getTime()).toBeGreaterThan(Date.now() - 60_000);
});
