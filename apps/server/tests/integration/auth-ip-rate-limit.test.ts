// V-251 / V-246-P1-004 — IP-rate-limit gate on auth endpoints.
//
// Tests:
//   - rate limit fires after threshold (per-endpoint capacity)
//   - per-IP isolation (one IP exhausting doesn't affect another)
//   - threshold values match founder-direction spec
//   - signup / login / verify-email / password-reset all gated
//
// `app.inject` lets us spoof remote-address via the `remoteAddress`
// option so we can vary the IP per request without spinning up real
// HTTP listeners.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const headers = { 'content-type': 'application/json' };

describe('V-251 — IP rate limit on auth endpoints', () => {
  it('signup: 5 attempts/IP/min — 6th from same IP returns 429', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.10';
    // First 5 succeed (each creates a fresh signup; emails differ to
    // avoid the EmailAlreadyRegisteredError gate).
    for (let i = 0; i < 5; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        headers,
        remoteAddress: ip,
        payload: {
          email: `ratelimit-${i.toString()}@example.test`,
          password: 'correct horse battery staple',
        },
      });
      // Each individual signup may legitimately fail for non-rate-limit
      // reasons (e.g. validation), but the FIRST 5 should never be
      // 429. Accepting any non-429 status here.
      expect(res.statusCode).not.toBe(429);
    }
    // 6th attempt from same IP exceeds capacity → 429.
    const sixth = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers,
      remoteAddress: ip,
      payload: {
        email: 'ratelimit-6@example.test',
        password: 'correct horse battery staple',
      },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  it('login: 10 attempts/IP/min — 11th from same IP returns 429', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.20';
    // Use invalid credentials so login itself fails (401) but
    // doesn't side-effect the DB; we're testing the rate-limit gate
    // fires BEFORE the authentication check.
    for (let i = 0; i < 10; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers,
        remoteAddress: ip,
        payload: { email: 'nobody@example.test', password: 'wrong' },
      });
      expect(res.statusCode).not.toBe(429);
    }
    const eleventh = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers,
      remoteAddress: ip,
      payload: { email: 'nobody@example.test', password: 'wrong' },
    });
    expect(eleventh.statusCode).toBe(429);
  });

  it('password-reset/request: 3/IP/min — 4th from same IP returns 429', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.30';
    for (let i = 0; i < 3; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/request',
        headers,
        remoteAddress: ip,
        payload: { email: 'unknown@example.test' },
      });
      expect(res.statusCode).not.toBe(429);
    }
    const fourth = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      headers,
      remoteAddress: ip,
      payload: { email: 'unknown@example.test' },
    });
    expect(fourth.statusCode).toBe(429);
  });

  it('magic-link/request: 3/IP/min — 4th from same IP returns 429 (#190 2026-05-15 follow-up)', async () => {
    // Pre-affda641 the route had no rate-limit at all and every call
    // fired a Postmark send. Same 3/min cap as password-reset since the
    // abuse profile is identical: anonymous public endpoint, each call
    // triggers a transactional email.
    fx = await buildTestApp();
    const ip = '203.0.113.40';
    for (let i = 0; i < 3; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/magic-link/request',
        headers,
        remoteAddress: ip,
        payload: { email: 'unknown@example.test' },
      });
      expect(res.statusCode).not.toBe(429);
    }
    const fourth = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/magic-link/request',
      headers,
      remoteAddress: ip,
      payload: { email: 'unknown@example.test' },
    });
    expect(fourth.statusCode).toBe(429);
    expect(fourth.headers['retry-after']).toBeDefined();
  });

  it('resend-verification: 3/IP/min — 4th from same IP returns 429 (#187)', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.50';
    for (let i = 0; i < 3; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/resend-verification',
        headers,
        remoteAddress: ip,
        payload: { email: 'unknown@example.test' },
      });
      expect(res.statusCode).not.toBe(429);
    }
    const fourth = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      headers,
      remoteAddress: ip,
      payload: { email: 'unknown@example.test' },
    });
    expect(fourth.statusCode).toBe(429);
  });

  it('verify-email: 10/IP/min — 11th from same IP returns 429', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.40';
    // Use invalid token so verify-email itself fails (400 InvalidAuthToken)
    // — rate limit fires BEFORE the token check.
    const bogusToken = 'a'.repeat(43);
    for (let i = 0; i < 10; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/verify-email',
        headers,
        remoteAddress: ip,
        payload: { token: bogusToken },
      });
      expect(res.statusCode).not.toBe(429);
    }
    const eleventh = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      headers,
      remoteAddress: ip,
      payload: { token: bogusToken },
    });
    expect(eleventh.statusCode).toBe(429);
  });

  it('per-IP isolation: one IP exhausting does not affect another', async () => {
    fx = await buildTestApp();
    const attackerIp = '203.0.113.50';
    const legitimateIp = '203.0.113.51';
    // Attacker exhausts the password-reset bucket (cap=3).
    for (let i = 0; i < 3; i++) {
      await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/password-reset/request',
        headers,
        remoteAddress: attackerIp,
        payload: { email: 'unknown@example.test' },
      });
    }
    const attackerRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      headers,
      remoteAddress: attackerIp,
      payload: { email: 'unknown@example.test' },
    });
    expect(attackerRes.statusCode).toBe(429);
    // Legitimate user from a different IP is unaffected.
    const legitimateRes = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/password-reset/request',
      headers,
      remoteAddress: legitimateIp,
      payload: { email: 'unknown@example.test' },
    });
    expect(legitimateRes.statusCode).not.toBe(429);
  });

  it('per-endpoint isolation: signup exhaustion does not affect login', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.60';
    // Exhaust signup bucket (cap=5).
    for (let i = 0; i < 5; i++) {
      await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/signup',
        headers,
        remoteAddress: ip,
        payload: {
          email: `iso-${i.toString()}@example.test`,
          password: 'correct horse battery staple',
        },
      });
    }
    const sixthSignup = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers,
      remoteAddress: ip,
      payload: { email: 'iso-6@example.test', password: 'correct horse battery staple' },
    });
    expect(sixthSignup.statusCode).toBe(429);
    // Login from same IP still works (different bucket).
    const login = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers,
      remoteAddress: ip,
      payload: { email: 'nobody@example.test', password: 'wrong' },
    });
    expect(login.statusCode).not.toBe(429);
  });

  it('cli-authorize/initiate: 5 attempts/IP/min — 6th from same IP returns 429', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.60';
    for (let i = 0; i < 5; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/cli-authorize/initiate',
        headers,
        remoteAddress: ip,
        payload: { state: `cli-state-nonce-${i.toString()}` },
      });
      expect(res.statusCode).not.toBe(429);
    }
    const sixth = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/cli-authorize/initiate',
      headers,
      remoteAddress: ip,
      payload: { state: 'cli-state-nonce-6' },
    });
    expect(sixth.statusCode).toBe(429);
    expect(sixth.headers['retry-after']).toBeDefined();
  });

  it('cli-authorize/exchange: generous poll bucket (60/min) — 6 quick polls from one IP never 429', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.61';
    // The exchange endpoint is a CLI poll loop; the looser bucket must let a
    // legitimate poll run without tripping (a non-existent code → not_found,
    // but never 429 within the bucket).
    for (let i = 0; i < 6; i++) {
      const res = await fx.app.inject({
        method: 'POST',
        url: '/v1/auth/cli-authorize/exchange',
        headers,
        remoteAddress: ip,
        payload: { code: 'nonexistent-code-value-1234', state: 'cli-state-nonce-x' },
      });
      expect(res.statusCode).not.toBe(429);
    }
  });
});
