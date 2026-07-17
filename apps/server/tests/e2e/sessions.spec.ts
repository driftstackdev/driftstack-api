// E2E session endpoints — all 8 endpoints × happy path + every documented
// error case via real HTTP through the Drizzle stack.

import { test, expect, type APIRequestContext } from '@playwright/test';
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

interface CreatedSession {
  id: string;
  status: string;
  archetype: string;
}

async function createSession(
  request: APIRequestContext,
  base: string,
  plaintext: string,
  body: Record<string, unknown> = {},
): Promise<CreatedSession> {
  const res = await request.post(`${base}/v1/sessions`, {
    headers: authHeader(plaintext),
    data: body,
  });
  if (res.status() !== 201) {
    throw new Error(`createSession returned ${String(res.status())}: ${await res.text()}`);
  }
  const json: unknown = await res.json();
  return json as CreatedSession;
}

// ── POST /v1/sessions ───────────────────────────────────────────────────────

test('POST /v1/sessions: 201 with full shape', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: { label: 'demo' },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.id).toMatch(/^ses_[0-9a-f-]{36}$/);
  expect(body.status).toBe('ready');
  // Default archetype was upgraded iphone16pro→iphone17 (migration 0072); the
  // sessions table DEFAULT is 'iphone17_ios18_7_safari26_4'. This e2e assertion
  // went stale undetected because the e2e job was SKIPPED for the whole window CI
  // was red on the core test job (e2e only runs once that job passes).
  expect(body.archetype).toBe('iphone17_ios18_7_safari26_4');
  expect(body.label).toBe('demo');
});

test('POST /v1/sessions: records "created" event in DB', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  let events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  await expect
    .poll(async () => {
      events = (await server.client`
        SELECT type, payload FROM session_events
        WHERE session_id = ${session.id.replace('ses_', '')}
      `) as Array<{ type: string; payload: Record<string, unknown> }>;
      return events.length;
    })
    .toBe(1);
  expect(events[0]).toEqual({
    type: 'created',
    payload: {
      archetype: 'iphone17_ios18_7_safari26_4',
      purpose: 'production_customer',
    },
  });
});

test('POST /v1/sessions: 429 ConcurrencyLimit when API-enabled single-session tier is at 1', async ({
  request,
}) => {
  const seed = await seedAccount(server.client, { tier: 'solo_manual' });
  await createSession(request, server.baseUrl, seed.plaintext);

  const res = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: {},
  });
  expect(res.status()).toBe(429);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.ConcurrencyLimit);
  expect(body.current_sessions).toBe(1);
  expect(body.limit).toBe(1);
});

test('POST /v1/sessions: 400 ValidationFailed on bad archetype slug', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: { archetype: 'iPhone16Pro' },
  });
  expect(res.status()).toBe(400);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.ValidationFailed);
});

// ── GET /v1/sessions ────────────────────────────────────────────────────────

test('GET /v1/sessions: empty initially', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: unknown[]; has_more: boolean };
  expect(body.data).toEqual([]);
  expect(body.has_more).toBe(false);
});

test('GET /v1/sessions: lists sessions in reverse-chrono order', async ({ request }) => {
  const seed = await seedAccount(server.client, { tier: 'api_builder' });
  await createSession(request, server.baseUrl, seed.plaintext, { label: 'a' });
  await createSession(request, server.baseUrl, seed.plaintext, { label: 'b' });
  await createSession(request, server.baseUrl, seed.plaintext, { label: 'c' });

  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  const body = (await res.json()) as { data: Array<{ label: string }> };
  expect(body.data.map((s) => s.label)).toEqual(['c', 'b', 'a']);
});

// ── POST /v1/sessions/:id/navigate ──────────────────────────────────────────

test('POST /:id/navigate: 200 happy path', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/navigate`, {
    headers: authHeader(seed.plaintext),
    data: { url: 'https://example.com' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.url).toBe('https://example.com');
  expect(body.final_url).toBe('https://example.com');
  expect(body.status).toBe(200);
});

test('POST /:id/navigate: 502 DriverError on error trigger', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/navigate`, {
    headers: authHeader(seed.plaintext),
    data: { url: 'https://error.driftstack-mock.test' },
  });
  expect(res.status()).toBe(502);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.DriverError);
});

