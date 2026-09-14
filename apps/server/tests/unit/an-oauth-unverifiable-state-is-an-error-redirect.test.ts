// The top-level IDP-return route verifies the state FIRST and only a verified
// state WITH a well-formed `bind` takes the exchange path. Everything else —
// no state, garbage state, forged state, expired state, a bind that is not a
// digest, ?error= with no usable state — is a bounded #oauth_error redirect to
// the CONFIGURED dashboard origin: an unverifiable state cannot vouch for an
// origin, and nothing from the query is forwarded. The code is state_invalid,
// except for an EXPIRED state, which is genuinely ours and gets state_replayed
// — the one code whose customer copy says "has expired". (Until 2026-09-14
// this was a verbatim query forward for an old bundle's XHR route; that route,
// the forward and the cookie are gone — see
// an-oauth-v1-start-without-a-binding-hash-is-refused.)
//
// Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts top-level route `if (stateRes === null ||
//     stateRes.kind !== 'ok') { return refuse(stateRes?.kind === 'expired' ?
//     'state_replayed' : 'state_invalid'); }` with `const refuse = (code:
//     OauthFragmentError = 'state_invalid') => reply.redirect(
//     fragmentErrorUrl(configuredOrigin, code), 302)` — forwarding the query
//     again, choosing any origin from an unverified state, or collapsing the
//     expired case back into state_invalid, reds the arms below.
//   • `if (bind === undefined || !BASE64URL_256_BIT_RE.test(bind)) return
//     refuse();` — a presence-only check lets a signed non-digest `bind`
//     consume the verifier and reach the IDP; the malformed-bind arm reds.
//   • the `?error` check sitting INSIDE the verified branch (`if (typeof
//     req.query.error === 'string' …) return fail('idp_denied')`) — hoisting it
//     above verification reds the "?error with no state" arm.

import { describe, expect, it } from 'vitest';
import type { LightMyRequestResponse } from 'fastify';
import { signOauthClientState } from '../../src/lib/oauth-client-state.js';
import {
  IDP_CODE,
  fragmentOf,
  locationOf,
  mintBinding,
  mountOauthHarness,
  signState,
  startV2,
  topLevel,
  type Harness,
} from './an-oauth-v2-harness.js';

/** The one refusal every unverifiable state gets: same origin, same path,
 *  nothing forwarded, nothing consumed — only the bounded code varies. */
function expectRefusalOnConfiguredOrigin(
  h: Harness,
  res: LightMyRequestResponse,
  code: 'state_invalid' | 'state_replayed' = 'state_invalid',
): void {
  expect(res.statusCode).toBe(302);
  expect(res.headers['cache-control']).toBe('no-store');
  const loc = locationOf(res);
  expect(loc.origin).toBe(h.dashboardOrigin);
  expect(loc.pathname).toBe('/auth/oauth-client/callback/');
  expect(loc.search, 'nothing from the query is forwarded').toBe('');
  expect(fragmentOf(res).get('oauth_error')).toBe(code);
  expect([...fragmentOf(res).keys()]).toEqual(['oauth_error']);
  expect(res.headers['set-cookie']).toBeUndefined();
  expect(h.idpCalls).toHaveLength(0);
  expect(h.storeConsumes).toHaveLength(0);
}

