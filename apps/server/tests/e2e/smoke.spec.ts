// Smoke spec — verifies the e2e wire-up works end-to-end: server boots,
// migrations apply to the worker schema, /health responds 200, /openapi.json
// returns 3.1, and reset/cleanup work cleanly.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';

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

test('GET /health returns ok', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/health`);
  expect(res.status()).toBe(200);
  expect(await res.json()).toEqual({ ok: true });
});

test('GET /openapi.json returns OpenAPI 3.1 doc', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/openapi.json`);
  expect(res.status()).toBe(200);
  const body = (await res.json()) as Record<string, unknown>;
  expect(body.openapi).toBe('3.1.0');
});

test('GET /v1/sessions without auth returns 401 problem+json', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/sessions`);
  expect(res.status()).toBe(401);
  expect(res.headers()['content-type']).toMatch(/application\/problem\+json/);
});

test('worker schema persists across tests within the worker', async () => {
  const result = await server.client.unsafe<Array<{ count: number }>>(
    'SELECT count(*)::int FROM accounts',
  );
  expect(result[0]?.count).toBe(0);
});