test('POST /:id/navigate: returns status 500 for http500 trigger (not 502)', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/navigate`, {
    headers: authHeader(seed.plaintext),
    data: { url: 'https://http500.driftstack-mock.test' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.status).toBe(500); // simulated upstream HTTP 500, but driver call succeeded
});

test('POST /:id/navigate: 404 for unknown session id', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(
    `${server.baseUrl}/v1/sessions/ses_00000000-0000-4000-8000-000000000999/navigate`,
    {
      headers: authHeader(seed.plaintext),
      data: { url: 'https://example.com' },
    },
  );
  expect(res.status()).toBe(404);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.NotFound);
});

test('POST /:id/navigate: 400 BadRequest for wrong-prefix id', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(
    `${server.baseUrl}/v1/sessions/key_00000000-0000-4000-8000-000000000001/navigate`,
    {
      headers: authHeader(seed.plaintext),
      data: { url: 'https://example.com' },
    },
  );
  expect(res.status()).toBe(400);
});

// ── POST /:id/interact ──────────────────────────────────────────────────────

test('POST /:id/interact: 200 tap happy path', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/interact`, {
    headers: authHeader(seed.plaintext),
    data: { action: { kind: 'tap', selector: '#go' } },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.ok).toBe(true);
});

test('POST /:id/interact: 502 for #nonexistent selector trigger', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/interact`, {
    headers: authHeader(seed.plaintext),
    data: { action: { kind: 'tap', selector: '#nonexistent' } },
  });
  expect(res.status()).toBe(502);
});

// ── POST /:id/wait ──────────────────────────────────────────────────────────

test('POST /:id/wait: 200 satisfied=true for time condition', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/wait`, {
    headers: authHeader(seed.plaintext),
    data: { condition: { kind: 'time', ms: 0 } },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.satisfied).toBe(true);
});

// ── GET /:id/state ──────────────────────────────────────────────────────────

test('GET /:id/state: 200 reflects post-navigate state', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  await request.post(`${server.baseUrl}/v1/sessions/${session.id}/navigate`, {
    headers: authHeader(seed.plaintext),
    data: { url: 'https://example.com' },
  });
  const res = await request.get(`${server.baseUrl}/v1/sessions/${session.id}/state`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.url).toBe('https://example.com');
});

// ── POST /:id/capture ───────────────────────────────────────────────────────

test('POST /:id/capture: returns base64 PNG for screenshot', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/capture`, {
    headers: authHeader(seed.plaintext),
    data: { kind: 'screenshot' },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.kind).toBe('screenshot');
  expect(body.encoding).toBe('base64');
  expect(typeof body.data).toBe('string');
});

// ── DELETE /:id ─────────────────────────────────────────────────────────────

test('DELETE /:id: 204 then 410 SessionDestroyed on subsequent ops', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const session = await createSession(request, server.baseUrl, seed.plaintext);

  const del = await request.delete(`${server.baseUrl}/v1/sessions/${session.id}`, {
    headers: authHeader(seed.plaintext),
  });
  expect(del.status()).toBe(204);

  const navigate = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/navigate`, {
    headers: authHeader(seed.plaintext),
    data: { url: 'https://example.com' },
  });
  expect(navigate.status()).toBe(410);
  const body = (await navigate.json()) as Record<string, unknown>;
  expect(body.type).toBe(PROBLEM_TYPES.SessionDestroyed);
});

// ── Cross-account isolation ────────────────────────────────────────────────

test('cross-account: account B cannot see / operate on account A session', async ({ request }) => {
  const a = await seedAccount(server.client, { email: 'a@driftstack.test' });
  const b = await seedAccount(server.client, { email: 'b@driftstack.test' });
  const session = await createSession(request, server.baseUrl, a.plaintext);

  // B tries to navigate A's session id — must 404 (not 403; no info leak).
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/navigate`, {
    headers: authHeader(b.plaintext),
    data: { url: 'https://example.com' },
  });
  expect(res.status()).toBe(404);
});
