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
//  - exchange with an unknown code returns 404.
//  - bind with a wrong state returns 400.

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

interface InitiateResponse {
  code: string;
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

  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state: 'happy-path-state' },
    })
  ).json()) as InitiateResponse;

  const bindRes = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/bind`, {
    headers: authHeader(seed.plaintext),
    data: { code: init.code, state: 'happy-path-state' },
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

test('exchange with an unknown code returns 404', async ({ request }) => {
  // 2026-05-21 — exchange schema requires state >= 16 chars. The unknown-code
  // assertion stays meaningful with a well-formed state — the route still
  // looks up the code first and 404s before checking state semantics.
  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/exchange`, {
    data: { code: 'definitely-not-a-real-code', state: 'state-padded-to-16+' },
  });
  expect(res.status()).toBe(404);
});

test('bind with a mismatched state returns 400', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state: 'right-state-token' },
    })
  ).json()) as InitiateResponse;

  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/bind`, {
    headers: authHeader(seed.plaintext),
    data: { code: init.code, state: 'wrong-state-token' },
  });
  expect(res.status()).toBe(400);
});

test('bind requires auth (401 without Authorization)', async ({ request }) => {
  const init = (await (
    await request.post(`${server.baseUrl}/v1/auth/cli-authorize/initiate`, {
      data: { state: 'no-auth-bind-token0' },
    })
  ).json()) as InitiateResponse;
  const res = await request.post(`${server.baseUrl}/v1/auth/cli-authorize/bind`, {
    data: { code: init.code, state: 'no-auth-bind-token0' },
  });
  expect(res.status()).toBe(401);
});
