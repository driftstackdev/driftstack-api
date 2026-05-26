// V-216 — in-memory AccountAuditRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  AccountAuditEntryRow,
  AccountAuditRepo,
  ListAccountAuditOpts,
  ListAccountAuditPage,
  RecordAccountAuditInput,
} from '../../../src/services/account-audit.js';

export class InMemoryAccountAuditRepo implements AccountAuditRepo {
  private readonly rows: AccountAuditEntryRow[] = [];

  insert(input: RecordAccountAuditInput): Promise<AccountAuditEntryRow> {
    const row: AccountAuditEntryRow = {
      id: randomUUID(),
      accountId: input.accountId,
      actorType: input.actorType,
      actorAccountId: input.actorAccountId ?? null,
      actorKeyId: input.actorKeyId ?? null,
      action: input.action,
      targetResourceId: input.targetResourceId ?? null,
      payload: input.payload ?? null,
      ipAddress: input.ipAddress ?? null,
      userAgent: input.userAgent ?? null,
      timestamp: new Date(),
    };
    this.rows.push(row);
    return Promise.resolve(row);
  }

  /** Test-only — returns every row inserted, regardless of account. */
  getAll(): readonly AccountAuditEntryRow[] {
    return this.rows;
  }

  list(accountId: string, opts: ListAccountAuditOpts): Promise<ListAccountAuditPage> {
    // Keyset cursor on (timestamp desc, id desc) — mirrors the Drizzle
    // repo. Stable sort, then resume strictly after the cursor row's
    // position so same-timestamp rows aren't dropped at a page boundary.
    let ordered = this.rows
      .filter((r) => r.accountId === accountId)
      .filter((r) => (opts.action ? r.action === opts.action : true))
      // V-484 — date range + actor + target_resource_id filters.
      .filter((r) => (opts.from ? r.timestamp >= opts.from : true))
      .filter((r) => (opts.to ? r.timestamp <= opts.to : true))
      .filter((r) => (opts.actorType ? r.actorType === opts.actorType : true))
      .filter((r) => (opts.targetResourceId ? r.targetResourceId === opts.targetResourceId : true))
      .sort((a, b) => {
        const dt = b.timestamp.getTime() - a.timestamp.getTime();
        if (dt !== 0) return dt;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });

    if (opts.cursor !== undefined) {
      const idx = ordered.findIndex((r) => r.id === opts.cursor);
      if (idx >= 0) ordered = ordered.slice(idx + 1);
    }

    const items = ordered.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = ordered.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.id : null,
    });
  }

  // 2026-05-22 — V-666 profile-import cycle cap helper. Counts rows
  // matching (accountId, action, timestamp >= since).
  countActionsSince(accountId: string, action: string, since: Date): Promise<number> {
    const n = this.rows.filter(
      (r) => r.accountId === accountId && r.action === action && r.timestamp >= since,
    ).length;
    return Promise.resolve(n);
  }
}
