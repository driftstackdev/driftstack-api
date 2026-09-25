// Drizzle-backed AccountDeletionPurgeRepo — read-only candidate query for
// the account-deletion-purge-sweeper. Queries the `accounts` table directly
// (the BYOK Anthropic columns + status/deleted_at all live there; migration
// 0041 added the BYOK columns, migration 0094 added deleted_at).

import { and, eq, inArray, isNotNull, lt } from 'drizzle-orm';
import type { Database } from './client.js';
import { accounts } from './schema.js';
import type {
  AccountDeletionPurgeRepo,
  TerminatedAccountAvatarPurgeRepo,
} from '../services/account-deletion-purge-sweeper.js';
import type { AvatarPointerRepo } from '../services/avatar-orphan-reaper.js';

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

/**
 * Security sweep E-23 (2026-09-24) — candidates and bookkeeping for the avatar
 * arm. The objects themselves live on the public bucket; the sweeper deletes them
 * and only then calls `clearAvatarKey`, so a row whose pointer is still set is
 * one whose image may still be public.
 */
export class DrizzleTerminatedAccountAvatarPurgeRepo implements TerminatedAccountAvatarPurgeRepo {
  constructor(private readonly database: Database) {}

  /** Bounded per tick, like every sibling arm; self-limiting once the pointer is cleared. */
  async findTerminatedAccountIdsWithAvatarBefore(
    cutoff: Date,
    maxPerTick = 500,
  ): Promise<string[]> {
    const rows = await this.database.db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.status, 'deleted'),
          isNotNull(accounts.deletedAt),
          lt(accounts.deletedAt, cutoff),
          isNotNull(accounts.avatarR2Key),
        ),
      )
      .limit(maxPerTick);
    return rows.map((r) => r.id);
  }

  /**
   * Guarded on status as well as id: this runs after an irreversible delete, and
   * must never clear the avatar of an account that is live again.
   */
  async clearAvatarKey(accountId: string): Promise<void> {
    await this.database.db
      .update(accounts)
      .set({ avatarR2Key: null, updatedAt: new Date() })
      .where(and(eq(accounts.id, accountId), eq(accounts.status, 'deleted')));
  }
}

/**
 * Security sweep E-23 — the pointer read the avatar orphan reaper trusts before an
 * irreversible delete: an object that is not its account's current pointer is
 * deleted. Every status is returned, deliberately; a deleted account's avatar
 * inside the retention window still belongs to it.
 */
export class DrizzleAvatarPointerRepo implements AvatarPointerRepo {
  constructor(private readonly database: Database) {}

  async findAvatarKeysForAccounts(
    accountIds: readonly string[],
  ): Promise<Map<string, string | null>> {
    if (accountIds.length === 0) return new Map();
    const rows = await this.database.db
      .select({ id: accounts.id, avatarR2Key: accounts.avatarR2Key })
      .from(accounts)
      .where(inArray(accounts.id, [...accountIds]));
    return new Map(rows.map((r) => [r.id, r.avatarR2Key]));
  }
}
