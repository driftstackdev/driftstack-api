// Wiring the rate limiter onto a public route returns 401, not a crash.
//
// The guard says what it is for in its own comment:
//
//   "Rate limit only applies to authenticated requests. If we ever wire this on
//    a public route, that's a misconfiguration — return 401."
//
//     src/middleware/rate-limit.ts:358  throw new UnauthorizedError(...)
//
// It had never executed (item 5f sweep), which is unsurprising: the decorator is
// only ever attached to authenticated routes today, so the branch exists purely
// for the day someone attaches it somewhere else. That is exactly the kind of
// guard worth running once — everything after it reads the account context, so
// without the check the misconfiguration surfaces as a TypeError on undefined
// and a 500, on a public route, instead of a clean 401 naming the problem.
//
// The bucket key is deliberately a real one. Passing an unknown bucket would let
// this arm pass by failing earlier in validation, which would leave the guard
// still unexecuted while looking covered.

import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { describe, expect, it } from 'vitest';
import authPlugin from '../../src/middleware/auth.js';
import rateLimitPlugin from '../../src/middleware/rate-limit.js';
import { UnauthorizedError } from '../../src/lib/errors.js';

type Gate = (request: FastifyRequest, reply: FastifyReply) => Promise<void>;

/** A store that would allow anything — so a refusal cannot come from the limiter. */
const permissiveStore = {
  consume: () =>
    Promise.resolve({ allowed: true, remaining: 100, limit: 100, resetAt: new Date() }),
};

async function appWithRateLimit(): Promise<FastifyInstance> {
  const app = Fastify();
  await app.register(authPlugin, {
    authRepo: {} as never,
    authCache: null,
    authCoalescer: null,
  });
  await app.register(rateLimitPlugin, { store: permissiveStore as never });
  await app.ready();
  return app;
}

const reply = {} as FastifyReply;

describe('rate limiting a route with no authenticated caller', () => {
  it('CRITICAL the decorator is registered and callable. Both arms below drive it, and a plugin that failed to decorate would make the refusal arm fail for the wrong reason.', async () => {
    const app = await appWithRateLimit();
    expect(
      typeof (app as unknown as { rateLimit?: unknown }).rateLimit,
      'rateLimit decorated onto the instance',
    ).toBe('function');
    await app.close();
  });

  it('CRITICAL a request with NO account context and no control key is refused with Unauthorized. Everything past this point reads the account, so without the guard a rate limiter attached to a public route fails as a TypeError and a 500 rather than a 401 that names the misconfiguration.', async () => {
    const app = await appWithRateLimit();
    const gate = (app as unknown as { rateLimit: (b: string, c?: number) => Gate }).rateLimit(
      'global',
    );
    await expect(gate({} as FastifyRequest, reply)).rejects.toBeInstanceOf(UnauthorizedError);
    await app.close();
  });

  it('CRITICAL the store is never consulted for an unauthenticated request. The refusal must come from the missing context, not from a limiter that happened to reject — and charging a bucket for a request that cannot be attributed to an account would bill the wrong tenant.', async () => {
    let consumed = false;
    const app = Fastify();
    await app.register(authPlugin, {
      authRepo: {} as never,
      authCache: null,
      authCoalescer: null,
    });
    await app.register(rateLimitPlugin, {
      store: {
        consume: () => {
          consumed = true;
          return Promise.resolve({
            allowed: true,
            remaining: 1,
            limit: 1,
            resetAt: new Date(),
          });
        },
      } as never,
    });
    await app.ready();

    const gate = (app as unknown as { rateLimit: (b: string, c?: number) => Gate }).rateLimit(
      'global',
    );
    await expect(gate({} as FastifyRequest, reply)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(consumed, 'the store was not consulted').toBe(false);
    await app.close();
  });
});
