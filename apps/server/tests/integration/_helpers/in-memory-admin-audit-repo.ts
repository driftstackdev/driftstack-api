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
import { keysetPage } from './keyset-page.js';

/**
 * Ascending `(timestamp, id)`; the sort negates it and the keyset boundary derives from
 * the same key, so ordering and boundary cannot drift apart.
 */
function compareAuditKey(a: { timestamp: Date; id: string }, b: { timestamp: Date; id: string }) {
  const t = a.timestamp.getTime() - b.timestamp.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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
    return Promise.resolve({ ...row });
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
    // V-521 — drill-down by resource id.
    if (filters.targetResourceId) {
      filtered = filtered.filter((r) => r.targetResourceId === filters.targetResourceId);
    }
    // V-1243 — keyset via the shared helper. The comment here claimed to mirror the
    // Drizzle repo, and the SORT did; the cursor did not. Resolving it with findIndex
    // inside the filtered array returns -1 once the cursor row leaves that array — a
    // narrower window on a re-read, or a retention purge — and the slice read -1 as
    // "start from the top", handing back entries the caller had already exported.
    filtered.sort((a, b) => -compareAuditKey(a, b));
    const page = keysetPage({
      // V-1249 — scoped by adminAccountId when one was given, matching the repo's
      // anchor lookup now that it scopes too. V-1243 mirrored the unscoped version and
      // recorded the gap rather than deciding it in a fixture; the decision was then
      // made in the repo, and this follows it.
      anchorSet: [...this.rows]
        .filter((r) =>
          filters.adminAccountId === undefined ? true : r.adminAccountId === filters.adminAccountId,
        )
        .sort((a, b) => -compareAuditKey(a, b)),
      rows: filtered,
      cursor: filters.cursor,
      limit: filters.limit,
      id: (r) => r.id,
      at: (r) => r.timestamp,
    });
    return Promise.resolve({
      items: page.items,
      nextCursor: page.nextCursor,
    });
  }

  /** Test helper: return all rows in insertion order. */
  getAll(): AdminAuditLogRow[] {
    return [...this.rows];
  }
}
