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

  it('imports: and/asc/count/desc/eq/inArray/lt/or from drizzle-orm; profile-DEK codec; 6 service types; Database; profiles schema', () => {
    // doc-150 item 6 — `sql` joined the drizzle import for the
    // COALESCE(sum(...))::bigint storage-total aggregate in sumSizeBytesByAccount.
    // #158 — `inArray` joined for findExistingProfileIds' WHERE id IN (...) batch.
    expect(body).toMatch(
      /import \{ and, asc, count, desc, eq, inArray, isNotNull, isNull, lt, or, sql \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(/import \{ isUniqueViolation \} from '\.\.\/lib\/pg-error\.js';/);
    expect(body).toMatch(
      /import type \{\s*ListProfilesArgs,\s*ListProfilesPage,\s*NewProfileInput,\s*ProfileRecord,\s*ProfileUpdates,\s*ProfilesRepo,\s*\} from '\.\.\/services\/profiles\.js';/,
    );
    expect(body).toContain('PROFILE_DEK_V2_PREFIX,');
    expect(body).toContain('unwrapLegacyProfileDek,');
    expect(body).toContain('unwrapProfileDek,');
    expect(body).toContain('wrapProfileDek,');
  });

  it('DEFAULT_PAGE = 50; MAX_PAGE = 100 constants, and both are EXPORTED. V-1244 — the in-memory double imports these rather than restating the numbers, so the export keyword is load-bearing: drop it and the double falls back to a private copy that agrees only until someone changes the page size here.', () => {
    expect(body).toMatch(/export const DEFAULT_PAGE = 50;\s*export const MAX_PAGE = 100;/);
  });

  it('toRecord: full ProfileRecord (id + accountId + name + archetype + description + folder + tags + icon + note + lastUsedAt + sizeBytes + lastSavedAt + created/updated_at + deletedAt)', () => {
    // Per-field toContain (no long \s* chains — see
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
    // doc-150 item 5 — per-profile sealed-store size + save-back time.
    expect(body).toContain('sizeBytes: r.sizeBytes,');
    expect(body).toContain('lastSavedAt: r.lastSavedAt,');
    expect(body).toContain('createdAt: r.createdAt,');
    expect(body).toContain('updatedAt: r.updatedAt,');
    expect(body).toContain('deletedAt: r.deletedAt,'); // L4b recycle bin
  });

  it('sumSizeBytesByAccount (doc-150 item 6): COALESCE(sum(sizeBytes), 0)::bigint over notDeleted account rows; Number()-parses the string back', () => {
    expect(body).toMatch(/async sumSizeBytesByAccount\(accountId: string\): Promise<number> \{/);
    expect(body).toContain('coalesce(sum(${profiles.sizeBytes}), 0)::bigint');
    expect(body).toContain('.where(and(eq(profiles.accountId, accountId), notDeleted));');
    expect(body).toContain('return row ? Number(row.total) : 0;');
  });

  it("insert: preallocated identity + metadata + wrappedDek; returning(); throws 'insert profile: no row returned'", () => {
    // Per-field toContain rather than one long \s*-chained regex (the
    // chain backtracks pathologically past ~5 groups; the wrapped_dek field
    // pushed it over — see feedback_no_long_chain_parity_regex).
    expect(body).toContain('...preallocatedProfileId(input),');
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

  it('profile-DEK migration authenticates v2 probe, prevalidates a bounded legacy page, exact-CASes id+account+old wrapper, preserves updatedAt and counts remaining', () => {
    expect(body).toContain('const MAX_PROFILE_DEK_MIGRATION_BATCH = 500;');
    expect(body).toContain('async migrateWrappedDekEnvelopes(');
    expect(body).toContain('.where(profileDekIsV2())');
    // The probe's unwrap now runs inside verifyBootEncryptionKey so a wrong
    // PROFILE_MASTER_KEY names the subsystem instead of surfacing a raw crypto
    // error. Both halves are pinned: the wrapper, and the unwrap it guards.
    expect(body).toContain(
      "verifyBootEncryptionKey('Profile encryption keys', 'PROFILE_MASTER_KEY', () => {",
    );
    expect(body).toContain(
      'unwrapProfileDek(masterKey, v2Probe.accountId, v2Probe.id, probeWrappedDek);',
    );
    expect(body).toContain('.where(profileDekIsLegacy())');
    expect(body).toContain(
      'const dek = unwrapLegacyProfileDek(masterKey, row.accountId, row.wrappedDek);',
    );
    expect(body).toContain('next: wrapProfileDek(masterKey, row.accountId, row.id, dek),');
    expect(body).toContain('eq(profiles.id, row.id),');
    expect(body).toContain('eq(profiles.accountId, row.accountId),');
    expect(body).toContain('eq(profiles.wrappedDek, row.wrappedDek),');
    expect(body).not.toContain('updatedAt: row.next');
    expect(body).toContain('remaining: remainingRow?.value ?? 0');
  });

  it('countByAccount: select count() helper aggregate where accountId; row?.n ?? 0', () => {
    expect(body).toMatch(
      /async countByAccount\(accountId: string\): Promise<number> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\{ n: count\(\) \}\)\s*\.from\(profiles\)\s*\.where\(and\(eq\(profiles\.accountId, accountId\), notDeleted\)\);\s*return row\?\.n \?\? 0;\s*\}/,
    );
  });

  it('findById + findByAccountAndName: account-scoped via and() + limit 1', () => {
    expect(body).toMatch(
      /async findById\(args: \{ id: string; accountId: string \}\): Promise<ProfileRecord \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(profiles\)\s*\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\), notDeleted\)\)\s*\.limit\(1\);\s*return row \? toRecord\(row\) : null;\s*\}/,
    );
    expect(body).toMatch(
      /async findByAccountAndName\(args: \{\s*accountId: string;\s*name: string;\s*\}\): Promise<ProfileRecord \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(profiles\)\s*\.where\(and\(eq\(profiles\.accountId, args\.accountId\), eq\(profiles\.name, args\.name\), notDeleted\)\)\s*\.limit\(1\);\s*return row \? toRecord\(row\) : null;\s*\}/,
    );
  });

  it('list cursor framing pinned: cursor lookup is ACCOUNT-SCOPED via and(eq(id, cursor), eq(accountId, args.accountId)) — prevents cross-account cursor probe; the cursor-anchor lookup deliberately OMITS notDeleted (a keyset POSITION is well-defined even if the boundary row was trashed between pages → no reset-to-page-1); composite OR(lt(createdAt, c.createdAt), and(eq(createdAt, c.createdAt), lt(id, c.id)))', () => {
    // Per-fragment toContain (no long \s* chain — it backtracks
    // pathologically AND breaks when prettier wraps the .where() across lines;
    // see feedback_no_long_chain_parity_regex). The security-relevant pin is the
    // account-scoped cursor lookup (cross-account probe blocked) + the composite
    // tiebreak. FIX 3 (2026-06-25) dropped notDeleted from the cursor-anchor
    // lookup ONLY (the RESULT set below stays notDeleted): a cursor pointing at a
    // profile trashed between page fetches must still ADVANCE the page, not reset
    // to page 1. The negative-pin below guards that notDeleted did NOT creep back
    // into the cursor-anchor .where().
    expect(body).toContain(
      'if (args.cursor !== undefined && parseUuidCursor(args.cursor) !== undefined) {',
    );
    expect(body).toContain('.select({ createdAt: profiles.createdAt, id: profiles.id })');
    expect(body).toContain(
      'and(eq(profiles.id, args.cursor), eq(profiles.accountId, args.accountId))',
    );
    // Negative pin: the cursor-anchor lookup must NOT re-add notDeleted (would
    // reintroduce the trashed-boundary page-1 reset FIX 3 closed).
    expect(body).not.toContain(
      'and(eq(profiles.id, args.cursor), eq(profiles.accountId, args.accountId), notDeleted)',
    );
    expect(body).toContain('lt(profiles.createdAt, cursorRow.createdAt),');
    expect(body).toContain(
      'and(eq(profiles.createdAt, cursorRow.createdAt), lt(profiles.id, cursorRow.id)),',
    );
  });

  it('list: limit cap = Math.min(args.limit ?? DEFAULT_PAGE, MAX_PAGE); orderBy desc(createdAt), desc(id); limit+1 hasMore + slice; nextCursor = last row id', () => {
    expect(body).toMatch(/const limit = Math\.min\(args\.limit \?\? DEFAULT_PAGE, MAX_PAGE\);/);
    expect(body).toMatch(
      /\.orderBy\(desc\(profiles\.createdAt\), desc\(profiles\.id\)\)\s*\.limit\(limit \+ 1\);\s*const hasMore = rows\.length > limit;\s*const data = rows\.slice\(0, limit\)\.map\(toRecord\);\s*const nextCursor = hasMore && data\.length > 0 \? data\[data\.length - 1\]!\.id : null;\s*return \{ data, hasMore, nextCursor \};/,
    );
  });

  it("update: sets always-bump updatedAt; selective name/description set; account-scoped where; throws 'update profile: no row returned'", () => {
    expect(body).toMatch(
      /const sets: Record<string, unknown> = \{ updatedAt: new Date\(\) \};\s*if \(args\.updates\.name !== undefined\) sets\.name = args\.updates\.name;\s*if \(args\.updates\.description !== undefined\) sets\.description = args\.updates\.description;/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('update profile: no row returned'\);/);
  });

  it('delete: L4b SOFT delete — UPDATE set {deletedAt, updatedAt} account-scoped + notDeleted (idempotent), returning {id} + length > 0; touch sets only lastUsedAt account-scoped + notDeleted', () => {
    expect(body).toMatch(
      /async delete\(args: \{ id: string; accountId: string \}\): Promise<boolean> \{\s*const now = new Date\(\);\s*const result = await this\.database\.db\s*\.update\(profiles\)\s*\.set\(\{ deletedAt: now, updatedAt: now \}\)\s*\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\), notDeleted\)\)\s*\.returning\(\{ id: profiles\.id \}\);\s*return result\.length > 0;\s*\}/,
    );
    expect(body).toMatch(
      /async touch\(args: \{ id: string; accountId: string; at: Date \}\): Promise<void> \{\s*await this\.database\.db\s*\.update\(profiles\)\s*\.set\(\{ lastUsedAt: args\.at \}\)\s*\.where\(and\(eq\(profiles\.id, args\.id\), eq\(profiles\.accountId, args\.accountId\), notDeleted\)\);\s*\}/,
    );
  });

  it('recordSave (doc-150 item 5): stamps lastSavedAt + (when provided) sizeBytes; account-scoped + notDeleted; sizeBytes undefined leaves the column untouched (no clobber-with-NULL)', () => {
    expect(body).toMatch(
      /async recordSave\(args: \{\s*id: string;\s*accountId: string;\s*at: Date;\s*sizeBytes\?: number;\s*\}\): Promise<void> \{/,
    );
    expect(body).toContain('const sets: Record<string, unknown> = { lastSavedAt: args.at };');
    expect(body).toContain('if (args.sizeBytes !== undefined) sets.sizeBytes = args.sizeBytes;');
  });

  it('L4b notDeleted predicate present: const notDeleted = isNull(profiles.deletedAt)', () => {
    expect(body).toMatch(/const notDeleted = isNull\(profiles\.deletedAt\);/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
