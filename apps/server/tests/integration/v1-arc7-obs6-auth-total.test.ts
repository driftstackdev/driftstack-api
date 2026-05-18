// Arc 7 obs.6 — end-to-end verification of the
// driftstack_auth_total counter through the full requireAuth
// preHandler. Asserts every classified outcome label fires from a
// real HTTP request through the lib/app.ts auth plugin (not the
// in-test stub from the unit suite).
//
// The auth pipeline integration tests in tests/integration/auth.test.ts
// already exercise the response side (401/200 + problem-type body);
// this slice pins the metric emission so a regression that breaks
// the metric without breaking the response shape still fails CI.

import { afterEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';
import { METRIC_NAMES } from '../../src/services/metrics-registry.js';

describe('Arc 7 obs.6 — auth_total counter (integration)', () => {
  let fx: TestAppFixture;

  afterEach(async () => {
    if (fx) await fx.cleanup();
  });

  it('outcome="ok" on a happy-path whoami', async () => {
    fx = await buildTestApp();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'ok' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(200);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'ok' })).toBe(before + 1);
  });

  it('outcome="unauthorized" when the Authorization header is absent', async () => {
    fx = await buildTestApp();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, {
      outcome: 'unauthorized',
    });
    const res = await fx.app.inject({ method: 'GET', url: '/v1/whoami' });
    expect(res.statusCode).toBe(401);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(
      before + 1,
    );
  });

  it('outcome="unauthorized" when the Authorization header is malformed', async () => {
    fx = await buildTestApp();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, {
      outcome: 'unauthorized',
    });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: 'Basic abc' },
    });
    expect(res.statusCode).toBe(401);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(
      before + 1,
    );
  });

  it('outcome="invalid" on an unknown bearer key', async () => {
    fx = await buildTestApp();
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'invalid' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: 'Bearer ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' },
    });
    expect(res.statusCode).toBe(401);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'invalid' })).toBe(
      before + 1,
    );
  });

  it('outcome="revoked" when the calling key is revoked', async () => {
    fx = await buildTestApp({ keyRevoked: true });
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'revoked' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(401);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'revoked' })).toBe(
      before + 1,
    );
  });

  it('outcome="expired" when the calling key has expired', async () => {
    fx = await buildTestApp({ keyExpired: true });
    const before = fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'expired' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/whoami',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });
    expect(res.statusCode).toBe(401);
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'expired' })).toBe(
      before + 1,
    );
  });

  it('different outcomes accumulate in separate cells across mixed traffic', async () => {
    fx = await buildTestApp();
    const okBefore = fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'ok' });
    const unauthBefore = fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, {
      outcome: 'unauthorized',
    });
    // 2 ok, 3 unauthorized — checks the cells stay independent.
    for (let i = 0; i < 2; i++) {
      await fx.app.inject({
        method: 'GET',
        url: '/v1/whoami',
        headers: { authorization: `Bearer ${fx.plaintext}` },
      });
    }
    for (let i = 0; i < 3; i++) {
      await fx.app.inject({ method: 'GET', url: '/v1/whoami' });
    }
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'ok' })).toBe(
      okBefore + 2,
    );
    expect(fx.metricsRegistry.getValue(METRIC_NAMES.authTotal, { outcome: 'unauthorized' })).toBe(
      unauthBefore + 3,
    );
  });
});
