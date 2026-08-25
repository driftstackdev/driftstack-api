// W448.B — drift guard for apps/server/src/db/auth-repo.ts.
// DrizzleAccountAuthRepo backing the AccountAuthRepo contract. Drift
// here either drops the V-298a slug-taken 23505 unique-violation
// translation on updateAccountBasics (route layer would 500 instead
// of 409 on duplicate slug) or breaks findActiveWebSession's
// (tokenHash, gt(expiresAt, now), isNull(revokedAt)) triple-condition
// — expired/revoked sessions would silently authenticate.
//
//   • findApiKeyByPrefix: eq(keyPrefix) + limit 1.
//   • getAccount: id-only lookup + limit 1.
//   • findActiveRateLimitOverrides: and(accountId, gt(expiresAt, now));
//     refillPerSecondCenti / REFILL_CENTI_SCALE — V-016 centi-rate divide-back, reading the
//     scale from the repo that owns the column rather than repeating it (V-1266).
//   • touchApiKeyLastUsed: 30s-staleness skip rationale.
//   • findActiveWebSession: triple and(tokenHash, gt(expiresAt, now),
//     isNull(revokedAt)) + limit 1; 7-field WebSessionAuthRow incl.
//     mfaSatisfiedAt.
//   • findTeamMemberships: select id/ownerAccountId/role only + map
//     to {membershipId, ownerAccountId, role}.
//   • updateAccountBasics: selective spread + always-bump updatedAt;
//     V-298a unique-violation 23505 + constraint_name='accounts_slug_unique'
//     → throws SLUG_TAKEN.
//   • toApiKeyRow: 10-field ApiKeyRow.
//   • toAccountRow: 11-field AccountRow.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W448.B apps/server/src/db/auth-repo.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Drizzle-backed implementation of AccountAuthRepo.'", () => {
    expect(body).toMatch(/\/\/ Drizzle-backed implementation of AccountAuthRepo\./);
  });

  it('imports: and/eq/gt/isNull/lt/or from drizzle-orm; 6 service types; Database; 5 schema tables (accounts + apiKeys + rateLimitOverrides + teamMembers + webSessions)', () => {
    expect(body).toMatch(
      /import \{ and, eq, getTableColumns, gt, isNull, lt, or \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(
      /import type \{\s*AccountAuthRepo,\s*AccountRow,\s*ApiKeyRow,\s*RateLimitOverride,\s*TeamMembership,\s*WebSessionAuthRow,\s*\} from '\.\.\/services\/auth\.js';/,
    );
    expect(body).toMatch(
      /import \{ accounts, apiKeys, rateLimitOverrides, teamMembers, webSessions \} from '\.\/schema\.js';/,
    );
  });

  it('findApiKeyByPrefix + getAccount: each are limit 1 lookups', () => {
    expect(body).toMatch(
      /async findApiKeyByPrefix\(prefix: string\): Promise<ApiKeyRow \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(apiKeys\)\s*\.where\(eq\(apiKeys\.keyPrefix, prefix\)\)\s*\.limit\(1\);\s*return row \? toApiKeyRow\(row\) : null;\s*\}/,
    );
    expect(body).toMatch(
      /async getAccount\(id: string\): Promise<AccountRow \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(accounts\)\s*\.where\(eq\(accounts\.id, id\)\)\s*\.limit\(1\);\s*return row \? toAccountRow\(row\) : null;\s*\}/,
    );
  });

  it('findActiveRateLimitOverrides: and(eq(accountId), gt(expiresAt, now)); V-016 centi-rate divide-back (refillPerSecondCenti / 100); quantization caveat pinned', () => {
    expect(body).toMatch(
      /\.where\(\s*and\(eq\(rateLimitOverrides\.accountId, accountId\), gt\(rateLimitOverrides\.expiresAt, now\)\),\s*\);/,
    );
    expect(body).toMatch(
      /\/\/ Centi-rate stored as 100x; multiply back\. See V-016 for the\s*\/\/ quantization caveat \(1\/60 → 2 → 1\/50 effective\)\. Acceptable\s*\/\/ until\/unless an exact-match requirement emerges\./,
    );
    expect(body).toMatch(
      /import \{ REFILL_CENTI_SCALE \} from '\.\/rate-limit-overrides-repo\.js';/,
    );
    expect(body).toMatch(/refillPerSecond: r\.refillPerSecondCenti \/ REFILL_CENTI_SCALE,/);
  });

  it("touchApiKeyLastUsed: 30s staleness rationale 'Skip the write if last_used_at was set within the last 30s — saves a row update on every authenticated request.'", () => {
    expect(body).toMatch(
      /\/\/ Skip the write if last_used_at was set within the last 30s — saves\s*\/\/ a row update on every authenticated request\./,
    );
    // The throttle predicate MUST include both the null branch AND the
    // staleness comparison — a regression to `or(isNull(...))`-only silently
    // freezes last_used_at at first use (the row only updates while NULL).
    expect(body).toMatch(/const API_KEY_LAST_USED_THROTTLE_MS = 30_000;/);
    expect(body).toMatch(
      /or\(\s*isNull\(apiKeys\.lastUsedAt\),\s*lt\(apiKeys\.lastUsedAt, new Date\(at\.getTime\(\) - API_KEY_LAST_USED_THROTTLE_MS\)\),\s*\),/,
    );
  });

  it('findActiveWebSession: triple and(eq(tokenHash), gt(expiresAt, now), isNull(revokedAt)) + limit 1; 7-field WebSessionAuthRow incl. mfaSatisfiedAt', () => {
    expect(body).toMatch(/\.select\(getTableColumns\(webSessions\)\)/);
    expect(body).toMatch(/eq\(accounts\.authEpoch, webSessions\.authEpoch\)/);
    expect(body).toMatch(
      /\.where\(\s*and\(\s*eq\(webSessions\.tokenHash, args\.tokenHash\),\s*gt\(webSessions\.expiresAt, args\.now\),\s*isNull\(webSessions\.revokedAt\),\s*\),\s*\)\s*\.limit\(1\);/,
    );
    expect(body).toMatch(
      /return \{\s*id: row\.id,\s*accountId: row\.accountId,\s*expiresAt: row\.expiresAt,\s*revokedAt: row\.revokedAt,\s*lastUsedAt: row\.lastUsedAt,\s*mfaSatisfiedAt: row\.mfaSatisfiedAt,\s*createdAt: row\.createdAt,\s*\};/,
    );
  });

  it('touchWebSessionLastUsed: 1-field set lastUsedAt where id; findTeamMemberships joins active owners and maps the five-field grant', () => {
    expect(body).toMatch(
      /async touchWebSessionLastUsed\(id: string, at: Date\): Promise<void> \{\s*await this\.database\.db\s*\.update\(webSessions\)\s*\.set\(\{ lastUsedAt: at \}\)\s*\.where\(eq\(webSessions\.id, id\)\);\s*\}/,
    );
    expect(body).toMatch(
      /\.select\(\{\s*id: teamMembers\.id,\s*ownerAccountId: teamMembers\.ownerAccountId,\s*ownerEmail: accounts\.email,\s*ownerName: accounts\.name,\s*role: teamMembers\.role,\s*\}\)[\s\S]*?\.innerJoin\(accounts, eq\(accounts\.id, teamMembers\.ownerAccountId\)\)[\s\S]*?return rows\.map\(\(r\) => \(\{\s*membershipId: r\.id,\s*ownerAccountId: r\.ownerAccountId,\s*ownerEmail: r\.ownerEmail,\s*ownerName: r\.ownerName,\s*role: r\.role,\s*\}\)\);/,
    );
    expect(body).toMatch(
      /and\(eq\(teamMembers\.memberAccountId, memberAccountId\), eq\(accounts\.status, 'active'\)\)/,
    );
  });

  it("updateAccountBasics: selective spread (5 fields: name + timezone + avatarR2Key + slug + region) + always-bump updatedAt; V-298a 23505 + constraint_name='accounts_slug_unique' → throws 'SLUG_TAKEN'", () => {
    expect(body).toMatch(
      /const set: Record<string, unknown> = \{ updatedAt: new Date\(\) \};\s*if \(patch\.name !== undefined\) set\.name = patch\.name;\s*if \(patch\.timezone !== undefined\) set\.timezone = patch\.timezone;\s*if \(patch\.avatarR2Key !== undefined\) set\.avatarR2Key = patch\.avatarR2Key;\s*if \(patch\.slug !== undefined\) set\.slug = patch\.slug;\s*if \(patch\.region !== undefined\) set\.region = patch\.region;/,
    );
    expect(body).toMatch(
      /\/\/ V-298a — translate Postgres unique-violation on the slug\s*\/\/ index into a SlugTakenError so the route layer returns 409\./,
    );
    expect(body).toMatch(
      /if \(isUniqueViolation\(err, 'accounts_slug_unique'\)\) \{\s*throw new Error\('SLUG_TAKEN'\);/,
    );
  });

  it('toApiKeyRow: 11-field ApiKeyRow (id + accountId + name + keyPrefix + keyHash + scopes + lastUsedAt + revokedAt + expiresAt + provenance + createdAt)', () => {
    expect(body).toMatch(
      /function toApiKeyRow\(r: typeof apiKeys\.\$inferSelect\): ApiKeyRow \{\s*return \{\s*id: r\.id,\s*accountId: r\.accountId,\s*name: r\.name,\s*keyPrefix: r\.keyPrefix,\s*keyHash: r\.keyHash,\s*scopes: r\.scopes,\s*lastUsedAt: r\.lastUsedAt,\s*revokedAt: r\.revokedAt,\s*expiresAt: r\.expiresAt,\s*provenance: r\.provenance,\s*createdAt: r\.createdAt,\s*\};\s*\}/,
    );
  });

  it('toAccountRow: 11-field AccountRow (id + email + name + tier + status + timezone + avatarR2Key + slug + region + created/updated_at)', () => {
    expect(body).toMatch(
      /function toAccountRow\(r: typeof accounts\.\$inferSelect\): AccountRow \{\s*return \{\s*id: r\.id,\s*email: r\.email,\s*name: r\.name,\s*tier: r\.tier,\s*status: r\.status,\s*timezone: r\.timezone,\s*avatarR2Key: r\.avatarR2Key,\s*slug: r\.slug,\s*region: r\.region,\s*createdAt: r\.createdAt,\s*updatedAt: r\.updatedAt,\s*\};\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
