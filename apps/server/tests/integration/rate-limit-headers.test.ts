// W199/W200 — integration coverage for the customer-facing
// `x-ratelimit-*` header set. The /docs/rate-limits page promises four
// headers; this test asserts the server actually emits them on a
// representative rate-limited route. Catches regressions where a
// future refactor drops one of the four off the response.
//
// v2-#23 extension: pin the headers across MULTIPLE buckets (not just
// `global`) and pin the 429 path's `retry-after` so SDK backoff logic
// has a stable contract to lean on.

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

    // W561 — IETF draft names emitted alongside the x- set, with the
    // draft's RELATIVE reset semantic: ratelimit-reset is delta-seconds
    // (== x-ratelimit-reset minus now), NOT an absolute timestamp.
    expect(res.headers['ratelimit-limit']).toBe(expectedCapacity.toString());
    expect(res.headers['ratelimit-remaining']).toBe(res.headers['x-ratelimit-remaining']);
    const relReset = Number(res.headers['ratelimit-reset']);
    expect(Number.isFinite(relReset)).toBe(true);
    expect(relReset).toBeGreaterThanOrEqual(0);
    expect(relReset).toBeLessThanOrEqual(120);
    // Cross-form coherence: absolute ≈ now + relative (±2s clock skew).
    expect(Math.abs(reset - (nowSec + relReset))).toBeLessThanOrEqual(2);
  });

  // v2-#23 — pin the agent_sessions:message bucket. v2-#13 split it
  // out from `global` so a customer hammering AI chat doesn't burn
  // their generic API budget; the dedicated bucket key MUST surface in
  // `x-ratelimit-bucket` so SDKs / dashboards can attribute throttling
  // correctly. Without an activation-gated runtime this route returns
  // 503 — but the rate-limit middleware fires BEFORE the route handler,
  // so the headers land regardless of the route's terminal status.
  it('v2-#23 sets x-ratelimit-bucket=agent_sessions:message on POST /v1/agent-sessions/:id/message (dedicated AI-chat bucket; v2-#13 split-out from global)', async () => {
    // Activation gate must be ON for this route to register with the
    // rate-limit preHandler — the 503-stub variant (registered when
    // agentRuntime isn't wired) is a bare endpoint with no rate-limit
    // middleware.
    fx = await buildTestApp({ tier: 'api_builder', enableAgentRuntime: true });
    // Create an agent session first so the :id resolves.
    const create = await fx.app.inject({
      method: 'POST',
      url: '/v1/agent-sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });
    const id = create.json<{ id: string }>().id;
    const res = await fx.app.inject({
      method: 'POST',
      url: `/v1/agent-sessions/${id}/message`,
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: { user_message: 'hi' },
    });
    expect(res.headers['x-ratelimit-bucket']).toBe('agent_sessions:message');
    const expectedCapacity =
      TIER_RATE_LIMIT_DEFAULTS.api_builder['agent_sessions:message'].capacity;
    expect(res.headers['x-ratelimit-limit']).toBe(expectedCapacity.toString());
    expect(res.headers['x-ratelimit-remaining']).toBeDefined();
    expect(res.headers['x-ratelimit-reset']).toBeDefined();
  });

  // v2-#23 — pin the 429 path. SDKs (TS / Python / Go) consume
  // `Retry-After` to schedule the next attempt; without the header, the
  // SDK's RateLimitError back-off falls back to a body-side hint or a
  // hard-coded 1s default. We drain the free `sessions:create`
  // bucket (capacity 5; cost 1 per call) by firing 6 POST /v1/sessions
  // calls and assert the 6th returns 429 with the full header set.
  it('v2-#23 429 path: retry-after + x-ratelimit-* headers MUST be present so SDK backoff has a stable contract', async () => {
    // Free has the smallest `sessions:create` capacity, which is why this case
    // uses it. `3202fdb17` made Free an interactive desktop tier, so an ORDINARY
    // key is refused at the customer-API boundary before the limiter ever runs;
    // POST /v1/sessions is on the Free desktop allowlist, so the desktop
    // credential is the caller that actually reaches the bucket in production.
    fx = await buildTestApp({ tier: 'free', keyProvenance: 'cli_device' });
    const expectedCapacity = TIER_RATE_LIMIT_DEFAULTS.free['sessions:create'].capacity;

    // Burn capacity. Bucket fires from the FIRST request, so capacity
    // successful POSTs leaves the bucket empty; the next is 429.
    for (let i = 0; i < expectedCapacity; i += 1) {
      await fx.app.inject({
        method: 'POST',
        url: '/v1/sessions',
        headers: { authorization: `Bearer ${fx.plaintext}` },
        payload: {},
      });
    }
    const throttled = await fx.app.inject({
      method: 'POST',
      url: '/v1/sessions',
      headers: { authorization: `Bearer ${fx.plaintext}` },
      payload: {},
    });

    expect(throttled.statusCode).toBe(429);
    // `sessions:create` is the bucket whose cost-1 hit drained it.
    // `global` fires first, but middleware emits the LAST-touched bucket's
    // headers (sessions:create), per the preHandler chain ordering.
    expect(throttled.headers['x-ratelimit-bucket']).toBe('sessions:create');
    expect(throttled.headers['x-ratelimit-limit']).toBe(expectedCapacity.toString());
    // Remaining MUST be < 1 (otherwise the bucket would've allowed the
    // call). Header is a non-negative integer per RFC convention.
    const remaining = Number(throttled.headers['x-ratelimit-remaining']);
    expect(Number.isFinite(remaining)).toBe(true);
    expect(remaining).toBeLessThan(1);

    // Retry-After in seconds, ≥1 per the middleware's Math.max(1, …).
    const retryAfter = Number(throttled.headers['retry-after']);
    expect(Number.isFinite(retryAfter)).toBe(true);
    expect(retryAfter).toBeGreaterThanOrEqual(1);
  });
});
