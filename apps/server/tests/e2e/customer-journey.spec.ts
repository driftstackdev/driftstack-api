// Customer journey e2e — proves all the pieces interlock.
// Walks: create-account → create-scoped-key → create-session → navigate →
// interact → capture → destroy → revoke key → confirm 401.

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

test('full customer journey: account → key → session → ops → destroy → revoke', async ({
  request,
}) => {
  // Bootstrap account with admin scope (simulates founder/CLI provisioning).
  const admin = await seedAccount(server.client, { tier: 'api_builder' });

  // 1. Customer creates a scoped (read+write only) API key for their app.
  const createKeyRes = await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(admin.plaintext),
    data: { name: 'app-key', scopes: ['read', 'write'] },
  });
  expect(createKeyRes.status()).toBe(201);
  const appKey = (await createKeyRes.json()) as { id: string; plaintext: string };
  expect(appKey.plaintext.startsWith('ds_live_')).toBe(true);

  // 2. App creates a session.
  const createSessionRes = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(appKey.plaintext),
    data: { label: 'journey' },
  });
  expect(createSessionRes.status()).toBe(201);
  const session = (await createSessionRes.json()) as { id: string; status: string };
  expect(session.status).toBe('ready');

  // 3. Navigate.
  const navigateRes = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/navigate`, {
    headers: authHeader(appKey.plaintext),
    data: { url: 'https://example.com' },
  });
  expect(navigateRes.status()).toBe(200);

  // 4. Interact.
  const interactRes = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/interact`, {
    headers: authHeader(appKey.plaintext),
    data: { action: { kind: 'tap', selector: '#go' } },
  });
  expect(interactRes.status()).toBe(200);

  // 5. Capture.
  const captureRes = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/capture`, {
    headers: authHeader(appKey.plaintext),
    data: { kind: 'screenshot' },
  });
  expect(captureRes.status()).toBe(200);

  // 6. Destroy.
  const destroyRes = await request.delete(`${server.baseUrl}/v1/sessions/${session.id}`, {
    headers: authHeader(appKey.plaintext),
  });
  expect(destroyRes.status()).toBe(204);

  // 7. Admin revokes the app key.
  const revokeRes = await request.delete(`${server.baseUrl}/v1/api-keys/${appKey.id}`, {
    headers: authHeader(admin.plaintext),
  });
  expect(revokeRes.status()).toBe(204);

  // 8. App key is now unusable — subsequent ops 401.
  const afterRevokeRes = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(appKey.plaintext),
  });
  expect(afterRevokeRes.status()).toBe(401);

  // 9. Sanity: session_events for the journey are recorded for the session.
  const eventTypes = (await server.client`
    SELECT type FROM session_events
    WHERE session_id = ${session.id.replace('ses_', '')}
    ORDER BY created_at ASC
  `) as Array<{ type: string }>;
  const types = eventTypes.map((e) => e.type);
  expect(types).toContain('created');
  expect(types).toContain('navigated');
  expect(types).toContain('interacted');
  expect(types).toContain('screenshot_captured');
  expect(types).toContain('destroyed');
});
