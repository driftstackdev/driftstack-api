// V-540.B-3 — E2E walkthrough of /v1/account/me read + patch surface.
//
// Avatar upload + DELETE flows depend on R2 wiring that's not always
// available in the test environment; this spec scopes to the always-
// available read + PATCH paths. Avatar coverage is V-540.B-4 territory.

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

interface MeResponse {
  id: string;
  email: string;
  name: string | null;
  tier: string;
  status: string;
  timezone: string | null;
  slug: string | null;
  region: string | null;
  avatar_url: string | null;
  mfa_enrolled: boolean;
  concurrent_session_cap: number;
  concurrent_session_active: number;
  profile_cap: number;
  profile_count: number;
  teams: Array<{
    owner_account_id: string;
    role: string;
    membership_id: string;
  }>;
}

test('GET /v1/account/me returns the full account shape', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as MeResponse;
  expect(body.id).toBe(`acc_${seed.accountId}`);
  expect(body.tier).toBe(seed.tier);
  expect(body.status).toBe('active');
  expect(body.concurrent_session_cap).toBeGreaterThan(0);
  expect(body.concurrent_session_active).toBe(0);
  expect(body.profile_count).toBe(0);
  expect(body.mfa_enrolled).toBe(false);
  expect(body.teams).toEqual([]);
});

test('PATCH /v1/account/me updates name + timezone', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.patch(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(seed.plaintext),
    data: { name: 'New Name', timezone: 'Europe/Amsterdam' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { name: string; timezone: string };
  expect(body.name).toBe('New Name');
  expect(body.timezone).toBe('Europe/Amsterdam');

  const reread = (await (
    await request.get(`${server.baseUrl}/v1/account/me`, { headers: authHeader(seed.plaintext) })
  ).json()) as MeResponse;
  expect(reread.name).toBe('New Name');
  expect(reread.timezone).toBe('Europe/Amsterdam');
});

test('PATCH /v1/account/me sets a slug', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.patch(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(seed.plaintext),
    data: { slug: 'alice-co' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { slug: string };
  expect(body.slug).toBe('alice-co');
});

test('PATCH /v1/account/me 409 on slug collision', async ({ request }) => {
  const seedA = await seedAccount(server.client, { email: 'a@driftstack.test' });
  const seedB = await seedAccount(server.client, { email: 'b@driftstack.test' });

  const claimRes = await request.patch(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(seedA.plaintext),
    data: { slug: 'taken-slug' },
  });
  expect(claimRes.status()).toBe(200);

  const collisionRes = await request.patch(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(seedB.plaintext),
    data: { slug: 'taken-slug' },
  });
  expect(collisionRes.status()).toBe(409);
});

test('PATCH /v1/account/me sets a region preference', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.patch(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(seed.plaintext),
    data: { region: 'eu' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { region: string };
  expect(body.region).toBe('eu');
});

test('PATCH /v1/account/me 400 on malformed body', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.patch(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(seed.plaintext),
    data: { slug: 'INVALID SLUG WITH SPACES' },
  });
  expect(res.status()).toBe(400);
});

test('GET /v1/account/me returns 401 without auth header', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/account/me`);
  expect(res.status()).toBe(401);
});

test('PATCH /v1/account/me returns 401 without auth header', async ({ request }) => {
  const res = await request.patch(`${server.baseUrl}/v1/account/me`, {
    data: { name: 'x' },
  });
  expect(res.status()).toBe(401);
});
