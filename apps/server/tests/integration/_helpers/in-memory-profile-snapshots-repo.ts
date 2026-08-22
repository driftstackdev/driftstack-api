// V-312 — in-memory ProfileSnapshotsRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  ListSnapshotsArgs,
  ListSnapshotsPage,
  NewSnapshotInput,
  ProfileSnapshotRecord,
  ProfileSnapshotsRepo,
} from '../../../src/services/profile-snapshots.js';
import { keysetPage } from './keyset-page.js';
import {
  SNAPSHOT_PAGE_DEFAULT,
  SNAPSHOT_PAGE_MAX,
} from '../../../src/db/profile-snapshots-repo.js';

/**
 * Ascending `(createdAt, id)`. The previous sort compared ids with `localeCompare`; this
 * uses plain byte order, which is what Postgres compares uuids by, and the keyset
 * boundary derives from the same function so the two cannot drift apart.
 */
function compareSnapshotKey(
  a: { createdAt: Date; id: string },
  b: { createdAt: Date; id: string },
) {
  const t = a.createdAt.getTime() - b.createdAt.getTime();
  if (t !== 0) return t;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export class InMemoryProfileSnapshotsRepo implements ProfileSnapshotsRepo {
  private readonly rows = new Map<string, ProfileSnapshotRecord>();

  insert(input: NewSnapshotInput): Promise<ProfileSnapshotRecord> {
    const now = new Date();
    const row: ProfileSnapshotRecord = {
      id: randomUUID(),
      accountId: input.accountId,
      parentProfileId: input.parentProfileId,
      label: input.label,
      description: input.description,
      parentArchetype: input.parentArchetype,
      parentName: input.parentName,
      stateBlob: input.stateBlob,
      capturedAt: now,
      createdAt: now,
    };
    this.rows.set(row.id, row);
    return Promise.resolve(row);
  }

  list(args: ListSnapshotsArgs): Promise<ListSnapshotsPage> {
    // V-1246 — read from DrizzleProfileSnapshotsRepo rather than restated. It used to be
    // `Math.min(args.limit ?? 50, 100)`: the same two numbers on both sides, agreeing only
    // until one of them moved.
    const limit = Math.min(args.limit ?? SNAPSHOT_PAGE_DEFAULT, SNAPSHOT_PAGE_MAX);
    // V-1243 — keyset via the shared helper. Resolving the cursor with findIndex inside
    // the parentProfileId-filtered array returns -1 whenever the caller pages with a
    // different drill-down than the one that issued the cursor, and the slice read that
    // as "start from the top".
    const scoped = Array.from(this.rows.values())
      .filter((r) => r.accountId === args.accountId)
      .sort((a, b) => -compareSnapshotKey(a, b));
    const candidates =
      args.parentProfileId === undefined
        ? scoped
        : scoped.filter((r) => r.parentProfileId === args.parentProfileId);

    const page = keysetPage({
      // Account-scoped only, matching the Drizzle anchor lookup's
      // `and(eq(id, cursor), eq(accountId, args.accountId))` — the scoping that repo
      // added deliberately, so a forged cross-account cursor cannot mis-position the
      // page or answer whether a snapshot id exists.
      anchorSet: scoped,
      rows: candidates,
      cursor: args.cursor,
      limit,
      id: (r) => r.id,
      at: (r) => r.createdAt,
    });
    return Promise.resolve({
      data: page.items,
      hasMore: page.hasMore,
      nextCursor: page.nextCursor,
    });
  }

  findById(args: { id: string; accountId: string }): Promise<ProfileSnapshotRecord | null> {
    const r = this.rows.get(args.id);
    if (!r) return Promise.resolve(null);
    if (r.accountId !== args.accountId) return Promise.resolve(null);
    return Promise.resolve({ ...r });
  }

  delete(args: { id: string; accountId: string }): Promise<boolean> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve(false);
    this.rows.delete(args.id);
    return Promise.resolve(true);
  }
}
