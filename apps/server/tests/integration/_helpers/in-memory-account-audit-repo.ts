// V-216 — in-memory AccountAuditRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  AccountAuditEntryRow,
  AccountAuditRepo,
  ListAccountAuditOpts,
  ListAccountAuditPage,
  RecordAccountAuditInput,
} from '../../../src/services/account-audit.js';
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
    return Promise.resolve({ ...row });
  }

  /** Test-only — returns every row inserted, regardless of account. */
  getAll(): readonly AccountAuditEntryRow[] {
    return this.rows;
  }

  list(accountId: string, opts: ListAccountAuditOpts): Promise<ListAccountAuditPage> {
    // V-1243 — keyset via the shared helper. The sort mirrored the Drizzle repo; the
    // cursor did not. findIndex inside the filtered array returns -1 as soon as the
    // cursor row stops matching — a narrowed window, a different action filter on a
    // re-read, a retention purge — and the slice read that as "start from the top".
    const scoped = this.rows
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => -compareAuditKey(a, b));
    const ordered = scoped
      .filter((r) => (opts.action ? r.action === opts.action : true))
      // V-484 — date range + actor + target_resource_id filters.
      .filter((r) => (opts.from ? r.timestamp >= opts.from : true))
      .filter((r) => (opts.to ? r.timestamp <= opts.to : true))
      .filter((r) => (opts.actorType ? r.actorType === opts.actorType : true))
      .filter((r) => (opts.targetResourceId ? r.targetResourceId === opts.targetResourceId : true));

    const page = keysetPage({
      // Account-scoped and nothing more, matching the Drizzle anchor lookup's
      // `and(eq(id, cursor), eq(accountId, accountId))` exactly.
      anchorSet: scoped,
      rows: ordered,
      cursor: opts.cursor,
      limit: opts.limit,
      id: (r) => r.id,
      at: (r) => r.timestamp,
    });
    return Promise.resolve({
      items: page.items,
      nextCursor: page.nextCursor,
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
