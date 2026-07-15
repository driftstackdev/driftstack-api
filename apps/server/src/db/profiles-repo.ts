// Drizzle-backed ProfilesRepo (V-081).

import { and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql } from 'drizzle-orm';
import { isUniqueViolation } from '../lib/pg-error.js';
import { StorageQuotaExceededError } from '../lib/errors.js';
import type {
  ListProfilesArgs,
  ListProfilesPage,
  NewProfileInput,
  ProfileRecord,
  ProfileUpdates,
  ProfilesRepo,
} from '../services/profiles.js';
// #2 (2026-06-30) — the SAME pure cap-vs-usage math the create-time hard gate
// uses (assertWithinStorageQuotaForLaunch -> computeAccountStorageState),
// reused here so restore() enforces an identical rule instead of a
// hand-duplicated threshold that could drift from it.
import { computeAccountStorageState } from '../services/profile-storage-quota.js';
import type { Database } from './client.js';
import { accounts, profiles } from './schema.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';
import {
  PROFILE_DEK_V2_PREFIX,
  unwrapLegacyProfileDek,
  unwrapProfileDek,
  wrapProfileDek,
} from '../lib/profile-key-hierarchy.js';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;
const MAX_PROFILE_DEK_MIGRATION_BATCH = 500;

// L4b recycle bin — every customer-facing read path excludes soft-deleted
// (trashed) profiles: they don't count against the cap, can't be found,
// listed, name-matched, or have their DEK unwrapped. Only the dedicated
// recycle-bin / restore / purge paths look at trashed rows. `delete()` here
// is a soft delete (sets deletedAt); a hard row removal happens at purge.
const notDeleted = isNull(profiles.deletedAt);

function profileDekIsLegacy() {
  return sql`${profiles.wrappedDek} IS NOT NULL
    AND ${profiles.wrappedDek} NOT LIKE ${`${PROFILE_DEK_V2_PREFIX}%`}`;
}

function profileDekIsV2() {
  return sql`${profiles.wrappedDek} LIKE ${`${PROFILE_DEK_V2_PREFIX}%`}`;
}

function preallocatedProfileId(input: NewProfileInput): { id?: string } {
  if (input.wrappedDek != null && input.id === undefined) {
    throw new Error('a profile with a wrapped DEK requires a preallocated id');
  }
  return input.id === undefined ? {} : { id: input.id };
}

function toRecord(r: typeof profiles.$inferSelect): ProfileRecord {
  return {
    id: r.id,
    accountId: r.accountId,
    name: r.name,
    archetype: r.archetype,
    description: r.description,
    folder: r.folder,
    tags: r.tags,
    icon: r.icon,
    note: r.note,
    lastUsedAt: r.lastUsedAt,
    sizeBytes: r.sizeBytes,
    lastSavedAt: r.lastSavedAt,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    deletedAt: r.deletedAt,
  };
}

export class DrizzleProfilesRepo implements ProfilesRepo {
  constructor(private readonly database: Database) {}

  /**
   * Bootstrap-only no-DDL conversion from account-only legacy DEK wrappers to
   * purpose/account/profile-bound v2. The complete page authenticates before
   * its first write; each update exact-CASes the old record tuple.
   */
  async migrateWrappedDekEnvelopes(
    masterKey: Buffer,
    limit = MAX_PROFILE_DEK_MIGRATION_BATCH,
  ): Promise<{ scanned: number; converted: number; remaining: number }> {
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PROFILE_DEK_MIGRATION_BATCH) {
      throw new Error(
        `Profile DEK migration limit must be an integer from 1 to ${MAX_PROFILE_DEK_MIGRATION_BATCH.toString()}.`,
      );
    }

    // Authenticate one already-bound row before considering legacy data. A
    // wrong operator master key therefore fails without rewriting anything,
    // including on successor boots after the legacy set has drained to zero.
    const [v2Probe] = await this.database.db
      .select({ id: profiles.id, accountId: profiles.accountId, wrappedDek: profiles.wrappedDek })
      .from(profiles)
      .where(profileDekIsV2())
      .orderBy(asc(profiles.id))
      .limit(1);
    if (v2Probe !== undefined) {
      if (v2Probe.wrappedDek === null) {
        throw new Error(`Profile ${v2Probe.id} has an incomplete wrapped DEK.`);
      }
      unwrapProfileDek(masterKey, v2Probe.accountId, v2Probe.id, v2Probe.wrappedDek);
    }

