// W446.B — drift guard for apps/server/src/db/profiles-repo.ts.
// V-081 Drizzle ProfilesRepo. Drift here either drops the cursor-
// is-account-scoped lookup (cross-account cursor probe leaks
// existence of another account's profile id) or breaks the composite
// (createdAt, id) tiebreak (list pagination with same-timestamp
// profiles silently skips rows).
//
//   • V-081 framing pinned.
//   • DEFAULT_PAGE 50; MAX_PAGE 100 constants.
//   • toRecord: 10-field ProfileRecord (incl folder/tags organization).
//   • insert: 7-field values (+ wrappedDek); returning(); throws on no-row.
//   • countByAccount: count() helper aggregate; row?.n ?? 0.
//   • findById + findByAccountAndName: account-scoped + limit 1.
//   • list cursor framing: cursor row lookup IS account-scoped
//     (and(eq(id, cursor), eq(accountId, args.accountId))); composite
//     OR(lt(createdAt), and(eq(createdAt), lt(id))) tiebreak;
//     whereClause combines accountId + optional cursor.
//   • orderBy desc(createdAt), desc(id); limit+1 hasMore; nextCursor=id.
//   • update: selective field set + always-bump updatedAt; throws on
//     no-row.
//   • delete: returning + boolean.
//   • touch: lastUsedAt set without updatedAt bump.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/profiles-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W446.B apps/server/src/db/profiles-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-081 framing pinned: 'Drizzle-backed ProfilesRepo (V-081).'", () => {
    expect(body).toMatch(/\/\/ Drizzle-backed ProfilesRepo \(V-081\)\./);
  });

  it('imports: and/count/desc/eq/lt/or from drizzle-orm; 6 service types (ListProfilesArgs/Page + NewProfileInput + ProfileRecord + ProfileUpdates + ProfilesRepo); Database; profiles schema', () => {
    expect(body).toMatch(/import \{ and, count, desc, eq, lt, or \} from 'drizzle-orm';/);
    expect(body).toMatch(
      /import type \{\s*\n?\s*ListProfilesArgs,\s*\n?\s*ListProfilesPage,\s*\n?\s*NewProfileInput,\s*\n?\s*ProfileRecord,\s*\n?\s*ProfileUpdates,\s*\n?\s*ProfilesRepo,\s*\n?\s*\} from '\.\.\/services\/profiles\.js';/,
    );
  });

  it('DEFAULT_PAGE = 50; MAX_PAGE = 100 constants', () => {
    expect(body).toMatch(/const DEFAULT_PAGE = 50;\s*\n?\s*const MAX_PAGE = 100;/);
  });

  it('toRecord: 10-field ProfileRecord (id + accountId + name + archetype + description + folder + tags + lastUsedAt + created/updated_at)', () => {
    // Per-field toContain (no long \s*\n?\s* chains — see
    // feedback_no_long_chain_parity_regex).
    expect(body).toMatch(
      /function toRecord\(r: typeof profiles\.\$inferSelect\): ProfileRecord \{/,
    );
    expect(body).toContain('id: r.id,');
    expect(body).toContain('accountId: r.accountId,');
    expect(body).toContain('name: r.name,');
    expect(body).toContain('archetype: r.archetype,');
    expect(body).toContain('description: r.description,');
    expect(body).toContain('folder: r.folder,');
    expect(body).toContain('tags: r.tags,');
    expect(body).toContain('lastUsedAt: r.lastUsedAt,');
    expect(body).toContain('createdAt: r.createdAt,');
    expect(body).toContain('updatedAt: r.updatedAt,');
  });

  it("insert: 7-field values (accountId + name + archetype + description + folder + tags + wrappedDek); returning(); throws 'insert profile: no row returned'", () => {
    // Per-field toContain rather than one long \s*\n?\s*-chained regex (the
    // chain backtracks pathologically past ~5 groups; the wrapped_dek field
    // pushed it over — see feedback_no_long_chain_parity_regex).
    expect(body).toContain('accountId: input.accountId,');
    expect(body).toContain('name: input.name,');
    expect(body).toContain('archetype: input.archetype,');
    expect(body).toContain('description: input.description,');
    expect(body).toContain('folder: input.folder ?? null,');
    expect(body).toContain('tags: input.tags ?? [],');
    expect(body).toContain('wrappedDek: input.wrappedDek ?? null,');
    expect(body).toContain('.returning();');
    expect(body).toContain("if (!row) throw new Error('insert profile: no row returned');");
  });

  it('countByAccount: select count() helper aggregate where accountId; row?.n ?? 0', () => {
    expect(body).toMatch(
      /async countByAccount\(accountId: string\): Promise<number> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\{ n: count\(\) \}\)\s*\n?\s*\.from\(profiles\)\s*\n?\s*\.where\(eq\(profiles\.accountId, accountId\)\);\s*\n?\s*return row\?\.n \?\? 0;\s*\n?\s*\}/,
    );
  });

  it('findById + findByAccountAndName: account-scoped via and() + limit 1', () => {
    expect(body).toMatch(
      /async findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileRecord \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(profiles\)\s*\n?\s*\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\)\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRecord\(row\) : null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async findByAccountAndName\(args: \{\s*\n?\s*accountId: string;\s*\n?\s*name: string;\s*\n?\s*\}\): Promise<ProfileRecord \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(profiles\)\s*\n?\s*\.where\(and\(eq\(profiles\.accountId, args\.accountId\), eq\(profiles\.name, args\.name\)\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRecord\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it('list cursor framing pinned: cursor lookup is ACCOUNT-SCOPED via and(eq(id, cursor), eq(accountId, args.accountId)) — prevents cross-account cursor probe; composite OR(lt(createdAt, c.createdAt), and(eq(createdAt, c.createdAt), lt(id, c.id)))', () => {
    expect(body).toMatch(
      /if \(args\.cursor !== undefined && parseUuidCursor\(args\.cursor\) !== undefined\) \{\s*\n?\s*const \[cursorRow\] = await this\.database\.db\s*\n?\s*\.select\(\{ createdAt: profiles\.createdAt, id: profiles\.id \}\)\s*\n?\s*\.from\(profiles\)\s*\n?\s*\.where\(and\(eq\(profiles\.id, args\.cursor\), eq\(profiles\.accountId, args\.accountId\)\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*if \(cursorRow !== undefined\) \{\s*\n?\s*cursorWhere = or\(\s*\n?\s*lt\(profiles\.createdAt, cursorRow\.createdAt\),\s*\n?\s*and\(eq\(profiles\.createdAt, cursorRow\.createdAt\), lt\(profiles\.id, cursorRow\.id\)\),\s*\n?\s*\);\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('list: limit cap = Math.min(args.limit ?? DEFAULT_PAGE, MAX_PAGE); orderBy desc(createdAt), desc(id); limit+1 hasMore + slice; nextCursor = last row id', () => {
    expect(body).toMatch(/const limit = Math\.min\(args\.limit \?\? DEFAULT_PAGE, MAX_PAGE\);/);
    expect(body).toMatch(
      /\.orderBy\(desc\(profiles\.createdAt\), desc\(profiles\.id\)\)\s*\n?\s*\.limit\(limit \+ 1\);\s*\n?\s*const hasMore = rows\.length > limit;\s*\n?\s*const data = rows\.slice\(0, limit\)\.map\(toRecord\);\s*\n?\s*const nextCursor = hasMore && data\.length > 0 \? data\[data\.length - 1\]!\.id : null;\s*\n?\s*return \{ data, hasMore, nextCursor \};/,
    );
  });

  it("update: sets always-bump updatedAt; selective name/description set; account-scoped where; throws 'update profile: no row returned'", () => {
    expect(body).toMatch(
      /const sets: Record<string, unknown> = \{ updatedAt: new Date\(\) \};\s*\n?\s*if \(args\.updates\.name !== undefined\) sets\.name = args\.updates\.name;\s*\n?\s*if \(args\.updates\.description !== undefined\) sets\.description = args\.updates\.description;/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('update profile: no row returned'\);/);
  });

  it('delete + touch: account-scoped via and(eq(id), eq(accountId)); delete returning {id} + length > 0; touch sets only lastUsedAt (no updatedAt bump)', () => {
    expect(body).toMatch(
      /async delete\(args: \{ id: string; accountId: string \}\): Promise<boolean> \{\s*\n?\s*const result = await this\.database\.db\s*\n?\s*\.delete\(profiles\)\s*\n?\s*\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\)\)\)\s*\n?\s*\.returning\(\{ id: profiles\.id \}\);\s*\n?\s*return result\.length > 0;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async touch\(args: \{ id: string; accountId: string; at: Date \}\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(profiles\)\s*\n?\s*\.set\(\{ lastUsedAt: args\.at \}\)\s*\n?\s*\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\)\)\);\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
