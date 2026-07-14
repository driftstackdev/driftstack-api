// V-353b — integration tests for /v1/account/mfa/* (TOTP enrollment,
// verify, status, recovery-code regen, disable).

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { computeTotpCode } from '../../src/lib/mfa-totp.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface EnrollStartResponse {
  otpauth_uri: string;
  secret_base32: string;
  algorithm: 'SHA1';
  digits: 6;
  period_seconds: 30;
}

interface EnrollCompleteResponse {
  recovery_codes: string[];
}

interface MfaStatusResponse {
  enrolled: boolean;
  enrolled_at: string | null;
  last_used_at: string | null;
  unused_recovery_codes: number;
}

interface SignupResponse {
  debug_token?: string;
}

interface SessionEnvelope {
  session: { token: string };
}

async function buildInteractiveFixture(): Promise<{ authorization: string }> {
  fx = await buildTestApp();
  const signup = await fx.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: {
      email: 'mfa-route-owner@driftstack.local',
      password: 'correct horse battery staple',
    },
  });
  const verificationToken = signup.json<SignupResponse>().debug_token;
  if (!verificationToken) throw new Error('fixture did not expose verification token');
  const verify = await fx.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verificationToken },
  });
  expect(verify.statusCode).toBe(200);
  const token = verify.json<SessionEnvelope>().session.token;
  return { authorization: `Bearer ${token}` };
}

/** Decode a base32-encoded TOTP secret back into raw bytes so the test
 *  can compute a current code with the same library function the
 *  service uses. RFC 4648 base32 (uppercase A-Z + 2-7). */
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

describe('GET /v1/account/mfa (V-353b)', () => {
  it('200 returns enrolled=false when never enrolled', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/mfa',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<MfaStatusResponse>();
    expect(body.enrolled).toBe(false);
    expect(body.enrolled_at).toBeNull();
    expect(body.unused_recovery_codes).toBe(0);
  });
});

describe('POST /v1/account/mfa/enroll → /verify (V-353b)', () => {
  it('200 enroll returns otpauth uri + base32 secret + algorithm metadata', async () => {
    const headers = await buildInteractiveFixture();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<EnrollStartResponse>();
    expect(body.otpauth_uri).toMatch(/^otpauth:\/\/totp\/Driftstack(?::|%3A).+\?/);
    expect(body.algorithm).toBe('SHA1');
    expect(body.digits).toBe(6);
    expect(body.period_seconds).toBe(30);
    // Base32 alphabet, length divisible by 8 after the 20-byte secret.
    expect(body.secret_base32).toMatch(/^[A-Z2-7]{32}$/);

    // /enroll is idempotent on the pending state — a re-call returns
    // a fresh secret rather than 409 (since the prior call's secret
    // is still pending, not enrolled).
    const again = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    expect(again.statusCode).toBe(200);
  });

  it('200 verify accepts the current code, returns 10 recovery codes', async () => {
    const headers = await buildInteractiveFixture();
    const enroll = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    const enrollBody = enroll.json<EnrollStartResponse>();
    const secretBytes = base32Decode(enrollBody.secret_base32);
    const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));

    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { code },
    });
    expect(verify.statusCode).toBe(200);
    const body = verify.json<EnrollCompleteResponse>();
    expect(body.recovery_codes).toHaveLength(10);
    // Recovery code shape: 5-char + hyphen + 5-char, Crockford alphabet
    // (no 0/1/I/O/L).
    expect(
      body.recovery_codes.every((c) =>
        /^[A-HJKMNPQRSTVWXYZ23456789]{5}-[A-HJKMNPQRSTVWXYZ23456789]{5}$/.test(c),
      ),
    ).toBe(true);

    // Status now reflects enrolled=true.
    const status = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/mfa',
      headers,
    });
    const statusBody = status.json<MfaStatusResponse>();
    expect(statusBody.enrolled).toBe(true);
    expect(statusBody.enrolled_at).toBeTruthy();
    expect(statusBody.unused_recovery_codes).toBe(10);
  });

  it('keeps only the enrolling session valid after activation and evicts a cached predecessor', async () => {
    fx = await buildTestApp();
    const email = 'mfa-epoch-owner@driftstack.local';
    const password = 'correct horse battery staple';
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email, password },
    });
    const verificationToken = signup.json<SignupResponse>().debug_token;
    if (!verificationToken) throw new Error('fixture did not expose verification token');
    const verified = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verificationToken },
    });
    const enrollingToken = verified.json<SessionEnvelope>().session.token;
    const predecessorLogin = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password },
    });
    expect(predecessorLogin.statusCode).toBe(200);
    const predecessorToken = predecessorLogin.json<SessionEnvelope>().session.token;
    const enrollingHeaders = { authorization: `Bearer ${enrollingToken}` };
    const predecessorHeaders = { authorization: `Bearer ${predecessorToken}` };

    // Populate the predecessor's positive auth-cache entry before authority
    // changes, reproducing the short cache window that must also be closed.
    expect(
      (await fx.app.inject({ method: 'GET', url: '/v1/account/mfa', headers: predecessorHeaders }))
        .statusCode,
    ).toBe(200);

    const enroll = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers: enrollingHeaders,
    });
    const secret = base32Decode(enroll.json<EnrollStartResponse>().secret_base32);
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: enrollingHeaders,
      payload: { code: computeTotpCode(secret, Math.floor(Date.now() / 1000)) },
    });
    expect(verify.statusCode).toBe(200);

    expect(
      (await fx.app.inject({ method: 'GET', url: '/v1/account/mfa', headers: enrollingHeaders }))
        .statusCode,
    ).toBe(200);
    expect(
      (await fx.app.inject({ method: 'GET', url: '/v1/account/mfa', headers: predecessorHeaders }))
        .statusCode,
    ).toBe(401);
  });

  it('400 verify rejects a wrong code', async () => {
    const headers = await buildInteractiveFixture();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { code: '000000' },
    });
    expect(verify.statusCode).toBe(400);
  });

  it('400 verify rejects malformed code (not 6 digits)', async () => {
    const headers = await buildInteractiveFixture();
    await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { code: '12345' },
    });
    expect(verify.statusCode).toBe(400);
  });

  it('409 enroll on already-enrolled account refuses; disable + re-enroll works', async () => {
    const headers = await buildInteractiveFixture();
    // Initial enroll + verify
    const enroll1 = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    const secret1 = base32Decode(enroll1.json<EnrollStartResponse>().secret_base32);
    const code1 = computeTotpCode(secret1, Math.floor(Date.now() / 1000));
    const verify1 = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { code: code1 },
    });
    const recoveryCode = verify1.json<EnrollCompleteResponse>().recovery_codes[0];
    const stepUp = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { recovery_code: recoveryCode },
    });
    expect(stepUp.statusCode).toBe(200);

    // Re-enroll on already-enrolled account → 409
    const enroll2 = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    expect(enroll2.statusCode).toBe(409);

    // Disable + re-enroll works.
    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/mfa',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { confirm: 'disable-mfa' },
    });
    expect(del.statusCode).toBe(204);

    const enroll3 = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    expect(enroll3.statusCode).toBe(200);
  });
});

