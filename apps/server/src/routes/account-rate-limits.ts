// V-219 — customer-facing rate-limit view.
// GET /v1/account/rate-limits — returns the calling account's
// effective rate-limit config per bucket (tier default OR admin
// override if currently active).

import type { FastifyInstance } from 'fastify';
import { TIER_RATE_LIMIT_DEFAULTS } from '@driftstack/api-types';

// All four enforced buckets — must match TIER_RATE_LIMIT_DEFAULTS so the
// customer view never hides a limit that's actually applied. (input_event has
// no admin-override path today, so it always resolves to the tier default.)
const BUCKET_KEYS = [
  'global',
  'sessions:create',
  'agent_sessions:message',
  'agent_sessions:input_event',
] as const;
type BucketKey = (typeof BUCKET_KEYS)[number];

export function registerAccountRateLimitsRoutes(app: FastifyInstance): void {
  app.get(
    '/v1/account/rate-limits',
    { preHandler: [app.requireAuth, app.requireScope('read'), app.rateLimit('global')] },
    (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const tier = ctx.account.tier;
      const tierDefaults = TIER_RATE_LIMIT_DEFAULTS[tier];
      const now = Date.now();

      const buckets = BUCKET_KEYS.map((bucketKey: BucketKey) => {
        const override = ctx.rateLimitOverrides[bucketKey];
        if (override && override.expiresAt.getTime() > now) {
          return {
            bucket_key: bucketKey,
            capacity: override.capacity,
            refill_per_second: override.refillPerSecond,
            source: 'override' as const,
            override_expires_at: override.expiresAt.toISOString(),
          };
        }
        const def = tierDefaults[bucketKey];
        return {
          bucket_key: bucketKey,
          capacity: def.capacity,
          refill_per_second: def.refill_per_second,
          source: 'tier_default' as const,
          override_expires_at: null,
        };
      });

      return { tier, buckets };
    },
  );
}
