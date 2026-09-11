// Cookie-free OAuth v2 (2026-09-11) — rollout, brief §5: an already-loaded OLD
// dashboard bundle must still complete a login against the NEW server. The old
// bundle POSTs /start WITHOUT binding_hash, expects the PKCE cookie, follows the
// top-level bounce with ?code&state in the QUERY, and XHRs the legacy
// GET /v1/auth/oauth-client/callback with credentials. Every one of those
// stays byte-for-byte (Safari failure included — the status quo, never worse).
//
// Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts /start: the `if (bindingHash !== undefined)`
//     gate — making v2 unconditional drops the Set-Cookie an old bundle needs.
//   • the top-level route `if (payload.bind === undefined) { … verbatim forward }`
//     — sending a bind-less state down the v2 path 302s with a fragment the old
//     page cannot read.
//   • GET /v1/auth/oauth-client/callback and the cookie helpers (setPkceCookie /
//     readPkceCookie / clearPkceCookie) being retained.

import { describe, expect, it } from 'vitest';
import {
  IDP_CODE,
  SESSION_PLAINTEXT,
  locationOf,
  mountOauthHarness,
  payloadOf,
  startV1,
  topLevel,
} from './an-oauth-v2-harness.js';

describe('an old dashboard bundle (v1 cookie flow) still completes against the v2 server', () => {
  it('/start without binding_hash sets the HttpOnly PKCE cookie, signs a bind-less state, touches no store, returns no flow_id', async () => {
    const h = await mountOauthHarness();
    const start = await startV1(h, 'google', 'https://app.driftstack.dev/');
    expect(start.res.statusCode).toBe(200);
    expect(start.cookie).toMatch(/^ds_oauth_pkce_[A-Za-z0-9_-]{43}=/);
    const setCookie = String(start.res.headers['set-cookie']);
    expect(setCookie).toMatch(
      /Path=\/v1\/auth\/oauth-client; HttpOnly; Secure; SameSite=None; Max-Age=300/,
    );
    expect(start.res.json<{ flow_id?: string }>().flow_id).toBeUndefined();
    expect(payloadOf(start.state).bind).toBeUndefined();
    expect(h.storeSets, 'v1 never writes the flow store').toHaveLength(0);
  });

  it('the top-level route forwards a bind-less state VERBATIM (?code&state, no fragment) and performs no exchange', async () => {
    const h = await mountOauthHarness();
    const start = await startV1(h, 'google', 'https://app.driftstack.dev/');
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(top.statusCode).toBe(302);
    const loc = locationOf(top);
    expect(loc.pathname).toBe('/auth/oauth-client/callback');
    expect(loc.searchParams.get('code')).toBe(IDP_CODE);
    expect(loc.searchParams.get('state')).toBe(start.state);
    expect(loc.hash).toBe('');
    expect(h.idpCalls).toHaveLength(0);
    expect(h.storeConsumes, 'v1 never reads the flow store').toHaveLength(0);
  });

  it('the legacy XHR callback, with the cookie, exchanges and mints the session — the whole old flow end to end', async () => {
    const h = await mountOauthHarness();
    const start = await startV1(h, 'google', 'https://app.driftstack.dev/dashboard');
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    const forwarded = locationOf(top);
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth-client/callback${forwarded.search}`,
      headers: { cookie: start.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      outcome: 'signed-in-existing-link',
      provider: 'google',
      account_id: 'acct-1',
      redirect_to: 'https://app.driftstack.dev/dashboard',
      session_token: SESSION_PLAINTEXT,
    });
    expect(h.idpCalls).toHaveLength(2);
    expect(h.linkCalls).toHaveLength(1);
    // The cookie is cleared on the exchange, as before.
    expect(String(res.headers['set-cookie'])).toMatch(/Max-Age=0/);
  });

  it('D2 on the legacy route is unchanged: the XHR callback without the cookie is the same "PKCE verifier cookie missing" 400, no Redis fallback', async () => {
    const h = await mountOauthHarness();
    const start = await startV1(h, 'google', 'https://app.driftstack.dev/');
    const res = await h.app.inject({
      method: 'GET',
      url: `/v1/auth/oauth-client/callback?code=${IDP_CODE}&state=${encodeURIComponent(start.state)}`,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toBe('PKCE verifier cookie missing or invalid.');
    expect(h.storeConsumes).toHaveLength(0);
    expect(h.idpCalls).toHaveLength(0);
  });
});
