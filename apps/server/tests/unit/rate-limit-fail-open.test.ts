// W384 — behavioral guard: the rate-limit middlewares must FAIL OPEN when their
// backing store (Redis in prod) throws. A rate-limiter is defense-in-depth; it
// must never become a SPOF that 500s every request when its store is down. The
// store error is caught → logged → the request is allowed (limiting resumes when
// the store recovers). A legitimate limit-hit still throws RateLimitedError —
// only the store call is wrapped — but that path needs a working store, so this
// file pins the store-OUTAGE behavior specifically.

import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ipRateLimit } from '../../src/middleware/ip-rate-limit.js';
import type { RateLimitStore } from '../../src/services/rate-limit.js';

const throwingStore: RateLimitStore = {
  consume: () => Promise.reject(new Error('redis down')),
};

describe('W384 ip-rate-limit fails open on a store error', () => {
  it('allows the request (resolves, no throw) when store.consume rejects', async () => {
    const warn = vi.fn();
    const req = { ip: '203.0.113.7', log: { warn } } as unknown as FastifyRequest;
    const reply = { header: vi.fn() } as unknown as FastifyReply;
    const handler = ipRateLimit(throwingStore, {
      bucketPrefix: 'login',
      capacity: 10,
      refillPerSecond: 1,
    });
    // Must NOT reject — a Redis outage cannot 500 the auth endpoint.
    await expect(handler(req, reply)).resolves.toBeUndefined();
    // And the bounded bypass must be observable.
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatch(/failing open/);
  });
});
