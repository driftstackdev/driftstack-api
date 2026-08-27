// Admin-only cross-account session list — GET /v1/admin/sessions.
// Read-only; no audit row written for the read itself. Mutating
// admin actions on sessions live in admin-force-actions.ts
// (POST /v1/admin/sessions/:id/destroy).
//
// Also GET /v1/admin/sessions/stats — cross-account session counts by
// status + active total, for the ops dashboard. Read-only, no audit.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { SessionRecord, SessionsService } from '../services/sessions.js';
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

const ListAdminSessionsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  // Slice 146 — defensive caps matching slice 117 conventions; see
  // admin-api-keys.ts for the same shape + rationale.
  cursor: z.string().min(1).max(512).optional(),
  status: z.enum(['creating', 'ready', 'busy', 'destroyed', 'errored']).optional(),
  /** Optional account scoping (`acc_<uuid>` or raw uuid). */
  account_id: z.string().min(1).max(100).optional(),
});

function publicSession(s: SessionRecord): Record<string, unknown> {
  return {
    id: `ses_${s.id}`,
    account_id: `acc_${s.accountId}`,
    api_key_id: `key_${s.apiKeyId}`,
    status: s.status,
    archetype: s.archetype,
    purpose: s.purpose,
    label: s.label,
    metadata: s.metadata,
    egress_capabilities: s.egressCapabilities,
    // Arc 5 EGRESS eg.1.l — raw harness-emitted payload for admin
    // forensics (migration 0054). Customer-facing surface added the
    // field in eg.1.c; the admin route's separate publicSession()
    // needs the same propagation.
    egress_capability_report: s.egressCapabilityReport,
    created_at: s.createdAt.toISOString(),
    updated_at: s.updatedAt.toISOString(),
    last_state_at: s.lastStateAt ? s.lastStateAt.toISOString() : null,
    destroyed_at: s.destroyedAt ? s.destroyedAt.toISOString() : null,
  };
}

export interface AdminSessionsRoutesOptions {
  sessionsService: SessionsService;
}

export function registerAdminSessionsRoutes(
  app: FastifyInstance,
  opts: AdminSessionsRoutesOptions,
): void {
  const { sessionsService } = opts;

  app.get(
    '/v1/admin/sessions',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = ListAdminSessionsQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid query parameters.');

      const accountUuid =
        parsed.data.account_id !== undefined
          ? BARE_UUID_RE.test(parsed.data.account_id)
            ? parsed.data.account_id
            : uuidFromPrefixedId(parsed.data.account_id, 'acc')
          : undefined;

      const page = await sessionsService.listAll(ctx, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(parsed.data.status !== undefined ? { status: parsed.data.status } : {}),
        ...(accountUuid !== undefined ? { accountId: accountUuid } : {}),
      });

      return {
        data: page.items.map(publicSession),
        next_cursor: page.nextCursor,
      };
    },
  );

  // Aggregate session counts by status (+ active total) for the ops
  // dashboard. Read-only; no audit row. Same scope-gate as the list.
  app.get(
    '/v1/admin/sessions/stats',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const stats = await sessionsService.statsForAdmin(ctx);
      return {
        by_status: stats.by_status,
        active: stats.active,
        total: stats.total,
      };
    },
  );
}
