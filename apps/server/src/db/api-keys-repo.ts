// Drizzle-backed implementation of ApiKeysRepo.

import { and, desc, eq } from 'drizzle-orm';
import type { ApiKeyRow } from '../services/auth.js';
import type { ApiKeysRepo, NewApiKeyInput } from '../services/api-keys.js';
import type { Database } from './client.js';
import { apiKeys } from './schema.js';

export class DrizzleApiKeysRepo implements ApiKeysRepo {
  constructor(private readonly database: Database) {}

  async insertApiKey(input: NewApiKeyInput): Promise<ApiKeyRow> {
    const [row] = await this.database.db
      .insert(apiKeys)
      .values({
        accountId: input.accountId,
        name: input.name,
        scopes: input.scopes,
        keyPrefix: input.keyPrefix,
        keyHash: input.keyHash,
        expiresAt: input.expiresAt,
      })
      .returning();
    if (!row) throw new Error('insertApiKey returned no row');
    return toApiKeyRow(row);
  }

  async listApiKeys(accountId: string): Promise<ApiKeyRow[]> {
    const rows = await this.database.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.accountId, accountId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(toApiKeyRow);
  }

  async findApiKey(id: string, accountId: string): Promise<ApiKeyRow | null> {
    const [row] = await this.database.db
      .select()
      .from(apiKeys)
      .where(and(eq(apiKeys.id, id), eq(apiKeys.accountId, accountId)))
      .limit(1);
    return row ? toApiKeyRow(row) : null;
  }

  async markRevoked(id: string, at: Date): Promise<void> {
    await this.database.db.update(apiKeys).set({ revokedAt: at }).where(eq(apiKeys.id, id));
  }
}

function toApiKeyRow(r: typeof apiKeys.$inferSelect): ApiKeyRow {
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    keyPrefix: r.keyPrefix,
    keyHash: r.keyHash,
    scopes: r.scopes,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    expiresAt: r.expiresAt,
    createdAt: r.createdAt,
  };
}