describe('DELETE /v1/account/mfa (V-353b)', () => {
  it('400 without confirm body field', async () => {
    const headers = await buildInteractiveFixture();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/mfa',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('204 idempotent on never-enrolled account', async () => {
    const headers = await buildInteractiveFixture();
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/mfa',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { confirm: 'disable-mfa' },
    });
    expect(res.statusCode).toBe(204);
  });
});

describe('POST /v1/account/mfa/recovery-codes/regenerate (V-353b)', () => {
  it('200 returns 10 fresh codes; old codes invalidated', async () => {
    const headers = await buildInteractiveFixture();
    const enroll = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers,
    });
    const secretBytes = base32Decode(enroll.json<EnrollStartResponse>().secret_base32);
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { code: computeTotpCode(secretBytes, Math.floor(Date.now() / 1000)) },
    });
    const originalCodes = verify.json<EnrollCompleteResponse>().recovery_codes;

    const stepUp = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { ...headers, 'content-type': 'application/json' },
      payload: { recovery_code: originalCodes[0] },
    });
    expect(stepUp.statusCode).toBe(200);

    const regen = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/recovery-codes/regenerate',
      headers,
    });
    expect(regen.statusCode).toBe(200);
    const newCodes = regen.json<EnrollCompleteResponse>().recovery_codes;
    expect(newCodes).toHaveLength(10);
    // Fresh codes should not overlap with the original set (probabilistically
    // certain — 30^10 codes per slot).
    expect(originalCodes.every((c) => !newCodes.includes(c))).toBe(true);

    // Status shows 10 unused.
    const status = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/mfa',
      headers,
    });
    expect(status.json<MfaStatusResponse>().unused_recovery_codes).toBe(10);
  });

  it('404 when MFA is not enrolled', async () => {
    const headers = await buildInteractiveFixture();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/recovery-codes/regenerate',
      headers,
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('401 unauth on /v1/account/mfa/* (V-353b)', () => {
  it.each([
    { method: 'GET' as const, url: '/v1/account/mfa' },
    { method: 'POST' as const, url: '/v1/account/mfa/enroll' },
    { method: 'POST' as const, url: '/v1/account/mfa/verify' },
    { method: 'DELETE' as const, url: '/v1/account/mfa' },
    { method: 'POST' as const, url: '/v1/account/mfa/recovery-codes/regenerate' },
  ])('$method $url returns 401 without auth', async ({ method, url }) => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method, url });
    expect(res.statusCode).toBe(401);
  });
});
