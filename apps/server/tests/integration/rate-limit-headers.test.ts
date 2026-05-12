// W199/W200 — integration coverage for the customer-facing
// `x-ratelimit-*` header set. The /docs/rate-limits page promises four
// headers; this test asserts the server actually emits them on a
// representative rate-limited route. Catches regressions where a
// future refactor drops one of the four off the response.

import { afterEach, describe, expect, it } from 'vitest';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';
import { buildTestApp, type TestAppFixture } from './_helpers/build-test-app.js';

let fx: TestAppFixture;

afterEach(async () => {
  if (fx) await fx.cleanup();
});

describe('W199/W200 rate-limit response headers', () => {
  it('sets x-ratelimit-bucket / -limit / -remaining / -reset on a rate-limited route', async () => {
    fx = await buildTestApp({ tier: 'api_builder' });
    const res = await fx.app.inject({
      method: 'GET',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
    });

    // The 'global' bucket is consulted on every authenticated request.
    expect(res.headers['x-ratelimit-bucket']).toBe('global');

    const expectedCapacity = TIER_RATE_LIMIT_DEFAULTS.api_builder.global.capacity;
    expect(res.headers['x-ratelimit-limit']).toBe(expectedCapacity.toString());

    // Remaining is capacity - 1 (this is the very first hit) but could be
    // less if the harness fires preceding requests; just assert it's
    // present, numeric, and within bounds.
    const remaining = Number(res.headers['x-ratelimit-remaining']);
    expect(Number.isFinite(remaining)).toBe(true);
    expect(remaining).toBeGreaterThanOrEqual(0);
    expect(remaining).toBeLessThanOrEqual(expectedCapacity);

    // Reset is unix-seconds; coarsely sanity-check it's near "now".
    const reset = Number(res.headers['x-ratelimit-reset']);
    const nowSec = Math.floor(Date.now() / 1000);
    expect(reset).toBeGreaterThanOrEqual(nowSec);
    // Bucket refill is 30/sec for api_builder global, capacity 1800.
    // Worst case from empty: 60 seconds. Allow 120s slack for CI jitter.
    expect(reset).toBeLessThanOrEqual(nowSec + 120);
  });
});
