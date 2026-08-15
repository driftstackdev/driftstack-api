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

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

/** 43 chars is the RFC 7636 minimum, so the value itself is never the reason. */
const CHALLENGE = 'a'.repeat(43);

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

  // ⚠️ The client-binding refusal (services/oauth.ts:620, "code issued to a
  // different client") is NOT covered here, and the blocker is worth recording
  // rather than leaving as a silent gap.
  //
  // Driving it needs a real authorization code, which means completing
  // POST /v1/oauth/authorize/complete — and that route deliberately refuses an
  // API key:
  //
  //     if (ctx.webSession === null) …
  //     // Consent is a human dashboard action, not a general API-key mutation.
  //     // Accepting an API key here lets a stolen limited credential launder
  //     // its authority into an independent OAuth token that survives key
  //     // revocation.
  //
  // That refusal is correct and worth keeping. But `buildTestApp` cannot mint a
  // web-session credential — nothing in the integration suite authenticates with
  // one — and it constructs `InMemoryOAuthStore` inline without exposing it, so
  // a code cannot be seeded directly either. Both routes to a real code are
  // closed by construction.
  //
  // Fix shape, either would do: expose the store on the fixture so a code can be
  // seeded, or add a web-session credential to the harness. The latter is worth
  // more — it would also unlock the approve route's own refusals. Same call as
  // the `agentDecomposerKind` and `opts.fetch` gaps: add the seam rather than
  // bend a fixture into the branch.

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
