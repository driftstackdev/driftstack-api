// In-memory ApiKeysRepo for integration tests.
//
// In production, ApiKeysRepo and AccountAuthRepo are two views over the same
// underlying api_keys table — a single UPDATE row affects both reads. The
// in-memory fixtures keep separate maps, so revocation done via this repo
// would otherwise be invisible to the auth-side. The optional `authRepo`
// constructor argument lets buildTestApp keep them in sync.

import { randomUUID } from 'node:crypto';
import type { ApiKeyRow } from '../../../src/services/auth.js';
import type {
  ApiKeysRepo,
  NewApiKeyInput,
  RevokeApiKeyInput,
  RevokeApiKeyRepoResult,
  RotateApiKeyInput,
  RotateApiKeyRepoResult,
} from '../../../src/services/api-keys.js';
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
      // C1 — carry provenance so a cli_device key minted through this repo
      // authenticates (via the mirrored auth repo) with the marker set,
      // mirroring the production api_keys column.
      provenance: input.provenance ?? null,
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

  revokeApiKeyAtomic(input: RevokeApiKeyInput): Promise<RevokeApiKeyRepoResult> {
    const current = this.byId.get(input.id);
    if (!current || (input.accountId !== null && current.accountId !== input.accountId)) {
      return Promise.resolve({ kind: 'not_found' });
    }
    if (current.revokedAt !== null) {
      return Promise.resolve({ kind: 'already_revoked', key: { ...current } });
    }
    const updated: ApiKeyRow = { ...current, revokedAt: input.revokedAt };
    this.byId.set(input.id, updated);
    if (this.authRepoMirror) this.authRepoMirror.upsertApiKey(updated);
    return Promise.resolve({ kind: 'revoked', key: { ...updated } });
  }

  setExpiresAt(id: string, expiresAt: Date): Promise<void> {
    const r = this.byId.get(id);
    if (r) {
      const updated: ApiKeyRow = { ...r, expiresAt };
      this.byId.set(id, updated);
      if (this.authRepoMirror) this.authRepoMirror.upsertApiKey(updated);
    }
    return Promise.resolve();
  }

  rotateApiKeyAtomic(input: RotateApiKeyInput): Promise<RotateApiKeyRepoResult> {
    const current = this.byId.get(input.oldKeyId);
    if (!current || current.accountId !== input.accountId) {
      return Promise.resolve({ kind: 'not_found' });
    }
    if (current.revokedAt !== null) return Promise.resolve({ kind: 'revoked' });
    if (current.expiresAt !== null && current.expiresAt <= input.now) {
      return Promise.resolve({ kind: 'expired' });
    }
    const candidateGraceEnd = new Date(input.now.getTime() + input.gracePeriodMs);
    const gracePeriodEndsAt =
      current.expiresAt !== null && current.expiresAt < candidateGraceEnd
        ? current.expiresAt
        : candidateGraceEnd;
    const newRow: ApiKeyRow = {
      id: randomUUID(),
      accountId: current.accountId,
      name: input.name ?? current.name,
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      scopes: current.scopes,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: current.expiresAt,
      provenance: null,
      createdAt: new Date(),
    };
    const updatedOld: ApiKeyRow = { ...current, expiresAt: gracePeriodEndsAt };
    this.byId.set(current.id, updatedOld);
    this.byId.set(newRow.id, newRow);
    if (this.authRepoMirror) {
      this.authRepoMirror.upsertApiKey(updatedOld);
      this.authRepoMirror.upsertApiKey(newRow);
    }
    return Promise.resolve({
      kind: 'rotated',
      oldKey: current,
      newRow,
      gracePeriodEndsAt,
    });
  }

  listAllApiKeys(opts: {
    limit: number;
    cursor?: string;
    accountId?: string;
    revoked?: boolean;
  }): Promise<{ items: ApiKeyRow[]; nextCursor: string | null }> {
    // Keyset (createdAt desc, id desc) — stable sort + resume after the
    // cursor row's position; mirrors the Drizzle repo.
    let all = Array.from(this.byId.values())
      .filter((r) => (opts.accountId ? r.accountId === opts.accountId : true))
      .filter((r) => {
        if (opts.revoked === true) return r.revokedAt !== null;
        if (opts.revoked === false) return r.revokedAt === null;
        return true;
      })
      .sort((a, b) => {
        const dt = b.createdAt.getTime() - a.createdAt.getTime();
        if (dt !== 0) return dt;
        return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
      });
    if (opts.cursor !== undefined) {
      const idx = all.findIndex((r) => r.id === opts.cursor);
      if (idx >= 0) all = all.slice(idx + 1);
    }
    const items = all.slice(0, opts.limit);
    const last = items[items.length - 1];
    const hasMore = all.length > opts.limit;
    return Promise.resolve({
      items,
      nextCursor: hasMore && last ? last.id : null,
    });
  }
}
