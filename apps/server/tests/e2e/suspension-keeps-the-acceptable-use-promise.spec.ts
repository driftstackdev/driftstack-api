// V-1042 — the AUP §5.2 suspension promise, checked against a running server.
//
// `docs/legal/acceptable-use-policy.md` tells customers exactly what suspension
// means. It is a legal document, so the four parts are worth quoting:
//
//   (a) existing Sessions are destroyed
//   (b) the API rejects authenticated requests with HTTP 403 carrying a problem
//       type `https://errors.driftstack.dev/forbidden`
//   (c) Customer-Provided Secrets are NOT deleted
//   (d) billing pauses — `pause_collection` with Stripe's `void` behaviour
//
// V-1020 verified (d) by tracing the call chain from `admin-accounts.suspend`
// through to Stripe. This file verifies (b) by asking the server, because (b) is
// the part a customer hits on their next request and the only one with a precise
// wire format attached to it.
//
// The integration suite already had an arm for this. It asserted
// `statusCode < 500` under a title saying "4xx", with a comment allowing a 200 —
// so a build where suspension did nothing on reads would have passed it. The
// server was never wrong; the assertion was, and it is tightened in the same
// commit as this file.
//
// SCOPE, stated rather than implied. Only (b) is exercised here:
//
//   (a) runs through the admin suspend path, which destroys sessions as a
//       best-effort reclaim. That needs a staff credential, not a status flip.
//   (c) concerns BYOK secrets, and this build answers 503 on the BYOK routes
//       because the feature is unwired — there is no customer-provided secret to
//       preserve, so the property cannot be observed here.
//   (d) needs Stripe.
//
// Flipping `accounts.status` directly, as this file does, exercises the AUTH gate
// and nothing else. That is the honest boundary of what it proves.

import { expect, test } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { authHeader, seedAccount } from './helpers/seed.js';

const PROMISED_TYPE = 'https://errors.driftstack.dev/forbidden';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test('a suspended account is refused with the status AND problem type the AUP names', async ({
  request,
}) => {
  const acct = await seedAccount(server.client, {
    email: `susp-${Date.now()}@driftstack.test`,
  });

  // Control: active, the same call succeeds — so the 403s below are the
  // suspension and not a broken key or a route that always refuses.
  const active = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(acct.plaintext),
  });
  expect(active.status(), 'the account works before suspension').toBe(200);

  await server.client`UPDATE accounts SET status = 'suspended' WHERE id = ${acct.accountId}`;

  // A read. The AUP says "authenticated requests", not "writes".
  const read = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(acct.plaintext),
    failOnStatusCode: false,
  });
  expect(read.status(), 'suspended read').toBe(403);
  const readBody = (await read.json()) as { type?: string; detail?: string };
  expect(readBody.type, 'the problem type promised in the AUP').toBe(PROMISED_TYPE);

  // A write, on a different route family, so this is the account status rather
  // than one route's own gate.
  const write = await request.post(`${server.baseUrl}/v1/profiles`, {
    headers: authHeader(acct.plaintext),
    data: { name: 'after-suspension' },
    failOnStatusCode: false,
  });
  expect(write.status(), 'suspended write').toBe(403);
  expect(
    ((await write.json()) as { type?: string }).type,
    'the problem type promised in the AUP',
  ).toBe(PROMISED_TYPE);
});

test('reinstating the account restores access', async ({ request }) => {
  // The AUP describes suspension as a state a customer can be reinstated from
  // ("Customer may dispute or remediate"). If the refusal were permanent — a
  // revoked key rather than a status gate — the promise would be different, so
  // the reversibility is part of what is being claimed.
  const acct = await seedAccount(server.client, {
    email: `reinstate-${Date.now()}@driftstack.test`,
  });
  await server.client`UPDATE accounts SET status = 'suspended' WHERE id = ${acct.accountId}`;

  const denied = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(acct.plaintext),
    failOnStatusCode: false,
  });
  expect(denied.status(), 'suspended').toBe(403);

  await server.client`UPDATE accounts SET status = 'active' WHERE id = ${acct.accountId}`;

  const restored = await request.get(`${server.baseUrl}/v1/account/me`, {
    headers: authHeader(acct.plaintext),
    failOnStatusCode: false,
  });
  expect(restored.status(), 'the same key works again after reinstatement').toBe(200);
});
