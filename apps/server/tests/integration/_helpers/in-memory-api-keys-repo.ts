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
import { keysetPage } from './keyset-page.js';

/**
 * Ascending `(createdAt, id)`; the sort negates it and the keyset boundary derives from
 * the same key, so ordering and boundary cannot drift apart.
 */
function compareApiKeyKey(a: { createdAt: Date; id: string }, b: { createdAt: Date; id: string }) {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

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
    // V-727 — the production api_keys row carries created_by_account_id (who
    // MINTED the key, which on a team-scoped mint is the member while
    // accountId stays the owner). ApiKeyRow deliberately does not expose it —
    // it is not auth-relevant and widening that type ripples into the auth
    // cache — so the twin mirrors the column in a side map instead.
    if (input.createdByAccountId != null) {
      this.minterByKeyId.set(row.id, input.createdByAccountId);
    }
    if (this.authRepoMirror) this.authRepoMirror.upsertApiKey(row);
    return Promise.resolve({ ...row });
  }

  private readonly minterByKeyId = new Map<string, string>();

  // V-727 — mirrors the Drizzle sibling: keys minted BY this account, wherever
  // they live. Deliberately NOT filtered by accountId.
  listApiKeysMintedBy(minterAccountId: string): Promise<ApiKeyRow[]> {
    const rows = Array.from(this.byId.values())
      .filter((r) => this.minterByKeyId.get(r.id) === minterAccountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }

  listApiKeys(accountId: string): Promise<ApiKeyRow[]> {
    const rows = Array.from(this.byId.values())
      .filter((r) => r.accountId === accountId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    return Promise.resolve(rows.map((r) => ({ ...r })));
  }

  findApiKey(id: string, accountId: string): Promise<ApiKeyRow | null> {
    const r = this.byId.get(id);
    return Promise.resolve(r && r.accountId === accountId ? r : null);
  }

  findApiKeyUnscoped(id: string): Promise<ApiKeyRow | null> {
    const row = this.byId.get(id);
    return Promise.resolve(row ? { ...row } : null);
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
    // V-775 twin — mirrors DrizzleApiKeysRepo.rotateApiKeyAtomic EXACTLY: rotation
    // de-escalates (drop the staff scope, retire the legacy `admin` alias to `account_owner`)
    // and carries the minter forward. A double that behaves differently from the real repo
    // makes every route-level test that uses it meaningless — which is precisely how the
    // billing defect in V-767 survived its own green suite.
    const successorScopes = [
      ...new Set(
        current.scopes.flatMap((scope) =>
          scope === 'driftstack_internal_admin'
            ? []
            : scope === 'admin'
              ? (['account_owner'] as const)
              : [scope],
        ),
      ),
    ];
    const newRow: ApiKeyRow = {
      id: randomUUID(),
      accountId: current.accountId,
      name: input.name ?? current.name,
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      scopes: successorScopes,
      lastUsedAt: null,
      revokedAt: null,
      expiresAt: current.expiresAt,
      provenance: null,
      createdAt: new Date(),
    };
    const updatedOld: ApiKeyRow = { ...current, expiresAt: gracePeriodEndsAt };
    this.byId.set(current.id, updatedOld);
    this.byId.set(newRow.id, newRow);
    // V-775 twin — the real repo carries `created_by_account_id` onto the successor. ApiKeyRow
    // does not expose that column, so this fake tracks it in `minterByKeyId`; propagating it
    // here is what makes listApiKeysMintedBy (and therefore offboarding reclaim) see the
    // successor, exactly as the SQL does.
    const minter = this.minterByKeyId.get(current.id);
    if (minter !== undefined) this.minterByKeyId.set(newRow.id, minter);
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
    // V-1242 — keyset via the shared helper. This listing filters on `revoked`, and
    // revoking a key is an ordinary customer action: resolving the cursor by its position
    // inside the filtered array meant that revoking a key you had just been shown made
    // page two of a `revoked: false` listing restart at the top, re-listing keys already
    // seen. The Drizzle anchor lookup scopes by account only, never by revoked.
    const scoped = Array.from(this.byId.values())
      .filter((r) => (opts.accountId ? r.accountId === opts.accountId : true))
      .sort((a, b) => -compareApiKeyKey(a, b));
    const all = scoped.filter((r) => {
      if (opts.revoked === true) return r.revokedAt !== null;
      if (opts.revoked === false) return r.revokedAt === null;
      return true;
    });
    const page = keysetPage({
      anchorSet: scoped,
      rows: all,
      cursor: opts.cursor,
      limit: opts.limit,
      id: (r) => r.id,
      at: (r) => r.createdAt,
    });
    return Promise.resolve({
      items: page.items,
      nextCursor: page.nextCursor,
    });
  }
}
