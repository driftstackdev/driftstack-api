// W449.B — drift guard for apps/server/src/db/auth-flows-repo.ts.
// V-079 DrizzleAuthFlowsRepo. Drift here either drops the
// findActiveAuthToken triple-condition (tokenHash, gt(expiresAt, now),
// isNull(consumedAt)) — expired or already-consumed tokens would
// authenticate — or breaks the markEmailVerified isNull(emailVerifiedAt)
// guard (re-clicking the verify link would bump emailVerifiedAt to
// a fresh timestamp, masking the original verification time used
// for audit/compliance trail).
//
//   • V-079 framing pinned (4-token-table dispatch + web_sessions +
//     accounts.password_hash + accounts.email_verified_at).
//   • tableForKind: 3-case kind→table dispatcher.
//   • toAccountRow: 8-field AuthFlowAccountRow.
//   • toTokenRow: 6-field AuthFlowTokenRow.
//   • toWebSessionRow: 10-field WebSessionRow incl. mfaSatisfiedAt.
//   • findAccountByEmail: trim().toLowerCase() canonicalize.
//   • createAccount: trim().toLowerCase() email canonicalize + 4-field
//     values + throws on no-row.
//   • setPassword: 2-field set (passwordHash + updatedAt).
//   • markEmailVerified: where and(eq(id), isNull(emailVerifiedAt))
//     — first-verify-wins, idempotent re-click no-op.
//   • findActiveAuthToken: triple and(tokenHash, gt(expiresAt, now),
//     isNull(consumedAt)) + limit 1.
//   • consumeAuthToken: where and(eq(id), isNull(consumedAt)) — first-
//     consume-wins (replay protection).
//   • revokeAllWebSessionsExcept: where and(accountId, isNull
//     (revokedAt), ne(id, exceptId)) — keeps current session live.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W449.B apps/server/src/db/auth-flows-repo.ts content parity', () => {
  const body = read(LIB);

  it("V-079 framing pinned: 'Drizzle-backed implementation of AuthFlowsRepo (V-079).' + 4-token-table + web_sessions + accounts.password_hash/email_verified_at rationale", () => {
    expect(body).toMatch(/\/\/ Drizzle-backed implementation of AuthFlowsRepo \(V-079\)\./);
    expect(body).toMatch(
      /\/\/ Maps the AuthFlowsService's domain shape onto the four token tables\s*\n?\s*\/\/ \(`email_verify_tokens`, `magic_link_tokens`, `password_reset_tokens`\)\s*\n?\s*\/\/ \+ `web_sessions` \+ the new `accounts\.password_hash` \/\s*\n?\s*\/\/ `accounts\.email_verified_at` columns\./,
    );
  });

  it('imports: and/desc/eq/gt/isNull/lt/ne/or/sql from drizzle-orm (2026-05-20 sweeper slice added lt/or/sql for stale-token deletion); 5 service types; Database; 5 schema tables (accounts + emailVerifyTokens + magicLinkTokens + passwordResetTokens + webSessions); AccountTier from @driftstack/api-types', () => {
    expect(body).toMatch(
      /import \{ and, desc, eq, gt, isNull, lt, ne, or, sql \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(
      /import type \{\s*\n?\s*AuthFlowAccountRow,\s*\n?\s*AuthFlowKind,\s*\n?\s*AuthFlowTokenRow,\s*\n?\s*AuthFlowsRepo,\s*\n?\s*WebSessionRow,\s*\n?\s*\} from '\.\.\/services\/auth-flows\.js';/,
    );
    expect(body).toMatch(
      /import \{\s*\n?\s*accounts,\s*\n?\s*emailVerifyTokens,\s*\n?\s*magicLinkTokens,\s*\n?\s*passwordResetTokens,\s*\n?\s*webSessions,\s*\n?\s*\} from '\.\/schema\.js';/,
    );
    expect(body).toMatch(/import type \{ AccountTier \} from '@driftstack\/api-types';/);
  });

  it("tableForKind: 3-case kind→table dispatcher ('email_verify'→emailVerifyTokens, 'magic_link'→magicLinkTokens, 'password_reset'→passwordResetTokens)", () => {
    expect(body).toMatch(
      /function tableForKind\(kind: AuthFlowKind\) \{\s*\n?\s*switch \(kind\) \{\s*\n?\s*case 'email_verify':\s*\n?\s*return emailVerifyTokens;\s*\n?\s*case 'magic_link':\s*\n?\s*return magicLinkTokens;\s*\n?\s*case 'password_reset':\s*\n?\s*return passwordResetTokens;\s*\n?\s*\}\s*\n?\s*\}/,
    );
  });

  it('toAccountRow: 8-field AuthFlowAccountRow (id + email + name + passwordHash + emailVerifiedAt + tier + status + createdAt); toTokenRow: 6-field AuthFlowTokenRow; toWebSessionRow: 10-field WebSessionRow incl. mfaSatisfiedAt', () => {
    expect(body).toMatch(
      /function toAccountRow\(r: typeof accounts\.\$inferSelect\): AuthFlowAccountRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*email: r\.email,\s*\n?\s*name: r\.name,\s*\n?\s*passwordHash: r\.passwordHash,\s*\n?\s*emailVerifiedAt: r\.emailVerifiedAt,\s*\n?\s*tier: r\.tier,\s*\n?\s*status: r\.status,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function toTokenRow<T extends typeof emailVerifyTokens\.\$inferSelect>\(r: T\): AuthFlowTokenRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*tokenHash: r\.tokenHash,\s*\n?\s*expiresAt: r\.expiresAt,\s*\n?\s*consumedAt: r\.consumedAt,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /function toWebSessionRow\(r: typeof webSessions\.\$inferSelect\): WebSessionRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*tokenHash: r\.tokenHash,\s*\n?\s*expiresAt: r\.expiresAt,\s*\n?\s*lastUsedAt: r\.lastUsedAt,\s*\n?\s*revokedAt: r\.revokedAt,\s*\n?\s*issuedFromIp: r\.issuedFromIp,\s*\n?\s*userAgent: r\.userAgent,\s*\n?\s*mfaSatisfiedAt: r\.mfaSatisfiedAt,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it("findAccountByEmail: where eq(email, email.trim().toLowerCase()) — email canonicalization at boundary; createAccount: same canonicalization on insert + 4-field core values (+ optional Arc 1 bundled-LLM consent/cap spread) + throws 'createAccount: insert returned no row'", () => {
    expect(body).toMatch(
      /\.where\(eq\(accounts\.email, email\.trim\(\)\.toLowerCase\(\)\)\)\s*\n?\s*\.limit\(1\);/,
    );
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*email: args\.email\.trim\(\)\.toLowerCase\(\),\s*\n?\s*name: args\.name,\s*\n?\s*passwordHash: args\.passwordHash,\s*\n?\s*tier: args\.initialTier,[\s\S]*?\}\)/,
    );
    expect(body).toMatch(
      /\.\.\.\(args\.bundledLlmConsent !== undefined\s*\n?\s*\? \{ bundledLlmConsent: args\.bundledLlmConsent \}\s*\n?\s*: \{\}\),/,
    );
    expect(body).toMatch(/if \(!row\) throw new Error\('createAccount: insert returned no row'\);/);
  });

  it('setPassword: 2-field set (passwordHash + updatedAt:new Date()); markEmailVerified: where and(eq(id), isNull(emailVerifiedAt)) — first-verify-wins guard (idempotent re-click no-op preserves original verification timestamp)', () => {
    expect(body).toMatch(
      /async setPassword\(accountId: string, passwordHash: string\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(accounts\)\s*\n?\s*\.set\(\{ passwordHash, updatedAt: new Date\(\) \}\)\s*\n?\s*\.where\(eq\(accounts\.id, accountId\)\);\s*\n?\s*\}/,
    );
    // C9 — markEmailVerified now returns the first-transition boolean.
    expect(body).toMatch(
      /async markEmailVerified\(accountId: string, at: Date\): Promise<boolean> \{[\s\S]*?\.set\(\{ emailVerifiedAt: at, updatedAt: at \}\)\s*\n?\s*\.where\(and\(eq\(accounts\.id, accountId\), isNull\(accounts\.emailVerifiedAt\)\)\)\s*\n?\s*\.returning\(\{ id: accounts\.id \}\);\s*\n?\s*return rows\.length > 0;/,
    );
  });

  it('findActiveAuthToken: triple and(eq(tokenHash), gt(expiresAt, now), isNull(consumedAt)) + limit 1 — expired/consumed tokens NEVER authenticate', () => {
    expect(body).toMatch(
      /\.where\(and\(eq\(t\.tokenHash, args\.tokenHash\), gt\(t\.expiresAt, args\.now\), isNull\(t\.consumedAt\)\)\)\s*\n?\s*\.limit\(1\);/,
    );
  });

  it('consumeAuthToken: where and(eq(id), isNull(consumedAt)) + returning → rows.length>0 — first-consume-wins replay protection, returns whether THIS call claimed the token (single-use under concurrency)', () => {
    expect(body).toMatch(
      /async consumeAuthToken\(args: \{ kind: AuthFlowKind; id: string; at: Date \}\): Promise<boolean> \{[\s\S]*?\.set\(\{ consumedAt: args\.at \}\)\s*\n?\s*\.where\(and\(eq\(t\.id, args\.id\), isNull\(t\.consumedAt\)\)\)\s*\n?\s*\.returning\(\{ id: t\.id \}\);[\s\S]*?return rows\.length > 0;/,
    );
  });

  it('findActiveWebSession: triple and(tokenHash, gt(expiresAt, now), isNull(revokedAt)) + limit 1; listActiveWebSessionsForAccount: 3-cond filter + orderBy desc(lastUsedAt)', () => {
    expect(body).toMatch(
      /\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(webSessions\.tokenHash, args\.tokenHash\),\s*\n?\s*gt\(webSessions\.expiresAt, args\.now\),\s*\n?\s*isNull\(webSessions\.revokedAt\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.limit\(1\);/,
    );
    expect(body).toMatch(
      /\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(webSessions\.accountId, accountId\),\s*\n?\s*isNull\(webSessions\.revokedAt\),\s*\n?\s*gt\(webSessions\.expiresAt, now\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.orderBy\(desc\(webSessions\.lastUsedAt\)\);/,
    );
  });

  it('revokeAllWebSessionsExcept: where and(accountId, isNull(revokedAt), ne(id, exceptId)) — keeps current session live; returning {id} → rows.length', () => {
    expect(body).toMatch(
      /async revokeAllWebSessionsExcept\(accountId: string, exceptId: string, at: Date\): Promise<number> \{[\s\S]*?\.where\(\s*\n?\s*and\(\s*\n?\s*eq\(webSessions\.accountId, accountId\),\s*\n?\s*isNull\(webSessions\.revokedAt\),\s*\n?\s*ne\(webSessions\.id, exceptId\),\s*\n?\s*\),\s*\n?\s*\)\s*\n?\s*\.returning\(\{ id: webSessions\.id \}\);\s*\n?\s*return rows\.length;/,
    );
  });

  it('markWebSessionMfaSatisfied: 1-field set mfaSatisfiedAt where id; revokeWebSession: where and(eq(id), isNull(revokedAt)) — idempotent revoke', () => {
    expect(body).toMatch(
      /async markWebSessionMfaSatisfied\(id: string, at: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\s*\n?\s*\.update\(webSessions\)\s*\n?\s*\.set\(\{ mfaSatisfiedAt: at \}\)\s*\n?\s*\.where\(eq\(webSessions\.id, id\)\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async revokeWebSession\(id: string, at: Date\): Promise<void> \{[\s\S]*?\.set\(\{ revokedAt: at \}\)\s*\n?\s*\.where\(and\(eq\(webSessions\.id, id\), isNull\(webSessions\.revokedAt\)\)\);/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
