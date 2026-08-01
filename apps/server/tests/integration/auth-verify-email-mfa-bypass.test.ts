// V-720 — end-to-end reproduction of the verify-email MFA bypass.
//
// /v1/auth/verify-email was the ONE session-minting flow with no MFA branch:
// login, magic-link, password-reset and OAuth all return a challenge when the
// account has an enrolled second factor, but verify-email handed back a full
// web session. Anyone holding the signup email therefore defeated MFA — which
// is precisely the threat MFA exists to backstop.
//
// The gap was locked in by a source-text parity pin whose title asserted
// verify-email "always returns a session", so it read as intended behaviour.
// That is why this file is BEHAVIOURAL and drives real HTTP: the parity pin
// guards the expression, not the invariant.
//
// REACHABILITY — the chain below is the exploit, not a hypothetical. It works
// because consumeMagicLink marks the email verified ITSELF and mints a session,
// so the owner reaches an authenticated, MFA-enrollable state while the signup
// verification token is still live and unconsumed:
//
//   1. signup                  -> verification token A issued, unconsumed
//   2. magic-link request      -> token B
//   3. magic-link consume      -> session; email now marked verified
//   4. enroll + verify TOTP    -> second factor now required for this account
//   5. verify-email with A     -> must be a CHALLENGE, never a session
//
// resendSignupVerification refuses once the email is verified, but that guard
// says nothing about the already-issued token; A stays live for its full
// 30-minute signupVerification TTL.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { computeTotpCode } from '../../src/lib/mfa-totp.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface DebugTokenResponse {
  debug_token?: string;
}
interface SessionEnvelope {
  session: { token: string };
}
interface MfaRequiredEnvelope {
  mfa_required?: true;
  challenge_token?: string;
  challenge_expires_at?: string;
  session?: unknown;
}
interface EnrollStartResponse {
  secret_base32: string;
}

/** RFC 4648 base32 (uppercase A-Z + 2-7) -> raw bytes, so the test can compute
 *  a live code with the same function the service verifies against. */
function base32Decode(input: string): Buffer {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of input.replace(/=+$/g, '').toUpperCase()) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error(`bad base32 char: ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describe('V-720 — /v1/auth/verify-email honours an enrolled second factor', () => {
  it('returns an MFA challenge (not a session) for a still-live signup link after the owner enrolled TOTP', async () => {
    fx = await buildTestApp();
    const email = 'verify-email-mfa-bypass@driftstack.local';

    // 1. Sign up. Verification token A is issued and left UNCONSUMED.
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password: 'correct horse battery staple' },
    });
    expect(signup.statusCode).toBe(200);
    const verificationTokenA = signup.json<DebugTokenResponse>().debug_token;
    if (!verificationTokenA) throw new Error('fixture did not expose the verification token');

    // 2-3. Reach an authenticated state WITHOUT spending token A. Magic-link
    //      consumption marks the email verified on its own, so this is the step
    //      that makes the whole chain reachable.
    const magicRequest = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/request',
      payload: { email },
    });
    expect(magicRequest.statusCode).toBe(200);
    const magicToken = magicRequest.json<DebugTokenResponse>().debug_token;
    if (!magicToken) throw new Error('fixture did not expose the magic-link token');

    const magicConsume = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/consume',
      payload: { token: magicToken },
    });
    expect(magicConsume.statusCode).toBe(200);
    const headers = {
      authorization: `Bearer ${magicConsume.json<SessionEnvelope>().session.token}`,
    };

    // 4. Enroll a real second factor from that session.
    const enroll = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    expect(enroll.statusCode).toBe(200);
    const secretBytes = base32Decode(enroll.json<EnrollStartResponse>().secret_base32);
    const enrollVerify = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { code: computeTotpCode(secretBytes, Math.floor(Date.now() / 1000)) },
    });
    expect(enrollVerify.statusCode).toBe(200);

    // 5. Token A is still live. Redeeming it must NOT hand back a session.
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verificationTokenA },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<MfaRequiredEnvelope>();
    expect(body.mfa_required).toBe(true);
    expect(typeof body.challenge_token).toBe('string');
    expect(body.challenge_expires_at).toEqual(expect.any(String));
    // The bypass itself: no session token may cross the wire.
    expect(body.session).toBeUndefined();
    expect(res.body).not.toContain('"token"');
  });

  it('still returns a session when the account has no second factor enrolled', async () => {
    fx = await buildTestApp();
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: {
        email: 'verify-email-no-mfa@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const token = signup.json<DebugTokenResponse>().debug_token;
    if (!token) throw new Error('fixture did not expose the verification token');

    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<MfaRequiredEnvelope>();
    expect(body.mfa_required).toBeUndefined();
    expect(typeof (body.session as { token?: string } | undefined)?.token).toBe('string');
  });
});
