// V-251 / V-246-P1-004 — IP-rate-limit gate on auth endpoints.
//
// Tests:
//   - rate limit fires after threshold (per-endpoint capacity)
//   - per-IP isolation (one IP exhausting doesn't affect another)
//   - threshold values match founder-direction spec
//   - signup / login / verify-email / password-reset all gated
//   - security audit 2026-07-01: signup's absolute per-IP DAILY ceiling
//     (25/24h) trips even when every individual request is paced slowly
//     enough that the burst token bucket alone would allow it forever
//
// `app.inject` lets us spoof remote-address via the `remoteAddress`
// option so we can vary the IP per request without spinning up real
// HTTP listeners.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
  // Belt-and-suspenders: the daily-ceiling test below fakes `Date` to pace
  // requests without real wall-clock sleeps. Always restore real timers
  // even if that test fails an assertion mid-way.
  vi.useRealTimers();
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

  // Same 25-round-trip budget as the headers case below — each signup does real
  // password hashing, so this is load-sensitive against the 10s default.
  it(
    'signup: absolute 25/IP/day ceiling still trips a perfectly-paced attacker the burst bucket alone would allow forever (security audit 2026-07-01)',
    { timeout: 60_000 },
    async () => {
      // The burst bucket alone (capacity=5, refill=5/60 tokens/sec) never
      // denies a caller paced at >= 12s/request — that's the exact abuse
      // this test proves is now closed. We pace every request 60s apart
      // (via a faked `Date`, so the test itself stays fast) which is MORE
      // than enough for the burst bucket to fully refill between every
      // single call, so the burst bucket can never be the thing that denies
      // request #26 below — only the new daily ceiling can.
      fx = await buildTestApp();
      const ip = '203.0.113.70';
      const PACE_MS = 60_000;

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const start = Date.now();
        // 25 paced signups from the same IP: none should be 429 — the daily
        // ceiling (25/day) permits exactly this many, and the burst bucket
        // was never at risk given the 60s pacing.
        for (let i = 0; i < 25; i++) {
          vi.setSystemTime(start + i * PACE_MS);
          const res = await fx.app.inject({
            method: 'POST',
            url: '/v1/auth/signup',
            headers,
            remoteAddress: ip,
            payload: {
              email: `daily-ceiling-${i.toString()}@example.test`,
              password: 'correct horse battery staple',
            },
          });
          expect(res.statusCode, `request #${(i + 1).toString()} should not be 429`).not.toBe(429);
        }

        // The 26th paced signup (still 60s after the previous one — the
        // burst bucket would happily allow it) is rejected by the daily
        // ceiling alone.
        vi.setSystemTime(start + 25 * PACE_MS);
        const twentySixth = await fx.app.inject({
          method: 'POST',
          url: '/v1/auth/signup',
          headers,
          remoteAddress: ip,
          payload: {
            email: 'daily-ceiling-25@example.test',
            password: 'correct horse battery staple',
          },
        });
        expect(twentySixth.statusCode).toBe(429);
        expect(twentySixth.headers['retry-after']).toBeDefined();
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it(
    'signup: the absolute ceiling does not replenish early inside its rolling 24-hour window',
    { timeout: 60_000 },
    async () => {
      fx = await buildTestApp();
      const ip = '203.0.113.73';

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const start = Date.now();
        for (let i = 0; i < 25; i++) {
          vi.setSystemTime(start + i * 60_000);
          const res = await fx.app.inject({
            method: 'POST',
            url: '/v1/auth/signup',
            headers,
            remoteAddress: ip,
            payload: {
              email: `rolling-ceiling-${i.toString()}@example.test`,
              password: 'correct horse battery staple',
            },
          });
          expect(res.statusCode).not.toBe(429);
        }

        vi.setSystemTime(start + 23 * 60 * 60 * 1000);
        const beforeExpiry = await fx.app.inject({
          method: 'POST',
          url: '/v1/auth/signup',
          headers,
          remoteAddress: ip,
          payload: {
            email: 'rolling-ceiling-before-expiry@example.test',
            password: 'correct horse battery staple',
          },
        });
        expect(beforeExpiry.statusCode).toBe(429);

        vi.setSystemTime(start + 24 * 60 * 60 * 1000);
        const atExpiry = await fx.app.inject({
          method: 'POST',
          url: '/v1/auth/signup',
          headers,
          remoteAddress: ip,
          payload: {
            email: 'rolling-ceiling-at-expiry@example.test',
            password: 'correct horse battery staple',
          },
        });
        expect(atExpiry.statusCode).not.toBe(429);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  // 25 sequential signup round trips, each doing real password hashing. That is
  // comfortably under the 10s default when the file runs alone, but it timed out
  // at 10,048ms once under parallel integration load — a budget problem, not a
  // race. The per-test timeout is raised rather than trimming the loop, because
  // the 25-request span is exactly what proves the daily ceiling keeps
  // decrementing while the burst bucket refills.
  it(
    'signup: daily-ceiling headers surface remaining/reset independently of the burst-bucket headers, decrementing across 25 requests (security audit 2026-07-01 fix #2)',
    { timeout: 60_000 },
    async () => {
      fx = await buildTestApp();
      const ip = '203.0.113.71';
      const PACE_MS = 60_000;

      vi.useFakeTimers({ toFake: ['Date'] });
      try {
        const start = Date.now();
        let previousDailyRemaining = Infinity;
        for (let i = 0; i < 25; i++) {
          vi.setSystemTime(start + i * PACE_MS);
          const res = await fx.app.inject({
            method: 'POST',
            url: '/v1/auth/signup',
            headers,
            remoteAddress: ip,
            payload: {
              email: `daily-headers-${i.toString()}@example.test`,
              password: 'correct horse battery staple',
            },
          });
          expect(res.statusCode).not.toBe(429);
          // The daily ceiling's own headers must be present on every request
          // once a daily ceiling is configured for the route — distinct from
          // the burst bucket's `x-ratelimit-*` headers (which reset every
          // ~60s and would misleadingly read "plenty left" at this pace).
          const dailyRemaining = Number(res.headers['x-ratelimit-daily-remaining']);
          const dailyReset = Number(res.headers['x-ratelimit-daily-reset']);
          expect(res.headers['x-ratelimit-daily-remaining']).toBeDefined();
          expect(res.headers['x-ratelimit-daily-reset']).toBeDefined();
          expect(Number.isNaN(dailyRemaining)).toBe(false);
          expect(Number.isNaN(dailyReset)).toBe(false);
          // Strictly decrementing request-over-request (paced 60s apart, far
          // slower than the daily bucket's ~1-token/57.6min refill, so it
          // never has time to refill a whole token between calls).
          expect(dailyRemaining).toBeLessThan(previousDailyRemaining);
          previousDailyRemaining = dailyRemaining;
        }
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it('signup: daily-ceiling store error fails CLOSED (denies the request) instead of silently granting a fresh fallback allotment (security audit 2026-07-01 fix #1)', async () => {
    fx = await buildTestApp();
    const ip = '203.0.113.72';
    const originalConsume = fx.rateLimitStore.consumeSlidingWindow.bind(fx.rateLimitStore);
    // Simulate a Redis-store error, but ONLY for the daily-ceiling bucket
    // key — the burst bucket (a distinct key, `auth-ip:signup:<ip>`) keeps
    // working normally, isolating exactly the behavior under test: what
    // happens when the DAILY check's own store call throws.
    fx.rateLimitStore.consumeSlidingWindow = (opts) => {
      if (opts.key.includes('-daily-window:')) {
        return Promise.reject(new Error('simulated redis outage'));
      }
      return originalConsume(opts);
    };

    // A brand-new IP's very first signup ever — the burst bucket has full
    // capacity and would allow it, and the (buggy, pre-fix) fallback store
    // would ALSO allow it by silently minting a fresh 25-token daily
    // allotment for this key. The fix must deny it instead.
    const res = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers,
      remoteAddress: ip,
      payload: {
        email: 'daily-outage-1@example.test',
        password: 'correct horse battery staple',
      },
    });
    expect(res.statusCode).toBe(429);
    expect(res.headers['retry-after']).toBeDefined();

    // Prove it's a durable fail-CLOSED posture, not a one-off: a second
    // attempt (which a fallback store with 25 capacity would still have
    // budget for) is denied too, since the daily check never got to
    // consume from — or grant — any fallback bucket at all.
    const res2 = await fx.app.inject({
      method: 'POST',
      url: '/v1/auth/signup',
      headers,
      remoteAddress: ip,
      payload: {
        email: 'daily-outage-2@example.test',
        password: 'correct horse battery staple',
      },
    });
    expect(res2.statusCode).toBe(429);
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
