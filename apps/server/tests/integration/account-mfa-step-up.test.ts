// V-353e — integration tests for the step-up gate.
//
// Sensitive routes (DELETE /v1/account/mfa, POST /v1/account/mfa/disable)
// require `web_sessions.mfa_satisfied_at` to be within 15 min of now
// when the calling account has MFA enrolled. POST /v1/auth/mfa/step-up
// refreshes the timestamp on the calling session.
//
// API keys remain valid for status reads, but every MFA credential mutation
// requires an interactive web session before the freshness gate is evaluated.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { computeTotpCode } from '../../src/lib/mfa-totp.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

interface SignupResponse {
  debug_token?: string;
}
interface SessionEnvelope {
  session: { token: string; expires_at: string; account_id: string };
}
interface MfaRequiredResponse {
  mfa_required: true;
  challenge_token: string;
}
interface EnrollStartResponse {
  secret_base32: string;
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

/**
 * Common setup: signup → verify → enroll TOTP → /verify → re-login →
 * complete MFA challenge. Returns a web-session token whose
 * `mfa_satisfied_at` is fresh (just stamped via the challenge path).
 */
async function setupEnrolledFreshSession(
  fixture: TestAppFixture,
  email: string,
): Promise<{ token: string; secretBytes: Buffer }> {
  const password = 'correct horse battery staple';
  const signup = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/signup',
    payload: { email, password },
  });
  const verifyToken = signup.json<SignupResponse>().debug_token!;
  const verify = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/verify-email',
    payload: { token: verifyToken },
  });
  const firstSessionToken = verify.json<SessionEnvelope>().session.token;

  const enroll = await fixture.app.inject({
    method: 'POST',
    url: '/v1/account/mfa/enroll',
    headers: { authorization: `Bearer ${firstSessionToken}` },
  });
  const secretBytes = base32Decode(enroll.json<EnrollStartResponse>().secret_base32);
  await fixture.app.inject({
    method: 'POST',
    url: '/v1/account/mfa/verify',
    headers: { authorization: `Bearer ${firstSessionToken}`, 'content-type': 'application/json' },
    payload: { code: computeTotpCode(secretBytes, Math.floor(Date.now() / 1000)) },
  });

  // Fresh login → MFA challenge → real session with mfa_satisfied_at stamped.
  const login = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email, password },
  });
  const challengeToken = login.json<MfaRequiredResponse>().challenge_token;
  const challenge = await fixture.app.inject({
    method: 'POST',
    url: '/v1/auth/mfa/challenge',
    payload: {
      challenge_token: challengeToken,
      code: computeTotpCode(secretBytes, Math.floor(Date.now() / 1000)),
    },
  });
  expect(challenge.statusCode).toBe(200);
  return {
    token: challenge.json<SessionEnvelope>().session.token,
    secretBytes,
  };
}

