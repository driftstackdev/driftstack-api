// Rate-limit middleware. Decorates `request` with no state and exposes a
// per-bucket factory: `app.rateLimit(bucketKey, costFn?)` returns a Fastify
// preHandler that consumes from the named bucket (account-keyed) and either
// allows the request or throws `RateLimitedError` with retry hint.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  rateLimitConsume,
  type ConsumeResultWithBucket,
  type RateLimitStore,
} from '../services/rate-limit.js';
import { RateLimitedError, UnauthorizedError } from '../lib/errors.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';

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
  /** Arc 7 obs.5 — optional metrics registry. When wired, the
   *  plugin increments `driftstack_rate_limit_total{bucket,outcome}`
   *  on every consume. outcome ∈ { allowed | exceeded }. */
  metrics?: MetricsRegistry;
}

function rateLimitPlugin(
  app: FastifyInstance,
  opts: RateLimitPluginOptions,
  done: (err?: Error) => void,
): void {
  app.decorate('rateLimit', (bucketKey: string, cost = 1) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const ctx = request.account;
      // gui_control_key control-auth path: `request.account` is absent
      // (the per-session control key isn't an account credential), but
      // the route's auth preHandler stashed the session's OWNING
      // account id. Charge that account's bucket at the conservative
      // `free`-tier floor so a per-session control key still consumes
      // rate-limit budget (never bypasses it) — and never sees a tier
      // larger than the smallest. Overrides are intentionally NOT
      // applied here (they're a per-account-key concept).
      const controlKeyAccountId = request.guiControlKeyRateLimitAccountId;
      if (!ctx && controlKeyAccountId === undefined) {
        // Rate limit only applies to authenticated requests. If we ever wire
        // this on a public route, that's a misconfiguration — return 401.
        throw new UnauthorizedError('Rate limit requires an authenticated request.');
      }

      let result: ConsumeResultWithBucket;
      try {
        result = await rateLimitConsume(opts.store, {
          accountId: ctx ? ctx.account.id : controlKeyAccountId!,
          tier: ctx ? ctx.account.tier : 'free',
          bucketKey,
          cost,
          overrides: ctx ? ctx.rateLimitOverrides : {},
        });
      } catch (err) {
        // W384 — fail OPEN on a store error (e.g. Redis down). A rate-limiter
        // must not be a SPOF that 500s the whole API when its backing store is
        // down; graceful degradation = allow + warn (limiting resumes when the
        // store recovers). Only the store call is wrapped, so a legitimate
        // limit-hit RateLimitedError below still propagates normally.
        request.log.warn(
          { component: 'rate-limit', bucket: bucketKey, err },
          'rate-limit store error — failing open (request allowed)',
        );
        return;
      }

      // W199 — full RateLimit-header set as documented at
      // `/docs/rate-limits`. `bucket` lets clients distinguish which
      // limiter fired (`global` / `sessions:create` /
      // `agent_sessions:message` today); `limit` is the bucket
      // capacity; `reset` is unix seconds at which the bucket will
      // be back at capacity.
      const nowSec = Math.floor(Date.now() / 1000);
      const tokensNeededForFull = result.capacity - result.remaining;
      const secondsToFull =
        tokensNeededForFull > 0 && result.refillPerSecond > 0
          ? Math.ceil(tokensNeededForFull / result.refillPerSecond)
          : 0;
      reply.header('x-ratelimit-bucket', bucketKey);
      reply.header('x-ratelimit-limit', result.capacity.toString());
      reply.header('x-ratelimit-remaining', Math.floor(result.remaining).toString());
      reply.header('x-ratelimit-reset', (nowSec + secondsToFull).toString());
      // W561 — IETF draft-ietf-httpapi-ratelimit-headers names, emitted
      // alongside the vendor x- set (gateways + generic retry libraries read
      // the un-prefixed names). SEMANTIC DIFFERENCE: `ratelimit-reset` is
      // RELATIVE delta-seconds per the draft, whereas `x-ratelimit-reset`
      // is an ABSOLUTE unix timestamp — do not copy the absolute value.
      reply.header('ratelimit-limit', result.capacity.toString());
      reply.header('ratelimit-remaining', Math.floor(result.remaining).toString());
      reply.header('ratelimit-reset', secondsToFull.toString());

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
      const effectiveAccountId = ctx ? ctx.account.id : controlKeyAccountId!;
      const effectiveTier = ctx ? ctx.account.tier : 'free';
      const logFields = {
        component: 'rate-limit',
        account_id: effectiveAccountId,
        tier: effectiveTier,
        bucket_key: bucketKey,
        cost,
        tokens_remaining: Math.floor(result.remaining),
        allowed: result.allowed,
        retry_after_ms: result.retryAfterMs,
      };

      // Arc 7 obs.5 — bucket-labelled consume counter. Best-effort.
      try {
        opts.metrics?.inc(METRIC_NAMES.rateLimitTotal, {
          bucket: bucketKey,
          outcome: result.allowed ? 'allowed' : 'exceeded',
        });
      } catch {
        // Swallow; metrics are best-effort.
      }

      if (!result.allowed) {
        request.log.warn(logFields, 'rate-limit exceeded');
        const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        reply.header('retry-after', retryAfterSec.toString());
        throw new RateLimitedError(
          retryAfterSec,
          `Rate limit for "${bucketKey}" exceeded for tier "${effectiveTier}".`,
        );
      }
      request.log.debug(logFields, 'rate-limit consumed');
    };
  });

  done();
}

export default fp(rateLimitPlugin, { name: 'rate-limit', dependencies: ['auth'] });