describe('an unverifiable OAuth state is an error redirect (never exchanged, never forwarded)', () => {
  it('garbage state: 302 to the CONFIGURED origin with #oauth_error=state_invalid; the code and state are never echoed', async () => {
    const h = await mountOauthHarness();
    const res = await topLevel(h, 'google', { code: 'abc123', state: 'xyz789' });
    expectRefusalOnConfiguredOrigin(h, res);
    const raw = String(res.headers.location);
    expect(raw).not.toContain('abc123');
    expect(raw).not.toContain('xyz789');
  });

  it('extra IDP keys are NOT forwarded either (github scope=read:user vanishes with the code)', async () => {
    const h = await mountOauthHarness();
    const res = await topLevel(h, 'github', { code: 'g0d', state: 's7t', scope: 'read:user' });
    expectRefusalOnConfiguredOrigin(h, res);
    expect(String(res.headers.location)).not.toContain('read');
  });

  it('?error=access_denied with no state is state_invalid, not idp_denied: the error param is only trusted under a verified state, and the raw strings never reach the Location', async () => {
    const h = await mountOauthHarness();
    const res = await topLevel(h, 'google', {
      error: 'access_denied',
      error_description: 'User <script>denied</script>',
    });
    expectRefusalOnConfiguredOrigin(h, res);
    const raw = String(res.headers.location);
    expect(raw).not.toContain('access_denied');
    expect(raw).not.toContain('denied');
    expect(raw).not.toContain('script');
  });

  it('no query at all is still the state_invalid redirect to the configured origin', async () => {
    const h = await mountOauthHarness();
    expectRefusalOnConfiguredOrigin(h, await topLevel(h, 'google', {}));
  });

  it('a FORGED state (right shape, wrong secret, on-list origin, with bind) is state_invalid; the origin it names is never used', async () => {
    const h = await mountOauthHarness({ dashboardOrigin: 'https://app.driftstack.dev' });
    const forged = signOauthClientState({
      provider: 'google',
      redirectTo: 'https://app.driftstack.io/',
      signingSecret: 'z'.repeat(32), // NOT the harness secret
      bind: mintBinding().bindingHash,
    });
    const res = await topLevel(h, 'google', { code: IDP_CODE, state: forged });
    expectRefusalOnConfiguredOrigin(h, res);
    expect(locationOf(res).origin).not.toBe('https://app.driftstack.io');
  });

  it("an EXPIRED v2 state cannot choose an origin or a branch: refused on the configured origin (not the state's .io origin), no IDP call, verifier untouched — and the code is state_replayed, whose copy says 'expired', not state_invalid's 'not valid for this dashboard'", async () => {
    const h = await mountOauthHarness({ dashboardOrigin: 'https://app.driftstack.dev' });
    const state = signState({
      redirectTo: 'https://app.driftstack.io/',
      bind: mintBinding().bindingHash,
      nowMs: Date.now() - 10 * 60 * 1000,
    });
    const res = await topLevel(h, 'google', { code: IDP_CODE, state });
    expectRefusalOnConfiguredOrigin(h, res, 'state_replayed');
    expect(locationOf(res).origin).not.toBe('https://app.driftstack.io');
    expect(String(res.headers.location)).not.toContain(state);
    // Boundary control: the same state one minute INSIDE the TTL is not
    // expired — it verifies and moves on to the verifier lookup (state_replayed
    // there too, but on the STATE's origin and with a consume), so the arm
    // above measures the expiry mapping, not a constant answer.
    const fresh = signState({
      redirectTo: 'https://app.driftstack.io/',
      bind: mintBinding().bindingHash,
      nowMs: Date.now() - 4 * 60 * 1000,
    });
    const live = await topLevel(h, 'google', { code: IDP_CODE, state: fresh });
    expect(locationOf(live).origin).toBe('https://app.driftstack.io');
    expect(h.storeConsumes).toHaveLength(1);
  });

  it('a signed state whose `bind` is PRESENT but not a 256-bit base64url digest (empty, short, off by one, wrong alphabet) is state_invalid: verifier never consumed, IDP never called — while the well-formed digest beside them moves on to the verifier lookup', async () => {
    const h = await mountOauthHarness();
    for (const [label, bind] of [
      ['empty', ''],
      ['short', 'abc'],
      ['42 chars', 'A'.repeat(42)],
      ['44 chars', 'A'.repeat(44)],
      ['base64 (not url-safe) alphabet', `${'A'.repeat(42)}+`],
    ] as const) {
      const state = signState({ bind, nonce: `malformed-bind-${label}` });
      const res = await topLevel(h, 'google', { code: IDP_CODE, state });
      expectRefusalOnConfiguredOrigin(h, res);
      expect(String(res.headers.location), label).not.toContain(IDP_CODE);
    }
    // Positive control for the regex boundary: exactly 43 url-safe chars
    // passes this check and reaches the store (state_replayed there: nothing
    // was ever stored under this nonce), so the refusals above are the shape
    // check, not a route that refuses every hand-signed state.
    // (A fresh harness: the five refusals above spent this IP's 5/min
    // top-level budget, and a 429 here would read as a refusal for the
    // wrong reason.)
    const h2 = await mountOauthHarness();
    const wellFormed = signState({ bind: 'A'.repeat(43), nonce: 'well-formed-bind' });
    const res = await topLevel(h2, 'google', { code: IDP_CODE, state: wellFormed });
    expect(res.statusCode).toBe(302);
    expect(fragmentOf(res).get('oauth_error')).toBe('state_replayed');
    expect(h2.storeConsumes).toHaveLength(1);
    expect(h2.idpCalls).toHaveLength(0);
  });

  it('positive control: a VERIFIED v2 state with ?error= takes the exchange path — #oauth_error=idp_denied on the STATE origin, verifier untouched', async () => {
    const h = await mountOauthHarness({ dashboardOrigin: 'https://app.driftstack.dev' });
    const start = await startV2(h, 'google', 'https://app.driftstack.io/');
    const res = await topLevel(h, 'google', { error: 'access_denied', state: start.state });
    const loc = locationOf(res);
    expect(loc.origin).toBe('https://app.driftstack.io');
    expect(loc.search).toBe('');
    expect(fragmentOf(res).get('oauth_error')).toBe('idp_denied');
    expect(h.idpCalls).toHaveLength(0);
    // The verifier is still there: the user can retry consent only via a fresh /start anyway,
    // but a denial must not burn state the route never used.
    expect(h.storeConsumes).toHaveLength(0);
  });

  it('a verified v2 state with no code → missing_code, no IDP call', async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const res = await topLevel(h, 'google', { state: start.state });
    expect(fragmentOf(res).get('oauth_error')).toBe('missing_code');
    expect(h.idpCalls).toHaveLength(0);
  });
});
