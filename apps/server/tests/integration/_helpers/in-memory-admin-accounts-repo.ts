// In-memory AccountsAdminRepo for integration tests. Shares state with
// the InMemoryAuthRepo it was constructed against — that mirrors
// production where auth and admin paths read/write the same `accounts`
// row.

import type { AccountTier } from '@driftstack/api-types';
import type { AccountsAdminRepo } from '../../../src/services/admin-accounts.js';
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
}
