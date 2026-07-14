// V-540.B-2 / V-667.B — E2E for the OAuth 2.0 routes.
//
// Covers the full happy-path dance end-to-end against the real
// Fastify app + PostgreSQL OAuth store. The unit tests at
// tests/unit/oauth.test.ts cover the OAuthService class in
// isolation; this spec verifies the route layer wiring + Zod
// validation + admin/public-route auth gating.

import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
import { drizzle } from 'drizzle-orm/postgres-js';
import { DrizzleOAuthStore } from '../../src/db/oauth-store.js';
import * as schema from '../../src/db/schema.js';
import { OAuthService } from '../../src/services/oauth.js';
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

function s256(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

interface SignupResponse {
  debug_token?: string;
}

interface SessionEnvelope {
  session: { token: string; account_id: string };
}

async function interactiveAuth(
  request: APIRequestContext,
  email: string,
): Promise<{ headers: { Authorization: string }; accountId: string }> {
  const signup = await request.post(`${server.baseUrl}/v1/auth/signup`, {
    data: { email, password: 'correct horse battery staple' },
  });
  expect(signup.status()).toBe(200);
  const verificationToken = ((await signup.json()) as SignupResponse).debug_token;
  expect(verificationToken).toBeTruthy();

  const verify = await request.post(`${server.baseUrl}/v1/auth/verify-email`, {
    data: { token: verificationToken },
  });
  expect(verify.status()).toBe(200);
  const session = ((await verify.json()) as SessionEnvelope).session;
  return {
    headers: authHeader(session.token),
    accountId: session.account_id.replace(/^acc_/, ''),
  };
}

test('POST /v1/admin/oauth/clients — requires internal-admin scope', async ({ request }) => {
  // 2026-05-21 — seedAccount's DEFAULT scopes are ['read', 'write', 'admin'];
  // V-174's admin alias satisfies 'driftstack_internal_admin', so the
  // default seed would pass the gate. Drop 'admin' so the scope check
  // actually fires.
  const seed = await seedAccount(server.client, { scopes: ['read', 'write'] });
  const res = await request.post(`${server.baseUrl}/v1/admin/oauth/clients`, {
    headers: authHeader(seed.plaintext),
    data: { label: 'App', redirect_uris: ['https://app.example/cb'] },
  });
  // 401 OR 403 depending on the auth gate's policy; both indicate the
  // scope-protected path didn't open.
  expect([401, 403]).toContain(res.status());
});

test('OAuth happy path: persistent consent → token → real read/write API auth → revocation', async ({
  request,
}) => {
  // Admin key with internal-admin scope.
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const customer = await interactiveAuth(request, 'oauth-customer@driftstack.test');

  // 1. Register OAuth client.
  const reg = await request.post(`${server.baseUrl}/v1/admin/oauth/clients`, {
    headers: authHeader(admin.plaintext),
    data: { label: 'Test App', redirect_uris: ['https://app.example/cb'] },
  });
  expect(reg.status()).toBe(201);
  const regBody = (await reg.json()) as { client_id: string; client_secret: string };
  expect(regBody.client_id).toMatch(/^oac_/);
  expect(regBody.client_secret).toMatch(/^oas_/);

  const broadAlias = await request.get(`${server.baseUrl}/v1/oauth/authorize`, {
    params: {
      client_id: regBody.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st_' + 'b'.repeat(20),
      code_challenge: s256('b'.repeat(64)),
      code_challenge_method: 'S256',
      scope: 'read',
    },
  });
  expect(broadAlias.status()).toBe(400);
  expect((await broadAlias.json()) as Record<string, unknown>).toMatchObject({
    detail: 'scope is not available to OAuth clients',
  });

  // 2. PKCE verifier + challenge.
  const verifier = 'v'.repeat(64);
  const challenge = s256(verifier);

  // 3. GET /v1/oauth/authorize — public; no auth.
  const authorize = await request.get(`${server.baseUrl}/v1/oauth/authorize`, {
    params: {
      client_id: regBody.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st_' + 'x'.repeat(20),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'read:sessions write:sessions',
    },
  });
  expect(authorize.status()).toBe(200);
  const authBody = (await authorize.json()) as {
    authorization_id: string;
    state: string;
    redirect_uri: string;
  };
  expect(authBody.authorization_id).toMatch(/^oaa_/);
  expect(authBody.state).toBe('st_' + 'x'.repeat(20));

  // 4. Dashboard "approve" — uses a real interactive web-session bearer.
  //    General API keys are deliberately rejected at this human-consent
  //    boundary; the session's account is bound to the access token.
  const approve = await request.post(`${server.baseUrl}/v1/oauth/authorize/complete`, {
    headers: customer.headers,
    data: { authorization_id: authBody.authorization_id },
  });
  expect(approve.status()).toBe(200);
  const approveBody = (await approve.json()) as { code: string; redirect_uri: string };
  expect(approveBody.code).toMatch(/^oac_/);

  // 5. Token exchange.
  const token = await request.post(`${server.baseUrl}/v1/oauth/token`, {
    data: {
      grant_type: 'authorization_code',
      code: approveBody.code,
      code_verifier: verifier,
      client_id: regBody.client_id,
      client_secret: regBody.client_secret,
      redirect_uri: 'https://app.example/cb',
    },
  });
  expect(token.status()).toBe(200);
  const tokenBody = (await token.json()) as {
    access_token: string;
    token_type: string;
    expires_in: number;
    scope: string[];
  };
  expect(tokenBody.access_token).toMatch(/^oat_/);
  expect(tokenBody.token_type).toBe('Bearer');
  expect(tokenBody.scope).toEqual(['read:sessions', 'write:sessions']);

  // 6. Introspect — token is active.
  const introspect = await request.post(`${server.baseUrl}/v1/oauth/introspect`, {
    data: {
      token: tokenBody.access_token,
      client_id: regBody.client_id,
      client_secret: regBody.client_secret,
    },
  });
  expect(introspect.status()).toBe(200);
  const introBody = (await introspect.json()) as { active: boolean; account_id: string };
  expect(introBody.active).toBe(true);
  expect(introBody.account_id).toBe(customer.accountId);

  // 7. The issued token is a real API principal, not just introspectable
  //    provider metadata. Both the narrow read and write scope paths run
  //    through the central auth middleware. POST additionally proves the
  //    backing credential UUID satisfies sessions.api_key_id's FK.
  const sessionsBefore = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(tokenBody.access_token),
  });
  expect(sessionsBefore.status()).toBe(200);
  const unrelatedProfiles = await request.get(`${server.baseUrl}/v1/profiles`, {
    headers: authHeader(tokenBody.access_token),
  });
  expect(unrelatedProfiles.status()).toBe(403);
  const create = await request.post(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(tokenBody.access_token),
    data: { label: 'oauth-created' },
  });
  expect(create.status()).toBe(201);
  const created = (await create.json()) as { id: string; api_key_id: string; label: string };
  expect(created.id).toMatch(/^ses_/);
  expect(created.api_key_id).toMatch(/^key_[0-9a-f-]{36}$/);
  expect(created.label).toBe('oauth-created');

  const [authority] = await server.client<
    Array<{ provenance: string | null; token_hash: string; key_hash: string }>
  >`
    SELECT k.provenance, t.token_hash, k.key_hash
      FROM oauth_access_tokens t
      JOIN api_keys k ON k.id = t.id
     WHERE t.id = ${created.api_key_id.replace(/^key_/, '')}
  `;
  expect(authority?.provenance).toBe('oauth');
  expect(authority?.token_hash).toMatch(/^[0-9a-f]{64}$/);
  expect(authority?.key_hash).toBe(authority?.token_hash);
  expect(authority?.token_hash).not.toContain(tokenBody.access_token);

  // 8. RFC 7009 revocation invalidates central API auth on the very next
  //    request (the OAuth path intentionally has no positive auth cache).
  const revoke = await request.post(`${server.baseUrl}/v1/oauth/revoke`, {
    data: {
      token: tokenBody.access_token,
      client_id: regBody.client_id,
      client_secret: regBody.client_secret,
    },
  });
  expect(revoke.status()).toBe(200);
  const afterRevoke = await request.get(`${server.baseUrl}/v1/sessions`, {
    headers: authHeader(tokenBody.access_token),
  });
  expect(afterRevoke.status()).toBe(401);

  // 9. Client revocation is the full-kill path. Issue a successor token, prove
  //    it works, then revoke the client through the real admin route and prove
  //    both the OAuth row and backing API-key authority are revoked.
  const authorizeAgain = await request.get(`${server.baseUrl}/v1/oauth/authorize`, {
    params: {
      client_id: regBody.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st_' + 'z'.repeat(20),
      code_challenge: challenge,
      code_challenge_method: 'S256',
      scope: 'read:sessions',
    },
  });
  const stagedAgain = (await authorizeAgain.json()) as { authorization_id: string };
  const approveAgain = await request.post(`${server.baseUrl}/v1/oauth/authorize/complete`, {
    headers: customer.headers,
    data: { authorization_id: stagedAgain.authorization_id },
  });
  const approvalAgain = (await approveAgain.json()) as { code: string };
  const tokenAgain = await request.post(`${server.baseUrl}/v1/oauth/token`, {
    data: {
      grant_type: 'authorization_code',
      code: approvalAgain.code,
      code_verifier: verifier,
      client_id: regBody.client_id,
      client_secret: regBody.client_secret,
      redirect_uri: 'https://app.example/cb',
    },
  });
  expect(tokenAgain.status()).toBe(200);
  const successor = (await tokenAgain.json()) as { access_token: string };
  expect(
    (
      await request.get(`${server.baseUrl}/v1/sessions`, {
        headers: authHeader(successor.access_token),
      })
    ).status(),
  ).toBe(200);

  const revokeClient = await request.delete(
    `${server.baseUrl}/v1/admin/oauth/clients/${regBody.client_id}`,
    { headers: authHeader(admin.plaintext) },
  );
  expect(revokeClient.status()).toBe(204);
  expect(
    (
      await request.get(`${server.baseUrl}/v1/sessions`, {
        headers: authHeader(successor.access_token),
      })
    ).status(),
  ).toBe(401);
  const revocationRows = await server.client<Array<{ active_tokens: number; active_keys: number }>>`
    SELECT
      count(*) FILTER (WHERE t.revoked_at IS NULL)::int AS active_tokens,
      count(*) FILTER (WHERE k.revoked_at IS NULL)::int AS active_keys
      FROM oauth_access_tokens t
      JOIN api_keys k ON k.id = t.id
     WHERE t.client_id = ${regBody.client_id}
  `;
  expect(revocationRows).toHaveLength(1);
  expect(revocationRows[0]?.active_tokens).toBe(0);
  expect(revocationRows[0]?.active_keys).toBe(0);
});

