// V-312 — Drizzle implementation of ProfileSnapshotsRepo.

import { and, desc, eq, lt, or } from 'drizzle-orm';
import type {
  ListSnapshotsArgs,
  ListSnapshotsPage,
  NewSnapshotInput,
  ProfileSnapshotRecord,
  ProfileSnapshotsRepo,
} from '../services/profile-snapshots.js';
import type { Database } from './client.js';
import { profileSnapshots } from './schema.js';
import { parseUuidCursor } from '../lib/keyset-cursor.js';

function toRow(r: typeof profileSnapshots.$inferSelect): ProfileSnapshotRecord {
  return {
    id: r.id,
    accountId: r.accountId,
    parentProfileId: r.parentProfileId,
    label: r.label,
    description: r.description,
    parentArchetype: r.parentArchetype,
    parentName: r.parentName,
    stateBlob: (r.stateBlob ?? {}) as Record<string, unknown>,
    capturedAt: r.capturedAt,
    createdAt: r.createdAt,
  };
}

export class DrizzleProfileSnapshotsRepo implements ProfileSnapshotsRepo {
  constructor(private readonly database: Database) {}

  /**
   * Retention purge — hard-delete every snapshot belonging to an account
   * terminated before `cutoff`.
   *
   * Snapshots are NOT reached by purging profiles: `parent_profile_id` is ON
   * DELETE SET NULL, so a deleted profile leaves its snapshots behind with a
   * null parent. They carry the captured state inline in `state_blob`, so the
   * row IS the data and deleting it is the erasure — no blob store to chase.
   *
   * Same shape as the profile purge: the account predicate lives in SQL beside
   * the delete target so a caller cannot widen it.
   */
  async purgeForTerminatedAccountsBefore(cutoff: Date): Promise<number> {
    const rows = await this.database.client<Array<{ id: string }>>`
      DELETE FROM profile_snapshots s
      USING accounts a
      WHERE a.id = s.account_id
        AND a.status = 'deleted'
        AND a.deleted_at IS NOT NULL
        AND a.deleted_at < ${cutoff.toISOString()}::timestamptz
      RETURNING s.id`;
    return rows.length;
  }

  async insert(input: NewSnapshotInput): Promise<ProfileSnapshotRecord> {
    const [row] = await this.database.db
      .insert(profileSnapshots)
      .values({
        accountId: input.accountId,
        parentProfileId: input.parentProfileId,
        label: input.label,
        description: input.description,
        parentArchetype: input.parentArchetype,
        parentName: input.parentName,
        stateBlob: input.stateBlob,
      })
      .returning();
    if (!row) throw new Error('insert: no row returned');
    return toRow(row);
  }

  async list(args: ListSnapshotsArgs): Promise<ListSnapshotsPage> {
    const limit = Math.min(args.limit ?? 50, 100);
    const filters = [eq(profileSnapshots.accountId, args.accountId)];
    if (args.parentProfileId !== undefined) {
      filters.push(eq(profileSnapshots.parentProfileId, args.parentProfileId));
    }
    if (args.cursor !== undefined && parseUuidCursor(args.cursor) !== undefined) {
      const [c] = await this.database.db
        .select({
          createdAt: profileSnapshots.createdAt,
          id: profileSnapshots.id,
        })
        .from(profileSnapshots)
        // Scope the cursor-row lookup by accountId (matches profiles-repo /
        // sessions-repo + the in-memory mirror). Without it a forged
        // cross-account cursor resolves to another account's (createdAt,id),
        // mis-positioning the caller's own keyset page and leaking a weak
        // snapshot-id-exists oracle. The main query below is already
        // account-scoped, so this is the residual cursor-scoping gap.
        .where(
          and(eq(profileSnapshots.id, args.cursor), eq(profileSnapshots.accountId, args.accountId)),
        )
        .limit(1);
      if (c) {
        const cur = or(
          lt(profileSnapshots.createdAt, c.createdAt),
          and(eq(profileSnapshots.createdAt, c.createdAt), lt(profileSnapshots.id, c.id)),
        );
        if (cur !== undefined) filters.push(cur);
      }
    }
    const rows = await this.database.db
      .select()
      .from(profileSnapshots)
      .where(and(...filters))
      .orderBy(desc(profileSnapshots.createdAt), desc(profileSnapshots.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const data = rows.slice(0, limit).map(toRow);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return { data, hasMore, nextCursor };
  }

  async findById(args: { id: string; accountId: string }): Promise<ProfileSnapshotRecord | null> {
    const [row] = await this.database.db
      .select()
      .from(profileSnapshots)
      .where(and(eq(profileSnapshots.id, args.id), eq(profileSnapshots.accountId, args.accountId)))
      .limit(1);
    return row ? toRow(row) : null;
  }

  async delete(args: { id: string; accountId: string }): Promise<boolean> {
    const rows = await this.database.db
      .delete(profileSnapshots)
      .where(and(eq(profileSnapshots.id, args.id), eq(profileSnapshots.accountId, args.accountId)))
      .returning({ id: profileSnapshots.id });
    return rows.length > 0;
  }
}