    const rows = await this.database.db
      .select({ id: profiles.id, accountId: profiles.accountId, wrappedDek: profiles.wrappedDek })
      .from(profiles)
      .where(profileDekIsLegacy())
      .orderBy(asc(profiles.id))
      .limit(limit);

    // Decode and authenticate every legacy wrapper before the first UPDATE.
    // Wrong key, malformed base64 or wrong-length plaintext leaves the whole
    // selected page byte-for-byte intact.
    const prepared = rows.map((row) => {
      if (row.wrappedDek === null) {
        throw new Error(`Profile ${row.id} has an incomplete wrapped DEK.`);
      }
      const dek = unwrapLegacyProfileDek(masterKey, row.accountId, row.wrappedDek);
      return {
        ...row,
        wrappedDek: row.wrappedDek,
        next: wrapProfileDek(masterKey, row.accountId, row.id, dek),
      };
    });

    let converted = 0;
    for (const row of prepared) {
      const updated = await this.database.db
        .update(profiles)
        .set({
          wrappedDek: row.next,
          // Deliberately preserve updatedAt: rewrapping does not mutate profile
          // metadata, customer revision state or sealed R2 blob contents.
        })
        .where(
          and(
            eq(profiles.id, row.id),
            eq(profiles.accountId, row.accountId),
            eq(profiles.wrappedDek, row.wrappedDek),
          ),
        )
        .returning({ id: profiles.id });
      if (updated.length === 1) converted += 1;
    }

