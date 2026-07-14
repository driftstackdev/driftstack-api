// Security regression: the bounded in-process store is the rate limiters'
// last enforcement layer when Redis is unavailable. If both stores fail,
// requests must be denied rather than admitted with no abuse budget.

import { describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fp from 'fastify-plugin';
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { RateLimitStore } from '../../src/services/rate-limit.js';

vi.mock('../../src/lib/bounded-memory-rate-limit-store.js', () => ({
  BoundedMemoryRateLimitStore: class ThrowingFallbackStore {
    consume(): Promise<never> {
      return Promise.reject(new Error('bounded fallback unavailable'));
    }
  },
}));

import rateLimitPlugin from '../../src/middleware/rate-limit.js';
import { ipRateLimit } from '../../src/middleware/ip-rate-limit.js';

const throwingPrimaryStore: RateLimitStore = {
  consume: () => Promise.reject(new Error('primary store unavailable')),
};

function fakeReply(): { reply: FastifyReply; header: ReturnType<typeof vi.fn> } {
  const header = vi.fn();
  return { reply: { header } as unknown as FastifyReply, header };
}

function fakeRequest(ip = '203.0.113.42'): {
  request: FastifyRequest;
  warn: ReturnType<typeof vi.fn>;
} {
  const warn = vi.fn();
  return {
    request: {
      ip,
      account: {
        account: { id: 'acc_security', tier: 'free' },
        apiKey: { id: 'key_security', scopes: ['account_owner'] },
        rateLimitOverrides: {},
      },
      log: { warn, debug: vi.fn() },
    } as unknown as FastifyRequest,
    warn,
  };
}

describe('rate-limit safety layer fails closed', () => {
  it('denies an IP-gated request when both the primary and bounded fallback stores fail', async () => {
    const handler = ipRateLimit(throwingPrimaryStore, {
      bucketPrefix: 'auth-ip:login',
      capacity: 10,
      refillPerSecond: 10 / 60,
    });
    const { request, warn } = fakeRequest();
    const { reply, header } = fakeReply();

    await expect(handler(request, reply)).rejects.toMatchObject({
      status: 429,
      detail: 'Request rate limiting is temporarily unavailable. Retry shortly.',
      extensions: { retry_after_seconds: 60 },
    });
    expect(header).toHaveBeenCalledWith('retry-after', '60');
    expect(warn.mock.calls.at(-1)?.[1]).toMatch(/fallback store error — failing CLOSED/);
  });

  it('denies an account-gated request when both the primary and bounded fallback stores fail', async () => {
    const app = Fastify();
    const stubAuthPlugin = fp((_app, _opts, done) => done(), { name: 'auth' });
    await app.register(stubAuthPlugin);
    await app.register(rateLimitPlugin, { store: throwingPrimaryStore });
    await app.ready();
    try {
      const handler = app.rateLimit('global');
      const { request, warn } = fakeRequest();
      const { reply, header } = fakeReply();

      await expect(handler(request, reply)).rejects.toMatchObject({
        status: 429,
        detail: 'Rate limiting is temporarily unavailable. Retry shortly.',
        extensions: { retry_after_seconds: 60 },
      });
      expect(header).toHaveBeenCalledWith('retry-after', '60');
      expect(warn.mock.calls.at(-1)?.[1]).toMatch(/fallback store error — failing CLOSED/);
    } finally {
      await app.close();
    }
  });

  it.each(['', '   '])(
    'charges an unresolved client identity instead of bypassing (%j)',
    async (ip) => {
      const consume = vi.fn().mockResolvedValue({
        allowed: true,
        remaining: 4,
        retryAfterMs: 0,
      });
      const handler = ipRateLimit(
        { consume },
        {
          bucketPrefix: 'auth-ip:login',
          capacity: 5,
          refillPerSecond: 5 / 60,
        },
      );
      const { request } = fakeRequest(ip);
      const { reply } = fakeReply();

      await expect(handler(request, reply)).resolves.toBeUndefined();
      expect(consume).toHaveBeenCalledWith(
        expect.objectContaining({ key: 'auth-ip:login:unresolved-client' }),
      );
    },
  );
});
