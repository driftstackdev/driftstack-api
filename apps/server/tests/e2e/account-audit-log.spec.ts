// V-540.B-4 — E2E walkthrough of /v1/account/audit-log read + export.
//
// Covers:
//  - happy-path GET returns the customer's own audit entries.
//  - empty-state (no audit rows) returns data: [], next_cursor: null.
//  - cursor pagination correctness across two pages.
//  - action filter narrows to the requested action.
//  - GET .../export?format=json returns all rows as JSON.
//  - GET .../export?format=csv returns CSV with the documented header.
//  - 401 unauth on read + export.

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

interface AuditEntry {
  id: string;
  account_id: string;
  actor_type: string;
  action: string;
  target_resource_id: string | null;
  timestamp: string;
  payload: unknown;
}

interface AuditListResponse {
  data: AuditEntry[];
  next_cursor: string | null;
}

async function insertAuditRows(
  client: TestServer['client'],
  accountId: string,
  rows: Array<{ action: string; targetResourceId?: string; offsetMs?: number }>,
): Promise<void> {
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!row) continue;
    const ts = new Date(Date.now() - (row.offsetMs ?? i * 1000));
    await client`
      INSERT INTO account_audit_log
        (account_id, actor_type, action, target_resource_id, payload, timestamp)
      VALUES (${accountId}, 'customer', ${row.action},
              ${row.targetResourceId ?? null}, '{}'::jsonb, ${ts})
    `;
  }
}

test('GET /v1/account/audit-log returns empty data for a fresh account', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/account/audit-log`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as AuditListResponse;
  expect(body.data).toEqual([]);
  expect(body.next_cursor).toBeNull();
});

test('GET /v1/account/audit-log returns the calling account audit rows newest-first', async ({
  request,
}) => {
  const seed = await seedAccount(server.client);
  await insertAuditRows(server.client, seed.accountId, [
    { action: 'profile.created', targetResourceId: 'prof_1', offsetMs: 3000 },
    { action: 'profile.updated', targetResourceId: 'prof_1', offsetMs: 2000 },
    { action: 'api_key.rotated', offsetMs: 1000 },
  ]);

  const res = await request.get(`${server.baseUrl}/v1/account/audit-log`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as AuditListResponse;
  expect(body.data).toHaveLength(3);
  expect(body.data[0]?.action).toBe('api_key.rotated');
  expect(body.data[1]?.action).toBe('profile.updated');
  expect(body.data[2]?.action).toBe('profile.created');
  for (const entry of body.data) {
    expect(entry.account_id).toBe(`acc_${seed.accountId}`);
    expect(entry.actor_type).toBe('customer');
  }
});

test('cursor pagination walks all pages', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const rows = Array.from({ length: 12 }, (_, i) => ({
    action: 'profile.updated',
    targetResourceId: `prof_${String(i)}`,
    offsetMs: (12 - i) * 1000,
  }));
  await insertAuditRows(server.client, seed.accountId, rows);

  const first = (await (
    await request.get(`${server.baseUrl}/v1/account/audit-log?limit=5`, {
      headers: authHeader(seed.plaintext),
    })
  ).json()) as AuditListResponse;
  expect(first.data).toHaveLength(5);
  expect(first.next_cursor).not.toBeNull();

  const second = (await (
    await request.get(
      `${server.baseUrl}/v1/account/audit-log?limit=5&cursor=${encodeURIComponent(
        first.next_cursor ?? '',
      )}`,
      { headers: authHeader(seed.plaintext) },
    )
  ).json()) as AuditListResponse;
  expect(second.data).toHaveLength(5);

  const third = (await (
    await request.get(
      `${server.baseUrl}/v1/account/audit-log?limit=5&cursor=${encodeURIComponent(
        second.next_cursor ?? '',
      )}`,
      { headers: authHeader(seed.plaintext) },
    )
  ).json()) as AuditListResponse;
  expect(third.data).toHaveLength(2);
  expect(third.next_cursor).toBeNull();

  // No overlap between pages.
  const allIds = [...first.data, ...second.data, ...third.data].map((e) => e.id);
  expect(new Set(allIds).size).toBe(12);
});

test('action filter narrows to matching rows only', async ({ request }) => {
  const seed = await seedAccount(server.client);
  await insertAuditRows(server.client, seed.accountId, [
    { action: 'profile.created', targetResourceId: 'prof_a', offsetMs: 3000 },
    { action: 'profile.updated', targetResourceId: 'prof_a', offsetMs: 2000 },
    { action: 'api_key.rotated', offsetMs: 1000 },
  ]);

  const res = await request.get(`${server.baseUrl}/v1/account/audit-log?action=profile.updated`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as AuditListResponse;
  expect(body.data).toHaveLength(1);
  expect(body.data[0]?.action).toBe('profile.updated');
});

test('export?format=json returns all rows as JSON array', async ({ request }) => {
  const seed = await seedAccount(server.client);
  await insertAuditRows(server.client, seed.accountId, [
    { action: 'profile.created', targetResourceId: 'prof_a' },
    { action: 'profile.updated', targetResourceId: 'prof_a' },
  ]);

  const res = await request.get(`${server.baseUrl}/v1/account/audit-log/export?format=json`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/application\/json/);
  const body = (await res.json()) as { data: AuditEntry[]; truncated: boolean };
  expect(body.data.length).toBe(2);
  expect(body.truncated).toBe(false);
});

test('export?format=csv returns CSV with the documented header', async ({ request }) => {
  const seed = await seedAccount(server.client);
  await insertAuditRows(server.client, seed.accountId, [
    { action: 'profile.created', targetResourceId: 'prof_a' },
  ]);

  const res = await request.get(`${server.baseUrl}/v1/account/audit-log/export?format=csv`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toMatch(/text\/csv/);
  const text = await res.text();
  const firstLine = text.split('\n')[0] ?? '';
  expect(firstLine).toContain('timestamp');
  expect(firstLine).toContain('action');
  expect(firstLine).toContain('actor_type');
  expect(text).toContain('profile.created');
});

test('GET /v1/account/audit-log returns 401 without auth', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/account/audit-log`);
  expect(res.status()).toBe(401);
});

test('GET /v1/account/audit-log/export returns 401 without auth', async ({ request }) => {
  const res = await request.get(`${server.baseUrl}/v1/account/audit-log/export`);
  expect(res.status()).toBe(401);
});
