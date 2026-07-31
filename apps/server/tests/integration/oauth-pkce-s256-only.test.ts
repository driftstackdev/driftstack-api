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
