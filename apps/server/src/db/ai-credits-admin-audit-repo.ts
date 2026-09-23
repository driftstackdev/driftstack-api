// S15 — reads and writes `ai_credits_admin_audit_log` (migration 0134): the
// separate, dark audit trail for the AI-credits admin tools. See the
// migration's own header for why this is not six new rows in the PUBLISHED
// `admin_audit_log` / `admin_audit_action` (packages/api-types/src/admin.ts
// ships to npm; this table does not exist anywhere published, so its
// vocabulary can freely name the feature).
//
// Same shape and the same discipline as `services/admin-audit.ts`: insert and
// a paginated list, nothing else. Append-only by convention — no UPDATE or
// DELETE method exists here to call.

import { and, desc, eq, lt } from 'drizzle-orm';
import type { Database } from './client.js';
import type { CreditLedgerExecutor } from './credit-ledger-repo.js';
import {
  AI_CREDITS_ADMIN_AUDIT_ACTIONS,
  aiCreditsAdminAuditLog,
  type AiCreditsAdminAuditLogRow,
} from './schema.js';

export type AiCreditsAdminAuditAction = (typeof AI_CREDITS_ADMIN_AUDIT_ACTIONS)[number];

export interface AiCreditsAdminAuditLogEntry {
  readonly id: string;
  readonly adminAccountId: string;
  readonly adminKeyId: string;
  readonly action: AiCreditsAdminAuditAction;
  readonly targetAccountId: string | null;
  readonly targetResourceId: string | null;
  readonly inputPayload: Record<string, unknown> | null;
  readonly result: string;
  readonly ipAddress: string | null;
  readonly timestamp: Date;
}

export interface NewAiCreditsAdminAuditLogEntry {
  readonly adminAccountId: string;
  readonly adminKeyId: string;
  readonly action: AiCreditsAdminAuditAction;
  readonly targetAccountId?: string | null;
  readonly targetResourceId?: string | null;
  readonly inputPayload?: Record<string, unknown> | null;
  readonly result: string;
  readonly ipAddress?: string | null;
}

export interface AiCreditsAdminAuditListFilters {
  readonly targetAccountId?: string;
  readonly limit: number;
  /** Pagination cursor — the last seen `timestamp` ISO string. */
  readonly cursor?: string;
}

export interface AiCreditsAdminAuditListPage {
  readonly items: readonly AiCreditsAdminAuditLogEntry[];
  readonly nextCursor: string | null;
}

function member(value: string): AiCreditsAdminAuditAction {
  if (!(AI_CREDITS_ADMIN_AUDIT_ACTIONS as readonly string[]).includes(value)) {
    throw new RangeError('ai_credits_admin_audit_log.action holds an unknown value');
  }
  return value as AiCreditsAdminAuditAction;
}

function toEntry(r: AiCreditsAdminAuditLogRow): AiCreditsAdminAuditLogEntry {
  return {
    id: r.id,
    adminAccountId: r.adminAccountId,
    adminKeyId: r.adminKeyId,
    action: member(r.action),
    targetAccountId: r.targetAccountId,
    targetResourceId: r.targetResourceId,
    inputPayload: r.inputPayload ?? null,
    result: r.result,
    ipAddress: r.ipAddress,
    timestamp: r.timestamp,
  };
}

/** The row an entry becomes — shared by `record` and {@link aiCreditsAdminAuditIn}. */
function auditRowValues(
  entry: NewAiCreditsAdminAuditLogEntry,
): typeof aiCreditsAdminAuditLog.$inferInsert {
  return {
    adminAccountId: entry.adminAccountId,
    adminKeyId: entry.adminKeyId,
    action: entry.action,
    targetAccountId: entry.targetAccountId ?? null,
    targetResourceId: entry.targetResourceId ?? null,
    inputPayload: entry.inputPayload ?? null,
    result: entry.result,
    ipAddress: entry.ipAddress ?? null,
  };
}

/** An audit writer bound to one transaction — see {@link aiCreditsAdminAuditIn}. */
export interface AiCreditsAdminAuditWriter {
  record(entry: NewAiCreditsAdminAuditLogEntry): Promise<void>;
}

/**
 * S15/S16 audit fix #2 — write `ai_credits_admin_audit_log` rows INSIDE the
 * transaction that makes the change they record. A mutation and its audit row
 * then commit together or not at all: a failed audit write rolls the mutation
 * back (the request fails and a retry does it properly), and a batch that fails
 * part-way leaves exactly one row per account it committed — never a committed
 * change with no row, which a retry would then report as `applied:false` or
 * `already_moved` and never audit.
 *
 * The row's actor columns are foreign keys to `accounts` and `api_keys`, so an
 * actor that does not exist fails the whole transaction — which is the point.
 */
export function aiCreditsAdminAuditIn(on: CreditLedgerExecutor): AiCreditsAdminAuditWriter {
  return {
    async record(entry: NewAiCreditsAdminAuditLogEntry): Promise<void> {
      await on.insert(aiCreditsAdminAuditLog).values(auditRowValues(entry));
    },
  };
}

export class DrizzleAiCreditsAdminAuditRepo {
  constructor(private readonly database: Database) {}

  async record(entry: NewAiCreditsAdminAuditLogEntry): Promise<AiCreditsAdminAuditLogEntry> {
    const [row] = await this.database.db
      .insert(aiCreditsAdminAuditLog)
      .values(auditRowValues(entry))
      .returning();
    if (row === undefined) throw new Error('an ai_credits_admin_audit_log row was not returned');
    return toEntry(row);
  }

  async list(filters: AiCreditsAdminAuditListFilters): Promise<AiCreditsAdminAuditListPage> {
    const { limit, cursor, targetAccountId } = filters;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new RangeError('a page holds 1 to 100 entries');
    }
    const rows = await this.database.db
      .select()
      .from(aiCreditsAdminAuditLog)
      .where(
        and(
          targetAccountId === undefined
            ? undefined
            : eq(aiCreditsAdminAuditLog.targetAccountId, targetAccountId),
          cursor === undefined ? undefined : lt(aiCreditsAdminAuditLog.timestamp, new Date(cursor)),
        ),
      )
      .orderBy(desc(aiCreditsAdminAuditLog.timestamp))
      .limit(limit + 1);
    const items = rows.slice(0, limit).map(toEntry);
    const last = items[items.length - 1];
    return {
      items,
      nextCursor: rows.length > limit && last !== undefined ? last.timestamp.toISOString() : null,
    };
  }
}