test('pending consent survives a fresh service/store instance', async ({ request }) => {
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const customer = await interactiveAuth(request, 'oauth-replica@driftstack.test');
  const reg = await request.post(`${server.baseUrl}/v1/admin/oauth/clients`, {
    headers: authHeader(admin.plaintext),
    data: { label: 'Replica App', redirect_uris: ['https://replica.example/cb'] },
  });
  const client = (await reg.json()) as { client_id: string; client_secret: string };
  const verifier = 'r'.repeat(64);
  const authorize = await request.get(`${server.baseUrl}/v1/oauth/authorize`, {
    params: {
      client_id: client.client_id,
      redirect_uri: 'https://replica.example/cb',
      state: 'st_' + 'r'.repeat(20),
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      scope: 'read:sessions',
    },
  });
  const staged = (await authorize.json()) as { authorization_id: string };

  // This object shares only PostgreSQL, not OAuthService process memory.
  const replicaStore = new DrizzleOAuthStore({
    client: server.client,
    db: drizzle(server.client, { schema }),
    close: () => Promise.resolve(),
  });
  const replicaService = new OAuthService(replicaStore);
  const approval = await replicaService.approveAuthorization({
    authorization_id: staged.authorization_id,
    account_id: customer.accountId,
    approverScopes: ['read'],
  });

  const exchange = await request.post(`${server.baseUrl}/v1/oauth/token`, {
    data: {
      grant_type: 'authorization_code',
      code: approval.code,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: 'https://replica.example/cb',
    },
  });
  expect(exchange.status()).toBe(200);
  expect((await exchange.json()) as Record<string, unknown>).toMatchObject({
    token_type: 'Bearer',
    scope: ['read:sessions'],
  });
});

