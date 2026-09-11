// Cookie-free OAuth v2 (2026-09-11) — brief §3: the session token must reach the
// SPA on app.driftstack.io "without putting a long-lived credential in a URL
// that lands in history, logs and Referer". The top-level 302 carries only a
// single-use hand-off code, in the FRAGMENT; the 30-day session (or the 5-min
// MFA challenge token) exists only after /redeem and travels once, in JSON.
//
// Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts top-level route: `const location =
//     `${origin}/auth/oauth-client/callback/` + `#flow=…` + `&code=…`` — putting
//     the code in the query, or calling completeSignIn() there and placing
//     session_token/challenge_token in the Location, reds the arms below.
//   • /redeem being the ONLY caller of completeSignIn on the v2 path.

import { describe, expect, it } from 'vitest';
import {
  IDP_CODE,
  SESSION_PLAINTEXT,
  fragmentOf,
  locationOf,
  mountOauthHarness,
  redeem,
  startV2,
  topLevel,
} from './an-oauth-v2-harness.js';

const CREDENTIAL_WORDS = ['session_token', 'challenge_token', 'account_id', SESSION_PLAINTEXT];

describe('an OAuth redirect URL carries no session credential', () => {
  it('happy path: the Location has an empty query, a fragment with only flow+code, and none of the credential fields; the session appears only in the /redeem JSON', async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/usage');
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    const raw = String(top.headers.location);
    for (const word of CREDENTIAL_WORDS) expect(raw).not.toContain(word);
    expect(raw).not.toContain(IDP_CODE);
    const loc = locationOf(top);
    expect(loc.search).toBe('');
    expect([...fragmentOf(top).keys()].sort()).toEqual(['code', 'flow']);

    const res = await redeem(h, fragmentOf(top).get('code') ?? '', start.secret);
    expect(res.json<{ session_token?: string }>().session_token).toBe(SESSION_PLAINTEXT);
  });

  it('MFA-enrolled account: the challenge token is minted at /redeem, never in the Location', async () => {
    const h = await mountOauthHarness({
      sessionResult: {
        kind: 'mfa_required',
        challengeToken: 'ds_mfac_guard_challenge',
        challengeExpiresAt: new Date('2026-09-11T10:05:00Z'),
      },
    });
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const top = await topLevel(h, 'google', { code: IDP_CODE, state: start.state });
    const raw = String(top.headers.location);
    expect(raw).not.toContain('ds_mfac_guard_challenge');
    expect(raw).not.toContain('challenge');
    expect(h.sessionCalls, 'no challenge exists before /redeem').toHaveLength(0);

    const res = await redeem(h, fragmentOf(top).get('code') ?? '', start.secret);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      outcome: 'signed-in-existing-link',
      provider: 'google',
      mfa_required: true,
      challenge_token: 'ds_mfac_guard_challenge',
      challenge_expires_at: '2026-09-11T10:05:00.000Z',
    });
    expect(res.json<{ session_token?: string }>().session_token).toBeUndefined();
  });

  it("error redirects carry only the bounded enum — the IDP's free-text error never reaches the Location", async () => {
    const h = await mountOauthHarness();
    const start = await startV2(h, 'google', 'https://app.driftstack.dev/');
    const res = await topLevel(h, 'google', {
      error: 'access_denied',
      error_description: 'The user <script>alert(1)</script> said no ' + 'x'.repeat(400),
      state: start.state,
    });
    const raw = String(res.headers.location);
    expect(raw).toBe(
      'https://app.driftstack.dev/auth/oauth-client/callback/#oauth_error=idp_denied',
    );
    expect(h.idpCalls).toHaveLength(0);
  });
});
