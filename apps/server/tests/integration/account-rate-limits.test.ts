// V-219 — integration tests for /v1/account/rate-limits.

import { afterEach, describe, expect, it } from 'vitest';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

const auth = (fixture: TestAppFixture): { authorization: string } => ({
  authorization: `Bearer ${fixture.plaintext}`,
});

interface BucketRow {
  bucket_key: 'global' | 'sessions:create' | 'agent_sessions:message';
  capacity: number;
  refill_per_second: number;
  source: 'tier_default' | 'override';
  override_expires_at: string | null;
}
interface RateLimitsResponse {
  tier: string;
  buckets: BucketRow[];
}

describe('GET /v1/account/rate-limits', () => {
  it('returns the locked tier defaults from TIER_RATE_LIMIT_DEFAULTS', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/rate-limits',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<RateLimitsResponse>();
    expect(body.tier).toBe('api_builder');
    // v2-#8 sub-slice 8.20 — 3 buckets (added agent_sessions:message).
    expect(body.buckets).toHaveLength(3);

    const expected = TIER_RATE_LIMIT_DEFAULTS.api_builder;
    const global = body.buckets.find((b) => b.bucket_key === 'global');
    expect(global).toBeDefined();
    expect(global!.capacity).toBe(expected.global.capacity);
    expect(global!.refill_per_second).toBe(expected.global.refill_per_second);
    expect(global!.source).toBe('tier_default');
    expect(global!.override_expires_at).toBeNull();

    const create = body.buckets.find((b) => b.bucket_key === 'sessions:create');
    expect(create!.capacity).toBe(expected['sessions:create'].capacity);
    expect(create!.refill_per_second).toBe(expected['sessions:create'].refill_per_second);

    const message = body.buckets.find((b) => b.bucket_key === 'agent_sessions:message');
    expect(message).toBeDefined();
    expect(message!.capacity).toBe(expected['agent_sessions:message'].capacity);
    expect(message!.refill_per_second).toBe(expected['agent_sessions:message'].refill_per_second);
    expect(message!.source).toBe('tier_default');
    expect(message!.override_expires_at).toBeNull();
  });

  it('reflects an active rate-limit override on the global bucket', async () => {
    fx = await buildTestApp({ tier: 'api_starter' });

    // Set an override via the admin endpoint (test fixture has admin scope).
    const setRes = await fx.app.inject({
      method: 'POST',
      url: `/v1/admin/accounts/acc_${fx.accountId}/quota-override`,
      headers: auth(fx),
      payload: {
        bucket_key: 'global',
        capacity: 10000,
        refill_per_second: 200,
        duration_seconds: 3600,
        reason: 'rate-limits test',
      },
    });
    expect([200, 201]).toContain(setRes.statusCode);

    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/rate-limits',
      headers: auth(fx),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<RateLimitsResponse>();
    const global = body.buckets.find((b) => b.bucket_key === 'global');
    expect(global!.capacity).toBe(10000);
    expect(global!.refill_per_second).toBe(200);
    expect(global!.source).toBe('override');
    expect(global!.override_expires_at).not.toBeNull();

    // sessions:create unaffected — still tier default.
    const create = body.buckets.find((b) => b.bucket_key === 'sessions:create');
    expect(create!.source).toBe('tier_default');
  });

  it('rejects without auth', async () => {
    fx = await buildTestApp();
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/account/rate-limits',
    });
    expect(res.statusCode).toBe(401);
  });
});
