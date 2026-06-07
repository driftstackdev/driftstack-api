// V-216 — customer-facing audit log read endpoint.
// GET /v1/account/audit-log — list the calling account's own audit
// entries (newest first, cursor-paginated, optional action filter).
//
// V-297 — `GET /v1/account/audit-log/export?format=csv|json` exports
// the full audit log for the calling account as a single download.
// CSV for spreadsheets / GDPR Article 20 portability; JSON for
// programmatic consumers. Server-side ceiling: 10,000 rows per export
// to avoid pathological cases. Pagination via subsequent
// `?since=<timestamp>` calls if more is needed (rare in practice).

import type { FastifyInstance } from 'fastify';
import { ListAccountAuditLogQuerySchema } from '@driftstack/api-types';
import type { AccountAuditEntryRow, AccountAuditService } from '../services/account-audit.js';
import { BadRequestError } from '../lib/errors.js';
import { buildCsv } from '../lib/csv.js';
import { resolveEffectiveAccount } from '../services/auth.js';
import { readEffectiveAccountHeader } from '../lib/effective-account-header.js';
import { z } from 'zod';

// The list cursor is the opaque bare-uuid id of the prior page's last row,
// keyset-looked-up via `eq(accountAuditLog.id, cursor)` against a Postgres
// uuid column → a malformed/tampered cursor would hit PG as an invalid uuid
// cast (500). Validate at the boundary so a bad cursor is a clean 400.
const CURSOR_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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
      if (parsed.data.cursor !== undefined && !CURSOR_UUID_RE.test(parsed.data.cursor)) {
        throw new BadRequestError('Invalid cursor.');
      }

      // V-330b — honor X-Driftstack-Account: a team member with a
      // valid membership reads the owner's audit log. Read-only;
      // both 'member' and 'admin' roles allowed.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));

      const page = await accountAudit.list(ctx, {
        limit: parsed.data.limit,
        ...(parsed.data.cursor !== undefined ? { cursor: parsed.data.cursor } : {}),
        ...(parsed.data.action !== undefined ? { action: parsed.data.action } : {}),
        // V-484 — additional filters forwarded to the service layer.
        ...(parsed.data.from !== undefined ? { from: parsed.data.from } : {}),
        ...(parsed.data.to !== undefined ? { to: parsed.data.to } : {}),
        ...(parsed.data.actor_type !== undefined ? { actorType: parsed.data.actor_type } : {}),
        ...(parsed.data.target_resource_id !== undefined
          ? { targetResourceId: parsed.data.target_resource_id }
          : {}),
        ...(effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {}),
      });

      return {
        data: page.items.map(publicEntry),
        next_cursor: page.nextCursor,
      };
    },
  );

  // V-297 — export
  const ExportQuerySchema = z.object({
    format: z.enum(['csv', 'json']).default('json'),
  });
  const EXPORT_MAX_ROWS = 10_000;
  const EXPORT_PAGE_SIZE = 200;

  app.get(
    '/v1/account/audit-log/export',
    { preHandler: [app.requireAuth, app.rateLimit('global')] },
    async (request, reply) => {
      const ctx = request.account;
      if (!ctx) throw new Error('account context missing after requireAuth');
      const parsed = ExportQuerySchema.safeParse(request.query ?? {});
      if (!parsed.success) throw new BadRequestError('Invalid query parameters.');
      const format = parsed.data.format;

      // V-330c — same effective-account semantic as the read endpoint
      // above. A team member can export the owner's audit log when
      // they pass X-Driftstack-Account.
      const effective = resolveEffectiveAccount(ctx, readEffectiveAccountHeader(request));

      // Walk pages until we have all rows or hit the ceiling. Service
      // already enforces account-scoping; we just iterate.
      const all: AccountAuditEntryRow[] = [];
      let cursor: string | undefined;
      while (all.length < EXPORT_MAX_ROWS) {
        const page = await accountAudit.list(ctx, {
          limit: EXPORT_PAGE_SIZE,
          ...(cursor !== undefined ? { cursor } : {}),
          ...(effective.kind === 'team' ? { effectiveAccountId: effective.accountId } : {}),
        });
        all.push(...page.items);
        if (page.nextCursor === null) break;
        cursor = page.nextCursor;
      }
      const truncated = all.length >= EXPORT_MAX_ROWS;

      const filenameBase = `driftstack-audit-log-${new Date().toISOString().slice(0, 10)}`;

      if (format === 'csv') {
        const header = [
          'timestamp',
          'action',
          'actor_type',
          'actor_account_id',
          'actor_key_id',
          'target_resource_id',
          'ip_address',
          'user_agent',
          'payload',
        ];
        const rows = all.map((row) => [
          row.timestamp.toISOString(),
          row.action,
          row.actorType,
          row.actorAccountId ? `acc_${row.actorAccountId}` : '',
          row.actorKeyId ? `key_${row.actorKeyId}` : '',
          row.targetResourceId ?? '',
          row.ipAddress ?? '',
          row.userAgent ?? '',
          row.payload === null ? '' : JSON.stringify(row.payload),
        ]);
        // buildCsv applies the shared CSV formula-injection guard
        // (CWE-1236) — audit rows carry client-controlled free text
        // (user_agent especially) that a spreadsheet would otherwise
        // evaluate as a formula on open.
        const csv = buildCsv({ header, rows });
        return reply
          .header('content-type', 'text/csv; charset=utf-8')
          .header('content-disposition', `attachment; filename="${filenameBase}.csv"`)
          .header('x-driftstack-export-truncated', truncated ? 'true' : 'false')
          .send(csv);
      }

      // JSON envelope.
      return reply
        .header('content-type', 'application/json; charset=utf-8')
        .header('content-disposition', `attachment; filename="${filenameBase}.json"`)
        .header('x-driftstack-export-truncated', truncated ? 'true' : 'false')
        .send({
          generated_at: new Date().toISOString(),
          account_id: `acc_${ctx.account.id}`,
          row_count: all.length,
          truncated,
          data: all.map(publicEntry),
        });
    },
  );
}
