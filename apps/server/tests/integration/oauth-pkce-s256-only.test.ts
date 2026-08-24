// The `plain` PKCE challenge method is REJECTED, proved by sending one.
//
// `api/oauth.md` tells customers: "literal `S256` (the plain method is
// rejected)" and "`plain` challenge method is rejected — S256 only". That is a
// security claim: `plain` sends the verifier itself as the challenge, so an
// attacker who intercepts the authorization request can complete the exchange,
// which is the entire attack PKCE exists to stop.
//
// Measured before writing this: relaxing the route schema from
// `z.literal('S256')` to `z.enum(['S256','plain'])` reds exactly two tests, and
// BOTH are source-text guards — `routes-oauth-content-parity` and
// `routes-oauth-v667b-cross-source-invariant`. Nothing sent a `plain` request.
//
// That distinction matters more than it looks. A source-text guard reds on the
// text, so a refactor can satisfy it by updating the pinned string — which
// looks like ordinary parity maintenance. A request that must be refused cannot
// be satisfied that way.
//
// PKCE is enforced in TWO places, which is good news and a mutation trap:
// `z.literal('S256')` on the route query schema, and an explicit
// `code_challenge_method !== 'S256'` check in `services/oauth.ts` that answers
// "only S256 PKCE is supported". Relaxing EITHER one alone leaves `plain` still
// refused, so a single-layer mutation makes this file look vacuous when it is
// not. Both together red it.
//
// The first draft of this file WAS vacuous, and the differential is what fixed
// it: it used a fabricated client id, so every request failed regardless of
// method and the assertions passed either way. Asserting that S256 SUCCEEDS on
// the same request is what makes the plain refusal mean something.

import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/** 43 chars is the RFC 7636 minimum, so the value itself is never the reason. */
const CHALLENGE = 'a'.repeat(43);

// The verifier `token()` sends, and its true S256 challenge. Needed only by the
// client-binding arm, which is the one that drives an exchange all the way to a
// token — every other arm is refused before PKCE is reached.
const VERIFIER = 'v'.repeat(43);
const REAL_CHALLENGE = createHash('sha256').update(VERIFIER).digest('base64url');

function authorizeUrl(clientId: string, method: string): string {
  const q = new URLSearchParams({
    client_id: clientId,
    redirect_uri: 'https://app.example/cb',
    state: 'state-value-long-enough',
    code_challenge: CHALLENGE,
    code_challenge_method: method,
    //  omitted deliberately: it is optional, and 'read' is refused for
    // OAuth clients with "scope is not available to OAuth clients" — which
    // would make BOTH arms of the differential fail for an unrelated reason.
  });
  return `/v1/oauth/authorize?${q.toString()}`;
}

/** Register a real client so the challenge METHOD is the only variable. */
async function registerClient(fixture: TestAppFixture): Promise<string> {
  const res = await fixture.app.inject({
    method: 'POST',
    url: '/v1/admin/oauth/clients',
    headers: { authorization: `Bearer ${fixture.plaintext}` },
    payload: { label: 'pkce-probe', redirect_uris: ['https://app.example/cb'] },
  });
  expect(res.statusCode, `client registration returned ${res.statusCode}`).toBe(201);
  return res.json<{ client_id: string }>().client_id;
}

