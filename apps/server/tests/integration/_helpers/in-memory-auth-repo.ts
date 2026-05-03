// In-memory implementation of AccountAuthRepo, used by integration tests so
// they can run without a real Postgres. Mirrors DrizzleAccountAuthRepo
// behaviour exactly.

import type {
  AccountAuthRepo,
  AccountRow,
  ApiKeyRow,
  RateLimitOverride,
} from '../../../src/services/auth.js';

export class InMemoryAuthRepo implements AccountAuthRepo {
  private readonly accounts = new Map<string, AccountRow>();
  private readonly keysById = new Map<string, ApiKeyRow>();
  private readonly keysByPrefix = new Map<string, ApiKeyRow>();
  private readonly overrides = new Map<string, Map<string, RateLimitOverride>>();

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

  /** Test seam: snapshot of all account rows. Used by InMemoryAccountsAdminRepo.list. */
  allAccounts(): AccountRow[] {
    return Array.from(this.accounts.values());
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

  findActiveRateLimitOverrides(accountId: string, now: Date): Promise<RateLimitOverride[]> {
    const buckets = this.overrides.get(accountId);
    if (!buckets) return Promise.resolve([]);
    const out: RateLimitOverride[] = [];
    for (const o of buckets.values()) {
      if (o.expiresAt.getTime() > now.getTime()) out.push(o);
    }
    return Promise.resolve(out);
  }

  /** Test helper: set/clear overrides for an account. Mirrors what the
   * RateLimitOverridesService does via its repo in production. */
  setRateLimitOverride(accountId: string, override: RateLimitOverride): void {
    let buckets = this.overrides.get(accountId);
    if (!buckets) {
      buckets = new Map();
      this.overrides.set(accountId, buckets);
    }
    buckets.set(override.bucketKey, override);
  }

  clearRateLimitOverride(accountId: string, bucketKey: string): void {
    this.overrides.get(accountId)?.delete(bucketKey);
  }
}
