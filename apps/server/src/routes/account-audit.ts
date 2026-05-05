// V-216 — customer-facing audit log read endpoint.
// GET /v1/account/audit-log — list the calling account's own audit
// entries (newest first, cursor-paginated, optional action filter).

import type { FastifyInstance } from 'fastify';
import { ListAccountAuditLogQuerySchema } from '@driftstack/api-types';
import type { AccountAuditEntryRow, AccountAuditService } from '../services/account-audit.js';
import { BadRequestError } from '../lib/errors.js';

function publicEntry(row: AccountAuditEntryRow): Record<string, unknown> {
  return {
    id: row.id,
    account_id: `acc_${row.accountId}`,
    actor_type: row.actorType,
    actor_account_id: row.actorAccountId ? `acc_${row.actorAccountId}` : null,
    actor_key_id: row.actorKeyId ? `key_${row.actorKeyId}` : null,
    action: row.action,
    target_resource_id: row.targetResourceId,
    payload: row.payload,
    ip_address: row.ipAddress,
    user_agent: row.userAgent,
    timestamp: row.timestamp.toISOString(),
  };
}

export interface AccountAuditRoutesOptions {
  accountAudit: AccountAuditService;
}

export function registerAccountAuditRoutes(
  app: FastifyInstance,
  opts: AccountAuditRoutesOptions,
): void {
  const { accountAudit } = opts;

  app.get(
    '/v1/account/audit-log',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = ListAccountAuditLogQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid query parameters.');

      const page = await accountAudit.list(ctx, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
      });

      return {
        data: page.items.map(publicEntry),
        next_cursor: page.nextCursor,
      };
    },
  );
}
