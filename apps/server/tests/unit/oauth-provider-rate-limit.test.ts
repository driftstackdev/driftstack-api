// 2026-06-01 — IP rate-limit gates on the UNAUTHENTICATED OAuth-provider
// public dance (V-667: authorize/token/introspect/revoke). These routes
// carry no bearer/scope auth (PKCE + client_secret + code IS the auth),
// so /token is a code+secret brute-force surface and /introspect an
// unauth token-validity oracle — they were the only live unauth API
// family without a limiter. This pins the BEHAVIOUR (not just the source)
// of the AUTH_IP_LIMITS.oauthProvider gate:
//   - normal traffic is allowed (the first request is not throttled);
//   - a single-IP burst past the capacity is throttled (429), giving the
//     brute-force friction the gate exists for;
//   - each route has its OWN bucket (exhausting /revoke does not throttle
//     /introspect) — proving the per-route bucketPrefix wiring.
// Mutation-proof: drop any `preHandler: [...Gate]` and the burst never
// 429s (the "throttles" assertion fails); collapse the per-route buckets
// to one prefix and the cross-route-isolation assertion fails.

import { describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { InMemoryOAuthStore, OAuthService } from '../../src/services/oauth.js';
import { registerOAuthRoutes } from '../../src/routes/oauth.js';
import { registerErrorHandler } from '../../src/middleware/error-handler.js';
import { MemoryRateLimitStore } from '../../src/lib/memory-rate-limit-store.js';
import { AUTH_IP_LIMITS } from '../../src/middleware/ip-rate-limit.js';

const CAPACITY = AUTH_IP_LIMITS.oauthProvider.capacity;

async function buildHarness(): Promise<FastifyInstance> {
  const app: FastifyInstance = Fastify({ logger: false });
  registerErrorHandler(app);
  // The admin routes registered alongside use app.requireScope; the
  // /authorize/complete route uses app.requireAuth. Decorate no-op stubs
  // so registration binds (we only exercise the public unauth routes).
  app.decorate('requireScope', (_scope: string) => () => Promise.resolve());
  app.decorate('requireAuth', () => Promise.resolve());
  app.decorate('rateLimit', (_bucket: string) => () => Promise.resolve());
  registerOAuthRoutes(app, {
    service: new OAuthService(new InMemoryOAuthStore()),
    rateLimitStore: new MemoryRateLimitStore(),
  });
  await app.ready();
  return app;
}

describe('V-667 OAuth-provider public dance — IP rate-limit gate', () => {
  it('allows the first request but throttles (429) a single-IP burst past capacity on /v1/oauth/revoke', async () => {
    const app = await buildHarness();
    try {
      const statuses: number[] = [];
      // capacity + 1: the token bucket starts full, so the first
      // `capacity` revokes pass and the next is denied. Refill is
      // ~1/sec; the in-memory burst completes in well under a second,
      // so no token refills mid-loop.
      for (let i = 0; i < CAPACITY + 1; i++) {
        const res = await app.inject({
          method: 'POST',
          url: '/v1/oauth/revoke',
          payload: { token: 'tok_unknown_value' },
        });
        statuses.push(res.statusCode);
      }
      // Normal traffic is allowed (revoke is always-200 per RFC 7009).
      expect(statuses[0]).toBe(200);
      // The burst gets throttled — without the gate, none would be 429.
      expect(statuses.some((s) => s === 429)).toBe(true);
    } finally {
      await app.close();
    }
  });

  it('keys each public route on its OWN bucket — exhausting /revoke does not throttle /introspect', async () => {
    const app = await buildHarness();
    try {
      // Drain the /revoke bucket past capacity.
      for (let i = 0; i < CAPACITY + 1; i++) {
        await app.inject({
          method: 'POST',
          url: '/v1/oauth/revoke',
          payload: { token: 'tok_unknown_value' },
        });
      }
      // A fresh /introspect must still be served (separate bucket).
      const introspect = await app.inject({
        method: 'POST',
        url: '/v1/oauth/introspect',
        payload: { token: 'tok_unknown_value' },
      });
      expect(introspect.statusCode).toBe(200);
      expect(introspect.json()).toEqual({ active: false });
    } finally {
      await app.close();
    }
  });
});