test('account-bound OAuth approval rejects foreign consent and atomically creates one code', async ({
  request,
}) => {
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const customer = await interactiveAuth(request, 'oauth-consent-race@driftstack.test');
  const foreign = await interactiveAuth(request, 'oauth-consent-foreign@driftstack.test');
  const reg = await request.post(`${server.baseUrl}/v1/admin/oauth/clients`, {
    headers: authHeader(admin.plaintext),
    data: {
      label: 'Consent Race',
      redirect_uris: ['https://race.example/cb'],
      account_id: customer.accountId,
    },
  });
  const client = (await reg.json()) as { client_id: string; client_secret: string };
  const verifier = 'c'.repeat(64);
  const authorize = await request.get(`${server.baseUrl}/v1/oauth/authorize`, {
    params: {
      client_id: client.client_id,
      redirect_uri: 'https://race.example/cb',
      state: 'st_' + 'c'.repeat(20),
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
      scope: 'read:sessions',
    },
  });
  const staged = (await authorize.json()) as { authorization_id: string };
  const foreignApproval = await request.post(`${server.baseUrl}/v1/oauth/authorize/complete`, {
    headers: foreign.headers,
    data: { authorization_id: staged.authorization_id },
  });
  expect(foreignApproval.status()).toBe(400);
  expect((await foreignApproval.json()) as Record<string, unknown>).toMatchObject({
    detail: 'client is not registered for this account',
  });

  const approve = () =>
    request.post(`${server.baseUrl}/v1/oauth/authorize/complete`, {
      headers: customer.headers,
      data: { authorization_id: staged.authorization_id },
    });

  const [first, second] = await Promise.all([approve(), approve()]);
  expect([first.status(), second.status()].sort()).toEqual([200, 400]);
  const winner = first.status() === 200 ? first : second;
  const winnerBody = (await winner.json()) as { code: string };

  const counts = await server.client<Array<{ authorizations: number; codes: number }>>`
    SELECT
      (SELECT count(*)::int FROM oauth_authorizations) AS authorizations,
      (SELECT count(*)::int FROM oauth_authorization_codes) AS codes
  `;
  expect(counts).toEqual([{ authorizations: 0, codes: 1 }]);

  const exchange = await request.post(`${server.baseUrl}/v1/oauth/token`, {
    data: {
      grant_type: 'authorization_code',
      code: winnerBody.code,
      code_verifier: verifier,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: 'https://race.example/cb',
    },
  });
  expect(exchange.status()).toBe(200);
});

