// W1004 — db/auth-flows-repo V-079 cross-source invariant. Three-
// hundred-thirtieth in the drift-guard series. Pins the apps/server/
// src/db/auth-flows-repo.ts Drizzle auth-flows repo primitive:
//
//   V-079 anchor — 'Drizzle-backed implementation of AuthFlowsRepo
//   (V-079)'.
//
//   Surface framing — 'Maps the AuthFlowsService's domain shape onto
//   the four token tables (email_verify_tokens, magic_link_tokens,
//   password_reset_tokens) + web_sessions + the new accounts.
//   password_hash / accounts.email_verified_at columns'.
//
//   tableForKind 3-branch dispatch — 'email_verify' →
//     emailVerifyTokens; 'magic_link' → magicLinkTokens;
//     'password_reset' → passwordResetTokens.
//
//   DrizzleAuthFlowsRepo 15-method surface — findAccountByEmail +
//     findAccountById + createAccount + setPassword +
//     markEmailVerified + insertAuthToken + findActiveAuthToken +
//     consumeAuthToken + insertWebSession + findActiveWebSession +
//     touchWebSession + revokeWebSession + listActiveWebSessionsFor-
//     Account + findWebSessionByIdForAccount + revokeAllWebSessions-
//     Except + markWebSessionMfaSatisfied.
//
//   Email normalisation — 'email.trim().toLowerCase()' applied at
//     findAccountByEmail + createAccount. The trim+lower is what
//     prevents case-sensitive email-uniqueness collisions.
//
//   markEmailVerified once-only guard — and(eq(id), isNull
//     (emailVerifiedAt)). The IS-NULL prevents overwriting verified-at
//     once it's set.
//
//   findActiveAuthToken 3-cond — eq(tokenHash) + gt(expiresAt, now)
//     + isNull(consumedAt). The 3-cond AND ensures only active +
//     unexpired + un-consumed tokens match.
//
//   consumeAuthToken isNull(consumedAt) double-check — single-use
//     guarantee (replay-safe).
//
//   findActiveWebSession 3-cond — eq(tokenHash) + gt(expiresAt) +
//     isNull(revokedAt).
//
//   listActiveWebSessionsForAccount 3-cond + orderBy desc
//     (lastUsedAt). The newest-active-first ordering matches the
//     /account/web-sessions list.
//
//   revokeAllWebSessionsExcept — and(eq(accountId), isNull
//     (revokedAt), ne(id, exceptId)) + returning({id}).length. The
//     ne(id, exceptId) excludes the calling session.
//
//   markWebSessionMfaSatisfied V-353e wire — set(mfaSatisfiedAt) +
//     where(eq(id)).
//
//   toAccountRow 8-field shape — id + email + name + passwordHash +
//     emailVerifiedAt + tier + status + createdAt.
//
//   toTokenRow 6-field shape — id + accountId + tokenHash +
//     expiresAt + consumedAt + createdAt.
//
//   toWebSessionRow 10-field shape — id + accountId + tokenHash +
//     expiresAt + lastUsedAt + revokedAt + issuedFromIp + userAgent
//     + mfaSatisfiedAt + createdAt.
//
// stays in lockstep across apps/server/src/db/auth-flows-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W1004 db/auth-flows-repo V-079 cross-source invariant', () => {
  // ─── V-079 anchor + 4-table framing ──────────────────────────

  it("CRITICAL apps/server/src/db/auth-flows-repo.ts header pins V-079 — 'Drizzle-backed implementation of AuthFlowsRepo (V-079). Maps the AuthFlowsService's domain shape onto the four token tables (email_verify_tokens, magic_link_tokens, password_reset_tokens) + web_sessions + the new accounts.password_hash / accounts.email_verified_at columns'. The 4-table mapping is the V-079 auth-flows storage contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed implementation of AuthFlowsRepo \(V-079\)\./);
    expect(p).toMatch(/Maps the AuthFlowsService's domain shape onto the four token tables/);
    expect(p).toMatch(/\(`email_verify_tokens`, `magic_link_tokens`, `password_reset_tokens`\)/);
    expect(p).toMatch(/\+ `web_sessions` \+ the new `accounts\.password_hash` \//);
    expect(p).toMatch(/`accounts\.email_verified_at` columns\./);
  });

  // ─── tableForKind 3-branch dispatch ──────────────────────────

  it("CRITICAL tableForKind 3-branch dispatch — 'email_verify' → emailVerifyTokens + 'magic_link' → magicLinkTokens + 'password_reset' → passwordResetTokens. The 3-kind dispatch lets insert/find/consume share one method body across the 3 tables.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/function tableForKind\(kind: AuthFlowKind\) \{/);
    expect(p).toMatch(/case 'email_verify':/);
    expect(p).toMatch(/return emailVerifyTokens;/);
    expect(p).toMatch(/case 'magic_link':/);
    expect(p).toMatch(/return magicLinkTokens;/);
    expect(p).toMatch(/case 'password_reset':/);
    expect(p).toMatch(/return passwordResetTokens;/);
  });

  // ─── Email normalisation ─────────────────────────────────────

  it("CRITICAL findAccountByEmail + createAccount apply 'email.trim().toLowerCase()'. The trim+lower normalisation is what prevents case-sensitive email collisions + leading/trailing whitespace.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/\.where\(eq\(accounts\.email, email\.trim\(\)\.toLowerCase\(\)\)\)/);
    expect(p).toMatch(/email: args\.email\.trim\(\)\.toLowerCase\(\),/);
  });

  // ─── markEmailVerified once-only guard ───────────────────────

  it('CRITICAL markEmailVerified once-only guard — and(eq(id), isNull(emailVerifiedAt)) — prevents overwriting the verification timestamp. The IS-NULL guard preserves the original verification date.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/\.set\(\{ emailVerifiedAt: at, updatedAt: at \}\)/);
    // C9 — the guarded UPDATE now chains .returning({ id }) and returns the
    // first-transition boolean (rows.length > 0), like consumeAuthToken.
    expect(p).toMatch(
      /\.where\(and\(eq\(accounts\.id, accountId\), isNull\(accounts\.emailVerifiedAt\)\)\)\s*\.returning\(\{ id: accounts\.id \}\);\s*return rows\.length > 0;/,
    );
  });

  // ─── findActiveAuthToken 3-cond ──────────────────────────────

  it('CRITICAL findActiveAuthToken 3-cond — eq(tokenHash) + gt(expiresAt, now) + isNull(consumedAt). The 3-cond AND ensures only active+unexpired+unconsumed tokens match.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(
      /\.where\(and\(eq\(t\.tokenHash, args\.tokenHash\), gt\(t\.expiresAt, args\.now\), isNull\(t\.consumedAt\)\)\)/,
    );
  });

  // ─── consumeAuthToken isNull double-check ────────────────────

  it('CRITICAL consumeAuthToken isNull(consumedAt) double-check — and(eq(id), isNull(consumedAt)) + returning({id})→rows.length. The IS-NULL guard makes consume idempotent + replay-safe (a concurrent/second consume claims 0 rows → returns false → caller rejects).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/\.set\(\{ consumedAt: args\.at \}\)/);
    // .where(...) now chains to .returning({ id }) (no trailing ;) so the call
    // reports whether it claimed the row — single-use under concurrency.
    expect(p).toMatch(
      /\.where\(and\(eq\(t\.id, args\.id\), isNull\(t\.consumedAt\)\)\)\s*\.returning\(\{ id: t\.id \}\);[\s\S]*?return rows\.length > 0;/,
    );
  });

  it('CRITICAL reset-family claim is one account-scoped conditional UPDATE and returns true only when the presented id was claimed', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(
      /async consumeAuthTokenFamily\(args: \{[\s\S]*?\.where\(and\(eq\(t\.accountId, args\.accountId\), isNull\(t\.consumedAt\)\)\)[\s\S]*?return rows\.some\(\(row\) => row\.id === args\.id\);/,
    );
  });

  // ─── findActiveWebSession 3-cond ─────────────────────────────

  it('CRITICAL findActiveWebSession 3-cond — eq(tokenHash) + gt(expiresAt, now) + isNull(revokedAt). The 3-cond AND matches the W993 (auth-repo) same-shape contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/eq\(webSessions\.tokenHash, args\.tokenHash\),/);
    expect(p).toMatch(/gt\(webSessions\.expiresAt, args\.now\),/);
    expect(p).toMatch(/isNull\(webSessions\.revokedAt\),/);
  });

  // ─── listActiveWebSessionsForAccount 3-cond + orderBy ────────

  it('CRITICAL listActiveWebSessionsForAccount 3-cond — eq(accountId) + isNull(revokedAt) + gt(expiresAt) + orderBy desc(lastUsedAt). The newest-active-first ordering matches /account/web-sessions list.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/eq\(webSessions\.accountId, accountId\),/);
    expect(p).toMatch(/isNull\(webSessions\.revokedAt\),/);
    expect(p).toMatch(/gt\(webSessions\.expiresAt, now\),/);
    expect(p).toMatch(/\.orderBy\(desc\(webSessions\.lastUsedAt\)\);/);
  });

  // ─── revokeWebSession isNull guard ──────────────────────────

  it('CRITICAL revokeWebSession isNull guard plus returning rowcount makes revocation an atomic first-winner claim.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/\.set\(\{ revokedAt: at \}\)/);
    expect(p).toMatch(
      /\.where\(and\(eq\(webSessions\.id, id\), isNull\(webSessions\.revokedAt\)\)\)/,
    );
    expect(p).toMatch(/\.returning\(\{ id: webSessions\.id \}\);/);
    expect(p).toMatch(/return rows\.length === 1;/);
  });

  // ─── revokeAllWebSessionsExcept ──────────────────────────────

  it('CRITICAL revokeAllWebSessionsExcept — and(eq(accountId), isNull(revokedAt), ne(id, exceptId)) + returning({id}).length. The ne(id, exceptId) excludes the calling session; length gives the revoked count.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/eq\(webSessions\.accountId, accountId\),/);
    expect(p).toMatch(/isNull\(webSessions\.revokedAt\),/);
    expect(p).toMatch(/ne\(webSessions\.id, exceptId\),/);
    expect(p).toMatch(/\.returning\(\{ id: webSessions\.id \}\);/);
    expect(p).toMatch(/return rows\.length;/);
  });

  // ─── markWebSessionMfaSatisfied V-353e wire ──────────────────

  it("CRITICAL markWebSessionMfaSatisfied wires V-353e — 'set({mfaSatisfiedAt: at}).where(eq(id))'. The single-field update is what V-353e step-up MFA writes after a successful OTP/recovery code.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(/async markWebSessionMfaSatisfied\(id: string, at: Date\): Promise<void> \{/);
    expect(p).toMatch(/\.set\(\{ mfaSatisfiedAt: at \}\)/);
    expect(p).toMatch(/\.where\(eq\(webSessions\.id, id\)\);/);
  });

  // ─── toAccountRow authority mapper ───────────────────────────

  it('CRITICAL toAccountRow carries authEpoch with account authority', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(
      /function toAccountRow\(r: typeof accounts\.\$inferSelect\): AuthFlowAccountRow \{/,
    );
    expect(p).toMatch(/passwordHash: r\.passwordHash,/);
    expect(p).toMatch(/emailVerifiedAt: r\.emailVerifiedAt,/);
    expect(p).toMatch(/tier: r\.tier,/);
    expect(p).toMatch(/status: r\.status,/);
    expect(p).toMatch(/authEpoch: r\.authEpoch,/);
  });

  // ─── toTokenRow 6-field mapper ───────────────────────────────

  it('CRITICAL toTokenRow 6-field mapper — id + accountId + tokenHash + expiresAt + consumedAt + createdAt. The 6-field AuthFlowTokenRow shape is shared across all 3 token-kind tables.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(
      /function toTokenRow<T extends typeof emailVerifyTokens\.\$inferSelect>\(r: T\): AuthFlowTokenRow \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/tokenHash: r\.tokenHash,/);
    expect(p).toMatch(/expiresAt: r\.expiresAt,/);
    expect(p).toMatch(/consumedAt: r\.consumedAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
  });

  // ─── toWebSessionRow authority mapper ────────────────────────

  it('CRITICAL toWebSessionRow carries authEpoch and MFA state', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-flows-repo.ts'));
    expect(p).toMatch(
      /function toWebSessionRow\(r: typeof webSessions\.\$inferSelect\): WebSessionRow \{/,
    );
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/tokenHash: r\.tokenHash,/);
    expect(p).toMatch(/authEpoch: r\.authEpoch,/);
    expect(p).toMatch(/expiresAt: r\.expiresAt,/);
    expect(p).toMatch(/lastUsedAt: r\.lastUsedAt,/);
    expect(p).toMatch(/revokedAt: r\.revokedAt,/);
    expect(p).toMatch(/issuedFromIp: r\.issuedFromIp,/);
    expect(p).toMatch(/userAgent: r\.userAgent,/);
    expect(p).toMatch(/mfaSatisfiedAt: r\.mfaSatisfiedAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-auth-flows-repo-v079-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
