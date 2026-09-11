// Cookie-free OAuth v2 (2026-09-11) — the top-level route verifies the state
// FIRST and only a verified state WITH `bind` takes the v2 path. Everything
// else — no state, garbage state, expired state, ?error= with no v2 state —
// is the pre-v2 verbatim forward to the configured origin, so an old bundle's
// XHR route still produces "State token invalid: …" / "IDP returned error: …"
// and the new page's legacy branch surfaces the same messages. Owned copy of
// tests/integration/auth-oauth-client.test.ts :221-257, plus the v2-side arms.
//
// Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts top-level route `if (stateRes === null ||
//     stateRes.kind !== 'ok') { const target = `${deps.dashboardOrigin}/auth/
//     oauth-client/callback?${qs.toString()}`; return reply.redirect(target, 302); }`
//     — turning an unverifiable state into a #oauth_error fragment reds the
//     verbatim arms and breaks every old bundle's error UX.
//   • the `?error` check sitting INSIDE the v2 branch (`if (typeof req.query.error
//     === 'string' …) return fail('idp_denied')`) — hoisting it above verification
//     reds the "?error with no state is forwarded" arm.

import { describe, expect, it } from 'vitest';
import {
  IDP_CODE,
  fragmentOf,
  locationOf,
  mintBinding,
  mountOauthHarness,
  signState,
  startV2,
  topLevel,
} from './an-oauth-v2-harness.js';

describe('an unverifiable OAuth state is forwarded verbatim (never exchanged, never a fragment)', () => {
  it('garbage state: 302 to the configured origin with code+state exactly as received', async () => {
    const h = await mountOauthHarness();
    const res = await topLevel(h, 'google', { code: 'abc123', state: 'xyz789' });
    expect(res.statusCode).toBe(302);
    expect(res.headers['cache-control']).toBe('no-store');
    const loc = locationOf(res);
    expect(loc.origin).toBe(h.dashboardOrigin);
    expect(loc.pathname).toBe('/auth/oauth-client/callback');
    expect(loc.searchParams.get('code')).toBe('abc123');
    expect(loc.searchParams.get('state')).toBe('xyz789');
    expect(loc.hash).toBe('');
    expect(h.idpCalls).toHaveLength(0);
    expect(h.storeConsumes).toHaveLength(0);
  });

  it('extra IDP keys ride along untouched (github scope=read:user)', async () => {
    const h = await mountOauthHarness();
    const res = await topLevel(h, 'github', { code: 'g0d', state: 's7t', scope: 'read:user' });
    const loc = locationOf(res);
    expect(loc.searchParams.get('code')).toBe('g0d');
    expect(loc.searchParams.get('state')).toBe('s7t');
    expect(loc.searchParams.get('scope')).toBe('read:user');
  });

  it('?error=access_denied with no state is forwarded verbatim, error_description included', async () => {
    const h = await mountOauthHarness();
    const res = await topLevel(h, 'google', {
      error: 'access_denied',
      error_description: 'User denied',
    });
    const loc = locationOf(res);
    expect(loc.searchParams.get('error')).toBe('access_denied');
    expect(loc.searchParams.get('error_description')).toBe('User denied');
    expect(loc.hash).toBe('');
  });

  it('no query at all is still a 302 to the configured origin (the SPA then says "Missing callback parameters.")', async () => {
    const h = await mountOauthHarness();
    const res = await topLevel(h, 'google', {});
    expect(res.statusCode).toBe(302);
    expect(locationOf(res).origin).toBe(h.dashboardOrigin);
  });

  it('an EXPIRED v2 state cannot choose an origin or a branch: verbatim forward, no IDP call, verifier untouched', async () => {
    const h = await mountOauthHarness();
    const state = signState({
      redirectTo: 'https://app.driftstack.io/',
      bind: mintBinding().bindingHash,
      nowMs: Date.now() - 10 * 60 * 1000,
    });
    const res = await topLevel(h, 'google', { code: IDP_CODE, state });
    const loc = locationOf(res);
    expect(loc.origin).toBe(h.dashboardOrigin);
    expect(loc.searchParams.get('state')).toBe(state);
    expect(loc.hash).toBe('');
    expect(h.idpCalls).toHaveLength(0);
    expect(h.storeConsumes).toHaveLength(0);
  });

  it('a VERIFIED v2 state with ?error= takes the v2 path: #oauth_error=idp_denied on the state origin, verifier untouched', async () => {
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
