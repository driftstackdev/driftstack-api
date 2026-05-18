// Arc 7 obs.5 — end-to-end verification of the
// driftstack_rate_limit_total counter through the full Fastify
// rate-limit plugin under lib/app.ts. Parallels the obs.15 / obs.6
// integration tests but on the rate-limit middleware.
//
// Strategy: set a tiny capacity override (1 request, no refill) on
// the `global` bucket for the test account, then send 3 requests:
//   - request 1 → allowed (counter outcome=allowed)
//   - request 2 → exceeded (counter outcome=exceeded)
//   - request 3 → exceeded (counter outcome=exceeded)
// Pin both label cells.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

describe('Arc 7 obs.5 — rate_limit_total counter (integration)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('outcome="allowed" on permitted requests', async () => {
    fx = await buildTestApp();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.rateLimitTotal, {
      bucket: 'global',
      outcome: 'allowed',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.rateLimitTotal, {
        bucket: 'global',
        outcome: 'allowed',
      }),
    ).toBe(before + 1);
  });

  it('outcome="exceeded" when an override drains the bucket', async () => {
    fx = await buildTestApp();
    // Apply a capacity-1 no-refill override on the global bucket for
    // this account. Future requests after the first should 429.
    await fx.rateLimitOverridesRepo.upsert({
      accountId: fx.accountId,
      bucketKey: 'global',
      capacity: 1,
      refillPerSecond: 0,
      expiresAt: new Date(Date.now() + 60_000),
      setByKeyId: fx.apiKeyId,
    });
    // V-355 auth cache invalidation — the auth cache holds the prior
    // empty overrides set; invalidate so the next request sees the
    // new override.
    await fx.authCache.invalidateAccount(fx.accountId);

    const allowedBefore = fx.metricsRegistry.getValue(METRIC_NAMES.rateLimitTotal, {
      bucket: 'global',
      outcome: 'allowed',
    });
    const exceededBefore = fx.metricsRegistry.getValue(METRIC_NAMES.rateLimitTotal, {
      bucket: 'global',
      outcome: 'exceeded',
    });

    // Request 1 — allowed (consumes the 1 token).
    const r1 = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(r1.statusCode).toBe(200);

    // Request 2 — bucket empty, no refill → 429.
    const r2 = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(r2.statusCode).toBe(429);
    expect(r2.headers['retry-after']).toBeTruthy();

    // Request 3 — still exceeded.
    const r3 = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(r3.statusCode).toBe(429);

    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.rateLimitTotal, {
        bucket: 'global',
        outcome: 'allowed',
      }),
    ).toBe(allowedBefore + 1);
    expect(
      fx.metricsRegistry.getValue(METRIC_NAMES.rateLimitTotal, {
        bucket: 'global',
        outcome: 'exceeded',
      }),
    ).toBe(exceededBefore + 2);
  });
});
