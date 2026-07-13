// W384 / DoS hardening — behavioral guard for the rate-limiters' PRIMARY-
// STORE-OUTAGE path.
//
// A rate-limiter must never become a SPOF that 500s every request when its
// store (Redis in prod) is down. Previously the limiters failed fully OPEN
// (allow every request), which removed ALL limiting platform-wide on a
// Redis blip — turning a transient outage into an unbounded resource-
// exhaustion window. The limiters now DEGRADE to a bounded per-instance
// memory fallback instead: a store outage drops to coarse per-instance
// limiting (still bounded), not "no limiting at all". The store error is
// caught → logged → metric'd → served from the fallback.

import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ipRateLimit } from '../../src/middleware/ip-rate-limit.js';
import type { RateLimitStore } from '../../src/services/rate-limit.js';

const throwingStore: RateLimitStore = {
  consume: () => Promise.reject(new Error('redis down')),
};

function makeReq(ip: string): { req: FastifyRequest; warn: ReturnType<typeof vi.fn> } {
  const warn = vi.fn();
  const req = { ip, log: { warn } } as unknown as FastifyRequest;
  return { req, warn };
}

describe('W384 ip-rate-limit degrades to a bounded fallback on a primary-store error', () => {
  it('does NOT 500 (resolves) when the primary store.consume rejects', async () => {
    const { req, warn } = makeReq('203.0.113.7');
    const reply = { header: vi.fn() } as unknown as FastifyReply;
    const handler = ipRateLimit(throwingStore, {
      bucketPrefix: 'login',
      capacity: 10,
      refillPerSecond: 1,
    });
    // Must NOT reject — a Redis outage cannot 500 the auth endpoint.
    await expect(handler(req, reply)).resolves.toBeUndefined();
    // And the bounded degradation must be observable.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/degrading to bounded in-process fallback/);
  });

  it('still ENFORCES the limit via the fallback (does NOT fail fully open)', async () => {
    // cap=2, refill=0 → the bounded fallback admits exactly 2 then 429s.
    const handler = ipRateLimit(throwingStore, {
      bucketPrefix: 'fallback-enforce-test',
      capacity: 2,
      refillPerSecond: 0,
    });
    const reply = () => ({ header: vi.fn() }) as unknown as FastifyReply;
    const ip = '203.0.113.99';

    // First two from the same IP are admitted by the fallback.
    await expect(handler(makeReq(ip).req, reply())).resolves.toBeUndefined();
    await expect(handler(makeReq(ip).req, reply())).resolves.toBeUndefined();
    // Third is throttled by the fallback — proving the outage path is NOT a
    // blanket allow (the pre-fix behaviour).
    await expect(handler(makeReq(ip).req, reply())).rejects.toMatchObject({ status: 429 });
  });

  it('increments the fallback metric when wired', async () => {
    const inc = vi.fn();
    const metrics = { inc } as unknown as Parameters<typeof ipRateLimit>[2];
    const handler = ipRateLimit(
      throwingStore,
      { bucketPrefix: 'metric-test', capacity: 10, refillPerSecond: 1 },
      metrics,
    );
    const reply = { header: vi.fn() } as unknown as FastifyReply;
    await handler(makeReq('203.0.113.8').req, reply);
    expect(inc).toHaveBeenCalledWith('driftstack_rate_limit_store_fallback_total', {
      limiter: 'ip',
    });
  });

  it('fails closed when an absolute daily ceiling is configured but the store lacks exact-window support', async () => {
    const burstOnlyStore: RateLimitStore = {
      consume: () =>
        Promise.resolve({
          allowed: true,
          remaining: 4,
          retryAfterMs: 0,
        }),
    };
    const { req, warn } = makeReq('203.0.113.201');
    const reply = { header: vi.fn() } as unknown as FastifyReply;
    const handler = ipRateLimit(burstOnlyStore, {
      bucketPrefix: 'auth-ip:signup',
      capacity: 5,
      refillPerSecond: 5 / 60,
    });

    await expect(handler(req, reply)).rejects.toMatchObject({ status: 429 });
    expect(warn.mock.calls.at(-1)?.[1]).toMatch(/failing CLOSED/);
  });
});
