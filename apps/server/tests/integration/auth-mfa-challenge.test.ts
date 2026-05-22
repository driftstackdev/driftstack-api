// V-353d — integration tests for the MFA login hand-off:
// /v1/auth/login returns a challenge token when the account has MFA
// enrolled; /v1/auth/mfa/challenge exchanges the token + code (or
// recovery code) for the real session.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { computeTotpCode } from '../../src/lib/mfa-totp.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface SignupResponse {
  verification_email_expires_at: string;
  debug_token?: string;
}

interface SessionEnvelope {
  session: { token: string; expires_at: string; account_id: string };
}

interface MfaRequiredResponse {
  mfa_required: true;
  challenge_token: string;
  challenge_expires_at: string;
}

interface EnrollStartResponse {
  otpauth_uri: string;
  secret_base32: string;
  algorithm: 'SHA1';
  digits: 6;
  period_seconds: 30;
}

interface ChallengeResponse {
  session: { token: string; expires_at: string; account_id: string };
  via: 'totp' | 'recovery';
}

function base32Decode(input: string): Buffer {
  const cleaned = input.replace(/=+$/g, '').toUpperCase();
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of cleaned) {
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

/** Signup + verify-email + enroll TOTP + complete enrollment. Returns
 *  the email + password + raw secret bytes + the recovery codes (caller
 *  drives whichever auth flow it needs). */
async function setupEnrolledAccount(
  fixture: TestAppFixture,
  email: string,
  password: string,
): Promise<{ secretBytes: Buffer; recoveryCodes: string[]; firstSessionToken: string }> {
  const signup = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password },
  });
  const verifyToken = signup.json<SignupResponse>().debug_token;
  if (!verifyToken) throw new Error('debug_token missing');
  const verify = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verifyToken },
  });
  expect(verify.statusCode).toBe(200);
  const firstSessionToken = verify.json<SessionEnvelope>().session.token;

  const enroll = await fixture.app.inject({
    method: 'POST',
    url: '/v1/account/mfa/enroll',
    headers: { authorization: `Bearer ${firstSessionToken}` },
  });
  const secretBytes = base32Decode(enroll.json<EnrollStartResponse>().secret_base32);

  const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
  const complete = await fixture.app.inject({
    method: 'POST',
    url: '/v1/account/mfa/verify',
    headers: { authorization: `Bearer ${firstSessionToken}`, 'content-type': 'application/json' },
    payload: { code },
  });
  expect(complete.statusCode).toBe(200);
  const recoveryCodes = complete.json<{ recovery_codes: string[] }>().recovery_codes;

  return { secretBytes, recoveryCodes, firstSessionToken };
}

describe('POST /v1/auth/login when MFA enrolled (V-353d)', () => {
  // 2026-05-23 — 30s timeout for scrypt-heavy MFA enrollment under
  // high test-parallelism CPU contention.
  it(
    '200 returns challenge_token + challenge_expires_at instead of session',
    { timeout: 30_000 },
    async () => {
      fx = await buildTestApp();
      await setupEnrolledAccount(fx, 'mfa-login@driftstack.local', 'correct horse battery staple');

      const login = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { email: 'mfa-login@driftstack.local', password: 'correct horse battery staple' },
      });
      expect(login.statusCode).toBe(200);
      const body = login.json<MfaRequiredResponse | SessionEnvelope>();
      expect('mfa_required' in body).toBe(true);
      if ('mfa_required' in body) {
        expect(body.mfa_required).toBe(true);
        expect(body.challenge_token).toMatch(/^[A-Za-z0-9_-]{40,}$/);
        expect(new Date(body.challenge_expires_at).getTime()).toBeGreaterThan(Date.now());
      }
    },
  );

  it('returns plain session when MFA NOT enrolled (back-compat)', async () => {
    fx = await buildTestApp();
    // Just signup + verify, no MFA enroll.
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'no-mfa@driftstack.local', password: 'correct horse battery staple' },
    });
    const t = signup.json<SignupResponse>().debug_token!;
    await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: t },
    });

    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'no-mfa@driftstack.local', password: 'correct horse battery staple' },
    });
    expect(login.statusCode).toBe(200);
    const body = login.json<MfaRequiredResponse | SessionEnvelope>();
    expect('mfa_required' in body).toBe(false);
    if ('session' in body) expect(body.session.token).toBeTruthy();
  });
});

