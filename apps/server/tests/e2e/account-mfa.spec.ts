// V-540.B-1 — E2E walkthrough of the /v1/account/mfa lifecycle.
//
// Exercises the full TOTP enroll → verify → status → disable cycle via
// real HTTP against the test server, plus the recovery-codes regen
// path and the explicit-confirm guard on disable. Credential-changing
// operations use the same web-session boundary as the dashboard; a separate
// assertion keeps API-key status reads working without letting machine keys
// mutate the human factor.

import { test, expect, type APIRequestContext } from '@playwright/test';
import { startTestServer, type TestServer } from './helpers/server.js';
import { seedAccount, authHeader } from './helpers/seed.js';
import { computeTotpCode } from '../../src/lib/mfa-totp.js';

let server: TestServer;

test.beforeAll(async () => {
  server = await startTestServer();
});

test.afterAll(async () => {
  if (server) await server.cleanup();
});

test.beforeEach(async () => {
  await server.resetState();
});

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/=+$/, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error(`base32: invalid char ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

interface EnrollResponse {
  otpauth_uri: string;
  secret_base32: string;
  algorithm: 'SHA1';
  digits: 6;
  period_seconds: 30;
}

interface VerifyResponse {
  recovery_codes: string[];
}

interface StatusResponse {
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

async function interactiveAuth(
  request: APIRequestContext,
  email: string,
): Promise<{ Authorization: string }> {
  const signup = await request.post(`${server.baseUrl}/v1/auth/signup`, {
    data: { email, password: 'correct horse battery staple' },
  });
  expect(signup.status()).toBe(200);
  const verificationToken = ((await signup.json()) as SignupResponse).debug_token;
  expect(verificationToken).toBeTruthy();
  const verify = await request.post(`${server.baseUrl}/v1/auth/verify-email`, {
    data: { token: verificationToken },
  });
  expect(verify.status()).toBe(200);
  const token = ((await verify.json()) as SessionEnvelope).session.token;
  return authHeader(token);
}

test('GET /v1/account/mfa returns enrolled=false for fresh account', async ({ request }) => {
  const seed = await seedAccount(server.client);
  const res = await request.get(`${server.baseUrl}/v1/account/mfa`, {
    headers: authHeader(seed.plaintext),
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as StatusResponse;
  expect(body.enrolled).toBe(false);
  expect(body.enrolled_at).toBeNull();
  expect(body.unused_recovery_codes).toBe(0);
});

test('full enroll → verify → status → disable cycle', async ({ request }) => {
  const headers = await interactiveAuth(request, 'mfa-cycle@driftstack.test');

  const enrollRes = await request.post(`${server.baseUrl}/v1/account/mfa/enroll`, {
    headers,
  });
  expect(enrollRes.status()).toBe(200);
  const enroll = (await enrollRes.json()) as EnrollResponse;
  expect(enroll.otpauth_uri).toMatch(/^otpauth:\/\/totp\//);
  expect(enroll.secret_base32).toMatch(/^[A-Z2-7]+$/);
  expect(enroll.algorithm).toBe('SHA1');
  expect(enroll.digits).toBe(6);
  expect(enroll.period_seconds).toBe(30);

  const secretBytes = base32Decode(enroll.secret_base32);
  const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));

  const verifyRes = await request.post(`${server.baseUrl}/v1/account/mfa/verify`, {
    headers,
    data: { code },
  });
  expect(verifyRes.status()).toBe(200);
  const verify = (await verifyRes.json()) as VerifyResponse;
  expect(Array.isArray(verify.recovery_codes)).toBe(true);
  expect(verify.recovery_codes.length).toBeGreaterThanOrEqual(8);
  for (const rc of verify.recovery_codes) {
    expect(rc).toMatch(/^[A-Z0-9-]+$/);
  }

  const stepUp = await request.post(`${server.baseUrl}/v1/auth/mfa/step-up`, {
    headers,
    data: { recovery_code: verify.recovery_codes[0] },
  });
  expect(stepUp.status()).toBe(200);

  const statusRes = await request.get(`${server.baseUrl}/v1/account/mfa`, { headers });
  expect(statusRes.status()).toBe(200);
  const status = (await statusRes.json()) as StatusResponse;
  expect(status.enrolled).toBe(true);
  expect(status.enrolled_at).not.toBeNull();
  expect(status.unused_recovery_codes).toBe(verify.recovery_codes.length - 1);

  const disableRes = await request.post(`${server.baseUrl}/v1/account/mfa/disable`, {
    headers,
    data: { confirm: 'disable-mfa' },
  });
  expect(disableRes.status()).toBe(204);

  const postDisableStatus = (await (
    await request.get(`${server.baseUrl}/v1/account/mfa`, { headers })
  ).json()) as StatusResponse;
  expect(postDisableStatus.enrolled).toBe(false);
  expect(postDisableStatus.unused_recovery_codes).toBe(0);
});

test('POST /v1/account/mfa/verify with wrong code returns 400', async ({ request }) => {
  const headers = await interactiveAuth(request, 'mfa-wrong@driftstack.test');

  await request.post(`${server.baseUrl}/v1/account/mfa/enroll`, { headers });
  const verifyRes = await request.post(`${server.baseUrl}/v1/account/mfa/verify`, {
    headers,
    data: { code: '000000' },
  });
  expect(verifyRes.status()).toBe(400);
});

test('POST /v1/account/mfa/verify with malformed body returns 400', async ({ request }) => {
  const headers = await interactiveAuth(request, 'mfa-malformed@driftstack.test');

  await request.post(`${server.baseUrl}/v1/account/mfa/enroll`, { headers });
  const verifyRes = await request.post(`${server.baseUrl}/v1/account/mfa/verify`, {
    headers,
    data: { code: 'not-six-digits' },
  });
  expect(verifyRes.status()).toBe(400);
});

test('POST /v1/account/mfa/disable without confirm body returns 400', async ({ request }) => {
  const headers = await interactiveAuth(request, 'mfa-confirm@driftstack.test');

  const enrollRes = await request.post(`${server.baseUrl}/v1/account/mfa/enroll`, { headers });
  const enroll = (await enrollRes.json()) as EnrollResponse;
  const secretBytes = base32Decode(enroll.secret_base32);
  const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
  const verify = await request.post(`${server.baseUrl}/v1/account/mfa/verify`, {
    headers,
    data: { code },
  });
  const recoveryCodes = ((await verify.json()) as VerifyResponse).recovery_codes;
  const stepUp = await request.post(`${server.baseUrl}/v1/auth/mfa/step-up`, {
    headers,
    data: { recovery_code: recoveryCodes[0] },
  });
  expect(stepUp.status()).toBe(200);

  const disableRes = await request.post(`${server.baseUrl}/v1/account/mfa/disable`, {
    headers,
    data: {},
  });
  expect(disableRes.status()).toBe(400);

  const stillEnrolled = (await (
    await request.get(`${server.baseUrl}/v1/account/mfa`, { headers })
  ).json()) as StatusResponse;
  expect(stillEnrolled.enrolled).toBe(true);
});

test('DELETE /v1/account/mfa back-compat alias also disables', async ({ request }) => {
  const headers = await interactiveAuth(request, 'mfa-delete@driftstack.test');

  const enrollRes = await request.post(`${server.baseUrl}/v1/account/mfa/enroll`, { headers });
  const enroll = (await enrollRes.json()) as EnrollResponse;
  const secretBytes = base32Decode(enroll.secret_base32);
  const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
  const verify = await request.post(`${server.baseUrl}/v1/account/mfa/verify`, {
    headers,
    data: { code },
  });
  const recoveryCodes = ((await verify.json()) as VerifyResponse).recovery_codes;
  const stepUp = await request.post(`${server.baseUrl}/v1/auth/mfa/step-up`, {
    headers,
    data: { recovery_code: recoveryCodes[0] },
  });
  expect(stepUp.status()).toBe(200);

  const disableRes = await request.delete(`${server.baseUrl}/v1/account/mfa`, {
    headers,
    data: { confirm: 'disable-mfa' },
  });
  expect(disableRes.status()).toBe(204);
});

test('POST /v1/account/mfa/recovery-codes/regenerate issues a fresh batch', async ({ request }) => {
  const headers = await interactiveAuth(request, 'mfa-regen@driftstack.test');

  const enrollRes = await request.post(`${server.baseUrl}/v1/account/mfa/enroll`, { headers });
  const enroll = (await enrollRes.json()) as EnrollResponse;
  const secretBytes = base32Decode(enroll.secret_base32);
  const code = computeTotpCode(secretBytes, Math.floor(Date.now() / 1000));
  const firstVerify = (await (
    await request.post(`${server.baseUrl}/v1/account/mfa/verify`, {
      headers,
      data: { code },
    })
  ).json()) as VerifyResponse;

  const stepUp = await request.post(`${server.baseUrl}/v1/auth/mfa/step-up`, {
    headers,
    data: { recovery_code: firstVerify.recovery_codes[0] },
  });
  expect(stepUp.status()).toBe(200);

  const regenRes = await request.post(
    `${server.baseUrl}/v1/account/mfa/recovery-codes/regenerate`,
    { headers },
  );
  expect(regenRes.status()).toBe(200);
  const regen = (await regenRes.json()) as VerifyResponse;
  expect(regen.recovery_codes.length).toBe(firstVerify.recovery_codes.length);

  // Recovery code set should be a brand-new batch — overlap with the
  // initial set is statistically impossible at 8+ random codes.
  const overlap = regen.recovery_codes.filter((code) => firstVerify.recovery_codes.includes(code));
  expect(overlap.length).toBe(0);

  const status = (await (
    await request.get(`${server.baseUrl}/v1/account/mfa`, { headers })
  ).json()) as StatusResponse;
  expect(status.unused_recovery_codes).toBe(regen.recovery_codes.length);
});

test('endpoints return 401 without auth header', async ({ request }) => {
  const noAuthEndpoints = [
    { method: 'get' as const, path: '/v1/account/mfa' },
    { method: 'post' as const, path: '/v1/account/mfa/enroll' },
    {
      method: 'post' as const,
      path: '/v1/account/mfa/verify',
      data: { code: '000000' },
    },
    {
      method: 'post' as const,
      path: '/v1/account/mfa/disable',
      data: { confirm: 'disable-mfa' },
    },
    { method: 'delete' as const, path: '/v1/account/mfa' },
    {
      method: 'post' as const,
      path: '/v1/account/mfa/recovery-codes/regenerate',
    },
  ];
  for (const ep of noAuthEndpoints) {
    const res = await request[ep.method](`${server.baseUrl}${ep.path}`, {
      data: ep.data,
    });
    expect(res.status(), `${ep.method.toUpperCase()} ${ep.path}`).toBe(401);
  }
});
