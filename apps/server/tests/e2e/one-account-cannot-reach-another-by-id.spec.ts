// V-1040 — account B cannot read or delete account A's resources by naming their id.
//
// This is the axis V-1025 measured statically and deliberately left unguarded. Of
// 72 parameterised customer routes, four handlers never mention an account, and all
// four turned out fine — but establishing that took reading a handler that resolves
// ownership roughly a hundred lines in, behind a delegate. V-1025's conclusion was
// that a static tenancy check "would have to see through one level of delegation,
// and one that cannot produces false reds until it gets tuned into uselessness".
//
// Running the server removes that problem entirely. Ownership either holds or it
// does not, and no amount of indirection hides the answer.
//
// The repo had exactly ONE cross-account test before this — `sessions.spec.ts`
// checks that B cannot navigate A's session — and it sets the convention for READS:
// 404, not 403. A 403 would confirm the id exists and belongs to someone, which is
// a disclosure in itself; 404 says only that the caller has nothing by that name.
//
// Writes are asserted on their EFFECT rather than their status, because measuring
// first showed the status says less than it appears to. Details at `expectHidden`.
//
// The mutation that matters: removing `eq(profiles.accountId, …)` from the profile
// delete's WHERE — a genuine cross-tenant delete — makes A's profile disappear and
// this file fails. That is the failure V-1025 could not guard by reading source.
//
// Each resource is created through the real API by A, so the ids are genuine rather
// than fabricated, and every attempt below uses B's key on A's id.

import { expect, test, type APIRequestContext } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { authHeader, seedAccount } from './helpers/seed.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

interface Pair {
  readonly aKey: string;
  readonly bKey: string;
}

async function seedPair(): Promise<Pair> {
  const a = await seedAccount(server.client, { email: `a-${Date.now()}@driftstack.test` });
  const b = await seedAccount(server.client, { email: `b-${Date.now()}@driftstack.test` });
  return { aKey: a.plaintext, bKey: b.plaintext };
}

async function createProfile(request: APIRequestContext, key: string): Promise<string> {
  const res = await request.post(`${server.baseUrl}/v1/profiles`, {
    headers: authHeader(key),
    data: { name: `p-${Math.floor(Date.now() % 100000)}` },
  });
  expect(res.status(), 'profile create').toBe(200);
  return ((await res.json()) as { id: string }).id;
}

async function createWebhook(request: APIRequestContext, key: string): Promise<string> {
  const res = await request.post(`${server.baseUrl}/v1/webhooks`, {
    headers: authHeader(key),
    data: { url: 'https://placeholder.test/webhook', events: ['session.completed'] },
  });
  expect(res.status(), 'webhook create').toBe(201);
  return ((await res.json()) as { id: string }).id;
}

/**
 * A cross-account READ must answer 404.
 *
 * 403 is NOT accepted, on the convention `sessions.spec.ts` already set: confirming
 * an id exists but belongs to someone else is a disclosure. If a route starts
 * answering 403, that is a decision to make deliberately, and this failing is where
 * it gets made.
 *
 * DELETE is deliberately NOT asserted this way, because measurement said otherwise.
 * `DELETE /v1/profiles/:id` answers 204 for another account's id — and equally for
 * an id that never existed anywhere, which is what makes it disclose nothing. It is
 * an idempotent delete affecting zero rows, not a cross-tenant one. The property
 * worth asserting there is that the owner's resource SURVIVES, which is what the
 * tests below check.
 */
async function expectHidden(
  request: APIRequestContext,
  method: 'get' | 'delete' | 'patch',
  path: string,
  key: string,
): Promise<void> {
  const res = await request[method](`${server.baseUrl}${path}`, {
    headers: authHeader(key),
    ...(method === 'patch' ? { data: {} } : {}),
    failOnStatusCode: false,
  });
  expect(res.status(), `${method.toUpperCase()} ${path} with another account's key`).toBe(404);
}

test("B cannot read or delete A's profile by id", async ({ request }) => {
  const { aKey, bKey } = await seedPair();
  const profileId = await createProfile(request, aKey);

  // Control: the owner CAN read it, so the 404s below are about ownership rather
  // than about the resource never having existed.
  const owner = await request.get(`${server.baseUrl}/v1/profiles/${profileId}`, {
    headers: authHeader(aKey),
  });
  expect(owner.status(), "the owner's own read").toBe(200);

  await expectHidden(request, 'get', `/v1/profiles/${profileId}`, bKey);
  // The delete is idempotent and answers 204 whether or not anything matched; the
  // load-bearing assertion is the one after it.
  await request.delete(`${server.baseUrl}/v1/profiles/${profileId}`, {
    headers: authHeader(bKey),
    failOnStatusCode: false,
  });

  // A's profile is still there — B's DELETE must not have removed it.
  const after = await request.get(`${server.baseUrl}/v1/profiles/${profileId}`, {
    headers: authHeader(aKey),
  });
  expect(after.status(), "the owner's profile survived B's delete attempt").toBe(200);
});

test("B cannot read or delete A's webhook endpoint by id", async ({ request }) => {
  const { aKey, bKey } = await seedPair();
  const webhookId = await createWebhook(request, aKey);

  const owner = await request.get(`${server.baseUrl}/v1/webhooks/${webhookId}`, {
    headers: authHeader(aKey),
  });
  expect(owner.status(), "the owner's own read").toBe(200);

  await expectHidden(request, 'get', `/v1/webhooks/${webhookId}`, bKey);
  await request.delete(`${server.baseUrl}/v1/webhooks/${webhookId}`, {
    headers: authHeader(bKey),
    failOnStatusCode: false,
  });

  const after = await request.get(`${server.baseUrl}/v1/webhooks/${webhookId}`, {
    headers: authHeader(aKey),
  });
  expect(after.status(), "the owner's endpoint survived B's delete attempt").toBe(200);
});

test("B cannot capture a snapshot against A's profile", async ({ request }) => {
  const { aKey, bKey } = await seedPair();
  const profileId = await createProfile(request, aKey);

  // A write path rather than a read: the snapshot route takes A's profile id in the
  // path and would attribute the capture to whoever asked.
  const res = await request.post(`${server.baseUrl}/v1/profiles/${profileId}/snapshots`, {
    headers: authHeader(bKey),
    data: {},
    failOnStatusCode: false,
  });
  // 404 (not yours) and 400 (body rejected before ownership is consulted) both
  // refuse without disclosing anything about A's profile. What must never happen is
  // a capture succeeding, so the assertion is on refusal rather than on one code.
  expect(
    [400, 404].includes(res.status()),
    `B capturing a snapshot of A's profile was answered ${res.status()}`,
  ).toBe(true);
});