describe('POST /v1/auth/mfa/challenge (V-353d)', () => {
  it('200 exchanges challenge_token + correct TOTP for a session', async () => {
    fx = await buildTestApp();
    const { secretBytes } = await setupEnrolledAccount(
      fx,
      'mfa-totp-challenge@driftstack.local',
      'correct horse battery staple',
    );
    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'mfa-totp-challenge@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const challengeToken = login.json<MfaRequiredResponse>().challenge_token;

    const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    const challenge = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/challenge',
      payload: { challenge_token: challengeToken, code },
    });
    expect(challenge.statusCode).toBe(200);
    const body = challenge.json<ChallengeResponse>();
    expect(body.via).toBe('totp');
    expect(body.session.token).toBeTruthy();

    // Token works: bearer-auth a request with it.
    const me = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/mfa',
      headers: { authorization: `Bearer ${body.session.token}` },
    });
    expect(me.statusCode).toBe(200);
  });

  it('200 exchanges challenge_token + recovery code, marks code consumed', async () => {
    fx = await buildTestApp();
    const { recoveryCodes, firstSessionToken } = await setupEnrolledAccount(
      fx,
      'mfa-recovery@driftstack.local',
      'correct horse battery staple',
    );
    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: {
        email: 'mfa-recovery@driftstack.local',
        password: 'correct horse battery staple',
      },
    });
    const challengeToken = login.json<MfaRequiredResponse>().challenge_token;

    const challenge = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/challenge',
      payload: { challenge_token: challengeToken, recovery_code: recoveryCodes[0] },
    });
    expect(challenge.statusCode).toBe(200);
    expect(challenge.json<ChallengeResponse>().via).toBe('recovery');

    // Status now shows 9 unused recovery codes (the first one was consumed).
    const status = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/mfa',
      headers: { authorization: `Bearer ${firstSessionToken}` },
    });
    expect(status.json<{ unused_recovery_codes: number }>().unused_recovery_codes).toBe(9);
  });

  it('400 when neither code nor recovery_code provided', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/challenge',
      payload: { challenge_token: 'whatever' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects unknown challenge_token', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/challenge',
      payload: { challenge_token: 'nonexistent', code: '000000' },
    });
    // InvalidAuthTokenError → 400 (mapAuthFlowError).
    expect(res.statusCode).toBe(400);
  });

  it('refuses correct token + wrong TOTP code, leaves token consumable', async () => {
    fx = await buildTestApp();
    const { secretBytes } = await setupEnrolledAccount(
      fx,
      'mfa-retry@driftstack.local',
      'correct horse battery staple',
    );
    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'mfa-retry@driftstack.local', password: 'correct horse battery staple' },
    });
    const challengeToken = login.json<MfaRequiredResponse>().challenge_token;

    const wrong = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/challenge',
      payload: { challenge_token: challengeToken, code: '000000' },
    });
    expect(wrong.statusCode).toBe(400);

    // Same token still consumable with the right code.
    const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    const right = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/challenge',
      payload: { challenge_token: challengeToken, code },
    });
    expect(right.statusCode).toBe(200);
  });

  it('refuses re-use of a successfully-consumed challenge_token', async () => {
    fx = await buildTestApp();
    const { secretBytes } = await setupEnrolledAccount(
      fx,
      'mfa-reuse@driftstack.local',
      'correct horse battery staple',
    );
    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'mfa-reuse@driftstack.local', password: 'correct horse battery staple' },
    });
    const challengeToken = login.json<MfaRequiredResponse>().challenge_token;
    const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
    const first = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/challenge',
      payload: { challenge_token: challengeToken, code },
    });
    expect(first.statusCode).toBe(200);

    const second = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/challenge',
      payload: { challenge_token: challengeToken, code },
    });
    expect(second.statusCode).toBe(400);
  });
});
