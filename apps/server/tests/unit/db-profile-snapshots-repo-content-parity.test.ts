// W444.A — drift guard for apps/server/src/db/profile-snapshots-repo.ts.
// V-312 Drizzle ProfileSnapshotsRepo. Drift here either drops the
// composite (createdAt, id) tiebreak (snapshots with identical
// timestamps emit duplicate or skipped pages across cursor reads)
// or stops capping limit at 100 (unbounded list query).
//
//   • V-312 framing pinned.
//   • toRow: 10-field ProfileSnapshotRecord (stateBlob defaulted
//     to {} when DB NULL).
//   • insert: 7-field values + returning(); throws on no-row.
//   • list pagination framing: min(limit ?? SNAPSHOT_PAGE_DEFAULT, SNAPSHOT_PAGE_MAX) cap,
//     both exported for the in-memory double (V-1246); composite
//     cursor over (createdAt, id) via OR(lt(createdAt, c.createdAt),
//     and(eq(createdAt, c.createdAt), lt(id, c.id))) — required
//     because multiple snapshots can share the same createdAt.
//   • orderBy desc(createdAt), desc(id); limit+1 hasMore;
//     nextCursor = last row's id (not timestamp ISO).
//   • findById + delete: account-scoped via and(eq(id), eq(accountId)).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/profile-snapshots-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W444.A apps/server/src/db/profile-snapshots-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-312 framing pinned: 'Drizzle implementation of ProfileSnapshotsRepo.'", () => {
    expect(body).toMatch(/\/\/ V-312 — Drizzle implementation of ProfileSnapshotsRepo\./);
  });

  it('imports: and/desc/eq/lt/or from drizzle-orm; 5 service types; Database; profileSnapshots schema', () => {
    expect(body).toMatch(/import \{ and, desc, eq, lt, or \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*ListSnapshotsArgs,\s*\n?\s*ListSnapshotsPage,\s*\n?\s*NewSnapshotInput,\s*\n?\s*ProfileSnapshotRecord,\s*\n?\s*ProfileSnapshotsRepo,\s*\n?\s*\} from '\.\.\/services\/profile-snapshots\.js';/,
    );
    expect(body).toMatch(/import \{ profileSnapshots \} from '\.\/schema\.js';/);
  });

  it('toRow: 10-field ProfileSnapshotRecord (id, accountId, parentProfileId, label, description, parentArchetype, parentName, stateBlob defaulted {} when null, capturedAt, createdAt)', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof profileSnapshots\.\$inferSelect\): ProfileSnapshotRecord \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*parentProfileId: r\.parentProfileId,\s*\n?\s*label: r\.label,\s*\n?\s*description: r\.description,\s*\n?\s*parentArchetype: r\.parentArchetype,\s*\n?\s*parentName: r\.parentName,\s*\n?\s*stateBlob: \(r\.stateBlob \?\? \{\}\) as Record<string, unknown>,\s*\n?\s*capturedAt: r\.capturedAt,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it("insert: 7-field values (accountId + parentProfileId + label + description + parentArchetype + parentName + stateBlob); returning(); throws 'insert: no row returned'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*parentProfileId: input\.parentProfileId,\s*\n?\s*label: input\.label,\s*\n?\s*description: input\.description,\s*\n?\s*parentArchetype: input\.parentArchetype,\s*\n?\s*parentName: input\.parentName,\s*\n?\s*stateBlob: input\.stateBlob,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('insert: no row returned'\);/,
    );
  });

  it('list: limit cap = Math.min(args.limit ?? SNAPSHOT_PAGE_DEFAULT, SNAPSHOT_PAGE_MAX), both EXPORTED (V-1246 — the in-memory double imports them, so the export keyword is load-bearing); filters seeded with eq(accountId); optional eq(parentProfileId)', () => {
    expect(body).toMatch(
      /const limit = Math\.min\(args\.limit \?\? SNAPSHOT_PAGE_DEFAULT, SNAPSHOT_PAGE_MAX\);\s*\n?\s*const filters = \[eq\(profileSnapshots\.accountId, args\.accountId\)\];\s*\n?\s*if \(args\.parentProfileId !== undefined\) \{\s*\n?\s*filters\.push\(eq\(profileSnapshots\.parentProfileId, args\.parentProfileId\)\);\s*\n?\s*\}/,
    );
  });

  it('composite cursor framing: 2-field cursor-row lookup, ACCOUNT-SCOPED (id AND accountId), then OR(lt(createdAt), and(eq(createdAt), lt(id))) keyset — multiple snapshots can share createdAt. The cursor-row lookup is account-scoped (NOT id-only) so a forged cross-account cursor cannot mis-position the caller page or leak a snapshot-id-exists oracle; the main query is account-scoped too. (Short focused pins, not one long-chain regex, per the no-long-chain-regex rule.)', () => {
    expect(body).toMatch(/const \[c\] = await this\.database\.db/);
    expect(body).toMatch(/createdAt: profileSnapshots\.createdAt,/);
    expect(body).toMatch(/id: profileSnapshots\.id,/);
    // IDOR guard: cursor-row lookup filters by BOTH id AND accountId.
    expect(body).toMatch(
      /and\(eq\(profileSnapshots\.id, args\.cursor\), eq\(profileSnapshots\.accountId, args\.accountId\)\)/,
    );
    expect(body).not.toMatch(/\.where\(eq\(profileSnapshots\.id, args\.cursor\)\)/);
    // Composite keyset (handles same-createdAt rows).
    expect(body).toMatch(/const cur = or\(/);
    expect(body).toMatch(/lt\(profileSnapshots\.createdAt, c\.createdAt\)/);
    expect(body).toMatch(
      /and\(eq\(profileSnapshots\.createdAt, c\.createdAt\), lt\(profileSnapshots\.id, c\.id\)\)/,
    );
  });

  it('Query orderBy desc(createdAt), desc(id); limit(limit+1); hasMore + slice + nextCursor = last id (NOT timestamp ISO)', () => {
    expect(body).toMatch(
      /\.orderBy\(desc\(profileSnapshots\.createdAt\), desc\(profileSnapshots\.id\)\)\s*\n?\s*\.limit\(limit \+ 1\);\s*\n?\s*const hasMore = rows\.length > limit;\s*\n?\s*const data = rows\.slice\(0, limit\)\.map\(toRow\);\s*\n?\s*const nextCursor = hasMore && data\.length > 0 \? data\[data\.length - 1\]!\.id : null;\s*\n?\s*return \{ data, hasMore, nextCursor \};/,
    );
  });

  it('findById: account-scoped and(eq(id), eq(accountId)) + limit 1 → toRow(row) or null', () => {
    expect(body).toMatch(
      /async findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileSnapshotRecord \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(profileSnapshots\)\s*\n?\s*\.where\(and\(eq\(profileSnapshots\.id, args\.id\), eq\(profileSnapshots\.accountId, args\.accountId\)\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRow\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it('delete: account-scoped delete returning {id}; returns rows.length > 0', () => {
    expect(body).toMatch(
      /async delete\(args: \{ id: string; accountId: string \}\): Promise<boolean> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.delete\(profileSnapshots\)\s*\n?\s*\.where\(and\(eq\(profileSnapshots\.id, args\.id\), eq\(profileSnapshots\.accountId, args\.accountId\)\)\)\s*\n?\s*\.returning\(\{ id: profileSnapshots\.id \}\);\s*\n?\s*return rows\.length > 0;\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
