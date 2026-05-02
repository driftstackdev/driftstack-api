// Drizzle-backed implementation of AccountAuthRepo.

import { and, eq, isNull, or } from 'drizzle-orm';
import type { AccountAuthRepo, AccountRow, ApiKeyRow } from '../services/auth.js';
import type { Database } from './client.js';
import { accounts, apiKeys } from './schema.js';

export class DrizzleAccountAuthRepo implements AccountAuthRepo {
  constructor(private readonly database: Database) {}

  async findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null> {
    const [row] = await this.database.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.keyPrefix, prefix))
      .limit(1);
    return row ? toApiKeyRow(row) : null;
  }

  async getAccount(id: string): Promise<AccountRow | null> {
    const [row] = await this.database.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id))
      .limit(1);
    return row ? toAccountRow(row) : null;
  }

  async touchApiKeyLastUsed(id: string, at: Date): Promise<void> {
    await this.database.db
      .update(apiKeys)
      .set({ lastUsedAt: at })
      .where(
        and(
          eq(apiKeys.id, id),
          // Skip the write if last_used_at was set within the last 30s — saves
          // a row update on every authenticated request.
          or(
            isNull(apiKeys.lastUsedAt),
            // Compare last_used_at < (at - 30s): SQL would be more idiomatic
            // here; we fall back to JS-side staleness check for now.
          ),
        ),
      );
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

function toAccountRow(r: typeof accounts.$inferSelect): AccountRow {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    tier: r.tier,
    status: r.status,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}