test('OAuth /token serializes concurrent exchange of one persistent code', async ({ request }) => {
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  const customer = await interactiveAuth(request, 'oauth-replay@driftstack.test');
  const reg = await request.post(`${server.baseUrl}/v1/admin/oauth/clients`, {
    headers: authHeader(admin.plaintext),
    data: { label: 'App', redirect_uris: ['https://app.example/cb'] },
  });
  const regBody = (await reg.json()) as { client_id: string; client_secret: string };

  const verifier = 'v'.repeat(64);
  const authorize = await request.get(`${server.baseUrl}/v1/oauth/authorize`, {
    params: {
      client_id: regBody.client_id,
      redirect_uri: 'https://app.example/cb',
      state: 'st_' + 'y'.repeat(20),
      code_challenge: s256(verifier),
      code_challenge_method: 'S256',
    },
  });
  const authBody = (await authorize.json()) as { authorization_id: string };
  const approve = await request.post(`${server.baseUrl}/v1/oauth/authorize/complete`, {
    headers: customer.headers,
    data: { authorization_id: authBody.authorization_id },
  });
  expect(approve.status()).toBe(200);
  const approveBody = (await approve.json()) as { code: string };

  const exchange = () =>
    request.post(`${server.baseUrl}/v1/oauth/token`, {
      data: {
        grant_type: 'authorization_code',
        code: approveBody.code,
        code_verifier: verifier,
        client_id: regBody.client_id,
        client_secret: regBody.client_secret,
        redirect_uri: 'https://app.example/cb',
      },
    });

  // Two replicas can race this transaction. Exactly one consumes the code and
  // creates both authority rows; the loser receives invalid_grant.
  const [first, second] = await Promise.all([exchange(), exchange()]);
  expect([first.status(), second.status()].sort()).toEqual([200, 400]);
  const loser = first.status() === 400 ? first : second;
  expect((await loser.json()) as Record<string, unknown>).toMatchObject({
    title: 'Bad Request',
    detail: 'code already exchanged',
  });

  const third = await request.post(`${server.baseUrl}/v1/oauth/token`, {
    data: {
      grant_type: 'authorization_code',
      code: approveBody.code,
      code_verifier: verifier,
      client_id: regBody.client_id,
      client_secret: regBody.client_secret,
      redirect_uri: 'https://app.example/cb',
    },
  });
  expect(third.status()).toBe(400);
});

test('GET /v1/admin/oauth/clients — lists registered clients', async ({ request }) => {
  const admin = await seedAccount(server.client, {
    scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
  });
  await request.post(`${server.baseUrl}/v1/admin/oauth/clients`, {
    headers: authHeader(admin.plaintext),
    data: { label: 'A', redirect_uris: ['https://a/cb'] },
  });
  await request.post(`${server.baseUrl}/v1/admin/oauth/clients`, {
    headers: authHeader(admin.plaintext),
    data: { label: 'B', redirect_uris: ['https://b/cb'] },
  });
  const list = await request.get(`${server.baseUrl}/v1/admin/oauth/clients`, {
    headers: authHeader(admin.plaintext),
  });
  expect(list.status()).toBe(200);
  const body = (await list.json()) as { clients: Array<{ label: string }> };
  expect(body.clients.map((c) => c.label).sort()).toEqual(['A', 'B']);
  // Critical: response shape must NOT carry client_secret_hash to admin UI.
  for (const c of body.clients) {
    expect(c).not.toHaveProperty('client_secret_hash');
  }
});
