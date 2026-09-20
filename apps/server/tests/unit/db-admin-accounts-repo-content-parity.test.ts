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
      /import type \{\s*AccountsAdminRepo,\s*ListAccountsArgs,\s*ListAccountsPage,\s*SetAccountTierOptions,\s*\} from '\.\.\/services\/admin-accounts\.js';/,
    );
    expect(body).toMatch(/import type \{ AccountRow \} from '\.\.\/services\/auth\.js';/);
  });

  it('findById: select * where eq(id) + limit 1 → toRow(row) or null', () => {
    expect(body).toMatch(
      /async findById\(id: string\): Promise<AccountRow \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.id, id\)\)\s*\.limit\(1\);\s*return row \? toRow\(row\) : null;\s*\}/,
    );
  });

  it("setTier: ONE transaction that locks accounts then credit_accounts, refuses Enterprise on a credits account with no contract figure, ends an admin_tier override when the tier changes, then updates accounts set tier + updatedAt returning(); setStatus: bare update with status enum 'active'|'suspended'|'deleted'", () => {
    // The lock order AND THE STRENGTH are both load-bearing, and the strength
    // is the one that is easy to get wrong. Every credit writer reaches this
    // same `accounts` row through a foreign key, which takes FOR KEY SHARE on
    // it; `for('update')` is the one strength that conflicts with that, so with
    // it here a refresh holding `credit_accounts` and this change holding
    // `accounts` deadlock (40P01, measured). `for('no key update')` is what the
    // UPDATE below takes anyway and still serialises two tier changes. The
    // deadlock itself is proved in
    // `an-admin-tier-change-holds-the-account-…`, arm THE OTHER ORDER DOES NOT
    // DEADLOCK; this pin is what stops the strength drifting back silently.
    expect(body).toMatch(
      /async setTier\(\s*id: string,\s*tier: AccountTier,\s*at: Date,\s*opts: SetAccountTierOptions = \{\},\s*\): Promise<AccountRow \| null> \{\s*return this\.database\.db\.transaction\(async \(tx\) => \{/,
    );
    expect(body).toMatch(
      /const \[current\] = await tx\s*\.select\(\{ tier: accounts\.tier \}\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.id, id\)\)\s*\.limit\(1\)\s*\.for\('no key update'\);\s*if \(current === undefined\) return null;\s*const \[credit\] = await tx\s*\.select\(\{ billingMode: creditAccounts\.billingMode \}\)\s*\.from\(creditAccounts\)\s*\.where\(eq\(creditAccounts\.accountId, id\)\)\s*\.limit\(1\)\s*\.for\('update'\);\s*const onCredits = credit\?\.billingMode === 'credits';/,
    );
    expect(body).toMatch(
      /if \(onCredits && tier === 'enterprise' && opts\.monthlyCredits === undefined\) \{\s*throw new BadRequestError\(/,
    );
    expect(body).toMatch(
      /if \(current\.tier !== tier\) await this\.endAdminTierOverride\(tx, id\);/,
    );
    expect(body).toMatch(
      /await this\.overrides\.upsert\(\s*\{\s*accountId: id,\s*monthlyCredits: opts\.monthlyCredits,\s*reason: 'contract',/,
    );
    // REVIEW B — `upsert` REPLACES the row, so an amendment that names only a
    // new figure must carry the standing agreement's anchor day and own-key
    // permission forward by hand. `anchor_at` is what the whole month calendar
    // is counted from (`coverageCandidatesSql`), so losing it moves the
    // customer's reset day and pays them a short window at a full month's
    // level. Measured, and held by the two AMENDMENT arms of
    // `an-admin-tier-change-holds-the-account-…`.
    expect(body).toMatch(
      /const standing = await this\.overrides\.get\(id, tx\);\s*const contract =\s*standing !== null && standing\.reason === 'contract' \? standing : null;/,
    );
    expect(body).toMatch(
      /\.\.\.\(contract === null\s*\? \{\}\s*: \{ anchorAt: contract\.anchorAt, ownKeyAllowed: contract\.ownKeyAllowed \}\),\s*setByKeyId: opts\.setByKeyId \?\? null,\s*note: opts\.note \?\? contract\?\.note \?\? '',/,
    );
    expect(body).toMatch(
      /const \[row\] = await tx\s*\.update\(accounts\)\s*\.set\(\{ tier, updatedAt: at \}\)\s*\.where\(eq\(accounts\.id, id\)\)\s*\.returning\(\);\s*return row \? toRow\(row\) : null;/,
    );
    expect(body).toMatch(
      /async setStatus\(\s*id: string,\s*status: 'active' \| 'suspended' \| 'deleted',\s*at: Date,\s*\): Promise<AccountRow \| null> \{/,
    );
  });

  it("list: limit cap = Math.min(args.limit ?? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX), with both constants EXPORTED (V-1245 — the in-memory double imports them, so the export keyword is load-bearing); filters with status eq + tier eq + emailContains via ilike '%${lower}%' (length > 0 guard)", () => {
    expect(body).toMatch(/export const ADMIN_ACCOUNTS_PAGE_DEFAULT = 50;/);
    expect(body).toMatch(/export const ADMIN_ACCOUNTS_PAGE_MAX = 100;/);
    expect(body).toMatch(
      /const limit = Math\.min\(args\.limit \?\? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX\);/,
    );
    expect(body).toMatch(
      /if \(args\.status !== undefined\) filters\.push\(eq\(accounts\.status, args\.status\)\);\s*if \(args\.tier !== undefined\) filters\.push\(eq\(accounts\.tier, args\.tier\)\);\s*if \(args\.emailContains !== undefined && args\.emailContains\.length > 0\) \{\s*filters\.push\(ilike\(accounts\.email, `%\$\{args\.emailContains\.toLowerCase\(\)\}%`\)\);\s*\}/,
    );
  });

  it('Composite cursor over (createdAt, id): lookup row by id via 2-field select; OR(lt(createdAt), and(eq(createdAt), lt(id))) — required because multiple accounts can share createdAt', () => {
    expect(body).toMatch(
      /if \(args\.cursor !== undefined && parseUuidCursor\(args\.cursor\) !== undefined\) \{\s*const \[cursorRow\] = await this\.database\.db\s*\.select\(\{ createdAt: accounts\.createdAt, id: accounts\.id \}\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.id, args\.cursor\)\)\s*\.limit\(1\);\s*if \(cursorRow !== undefined\) \{\s*const cursorClause = or\(\s*lt\(accounts\.createdAt, cursorRow\.createdAt\),\s*and\(eq\(accounts\.createdAt, cursorRow\.createdAt\), lt\(accounts\.id, cursorRow\.id\)\),\s*\);\s*if \(cursorClause !== undefined\) filters\.push\(cursorClause\);\s*\}\s*\}/,
    );
  });

  it('Query orderBy desc(createdAt), desc(id); limit+1 hasMore + slice; nextCursor = last id', () => {
    expect(body).toMatch(
      /\.orderBy\(desc\(accounts\.createdAt\), desc\(accounts\.id\)\)\s*\.limit\(limit \+ 1\);\s*const hasMore = rows\.length > limit;\s*const data = rows\.slice\(0, limit\)\.map\(toRow\);\s*const nextCursor = hasMore && data\.length > 0 \? data\[data\.length - 1\]!\.id : null;\s*return \{ data, hasMore, nextCursor \};/,
    );
  });

  it('countByStatus: select count(*)::int where status eq; row?.cnt ?? 0', () => {
    expect(body).toMatch(
      /async countByStatus\(status: 'active' \| 'suspended' \| 'deleted'\): Promise<number> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\{ cnt: sql<number>`count\(\*\)::int` \}\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.status, status\)\);\s*return row\?\.cnt \?\? 0;\s*\}/,
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
      /function emptyTierCounts\(\): Record<AccountTier, number> \{\s*const out = \{\} as Record<AccountTier, number>;\s*for \(const tier of AccountTierSchema\.options\) out\[tier\] = 0;\s*return out;\s*\}/,
    );
  });

  it('countCreatedSince: select count(*)::int where gte(createdAt, since); row?.cnt ?? 0', () => {
    expect(body).toMatch(/async countCreatedSince\(since: Date\): Promise<number> \{/);
    expect(body).toMatch(/\.where\(gte\(accounts\.createdAt, since\)\);/);
  });

  it('toRow: 11-field AccountRow (id + email + name + tier + status + V-237 timezone + V-352b avatarR2Key + V-298a slug + V-298b region + created/updated_at)', () => {
    expect(body).toMatch(
      /function toRow\(r: typeof accounts\.\$inferSelect\): AccountRow \{\s*return \{\s*id: r\.id,\s*email: r\.email,\s*name: r\.name,\s*tier: r\.tier,\s*status: r\.status,\s*timezone: r\.timezone,\s*avatarR2Key: r\.avatarR2Key,\s*slug: r\.slug,\s*region: r\.region,\s*createdAt: r\.createdAt,\s*updatedAt: r\.updatedAt,\s*\};\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
