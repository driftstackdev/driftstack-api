// V-540.B-11 — E2E walkthrough of /v1/status/subscribe — the
// V-295c3 double-opt-in subscription flow for the public status
// page's incident-email notifications.
//
// Three legs:
//   1. POST /v1/status/subscribe { email } → 202; row created with
//      a confirm token hash; confirmation email queued.
//   2. GET /v1/status/subscribe/confirm?token=<plaintext> → 200;
//      sets confirmed_at; generates an unsubscribe token; clears
//      confirm token.
//   3. GET /v1/status/subscribe/unsubscribe?token=<unsub plaintext>
//      → 200; sets unsubscribed_at.
//
// All routes are public (no Authorization). IP rate-limited by the
// `ip:status-subscribe` gate; we don't exercise rate-limit boundary
// here — that's covered by the rate-limit spec.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { createHash, randomUUID } from 'node:crypto';

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

/** Read the confirm token from the DB given an email. The plaintext
 *  is never returned by the route — the test seeds the row directly
 *  with a known plaintext when it needs to call /confirm. */
async function seedSubscriberPending(
  client: TestServer['client'],
  email: string,
): Promise<{ confirmTokenPlain: string }> {
  const confirmTokenPlain = `cfm-${randomUUID()}`;
  const tokenHash = createHash('sha256').update(confirmTokenPlain).digest('hex');
  const expiresAt = new Date(Date.now() + 24 * 3600 * 1000);
  await client`
    INSERT INTO status_subscribers
      (email, confirm_token_hash, confirm_expires_at)
    VALUES (${email}, ${tokenHash}, ${expiresAt})
  `;
  return { confirmTokenPlain };
}

async function seedSubscriberConfirmed(
  client: TestServer['client'],
  email: string,
): Promise<{ unsubscribeTokenPlain: string }> {
  const unsubscribeTokenPlain = `uns-${randomUUID()}`;
  const tokenHash = createHash('sha256').update(unsubscribeTokenPlain).digest('hex');
  await client`
    INSERT INTO status_subscribers
      (email, unsubscribe_token_hash, confirmed_at)
    VALUES (${email}, ${tokenHash}, NOW())
  `;
  return { unsubscribeTokenPlain };
}

test('POST /v1/status/subscribe returns 202 + creates a pending row', async ({ request }) => {
  const res = await request.post(`${server.baseUrl}/v1/status/subscribe`, {
    data: { email: 'subscriber@example.test' },
  });
  expect(res.status()).toBe(202);

  const rows = await server.client`
    SELECT email, confirm_token_hash, confirmed_at
    FROM status_subscribers
    WHERE email = 'subscriber@example.test'
  `;
  expect(rows.length).toBe(1);
  expect(rows[0]?.confirm_token_hash).toBeTruthy();
  expect(rows[0]?.confirmed_at).toBeNull();
});

test('POST /v1/status/subscribe 400 on malformed email', async ({ request }) => {
  const res = await request.post(`${server.baseUrl}/v1/status/subscribe`, {
    data: { email: 'not-an-email' },
  });
  expect(res.status()).toBe(400);
});

test('POST /v1/status/subscribe 400 on missing email', async ({ request }) => {
  const res = await request.post(`${server.baseUrl}/v1/status/subscribe`, {
    data: {},
  });
  expect(res.status()).toBe(400);
});

test('GET /v1/status/subscribe/confirm flips a pending row to confirmed', async ({ request }) => {
  const email = 'confirm-me@example.test';
  const { confirmTokenPlain } = await seedSubscriberPending(server.client, email);

  const res = await request.get(
    `${server.baseUrl}/v1/status/subscribe/confirm?token=${encodeURIComponent(confirmTokenPlain)}`,
  );
  expect(res.status()).toBe(200);

  const rows = await server.client`
    SELECT confirmed_at, unsubscribe_token_hash, confirm_token_hash
    FROM status_subscribers
    WHERE email = ${email}
  `;
  expect(rows[0]?.confirmed_at).toBeTruthy();
  expect(rows[0]?.unsubscribe_token_hash).toBeTruthy();
  expect(rows[0]?.confirm_token_hash).toBeNull();
});

test('GET /v1/status/subscribe/confirm with an unknown token returns 4xx', async ({ request }) => {
  const res = await request.get(
    `${server.baseUrl}/v1/status/subscribe/confirm?token=${encodeURIComponent('not-a-real-token')}`,
  );
  expect(res.status()).toBeGreaterThanOrEqual(400);
  expect(res.status()).toBeLessThan(500);
});

test('GET /v1/status/subscribe/unsubscribe marks the row unsubscribed', async ({ request }) => {
  const email = 'leaving@example.test';
  const { unsubscribeTokenPlain } = await seedSubscriberConfirmed(server.client, email);

  const res = await request.get(
    `${server.baseUrl}/v1/status/subscribe/unsubscribe?token=${encodeURIComponent(unsubscribeTokenPlain)}`,
  );
  expect(res.status()).toBe(200);

  const rows = await server.client`
    SELECT unsubscribed_at
    FROM status_subscribers
    WHERE email = ${email}
  `;
  expect(rows[0]?.unsubscribed_at).toBeTruthy();
});

test('confirm endpoint 400 on missing token query param', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/status/subscribe/confirm`);
  expect(res.status()).toBe(400);
});

test('unsubscribe endpoint 400 on missing token query param', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/status/subscribe/unsubscribe`);
  expect(res.status()).toBe(400);
});
