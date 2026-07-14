// W993 — db/auth-repo V-016 + V-298a cross-source invariant. Three-
// hundred-nineteenth in the drift-guard series. Pins the apps/server/
// src/db/auth-repo.ts Drizzle auth-repo primitive:
//
//   Header — 'Drizzle-backed implementation of AccountAuthRepo'.
//
//   DrizzleAccountAuthRepo 7-method surface:
//     - findApiKeyByPrefix(prefix): API-key prefix lookup.
//     - getAccount(id): account row by id.
//     - findActiveRateLimitOverrides(accountId, now): rate-limit
//       overrides with V-016 centi-rate /100 dequantization.
//     - touchApiKeyLastUsed(id, at): lastUsedAt write (30s
//       staleness gate framing).
//     - findActiveWebSession({tokenHash, now}): 3-condition active-
//       session lookup (tokenHash + expiresAt>now + revokedAt
//       IS NULL).
//     - touchWebSessionLastUsed(id, at): lastUsedAt write.
//     - findTeamMemberships(memberAccountId): membership join with
//       owner identity projection + active-owner authority filter.
//     - updateAccountBasics(id, patch): 5-field partial update +
//       V-298a slug-unique-violation translation.
//
//   V-016 centi-rate framing — 'Centi-rate stored as 100x; multiply
//   back. See V-016 for the quantization caveat (1/60 → 2 → 1/50
//   effective). Acceptable until/unless an exact-match requirement
//   emerges'.
//
//   V-298a slug-unique-violation framing — 'V-298a — translate
//   Postgres unique-violation on the slug index into a SlugTakenError
//   so the route layer returns 409'.
//
//   3-condition active-session — tokenHash eq + expiresAt > now +
//     revokedAt IS NULL.
//
//   toApiKeyRow 10-field mapper + toAccountRow 11-field mapper.
//
//   30s staleness comment — 'Skip the write if last_used_at was set
//   within the last 30s — saves a row update on every authenticated
//   request'.
//
// stays in lockstep across apps/server/src/db/auth-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W993 db/auth-repo V-016 + V-298a cross-source invariant', () => {
  // ─── Header + impl ───────────────────────────────────────────

  it("CRITICAL apps/server/src/db/auth-repo.ts header — 'Drizzle-backed implementation of AccountAuthRepo'. The Drizzle-impl + AccountAuthRepo-interface separation is the V-156 + V-079 auth-repo contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed implementation of AccountAuthRepo\./);
    expect(p).toMatch(/export class DrizzleAccountAuthRepo implements AccountAuthRepo \{/);
  });

  // ─── 7-method surface ────────────────────────────────────────

  it('CRITICAL 7-method surface — findApiKeyByPrefix + getAccount + findActiveRateLimitOverrides + touchApiKeyLastUsed + findActiveWebSession + touchWebSessionLastUsed + findTeamMemberships + updateAccountBasics. The 8-method set is the AccountAuthRepo contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/async findApiKeyByPrefix\(prefix: string\): Promise<ApiKeyRow \| null> \{/);
    expect(p).toMatch(/async getAccount\(id: string\): Promise<AccountRow \| null> \{/);
    expect(p).toMatch(
      /async findActiveRateLimitOverrides\(accountId: string, now: Date\): Promise<RateLimitOverride\[\]> \{/,
    );
    expect(p).toMatch(/async touchApiKeyLastUsed\(id: string, at: Date\): Promise<void> \{/);
    expect(p).toMatch(/async findActiveWebSession\(args: \{/);
    expect(p).toMatch(/async touchWebSessionLastUsed\(id: string, at: Date\): Promise<void> \{/);
    expect(p).toMatch(
      /async findTeamMemberships\(memberAccountId: string\): Promise<TeamMembership\[\]> \{/,
    );
    expect(p).toMatch(/async updateAccountBasics\(/);
  });

  // ─── V-016 centi-rate dequantization ─────────────────────────

  it("CRITICAL V-016 centi-rate framing — 'Centi-rate stored as 100x; multiply back. See V-016 for the quantization caveat (1/60 → 2 → 1/50 effective). Acceptable until/unless an exact-match requirement emerges'. The /100 dequantize + V-016 caveat is the rate-limit precision contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/\/\/ Centi-rate stored as 100x; multiply back\. See V-016 for the/);
    expect(p).toMatch(/\/\/ quantization caveat \(1\/60 → 2 → 1\/50 effective\)\. Acceptable/);
    expect(p).toMatch(/\/\/ until\/unless an exact-match requirement emerges\./);
    expect(p).toMatch(/refillPerSecond: r\.refillPerSecondCenti \/ 100,/);
  });

  // ─── findActiveRateLimitOverrides active-window ──────────────

  it('CRITICAL findActiveRateLimitOverrides where — and(eq(accountId), gt(expiresAt, now)). The expiresAt-gt-now filter selects only currently-active overrides.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(
      /and\(eq\(rateLimitOverrides\.accountId, accountId\), gt\(rateLimitOverrides\.expiresAt, now\)\)/,
    );
  });

  // ─── 30s staleness framing ───────────────────────────────────

  it("CRITICAL 30s staleness framing — 'Skip the write if last_used_at was set within the last 30s — saves a row update on every authenticated request'. The 30s-staleness-gate design avoids hot-path row-update storms.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/\/\/ Skip the write if last_used_at was set within the last 30s — saves/);
    expect(p).toMatch(/\/\/ a row update on every authenticated request\./);
  });

  // ─── 3-condition active-session ──────────────────────────────

  it('CRITICAL findActiveWebSession 3-condition lookup — eq(tokenHash) + gt(expiresAt, now) + isNull(revokedAt). The 3-cond AND ensures only active+unexpired+unrevoked sessions match.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/eq\(webSessions\.tokenHash, args\.tokenHash\),/);
    expect(p).toMatch(/gt\(webSessions\.expiresAt, args\.now\),/);
    expect(p).toMatch(/isNull\(webSessions\.revokedAt\),/);
    expect(p).toMatch(/eq\(accounts\.authEpoch, webSessions\.authEpoch\)/);
  });

  // ─── WebSessionAuthRow 7-field projection ────────────────────

  it('CRITICAL findActiveWebSession returns 7-field WebSessionAuthRow — id + accountId + expiresAt + revokedAt + lastUsedAt + mfaSatisfiedAt + createdAt. The 7-field shape carries enough to bind a request + run V-353e MFA freshness check.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/id: row\.id,/);
    expect(p).toMatch(/accountId: row\.accountId,/);
    expect(p).toMatch(/expiresAt: row\.expiresAt,/);
    expect(p).toMatch(/revokedAt: row\.revokedAt,/);
    expect(p).toMatch(/lastUsedAt: row\.lastUsedAt,/);
    expect(p).toMatch(/mfaSatisfiedAt: row\.mfaSatisfiedAt,/);
    expect(p).toMatch(/createdAt: row\.createdAt,/);
  });

  // ─── findTeamMemberships live-owner grant projection ─────────

  it('CRITICAL findTeamMemberships projects 3 fields — id + ownerAccountId + role. The narrow projection avoids fetching createdAt/invitedAt/etc on every authenticated request.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/\.select\(\{/);
    expect(p).toMatch(/id: teamMembers\.id,/);
    expect(p).toMatch(/ownerAccountId: teamMembers\.ownerAccountId,/);
    expect(p).toMatch(/role: teamMembers\.role,/);
  });

  it('CRITICAL findTeamMemberships returns {membershipId, ownerAccountId, role}. The membershipId alias (from db.id) keeps the TeamMembership service shape stable.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/membershipId: r\.id,/);
    expect(p).toMatch(/ownerAccountId: r\.ownerAccountId,/);
    expect(p).toMatch(/role: r\.role,/);
  });

  it('CRITICAL findTeamMemberships requires an active owner account so suspended/deleted owners cannot retain cross-account grants', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(
      /and\(eq\(teamMembers\.memberAccountId, memberAccountId\), eq\(accounts\.status, 'active'\)\)/,
    );
  });

  // ─── updateAccountBasics 5-field patch ───────────────────────

  it('CRITICAL updateAccountBasics 5-field patch — name + timezone + avatarR2Key + slug + region. Each field optionally overrideable; updatedAt always touched.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/name\?: string \| null;/);
    expect(p).toMatch(/timezone\?: string \| null;/);
    expect(p).toMatch(/avatarR2Key\?: string \| null;/);
    expect(p).toMatch(/slug\?: string \| null;/);
    expect(p).toMatch(/region\?: 'us' \| 'eu' \| 'apac' \| null;/);
    expect(p).toMatch(/const set: Record<string, unknown> = \{ updatedAt: new Date\(\) \};/);
  });

  // ─── V-298a slug-unique-violation ────────────────────────────

  it("CRITICAL V-298a slug-unique framing — 'V-298a — translate Postgres unique-violation on the slug index into a SlugTakenError so the route layer returns 409'. The 23505 + accounts_slug_unique double-check + SLUG_TAKEN throw is the V-298a route-409 contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/V-298a — translate Postgres unique-violation on the slug/);
    expect(p).toMatch(/index into a SlugTakenError so the route layer returns 409\./);
    // V-714 — the 23505 + accounts_slug_unique check delegates to the
    // drizzle-version-agnostic isUniqueViolation helper (top level on 0.38,
    // err.cause on 0.45).
    expect(p).toMatch(/isUniqueViolation\(err, 'accounts_slug_unique'\)/);
    expect(p).toMatch(/throw new Error\('SLUG_TAKEN'\);/);
  });

  // ─── toApiKeyRow 10-field mapper ─────────────────────────────

  it('CRITICAL toApiKeyRow 10-field mapper — id + accountId + name + keyPrefix + keyHash + scopes + lastUsedAt + revokedAt + expiresAt + createdAt. Matches W991 db/api-keys-repo toApiKeyRow shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/function toApiKeyRow\(r: typeof apiKeys\.\$inferSelect\): ApiKeyRow \{/);
    expect(p).toMatch(/scopes: r\.scopes,/);
    expect(p).toMatch(/lastUsedAt: r\.lastUsedAt,/);
    expect(p).toMatch(/revokedAt: r\.revokedAt,/);
    expect(p).toMatch(/expiresAt: r\.expiresAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
  });

  // ─── toAccountRow 11-field mapper ────────────────────────────

  it('CRITICAL toAccountRow 11-field mapper — id + email + name + tier + status + timezone + avatarR2Key + slug + region + createdAt + updatedAt. The 11-field AccountRow carries identity + tier + profile + 2-timestamp audit.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/auth-repo.ts'));
    expect(p).toMatch(/function toAccountRow\(r: typeof accounts\.\$inferSelect\): AccountRow \{/);
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
          'apps/server/tests/unit/db-auth-repo-v016-v298a-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
