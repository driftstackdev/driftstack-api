// In-memory ApiKeysRepo for integration tests.
//
// In production, ApiKeysRepo and AccountAuthRepo are two views over the same
// underlying api_keys table — a single UPDATE row affects both reads. The
// in-memory fixtures keep separate maps, so revocation done via this repo
// would otherwise be invisible to the auth-side. The optional `authRepo`
// constructor argument lets buildTestApp keep them in sync.

import { randomUUID } from 'node:crypto';
import type { ApiKeyRow } from '../../../src/services/auth.js';
import type { ApiKeysRepo, NewApiKeyInput } from '../../../src/services/api-keys.js';
import type { InMemoryAuthRepo } from './in-memory-auth-repo.js';

export class InMemoryApiKeysRepo implements ApiKeysRepo {
  private readonly byId = new Map<string, ApiKeyRow>();

  constructor(private readonly authRepoMirror: InMemoryAuthRepo | null = null) {}

  /** Pre-seed (used by buildTestApp to wire in the test fixture's own key). */
  upsert(row: ApiKeyRow): void {
    this.byId.set(row.id, row);
    if (this.authRepoMirror) this.authRepoMirror.upsertApiKey(row);
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
    if (this.authRepoMirror) this.authRepoMirror.upsertApiKey(row);
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

  findApiKeyUnscoped(id: string): Promise<ApiKeyRow | null> {
    return Promise.resolve(this.byId.get(id) ?? null);
  }

  markRevoked(id: string, at: Date): Promise<void> {
    const r = this.byId.get(id);
    if (r) {
      const updated: ApiKeyRow = { ...r, revokedAt: at };
      this.byId.set(id, updated);
      if (this.authRepoMirror) this.authRepoMirror.upsertApiKey(updated);
    }
    return Promise.resolve();
  }

  listAllApiKeys(opts: {
    limit: number;
    cursor?: string;
    accountId?: string;
    revoked?: boolean;
  }): Promise<{ items: ApiKeyRow[]; nextCursor: string | null }> {
    const cursorDate = opts.cursor ? new Date(opts.cursor) : null;
    const all = Array.from(this.byId.values())
      .filter((r) => (opts.accountId ? r.accountId === opts.accountId : true))
      .filter((r) => {
        if (opts.revoked === true) return r.revokedAt !== null;
        if (opts.revoked === false) return r.revokedAt === null;
        return true;
      })
      .filter((r) => (cursorDate ? r.createdAt < cursorDate : true))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.createdAt.toISOString() : null,
    });
  }
}
