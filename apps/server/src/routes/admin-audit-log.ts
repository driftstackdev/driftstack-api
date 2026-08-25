// Admin audit-log query route.
//
// Read-only — no audit row written for the read itself (audits would
// recurse forever). The route validates the admin scope, parses
// filters, paginates by timestamp DESC, and returns the page.

import type { FastifyInstance } from 'fastify';
import { ListAuditLogQuerySchema, type ListAuditLogQueryInput } from '@driftstack/api-types';
import type { AdminAuditLogRow, AdminAuditService } from '../services/admin-audit.js';
import { requireScope as throwIfMissingScope } from '../lib/errors-helpers.js';
import { BadRequestError } from '../lib/errors.js';

const PUBLIC_ID_RE = /^[a-z]{3}_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;

// The cursor is the opaque bare-uuid id of the prior page's last row,
// keyset-looked-up via `eq(adminAuditLog.id, cursor)` against a Postgres uuid
// column → a malformed/tampered cursor would hit PG as an invalid uuid cast
// (500). Validate at the boundary so a bad cursor is a clean 400.
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// V-1565 — the raw-UUID branch was a hex-or-dash character class of length 36
// rather than the dashed UUID shape, so 36 hex digits with no dashes, and an
// all-dash string, both passed as a "UUID". `admin_id` and `target_id` land in
// `eq(adminAuditLog.adminAccountId, ...)` against a Postgres uuid column, so a
// malformed filter reached PG as an invalid uuid cast and answered 500 where the
// boundary owes a 400 — the same defect this file already fixed for the CURSOR
// six lines above, and that sessions.ts, profile-snapshots.ts and
// account-web-sessions.ts each fixed in their own copy. Reuses CURSOR_UUID_RE
// rather than adding a fourth spelling. (The old pattern is described, not
// quoted: a guard scans these files for that literal.)
/** Accept either a raw UUID or a prefixed id; return the UUID. */
function maybeUuidFromInput(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  if (CURSOR_UUID_RE.test(value)) return value;
  const match = PUBLIC_ID_RE.exec(value);
  if (!match || !match[1]) {
    throw new BadRequestError(`Invalid id "${value}". Expected a UUID or prefixed id.`);
  }
  return match[1];
}

function publicEntry(row: AdminAuditLogRow): Record<string, unknown> {
  return {
    id: row.id,
    admin_account_id: `acc_${row.adminAccountId}`,
    admin_key_id: `key_${row.adminKeyId}`,
    action: row.action,
    target_account_id: row.targetAccountId ? `acc_${row.targetAccountId}` : null,
    target_resource_id: row.targetResourceId,
    input_payload: row.inputPayload,
    result: row.result,
    ip_address: row.ipAddress,
    timestamp: row.timestamp.toISOString(),
  };
}

export interface AdminAuditLogRoutesOptions {
  audit: AdminAuditService;
}

export function registerAdminAuditLogRoutes(
  app: FastifyInstance,
  opts: AdminAuditLogRoutesOptions,
): void {
  const { audit } = opts;

  // ── GET /v1/admin/audit-log ────────────────────────────────────────────
  app.get(
    '/v1/admin/audit-log',
    {
      preHandler: [app.requireScope('driftstack_internal_admin'), app.rateLimit('global')],
    },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      throwIfMissingScope(ctx, 'driftstack_internal_admin');

      const rawQuery = (request.query ?? {}) as ListAuditLogQueryInput;
      const query = ListAuditLogQuerySchema.parse(rawQuery);
      if (query.cursor !== undefined && !CURSOR_UUID_RE.test(query.cursor)) {
        throw new BadRequestError('Invalid cursor.');
      }

      const adminUuid = maybeUuidFromInput(query.admin_id);
      const targetUuid = maybeUuidFromInput(query.target_id);

      const page = await audit.list({
        ...(adminUuid !== undefined ? { adminAccountId: adminUuid } : {}),
        ...(targetUuid !== undefined ? { targetAccountId: targetUuid } : {}),
        ...(query.action !== undefined ? { action: query.action } : {}),
        ...(query.from !== undefined ? { from: new Date(query.from) } : {}),
        ...(query.to !== undefined ? { to: new Date(query.to) } : {}),
        // V-521 — drill-down by resource id (parity with V-484
        // customer-side filter).
        ...(query.target_resource_id !== undefined
          ? { targetResourceId: query.target_resource_id }
          : {}),
        limit: query.limit,
        ...(query.cursor !== undefined ? { cursor: query.cursor } : {}),
      });

      return {
        data: page.items.map(publicEntry),
        next_cursor: page.nextCursor,
      };
    },
  );
}
