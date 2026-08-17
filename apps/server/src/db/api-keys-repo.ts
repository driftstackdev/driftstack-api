// Drizzle-backed implementation of ApiKeysRepo.

import { type SQL, and, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { ApiKeyRow } from '../services/auth.js';
import type {
  ApiKeysRepo,
  NewApiKeyInput,
  RevokeApiKeyInput,
  RevokeApiKeyRepoResult,
  RotateApiKeyInput,
  RotateApiKeyRepoResult,
} from '../services/api-keys.js';
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
        createdByAccountId: input.createdByAccountId ?? null,
      })
      .returning();
    if (!row) throw new Error('insertApiKey returned no row');
    return toApiKeyRow(row);
  }

  // V-727 — keys minted BY this account on other accounts. Deliberately not
  // filtered by accountId: the whole point is the ones that live elsewhere.
  async listApiKeysMintedBy(minterAccountId: string): Promise<ApiKeyRow[]> {
    const rows = await this.database.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.createdByAccountId, minterAccountId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(toApiKeyRow);
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

  async revokeApiKeyAtomic(input: RevokeApiKeyInput): Promise<RevokeApiKeyRepoResult> {
    const scope = and(
      eq(apiKeys.id, input.id),
      input.accountId === null ? undefined : eq(apiKeys.accountId, input.accountId),
    );
    const [revoked] = await this.database.db
      .update(apiKeys)
      .set({ revokedAt: input.revokedAt })
      .where(and(scope, isNull(apiKeys.revokedAt)))
      .returning();
    if (revoked) return { kind: 'revoked', key: toApiKeyRow(revoked) };

    // A concurrent first revoke can make the conditional update lose. Read
    // the same explicit scope again so the loser returns the one persisted
    // timestamp instead of overwriting it or inventing its own authority.
    const [existing] = await this.database.db.select().from(apiKeys).where(scope).limit(1);
    if (!existing) return { kind: 'not_found' };
    const key = toApiKeyRow(existing);
    if (key.revokedAt === null) {
      throw new Error('revokeApiKeyAtomic lost its update without a persisted revocation');
    }
    return { kind: 'already_revoked', key };
  }

  async setExpiresAt(id: string, expiresAt: Date): Promise<void> {
    await this.database.db.update(apiKeys).set({ expiresAt }).where(eq(apiKeys.id, id));
  }

  async rotateApiKeyAtomic(input: RotateApiKeyInput): Promise<RotateApiKeyRepoResult> {
    return this.database.db.transaction(async (tx) => {
      const [locked] = await tx
        .select()
        .from(apiKeys)
        .where(and(eq(apiKeys.id, input.oldKeyId), eq(apiKeys.accountId, input.accountId)))
        .limit(1)
        .for('update');
      if (!locked) return { kind: 'not_found' };
      if (locked.revokedAt !== null) return { kind: 'revoked' };
      if (locked.expiresAt !== null && locked.expiresAt.getTime() <= input.now.getTime()) {
        return { kind: 'expired' };
      }

      const oldKey = toApiKeyRow(locked);

      // V-775 — rotation DE-ESCALATES. `rotate()`'s own comment has always said it "always
      // produces an ordinary customer API key", but the successor used to copy
      // `locked.scopes` verbatim, so a caller holding only `account_owner` could rotate a key
      // carrying `driftstack_internal_admin` and be handed a fresh plaintext with staff
      // authority — `create()` refuses exactly that (its ELEVATED_SCOPES guard), and rotate is
      // the second issuance path.
      //
      //   driftstack_internal_admin — dropped. Staff mint a staff key from a staff session;
      //     rotation must not launder one.
      //   admin (legacy alias)      — replaced by `account_owner`, not merely dropped. Per
      //     docs/operations/admin-scope-mitigation.md the alias grants `account_owner` plus the
      //     customer `admin:*` checks, and `account_owner` satisfies both — so the successor
      //     keeps identical CUSTOMER authority while shedding the alias. That doc also states
      //     the enum can only be retired once stored legacy keys are "rotated or revoked", so
      //     retiring it here is the documented path rather than a new policy.
      //
      // Computed from the FOR UPDATE-locked row inside this transaction, so it cannot race a
      // concurrent scope change the way a pre-read in the service layer would.
      const successorScopes = [
        ...new Set(
          locked.scopes.flatMap((scope) =>
            scope === 'driftstack_internal_admin'
              ? []
              : scope === 'admin'
                ? (['account_owner'] as const)
                : [scope],
          ),
        ),
      ];

      const candidateGraceEnd = new Date(input.now.getTime() + input.gracePeriodMs);
      const gracePeriodEndsAt =
        locked.expiresAt !== null && locked.expiresAt < candidateGraceEnd
          ? locked.expiresAt
          : candidateGraceEnd;
      const [inserted] = await tx
        .insert(apiKeys)
        .values({
          accountId: locked.accountId,
          name: input.name ?? locked.name,
          scopes: successorScopes,
          keyPrefix: input.keyPrefix,
          keyHash: input.keyHash,
          expiresAt: locked.expiresAt,
          provenance: null,
          // V-775 — carry the minter forward. Omitting this landed NULL, and BOTH
          // minter-attributed reclaims filter on this column: team offboarding
          // (team-members-repo.ts) and the staff termination sweep (:44 below). A rotated key
          // therefore survived removal of the member who minted it, with the same authority
          // and no expiry. Rotation must not launder attribution.
          createdByAccountId: locked.createdByAccountId,
        })
        .returning();
      if (!inserted) throw new Error('rotateApiKeyAtomic insert returned no row');
      await tx
        .update(apiKeys)
        .set({ expiresAt: gracePeriodEndsAt })
        .where(eq(apiKeys.id, locked.id));
      return {
        kind: 'rotated',
        oldKey,
        newRow: toApiKeyRow(inserted),
        gracePeriodEndsAt,
      };
    });
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
        .where(
          opts.accountId === undefined
            ? eq(apiKeys.id, opts.cursor)
            : and(eq(apiKeys.id, opts.cursor), eq(apiKeys.accountId, opts.accountId)),
        )
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
