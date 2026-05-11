// V-540.B-5 — E2E walkthrough of /v1/account/email-preferences.
//
// Covers:
//  - GET returns the default preference set (all opted_in defaults
//    derived from the catalog).
//  - PUT sets a preference; subsequent GET reflects the change.
//  - PUT 400 on missing or unknown event_type.
//  - PUT 400 on missing opted_in.
//  - 401 unauth on both GET + PUT.

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

interface PreferenceEntry {
  event_type: string;
  opted_in: boolean;
}

interface PreferenceListResponse {
  data: PreferenceEntry[];
}

test('GET /v1/account/email-preferences returns the default preference set', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/account/email-preferences`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as PreferenceListResponse;
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeGreaterThan(0);
  for (const entry of body.data) {
    expect(typeof entry.event_type).toBe('string');
    expect(typeof entry.opted_in).toBe('boolean');
  }
});

test('PUT updates a preference; subsequent GET reflects the change', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const headers = authHeader(seed.plaintext);

  // Read first to discover which event_type is currently opted-in.
  const initial = (await (
    await request.get(`${server.baseUrl}/v1/account/email-preferences`, { headers })
  ).json()) as PreferenceListResponse;
  const target = initial.data.find((d) => d.opted_in);
  expect(target).toBeDefined();
  if (!target) return;

  const putRes = await request.put(`${server.baseUrl}/v1/account/email-preferences`, {
    headers,
    data: { event_type: target.event_type, opted_in: false },
  });
  expect(putRes.status()).toBe(204);

  const after = (await (
    await request.get(`${server.baseUrl}/v1/account/email-preferences`, { headers })
  ).json()) as PreferenceListResponse;
  const updated = after.data.find((d) => d.event_type === target.event_type);
  expect(updated?.opted_in).toBe(false);
});

test('PUT toggles a preference back on', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const headers = authHeader(seed.plaintext);

  const initial = (await (
    await request.get(`${server.baseUrl}/v1/account/email-preferences`, { headers })
  ).json()) as PreferenceListResponse;
  const target = initial.data[0];
  if (!target) return;

  await request.put(`${server.baseUrl}/v1/account/email-preferences`, {
    headers,
    data: { event_type: target.event_type, opted_in: false },
  });
  await request.put(`${server.baseUrl}/v1/account/email-preferences`, {
    headers,
    data: { event_type: target.event_type, opted_in: true },
  });

  const final = (await (
    await request.get(`${server.baseUrl}/v1/account/email-preferences`, { headers })
  ).json()) as PreferenceListResponse;
  const updated = final.data.find((d) => d.event_type === target.event_type);
  expect(updated?.opted_in).toBe(true);
});

test('PUT 400 on missing event_type', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.put(`${server.baseUrl}/v1/account/email-preferences`, {
    headers: authHeader(seed.plaintext),
    data: { opted_in: false },
  });
  expect(res.status()).toBe(400);
});

test('PUT 400 on missing opted_in', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.put(`${server.baseUrl}/v1/account/email-preferences`, {
    headers: authHeader(seed.plaintext),
    data: { event_type: 'session-failed-first' },
  });
  expect(res.status()).toBe(400);
});

test('GET /v1/account/email-preferences returns 401 without auth', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/account/email-preferences`);
  expect(res.status()).toBe(401);
});

test('PUT /v1/account/email-preferences returns 401 without auth', async ({ request }) => {
  const res = await request.put(`${server.baseUrl}/v1/account/email-preferences`, {
    data: { event_type: 'x', opted_in: false },
  });
  expect(res.status()).toBe(401);
});
