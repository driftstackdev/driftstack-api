// W1005 — db/admin-accounts-repo cross-source invariant. Three-
// hundred-thirty-first in the drift-guard series. Pins the apps/
// server/src/db/admin-accounts-repo.ts Drizzle admin-accounts repo:
//
//   Header — 'Drizzle-backed AccountsAdminRepo. Updates accounts.tier
//   / accounts.status'.
//
//   DrizzleAccountsAdminRepo 7-method surface — findById + setTier +
//     setStatus + list + countByStatus + countByTier + countCreatedSince.
//
//   status 3-value union — 'active' | 'suspended' | 'deleted'.
//
//   list 50/100 limit clamp, now named ADMIN_ACCOUNTS_PAGE_* and exported (V-1245) — Math.min(args.limit ?? 50, 100).
//
//   list 3-filter — status (eq) + tier (eq) + emailContains
//     (ilike(accounts.email, `%${lowercased}%`)).
//
//   list compound-cursor — loads (createdAt, id) of cursor account,
//     then or(lt(createdAt, c.createdAt), and(eq(createdAt, c.
//     createdAt), lt(id, c.id))). The tuple-compare tiebreaker keeps
//     pagination stable.
//
//   list orderBy desc(createdAt) + desc(id) + limit+1 hasMore probe.
//
//   countByStatus sql<number>`count(*)::int` for bigint→int coercion.
//
//   countByTier groupBy(accounts.tier) → zero-filled Record over
//     AccountTierSchema.options (every AccountTier present).
//
//   countCreatedSince count(*)::int where gte(createdAt, since) —
//     backs the signup-window stats.
//
//   toRow 11-field shape — id + email + name + tier + status +
//     timezone + avatarR2Key + slug + region + createdAt + updatedAt
//     (matches W993 toAccountRow shape).
//
// stays in lockstep across apps/server/src/db/admin-accounts-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1005 db/admin-accounts-repo cross-source invariant', () => {
  // ─── Header + impl ───────────────────────────────────────────

  it("CRITICAL apps/server/src/db/admin-accounts-repo.ts header — 'Drizzle-backed AccountsAdminRepo. Updates accounts.tier / accounts.status'. The tier-and-status focus is the admin-side mutation contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(
      /\/\/ Drizzle-backed AccountsAdminRepo\. Updates accounts\.tier \/ accounts\.status\./,
    );
    expect(p).toMatch(/export class DrizzleAccountsAdminRepo implements AccountsAdminRepo \{/);
  });

  // ─── 7-method surface ────────────────────────────────────────

  it('CRITICAL 7-method surface — findById + setTier + setStatus + list + countByStatus + countByTier + countCreatedSince. The admin contract covers id-lookup + 2 mutations + paged-list + status-count + tier-distribution + signup-window count.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(/async findById\(id: string\): Promise<AccountRow \| null> \{/);
    expect(p).toMatch(
      /async setTier\(id: string, tier: AccountTier, at: Date\): Promise<AccountRow \| null> \{/,
    );
    expect(p).toMatch(/async setStatus\(/);
    expect(p).toMatch(/async list\(args: ListAccountsArgs\): Promise<ListAccountsPage> \{/);
    expect(p).toMatch(
      /async countByStatus\(status: 'active' \| 'suspended' \| 'deleted'\): Promise<number> \{/,
    );
    expect(p).toMatch(/async countByTier\(\): Promise<Record<AccountTier, number>> \{/);
    expect(p).toMatch(/\.groupBy\(accounts\.tier\);/);
    expect(p).toMatch(/async countCreatedSince\(since: Date\): Promise<number> \{/);
    expect(p).toMatch(/\.where\(gte\(accounts\.createdAt, since\)\);/);
  });

  // ─── status 3-value union ────────────────────────────────────

  it("CRITICAL status 3-value union — 'active' | 'suspended' | 'deleted'. The 3-value lifecycle covers the admin-controllable account states.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(/status: 'active' \| 'suspended' \| 'deleted',/);
  });

  // ─── setTier + setStatus 2-field touch ───────────────────────

  it("CRITICAL setTier + setStatus each set the field + updatedAt + returning() + null on missing. The 2-field touch keeps updatedAt fresh and exposes the post-update row to callers. setStatus ALSO stamps deletedAt when transitioning to 'deleted' (GDPR Article 17, migration 0094) — powers the account-deletion-purge-sweeper's retention cutoff.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(/\.set\(\{ tier, updatedAt: at \}\)/);
    expect(p).toMatch(
      /\.set\(\{ status, updatedAt: at, \.\.\.\(status === 'deleted' \? \{ deletedAt: at \} : \{\}\) \}\)/,
    );
    expect(p).toMatch(/\.where\(eq\(accounts\.id, id\)\)/);
    expect(p).toMatch(/return row \? toRow\(row\) : null;/);
  });

  // ─── list 50/100 limit clamp ─────────────────────────────────

  it('CRITICAL list limit clamp — Math.min(args.limit ?? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX). The 50-default + 100-max keeps admin pagination bounded. V-1245 — named and exported so the in-memory double reads them rather than carrying a second copy of the same two numbers.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(/export const ADMIN_ACCOUNTS_PAGE_DEFAULT = 50;/);
    expect(p).toMatch(/export const ADMIN_ACCOUNTS_PAGE_MAX = 100;/);
    expect(p).toMatch(
      /const limit = Math\.min\(args\.limit \?\? ADMIN_ACCOUNTS_PAGE_DEFAULT, ADMIN_ACCOUNTS_PAGE_MAX\);/,
    );
  });

  // ─── list 3-filter ───────────────────────────────────────────

  it("CRITICAL list 3-filter — status (eq) + tier (eq) + emailContains (ilike with lowercased pattern). The ilike + %wrap + lowercase combo lets admin search 'all caps' or 'mixed' email substrings.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(
      /if \(args\.status !== undefined\) filters\.push\(eq\(accounts\.status, args\.status\)\);/,
    );
    expect(p).toMatch(
      /if \(args\.tier !== undefined\) filters\.push\(eq\(accounts\.tier, args\.tier\)\);/,
    );
    expect(p).toMatch(
      /if \(args\.emailContains !== undefined && args\.emailContains\.length > 0\) \{/,
    );
    expect(p).toMatch(
      /filters\.push\(ilike\(accounts\.email, `%\$\{args\.emailContains\.toLowerCase\(\)\}%`\)\);/,
    );
  });

  // ─── list compound-cursor ────────────────────────────────────

  it('CRITICAL list compound-cursor — loads (createdAt, id) of cursor account, then or(lt(createdAt, c.createdAt), and(eq(createdAt, c.createdAt), lt(id, c.id))). The tuple-compare tiebreaker keeps pagination stable under createdAt-ties.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(/\.select\(\{ createdAt: accounts\.createdAt, id: accounts\.id \}\)/);
    expect(p).toMatch(/\.where\(eq\(accounts\.id, args\.cursor\)\)/);
    expect(p).toMatch(/const cursorClause = or\(/);
    expect(p).toMatch(/lt\(accounts\.createdAt, cursorRow\.createdAt\),/);
    expect(p).toMatch(
      /and\(eq\(accounts\.createdAt, cursorRow\.createdAt\), lt\(accounts\.id, cursorRow\.id\)\),/,
    );
    expect(p).toMatch(/if \(cursorClause !== undefined\) filters\.push\(cursorClause\);/);
  });

  it('CRITICAL list orderBy desc(createdAt) + desc(id) + limit+1 hasMore + nextCursor = last item id when hasMore. The 3-field paged response uses last-id keyset.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(/\.orderBy\(desc\(accounts\.createdAt\), desc\(accounts\.id\)\)/);
    expect(p).toMatch(/\.limit\(limit \+ 1\);/);
    expect(p).toMatch(/const hasMore = rows\.length > limit;/);
    expect(p).toMatch(/const data = rows\.slice\(0, limit\)\.map\(toRow\);/);
    expect(p).toMatch(
      /const nextCursor = hasMore && data\.length > 0 \? data\[data\.length - 1\]!\.id : null;/,
    );
    expect(p).toMatch(/return \{ data, hasMore, nextCursor \};/);
  });

  it("CRITICAL list emits 'where(filters.length === 0 ? undefined : and(...filters))'. The undefined-on-empty design lets drizzle skip emitting WHERE.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(
      /const whereClause = filters\.length === 0 \? undefined : and\(\.\.\.filters\);/,
    );
  });

  // ─── countByStatus ──────────────────────────────────────────

  it('CRITICAL countByStatus uses sql<number>`count(*)::int`. The ::int cast keeps Postgres bigint from leaking as JS string.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(/\.select\(\{ cnt: sql<number>`count\(\*\)::int` \}\)/);
    expect(p).toMatch(/\.where\(eq\(accounts\.status, status\)\);/);
    expect(p).toMatch(/return row\?\.cnt \?\? 0;/);
  });

  // ─── toRow 11-field shape ────────────────────────────────────

  it('CRITICAL toRow 11-field shape — id + email + name + tier + status + timezone + avatarR2Key + slug + region + createdAt + updatedAt. The 11-field AccountRow matches the W993 db/auth-repo toAccountRow shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/admin-accounts-repo.ts'));
    expect(p).toMatch(/function toRow\(r: typeof accounts\.\$inferSelect\): AccountRow \{/);
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/email: r\.email,/);
    expect(p).toMatch(/name: r\.name,/);
    expect(p).toMatch(/tier: r\.tier,/);
    expect(p).toMatch(/status: r\.status,/);
    expect(p).toMatch(/timezone: r\.timezone,/);
    expect(p).toMatch(/avatarR2Key: r\.avatarR2Key,/);
    expect(p).toMatch(/slug: r\.slug,/);
    expect(p).toMatch(/region: r\.region,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
    expect(p).toMatch(/updatedAt: r\.updatedAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-admin-accounts-repo-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
