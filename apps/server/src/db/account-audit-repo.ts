// V-216 — Drizzle-backed AccountAuditRepo.

import { type SQL, and, count, desc, eq, gte, lt, lte } from 'drizzle-orm';
import type { AccountAuditAction, AccountAuditActorType } from '@driftstack/api-types';
import type {
  AccountAuditEntryRow,
  AccountAuditRepo,
  ListAccountAuditOpts,
  ListAccountAuditPage,
  RecordAccountAuditInput,
} from '../services/account-audit.js';
import type { Database } from './client.js';
import { accountAuditLog } from './schema.js';

export class DrizzleAccountAuditRepo implements AccountAuditRepo {
  constructor(private readonly database: Database) {}

  async insert(input: RecordAccountAuditInput): Promise<AccountAuditEntryRow> {
    const [row] = await this.database.db
      .insert(accountAuditLog)
      .values({
        accountId: input.accountId,
        actorType: input.actorType,
        actorAccountId: input.actorAccountId ?? null,
        actorKeyId: input.actorKeyId ?? null,
        action: input.action,
        targetResourceId: input.targetResourceId ?? null,
        payload: input.payload ?? null,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
      })
      .returning();
    if (!row) throw new Error('account_audit_log insert returned no row');
    return toRow(row);
  }

  async list(accountId: string, opts: ListAccountAuditOpts): Promise<ListAccountAuditPage> {
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const filters: SQL[] = [eq(accountAuditLog.accountId, accountId)];
    if (cursorDate) filters.push(lt(accountAuditLog.timestamp, cursorDate));
    if (opts.action) filters.push(eq(accountAuditLog.action, opts.action));
    // V-484 — additional filters: from/to date range, actor_type,
    // target_resource_id (exact match).
    if (opts.from) filters.push(gte(accountAuditLog.timestamp, opts.from));
    if (opts.to) filters.push(lte(accountAuditLog.timestamp, opts.to));
    if (opts.actorType) filters.push(eq(accountAuditLog.actorType, opts.actorType));
    if (opts.targetResourceId) {
      filters.push(eq(accountAuditLog.targetResourceId, opts.targetResourceId));
    }

    const rows = await this.database.db
      .select()
      .from(accountAuditLog)
      .where(and(...filters))
      .orderBy(desc(accountAuditLog.timestamp))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toRow),
      nextCursor: hasMore && last ? last.timestamp.toISOString() : null,
    };
  }

  // 2026-05-22 — V-666 profile-import cycle cap helper. Counts entries
  // matching (accountId, action) since `since`. Uses the
  // `account_audit_log_action_idx` (account_id, action, timestamp)
  // composite index — fully covered scan, no table touch.
  async countActionsSince(accountId: string, action: string, since: Date): Promise<number> {
    const [row] = await this.database.db
      .select({ value: count() })
      .from(accountAuditLog)
      .where(
        and(
          eq(accountAuditLog.accountId, accountId),
          eq(accountAuditLog.action, action as AccountAuditAction),
          gte(accountAuditLog.timestamp, since),
        ),
      );
    return row?.value ?? 0;
  }
}

function toRow(r: typeof accountAuditLog.$inferSelect): AccountAuditEntryRow {
  return {
    id: r.id,
    accountId: r.accountId,
    actorType: r.actorType as AccountAuditActorType,
    actorAccountId: r.actorAccountId,
    actorKeyId: r.actorKeyId,
    action: r.action as AccountAuditAction,
    targetResourceId: r.targetResourceId,
    payload: r.payload ?? null,
    ipAddress: r.ipAddress,
    userAgent: r.userAgent,
    timestamp: r.timestamp,
  };
}
