// W1011 — db/profile-snapshots-repo V-312 cross-source invariant.
// Three-hundred-thirty-seventh in the drift-guard series. Pins the
// apps/server/src/db/profile-snapshots-repo.ts Drizzle profile-
// snapshots repo:
//
//   V-312 anchor — 'V-312 — Drizzle implementation of
//   ProfileSnapshotsRepo'.
//
//   4-method DrizzleProfileSnapshotsRepo — insert + list + findById
//     + delete.
//
//   list 50/100 limit clamp + parentProfileId optional filter +
//     compound (createdAt, id) cursor pattern with tuple-compare
//     tiebreaker (matches W1002 profiles-repo).
//
//   toRow 10-field shape — id + accountId + parentProfileId + label
//     + description + parentArchetype + parentName + stateBlob (??
//     {} fallback) + capturedAt + createdAt.
//
//   stateBlob fallback — '(r.stateBlob ?? {}) as Record<string,
//     unknown>'. The ?? {} normalises NULL→empty-object.
//
//   delete returning length > 0 + tenant-scoped (id, accountId).
//
// stays in lockstep across apps/server/src/db/profile-snapshots-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1011 db/profile-snapshots-repo V-312 cross-source invariant', () => {
  it("CRITICAL V-312 anchor — 'V-312 — Drizzle implementation of ProfileSnapshotsRepo'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profile-snapshots-repo.ts'));
    expect(p).toMatch(/\/\/ V-312 — Drizzle implementation of ProfileSnapshotsRepo\./);
    expect(p).toMatch(
      /export class DrizzleProfileSnapshotsRepo implements ProfileSnapshotsRepo \{/,
    );
  });

  it('CRITICAL 4-method surface — insert + list + findById + delete.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profile-snapshots-repo.ts'));
    expect(p).toMatch(/async insert\(input: NewSnapshotInput\): Promise<ProfileSnapshotRecord> \{/);
    expect(p).toMatch(/async list\(args: ListSnapshotsArgs\): Promise<ListSnapshotsPage> \{/);
    expect(p).toMatch(
      /async findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileSnapshotRecord \| null> \{/,
    );
    expect(p).toMatch(
      /async delete\(args: \{ id: string; accountId: string \}\): Promise<boolean> \{/,
    );
  });

  it('CRITICAL list 50/100 limit clamp + parentProfileId optional filter + compound (createdAt, id) cursor.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profile-snapshots-repo.ts'));
    expect(p).toMatch(/export const SNAPSHOT_PAGE_DEFAULT = 50;/);
    expect(p).toMatch(/export const SNAPSHOT_PAGE_MAX = 100;/);
    expect(p).toMatch(
      /const limit = Math\.min\(args\.limit \?\? SNAPSHOT_PAGE_DEFAULT, SNAPSHOT_PAGE_MAX\);/,
    );
    expect(p).toMatch(/if \(args\.parentProfileId !== undefined\) \{/);
    expect(p).toMatch(
      /filters\.push\(eq\(profileSnapshots\.parentProfileId, args\.parentProfileId\)\);/,
    );
    expect(p).toMatch(/lt\(profileSnapshots\.createdAt, c\.createdAt\),/);
    expect(p).toMatch(
      /and\(eq\(profileSnapshots\.createdAt, c\.createdAt\), lt\(profileSnapshots\.id, c\.id\)\),/,
    );
  });

  it('CRITICAL list orderBy desc(createdAt) + desc(id) + limit+1 hasMore + nextCursor = last item id.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profile-snapshots-repo.ts'));
    expect(p).toMatch(
      /\.orderBy\(desc\(profileSnapshots\.createdAt\), desc\(profileSnapshots\.id\)\)/,
    );
    expect(p).toMatch(/\.limit\(limit \+ 1\);/);
    expect(p).toMatch(
      /const nextCursor = hasMore && data\.length > 0 \? data\[data\.length - 1\]!\.id : null;/,
    );
    expect(p).toMatch(/return \{ data, hasMore, nextCursor \};/);
  });

  it("CRITICAL toRow 10-field shape + stateBlob ?? {} NULL-to-empty-object fallback. The 'as Record<string, unknown>' cast preserves the open-payload type.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profile-snapshots-repo.ts'));
    expect(p).toMatch(
      /function toRow\(r: typeof profileSnapshots\.\$inferSelect\): ProfileSnapshotRecord \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/parentProfileId: r\.parentProfileId,/);
    expect(p).toMatch(/label: r\.label,/);
    expect(p).toMatch(/description: r\.description,/);
    expect(p).toMatch(/parentArchetype: r\.parentArchetype,/);
    expect(p).toMatch(/parentName: r\.parentName,/);
    expect(p).toMatch(/stateBlob: \(r\.stateBlob \?\? \{\}\) as Record<string, unknown>,/);
    expect(p).toMatch(/capturedAt: r\.capturedAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
  });

  it('CRITICAL delete tenant-scoped (id, accountId) + returning({id}).length > 0 boolean.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profile-snapshots-repo.ts'));
    expect(p).toMatch(
      /\.where\(and\(eq\(profileSnapshots\.id, args\.id\), eq\(profileSnapshots\.accountId, args\.accountId\)\)\)/,
    );
    expect(p).toMatch(/\.returning\(\{ id: profileSnapshots\.id \}\);/);
    expect(p).toMatch(/return rows\.length > 0;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-profile-snapshots-repo-v312-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
