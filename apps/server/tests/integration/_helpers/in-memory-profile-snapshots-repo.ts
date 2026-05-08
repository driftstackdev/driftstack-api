// V-312 — in-memory ProfileSnapshotsRepo for integration tests.

import { randomUUID } from 'node:crypto';
import type {
  ListSnapshotsArgs,
  ListSnapshotsPage,
  NewSnapshotInput,
  ProfileSnapshotRecord,
  ProfileSnapshotsRepo,
} from '../../../src/services/profile-snapshots.js';

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
    const limit = Math.min(args.limit ?? 50, 100);
    let candidates = Array.from(this.rows.values()).filter((r) => r.accountId === args.accountId);
    if (args.parentProfileId !== undefined) {
      candidates = candidates.filter((r) => r.parentProfileId === args.parentProfileId);
    }
    candidates.sort((a, b) => {
      const t = b.createdAt.getTime() - a.createdAt.getTime();
      if (t !== 0) return t;
      return b.id.localeCompare(a.id);
    });
    if (args.cursor !== undefined) {
      const cIdx = candidates.findIndex((r) => r.id === args.cursor);
      if (cIdx >= 0) candidates = candidates.slice(cIdx + 1);
    }
    const data = candidates.slice(0, limit);
    const hasMore = candidates.length > limit;
    const nextCursor = hasMore && data.length > 0 ? data[data.length - 1]!.id : null;
    return Promise.resolve({ data, hasMore, nextCursor });
  }

  findById(args: { id: string; accountId: string }): Promise<ProfileSnapshotRecord | null> {
    const r = this.rows.get(args.id);
    if (!r) return Promise.resolve(null);
    if (r.accountId !== args.accountId) return Promise.resolve(null);
    return Promise.resolve(r);
  }

  delete(args: { id: string; accountId: string }): Promise<boolean> {
    const r = this.rows.get(args.id);
    if (!r || r.accountId !== args.accountId) return Promise.resolve(false);
    this.rows.delete(args.id);
    return Promise.resolve(true);
  }
}
