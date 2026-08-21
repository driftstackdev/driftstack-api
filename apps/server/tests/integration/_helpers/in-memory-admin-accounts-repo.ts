// In-memory AccountsAdminRepo for integration tests. Shares state with
// the InMemoryAuthRepo it was constructed against — that mirrors
// production where auth and admin paths read/write the same `accounts`
// row.

import { AccountTierSchema, type AccountTier } from '@driftstack/api-types';
import type {
  AccountsAdminRepo,
  ListAccountsArgs,
  ListAccountsPage,
} from '../../../src/services/admin-accounts.js';
import type { AccountRow } from '../../../src/services/auth.js';
import { parseUuidCursor } from '../../../src/lib/keyset-cursor.js';
import type { InMemoryAuthRepo } from './in-memory-auth-repo.js';

/**
 * Ascending `(createdAt, id)` — the sort negates it for the created_at DESC, id DESC
 * page order, and the cursor clause reuses it so the boundary can never disagree with
 * the ordering it is a boundary in. Plain `<` on the id rather than `localeCompare`:
 * these are canonical lowercase-hex uuids, so byte order is what Postgres compares.
 */
function compareKey(a: AccountRow, b: AccountRow): number {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class InMemoryAccountsAdminRepo implements AccountsAdminRepo {
  constructor(private readonly authRepo: InMemoryAuthRepo) {}

  findById(id: string): Promise<AccountRow | null> {
    return this.authRepo.getAccount(id);
  }

  async setTier(id: string, tier: AccountTier, at: Date): Promise<AccountRow | null> {
    const current = await this.authRepo.getAccount(id);
    if (!current) return null;
    const updated: AccountRow = { ...current, tier, updatedAt: at };
    this.authRepo.upsertAccount(updated);
    return updated;
  }

  async setStatus(
    id: string,
    status: 'active' | 'suspended' | 'deleted',
    at: Date,
  ): Promise<AccountRow | null> {
    const current = await this.authRepo.getAccount(id);
    if (!current) return null;
    const updated: AccountRow = { ...current, status, updatedAt: at };
    this.authRepo.upsertAccount(updated);
    return updated;
  }

  list(args: ListAccountsArgs): Promise<ListAccountsPage> {
    const limit = Math.min(args.limit ?? 50, 100);
    const all = this.authRepo.allAccounts();

    let filtered = all;
    if (args.status !== undefined) filtered = filtered.filter((r) => r.status === args.status);
    if (args.tier !== undefined) filtered = filtered.filter((r) => r.tier === args.tier);
    if (args.emailContains !== undefined && args.emailContains.length > 0) {
      const needle = args.emailContains.toLowerCase();
      filtered = filtered.filter((r) => r.email.toLowerCase().includes(needle));
    }

    filtered = [...filtered].sort((a, b) => -compareKey(a, b));

    // V-1236b — KEYSET, mirroring DrizzleAccountsAdminRepo.list, which resolves the
    // cursor row by id across ALL accounts and then filters on
    // `(created_at, id) < (cursor.created_at, cursor.id)`.
    //
    // This used to be an offset instead: findIndex(id === cursor) inside the already
    // FILTERED array, then slice from index + 1. That agrees with the keyset query for
    // exactly as long as the cursor row still satisfies the filter — and `findIndex`
    // returns -1 the moment it does not, which the slice read as "start from the top".
    // So an admin who filtered by active, read page one, suspended an account they had
    // just read, and asked for page two got page two starting back at the first row:
    // accounts already seen, listed again, in the one workflow this browser exists for.
    // Resolving the cursor against `all` is the load-bearing part — the cursor row is
    // allowed to have left the filtered set.
    if (args.cursor !== undefined && parseUuidCursor(args.cursor) !== undefined) {
      const cursorRow = all.find((r) => r.id === args.cursor);
      // An unknown cursor falls through to page one rather than to an empty page,
      // matching the Drizzle side, where a cursor row that no longer exists simply
      // contributes no WHERE clause.
      if (cursorRow !== undefined) filtered = filtered.filter((r) => compareKey(r, cursorRow) < 0);
    }

    const slice = filtered.slice(0, limit + 1);
    const hasMore = slice.length > limit;
    const data = slice.slice(0, limit);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return Promise.resolve({ data, hasMore, nextCursor });
  }

  countByStatus(status: 'active' | 'suspended' | 'deleted'): Promise<number> {
    const cnt = this.authRepo.allAccounts().filter((r) => r.status === status).length;
    return Promise.resolve(cnt);
  }

  countByTier(): Promise<Record<AccountTier, number>> {
    const out = {} as Record<AccountTier, number>;
    for (const tier of AccountTierSchema.options) out[tier] = 0;
    for (const r of this.authRepo.allAccounts()) out[r.tier] += 1;
    return Promise.resolve(out);
  }

  countCreatedSince(since: Date): Promise<number> {
    const cnt = this.authRepo
      .allAccounts()
      .filter((r) => r.createdAt.getTime() >= since.getTime()).length;
    return Promise.resolve(cnt);
  }
}
