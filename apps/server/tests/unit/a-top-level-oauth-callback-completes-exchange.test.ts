// Cookie-free OAuth v2 (2026-09-11) — the top-level IDP-return route completes
// the exchange itself, and /start sets NO cookie for a v2 flow.
//
// Reverting these production lines reds the named assertions:
//   • routes/auth-oauth-client.ts /start: `if (bindingHash !== undefined) {
//     await deps.flowStore.set(verifierKey(nonce), …); return … flow_id }`
//     → "no Set-Cookie", "flow_id", "verifier stored" arms.
//   • routes/auth-oauth-client.ts top-level route, the `// ── v2` branch
//     (`payload.bind === undefined` deciding legacy vs v2, then
//     `exchangeCodeForTokens` / `fetchUserInfo` / `flowStore.set(handoffKey…)`)
//     → "injected fetch called for the token exchange", "fragment" arms.
//   • lib/oauth-client-state.ts `...(opts.bind !== undefined ? { bind } : {})`
//     → "state carries bind" arm.

import { describe, expect, it } from 'vitest';
import {
  CALLBACK_URL_BASE,
  IDP_CODE,
  SESSION_PLAINTEXT,
  mountOauthHarness,
  payloadOf,
  redeem,
  startV2,
  topLevel,
  fragmentOf,
  locationOf,
} from './an-oauth-v2-harness.js';

describe('a top-level OAuth callback completes the exchange (v2)', () => {
  it('/start with binding_hash signs `bind` into the state, stores the verifier server-side, answers flow_id and sets NO cookie', async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/usage');
    expect(start.res.statusCode).toBe(200);
    expect(start.res.headers['cache-control']).toBe('no-store');
    expect(
      start.res.headers['set-cookie'],
      'v2 must not write the cookie ITP drops',
    ).toBeUndefined();
    expect(start.flowId).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(payloadOf(start.state).bind).toBe(start.bindingHash);
    expect(h.storeSets).toHaveLength(1);
    expect(h.storeSets[0]).toMatch(/^oauth-client-verifier:[0-9a-f]{64}$/);
    // The verifier itself is what was stored (S256 of it is in the authorize URL).
    const stored = await h.store.peek(h.storeSets[0]!);
    expect(stored).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(new URL(start.authorizeUrl).searchParams.get('code_challenge_method')).toBe('S256');
  });

  it('the IDP return runs token exchange + userinfo on the top-level route (injected fetch), then 302s with a fragment hand-off — no DB write, no session yet', async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/usage');
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(top.statusCode).toBe(302);
    expect(top.headers['cache-control']).toBe('no-store');

    // Both IDP legs ran here, with the SAME redirect_uri sent at authorize.
    expect(h.idpCalls).toHaveLength(2);
    const tokenCall = h.idpCalls[0]!;
    expect(tokenCall.url).toBe('https://oauth2.googleapis.com/token');
    const tokenBody = tokenCall.init?.body;
    const form = new URLSearchParams(typeof tokenBody === 'string' ? tokenBody : '');
    expect(form.get('code')).toBe(IDP_CODE);
    expect(form.get('redirect_uri')).toBe(`${CALLBACK_URL_BASE}/google/callback`);
    expect(form.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{64}$/);
    expect(h.idpCalls[1]!.url).toBe('https://openidconnect.googleapis.com/v1/userinfo');

    const loc = locationOf(top);
    expect(loc.origin).toBe('https://app.driftstack.dev');
    // Trailing slash: the canonical Pages path, so the hand-off skips the host's 308 hop.
    expect(loc.pathname).toBe('/auth/oauth-client/callback/');
    expect(loc.search).toBe('');
    const frag = fragmentOf(top);
    expect(frag.get('flow')).toBe(start.flowId);
    expect(frag.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    // Parked, not persisted: the account service and session mint were NOT called.
    expect(h.linkCalls).toHaveLength(0);
    expect(h.sessionCalls).toHaveLength(0);
    expect(h.storeSets[1]).toMatch(/^oauth-client-handoff:[0-9a-f]{64}$/);
    expect(h.storeConsumes[0]).toBe(h.storeSets[0]);
  });

  it('/redeem with the flow secret links the account and mints the session for THIS request, answering the legacy JSON shape plus `provider`', async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/usage?tab=1');
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    const code = fragmentOf(top).get('code') ?? '';
    const res = await redeem(h, code, start.secret);
    expect(res.statusCode).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.json()).toEqual({
      outcome: 'signed-in-existing-link',
      provider: 'google',
      account_id: 'acct-1',
      redirect_to: 'https://app.driftstack.dev/usage?tab=1',
      session_token: SESSION_PLAINTEXT,
    });
    expect(h.linkCalls).toHaveLength(1);
    expect(h.linkCalls[0]).toMatchObject({
      provider: 'google',
      providerSub: 'google-sub-1',
      email: 'person@example.test',
    });
    expect(h.sessionCalls).toHaveLength(1);
    expect(h.sessionCalls[0]).toMatchObject({ accountId: 'acct-1', provider: 'google' });
    expect(typeof h.sessionCalls[0]!.issuedFromIp).toBe('string');
  });

  it('a v2 failure after verification is a bounded #oauth_error on the dashboard, never a problem+json page: token exchange refused → exchange_failed', async () => {
    const h = await mountOauthHarness({ idp: 'token-fails' });
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(top.statusCode).toBe(302);
    expect(locationOf(top).origin).toBe('https://app.driftstack.dev');
    expect(fragmentOf(top).get('oauth_error')).toBe('exchange_failed');
    expect(h.idpCalls).toHaveLength(1);
    expect(h.storeSets, 'no hand-off record on failure').toHaveLength(1);
  });

  it('userinfo refused → userinfo_failed, and the verifier was still consumed (one attempt per state)', async () => {
    const h = await mountOauthHarness({ idp: 'userinfo-fails' });
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(fragmentOf(top).get('oauth_error')).toBe('userinfo_failed');
    expect(await h.store.peek(h.storeSets[0]!)).toBeNull();
  });

  it('a malformed binding_hash on /start is a 400, not a silent fall-through to the cookie flow', async () => {
    const h = await mountOauthHarness();
    const res = await h.app.inject({
      method: 'POST',
      url: '/v1/auth/oauth-client/start',
      payload: {
        provider: 'google',
        redirect_to: 'https://app.driftstack.dev/',
        binding_hash: 'nope',
      },
    });
    expect(res.statusCode).toBe(400);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(h.storeSets).toHaveLength(0);
  });
});
