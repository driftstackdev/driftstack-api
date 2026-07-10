// In-memory ProfilesRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  ListProfilesArgs,
  ListProfilesPage,
  NewProfileInput,
  ProfileRecord,
  ProfileUpdates,
  ProfilesRepo,
} from '../../../src/services/profiles.js';

export class InMemoryProfilesRepo implements ProfilesRepo {
  // L4b — rows carry deletedAt (NULL = live, Date = trashed), mirroring the
  // prod deletedAt column: trashed rows are skipped by every customer-facing
  // read path (count/find/list/name-lookup) and can't be updated/touched, but
  // the row survives (recycle bin) for listTrashed/restore until a purge.
  private readonly rows = new Map<string, ProfileRecord>();

  insert(input: NewProfileInput): Promise<ProfileRecord> {
    const now = new Date();
    const row: ProfileRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      name: input.name,
      archetype: input.archetype,
      description: input.description,
      folder: input.folder ?? null,
      tags: input.tags ?? [],
      icon: input.icon ?? null,
      note: input.note ?? null,
      lastUsedAt: null,
      sizeBytes: null,
      lastSavedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  countByAccount(accountId: string): Promise<number> {
    let n = 0;
    for (const r of this.rows.values())
      if (r.accountId === accountId && r.deletedAt === null) n += 1;
    return Promise.resolve(n);
  }

  // doc-150 item 6 — sum of size_bytes over the account's LIVE profiles
  // (deletedAt === null, matching the prod COALESCE(sum) + notDeleted filter).
  // A NULL/never-saved size contributes 0.
  sumSizeBytesByAccount(accountId: string): Promise<number> {
    let total = 0;
    for (const r of this.rows.values())
      if (r.accountId === accountId && r.deletedAt === null && typeof r.sizeBytes === 'number')
        total += r.sizeBytes;
    return Promise.resolve(total);
  }

  // V-714 — atomic limit-check + insert. The prod Drizzle repo serialises this
  // via a `FOR UPDATE` lock on the accounts row; here the count + insert run
  // synchronously (JS single-thread → no interleave), which models the same
  // "loser sees the post-insert count and is refused" outcome.
  insertWithLimit(
    input: NewProfileInput,
    limit: number | null,
  ): Promise<{ record: ProfileRecord } | { limitExceeded: true; current: number }> {
    if (limit !== null) {
      let current = 0;
      // Anti-abuse: count LIVE + TRASHED against the cap (mirrors prod
      // insertWithLimit — trashed rows still occupy a slot until purged).
      for (const r of this.rows.values()) if (r.accountId === input.accountId) current += 1;
      if (current >= limit) {
        return Promise.resolve({ limitExceeded: true as const, current });
      }
    }
    const now = new Date();
    const row: ProfileRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      name: input.name,
      archetype: input.archetype,
      description: input.description,
      folder: input.folder ?? null,
      tags: input.tags ?? [],
      icon: input.icon ?? null,
      note: input.note ?? null,
      lastUsedAt: null,
      sizeBytes: null,
      lastSavedAt: null,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
    };
    this.rows.set(row.id, row);
    return Promise.resolve({ record: row });
  }

