// In-memory RateLimitOverridesRepo for integration tests. Mirrors
// writes into the InMemoryAuthRepo so the auth path sees the override.
// Same pattern as InMemoryApiKeysRepo (V-012).

import { randomUUID } from 'node:crypto';
import type {
  RateLimitOverrideRecord,
  RateLimitOverridesRepo,
  SetOverrideInput,
} from '../../../src/services/rate-limit-overrides.js';
import type { InMemoryAuthRepo } from './in-memory-auth-repo.js';

export class InMemoryRateLimitOverridesRepo implements RateLimitOverridesRepo {
  // Keyed by `${accountId}:${bucketKey}` — the unique key on the table.
  private readonly rows = new Map<string, RateLimitOverrideRecord>();

  constructor(private readonly authRepo: InMemoryAuthRepo) {}

  upsert(input: SetOverrideInput): Promise<RateLimitOverrideRecord> {
    const key = `${input.accountId}:${input.bucketKey}`;
    const now = new Date();
    const existing = this.rows.get(key);
    const record: RateLimitOverrideRecord = {
      id: existing?.id ?? randomUUID(),
      accountId: input.accountId,
      bucketKey: input.bucketKey,
      capacity: input.capacity,
      refillPerSecond: input.refillPerSecond,
      reason: input.reason ?? null,
      expiresAt: input.expiresAt,
      setByKeyId: input.setByKeyId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.rows.set(key, record);
    // Mirror into the auth repo so AccountContext loads see it.
    this.authRepo.setRateLimitOverride(input.accountId, {
      bucketKey: input.bucketKey,
      capacity: input.capacity,
      refillPerSecond: input.refillPerSecond,
      expiresAt: input.expiresAt,
    });
    return Promise.resolve(record);
  }

  clear(accountId: string, bucketKey: string): Promise<boolean> {
    const key = `${accountId}:${bucketKey}`;
    const existed = this.rows.delete(key);
    if (existed) this.authRepo.clearRateLimitOverride(accountId, bucketKey);
    return Promise.resolve(existed);
  }

  /** Test helper: enumerate all stored override records. */
  getAll(): RateLimitOverrideRecord[] {
    return Array.from(this.rows.values());
  }
}
