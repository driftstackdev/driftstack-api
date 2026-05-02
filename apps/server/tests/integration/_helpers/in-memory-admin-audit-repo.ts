// In-memory AdminAuditLogRepo for integration tests. Insert + filtered
// list only — mirrors the production "no UPDATE/DELETE" surface.

import { randomUUID } from 'node:crypto';
import type {
  AdminAuditLogRepo,
  AdminAuditLogRow,
  ListAuditFilters,
  ListAuditPage,
  NewAdminAuditLogInput,
} from '../../../src/services/admin-audit.js';

export class InMemoryAdminAuditLogRepo implements AdminAuditLogRepo {
  private readonly rows: AdminAuditLogRow[] = [];

  insert(input: NewAdminAuditLogInput): Promise<AdminAuditLogRow> {
    const row: AdminAuditLogRow = {
      id: randomUUID(),
      adminAccountId: input.adminAccountId,
      adminKeyId: input.adminKeyId,
      action: input.action,
      targetAccountId: input.targetAccountId ?? null,
      targetResourceId: input.targetResourceId ?? null,
      inputPayload: input.inputPayload ?? null,
      result: input.result,
      ipAddress: input.ipAddress ?? null,
      timestamp: new Date(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  list(filters: ListAuditFilters): Promise<ListAuditPage> {
    let filtered = [...this.rows];
    if (filters.adminAccountId) {
      filtered = filtered.filter((r) => r.adminAccountId === filters.adminAccountId);
    }
    if (filters.targetAccountId) {
      filtered = filtered.filter((r) => r.targetAccountId === filters.targetAccountId);
    }
    if (filters.action) filtered = filtered.filter((r) => r.action === filters.action);
    if (filters.from) {
      const fromMs = filters.from.getTime();
      filtered = filtered.filter((r) => r.timestamp.getTime() >= fromMs);
    }
    if (filters.to) {
      const toMs = filters.to.getTime();
      filtered = filtered.filter((r) => r.timestamp.getTime() < toMs);
    }
    if (filters.cursor) {
      const cursorMs = new Date(filters.cursor).getTime();
      filtered = filtered.filter((r) => r.timestamp.getTime() < cursorMs);
    }
    filtered.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const items = filtered.slice(0, filters.limit);
    const hasMore = filtered.length > filters.limit;
    const last = items[items.length - 1];
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.timestamp.toISOString() : null,
    });
  }

  /** Test helper: return all rows in insertion order. */
  getAll(): AdminAuditLogRow[] {
    return [...this.rows];
  }
}
