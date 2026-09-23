// Drizzle-backed AdminAuditLogRepo.
//
// Insert + paginated list only. No update, no delete — see D-025 for
// the append-only invariant.

import { and, desc, eq, gte, lt, or } from 'drizzle-orm';
import type {
  AdminAuditLogRepo,
  AdminAuditLogRow,
  ListAuditFilters,
  ListAuditPage,
  NewAdminAuditLogInput,
} from '../services/admin-audit.js';
import type { Database } from './client.js';
import { adminAuditLog } from './schema.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';
import { actingKeyColumns, requiredActingKeyIdFromColumns } from '../lib/acting-key-columns.js';

export class DrizzleAdminAuditLogRepo implements AdminAuditLogRepo {
  constructor(private readonly database: Database) {}

  async insert(input: NewAdminAuditLogInput): Promise<AdminAuditLogRow> {
    // 0138 — an API key id goes to admin_key_id, a web session's `wsk_<uuid>` to
    // admin_web_session_id; anything else throws here, before the insert.
    const actor = actingKeyColumns(input.adminKeyId);
    const [row] = await this.database.db
      .insert(adminAuditLog)
      .values({
        adminAccountId: input.adminAccountId,
        adminKeyId: actor.keyId,
        adminWebSessionId: actor.webSessionId,
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
    // Keyset cursor on (timestamp desc, id desc) — the cursor is the
    // last row's id. A timestamp-only cursor dropped every row sharing
    // the cursor timestamp at a page boundary, and bulk admin actions
    // written in one transaction share an identical timestamp. Mirrors
    // the profiles-repo keyset pattern.
    if (filters.cursor !== undefined && parseUuidCursor(filters.cursor) !== undefined) {
      const [cursorRow] = await this.database.db
        .select({ timestamp: adminAuditLog.timestamp, id: adminAuditLog.id })
        .from(adminAuditLog)
        // V-1249 — scoped by adminAccountId WHEN one was given, mirroring
        // api-keys-repo and profile-snapshots-repo. Unscoped, a cursor naming another
        // operator's entry still resolves to a real (timestamp, id), so a caller
        // filtering by operator A while holding a cursor from operator B's listing gets
        // its own page silently mis-positioned — entries skipped or repeated, with no
        // error. Staff can already list the whole log, so this is about the caller
        // getting a correct page rather than about hiding anything from them.
        .where(
          filters.adminAccountId === undefined
            ? eq(adminAuditLog.id, filters.cursor)
            : and(
                eq(adminAuditLog.id, filters.cursor),
                eq(adminAuditLog.adminAccountId, filters.adminAccountId),
              ),
        )
        .limit(1);
      if (cursorRow) {
        const keyset = or(
          lt(adminAuditLog.timestamp, cursorRow.timestamp),
          and(eq(adminAuditLog.timestamp, cursorRow.timestamp), lt(adminAuditLog.id, cursorRow.id)),
        );
        if (keyset) conds.push(keyset);
      }
    }

    const rows = await this.database.db
      .select()
      .from(adminAuditLog)
      .where(conds.length > 0 ? and(...conds) : undefined)
      .orderBy(desc(adminAuditLog.timestamp), desc(adminAuditLog.id))
      .limit(filters.limit + 1);

    const hasMore = rows.length > filters.limit;
    const items = hasMore ? rows.slice(0, filters.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toRow),
      nextCursor: hasMore && last ? last.id : null,
    };
  }
}

function toRow(r: typeof adminAuditLog.$inferSelect): AdminAuditLogRow {
  return {
    id: r.id,
    adminAccountId: r.adminAccountId,
    // The string the auth context had: the key's uuid, or `wsk_<uuid>`.
    adminKeyId: requiredActingKeyIdFromColumns(r.adminKeyId, r.adminWebSessionId),
    action: r.action,
    targetAccountId: r.targetAccountId,
    targetResourceId: r.targetResourceId,
    inputPayload: r.inputPayload,
    result: r.result,
    ipAddress: r.ipAddress,
    timestamp: r.timestamp,
  };
}
