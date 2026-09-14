// Q6 (brief, "second independent defect"): the top-level callback used to 302
// to the single configured `deps.dashboardOrigin` and ignore the verified
// state's redirectTo, so a sign-in started on app.driftstack.io finished on
// app.driftstack.dev (prod measured .dev on 2026-09-05) — and under Firefox
// Total Cookie Protection that hop alone broke the read. The 302 origin is now
// the verified state's own origin, re-checked against the SAME closed
// allow-list /start applies; an off-list origin is refused, never targeted.
//
// Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts `redirectOriginFor(payload.redirectTo,
//     deps.dashboardOrigin)` in the top-level route and the `if (origin === null)
//     … fragmentErrorUrl(configured, 'state_invalid')` refusal.
//   • `allowedDashboardOrigins()` — widening it past the two first-party hosts,
//     or reading the request Host, reds the allow-list arms.
//   • the bind-less refusal `const bind = payload.bind; if (bind === undefined
//     || !BASE64URL_256_BIT_RE.test(bind)) return refuse();` landing on the
//     CONFIGURED origin — letting a bind-less state choose its own origin (or
//     forwarding it) reds that arm.

import { describe, expect, it } from 'vitest';
import { FIRST_PARTY_DASHBOARD_ORIGINS } from '../../src/lib/cors-allow.js';
import { allowedDashboardOrigins } from '../../src/routes/auth-oauth-client.js';
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

describe('an OAuth top-level 302 targets the verified state origin, not the configured dashboard origin', () => {
  it('v2: config says app.driftstack.dev, the flow started on app.driftstack.io → the hand-off lands on app.driftstack.io', async () => {
    const h = await mountOauthHarness({ dashboardOrigin: 'https://app.driftstack.dev' });
    const start = await startV2(h, 'google', 'https://app.driftstack.io/usage');
    expect(start.res.statusCode).toBe(200);
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    const loc = locationOf(top);
    expect(loc.origin).toBe('https://app.driftstack.io');
    // Trailing slash: the canonical Pages path, so the hand-off skips the host's 308 hop.
    expect(loc.pathname).toBe('/auth/oauth-client/callback/');
    // The user's requested PATH never rides in the Location — it comes back from /redeem.
    expect(loc.search).toBe('');
    expect(loc.hash).not.toContain('usage');
  });

  it('a bind-less state (signed by us, on-list .io redirectTo) cannot choose its origin: refused to the CONFIGURED .dev origin with state_invalid, nothing forwarded', async () => {
    const h = await mountOauthHarness({ dashboardOrigin: 'https://app.driftstack.dev' });
    const legacy = signState({ provider: 'github', redirectTo: 'https://app.driftstack.io/' });
    const top = await topLevel(h, 'github', { code: 'c1', state: legacy, scope: 'read:user' });
    const loc = locationOf(top);
    expect(loc.origin).toBe('https://app.driftstack.dev');
    expect(loc.search).toBe('');
    expect(fragmentOf(top).get('oauth_error')).toBe('state_invalid');
    expect(h.idpCalls).toHaveLength(0);
  });

  it('a validly-signed state whose redirectTo is OFF the allow-list is refused: 302 to the CONFIGURED origin with #oauth_error=state_invalid, no forward, no exchange', async () => {
    const h = await mountOauthHarness({ dashboardOrigin: 'https://app.driftstack.dev' });
    const state = signState({
      redirectTo: 'https://evil.example/phish',
      bind: mintBinding().bindingHash,
    });
    const res = await topLevel(h, 'google', { code: IDP_CODE, state });
    expect(res.statusCode).toBe(302);
    const loc = locationOf(res);
    expect(loc.origin).toBe('https://app.driftstack.dev');
    expect(loc.search).toBe('');
    expect(fragmentOf(res).get('oauth_error')).toBe('state_invalid');
    expect(h.idpCalls).toHaveLength(0);
    expect(h.storeConsumes, 'refused before the verifier is even looked up').toHaveLength(0);
    // Same refusal for a bind-less state: never forwarded, off-list or not.
    const legacy = signState({ redirectTo: 'https://evil.example/phish' });
    const res2 = await topLevel(h, 'google', { code: IDP_CODE, state: legacy });
    expect(locationOf(res2).origin).toBe('https://app.driftstack.dev');
    expect(locationOf(res2).search).toBe('');
    expect(fragmentOf(res2).get('oauth_error')).toBe('state_invalid');
  });

  it('a self-hosted (non-first-party) configured origin keeps an EXACT allow-list: a first-party state origin is off-list there', async () => {
    const h = await mountOauthHarness({ dashboardOrigin: 'https://dash.example.com' });
    const state = signState({
      redirectTo: 'https://app.driftstack.io/',
      bind: mintBinding().bindingHash,
    });
    const res = await topLevel(h, 'google', { code: IDP_CODE, state });
    expect(locationOf(res).origin).toBe('https://dash.example.com');
    expect(fragmentOf(res).get('oauth_error')).toBe('state_invalid');
  });

  it('the redirect-site helper is the same closed rule /start enforces inline (first-party config → both hosts; anything else → exact), never the request host', () => {
    expect([...allowedDashboardOrigins('https://app.driftstack.dev')].sort()).toEqual(
      [...FIRST_PARTY_DASHBOARD_ORIGINS].sort(),
    );
    expect([...allowedDashboardOrigins('https://app.driftstack.io/some/path')].sort()).toEqual(
      [...FIRST_PARTY_DASHBOARD_ORIGINS].sort(),
    );
    expect([...allowedDashboardOrigins('https://dash.example.com')]).toEqual([
      'https://dash.example.com',
    ]);
    expect(FIRST_PARTY_DASHBOARD_ORIGINS).toHaveLength(2);
  });

  it('route provider and signed provider must agree: a google state on the github route → state_invalid, no exchange', async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const res = await topLevel(h, 'github', { code: IDP_CODE, state: start.state });
    expect(fragmentOf(res).get('oauth_error')).toBe('state_invalid');
    expect(h.idpCalls).toHaveLength(0);
  });
});
