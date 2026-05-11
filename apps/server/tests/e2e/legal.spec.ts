// V-540.B-6 — E2E walkthrough of /v1/legal/* routes.
//
// Covers:
//  - GET /v1/legal/documents returns the catalog with required fields.
//  - GET /v1/legal/required returns rows the calling account must
//    accept (V-049 — fresh accounts that opted out of pre-acceptance
//    in seedAccount show all 4 documents).
//  - POST /v1/legal/accept records a fresh acceptance.
//  - POST /v1/legal/accept 409 on stale version / hash mismatch.
//  - POST /v1/legal/accept 404 on unknown document_key.
//  - 401 unauth on all three routes.
//
// The catalog is built from `docs/legal/*.md` at server start; the
// test relies on at least one document existing in the catalog (the
// seedAccount helper already validates this assumption by using the
// catalog to pre-accept on the default path).

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

interface CatalogEntry {
  document_key: string;
  title: string;
  version: string;
  effective_date: string;
  content_hash: string;
  source_path: string;
  byte_size: number;
}

interface RequiredEntry {
  document_key: string;
  current_version: string;
  content_hash: string;
  reason: string;
  last_accepted_version: string | null;
}

test('GET /v1/legal/documents returns the catalog with required fields', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/legal/documents`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: CatalogEntry[] };
  expect(Array.isArray(body.data)).toBe(true);
  expect(body.data.length).toBeGreaterThan(0);
  for (const entry of body.data) {
    expect(typeof entry.document_key).toBe('string');
    expect(typeof entry.title).toBe('string');
    expect(typeof entry.version).toBe('string');
    expect(typeof entry.content_hash).toBe('string');
    expect(typeof entry.byte_size).toBe('number');
    expect(entry.byte_size).toBeGreaterThan(0);
  }
});

test('GET /v1/legal/required returns empty for a pre-accepted account', async ({ request }) => {
  const seed = await seedAccount(server.client); // pre-acceptance default
  const res = await request.get(`${server.baseUrl}/v1/legal/required`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: RequiredEntry[] };
  expect(body.data).toEqual([]);
});

test('GET /v1/legal/required returns rows for a not-yet-accepted account', async ({ request }) => {
  const seed = await seedAccount(server.client, { skipLegalAcceptance: true });
  const res = await request.get(`${server.baseUrl}/v1/legal/required`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as { data: RequiredEntry[] };
  expect(body.data.length).toBeGreaterThan(0);
  for (const entry of body.data) {
    expect(entry.last_accepted_version).toBeNull();
  }
});

test('POST /v1/legal/accept records an acceptance with the current version', async ({
  request,
}) => {
  const seed = await seedAccount(server.client, { skipLegalAcceptance: true });
  const headers = authHeader(seed.plaintext);

  const catalog = (await (
    await request.get(`${server.baseUrl}/v1/legal/documents`, { headers })
  ).json()) as { data: CatalogEntry[] };
  const first = catalog.data[0];
  if (!first) return;

  const res = await request.post(`${server.baseUrl}/v1/legal/accept`, {
    headers,
    data: {
      document_key: first.document_key,
      version: first.version,
      content_hash: first.content_hash,
    },
  });
  expect(res.status()).toBe(201);
  const body = (await res.json()) as { id: string; document_key: string; version: string };
  expect(body.id).toMatch(/^lacc_/);
  expect(body.document_key).toBe(first.document_key);
  expect(body.version).toBe(first.version);

  // After accept, /required no longer lists this document.
  const required = (await (
    await request.get(`${server.baseUrl}/v1/legal/required`, { headers })
  ).json()) as { data: RequiredEntry[] };
  expect(required.data.find((d) => d.document_key === first.document_key)).toBeUndefined();
});

test('POST /v1/legal/accept 409 on stale version / hash mismatch', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const headers = authHeader(seed.plaintext);
  const catalog = (await (
    await request.get(`${server.baseUrl}/v1/legal/documents`, { headers })
  ).json()) as { data: CatalogEntry[] };
  const first = catalog.data[0];
  if (!first) return;

  const res = await request.post(`${server.baseUrl}/v1/legal/accept`, {
    headers,
    data: {
      document_key: first.document_key,
      version: first.version,
      // Wrong hash → server replies 409 with the current hash.
      content_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
  });
  expect(res.status()).toBe(409);
});

test('POST /v1/legal/accept 404 on unknown document_key', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.post(`${server.baseUrl}/v1/legal/accept`, {
    headers: authHeader(seed.plaintext),
    data: {
      document_key: 'no-such-document',
      version: '1.0.0',
      content_hash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
    },
  });
  expect(res.status()).toBe(404);
});

test('legal endpoints return 401 without auth', async ({ request }) => {
  const eps = [
    { method: 'get' as const, path: '/v1/legal/documents' },
    { method: 'get' as const, path: '/v1/legal/required' },
    {
      method: 'post' as const,
      path: '/v1/legal/accept',
      data: { document_key: 'x', version: '1', content_hash: 'sha256:0' },
    },
  ];
  for (const ep of eps) {
    const res = await request[ep.method](`${server.baseUrl}${ep.path}`, { data: ep.data });
    expect(res.status(), `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
  }
});
