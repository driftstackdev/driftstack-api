// In-memory ApiKeysRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type { ApiKeyRow } from '../../../src/services/auth.js';
import type { ApiKeysRepo, NewApiKeyInput } from '../../../src/services/api-keys.js';

export class InMemoryApiKeysRepo implements ApiKeysRepo {
  private readonly byId = new Map<string, ApiKeyRow>();

  /** Pre-seed (used by buildTestApp to wire in the test fixture's own key). */
  upsert(row: ApiKeyRow): void {
    this.byId.set(row.id, row);
  }

  insertApiKey(input: NewApiKeyInput): Promise<ApiKeyRow> {
    const row: ApiKeyRow = {
      id: randomUUID(),
      accountId: input.accountId,
      name: input.name,
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      scopes: input.scopes,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: input.expiresAt,
      createdAt: new Date(),
    };
    this.byId.set(row.id, row);
    return Promise.resolve(row);
  }

  listApiKeys(accountId: string): Promise<ApiKeyRow[]> {
    const rows = Array.from(this.byId.values())
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(rows);
  }

  findApiKey(id: string, accountId: string): Promise<ApiKeyRow | null> {
    const r = this.byId.get(id);
    return Promise.resolve(r && r.accountId === accountId ? r : null);
  }

  markRevoked(id: string, at: Date): Promise<void> {
    const r = this.byId.get(id);
    if (r) this.byId.set(id, { ...r, revokedAt: at });
    return Promise.resolve();
  }
}