describe('OAuth authorize accepts S256 only', () => {
  it('CRITICAL rejects code_challenge_method=plain while the SAME request with S256 is accepted. `plain` sends the verifier as the challenge, so anyone intercepting the authorization request can complete the exchange — the exact attack PKCE prevents, and what the docs promise customers is refused.', async () => {
    fx = await buildTestApp({
      withOauthStore: true,
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const clientId = await registerClient(fx);

    const s256 = await fx.app.inject({ method: 'GET', url: authorizeUrl(clientId, 'S256') });
    const plain = await fx.app.inject({ method: 'GET', url: authorizeUrl(clientId, 'plain') });

    // The differential IS the assertion. Comparing plain against a fixed status
    // would pass even if every authorize request failed for an unrelated
    // reason — which is exactly how the first draft of this test was vacuous.
    expect(s256.statusCode, 'S256 must be accepted, or this test proves nothing').toBeLessThan(400);
    expect(
      plain.statusCode,
      `plain returned ${plain.statusCode} while S256 returned ${s256.statusCode}; plain must be refused`,
    ).toBeGreaterThanOrEqual(400);
  });

  it('CRITICAL rejects an unknown method too, so the refusal is an allowlist rather than a plain-specific denylist. A denylist admits any future method name.', async () => {
    fx = await buildTestApp({
      withOauthStore: true,
      scopes: ['read', 'write', 'admin', 'driftstack_internal_admin'],
    });
    const clientId = await registerClient(fx);

    const s256 = await fx.app.inject({ method: 'GET', url: authorizeUrl(clientId, 'S256') });
    const other = await fx.app.inject({ method: 'GET', url: authorizeUrl(clientId, 'S512') });

    expect(s256.statusCode).toBeLessThan(400);
    expect(other.statusCode).toBeGreaterThanOrEqual(400);
  });
});

// ─── the two classic authorization-code attacks, at the token endpoint ──────
//
// Added 2026-08-15. `exchangeCode` runs a chain of guards and two of them had
// never executed (measured against a coverage run at HEAD):
//
//   services/oauth.ts:612  redirect_uri rejected
//   services/oauth.ts:620  code issued to a different client
//
// Neither is caught upstream. The token route's schema checks SHAPE only —
// `redirect_uri: z.string().url()` — so a well-formed but disallowed URL sails
// through to the service, and nothing at the route knows which client a code
// was issued to. (Contrast `:518`, the PKCE-downgrade guard: the authorize
// route's schema is `z.literal('S256')`, so the service's own copy is a second
// layer that HTTP cannot reach. That one is left alone deliberately.)
//
// Both are textbook OAuth attacks rather than hygiene:
//
//   redirect_uri  the allowlist rejects credentials in the URL, a fragment, and
//                 any non-https scheme except localhost. Each is a way to land
//                 an authorization code somewhere the client never nominated.
//
//   client binding  a code minted for client A must not be redeemable by client
//                 B, even when B authenticates correctly as itself. Without the
//                 check, any registered client that observes a code — a shared
//                 browser, a logged referrer — can trade it for a token on
//                 another client's behalf.
//
// MUTATION-PROVED against services/oauth.ts — control 5/5:
//
//   the token endpoint stops checking the allowlist       3 red
//   the allowlist drops the credentials/fragment check    2 red
//   the allowlist admits any http origin, not localhost   1 red
//   the allowlist admits everything                       1 red
//
// The three cases are asserted separately rather than as one "bad uri" arm
// because they fail through different clauses: credentials and fragment share
// one line, the scheme check is another, and a mutation to either leaves the
// other still refusing. The counts above show it — dropping the
// credentials/fragment line reds exactly the two arms that depend on it.
//
// Client binding, added in the same slice once the harness could earn a real
// code — control 6/6:
//
//   the binding check deleted outright                    1 red
//   it compares the AUTHENTICATED client to the body id   1 red
//   every exchange refused                                1 red
//   the `signupTier` harness seam removed                 1 red
//
// The second is the one worth keeping. `authenticateClient` has already proved
// args.client_id owns its secret, so comparing the resolved client back to the
// same id is a tautology — the guard reads correctly, reviews cleanly, and
// enforces nothing. Deleting a guard is caught by almost anything; a comparison
// against the wrong side of an identity is not.
//
// The third mutates nothing about the attack and reds the OTHER leg: with every
// exchange refused, the stolen-code assertion still passes. Only the "rightful
// client still succeeds afterwards" leg tells that apart from a build that
// refuses everyone, which is why the arm spends a second exchange on it.
//
// The fourth is not a source guard at all — it pins that the coverage depends on
// the seam. Drop `signupTier` and the signup account falls back to `free`, the
// approve route 403s on `apiAccess`, and no code is ever minted.
//
// ─── approve-path refusals, added once the seam made consent reachable ──────
//
// Cold sites from the same coverage run: :561 unknown authorization_id, :592/:595
// the commit verdicts, :598 revoked client. Ledger — control 48/48 across this
// file and tests/unit/oauth.test.ts:
//
//   the staged-authorization pre-check removed (:561)     2 red
//   the atomic-consume 'unavailable' verdict ignored      2 red
//   the revoked-client verdict ignored (:598)             1 red
//   the store stops treating a revoked client as gone     1 red
//   the store's consume is no longer atomic               SURVIVES
//
// ⚠️ The survivor is reported rather than quietly dropped, because a surviving
// mutation is not automatically a coverage gap. Moving
// `authorizations.delete(...)` below the expiry check changes only whether an
// ALREADY-expired authorization is evicted on the attempt — either way it can
// never be approved, and `getAuthorization` filters it on the next read. So the
// two orderings are observationally identical and no test could tell them apart.
// It also mutates `InMemoryOAuthStore`, which is a test double: production runs
// `db/oauth-store.ts`, where the same decision is one SQL statement. Contrast the
// mutation directly above it, which touches the same double and REDS — that one
// mirrors a real production rule.
//
// ⚠️ The guard block appears at FOUR sites in this file, so the first mutation
// anchor matched more than once and was refused rather than applied to the wrong
// path. The `authenticateClient` line above exchangeCode's copy disambiguates
// it — the same repeated-block hazard this suite keeps running into.

describe('OAuth token exchange refuses a bad redirect_uri and a foreign code', () => {
  interface Client {
    client_id: string;
    client_secret: string;
  }

  async function registerFullClient(fixture: TestAppFixture, label: string): Promise<Client> {
    const res = await fixture.app.inject({
      method: 'POST',
      url: '/v1/admin/oauth/clients',
      headers: { authorization: `Bearer ${fixture.plaintext}` },
      payload: { label, redirect_uris: ['https://app.example/cb'] },
    });
    expect(res.statusCode, `registration returned ${res.statusCode}`).toBe(201);
    return res.json<Client>();
  }

  const token = (
    fixture: TestAppFixture,
    body: Record<string, string>,
  ): Promise<{ statusCode: number; json: <T>() => T }> =>
    fixture.app.inject({
      method: 'POST',
      url: '/v1/oauth/token',
      headers: { 'content-type': 'application/json' },
      payload: {
        grant_type: 'authorization_code',
        code_verifier: 'v'.repeat(43),
        redirect_uri: 'https://app.example/cb',
        ...body,
      },
    });

  // Earning a real authorization code takes a consent, and consent is a human
  // action: POST /v1/oauth/authorize/complete refuses an API key outright.
  //
  //     if (ctx.webSession === null) …
  //     // Accepting an API key here lets a stolen limited credential launder
  //     // its authority into an independent OAuth token that survives key
  //     // revocation.
  //
  // So the caller has to be a web session, which signup + verify-email issues.
  // That alone is not enough: the very next line is
  // `requireTierFeature(ctx.account.tier, 'apiAccess')`, and a signup account is
  // `free`, the one tier with `apiAccess: false`. Two independent gates in
  // sequence, each correct, each fed by a different account — the harness seeds
  // the API-key account's tier and left the signup account at the production
  // default. `signupTier` is that missing knob.
  //
  // ⚠️ Worth stating plainly because the first version of this file asserted the
  // opposite: the blocker recorded here was that the harness "cannot mint a
  // web-session credential". It can, and ten integration suites already do. The
  // real obstacle was one tier default two lines further down. A blocker is a
  // claim like any other and deserves the same grep — mine survived only because
  // a 403 is equally consistent with "wrong credential kind" and "wrong tier",
  // and I read the first gate and stopped.
  async function consentingSession(fixture: TestAppFixture, email: string): Promise<string> {
    const signup = await fixture.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password: 'correct-horse-battery-staple-9' },
    });
    expect(signup.statusCode, `signup returned ${signup.statusCode}`).toBe(200);
    const debugToken = signup.json<{ debug_token?: string }>().debug_token;
    expect(debugToken, 'fixture should expose debug_token').toBeTruthy();
    const verify = await fixture.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: debugToken },
    });
    expect(verify.statusCode, `verify-email returned ${verify.statusCode}`).toBe(200);
    return verify.json<{ session: { token: string } }>().session.token;
  }

  /** Stage an authorization for `client`, then approve it as the human. */
  async function earnCode(
    fixture: TestAppFixture,
    client: Client,
    sessionToken: string,
  ): Promise<string> {
    const staged = await fixture.app.inject({
      method: 'GET',
      url: '/v1/oauth/authorize',
      query: {
        client_id: client.client_id,
        redirect_uri: 'https://app.example/cb',
        state: 'state-value-long-enough',
        // A REAL S256 pair, unlike the dummy CHALLENGE the arms above use —
        // those stop at the method check, this one runs the exchange to
        // completion and would fail PKCE verification at services/oauth.ts:625.
        code_challenge: REAL_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });
    expect(staged.statusCode, `authorize returned ${staged.statusCode}`).toBe(200);
    const approved = await fixture.app.inject({
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

  /** Stage an authorization and return its id WITHOUT approving it. */
  async function stageAuthorization(fixture: TestAppFixture, client: Client): Promise<string> {
    const staged = await fixture.app.inject({
      method: 'GET',
      url: '/v1/oauth/authorize',
      query: {
        client_id: client.client_id,
        redirect_uri: 'https://app.example/cb',
        state: 'state-value-long-enough',
        code_challenge: REAL_CHALLENGE,
        code_challenge_method: 'S256',
      },
    });
    expect(staged.statusCode, `authorize returned ${staged.statusCode}`).toBe(200);
    return staged.json<{ authorization_id: string }>().authorization_id;
  }

  const approve = (
    fixture: TestAppFixture,
    sessionToken: string,
    authorizationId: string,
  ): Promise<{ statusCode: number; body: string; json: <T>() => T }> =>
    fixture.app.inject({
      method: 'POST',
      url: '/v1/oauth/authorize/complete',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      payload: { authorization_id: authorizationId },
    });

  it('400: consent for an authorization_id that was never staged', async () => {
    const fx = await buildTestApp({ withOauthStore: true, signupTier: 'api_builder' });
    try {
      await registerFullClient(fx, 'unknown-id');
      const session = await consentingSession(fx, 'consent-unknown@example.test');

      const res = await approve(fx, session, 'oaz_never-staged-authorization-id');
      expect(res.statusCode).toBe(400);
      const body = res.json<{ error: string; detail: string }>();
      expect(body.error).toBe('invalid_request');
      expect(body.detail).toMatch(/unknown or expired authorization_id/i);
    } finally {
      await fx.cleanup();
    }
  });

  it('401: a client revoked after staging cannot have its consent completed', async () => {
    const fx = await buildTestApp({ withOauthStore: true, signupTier: 'api_builder' });
    try {
      const client = await registerFullClient(fx, 'decommissioned');
      const session = await consentingSession(fx, 'consent-revoked@example.test');
      const authorizationId = await stageAuthorization(fx, client);

      // Revocation is the operator's kill switch for a compromised or retired
      // app. Staging happens before the human decides, so there is a real window
      // between "authorization staged" and "user clicks Approve" — and revoking
      // during it has to hold. Otherwise a client revoked in response to a
      // compromise still collects a code from any consent already in flight, and
      // trades it for a token that outlives the revocation.
      const revoke = await fx.app.inject({
        method: 'DELETE',
        url: `/v1/admin/oauth/clients/${client.client_id}`,
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(revoke.statusCode, `revoke returned ${revoke.statusCode}`).toBeLessThan(300);

      const res = await approve(fx, session, authorizationId);
      // 401, not 400: `oauthErrorToHttp` maps `invalid_client` to Unauthorized,
      // which is RFC 6749's own answer for a client that cannot be authenticated
      // — including one that no longer exists. The first version of this arm
      // asserted 400 by analogy with its neighbours and was wrong about the
      // code, not about the branch.
      expect(res.statusCode).toBe(401);
      const body = res.json<{ error: string; detail: string }>();
      expect(body.error).toBe('invalid_client');
      expect(body.detail).toMatch(/unknown or revoked client_id/i);
    } finally {
      await fx.cleanup();
    }
  });

  it('one consent, double-submitted, yields exactly one code', async () => {
    const fx = await buildTestApp({ withOauthStore: true, signupTier: 'api_builder' });
    try {
      const client = await registerFullClient(fx, 'double-click');
      const session = await consentingSession(fx, 'consent-race@example.test');
      const authorizationId = await stageAuthorization(fx, client);

      // A double-clicked Approve button, which is the ordinary way this happens.
      //
      // ⚠️ MEASURED, and not what it looks like. The intent was to land on the
      // ATOMIC-CONSUME verdict (services/oauth.ts:595) rather than the
      // `getAuthorization` pre-check (:561). It does not: ignoring the :595
      // verdict entirely leaves this arm green, so the loser is refused by the
      // pre-check — the winner finishes before the loser starts reading.
      //
      // It cannot be fixed by asserting harder, because **the two sites emit the
      // same string**. From outside, `unknown or expired authorization_id` at
      // :561 and at :595 are indistinguishable, so no HTTP-level test can prove
      // which one fired. :595 is covered in `tests/unit/oauth.test.ts` instead,
      // with a store that returns the racing verdict directly.
      //
      // The arm is kept for what it does prove end-to-end, which is worth having
      // on its own: a double-submitted consent yields exactly ONE code.
      const [a, b] = await Promise.all([
        approve(fx, session, authorizationId),
        approve(fx, session, authorizationId),
      ]);

      const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
      expect(statuses, `got ${statuses.join(',')}`).toEqual([200, 400]);

      // Assert the SHAPE of the loser rather than a global count: whichever
      // request lost must be refused as a spent authorization, not as some
      // unrelated 400 that would satisfy the status assertion just as well.
      const loser = a.statusCode === 400 ? a : b;
      const body = loser.json<{ error: string; detail: string }>();
      expect(body.error).toBe('invalid_request');
      expect(body.detail).toMatch(/unknown or expired authorization_id/i);

      // And the winner's code has to be real, not a 200 with nothing behind it.
      const winner = a.statusCode === 200 ? a : b;
      expect(winner.json<{ code: string }>().code).toMatch(/^oag_/);
    } finally {
      await fx.cleanup();
    }
  });

  it('400: a code minted for one client cannot be redeemed by another', async () => {
    const fx = await buildTestApp({ withOauthStore: true, signupTier: 'api_builder' });
    try {
      const alice = await registerFullClient(fx, 'alice');
      const mallory = await registerFullClient(fx, 'mallory');
      const session = await consentingSession(fx, 'consent-binding@example.test');
      const code = await earnCode(fx, alice, session);

      // Mallory authenticates correctly AS MALLORY — the client credentials are
      // her own and valid. The only thing wrong is that the code is not hers,
      // which is the whole point: without the binding check, any registered
      // client that merely observes a code can spend it.
      const stolen = await token(fx, {
        code,
        client_id: mallory.client_id,
        client_secret: mallory.client_secret,
      });
      expect(stolen.statusCode).toBe(400);
      const body = stolen.json<{ error: string; detail: string }>();
      expect(body.error).toBe('invalid_grant');
      expect(body.detail).toMatch(/different client/i);

      // The same code still works for its rightful client afterwards, so the
      // refusal above is the binding check and not the code being consumed,
      // malformed, or expired. Without this the arm passes just as well against
      // a build that rejects every exchange.
      const rightful = await token(fx, {
        code,
        client_id: alice.client_id,
        client_secret: alice.client_secret,
      });
      expect(rightful.statusCode, `rightful client got ${rightful.statusCode}`).toBe(200);
    } finally {
      await fx.cleanup();
    }
  });

  it.each([
    ['a plain-http target', 'http://evil.example/cb'],
    ['credentials embedded in the URL', 'https://user:pass@app.example/cb'],
    ['a fragment', 'https://app.example/cb#stolen'],
  ])(
    'CRITICAL the token endpoint rejects %s as a redirect_uri. Each is well-formed enough to pass the route schema — which only checks that it parses as a URL — so the allowlist in the service is the only thing standing between a valid code and delivery somewhere the client never nominated.',
    async (_label, redirect_uri) => {
      fx = await buildTestApp({ withOauthStore: true });
      const client = await registerFullClient(fx, 'redirect-probe');
      const res = await token(fx, {
        code: 'irrelevant-the-uri-is-checked-first',
        client_id: client.client_id,
        client_secret: client.client_secret,
        redirect_uri,
      });
      expect(res.statusCode, 'refused').toBe(400);
      const body = res.json<{ error: string; detail?: string }>();
      expect(body.error, 'as a bad request rather than a bad grant').toBe('invalid_request');
      // The route maps OAuthError -> BadRequestError(message, { error: code }),
      // so the reason lands in `detail` and the code in a top-level `error`.
      expect(String(body.detail ?? '')).toMatch(/redirect_uri rejected/i);
    },
  );
});
