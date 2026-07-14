// V-540.B-2 / V-667.B — E2E for the OAuth 2.0 routes.
//
// Covers the full happy-path dance end-to-end against the real
// Fastify app + InMemoryOAuthStore. The unit tests at
// tests/unit/oauth.test.ts cover the OAuthService class in
// isolation; this spec verifies the route layer wiring + Zod
// validation + admin/public-route auth gating.

import { test, expect, type APIRequestContext } from '@playwright/test';
import { createHash } from 'node:crypto';
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

test('OAuth happy path: admin registers → /authorize → /authorize/complete → /token → /introspect', async ({
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
      scope: 'read:sessions',
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
  };
  expect(tokenBody.access_token).toMatch(/^oat_/);
  expect(tokenBody.token_type).toBe('Bearer');

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
});

test('OAuth /token rejects a replayed code with 400 invalid_grant', async ({ request }) => {
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

  // First exchange — succeeds.
  const first = await request.post(`${server.baseUrl}/v1/oauth/token`, {
    data: {
      grant_type: 'authorization_code',
      code: approveBody.code,
      code_verifier: verifier,
      client_id: regBody.client_id,
      client_secret: regBody.client_secret,
      redirect_uri: 'https://app.example/cb',
    },
  });
  expect(first.status()).toBe(200);

  // Second exchange — same code — must reject.
  const second = await request.post(`${server.baseUrl}/v1/oauth/token`, {
    data: {
      grant_type: 'authorization_code',
      code: approveBody.code,
      code_verifier: verifier,
      client_id: regBody.client_id,
      client_secret: regBody.client_secret,
      redirect_uri: 'https://app.example/cb',
    },
  });
  expect(second.status()).toBe(400);
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
