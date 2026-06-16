// W1002 — db/profiles-repo V-081 cross-source invariant. Three-
// hundred-twenty-eighth in the drift-guard series. Pins the apps/
// server/src/db/profiles-repo.ts Drizzle profiles repo primitive:
//
//   V-081 anchor — 'Drizzle-backed ProfilesRepo (V-081)'.
//
//   DrizzleProfilesRepo 8-method surface — insert + countByAccount +
//     findById + findByAccountAndName + list + update + delete + touch.
//
//   DEFAULT_PAGE = 50 + MAX_PAGE = 100. The min(args.limit ?? DEFAULT,
//     MAX) clamp keeps page sizes sane.
//
//   list compound-cursor framing — load cursor row's (createdAt, id),
//   then WHERE (createdAt < cursor.createdAt OR (createdAt = cursor.
//   createdAt AND id < cursor.id)). The tuple-comparison tiebreaker
//   keeps pagination correct when multiple profiles share a
//   timestamp.
//
//   list orderBy desc(createdAt) + desc(id) tuple-order. limit+1
//     hasMore probe. nextCursor = last item's id (when hasMore).
//
//   countByAccount uses count() aggregator (drizzle helper).
//
//   findById tenant-scoped — and(eq(id), eq(accountId)).
//
//   findByAccountAndName lookup by (accountId, name) tuple.
//
//   update sets always-updatedAt + 2 conditional fields (name +
//     description).
//
//   delete returning({id}).length > 0 boolean.
//
//   touch single-field UPDATE (lastUsedAt).
//
//   toRecord 8-field shape — id + accountId + name + archetype +
//     description + lastUsedAt + createdAt + updatedAt.
//
// stays in lockstep across apps/server/src/db/profiles-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1002 db/profiles-repo V-081 cross-source invariant', () => {
  // ─── V-081 anchor ────────────────────────────────────────────

  it("CRITICAL apps/server/src/db/profiles-repo.ts header pins V-081 anchor — 'Drizzle-backed ProfilesRepo (V-081)'. The V-081 anchor is the profiles-repo provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed ProfilesRepo \(V-081\)\./);
    expect(p).toMatch(/export class DrizzleProfilesRepo implements ProfilesRepo \{/);
  });

  // ─── Page-size constants ─────────────────────────────────────

  it('CRITICAL DEFAULT_PAGE 50 + MAX_PAGE 100. The 50/100 default+clamp keeps page sizes reasonable for the customer dashboard.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/const DEFAULT_PAGE = 50;/);
    expect(p).toMatch(/const MAX_PAGE = 100;/);
    expect(p).toMatch(/const limit = Math\.min\(args\.limit \?\? DEFAULT_PAGE, MAX_PAGE\);/);
  });

  // ─── 8-method surface ────────────────────────────────────────

  it('CRITICAL 10-method surface — insert + countByAccount + findById + findByAccountAndName + list + update + delete + touch + listTrashed + restore. CRUD + count + dedup-by-name + lastUsedAt touch + L4b recycle bin (trash list + restore).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/async insert\(input: NewProfileInput\): Promise<ProfileRecord> \{/);
    expect(p).toMatch(/async countByAccount\(accountId: string\): Promise<number> \{/);
    expect(p).toMatch(
      /async findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileRecord \| null> \{/,
    );
    expect(p).toMatch(/async findByAccountAndName\(args: \{/);
    expect(p).toMatch(/async list\(args: ListProfilesArgs\): Promise<ListProfilesPage> \{/);
    expect(p).toMatch(/async update\(args: \{/);
    expect(p).toMatch(
      /async delete\(args: \{ id: string; accountId: string \}\): Promise<boolean> \{/,
    );
    expect(p).toMatch(
      /async touch\(args: \{ id: string; accountId: string; at: Date \}\): Promise<void> \{/,
    );
    expect(p).toMatch(
      /async listTrashed\(args: \{ accountId: string \}\): Promise<ProfileRecord\[\]> \{/,
    );
    expect(p).toContain("Promise<'restored' | 'not_found' | 'name_conflict'>");
  });

  it('CRITICAL L4b listTrashed inverts the live filter — isNotNull(deletedAt), orderBy desc(deletedAt). restore pre-checks a LIVE same-name (notDeleted) → name_conflict, else clears deletedAt; catches the 23505 partial-index race.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toContain('isNotNull(profiles.deletedAt)');
    expect(p).toMatch(/\.orderBy\(desc\(profiles\.deletedAt\), desc\(profiles\.id\)\)/);
    expect(p).toContain('.set({ deletedAt: null, updatedAt: new Date() })');
    expect(p).toMatch(/isUniqueViolation\(err, 'profiles_account_name_unique'\)/);
  });

  // ─── countByAccount drizzle count() ─────────────────────────

  it("CRITICAL countByAccount uses drizzle count() aggregator — '.select({ n: count() }).from(profiles).where(eq(accountId))'. The count() helper avoids hand-writing sql<number>`count(*)`.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/\.select\(\{ n: count\(\) \}\)/);
    expect(p).toMatch(/\.where\(and\(eq\(profiles\.accountId, accountId\), notDeleted\)\);/);
    expect(p).toMatch(/return row\?\.n \?\? 0;/);
  });

  // ─── findById + findByAccountAndName tenant-scoped ───────────

  it('CRITICAL findById tenant-scoped — and(eq(id), eq(accountId)) + limit(1). The 2-cond scope prevents cross-account lookup.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(
      /\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\), notDeleted\)\)/,
    );
  });

  it('CRITICAL findByAccountAndName tenant-scoped by (accountId, name) — and(eq(accountId), eq(name), notDeleted). The (account, name) tuple is the dedup-on-name lookup; notDeleted excludes trashed.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(
      /\.where\(and\(eq\(profiles\.accountId, args\.accountId\), eq\(profiles\.name, args\.name\), notDeleted\)\)/,
    );
  });

  // ─── list compound-cursor pagination ─────────────────────────

  it("CRITICAL list compound-cursor — loads (createdAt, id) from cursor profile first, then 'or(lt(createdAt, cursor.createdAt), and(eq(createdAt, cursor.createdAt), lt(id, cursor.id)))'. The tuple-compare tiebreaker is what makes pagination correct under createdAt-ties.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/\.select\(\{ createdAt: profiles\.createdAt, id: profiles\.id \}\)/);
    expect(p).toMatch(/cursorWhere = or\(/);
    expect(p).toMatch(/lt\(profiles\.createdAt, cursorRow\.createdAt\),/);
    expect(p).toMatch(
      /and\(eq\(profiles\.createdAt, cursorRow\.createdAt\), lt\(profiles\.id, cursorRow\.id\)\),/,
    );
  });

  it('CRITICAL list orderBy desc(createdAt) + desc(id) tuple-order + limit+1 hasMore probe + nextCursor = last item id.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/\.orderBy\(desc\(profiles\.createdAt\), desc\(profiles\.id\)\)/);
    expect(p).toMatch(/\.limit\(limit \+ 1\);/);
    expect(p).toMatch(/const hasMore = rows\.length > limit;/);
    expect(p).toMatch(/const data = rows\.slice\(0, limit\)\.map\(toRecord\);/);
    expect(p).toMatch(
      /const nextCursor = hasMore && data\.length > 0 \? data\[data\.length - 1\]!\.id : null;/,
    );
  });

  it('CRITICAL list returns 3-field ListProfilesPage — { data, hasMore, nextCursor }. The 3-field shape is the V-081 paged-response contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/return \{ data, hasMore, nextCursor \};/);
  });

  // ─── update 1+2 patch ────────────────────────────────────────

  it('CRITICAL update always sets updatedAt + 2 conditional fields (name + description). The conditional-set design avoids overwriting unset fields.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/const sets: Record<string, unknown> = \{ updatedAt: new Date\(\) \};/);
    expect(p).toMatch(/if \(args\.updates\.name !== undefined\) sets\.name = args\.updates\.name;/);
    expect(p).toMatch(
      /if \(args\.updates\.description !== undefined\) sets\.description = args\.updates\.description;/,
    );
  });

  // ─── delete returning length ─────────────────────────────────

  it("CRITICAL delete is a L4b SOFT delete — UPDATE set({deletedAt, updatedAt}) where (id, accountId, notDeleted), returning {id}, 'result.length > 0'. The notDeleted guard makes it idempotent; the .length check is the deleted-or-not signal.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/const notDeleted = isNull\(profiles\.deletedAt\);/);
    expect(p).toMatch(/\.set\(\{ deletedAt: now, updatedAt: now \}\)/);
    expect(p).toMatch(
      /\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\), notDeleted\)\)/,
    );
    expect(p).toMatch(/\.returning\(\{ id: profiles\.id \}\);/);
    expect(p).toMatch(/return result\.length > 0;/);
  });

  // ─── touch single-field UPDATE ───────────────────────────────

  it('CRITICAL touch single-field UPDATE — set({lastUsedAt}) where (id, accountId). The narrow update lets services bump lastUsedAt without touching other fields.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/\.update\(profiles\)/);
    expect(p).toMatch(/\.set\(\{ lastUsedAt: args\.at \}\)/);
    expect(p).toMatch(
      /\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\), notDeleted\)\);/,
    );
  });

  // ─── toRecord 8-field mapper ─────────────────────────────────

  it('CRITICAL toRecord 8-field mapper — id + accountId + name + archetype + description + lastUsedAt + createdAt + updatedAt. The 8-field ProfileRecord covers profile-table public surface.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts'));
    expect(p).toMatch(/function toRecord\(r: typeof profiles\.\$inferSelect\): ProfileRecord \{/);
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/name: r\.name,/);
    expect(p).toMatch(/archetype: r\.archetype,/);
    expect(p).toMatch(/description: r\.description,/);
    expect(p).toMatch(/lastUsedAt: r\.lastUsedAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
    expect(p).toMatch(/updatedAt: r\.updatedAt,/);
    expect(p).toMatch(/deletedAt: r\.deletedAt,/); // L4b recycle bin
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-profiles-repo-v081-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
