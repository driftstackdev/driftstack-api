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

  /**
   * BOUNDED per tick, matching the other five arms.
   *
   * This was the last unbounded erasure path. The sweeper consumes the result
   * in a loop, one `clearKey` per account, so an unbounded candidate list on a
   * production backlog of long-terminated accounts means one tick issues an
   * unbounded number of sequential key-clearing writes. Correct either way —
   * the query is self-limiting, since clearing the ciphertext drops the account
   * out of the candidate set — but a cap keeps the blast radius of a first run
   * something an operator can watch, and leaves no arm behaving differently
   * from its siblings for no stated reason.
   */
  async findDeletedAccountIdsWithByokKeyBefore(cutoff: Date, maxPerTick = 500): Promise<string[]> {
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
      )
      .limit(maxPerTick);
    return rows.map((r) => r.id);
  }
}
