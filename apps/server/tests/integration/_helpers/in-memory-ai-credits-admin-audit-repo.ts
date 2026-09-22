// In-memory `ai_credits_admin_audit_log` double for integration tests — the
// S15 dark audit sink `routes/admin-ai-credits.ts`'s admin routes write to
// (see `db/ai-credits-admin-audit-repo.ts`'s own header for why it is a
// SEPARATE table from `admin_audit_log`, not a service wrapping it). `record`
// + `list` only, mirroring the production "insert and a paginated list,
// nothing else" surface — same discipline as `InMemoryAdminAuditLogRepo`
// beside it.
//
// Structural, not `implements DrizzleAiCreditsAdminAuditRepo`: that class
// takes a real `Database` in its constructor and its `database` field is
// private, so nothing outside its own module can satisfy that type by value —
// `AdminAiCreditsRoutesDeps.adminAudit` is typed as
// `Pick<DrizzleAiCreditsAdminAuditRepo, 'record'>` for exactly this reason.

import { randomUUID } from 'node:crypto';
import type {
  AiCreditsAdminAuditListFilters,
  AiCreditsAdminAuditListPage,
  AiCreditsAdminAuditLogEntry,
  NewAiCreditsAdminAuditLogEntry,
} from '../../../src/db/ai-credits-admin-audit-repo.js';

export class InMemoryAiCreditsAdminAuditRepo {
  private readonly rows: AiCreditsAdminAuditLogEntry[] = [];

  record(entry: NewAiCreditsAdminAuditLogEntry): Promise<AiCreditsAdminAuditLogEntry> {
    const row: AiCreditsAdminAuditLogEntry = {
      id: randomUUID(),
      adminAccountId: entry.adminAccountId,
      adminKeyId: entry.adminKeyId,
      action: entry.action,
      targetAccountId: entry.targetAccountId ?? null,
      targetResourceId: entry.targetResourceId ?? null,
      inputPayload: entry.inputPayload ?? null,
      result: entry.result,
      ipAddress: entry.ipAddress ?? null,
      timestamp: new Date(),
    };
    this.rows.push(row);
    return Promise.resolve({ ...row });
  }

  list(filters: AiCreditsAdminAuditListFilters): Promise<AiCreditsAdminAuditListPage> {
    let filtered = [...this.rows];
    if (filters.targetAccountId !== undefined) {
      filtered = filtered.filter((r) => r.targetAccountId === filters.targetAccountId);
    }
    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());
    if (filters.cursor !== undefined) {
      const cursorMs = Date.parse(filters.cursor);
      filtered = filtered.filter((r) => r.timestamp.getTime() < cursorMs);
    }
    const items = filtered.slice(0, filters.limit);
    const last = items[items.length - 1];
    return Promise.resolve({
      items,
      nextCursor:
        filtered.length > filters.limit && last !== undefined ? last.timestamp.toISOString() : null,
    });
  }

  /** Test helper: every row recorded so far, insertion order. */
  getAll(): AiCreditsAdminAuditLogEntry[] {
    return [...this.rows];
  }
}
