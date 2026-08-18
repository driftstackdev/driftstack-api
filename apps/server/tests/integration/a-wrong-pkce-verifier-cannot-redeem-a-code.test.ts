// Nothing in this repo had ever exchanged an authorization code with the WRONG
// `code_verifier`.
//
// PKCE exists for one attack: someone intercepts the authorization code — from a
// redirect, a log, a shared device — and redeems it. The verifier is what makes the
// stolen code useless, and the check that enforces it is one comparison inside
// `exchangeCode`. If the route never consults it, or consults it and ignores the
// answer, every other OAuth test in this repo still passes.
//
// What existed, checked before writing this:
//
//   oauth-pkce.test.ts                     unit-tests the PRIMITIVES, including
//                                          "rejects a wrong verifier". A primitive
//                                          that returns false is worth nothing if
//                                          the caller does not branch on it.
//   oauth-pkce-v488-rfc7636-cross-source   pins the JSDoc and the function shapes.
//   oauth-pkce-s256-only.test.ts           drives the REAL exchange — but always
//                                          with the correct verifier. Its subject is
//                                          the challenge METHOD allowlist.
//   e2e/oauth.spec.ts                      completes the happy path twice; grepping
//                                          it for wrong/mismatch/different returns
//                                          nothing.
//
// So the primitive was tested, the wiring was not, and the gap is exactly the shape
// V-753 had: a correct function nobody consults. This file closes it end to end —
// stage a real authorization, get consent from a real web session, mint a real code,
// then try to redeem it with a verifier that is not the one the challenge was built
// from.
//
// The happy-path arm is not decoration. Every other arm here reports a REFUSAL, and a
// route that refused everyone would satisfy all of them while being completely broken
// — the same vacuity that made an isolation arm on a 404-for-everyone route worthless
// two fires ago.

import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

/** RFC 7636 §4.2 — BASE64URL(SHA256(ASCII(verifier))). */
function s256(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

/** Two verifiers of the SAME legal shape, so only the hash distinguishes them. */
const REAL_VERIFIER = 'a'.repeat(43);
const WRONG_VERIFIER = 'b'.repeat(43);
const REAL_CHALLENGE = s256(REAL_VERIFIER);

const REDIRECT = 'https://app.example/cb';

interface Client {
  client_id: string;
  client_secret: string;
}

async function registerClient(fx: TestAppFixture): Promise<Client> {
  const res = await fx.app.inject({
    method: 'POST',
    url: '/v1/admin/oauth/clients',
    headers: { authorization: `Bearer ${fx.plaintext}` },
    payload: { label: `pkce-${randomUUID()}`, redirect_uris: [REDIRECT] },
  });
  expect(res.statusCode, `client registration returned ${res.statusCode}`).toBe(201);
  return res.json<Client>();
}

/**
 * A web session that can give consent.
 *
 * `/v1/oauth/authorize/complete` refuses an API key outright — accepting one would let
 * a stolen limited credential launder its authority into an OAuth token that survives
 * key revocation — and then requires a tier with apiAccess, which `free` does not have.
 * Both gates are why the fixture signs up at `api_builder`.
 */
async function consentingSession(fx: TestAppFixture, email: string): Promise<string> {
  const signup = await fx.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password: 'correct-horse-battery-staple-9' },
  });
  expect(signup.statusCode, `signup returned ${signup.statusCode}`).toBe(200);
  const debugToken = signup.json<{ debug_token?: string }>().debug_token;
  expect(debugToken, 'fixture must expose debug_token').toBeTruthy();
  const verify = await fx.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: debugToken },
  });
  expect(verify.statusCode, `verify-email returned ${verify.statusCode}`).toBe(200);
  return verify.json<{ session: { token: string } }>().session.token;
}

/** Stage an authorization bound to REAL_CHALLENGE and approve it, returning the code. */
async function earnCode(fx: TestAppFixture, client: Client, sessionToken: string): Promise<string> {
  const staged = await fx.app.inject({
    method: 'GET',
    url: '/v1/oauth/authorize',
    query: {
      client_id: client.client_id,
      redirect_uri: REDIRECT,
      state: 'state-value-long-enough',
      code_challenge: REAL_CHALLENGE,
      code_challenge_method: 'S256',
    },
  });
  expect(staged.statusCode, `authorize returned ${staged.statusCode}`).toBe(200);
  const approved = await fx.app.inject({
    method: 'POST',
    url: '/v1/oauth/authorize/complete',
    headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
    payload: { authorization_id: staged.json<{ authorization_id: string }>().authorization_id },
  });
  expect(approved.statusCode, `approve returned ${approved.statusCode}: ${approved.body}`).toBe(
    200,
  );
  return approved.json<{ code: string }>().code;
}

