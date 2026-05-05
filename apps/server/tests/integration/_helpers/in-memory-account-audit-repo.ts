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

  list(accountId: string, opts: ListAccountAuditOpts): Promise<ListAccountAuditPage> {
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const filtered = this.rows
      .filter((r) => r.accountId === accountId)
      .filter((r) => (opts.action ? r.action === opts.action : true))
      .filter((r) => (cursorDate ? r.timestamp < cursorDate : true))
      .sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime());

    const items = filtered.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = filtered.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.timestamp.toISOString() : null,
    });
  }
}
