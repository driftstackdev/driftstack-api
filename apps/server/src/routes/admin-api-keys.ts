// Admin-only cross-account API key list — GET /v1/admin/api-keys.
// Read-only; no audit row written for the read. Revoke action lives
// in admin-force-actions.ts (POST /v1/admin/api-keys/:id/revoke).

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { ApiKeyRow } from '../services/auth.js';
import type { ApiKeysService } from '../services/api-keys.js';
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

const ListAdminApiKeysQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Slice 146 — defensive caps matching slice 117 conventions across
  // admin routes (admin-cost / admin-usage / admin-crypto-orders all
  // capped at max(512) for cursor, max(100) for account_id). cursor
  // is an opaque pagination token; 512 chars covers any base64url-
  // encoded {ts, uuid} payload plus headroom. account_id is `acc_
  // <36-char-uuid>` ≈ 40 chars; 100-char cap blocks multi-KB inputs
  // that would bloat the 400/404 problem+json body if the filter
  // doesn't match anything.
  cursor: z.string().min(1).max(512).optional(),
  account_id: z.string().min(1).max(100).optional(),
  revoked: z.enum(['true', 'false']).optional(),
});

function publicAdminApiKey(row: ApiKeyRow): Record<string, unknown> {
  return {
    id: `key_${row.id}`,
    account_id: `acc_${row.accountId}`,
    name: row.name,
    key_prefix: row.keyPrefix,
    scopes: row.scopes,
    last_used_at: row.lastUsedAt ? row.lastUsedAt.toISOString() : null,
    revoked_at: row.revokedAt ? row.revokedAt.toISOString() : null,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    created_at: row.createdAt.toISOString(),
  };
}

export interface AdminApiKeysRoutesOptions {
  apiKeysService: ApiKeysService;
}

export function registerAdminApiKeysRoutes(
  app: FastifyInstance,
  opts: AdminApiKeysRoutesOptions,
): void {
  const { apiKeysService } = opts;

  app.get(
    '/v1/admin/api-keys',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = ListAdminApiKeysQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid query parameters.');

      const accountUuid =
        parsed.data.account_id !== undefined
          ? BARE_UUID_RE.test(parsed.data.account_id)
            ? parsed.data.account_id
            : uuidFromPrefixedId(parsed.data.account_id, 'acc')
          : undefined;

      const revoked =
        parsed.data.revoked === undefined ? undefined : parsed.data.revoked === 'true';

      const page = await apiKeysService.listAll(ctx, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(accountUuid !== undefined ? { accountId: accountUuid } : {}),
        ...(revoked !== undefined ? { revoked } : {}),
      });

      return {
        data: page.items.map(publicAdminApiKey),
        next_cursor: page.nextCursor,
      };
    },
  );
}
