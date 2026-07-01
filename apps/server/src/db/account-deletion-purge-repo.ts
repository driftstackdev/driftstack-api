// Drizzle-backed AccountDeletionPurgeRepo — read-only candidate query for
// the account-deletion-purge-sweeper. Queries the `accounts` table directly
// (the BYOK Anthropic columns + status/deleted_at all live there; migration
// 0041 added the BYOK columns, migration 0094 added deleted_at).

import { and, eq, isNotNull, lt } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts } from './schema.js';
import type { AccountDeletionPurgeRepo } from '../services/account-deletion-purge-sweeper.js';

export class DrizzleAccountDeletionPurgeRepo implements AccountDeletionPurgeRepo {
  constructor(private readonly database: Database) {}

  async findDeletedAccountIdsWithByokKeyBefore(cutoff: Date): Promise<string[]> {
    const rows = await this.database.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.status, 'deleted'),
          isNotNull(accounts.deletedAt),
          lt(accounts.deletedAt, cutoff),
          isNotNull(accounts.byokAnthropicApiKeyCiphertext),
        ),
      );
    return rows.map((r) => r.id);
  }
}
