// Rate-limit middleware. Decorates `request` with no state and exposes a
// per-bucket factory: `app.rateLimit(bucketKey, costFn?)` returns a Fastify
// preHandler that consumes from the named bucket (account-keyed) and either
// allows the request or throws `RateLimitedError` with retry hint.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { rateLimitConsume, type RateLimitStore } from '../services/rate-limit.js';
import { RateLimitedError, UnauthorizedError } from '../lib/errors.js';

declare module 'fastify' {
  interface FastifyInstance {
    rateLimit: (
      bucketKey: string,
      cost?: number,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface RateLimitPluginOptions {
  store: RateLimitStore;
}

function rateLimitPlugin(
  app: FastifyInstance,
  opts: RateLimitPluginOptions,
  done: (err?: Error) => void,
): void {
  app.decorate('rateLimit', (bucketKey: string, cost = 1) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const ctx = request.account;
      if (!ctx) {
        // Rate limit only applies to authenticated requests. If we ever wire
        // this on a public route, that's a misconfiguration — return 401.
        throw new UnauthorizedError('Rate limit requires an authenticated request.');
      }

      const result = await rateLimitConsume(opts.store, {
        accountId: ctx.account.id,
        tier: ctx.account.tier,
        bucketKey,
        cost,
        overrides: ctx.rateLimitOverrides,
      });

      reply.header('x-ratelimit-remaining', Math.floor(result.remaining).toString());

      // V-092: structured log line on every consume so observability
      // tooling (Sentry breadcrumbs, log search) can answer "is account
      // X near its rate-limit budget right now?" without piecing it
      // together from the egress log. Fastify's per-request logger is
      // already account-tagged from the auth middleware; we add the
      // bucket-specific fields here.
      //
      // Allowed → debug level (high-volume; avoid noise at default
      // info-level production logs). Exceeded → warn level (carries the
      // operational signal for capacity planning + abuse detection).
      const logFields = {
        component: 'rate-limit',
        account_id: ctx.account.id,
        tier: ctx.account.tier,
        bucket_key: bucketKey,
        cost,
        tokens_remaining: Math.floor(result.remaining),
        allowed: result.allowed,
        retry_after_ms: result.retryAfterMs,
      };

      if (!result.allowed) {
        request.log.warn(logFields, 'rate-limit exceeded');
        const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        reply.header('retry-after', retryAfterSec.toString());
        throw new RateLimitedError(
          retryAfterSec,
          `Rate limit for "${bucketKey}" exceeded for tier "${ctx.account.tier}".`,
        );
      }
      request.log.debug(logFields, 'rate-limit consumed');
    };
  });

  done();
}

export default fp(rateLimitPlugin, { name: 'rate-limit', dependencies: ['auth'] });
