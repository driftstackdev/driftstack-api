// Drizzle-backed implementation of ApiKeysRepo.

import { type SQL, and, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { ApiKeyRow } from '../services/auth.js';
import type { ApiKeysRepo, NewApiKeyInput } from '../services/api-keys.js';
import type { Database } from './client.js';
import { apiKeys } from './schema.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';

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
        provenance: input.provenance ?? null,
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

  async findApiKeyUnscoped(id: string): Promise<ApiKeyRow | null> {
    const [row] = await this.database.db.select().from(apiKeys).where(eq(apiKeys.id, id)).limit(1);
    return row ? toApiKeyRow(row) : null;
  }

  async markRevoked(id: string, at: Date): Promise<void> {
    await this.database.db.update(apiKeys).set({ revokedAt: at }).where(eq(apiKeys.id, id));
  }

  async setExpiresAt(id: string, expiresAt: Date): Promise<void> {
    await this.database.db.update(apiKeys).set({ expiresAt }).where(eq(apiKeys.id, id));
  }

  async listAllApiKeys(opts: {
    limit: number;
    cursor?: string;
    accountId?: string;
    revoked?: boolean;
  }): Promise<{ items: ApiKeyRow[]; nextCursor: string | null }> {
    // Keyset cursor on (createdAt desc, id desc) — cursor = last row id.
    // Mirrors profiles-repo; avoids dropping same-createdAt rows.
    const filters: SQL[] = [];
    if (opts.cursor !== undefined && parseUuidCursor(opts.cursor) !== undefined) {
      const [c] = await this.database.db
        .select({ createdAt: apiKeys.createdAt, id: apiKeys.id })
        .from(apiKeys)
        .where(eq(apiKeys.id, opts.cursor))
        .limit(1);
      if (c) {
        const keyset = or(
          lt(apiKeys.createdAt, c.createdAt),
          and(eq(apiKeys.createdAt, c.createdAt), lt(apiKeys.id, c.id)),
        );
        if (keyset) filters.push(keyset);
      }
    }
    if (opts.accountId) filters.push(eq(apiKeys.accountId, opts.accountId));
    if (opts.revoked === true) filters.push(isNotNull(apiKeys.revokedAt));
    if (opts.revoked === false) filters.push(isNull(apiKeys.revokedAt));
    const whereClause = filters.length === 0 ? undefined : and(...filters);

    const rows = await this.database.db
      .select()
      .from(apiKeys)
      .where(whereClause)
      .orderBy(desc(apiKeys.createdAt), desc(apiKeys.id))
      .limit(opts.limit + 1);

    const hasMore = rows.length > opts.limit;
    const items = hasMore ? rows.slice(0, opts.limit) : rows;
    const last = items[items.length - 1];
    return {
      items: items.map(toApiKeyRow),
      nextCursor: hasMore && last ? last.id : null,
    };
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
    provenance: r.provenance,
    createdAt: r.createdAt,
  };
}
