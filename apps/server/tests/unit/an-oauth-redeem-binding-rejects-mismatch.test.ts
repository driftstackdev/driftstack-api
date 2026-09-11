// Cookie-free OAuth v2 (2026-09-11) — the D2 replacement. The cookie↔state-
// nonce binding (`cookie.nonce !== stateNonce` on the legacy XHR route) becomes
// flow_secret↔state.bind at /redeem: only the browser holding the preimage of
// the digest signed into the state at /start can turn a hand-off into a
// session. This is what stops an attacker's state + callback URL from signing
// a victim in as the attacker, and it holds for PKCE-ignoring GitHub OAuth Apps.
//
// Reverting these production lines reds it:
//   • routes/auth-oauth-client.ts /redeem: `const presented = createHash('sha256')
//     .update(body.flow_secret).digest(); … if (expected.length !== presented.length
//     || !timingSafeEqual(expected, presented)) throw new BadRequestError('Sign-in
//     was not started by this browser.')` — drop it and the wrong secret answers 200.
//   • the consume-BEFORE-compare order (`flowStore.consume(handoffKey(body.code))`
//     above the compare) — move it below and the "second attempt is also 400" arm reds.

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  completeToHandoff,
  mintBinding,
  mountOauthHarness,
  redeem,
} from './an-oauth-v2-harness.js';

describe('an OAuth /redeem with a mismatched flow secret is refused before any account or session exists', () => {
  it('wrong preimage → 400, no linkOrCreateAccount, no session; the code is burnt so the right secret is ALSO refused afterwards', async () => {
    const h = await mountOauthHarness();
    const { start, code } = await completeToHandoff(h);
    const stranger = mintBinding().secret;
    expect(stranger).not.toBe(start.secret);

    const wrong = await redeem(h, code, stranger);
    expect(wrong.statusCode).toBe(400);
    expect(wrong.json<{ detail?: string }>().detail).toBe(
      'Sign-in was not started by this browser.',
    );
    expect(h.linkCalls).toHaveLength(0);
    expect(h.sessionCalls).toHaveLength(0);

    // Single attempt at the 256-bit preimage: the record went with the miss.
    const right = await redeem(h, code, start.secret);
    expect(right.statusCode).toBe(400);
    expect(right.json<{ detail?: string }>().detail).toMatch(/invalid, expired, or already used/);
    expect(h.linkCalls).toHaveLength(0);
  });

  it("login-CSRF walk: a victim browser that never wrote the flow secret cannot redeem the attacker-started flow, even with the attacker's valid callback URL", async () => {
    const h = await mountOauthHarness();
    // Attacker completes consent for THEIR account and captures the fragment
    // the top-level route issued. The victim's page holds no record for that
    // flow_id; the only way to "try" is a guessed secret.
    const { code } = await completeToHandoff(h, 'github');
    const victimGuess = mintBinding().secret;
    const res = await redeem(h, code, victimGuess);
    expect(res.statusCode).toBe(400);
    expect(h.sessionCalls).toHaveLength(0);
  });

  it('the compare is over sha256(flow_secret) — sending the DIGEST itself as the secret does not pass', async () => {
    const h = await mountOauthHarness();
    const { start, code } = await completeToHandoff(h);
    const digestAsSecret = createHash('sha256').update(start.secret).digest('base64url');
    expect(digestAsSecret).toBe(start.bindingHash);
    const res = await redeem(h, code, digestAsSecret);
    expect(res.statusCode).toBe(400);
    expect(res.json<{ detail?: string }>().detail).toBe('Sign-in was not started by this browser.');
  });
});
