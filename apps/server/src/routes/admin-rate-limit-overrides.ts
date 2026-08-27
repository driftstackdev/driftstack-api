// Admin-only cross-account rate-limit override list —
// GET /v1/admin/rate-limit-overrides. Read-only; no audit row written
// for the read. Set / clear are per-account at
// /v1/admin/accounts/:id/quota-override.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type {
  RateLimitOverrideRecord,
  RateLimitOverridesService,
} from '../services/rate-limit-overrides.js';
import { BadRequestError } from '../lib/errors.js';

// V-2005 — a BARE uuid is accepted alongside the public `acc_<uuid>` form, and a
// length check is not a shape check: `.length === 36` admitted ANY 36 characters
// (36 dashes included) straight into a Postgres `uuid` column, so the route
// answered 500 where the boundary owes 400. Same literal as the sibling fix in
// admin-cost.ts (V-1580), `/i` because an uppercase bare uuid verifies today and
// narrowing that would be a separate decision.
const BARE_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

function uuidFromPrefixedId(value: string, expectedPrefix: string): string {
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1] || !value.startsWith(`${expectedPrefix}_`)) {
    throw new BadRequestError(`Invalid id format. Expected "${expectedPrefix}_<uuid>".`);
  }
  return match[1];
}

const ListAdminOverridesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Slice 146 — defensive caps matching slice 117 conventions; see
  // admin-api-keys.ts for the same shape + rationale.
  cursor: z.string().min(1).max(512).optional(),
  account_id: z.string().min(1).max(100).optional(),
  include_expired: z.enum(['true', 'false']).optional(),
});

function publicOverride(r: RateLimitOverrideRecord): Record<string, unknown> {
  return {
    id: `rlo_${r.id}`,
    account_id: `acc_${r.accountId}`,
    bucket_key: r.bucketKey,
    capacity: r.capacity,
    refill_per_second: r.refillPerSecond,
    reason: r.reason,
    expires_at: r.expiresAt.toISOString(),
    set_by_key_id: `key_${r.setByKeyId}`,
    created_at: r.createdAt.toISOString(),
    updated_at: r.updatedAt.toISOString(),
  };
}

export interface AdminRateLimitOverridesRoutesOptions {
  rateLimitOverrides: RateLimitOverridesService;
}

export function registerAdminRateLimitOverridesRoutes(
  app: FastifyInstance,
  opts: AdminRateLimitOverridesRoutesOptions,
): void {
  const { rateLimitOverrides } = opts;

  app.get(
    '/v1/admin/rate-limit-overrides',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = ListAdminOverridesQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid query parameters.');

      const accountUuid =
        parsed.data.account_id !== undefined
          ? BARE_UUID_RE.test(parsed.data.account_id)
            ? parsed.data.account_id
            : uuidFromPrefixedId(parsed.data.account_id, 'acc')
          : undefined;

      const includeExpired = parsed.data.include_expired === 'true';

      const page = await rateLimitOverrides.listAll(ctx, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(accountUuid !== undefined ? { accountId: accountUuid } : {}),
        includeExpired,
      });

      return {
        data: page.items.map(publicOverride),
        next_cursor: page.nextCursor,
      };
    },
  );
}