    const [remainingRow] = await this.database.db
      .select({ value: count() })
      .from(profiles)
      .where(profileDekIsLegacy());
    return { scanned: rows.length, converted, remaining: remainingRow?.value ?? 0 };
  }

  async insert(input: NewProfileInput): Promise<ProfileRecord> {
    const [row] = await this.database.db
      .insert(profiles)
      .values({
        ...preallocatedProfileId(input),
        accountId: input.accountId,
        name: input.name,
        archetype: input.archetype,
        description: input.description,
        folder: input.folder ?? null,
        tags: input.tags ?? [],
        icon: input.icon ?? null,
        note: input.note ?? null,
        wrappedDek: input.wrappedDek ?? null,
      })
      .returning();
    if (!row) throw new Error('insert profile: no row returned');
    return toRecord(row);
  }

  async countByAccount(accountId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ n: count() })
      .from(profiles)
      .where(and(eq(profiles.accountId, accountId), notDeleted));
    return row?.n ?? 0;
  }

  // doc-150 item 6 — sum of size_bytes (COALESCE NULL→0) over the account's
  // LIVE profiles (notDeleted, same filter as countByAccount/list — trashed
  // profiles don't count toward the storage quota, mirroring the live read
  // paths). The ::bigint cast keeps the SUM exact for large totals; we read it
  // back as a string and Number()-parse (account storage caps top out at
  // 500 GiB ≈ 5.4e11, well inside Number's 2^53 safe-integer range).
  async sumSizeBytesByAccount(accountId: string): Promise<number> {
    const [row] = await this.database.db
      .select({ total: sql<string>`coalesce(sum(${profiles.sizeBytes}), 0)::bigint` })
      .from(profiles)
      .where(and(eq(profiles.accountId, accountId), notDeleted));
    return row ? Number(row.total) : 0;
  }

  // V-714 — atomic tier-limit check + insert. The plain count-then-insert in
  // the service is a TOCTOU: N concurrent creates all read count < limit, all
  // insert, and the per-tier profile cap (free = 1) is exceeded. Here the
  // count + insert run inside ONE transaction under a `FOR UPDATE` lock on the
  // owning accounts row, so concurrent creates for the same account serialize
  // — the loser reads the post-insert count and is refused. Mirrors
  // stripe-webhooks-repo.setAccountTier's lock idiom; locks the accounts row
  // FIRST (consistent ordering with every other account-row-locking txn →
  // deadlock-safe; nothing locks profiles-then-accounts). `limit === null` is
  // an unmetered tier → no lock/count needed, just insert.
  async insertWithLimit(
    input: NewProfileInput,
    limit: number | null,
  ): Promise<{ record: ProfileRecord } | { limitExceeded: true; current: number }> {
    return this.database.db.transaction(async (tx) => {
      if (limit !== null) {
        await tx
          .select({ id: accounts.id })
          .from(accounts)
          .where(eq(accounts.id, input.accountId))
          .for('update')
          .limit(1);
        // Anti-abuse (2026-06-17): count LIVE + TRASHED against the cap (no
        // notDeleted filter). Trashed profiles still hold a row + DEK + sealed
        // blob until purge, so excluding them let a low-tier user trash+recreate
        // to hoard unbounded recoverable profiles past their limit. The cap now
        // bounds TOTAL stored profiles; the user frees space via the manual purge
        // (DELETE /:id/purge) or the 30-day auto-purge. Read/list paths stay
        // notDeleted (trashed remain hidden from the live grid).
        const [c] = await tx
          .select({ n: count() })
          .from(profiles)
          .where(eq(profiles.accountId, input.accountId));
        const current = c?.n ?? 0;
        if (current >= limit) {
          return { limitExceeded: true as const, current };
        }
      }
      const [row] = await tx
        .insert(profiles)
        .values({
          ...preallocatedProfileId(input),
          accountId: input.accountId,
          name: input.name,
          archetype: input.archetype,
          description: input.description,
          folder: input.folder ?? null,
          tags: input.tags ?? [],
          icon: input.icon ?? null,
          note: input.note ?? null,
          wrappedDek: input.wrappedDek ?? null,
        })
        .returning();
      if (!row) throw new Error('insertWithLimit profile: no row returned');
      return { record: toRecord(row) };
    });
  }

  async findById(args: { id: string; accountId: string }): Promise<ProfileRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId), notDeleted))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  // file 57: account-scoped read of ONLY the wrapped DEK (kept off ProfileRecord
  // so the secret never rides a customer-facing record).
  async getWrappedDek(args: { id: string; accountId: string }): Promise<string | null> {
    const [row] = await this.database.db
      .select({ wrappedDek: profiles.wrappedDek })
      .from(profiles)
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId), notDeleted))
      .limit(1);
    return row?.wrappedDek ?? null;
  }

  async findByAccountAndName(args: {
    accountId: string;
    name: string;
  }): Promise<ProfileRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.accountId, args.accountId), eq(profiles.name, args.name), notDeleted))
      .limit(1);
    return row ? toRecord(row) : null;
  }

  async list(args: ListProfilesArgs): Promise<ListProfilesPage> {
    const limit = Math.min(args.limit ?? DEFAULT_PAGE, MAX_PAGE);

    // A supplied cursor is a keyset POSITION on (created_at desc, id desc). We
    // resolve the anchor row WITHOUT the notDeleted filter: the cursor id is the
    // PRIOR page's last profile, and that profile may have been soft-deleted (or
    // restored) between page fetches. If we required it to still be live, a
    // trashed boundary would make cursorRow undefined → cursorWhere undefined →
    // the query would silently return PAGE 1 again (with a non-null next_cursor
    // → a pagination loop / skipped rows). The anchor's (created_at, id) keyset
    // position is well-defined whether or not the row is currently live, so the
    // page after a stale boundary still advances correctly. The notDeleted
    // filter still applies to the RESULT set below — trashed rows never appear.
    let cursorWhere;
    if (args.cursor !== undefined && parseUuidCursor(args.cursor) !== undefined) {
      const [cursorRow] = await this.database.db
        .select({ createdAt: profiles.createdAt, id: profiles.id })
        .from(profiles)
        .where(and(eq(profiles.id, args.cursor), eq(profiles.accountId, args.accountId)))
        .limit(1);
      if (cursorRow !== undefined) {
        cursorWhere = or(
          lt(profiles.createdAt, cursorRow.createdAt),
          and(eq(profiles.createdAt, cursorRow.createdAt), lt(profiles.id, cursorRow.id)),
        );
      }
    }

    const rows = await this.database.db
      .select()
      .from(profiles)
      .where(
        cursorWhere !== undefined
          ? and(eq(profiles.accountId, args.accountId), notDeleted, cursorWhere)
          : and(eq(profiles.accountId, args.accountId), notDeleted),
      )
      .orderBy(desc(profiles.createdAt), desc(profiles.id))
      .limit(limit + 1);

    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(toRecord);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;

    return { data, hasMore, nextCursor };
  }

  async update(args: {
    id: string;
    accountId: string;
    updates: ProfileUpdates;
  }): Promise<ProfileRecord> {
    const sets: Record<string, unknown> = { updatedAt: new Date() };
    if (args.updates.name !== undefined) sets.name = args.updates.name;
    if (args.updates.description !== undefined) sets.description = args.updates.description;
    if (args.updates.folder !== undefined) sets.folder = args.updates.folder;
    if (args.updates.tags !== undefined) sets.tags = args.updates.tags;
    if (args.updates.icon !== undefined) sets.icon = args.updates.icon;
    if (args.updates.note !== undefined) sets.note = args.updates.note;

    const [row] = await this.database.db
      .update(profiles)
      .set(sets)
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId), notDeleted))
      .returning();
    if (!row) throw new Error('update profile: no row returned');
    return toRecord(row);
  }

  // L4b — soft delete: mark the profile trashed (recycle bin) instead of
  // removing the row, so it can be restored and its DEK survives until purge.
  // notDeleted guard makes this idempotent — re-deleting a trashed profile is
  // a no-op (returns false) and never overwrites the original trash time.
  async delete(args: { id: string; accountId: string }): Promise<boolean> {
    const now = new Date();
    const result = await this.database.db
      .update(profiles)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId), notDeleted))
      .returning({ id: profiles.id });
    return result.length > 0;
  }

  async touch(args: { id: string; accountId: string; at: Date }): Promise<void> {
    await this.database.db
      .update(profiles)
      .set({ lastUsedAt: args.at })
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId), notDeleted));
  }

  // doc-150 item 5 — record a sealed-store save-back. Fire-and-forget from the
  // profileSaved consumer: stamp last_saved_at = now() and (when the harness
  // emitted it) the sealed-store byte size. `sizeBytes` undefined → leave the
  // column untouched (a pre-emit harness must not clobber a known size with
  // NULL); a missing size on this save just keeps the prior value. Account-
  // scoped + notDeleted like touch() — a no-op for a wrong-account / trashed id.
  async recordSave(args: {
    id: string;
    accountId: string;
    at: Date;
    sizeBytes?: number;
  }): Promise<void> {
    const sets: Record<string, unknown> = { lastSavedAt: args.at };
    if (args.sizeBytes !== undefined) sets.sizeBytes = args.sizeBytes;
    await this.database.db
      .update(profiles)
      .set(sets)
      .where(and(eq(profiles.id, args.id), eq(profiles.accountId, args.accountId), notDeleted));
  }

  // L4b recycle bin — inverse of the live read paths: ONLY trashed rows
  // (deletedAt IS NOT NULL), most-recently trashed first so the newest deletions
  // surface at the top of the Trash view.
  async listTrashed(args: { accountId: string }): Promise<ProfileRecord[]> {
    const rows = await this.database.db
      .select()
      .from(profiles)
      .where(and(eq(profiles.accountId, args.accountId), isNotNull(profiles.deletedAt)))
      .orderBy(desc(profiles.deletedAt), desc(profiles.id));
    return rows.map(toRecord);
  }

  // L4b — restore (clear deletedAt). 'not_found' if no trashed row matches;
  // 'name_conflict' if a LIVE profile already holds the name (freed + reused
  // while trashed) — caught both by a pre-check and by the partial-unique-index
  // 23505 (the pre-check→update window is not atomic, so the catch is the real
  // guard; the pre-check just gives the common case a query-cheap answer).
  async restore(args: {
    id: string;
    accountId: string;
  }): Promise<'restored' | 'not_found' | 'name_conflict'> {
    return this.database.db.transaction(async (tx) => {
      const [trashed] = await tx
        .select({ name: profiles.name, sizeBytes: profiles.sizeBytes })
        .from(profiles)
        .where(
          and(
            eq(profiles.id, args.id),
            eq(profiles.accountId, args.accountId),
            isNotNull(profiles.deletedAt),
          ),
        )
        .limit(1);
      if (trashed === undefined) return 'not_found';

      const [liveSameName] = await tx
        .select({ id: profiles.id })
        .from(profiles)
        .where(
          and(eq(profiles.accountId, args.accountId), eq(profiles.name, trashed.name), notDeleted),
        )
        .limit(1);
      if (liveSameName !== undefined) return 'name_conflict';

      // #2 (2026-06-30) anti-abuse — re-validate the account's storage cap
      // BEFORE un-trashing, mirroring the create-time hard gate
      // (assertWithinStorageQuotaForLaunch). sumSizeBytesByAccount /
      // countByAccount only ever summed LIVE rows, so a customer at the cap
      // could soft-delete a large profile to instantly free reported quota
      // (the real R2 bytes are untouched by a soft delete) and bring the
      // exact same bytes back later via restore with zero re-check — a
      // trash+restore round-trip silently bypassed the hard cap for the
      // entire 30-day trash retention window. `FOR UPDATE` on the owning
      // account row serializes this against a concurrent insertWithLimit (or
      // another restore) on the same account — same lock-ordering convention
      // as insertWithLimit above (accounts row locked first). A missing
      // account row (shouldn't happen — profiles FK to accounts) skips the
      // check rather than blocking the restore on unrelated data.
      const [account] = await tx
        .select({ tier: accounts.tier })
        .from(accounts)
        .where(eq(accounts.id, args.accountId))
        .for('update')
        .limit(1);
      if (account !== undefined) {
        const [sumRow] = await tx
          .select({ total: sql<string>`coalesce(sum(${profiles.sizeBytes}), 0)::bigint` })
          .from(profiles)
          .where(and(eq(profiles.accountId, args.accountId), notDeleted));
        const liveUsedBytes = sumRow ? Number(sumRow.total) : 0;
        const projectedUsedBytes = liveUsedBytes + (trashed.sizeBytes ?? 0);
        const state = computeAccountStorageState({
          usedBytes: projectedUsedBytes,
          tier: account.tier,
        });
        if (state.state === 'hard') {
          throw new StorageQuotaExceededError({
            usedBytes: state.usedBytes,
            capBytes: state.capBytes,
            tier: account.tier,
          });
        }
      }

      try {
        const result = await tx
          .update(profiles)
          .set({ deletedAt: null, updatedAt: new Date() })
          .where(
            and(
              eq(profiles.id, args.id),
              eq(profiles.accountId, args.accountId),
              isNotNull(profiles.deletedAt),
            ),
          )
          .returning({ id: profiles.id });
        return result.length > 0 ? 'restored' : 'not_found';
      } catch (err) {
        if (isUniqueViolation(err, 'profiles_account_name_unique')) return 'name_conflict';
        throw err;
      }
    });
  }

  // L4b Step 4 — retention purge. The ONLY hard DELETE on profiles (delete()
  // is now soft). Scoped to trashed rows older than cutoff so a live profile
  // can never be reached: isNotNull(deletedAt) AND deletedAt < cutoff. Removing
  // the row also drops its wrapped DEK. Returns the purged IDs so the caller can
  // best-effort delete each profile's orphaned R2 sealed blob (count = .length).
  async purgeTrashedBefore(cutoff: Date): Promise<string[]> {
    const result = await this.database.db
      .delete(profiles)
      .where(and(isNotNull(profiles.deletedAt), lt(profiles.deletedAt, cutoff)))
      .returning({ id: profiles.id });
    return result.map((r) => r.id);
  }

  // #158 — which of `ids` still have a profiles row. Deliberately NOT filtered
  // by notDeleted or by account: a trashed (soft-deleted) profile still holds a
  // row + wrapped DEK + sealed blob until the retention purge hard-deletes it,
  // so its blob must survive; only a HARD-deleted row means the blob is a true
  // orphan. Single WHERE id IN (...) select of just the id column. An empty
  // input short-circuits (an empty IN () is a degenerate/invalid SQL clause).
  async findExistingProfileIds(ids: string[]): Promise<Set<string>> {
    if (ids.length === 0) return new Set<string>();
    const rows = await this.database.db
      .select({ id: profiles.id })
      .from(profiles)
      .where(inArray(profiles.id, ids));
    return new Set(rows.map((r) => r.id));
  }

  // Anti-abuse companion (2026-06-17) — user-initiated permanent delete of ONE
  // trashed profile, so a user at their cap can free a slot immediately (the cap
  // now counts trashed). Owner-scoped + trashed-only (isNotNull(deletedAt)) so a
  // LIVE profile or another account's row can never be hard-deleted here. Returns
  // true when a row was purged, false otherwise (not found / live / wrong owner).
  async purgeTrashed(args: { id: string; accountId: string }): Promise<boolean> {
    const result = await this.database.db
      .delete(profiles)
      .where(
        and(
          eq(profiles.id, args.id),
          eq(profiles.accountId, args.accountId),
          isNotNull(profiles.deletedAt),
        ),
      )
      .returning({ id: profiles.id });
    return result.length > 0;
  }
}
