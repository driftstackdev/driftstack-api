// V-1596 — every error the surface returns is a problem+json document.
//
// `openapi.json` declares 1114 error responses, all of them
// `application/problem+json` with a `$ref` to the `Problem` schema —
// `type`, `title`, `status`, `detail`, `instance`. That is generated from the
// route definitions and says nothing about what the server actually writes on the
// wire, which is the same gap the bearer-enforcement spec exists for: a handler
// that answers a bare JSON object, or drops `type`, keeps its declaration.
//
// The SDKs make this load-bearing rather than cosmetic. `docs/decisions.md`
// records the TypeScript SDK carrying "17 typed error classes mirroring the
// server's RFC 7807 problem-types", and those classes dispatch on `type`. An
// error that arrives without it is not a typed error to any of them.
//
// One extension member is emitted and is NOT in the schema: validation failures
// add `issues`, carrying the field-level detail. RFC 7807 allows extensions and
// `Problem` sets `additionalProperties: {}`, so this is legal rather than broken —
// but it is undeclared, and `AgentMessageConflictProblem` shows this document
// declares its extensions when it means to. It is allowlisted below so it stays
// visible, and so a SECOND undeclared member has to be added here deliberately
// rather than arriving unnoticed.

import { test, expect } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';

/** The five members `Problem` declares. */
const PROBLEM_MEMBERS = ['type', 'title', 'status', 'detail', 'instance'] as const;

/**
 * Extension members the server emits that the schema does not name.
 *
 * Kept as a roster rather than an "anything goes" rule: the point of the arm
 * below is that a new one is a decision someone makes here, not a surprise a
 * client discovers.
 */
const DECLARED_EXTENSIONS = new Set<string>(['issues']);

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('every error response is problem+json carrying the members Problem declares', async ({
  request,
}) => {
  await server.resetState();

  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const auth = authHeader(admin.plaintext);
  const ID = '11111111-2222-3333-4444-555555555555';

  // Deliberately spread across the ways an error is produced, because they come
  // from different layers: a route-level shape check, a repo lookup that misses,
  // the auth preHandler, a zod schema, and Fastify's own not-found handler. A
  // sweep of one kind would prove only that one layer is consistent.
  const cases: Array<{ url: string; headers: Record<string, string>; why: string }> = [
    { url: '/v1/admin/usage/accounts/not-a-uuid', headers: auth, why: 'route shape check' },
    { url: `/v1/admin/usage/accounts/acc_${ID}`, headers: auth, why: 'lookup miss' },
    { url: '/v1/admin/accounts', headers: {}, why: 'missing credentials' },
    { url: `/v1/sessions/${ID}`, headers: auth, why: 'customer lookup' },
    { url: '/v1/admin/webhook-dlq?limit=abc', headers: auth, why: 'query schema' },
    { url: '/v1/admin/crypto-orders?account_id=acc_other', headers: auth, why: 'filter shape' },
    { url: '/v1/nope-not-a-route', headers: auth, why: 'no such route' },
    { url: '/v1/admin/audit-log?limit=-1', headers: auth, why: 'out-of-range bound' },
  ];

  const wrongType: string[] = [];
  const missingMembers: string[] = [];
  const undeclared: string[] = [];
  let checked = 0;

  for (const c of cases) {
    const res = await request.get(server.baseUrl + c.url, { headers: c.headers });
    const status = res.status();
    // A case that stopped producing an error proves nothing about error shape,
    // and silently dropping it would shrink this sweep without saying so.
    expect(status, `${c.why} still produces an error`).toBeGreaterThanOrEqual(400);
    checked += 1;

    const contentType = (res.headers()['content-type'] ?? '(none)').split(';')[0];
    if (contentType !== 'application/problem+json') {
      wrongType.push(`${c.why} (${c.url}) -> ${contentType}`);
    }

    let body: Record<string, unknown> = {};
    try {
      body = JSON.parse(await res.text()) as Record<string, unknown>;
    } catch {
      body = {};
    }
    for (const member of PROBLEM_MEMBERS) {
      if (!(member in body)) missingMembers.push(`${c.why} (${c.url}) missing "${member}"`);
    }
    for (const key of Object.keys(body)) {
      if ((PROBLEM_MEMBERS as readonly string[]).includes(key)) continue;
      if (DECLARED_EXTENSIONS.has(key)) continue;
      undeclared.push(`${c.why} (${c.url}) -> "${key}"`);
    }
  }

  expect(checked, 'every error-producing case was actually exercised').toBe(cases.length);

  expect(
    wrongType,
    'the document declares application/problem+json on all 1114 error responses',
  ).toEqual([]);

  expect(
    missingMembers,
    'the SDKs dispatch on these members; an error missing one is not a typed error',
  ).toEqual([]);

  expect(
    undeclared,
    'an extension member the schema does not name and this spec has not allowlisted',
  ).toEqual([]);
});
