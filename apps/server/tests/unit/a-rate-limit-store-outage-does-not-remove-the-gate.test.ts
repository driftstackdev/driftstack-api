// A Redis outage degrades the rate limiter. It does not switch it off.
//
// This is a regression test for a defect this codebase already shipped once.
// The middleware's own comment records it: the primary-store catch used to
// resolve to allow, "which removed EVERY IP gate (signup/login/oauth/... + the
// global pre-auth gate) at once on a Redis blip". An attacker who could degrade
// Redis got an unlimited-rate API, and every request looked successful.
//
// The fix has three levels, and each one has a different failure mode:
//
//   1. primary store consumes         normal operation
//   2. primary throws  -> bounded per-instance memory fallback, so coarse
//                         limiting survives the outage
//   3. fallback throws -> FAIL CLOSED, a retryable 429. The state is unknown
//                         and admitting the request is the one unsafe answer.
//
// What guarded this was a source-text pin asserting the string
// `'ip rate-limit fallback store error — failing CLOSED'` appears in the file.
// That checks the log message, not the behaviour. Changing the `throw` to a
// `return` — which is precisely the regression — leaves the log line untouched
// and the pin green.
//
// So this drives the real middleware with a store that throws, and asserts what
// a caller experiences. The distinction matters more than usual here because the
// failure is invisible in production: nothing errors, nothing 500s, requests
// simply stop being counted.

import { describe, expect, it, vi } from 'vitest';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ipRateLimit } from '../../src/middleware/ip-rate-limit.js';
import { RateLimitedError } from '../../src/lib/errors.js';
import type { RateLimitStore } from '../../src/services/rate-limit.js';

/** A store whose every consume rejects, standing in for a Redis outage. */
const brokenStore: RateLimitStore = {
  consume: () => Promise.reject(new Error('ECONNREFUSED: redis is down')),
};

/** Minimal request/reply pair; the middleware only reads `ip` and sets headers. */
function requestFrom(ip: string): { req: FastifyRequest; reply: FastifyReply } {
  const headers: Record<string, string> = {};
  const req = {
    ip,
    log: { warn: vi.fn(), info: vi.fn() },
    headers: {},
  } as unknown as FastifyRequest;
  const reply = {
    header: (name: string, value: string) => {
      headers[name.toLowerCase()] = value;
      return reply;
    },
    removeHeader: (name: string) => {
      delete headers[name.toLowerCase()];
    },
    getHeader: (name: string) => headers[name.toLowerCase()],
  } as unknown as FastifyReply;
  return { req, reply };
}

const CONFIG = { bucketPrefix: 'test-outage', capacity: 3, refillPerSecond: 0 };

describe('a rate-limit store outage does not remove the gate', () => {
  it('CRITICAL the broken store really is broken, and the middleware still answers. If consume resolved instead of rejecting, every assertion below would be exercising the ordinary path and reporting the outage handled without one having occurred.', async () => {
    await expect(
      brokenStore.consume({
        key: 'k',
        capacity: 1,
        refillPerSecond: 0,
        cost: 1,
        now: Date.now(),
      }),
    ).rejects.toThrow(/redis is down/);

    const gate = ipRateLimit(brokenStore, { ...CONFIG, bucketPrefix: 'probe-reachable' });
    const { req, reply } = requestFrom('203.0.113.10');
    await expect(gate(req, reply)).resolves.toBeUndefined();
  });

  it('CRITICAL a request is still ADMITTED while the primary store is down. Failing every request closed on an ordinary Redis blip would be its own outage — the bounded in-process fallback exists so coarse limiting survives without taking the API down with it.', async () => {
    const gate = ipRateLimit(brokenStore, { ...CONFIG, bucketPrefix: 'admits-during-outage' });
    const { req, reply } = requestFrom('203.0.113.20');
    await expect(gate(req, reply)).resolves.toBeUndefined();
  });

  it('CRITICAL the gate STILL REFUSES past capacity while the primary store is down. This is the defect the middleware comment records shipping once: the catch resolved to allow, and a Redis blip removed every IP gate at once. Unlimited requests, nothing logged as an error, every call a success.', async () => {
    const gate = ipRateLimit(brokenStore, { ...CONFIG, bucketPrefix: 'refuses-during-outage' });
    const ip = '203.0.113.30';

    // Drain the bounded fallback bucket: `capacity` admitted, the next refused.
    for (let i = 0; i < CONFIG.capacity; i += 1) {
      const { req, reply } = requestFrom(ip);
      await expect(
        gate(req, reply),
        `request ${String(i + 1)} of capacity`,
      ).resolves.toBeUndefined();
    }

    const { req, reply } = requestFrom(ip);
    await expect(gate(req, reply), 'the request past capacity').rejects.toBeInstanceOf(
      RateLimitedError,
    );
  });

  it('CRITICAL the fallback is PER-IP, not one shared counter. A fallback keyed globally would let one noisy address exhaust the bucket for everyone — turning a Redis blip into a self-inflicted denial of service for every other caller.', async () => {
    const gate = ipRateLimit(brokenStore, { ...CONFIG, bucketPrefix: 'per-ip-during-outage' });

    const noisy = '203.0.113.40';
    for (let i = 0; i < CONFIG.capacity; i += 1) {
      const { req, reply } = requestFrom(noisy);
      await gate(req, reply);
    }
    const exhausted = requestFrom(noisy);
    await expect(gate(exhausted.req, exhausted.reply), 'the noisy IP is refused').rejects.toThrow();

    const quiet = requestFrom('203.0.113.41');
    await expect(
      gate(quiet.req, quiet.reply),
      'a different IP is unaffected by the noisy one',
    ).resolves.toBeUndefined();
  });
});
