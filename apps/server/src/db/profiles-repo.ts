// Drizzle-backed ProfilesRepo (V-081).

import { and, count, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import { isUniqueViolation } from '../lib/pg-error.js';
import type {
  ListProfilesArgs,
  ListProfilesPage,
  NewProfileInput,
  ProfileRecord,
  ProfileUpdates,
  ProfilesRepo,
} from '../services/profiles.js';
import type { Database } from './client.js';
import { accounts, profiles } from './schema.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';

const DEFAULT_PAGE = 50;
const MAX_PAGE = 100;

// L4b recycle bin — every customer-facing read path excludes soft-deleted
// (trashed) profiles: they don't count against the cap, can't be found,
// listed, name-matched, or have their DEK unwrapped. Only the dedicated
// recycle-bin / restore / purge paths look at trashed rows. `delete()` here
// is a soft delete (sets deletedAt); a hard row removal happens at purge.
const notDeleted = isNull(profiles.deletedAt);

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

  async insert(input: NewProfileInput): Promise<ProfileRecord> {
    const [row] = await this.database.db
      .insert(profiles)
      .values({
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

    let cursorWhere;
    if (args.cursor !== undefined && parseUuidCursor(args.cursor) !== undefined) {
      const [cursorRow] = await this.database.db
        .select({ createdAt: profiles.createdAt, id: profiles.id })
        .from(profiles)
        .where(
          and(eq(profiles.id, args.cursor), eq(profiles.accountId, args.accountId), notDeleted),
        )
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
    const [trashed] = await this.database.db
      .select({ name: profiles.name })
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

    const [liveSameName] = await this.database.db
      .select({ id: profiles.id })
      .from(profiles)
      .where(
        and(eq(profiles.accountId, args.accountId), eq(profiles.name, trashed.name), notDeleted),
      )
      .limit(1);
    if (liveSameName !== undefined) return 'name_conflict';

    try {
      const result = await this.database.db
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
  }

  // L4b Step 4 — retention purge. The ONLY hard DELETE on profiles (delete()
  // is now soft). Scoped to trashed rows older than cutoff so a live profile
  // can never be reached: isNotNull(deletedAt) AND deletedAt < cutoff. Removing
  // the row also drops its wrapped DEK. Returns the purged count.
  async purgeTrashedBefore(cutoff: Date): Promise<number> {
    const result = await this.database.db
      .delete(profiles)
      .where(and(isNotNull(profiles.deletedAt), lt(profiles.deletedAt, cutoff)))
      .returning({ id: profiles.id });
    return result.length;
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
