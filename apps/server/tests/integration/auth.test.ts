// Integration tests for the auth + error-handler pipeline. Uses Fastify's
// `inject` (no port binding) so the suite is fast and deterministic.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { PROBLEM_TYPES } from '@driftstack/api-types';

describe('auth pipeline (GET /v1/whoami)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('200 with happy path bearer key', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/json/);
    expect(res.headers['x-request-id']).toBeTruthy();
    expect(res.headers['x-ratelimit-remaining']).toBeTruthy();

    const body = res.json<Record<string, unknown>>();
    expect(body.tier).toBe('api_builder');
    expect(body.scopes).toEqual(['read', 'write', 'account_owner', 'driftstack_internal_admin']);
  });

  it('403s an ordinary API key when the current account tier is Free', async () => {
    fx = await buildTestApp({ tier: 'free' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<{ type: string; detail: string }>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
    expect(body.detail).toContain('apiAccess');
    expect(body.detail).toContain('free');
  });

  it('401 with no Authorization header', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({ method: 'GET', url: '/v1/whoami' });

    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.Unauthorized);
    expect(body.title).toBe('Unauthorized');
    expect(body.status).toBe(401);
  });

  it('401 with malformed Authorization header', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: 'Basic abc' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.Unauthorized);
  });

  it('401 InvalidKey for an unknown key', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: 'Bearer ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.InvalidKey);
  });

  it('401 RevokedKey', async () => {
    fx = await buildTestApp({ keyRevoked: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.RevokedKey);
  });

  it('401 ExpiredKey', async () => {
    fx = await buildTestApp({ keyExpired: true });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.ExpiredKey);
  });

  it('403 when account suspended', async () => {
    fx = await buildTestApp({ accountStatus: 'suspended' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(403);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.Forbidden);
  });

  it('401 when account deleted (looks like invalid key to caller)', async () => {
    fx = await buildTestApp({ accountStatus: 'deleted' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.InvalidKey);
  });

  it('updates last_used_at on successful auth', async () => {
    fx = await buildTestApp();
    const before = (await fx.authRepo.findApiKeyByPrefix(fx.plaintext.slice(0, 16)))?.lastUsedAt;
    expect(before).toBeNull();

    await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    const after = (await fx.authRepo.findApiKeyByPrefix(fx.plaintext.slice(0, 16)))?.lastUsedAt;
    expect(after).toBeInstanceOf(Date);
  });
});

describe('public routes', () => {
  let fx: TestAppFixture;
  beforeEach(async () => {
    fx = await buildTestApp();
  });
  afterEach(async () => {
    await fx.cleanup();
  });

  it('GET /health is public and returns ok', async () => {
    const res = await fx.app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('GET /healthz is also public', async () => {
    const res = await fx.app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
  });

  it('GET /ready returns 200 with empty checks when no readinessChecks supplied', async () => {
    // Fixture passes no readinessChecks — /ready returns process-up
    // semantics only.
    const res = await fx.app.inject({ method: 'GET', url: '/ready' });
    expect(res.statusCode).toBe(200);
    const body = res.json<Record<string, unknown>>();
    expect(body.ready).toBe(true);
    expect(body.checks).toEqual([]);
  });

  it('unknown route returns 404 problem+json', async () => {
    const res = await fx.app.inject({ method: 'GET', url: '/v1/nope' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toMatch(/application\/problem\+json/);
    const body = res.json<Record<string, unknown>>();
    expect(body.type).toBe(PROBLEM_TYPES.NotFound);
  });
});

describe('rate limit', () => {
  it('returns 429 with retry-after when bucket is exhausted', async () => {
    // Drain the bucket directly via the store to avoid scrypt-bound timing
    // dependence on number of HTTP calls. Solo Manual has capacity 120 in the
    // 'global' bucket. The store key encodes (rl:<accountId>:global).
    const fx = await buildTestApp({ tier: 'solo_manual' });
    try {
      const drained = await fx.rateLimitStore.consume({
        key: `rl:${fx.accountId}:global`,
        capacity: 120,
        refillPerSecond: 2,
        cost: 120,
        // Park the bucket's refill clock 60s in the FUTURE. The store computes
        // `elapsedSec = Math.max(0, (now - lastRefillMs) / 1000)`, so a future
        // stamp clamps the refill to zero and the next request is denied
        // regardless of how long this test takes to reach it.
        //
        // Draining at `Date.now()` left a 500ms budget: the bucket refills at
        // 2 tokens/sec, so one token returns after half a second and the
        // request is allowed. That is comfortable in isolation — measured 53ms
        // drain-to-request — but not under full-suite load, where this test was
        // one of the intermittent failures in the CI coverage job.
        now: Date.now() + 60_000,
      });
      expect(drained.allowed).toBe(true);
      expect(Math.floor(drained.remaining)).toBe(0);

      const denied = await fx.app.inject({
        method: 'GET',
        url: '/v1/whoami',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(denied.statusCode).toBe(429);
      expect(denied.headers['content-type']).toMatch(/application\/problem\+json/);
      expect(denied.headers['retry-after']).toBeTruthy();
      const body = denied.json<{ type: string; retry_after_seconds: number }>();
      expect(body.type).toBe(PROBLEM_TYPES.RateLimited);
      expect(body.retry_after_seconds).toBeGreaterThan(0);
    } finally {
      await fx.cleanup();
    }
  });

  it('exposes x-ratelimit-remaining on successful authenticated requests', async () => {
    const fx = await buildTestApp({ tier: 'solo_manual' });
    try {
      const res = await fx.app.inject({
        method: 'GET',
        url: '/v1/whoami',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
      expect(res.statusCode).toBe(200);
      const remaining = Number(res.headers['x-ratelimit-remaining']);
      expect(remaining).toBeGreaterThanOrEqual(118);
      expect(remaining).toBeLessThan(120);
    } finally {
      await fx.cleanup();
    }
  });
});