describe('V-353e step-up gate on DELETE /v1/account/mfa + POST disable', () => {
  // 2026-05-23 — 30s timeout for scrypt-heavy MFA enrollment under
  // high test-parallelism CPU contention.
  it('200/204: fresh MFA-satisfied web session passes the gate', { timeout: 30_000 }, async () => {
    fx = await buildTestApp();
    const { token } = await setupEnrolledFreshSession(fx, 'fresh@driftstack.local');
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/mfa',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { confirm: 'disable-mfa' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('204 immediately after enrollment because the first TOTP proof freshly satisfies that session', async () => {
    fx = await buildTestApp();
    // Signup + verify-email gives a session, then activation atomically
    // advances account authority and rebases only this exact session. The
    // first verified TOTP is itself a fresh factor proof, so an immediate
    // sensitive action should not demand the same code a second time.
    const password = 'correct horse battery staple';
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'stale@driftstack.local', password },
    });
    const verifyToken = signup.json<SignupResponse>().debug_token!;
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });
    const sessionToken = verify.json<SessionEnvelope>().session.token;

    const enroll = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const secretBytes = base32Decode(enroll.json<EnrollStartResponse>().secret_base32);
    await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      payload: { code: computeTotpCode(secretBytes, Math.floor(Date.now() / 1000)) },
    });

    // The exact enrolling session is now both current-epoch and freshly
    // MFA-satisfied; predecessor sessions are invalidated instead.
    const res = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/mfa',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      payload: { confirm: 'disable-mfa' },
    });
    expect(res.statusCode).toBe(204);
  });

  it('204 after POST /v1/auth/mfa/step-up refreshes the satisfied timestamp', async () => {
    fx = await buildTestApp();
    const password = 'correct horse battery staple';
    const signup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      payload: { email: 'stepup@driftstack.local', password },
    });
    const verifyToken = signup.json<SignupResponse>().debug_token!;
    const verify = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });
    const sessionToken = verify.json<SessionEnvelope>().session.token;

    const enroll = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/enroll',
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    const secretBytes = base32Decode(enroll.json<EnrollStartResponse>().secret_base32);
    await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/verify',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      payload: { code: computeTotpCode(secretBytes, Math.floor(Date.now() / 1000)) },
    });

    // Step-up reauth on the existing session.
    const stepUp = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      payload: { code: computeTotpCode(secretBytes, Math.floor(Date.now() / 1000)) },
    });
    expect(stepUp.statusCode).toBe(200);
    expect(stepUp.json<{ via: string }>().via).toBe('totp');

    // Now disable should pass.
    const del = await fx.app.inject({
      method: 'DELETE',
      url: '/v1/account/mfa',
      headers: { authorization: `Bearer ${sessionToken}`, 'content-type': 'application/json' },
      payload: { confirm: 'disable-mfa' },
    });
    expect(del.statusCode).toBe(204);
  });

  it('POST /v1/account/mfa/disable alias has the same step-up gate', async () => {
    fx = await buildTestApp();
    const { token } = await setupEnrolledFreshSession(fx, 'post-alias@driftstack.local');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/account/mfa/disable',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { confirm: 'disable-mfa' },
    });
    expect(res.statusCode).toBe(204);
  });

  it.each([
    { method: 'POST' as const, url: '/v1/account/mfa/enroll', payload: undefined },
    {
      method: 'POST' as const,
      url: '/v1/account/mfa/verify',
      payload: { code: '123456' },
    },
    {
      method: 'DELETE' as const,
      url: '/v1/account/mfa',
      payload: { confirm: 'disable-mfa' },
    },
    {
      method: 'POST' as const,
      url: '/v1/account/mfa/disable',
      payload: { confirm: 'disable-mfa' },
    },
    {
      method: 'POST' as const,
      url: '/v1/account/mfa/recovery-codes/regenerate',
      payload: undefined,
    },
  ])(
    '$method $url rejects an API-key bearer before mutating MFA',
    async ({ method, url, payload }) => {
      fx = await buildTestApp();
      const res = await fx.app.inject({
        method,
        url,
        headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
        payload,
      });
      expect(res.statusCode).toBe(403);
      expect(res.headers['content-type']).toContain('application/problem+json');
      const problem = res.json<Record<string, unknown>>();
      expect(problem).toMatchObject({
        type: 'https://errors.driftstack.dev/forbidden',
        title: 'Forbidden',
        status: 403,
        detail: 'MFA credential management requires an interactive web session.',
      });
      expect(problem['instance']).toBe(res.headers['x-request-id']);
    },
  );
});

describe('POST /v1/auth/mfa/step-up validation (V-353e)', () => {
  it('400 when neither code nor recovery_code provided', async () => {
    fx = await buildTestApp();
    const { token } = await setupEnrolledFreshSession(fx, 'stepup-empty@driftstack.local');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('400 with wrong code', async () => {
    fx = await buildTestApp();
    const { token } = await setupEnrolledFreshSession(fx, 'stepup-wrong@driftstack.local');
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      payload: { code: '000000' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('403 when caller is API-key authed (no session to refresh)', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      headers: { authorization: `Bearer ${fx.plaintext}`, 'content-type': 'application/json' },
      payload: { code: '123456' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('401 without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/mfa/step-up',
      payload: { code: '123456' },
    });
    expect(res.statusCode).toBe(401);
  });
});
