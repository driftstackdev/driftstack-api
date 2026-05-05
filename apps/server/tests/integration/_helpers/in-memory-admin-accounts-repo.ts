// In-memory AccountsAdminRepo for integration tests. Shares state with
// the InMemoryAuthRepo it was constructed against — that mirrors
// production where auth and admin paths read/write the same `accounts`
// row.

import type { AccountTier } from '@driftstack/api-types';
import type {
  AccountsAdminRepo,
  ListAccountsArgs,
  ListAccountsPage,
} from '../../../src/services/admin-accounts.js';
import type { AccountRow } from '../../../src/services/auth.js';
import type { InMemoryAuthRepo } from './in-memory-auth-repo.js';

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
    let filtered = this.authRepo.allAccounts();
    if (args.status !== undefined) filtered = filtered.filter((r) => r.status === args.status);
    if (args.tier !== undefined) filtered = filtered.filter((r) => r.tier === args.tier);
    if (args.emailContains !== undefined && args.emailContains.length > 0) {
      const needle = args.emailContains.toLowerCase();
      filtered = filtered.filter((r) => r.email.toLowerCase().includes(needle));
    }

    filtered.sort((a, b) => {
      const t = b.createdAt.getTime() - a.createdAt.getTime();
      return t !== 0 ? t : b.id.localeCompare(a.id);
    });

    let startIdx = 0;
    if (args.cursor !== undefined) {
      const i = filtered.findIndex((r) => r.id === args.cursor);
      startIdx = i >= 0 ? i + 1 : 0;
    }

    const slice = filtered.slice(startIdx, startIdx + limit + 1);
    const hasMore = slice.length > limit;
    const data = slice.slice(0, limit);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return Promise.resolve({ data, hasMore, nextCursor });
  }

  countByStatus(status: 'active' | 'suspended' | 'deleted'): Promise<number> {
    const cnt = this.authRepo.allAccounts().filter((r) => r.status === status).length;
    return Promise.resolve(cnt);
  }
}
