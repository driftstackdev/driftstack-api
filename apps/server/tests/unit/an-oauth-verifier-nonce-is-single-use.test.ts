// Cookie-free OAuth v2 (2026-09-11) — the PKCE verifier lives server-side under
// the state nonce and is GETDEL'd by the top-level callback, so a captured
// callback URL cannot be replayed even inside the state's 5-minute TTL, and a
// replay makes NO outbound IDP call. The cookie design never had this.
//
// Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts top-level route `const verifier = await
//     deps.flowStore.consume(verifierKey(payload.nonce)); if (verifier === null)
//     return fail('state_replayed');` — a peek, or a fallback to a cookie/state-
//     embedded verifier, answers the replay with a second exchange.

import { describe, expect, it } from 'vitest';
import {
  IDP_CODE,
  fragmentOf,
  mintBinding,
  mountOauthHarness,
  signState,
  startV2,
  topLevel,
} from './an-oauth-v2-harness.js';

describe('an OAuth v2 verifier record is single-use', () => {
  it('the same callback URL a second time → #oauth_error=state_replayed and zero additional IDP calls', async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const first = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(fragmentOf(first).get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(h.idpCalls).toHaveLength(2);

    const replay = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(replay.statusCode).toBe(302);
    expect(fragmentOf(replay).get('oauth_error')).toBe('state_replayed');
    expect(fragmentOf(replay).get('code')).toBeNull();
    expect(h.idpCalls, 'a replay must not reach the IDP').toHaveLength(2);
    expect(h.storeSets, 'a replay must not mint a second hand-off').toHaveLength(2);
  });

  it('a validly-signed v2 state whose verifier was never stored (expired from the store, or minted elsewhere) → state_replayed, no IDP call', async () => {
    const h = await mountOauthHarness();
    const state = signState({ bind: mintBinding().bindingHash, nonce: 'never-started-nonce' });
    const res = await topLevel(h, 'google', { code: IDP_CODE, state });
    expect(res.statusCode).toBe(302);
    expect(fragmentOf(res).get('oauth_error')).toBe('state_replayed');
    expect(h.idpCalls).toHaveLength(0);
    expect(h.storeConsumes).toHaveLength(1);
  });

  it('a verifier is consumed exactly once even when the exchange then fails (no second try on the same state)', async () => {
    const h = await mountOauthHarness({ idp: 'token-fails' });
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const first = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(fragmentOf(first).get('oauth_error')).toBe('exchange_failed');
    const again = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    expect(fragmentOf(again).get('oauth_error')).toBe('state_replayed');
    expect(h.idpCalls).toHaveLength(1);
  });
});
