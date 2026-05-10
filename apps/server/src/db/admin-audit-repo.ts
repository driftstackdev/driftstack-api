// Drizzle-backed AdminAuditLogRepo.
//
// Insert + paginated list only. No update, no delete — see D-025 for
// the append-only invariant.

import { and, desc, eq, gte, lt } from 'drizzle-orm';
import type {
  AdminAuditLogRepo,
  AdminAuditLogRow,
  ListAuditFilters,
  ListAuditPage,
  NewAdminAuditLogInput,
} from '../services/admin-audit.js';
import type { Database } from './client.js';
import { adminAuditLog } from './schema.js';

export class DrizzleAdminAuditLogRepo implements AdminAuditLogRepo {
  constructor(private readonly database: Database) {}

  async insert(input: NewAdminAuditLogInput): Promise<AdminAuditLogRow> {
    const [row] = await this.database.db
      .insert(adminAuditLog)
      .values({
        adminAccountId: input.adminAccountId,
        adminKeyId: input.adminKeyId,
        action: input.action,
        targetAccountId: input.targetAccountId ?? null,
        targetResourceId: input.targetResourceId ?? null,
        inputPayload: input.inputPayload ?? null,
        result: input.result,
        ipAddress: input.ipAddress ?? null,
      })
      .returning();
    if (!row) throw new Error('admin_audit_log insert returned no row');
    return toRow(row);
  }

  async list(filters: ListAuditFilters): Promise<ListAuditPage> {
    const conds = [];
    if (filters.adminAccountId) {
      conds.push(eq(adminAuditLog.adminAccountId, filters.adminAccountId));
    }
    if (filters.targetAccountId) {
      conds.push(eq(adminAuditLog.targetAccountId, filters.targetAccountId));
    }
    if (filters.action) conds.push(eq(adminAuditLog.action, filters.action));
    if (filters.from) conds.push(gte(adminAuditLog.timestamp, filters.from));
    if (filters.to) conds.push(lt(adminAuditLog.timestamp, filters.to));
    // V-521 — drill-down by resource id (parity with V-484
    // customer-side filter).
    if (filters.targetResourceId) {
      conds.push(eq(adminAuditLog.targetResourceId, filters.targetResourceId));
    }
    if (filters.cursor) conds.push(lt(adminAuditLog.timestamp, new Date(filters.cursor)));

    const rows = await this.database.db
      .select()
      .from(adminAuditLog)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(adminAuditLog.timestamp))
      .limit(filters.limit + 1);

    const hasMore = rows.length > filters.limit;
    const items = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toRow),
      nextCursor: hasMore && last ? last.timestamp.toISOString() : null,
    };
  }
}

function toRow(r: typeof adminAuditLog.$inferSelect): AdminAuditLogRow {
  return {
    id: r.id,
    adminAccountId: r.adminAccountId,
    adminKeyId: r.adminKeyId,
    action: r.action,
    targetAccountId: r.targetAccountId,
    targetResourceId: r.targetResourceId,
    inputPayload: r.inputPayload,
    result: r.result,
    ipAddress: r.ipAddress,
    timestamp: r.timestamp,
  };
}
