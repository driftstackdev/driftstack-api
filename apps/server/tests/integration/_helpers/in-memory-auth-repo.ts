// In-memory implementation of AccountAuthRepo, used by integration tests so
// they can run without a real Postgres. Mirrors DrizzleAccountAuthRepo
// behaviour exactly.

import type { AccountAuthRepo, AccountRow, ApiKeyRow } from '../../../src/services/auth.js';

export class InMemoryAuthRepo implements AccountAuthRepo {
  private readonly accounts = new Map<string, AccountRow>();
  private readonly keysById = new Map<string, ApiKeyRow>();
  private readonly keysByPrefix = new Map<string, ApiKeyRow>();

  upsertAccount(row: AccountRow): void {
    this.accounts.set(row.id, row);
  }

  upsertApiKey(row: ApiKeyRow): void {
    this.keysById.set(row.id, row);
    this.keysByPrefix.set(row.keyPrefix, row);
  }

  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    return Promise.resolve(this.keysByPrefix.get(prefix) ?? null);
  }

  getAccount(id: string): Promise<AccountRow | null> {
    return Promise.resolve(this.accounts.get(id) ?? null);
  }

  touchApiKeyLastUsed(id: string, at: Date): Promise<void> {
    const row = this.keysById.get(id);
    if (row) {
      const updated: ApiKeyRow = { ...row, lastUsedAt: at };
      this.keysById.set(id, updated);
      this.keysByPrefix.set(updated.keyPrefix, updated);
    }
    return Promise.resolve();
  }
}
