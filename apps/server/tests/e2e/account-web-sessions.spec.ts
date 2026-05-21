// V-540.B-7 — E2E walkthrough of /v1/account/web-sessions.
//
// Web sessions are the dashboard's bearer-token contexts (cookies +
// session token). API-key callers don't HAVE web sessions, so the
// list-from-API-key path returns whatever rows already exist for the
// account; the bulk-revoke endpoint refuses non-web-session callers.
//
// This spec covers:
//  - GET /v1/account/web-sessions returns the account's active web
//    sessions (we seed rows directly into the table to verify the
//    shape without going through real cookie auth).
//  - GET on a fresh account returns empty data.
//  - DELETE /v1/account/web-sessions/:id revokes a specific session
//    (works with API-key auth for self-account).
//  - DELETE /v1/account/web-sessions?keep=current refuses an
//    API-key caller (no "current" to keep).
//  - DELETE on unknown id returns 404.
//  - 401 unauth on all routes.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';
import { randomUUID } from 'node:crypto';

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

interface WebSessionEntry {
  id: string;
  os: string;
  browser: string;
  last_used_at: string;
  expires_at: string;
  current: boolean;
}

interface WebSessionListResponse {
  data: WebSessionEntry[];
}

async function seedWebSession(
  client: TestServer['client'],
  accountId: string,
  opts: { tokenSuffix?: string; userAgent?: string } = {},
): Promise<string> {
  const tokenPlain = `web-${opts.tokenSuffix ?? randomUUID()}`;
  const { createHash } = await import('node:crypto');
  const tokenHash = createHash('sha256').update(tokenPlain).digest('hex');
  const sessionId = randomUUID();
  // 2026-05-20 — pre-serialize Date to ISO; postgres-js Bind step
  // doesn't accept raw Date params (same fix as auth-flows-repo.ts:190).
  const expiresAt = new Date(Date.now() + 86_400_000).toISOString(); // +24h
  const ua =
    opts.userAgent ??
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/16.4';
  await client`
    INSERT INTO web_sessions
      (id, account_id, token_hash, expires_at, user_agent, last_used_at)
    VALUES (${sessionId}, ${accountId}, ${tokenHash}, ${expiresAt}::timestamptz,
            ${ua}, NOW())
  `;
  return sessionId;
}

test('GET /v1/account/web-sessions returns empty data on a fresh account', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/account/web-sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as WebSessionListResponse;
  expect(body.data).toEqual([]);
});

test('GET /v1/account/web-sessions lists seeded sessions', async ({ request }) => {
  const seed = await seedAccount(server.client);
  await seedWebSession(server.client, seed.accountId, { tokenSuffix: 'a' });
  await seedWebSession(server.client, seed.accountId, { tokenSuffix: 'b' });

  const res = await request.get(`${server.baseUrl}/v1/account/web-sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as WebSessionListResponse;
  expect(body.data.length).toBe(2);
  for (const entry of body.data) {
    expect(entry.id).toMatch(/^wsess_/);
    expect(typeof entry.os).toBe('string');
    expect(typeof entry.browser).toBe('string');
    expect(entry.current).toBe(false); // API-key caller has no "current"
  }
});

test('DELETE /v1/account/web-sessions/:id revokes a specific session', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const sessionId = await seedWebSession(server.client, seed.accountId);
  const publicId = `wsess_${sessionId}`;

  const delRes = await request.delete(`${server.baseUrl}/v1/account/web-sessions/${publicId}`, {
    headers: authHeader(seed.plaintext),
  });
  expect(delRes.status()).toBe(204);

  // Subsequent list no longer includes the revoked session.
  const listRes = await request.get(`${server.baseUrl}/v1/account/web-sessions`, {
    headers: authHeader(seed.plaintext),
  });
  const list = (await listRes.json()) as WebSessionListResponse;
  expect(list.data.find((d) => d.id === publicId)).toBeUndefined();
});

test('DELETE /v1/account/web-sessions/:id 404 on unknown id', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.delete(
    `${server.baseUrl}/v1/account/web-sessions/wsess_${randomUUID()}`,
    { headers: authHeader(seed.plaintext) },
  );
  expect(res.status()).toBe(404);
});

test('DELETE /v1/account/web-sessions?keep=current 400 for API-key caller', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.delete(`${server.baseUrl}/v1/account/web-sessions?keep=current`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(400);
});

test('DELETE bulk requires ?keep=current — without it returns 400', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.delete(`${server.baseUrl}/v1/account/web-sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(400);
});

test('web-sessions routes return 401 without auth', async ({ request }) => {
  const eps = [
    { method: 'get' as const, path: '/v1/account/web-sessions' },
    {
      method: 'delete' as const,
      path: `/v1/account/web-sessions/wsess_${randomUUID()}`,
    },
    {
      method: 'delete' as const,
      path: '/v1/account/web-sessions?keep=current',
    },
  ];
  for (const ep of eps) {
    const res = await request[ep.method](`${server.baseUrl}${ep.path}`);
    expect(res.status(), `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
  }
});
