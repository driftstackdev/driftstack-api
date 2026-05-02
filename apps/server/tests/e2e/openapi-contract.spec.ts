// E2E contract validation. For every happy-path response the API produces,
// validate the body against the SAME Zod schema the route uses (sourced from
// @driftstack/api-types — the single source of truth for the public contract,
// which is also what the OpenAPI spec is generated from).
//
// This approach avoids the ajv/JSON-Schema route entirely; the OpenAPI spec
// at /openapi.json is downstream of the same Zod schemas, so validating
// against the source-of-truth Zod is equivalent and simpler.

import { test, expect } from '@playwright/test';
import {
  CreateApiKeyResponseSchema,
  CreateSessionResponseSchema,
  NavigateResponseSchema,
  ProblemSchema,
  SessionSchema,
  UsagePeriodSummarySchema,
} from '@driftstack/api-types';
import { z } from 'zod';
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

const PaginatedSessionsSchema = z.object({
  data: z.array(SessionSchema),
  has_more: z.boolean(),
  next_cursor: z.string().nullable(),
});

test('POST /v1/sessions response matches Session schema', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: {},
  });
  expect(res.status()).toBe(201);
  CreateSessionResponseSchema.parse(await res.json());
});

test('GET /v1/sessions response matches paginated Session schema', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  PaginatedSessionsSchema.parse(await res.json());
});

test('POST /v1/sessions/:id/navigate response matches NavigateResponse schema', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  const create = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: {},
  });
  const session = (await create.json()) as { id: string };
  const res = await request.post(`${server.baseUrl}/v1/sessions/${session.id}/navigate`, {
    headers: authHeader(seed.plaintext),
    data: { url: 'https://example.com' },
  });
  expect(res.status()).toBe(200);
  NavigateResponseSchema.parse(await res.json());
});

test('POST /v1/api-keys response matches CreateApiKeyResponse schema', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(seed.plaintext),
    data: { name: 'contract', scopes: ['read'] },
  });
  expect(res.status()).toBe(201);
  CreateApiKeyResponseSchema.parse(await res.json());
});

test('GET /v1/usage response matches UsagePeriodSummary schema', async ({ request }) => {
  const seed = await seedAccount(server.client, { tier: 'scale' });
  const res = await request.get(`${server.baseUrl}/v1/usage`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  UsagePeriodSummarySchema.parse(await res.json());
});

test('error response matches Problem schema', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/sessions`);
  expect(res.status()).toBe(401);
  ProblemSchema.parse(await res.json());
});

test('OpenAPI spec at /openapi.json is well-formed 3.1', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/openapi.json`);
  expect(res.status()).toBe(200);
  const spec = (await res.json()) as { openapi: string; paths: Record<string, unknown> };
  expect(spec.openapi).toBe('3.1.0');
  // Spot-check that the major endpoints are advertised.
  expect(spec.paths).toHaveProperty('/v1/sessions');
  expect(spec.paths).toHaveProperty('/v1/api-keys');
  expect(spec.paths).toHaveProperty('/v1/usage');
});
