// E2E OpenAPI contract validation. For every happy-path response the API
// produces, validate the body against the response schema declared in
// /openapi.json. Catches drift between the published contract and the
// route implementations.
//
// This file uses Ajv against dynamically-loaded JSON Schema documents.
// typescript-eslint can't resolve Ajv's typing through its module-resolution
// in this workspace (works under tsc, fails under @typescript-eslint/parser
// which seems to pick up an older ajv@6 from a transitive hoist). The unsafe-*
// rules are noise here — the runtime is well-typed and tested end-to-end.

/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access */

import { test, expect } from '@playwright/test';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';

type AjvInstance = InstanceType<typeof Ajv>;
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

interface OpenApiContent {
  schema?: Record<string, unknown>;
}
interface OpenApiResponse {
  content?: Record<string, OpenApiContent>;
}
interface OpenApiOperation {
  responses?: Record<string, OpenApiResponse>;
}
interface OpenApiSpec {
  paths?: Record<string, Record<string, OpenApiOperation>>;
  components?: { schemas?: Record<string, Record<string, unknown>> };
}

let server: TestServer;
let spec: OpenApiSpec;
let ajv: AjvInstance;

test.beforeAll(async ({ request }) => {
  server = await startTestServer();
  const res = await request.get(`${server.baseUrl}/openapi.json`);
  spec = (await res.json()) as OpenApiSpec;

  ajv = new Ajv({ strict: false, allErrors: true });
  addFormats(ajv);

  for (const [name, schema] of Object.entries(spec.components?.schemas ?? {})) {
    ajv.addSchema(schema, `#/components/schemas/${name}`);
  }
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

function compileResponseSchema(
  pathPattern: string,
  method: string,
  status: number,
  contentType: string = 'application/json',
): { validate: ValidateFunction; haveSchema: true } | { haveSchema: false; reason: string } {
  const op = spec.paths?.[pathPattern]?.[method];
  if (!op) return { haveSchema: false, reason: `no ${method} ${pathPattern} in spec` };
  const response = op.responses?.[String(status)];
  if (!response)
    return {
      haveSchema: false,
      reason: `no ${String(status)} declared for ${method} ${pathPattern}`,
    };
  const schema = response.content?.[contentType]?.schema;
  if (!schema)
    return {
      haveSchema: false,
      reason: `no ${contentType} schema for ${method} ${pathPattern} ${String(status)}`,
    };
  return { validate: ajv.compile(schema), haveSchema: true };
}

function assertMatches(
  pathPattern: string,
  method: string,
  status: number,
  body: unknown,
  contentType: string = 'application/json',
): void {
  const compiled = compileResponseSchema(pathPattern, method, status, contentType);
  if (!compiled.haveSchema) throw new Error(compiled.reason);
  const ok = compiled.validate(body);
  if (!ok)
    throw new Error(`OpenAPI validation failed: ${ajv.errorsText(compiled.validate.errors)}`);
}

test('POST /v1/sessions response matches Session schema', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
    data: {},
  });
  expect(res.status()).toBe(201);
  assertMatches('/v1/sessions', 'post', 201, await res.json());
});

test('GET /v1/sessions response matches paginated schema', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  assertMatches('/v1/sessions', 'get', 200, await res.json());
});

test('POST /v1/api-keys response matches CreateApiKeyResponse schema', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/api-keys`, {
    headers: authHeader(seed.plaintext),
    data: { name: 'contract', scopes: ['read'] },
  });
  expect(res.status()).toBe(201);
  assertMatches('/v1/api-keys', 'post', 201, await res.json());
});

test('GET /v1/usage response matches UsagePeriodSummary schema', async ({ request }) => {
  const seed = await seedAccount(server.client, { tier: 'scale' });
  const res = await request.get(`${server.baseUrl}/v1/usage`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  assertMatches('/v1/usage', 'get', 200, await res.json());
});

test('error response matches Problem schema', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/sessions`);
  expect(res.status()).toBe(401);
  assertMatches('/v1/sessions', 'get', 401, await res.json(), 'application/problem+json');
});