  findById(args: { id: string; accountId: string }): Promise<ProfileRecord | null> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId || r.deletedAt !== null) return Promise.resolve(null);
    return Promise.resolve(r);
  }

  // In-memory repo doesn't track per-profile DEKs (DEK dispatch is exercised by
  // the unit test's dedicated mock); null keeps the interface satisfied.
  getWrappedDek(_args: { id: string; accountId: string }): Promise<string | null> {
    return Promise.resolve(null);
  }

  findByAccountAndName(args: { accountId: string; name: string }): Promise<ProfileRecord | null> {
    for (const r of this.rows.values()) {
      if (r.accountId === args.accountId && r.name === args.name && r.deletedAt === null)
        return Promise.resolve(r);
    }
    return Promise.resolve(null);
  }

  list(args: ListProfilesArgs): Promise<ListProfilesPage> {
    const limit = Math.min(args.limit ?? 50, 100);
    // FIX 3 — resolve the cursor keyset POSITION against the account's full
    // ordered set (live + trashed), mirroring the prod repo dropping the
    // notDeleted filter on the cursor-anchor lookup. The cursor id is the prior
    // page's last profile, which may have been soft-deleted/restored between
    // page fetches; resolving it against the live-only set would miss a trashed
    // boundary → startIdx 0 → page 1 returned again (a pagination loop). The
    // notDeleted filter still applies to the RESULT set below.
    const ordered = Array.from(this.rows.values())
      .filter((r) => r.accountId === args.accountId)
      .sort((a, b) => {
        const t = b.createdAt.getTime() - a.createdAt.getTime();
        return t !== 0 ? t : b.id.localeCompare(a.id);
      });

    let anchor: { createdAt: Date; id: string } | undefined;
    if (args.cursor !== undefined) {
      const c = ordered.find((r) => r.id === args.cursor);
      if (c !== undefined) anchor = { createdAt: c.createdAt, id: c.id };
    }

    const live = ordered.filter((r) => r.deletedAt === null);
    let afterAnchor = live;
    if (anchor !== undefined) {
      const at = anchor;
      afterAnchor = live.filter(
        (r) =>
          r.createdAt.getTime() < at.createdAt.getTime() ||
          (r.createdAt.getTime() === at.createdAt.getTime() && r.id.localeCompare(at.id) < 0),
      );
    }

    const slice = afterAnchor.slice(0, limit + 1);
    const hasMore = slice.length > limit;
    const data = slice.slice(0, limit);
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return Promise.resolve({ data, hasMore, nextCursor });
  }

  update(args: { id: string; accountId: string; updates: ProfileUpdates }): Promise<ProfileRecord> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId || r.deletedAt !== null) {
      return Promise.reject(new Error('update: row not found / wrong account'));
    }
    const next: ProfileRecord = {
      ...r,
      name: args.updates.name ?? r.name,
      description:
        args.updates.description !== undefined ? args.updates.description : r.description,
      folder: args.updates.folder !== undefined ? args.updates.folder : r.folder,
      tags: args.updates.tags !== undefined ? args.updates.tags : r.tags,
      updatedAt: new Date(),
    };
    this.rows.set(r.id, next);
    return Promise.resolve(next);
  }

  // L4b soft delete — set deletedAt (idempotent: re-deleting a trashed row is a
  // no-op). The row stays in the map so it survives until purge.
  delete(args: { id: string; accountId: string }): Promise<boolean> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId || r.deletedAt !== null) return Promise.resolve(false);
    this.rows.set(r.id, { ...r, deletedAt: new Date() });
    return Promise.resolve(true);
  }

  touch(args: { id: string; accountId: string; at: Date }): Promise<void> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId || r.deletedAt !== null) return Promise.resolve();
    this.rows.set(r.id, { ...r, lastUsedAt: args.at });
    return Promise.resolve();
  }

  // doc-150 item 5 — stamp last_saved_at (+ size_bytes when provided). Mirrors
  // the prod recordSave: account-scoped + notDeleted; a missing sizeBytes leaves
  // the column untouched (no clobber-with-NULL).
  recordSave(args: { id: string; accountId: string; at: Date; sizeBytes?: number }): Promise<void> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId || r.deletedAt !== null) return Promise.resolve();
    this.rows.set(r.id, {
      ...r,
      lastSavedAt: args.at,
      sizeBytes: args.sizeBytes !== undefined ? args.sizeBytes : r.sizeBytes,
    });
    return Promise.resolve();
  }

  // L4b — trashed rows only, most-recently trashed first (matches the prod
  // orderBy(desc(deletedAt), desc(id))).
  listTrashed(args: { accountId: string }): Promise<ProfileRecord[]> {
    const trashed = Array.from(this.rows.values())
      .filter((r) => r.accountId === args.accountId && r.deletedAt !== null)
      .sort((a, b) => {
        const t = b.deletedAt!.getTime() - a.deletedAt!.getTime();
        return t !== 0 ? t : b.id.localeCompare(a.id);
      });
    return Promise.resolve(trashed);
  }

  // L4b — restore (clear deletedAt). 'not_found' if no trashed row matches;
  // 'name_conflict' if a LIVE profile already holds the name.
  restore(args: {
    id: string;
    accountId: string;
  }): Promise<'restored' | 'not_found' | 'name_conflict'> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId || r.deletedAt === null) {
      return Promise.resolve('not_found');
    }
    for (const other of this.rows.values()) {
      if (other.accountId === args.accountId && other.name === r.name && other.deletedAt === null) {
        return Promise.resolve('name_conflict');
      }
    }
    this.rows.set(r.id, { ...r, deletedAt: null, updatedAt: new Date() });
    return Promise.resolve('restored');
  }

  // L4b Step 4 — hard-delete trashed rows older than cutoff (mirrors the prod
  // DELETE WHERE deletedAt IS NOT NULL AND deletedAt < cutoff).
  purgeTrashedBefore(cutoff: Date): Promise<string[]> {
    const purgedIds: string[] = [];
    for (const [id, r] of this.rows) {
      if (r.deletedAt !== null && r.deletedAt.getTime() < cutoff.getTime()) {
        this.rows.delete(id);
        purgedIds.push(id);
      }
    }
    return Promise.resolve(purgedIds);
  }

  purgeTrashed(args: { id: string; accountId: string }): Promise<boolean> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId || r.deletedAt === null) return Promise.resolve(false);
    this.rows.delete(args.id);
    return Promise.resolve(true);
  }

  // #158 — which of `ids` still have a row (any account, INCLUDING trashed).
  // A trashed row stays in the map until purgeTrashed(Before) hard-deletes it,
  // so this.rows.has() correctly counts trashed profiles as "existing" (their
  // blob must survive) and only a hard-purged id is absent (a true orphan).
  findExistingProfileIds(ids: string[]): Promise<Set<string>> {
    const found = new Set<string>();
    for (const id of ids) if (this.rows.has(id)) found.add(id);
    return Promise.resolve(found);
  }
}
