// V-540.B-10 — E2E walkthrough of the V-460 CLI/GUI activation
// flow: initiate → bind → exchange.
//
// The CLI tool runs initiate to receive a code + browser URL,
// opens that URL for the user, who signs in and authorises (the
// bind happens server-side from the dashboard with their existing
// bearer token), then the CLI polls exchange until status flips
// from pending to bound, at which point it receives the issued
// API key.
//
// Covered:
//  - initiate without auth issues a code + browser URL + expiry.
//  - initiate is rate-shaped but reachable un-authenticated.
//  - exchange BEFORE bind returns status=pending.
//  - bind (with the dashboard's bearer token) flips the
//    authorization to bound.
//  - exchange AFTER bind returns the issued plaintext API key +
//    account id.
//  - exchange with a wrong state returns 400 even if code matches.
//  - exchange with an unknown code returns status=expired.
//  - bind with a wrong state returns 400.
//  - bind with a wrong device verification code stays pending.

import { test, expect } from '@playwright/test';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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

interface InitiateResponse {
  code: string;
  user_code: string;
  browser_url: string;
  expires_at: string;
}

interface ExchangePending {
  status: 'pending' | 'bound' | 'expired';
  api_key?: string;
  account_id?: string;
}

interface BindOk {
  ok: true;
  account_id: string;
  expires_at: string;
}

async function seedDashboardSession(accountId: string): Promise<string> {
  const token = randomBytes(32).toString('base64url');
  const tokenHash = createHash('sha256').update(token).digest('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
  await server.client`
    INSERT INTO web_sessions
      (id, account_id, token_hash, expires_at, user_agent, last_used_at)
    VALUES (${randomUUID()}, ${accountId}, ${tokenHash}, ${expiresAt}::timestamptz,
            ${'Driftstack E2E dashboard'}, NOW())
  `;
  return token;
}

test('POST /v1/auth/cli-authorize/initiate issues a code + browser URL', async ({ request }) => {
  // 2026-05-21 — schema requires state >= 16 chars (CSRF entropy floor).
  // Previous fixture 'state-token-abc' was 15 chars → 400. Pad.
  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
    data: { state: 'state-token-abcdef', client_label: 'driftstack-cli/0.1.0' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as InitiateResponse;
  expect(typeof body.code).toBe('string');
  expect(body.code.length).toBeGreaterThan(0);
  expect(body.user_code).toMatch(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/);
  expect(body.browser_url).toMatch(/^https?:\/\//);
  expect(new Date(body.expires_at).getTime()).toBeGreaterThan(Date.now());
});

test('initiate works without an Authorization header (CLI is pre-auth)', async ({ request }) => {
  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
    data: { state: 'no-auth-state-token' },
  });
  expect(res.status()).toBe(200);
});

test('exchange before bind returns status=pending', async ({ request }) => {
  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state: 'state-pending-0000' },
    })
  ).json()) as InitiateResponse;

  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/exchange`, {
    data: { code: init.code, state: 'state-pending-0000' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as ExchangePending;
  expect(body.status).toBe('pending');
  expect(body.api_key).toBeUndefined();
});

test('full happy path: initiate → bind → exchange returns the issued API key', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const sessionToken = await seedDashboardSession(seed.accountId);

  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state: 'happy-path-state' },
    })
  ).json()) as InitiateResponse;

  const bindRes = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/bind-device-code`, {
    headers: authHeader(sessionToken),
    data: { code: init.code, state: 'happy-path-state', user_code: init.user_code },
  });
  expect(bindRes.status()).toBe(200);
  const bind = (await bindRes.json()) as BindOk;
  expect(bind.ok).toBe(true);
  expect(bind.account_id).toBe(`acc_${seed.accountId}`);

  const exchange = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/exchange`, {
      data: { code: init.code, state: 'happy-path-state' },
    })
  ).json()) as ExchangePending;
  expect(exchange.status).toBe('bound');
  expect(typeof exchange.api_key).toBe('string');
  expect(exchange.api_key?.length).toBeGreaterThan(20);
  expect(exchange.account_id).toBe(`acc_${seed.accountId}`);
});

test('exchange with a mismatched state returns 400 (state_mismatch)', async ({ request }) => {
  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state: 'real-state-token0' },
    })
  ).json()) as InitiateResponse;

  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/exchange`, {
    data: { code: init.code, state: 'wrong-state-token' },
  });
  expect(res.status()).toBe(400);
});

test('exchange with an unknown code returns status=expired', async ({ request }) => {
  // 2026-05-21 — the service maps "code not in store" to
  // `{ status: 'expired' }` (cli-authorize.ts comment: "Either never
  // existed OR Redis evicted on TTL — treat both as expired from the
  // CLI / GUI's perspective"). The earlier expectation of 404 was
  // wrong; the route returns 200 + body.status='expired'. CLI loops
  // on expired the same way it loops on pending → restarts the flow.
  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/exchange`, {
    data: { code: 'definitely-not-a-real-code', state: 'state-padded-to-16+' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { status: string };
  expect(body.status).toBe('expired');
});

test('bind with a mismatched state returns 400', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const sessionToken = await seedDashboardSession(seed.accountId);
  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state: 'right-state-token' },
    })
  ).json()) as InitiateResponse;

  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/bind-device-code`, {
    headers: authHeader(sessionToken),
    data: { code: init.code, state: 'wrong-state-token', user_code: init.user_code },
  });
  expect(res.status()).toBe(400);
});

test('bind with a mismatched device verification code stays pending', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const sessionToken = await seedDashboardSession(seed.accountId);
  const state = 'device-code-state';
  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state },
    })
  ).json()) as InitiateResponse;
  const wrongUserCode = (init.user_code.startsWith('A') ? 'B' : 'A') + init.user_code.slice(1);

  const bind = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/bind-device-code`, {
    headers: authHeader(sessionToken),
    data: { code: init.code, state, user_code: wrongUserCode },
  });
  expect(bind.status()).toBe(400);

  const exchange = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/exchange`, {
    data: { code: init.code, state },
  });
  expect(exchange.status()).toBe(200);
  expect(((await exchange.json()) as ExchangePending).status).toBe('pending');
});

test('bind requires auth (401 without Authorization)', async ({ request }) => {
  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state: 'no-auth-bind-token0' },
    })
  ).json()) as InitiateResponse;
  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/bind-device-code`, {
    data: { code: init.code, state: 'no-auth-bind-token0', user_code: init.user_code },
  });
  expect(res.status()).toBe(401);
});