function exchange(
  fx: TestAppFixture,
  client: Client,
  code: string,
  verifier: string | undefined,
): Promise<{ statusCode: number; body: string; json: <T>() => T }> {
  return fx.app.inject({
    method: 'POST',
    url: '/v1/oauth/token',
    headers: { 'content-type': 'application/json' },
    payload: {
      grant_type: 'authorization_code',
      code,
      client_id: client.client_id,
      client_secret: client.client_secret,
      redirect_uri: REDIRECT,
      ...(verifier === undefined ? {} : { code_verifier: verifier }),
    },
  });
}

describe('a wrong PKCE verifier cannot redeem a code', () => {
  it('CRITICAL the CORRECT verifier redeems the code and returns a token. Every other arm reports a refusal, and a route that refused everyone would satisfy them all while being entirely broken — so this is the arm that makes the rest mean something.', async () => {
    const fx = await buildTestApp({ withOauthStore: true, signupTier: 'api_builder' });
    try {
      const client = await registerClient(fx);
      const session = await consentingSession(fx, `pkce-ok-${randomUUID()}@test.local`);
      const code = await earnCode(fx, client, session);

      const res = await exchange(fx, client, code, REAL_VERIFIER);
      expect(res.statusCode, `the correct verifier was refused: ${res.body}`).toBe(200);
      expect(
        res.json<{ access_token?: string }>().access_token,
        'a successful exchange returned no access token',
      ).toBeTruthy();
    } finally {
      await fx.cleanup();
    }
  }, 60_000);

  it('CRITICAL a WRONG verifier of the same shape is REFUSED. This is the whole of PKCE: an intercepted code is useless without the verifier that produced its challenge. The primitive was unit-tested and the exchange was driven only with the correct value, so nothing had ever established that the route branches on the answer.', async () => {
    const fx = await buildTestApp({ withOauthStore: true, signupTier: 'api_builder' });
    try {
      const client = await registerClient(fx);
      const session = await consentingSession(fx, `pkce-bad-${randomUUID()}@test.local`);
      const code = await earnCode(fx, client, session);

      const res = await exchange(fx, client, code, WRONG_VERIFIER);
      expect(
        res.statusCode,
        `a wrong code_verifier redeemed the code — an intercepted authorization code is exchangeable: ${res.body}`,
      ).not.toBe(200);
      expect(
        res.json<{ access_token?: string }>().access_token,
        'a refused exchange still returned an access token',
      ).toBeUndefined();
    } finally {
      await fx.cleanup();
    }
  }, 60_000);

  it('CRITICAL an OMITTED verifier is refused rather than skipping the check. A missing field is the cheapest downgrade there is: if absent means "no PKCE to verify", every code becomes redeemable by leaving one parameter out.', async () => {
    const fx = await buildTestApp({ withOauthStore: true, signupTier: 'api_builder' });
    try {
      const client = await registerClient(fx);
      const session = await consentingSession(fx, `pkce-none-${randomUUID()}@test.local`);
      const code = await earnCode(fx, client, session);

      const res = await exchange(fx, client, code, undefined);
      expect(
        res.statusCode,
        `an exchange with no code_verifier succeeded — PKCE is optional in practice: ${res.body}`,
      ).not.toBe(200);
    } finally {
      await fx.cleanup();
    }
  }, 60_000);

  it('CRITICAL a code that survived a failed attempt is still governed by the verifier. Whether a bad attempt burns the code is a design choice — burning it lets an interceptor deny the legitimate client, not burning it leaves the code alive — but either way the SECOND attempt must be decided by the verifier and not by having tried before. Both outcomes are accepted here; what is refused is a wrong verifier succeeding on a retry.', async () => {
    const fx = await buildTestApp({ withOauthStore: true, signupTier: 'api_builder' });
    try {
      const client = await registerClient(fx);
      const session = await consentingSession(fx, `pkce-retry-${randomUUID()}@test.local`);
      const code = await earnCode(fx, client, session);

      const first = await exchange(fx, client, code, WRONG_VERIFIER);
      expect(first.statusCode, 'the first wrong-verifier attempt was not refused').not.toBe(200);

      const second = await exchange(fx, client, code, WRONG_VERIFIER);
      expect(
        second.statusCode,
        `a repeated wrong verifier eventually succeeded: ${second.body}`,
      ).not.toBe(200);
    } finally {
      await fx.cleanup();
    }
  }, 60_000);
});
