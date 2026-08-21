// W445.B — drift guard for apps/server/src/db/admin-accounts-repo.ts.
// AccountsAdminRepo with admin list filters + composite cursor +
// ilike email-contains search. Drift here either drops the ilike
// pattern (case-sensitive email search breaks dashboard "find by
// email" UX) or the composite (createdAt, id) cursor (admin list
// scroll silently skips/duplicates same-timestamp rows).
//
//   • Updates accounts.tier / accounts.status framing pinned.
//   • findById + setTier (returning) + setStatus (returning).
//   • list: limit cap Math.min(args.limit ?? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX),
//     both exported for the in-memory double (V-1245).
//   • Filters: status eq, tier eq, emailContains via ilike with
//     '%${lowerCased}%' pattern.
//   • Composite cursor over (createdAt, id) — same as profile-
//     snapshots-repo (multiple accounts can share createdAt).
//   • orderBy desc(createdAt), desc(id); limit+1 hasMore;
//     nextCursor = last id.
//   • countByStatus: select count(*)::int where status; row?.cnt ?? 0.
//   • countByTier: select tier + count(*)::int groupBy tier; zero-fill
//     from AccountTierSchema.options (every tier present).
//   • countCreatedSince: select count(*)::int where gte(createdAt,
//     since); row?.cnt ?? 0.
//   • toRow: 11-field AccountRow including V-237 timezone, V-352b
//     avatarR2Key, V-298a slug, V-298b region.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W445.B apps/server/src/db/admin-accounts-repo.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Drizzle-backed AccountsAdminRepo. Updates accounts.tier / accounts.status.'", () => {
    expect(body).toMatch(
      /\/\/ Drizzle-backed AccountsAdminRepo\. Updates accounts\.tier \/ accounts\.status\./,
    );
  });

  it('imports: SQL type + and/desc/eq/ilike/lt/or/sql; AccountTier; AccountsAdminRepo/ListAccountsArgs/Page; AccountRow; Database; accounts schema', () => {
    expect(body).toMatch(
      /import \{ type SQL, and, desc, eq, gte, ilike, lt, or, sql \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(
      /import \{ AccountTierSchema, type AccountTier \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*AccountsAdminRepo,\s*\n?\s*ListAccountsArgs,\s*\n?\s*ListAccountsPage,\s*\n?\s*\} from '\.\.\/services\/admin-accounts\.js';/,
    );
    expect(body).toMatch(/import type \{ AccountRow \} from '\.\.\/services\/auth\.js';/);
  });

  it('findById: select * where eq(id) + limit 1 → toRow(row) or null', () => {
    expect(body).toMatch(
      /async findById\(id: string\): Promise<AccountRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(accounts\)\s*\n?\s*\.where\(eq\(accounts\.id, id\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toRow\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it("setTier: update accounts set tier + updatedAt where id returning(); setStatus: same pattern with status enum 'active'|'suspended'|'deleted'", () => {
    expect(body).toMatch(
      /async setTier\(id: string, tier: AccountTier, at: Date\): Promise<AccountRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.update\(accounts\)\s*\n?\s*\.set\(\{ tier, updatedAt: at \}\)\s*\n?\s*\.where\(eq\(accounts\.id, id\)\)\s*\n?\s*\.returning\(\);\s*\n?\s*return row \? toRow\(row\) : null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async setStatus\(\s*\n?\s*id: string,\s*\n?\s*status: 'active' \| 'suspended' \| 'deleted',\s*\n?\s*at: Date,\s*\n?\s*\): Promise<AccountRow \| null> \{/,
    );
  });

  it("list: limit cap = Math.min(args.limit ?? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX), with both constants EXPORTED (V-1245 — the in-memory double imports them, so the export keyword is load-bearing); filters with status eq + tier eq + emailContains via ilike '%${lower}%' (length > 0 guard)", () => {
    expect(body).toMatch(/export const ADMIN_ACCOUNTS_PAGE_DEFAULT = 50;/);
    expect(body).toMatch(/export const ADMIN_ACCOUNTS_PAGE_MAX = 100;/);
    expect(body).toMatch(
      /const limit = Math\.min\(args\.limit \?\? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX\);/,
    );
    expect(body).toMatch(
      /if \(args\.status !== undefined\) filters\.push\(eq\(accounts\.status, args\.status\)\);\s*\n?\s*if \(args\.tier !== undefined\) filters\.push\(eq\(accounts\.tier, args\.tier\)\);\s*\n?\s*if \(args\.emailContains !== undefined && args\.emailContains\.length > 0\) \{\s*\n?\s*filters\.push\(ilike\(accounts\.email, `%\$\{args\.emailContains\.toLowerCase\(\)\}%`\)\);\s*\n?\s*\}/,
    );
  });

  it('Composite cursor over (createdAt, id): lookup row by id via 2-field select; OR(lt(createdAt), and(eq(createdAt), lt(id))) — required because multiple accounts can share createdAt', () => {
    expect(body).toMatch(
      /if \(args\.cursor !== undefined && parseUuidCursor\(args\.cursor\) !== undefined\) \{\s*\n?\s*const \[cursorRow\] = await this\.database\.db\s*\n?\s*\.select\(\{ createdAt: accounts\.createdAt, id: accounts\.id \}\)\s*\n?\s*\.from\(accounts\)\s*\n?\s*\.where\(eq\(accounts\.id, args\.cursor\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*if \(cursorRow !== undefined\) \{\s*\n?\s*const cursorClause = or\(\s*\n?\s*lt\(accounts\.createdAt, cursorRow\.createdAt\),\s*\n?\s*and\(eq\(accounts\.createdAt, cursorRow\.createdAt\), lt\(accounts\.id, cursorRow\.id\)\),\s*\n?\s*\);\s*\n?\s*if \(cursorClause !== undefined\) filters\.push\(cursorClause\);\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('Query orderBy desc(createdAt), desc(id); limit+1 hasMore + slice; nextCursor = last id', () => {
    expect(body).toMatch(
      /\.orderBy\(desc\(accounts\.createdAt\), desc\(accounts\.id\)\)\s*\n?\s*\.limit\(limit \+ 1\);\s*\n?\s*const hasMore = rows\.length > limit;\s*\n?\s*const data = rows\.slice\(0, limit\)\.map\(toRow\);\s*\n?\s*const nextCursor = hasMore && data\.length > 0 \? data\[data\.length - 1\]!\.id : null;\s*\n?\s*return \{ data, hasMore, nextCursor \};/,
    );
  });

  it('countByStatus: select count(*)::int where status eq; row?.cnt ?? 0', () => {
    expect(body).toMatch(
      /async countByStatus\(status: 'active' \| 'suspended' \| 'deleted'\): Promise<number> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\{ cnt: sql<number>`count\(\*\)::int` \}\)\s*\n?\s*\.from\(accounts\)\s*\n?\s*\.where\(eq\(accounts\.status, status\)\);\s*\n?\s*return row\?\.cnt \?\? 0;\s*\n?\s*\}/,
    );
  });

  it('countByTier: select tier + count(*)::int groupBy tier; zero-fill from AccountTierSchema.options', () => {
    expect(body).toMatch(/async countByTier\(\): Promise<Record<AccountTier, number>> \{/);
    expect(body).toMatch(
      /\.select\(\{ tier: accounts\.tier, cnt: sql<number>`count\(\*\)::int` \}\)/,
    );
    expect(body).toMatch(/\.groupBy\(accounts\.tier\);/);
    expect(body).toMatch(/const out = emptyTierCounts\(\);/);
    expect(body).toMatch(/for \(const row of rows\) out\[row\.tier\] = row\.cnt;/);
    expect(body).toMatch(
      /function emptyTierCounts\(\): Record<AccountTier, number> \{\s*\n?\s*const out = \{\} as Record<AccountTier, number>;\s*\n?\s*for \(const tier of AccountTierSchema\.options\) out\[tier\] = 0;\s*\n?\s*return out;\s*\n?\s*\}/,
    );
  });

  it('countCreatedSince: select count(*)::int where gte(createdAt, since); row?.cnt ?? 0', () => {
    expect(body).toMatch(/async countCreatedSince\(since: Date\): Promise<number> \{/);
    expect(body).toMatch(/\.where\(gte\(accounts\.createdAt, since\)\);/);
  });

  it('toRow: 11-field AccountRow (id + email + name + tier + status + V-237 timezone + V-352b avatarR2Key + V-298a slug + V-298b region + created/updated_at)', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof accounts\.\$inferSelect\): AccountRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*email: r\.email,\s*\n?\s*name: r\.name,\s*\n?\s*tier: r\.tier,\s*\n?\s*status: r\.status,\s*\n?\s*timezone: r\.timezone,\s*\n?\s*avatarR2Key: r\.avatarR2Key,\s*\n?\s*slug: r\.slug,\s*\n?\s*region: r\.region,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*updatedAt: r\.updatedAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
