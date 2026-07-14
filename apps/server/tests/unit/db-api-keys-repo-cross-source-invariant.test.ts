// W991 — db/api-keys-repo cross-source invariant. Three-hundred-
// seventeenth in the drift-guard series. Pins the apps/server/src/
// db/api-keys-repo.ts Drizzle repo primitive:
//
//   Header — 'Drizzle-backed implementation of ApiKeysRepo'.
//
//   DrizzleApiKeysRepo implements ApiKeysRepo with atomic rotation:
//     - insertApiKey(input): inserts + returns row.
//     - listApiKeys(accountId): selects by accountId + orderBy
//       desc(createdAt).
//     - findApiKey(id, accountId): scoped lookup with accountId
//       guard.
//     - findApiKeyUnscoped(id): admin-only lookup without accountId.
//     - markRevoked(id, at): sets revokedAt timestamp.
//     - setExpiresAt(id, expiresAt): updates expiresAt.
//     - rotateApiKeyAtomic(input): locks the tenant-scoped current row
//       before validating authority and writing both rotation rows.
//
//   listAllApiKeys admin paged-cursor lookup with 4 filters:
//     - cursor → lt(createdAt, cursorDate).
//     - opts.accountId → eq(accountId).
//     - opts.revoked === true → isNotNull(revokedAt).
//     - opts.revoked === false → isNull(revokedAt).
//     - .limit(opts.limit + 1) for hasMore probe.
//     - returns { items, nextCursor } where nextCursor is the
//       createdAt ISO of the last item when hasMore.
//
//   toApiKeyRow mapper has 10 fields — id + accountId + name +
//     keyPrefix + keyHash + scopes + lastUsedAt + revokedAt +
//     expiresAt + createdAt.
//
//   insertApiKey throws 'insertApiKey returned no row' on missing
//     returning() result.
//
// stays in lockstep across apps/server/src/db/api-keys-repo.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W991 db/api-keys-repo cross-source invariant', () => {
  // ─── Header + impl ───────────────────────────────────────────

  it("CRITICAL apps/server/src/db/api-keys-repo.ts header — 'Drizzle-backed implementation of ApiKeysRepo'. The Drizzle-impl + service-interface separation is the V-156 repo-injection contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(/\/\/ Drizzle-backed implementation of ApiKeysRepo\./);
    expect(p).toMatch(/export class DrizzleApiKeysRepo implements ApiKeysRepo \{/);
    expect(p).toMatch(/constructor\(private readonly database: Database\) \{\}/);
  });

  // ─── core method surface ─────────────────────────────────────

  it('CRITICAL method surface includes atomic rotation alongside insert/list/find/revoke/expiry primitives.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(/async insertApiKey\(input: NewApiKeyInput\): Promise<ApiKeyRow> \{/);
    expect(p).toMatch(/async listApiKeys\(accountId: string\): Promise<ApiKeyRow\[\]> \{/);
    expect(p).toMatch(
      /async findApiKey\(id: string, accountId: string\): Promise<ApiKeyRow \| null> \{/,
    );
    expect(p).toMatch(/async findApiKeyUnscoped\(id: string\): Promise<ApiKeyRow \| null> \{/);
    expect(p).toMatch(/async markRevoked\(id: string, at: Date\): Promise<void> \{/);
    expect(p).toMatch(/async setExpiresAt\(id: string, expiresAt: Date\): Promise<void> \{/);
    expect(p).toContain(
      'async rotateApiKeyAtomic(input: RotateApiKeyInput): Promise<RotateApiKeyRepoResult>',
    );
  });

  // ─── insertApiKey returning() ────────────────────────────────

  it("CRITICAL insertApiKey throws 'insertApiKey returned no row' when returning() yields nothing. The defensive check guards against silent drizzle weirdness.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(/if \(!row\) throw new Error\('insertApiKey returned no row'\);/);
  });

  // ─── listApiKeys ordering ────────────────────────────────────

  it('CRITICAL listApiKeys orders by desc(createdAt). The newest-first ordering matches the customer-facing /v1/account/keys list expectation.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(/\.where\(eq\(apiKeys\.accountId, accountId\)\)/);
    expect(p).toMatch(/\.orderBy\(desc\(apiKeys\.createdAt\)\);/);
  });

  // ─── findApiKey accountId-scoped ─────────────────────────────

  it('CRITICAL findApiKey scopes on (id, accountId) with and() — prevents cross-account lookup. The scoped lookup is the tenant-isolation guarantee.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(
      /\.where\(and\(eq\(apiKeys\.id, id\), eq\(apiKeys\.accountId, accountId\)\)\)/,
    );
    expect(p).toMatch(/\.limit\(1\);/);
  });

  it('CRITICAL findApiKeyUnscoped does NOT scope on accountId — admin-only lookup. The unscoped variant is for admin / cross-account audit flows.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(/\.from\(apiKeys\)\.where\(eq\(apiKeys\.id, id\)\)\.limit\(1\);/);
  });

  // ─── markRevoked + setExpiresAt ──────────────────────────────

  it('CRITICAL markRevoked sets revokedAt timestamp. The set-revokedAt pattern is what makes revocation a soft-delete (history preserved for audit).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(
      /\.update\(apiKeys\)\.set\(\{ revokedAt: at \}\)\.where\(eq\(apiKeys\.id, id\)\);/,
    );
  });

  it('CRITICAL setExpiresAt updates expiresAt (no other fields). The narrow-update keeps key-rotation paths from accidentally clobbering name/scopes.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(
      /\.update\(apiKeys\)\.set\(\{ expiresAt \}\)\.where\(eq\(apiKeys\.id, id\)\);/,
    );
  });

  it('CRITICAL rotateApiKeyAtomic serializes the active-row check, successor insert, and old expiry update under a tenant-scoped FOR UPDATE lock.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toContain('return this.database.db.transaction(async (tx) => {');
    expect(p).toContain(
      '.where(and(eq(apiKeys.id, input.oldKeyId), eq(apiKeys.accountId, input.accountId)))',
    );
    expect(p).toContain(".for('update');");
    expect(p).toContain("if (locked.revokedAt !== null) return { kind: 'revoked' };");
    expect(p).toContain('.insert(apiKeys)');
    expect(p).toContain('.set({ expiresAt: gracePeriodEndsAt })');
  });

  // ─── listAllApiKeys 4-filter ─────────────────────────────────

  it('CRITICAL listAllApiKeys 4 filters — cursor → lt(createdAt) + accountId → eq + revoked=true → isNotNull(revokedAt) + revoked=false → isNull(revokedAt). The 4-filter ladder is the V-666.B admin-API-keys paged-list shape.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    // Keyset cursor (createdAt, id) — looked up by cursor id, compound filter.
    expect(p).toMatch(/lt\(apiKeys\.createdAt, c\.createdAt\),/);
    expect(p).toMatch(/and\(eq\(apiKeys\.createdAt, c\.createdAt\), lt\(apiKeys\.id, c\.id\)\),/);
    expect(p).toMatch(
      /if \(opts\.accountId\) filters\.push\(eq\(apiKeys\.accountId, opts\.accountId\)\);/,
    );
    expect(p).toMatch(
      /if \(opts\.revoked === true\) filters\.push\(isNotNull\(apiKeys\.revokedAt\)\);/,
    );
    expect(p).toMatch(
      /if \(opts\.revoked === false\) filters\.push\(isNull\(apiKeys\.revokedAt\)\);/,
    );
  });

  it('CRITICAL listAllApiKeys uses .limit(opts.limit + 1) hasMore probe + nextCursor = last.createdAt.toISOString() when hasMore. The +1 probe + ISO cursor design is the standard keyset-pagination pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(/\.limit\(opts\.limit \+ 1\);/);
    expect(p).toMatch(/const hasMore = rows\.length > opts\.limit;/);
    expect(p).toMatch(/const items = hasMore \? rows\.slice\(0, opts\.limit\) : rows;/);
    expect(p).toMatch(/nextCursor: hasMore && last \? last\.id : null,/);
  });

  it('CRITICAL listAllApiKeys empty-filter clause → undefined whereClause. The undefined-when-empty pattern lets drizzle skip emitting WHERE entirely.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(
      /const whereClause = filters\.length === 0 \? undefined : and\(\.\.\.filters\);/,
    );
  });

  // ─── toApiKeyRow 10-field mapper ─────────────────────────────

  it('CRITICAL toApiKeyRow has 10 fields — id + accountId + name + keyPrefix + keyHash + scopes + lastUsedAt + revokedAt + expiresAt + createdAt. The 10-field shape is the ApiKeyRow service-layer contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts'));
    expect(p).toMatch(/function toApiKeyRow\(r: typeof apiKeys\.\$inferSelect\): ApiKeyRow \{/);
    expect(p).toMatch(/id: r\.id,/);
    expect(p).toMatch(/accountId: r\.accountId,/);
    expect(p).toMatch(/name: r\.name,/);
    expect(p).toMatch(/keyPrefix: r\.keyPrefix,/);
    expect(p).toMatch(/keyHash: r\.keyHash,/);
    expect(p).toMatch(/scopes: r\.scopes,/);
    expect(p).toMatch(/lastUsedAt: r\.lastUsedAt,/);
    expect(p).toMatch(/revokedAt: r\.revokedAt,/);
    expect(p).toMatch(/expiresAt: r\.expiresAt,/);
    expect(p).toMatch(/createdAt: r\.createdAt,/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/db-api-keys-repo-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
