// W444.C — drift guard for apps/server/src/db/api-keys-repo.ts.
// Drizzle ApiKeysRepo. Drift here either drops the unscoped findById
// variant (key-store internals can no longer look up keys by id alone
// during account-revocation lookups) or breaks the revoked filter
// tri-state (true=revoked, false=active, undefined=all).
//
//   • insertApiKey: 6-field values; returning(); throws on no-row.
//   • listApiKeys(accountId): account-scoped + orderBy desc(createdAt).
//   • findApiKey: account-scoped via and(eq(id), eq(accountId)) + limit 1.
//   • findApiKeyUnscoped: id-only lookup (no account scope) for
//     cross-account introspection.
//   • revokeApiKeyAtomic: conditional scoped update with persisted outcome.
//   • setExpiresAt: update expiresAt where id.
//   • rotateApiKeyAtomic: transaction + locked tenant-scoped old row;
//     validates active authority before inserting successor + expiring old.
//   • listAllApiKeys: tri-state revoked filter (true→isNotNull, false→
//     isNull, undefined→no filter); cursor lt(createdAt); orderBy
//     desc(createdAt); limit+1 hasMore + nextCursor.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/db/api-keys-repo.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W444.C apps/server/src/db/api-keys-repo.ts content parity', () => {
  const body = read(LIB);

  it("header framing pinned: 'Drizzle-backed implementation of ApiKeysRepo.'", () => {
    expect(body).toMatch(/\/\/ Drizzle-backed implementation of ApiKeysRepo\./);
  });

  it('imports: Drizzle operators; ApiKeyRow + API-key repo input/result types; Database; apiKeys schema', () => {
    expect(body).toMatch(
      /import \{ type SQL, and, desc, eq, isNotNull, isNull, lt, or \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(/import type \{ ApiKeyRow \} from '\.\.\/services\/auth\.js';/);
    expect(body).toContain('ApiKeysRepo,');
    expect(body).toContain('NewApiKeyInput,');
    expect(body).toContain('RevokeApiKeyInput,');
    expect(body).toContain('RevokeApiKeyRepoResult,');
    expect(body).toContain('RotateApiKeyInput,');
    expect(body).toContain('RotateApiKeyRepoResult,');
    expect(body).toContain("} from '../services/api-keys.js';");
    expect(body).toMatch(/import \{ apiKeys \} from '\.\/schema\.js';/);
  });

  // V-726 — an 8th field: createdByAccountId, the account that MINTED the key
  // (the acting member on a team-scoped mint, while accountId stays the owner).
  // It is what removeMember revokes against, so dropping it from the insert
  // would silently restore the offboarding hole — every key would land
  // unattributed and removal would find nothing to revoke.
  it("insertApiKey: 8-field values (accountId + name + scopes + keyPrefix + keyHash + expiresAt + provenance + createdByAccountId); returning(); throws 'insertApiKey returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*accountId: input\.accountId,\s*name: input\.name,\s*scopes: input\.scopes,\s*keyPrefix: input\.keyPrefix,\s*keyHash: input\.keyHash,\s*expiresAt: input\.expiresAt,\s*provenance: input\.provenance \?\? null,\s*createdByAccountId: input\.createdByAccountId \?\? null,\s*\}\)\s*\.returning\(\);\s*if \(!row\) throw new Error\('insertApiKey returned no row'\);/,
    );
  });

  it('listApiKeys(accountId): account-scoped + orderBy desc(createdAt); rows.map(toApiKeyRow)', () => {
    expect(body).toMatch(
      /async listApiKeys\(accountId: string\): Promise<ApiKeyRow\[\]> \{\s*const rows = await this\.database\.db\s*\.select\(\)\s*\.from\(apiKeys\)\s*\.where\(eq\(apiKeys\.accountId, accountId\)\)\s*\.orderBy\(desc\(apiKeys\.createdAt\)\);\s*return rows\.map\(toApiKeyRow\);\s*\}/,
    );
  });

  it('findApiKey: account-scoped via and(eq(id), eq(accountId)) + limit 1; findApiKeyUnscoped: id-only no account scope', () => {
    expect(body).toMatch(
      /async findApiKey\(id: string, accountId: string\): Promise<ApiKeyRow \| null> \{\s*const \[row\] = await this\.database\.db\s*\.select\(\)\s*\.from\(apiKeys\)\s*\.where\(and\(eq\(apiKeys\.id, id\), eq\(apiKeys\.accountId, accountId\)\)\)\s*\.limit\(1\);\s*return row \? toApiKeyRow\(row\) : null;\s*\}/,
    );
    expect(body).toMatch(
      /async findApiKeyUnscoped\(id: string\): Promise<ApiKeyRow \| null> \{\s*const \[row\] = await this\.database\.db\.select\(\)\.from\(apiKeys\)\.where\(eq\(apiKeys\.id, id\)\)\.limit\(1\);\s*return row \? toApiKeyRow\(row\) : null;\s*\}/,
    );
  });

  it('revokeApiKeyAtomic: explicit scope + active-only returning winner + authoritative loser read; setExpiresAt remains narrow', () => {
    expect(body).toContain(
      'async revokeApiKeyAtomic(input: RevokeApiKeyInput): Promise<RevokeApiKeyRepoResult>',
    );
    expect(body).toContain(
      'input.accountId === null ? undefined : eq(apiKeys.accountId, input.accountId)',
    );
    expect(body).toContain('.where(and(scope, isNull(apiKeys.revokedAt)))');
    expect(body).toContain("if (revoked) return { kind: 'revoked', key: toApiKeyRow(revoked) };");
    expect(body).toContain("if (!existing) return { kind: 'not_found' };");
    expect(body).toContain("return { kind: 'already_revoked', key };");
    expect(body).toMatch(
      /async setExpiresAt\(id: string, expiresAt: Date\): Promise<void> \{\s*await this\.database\.db\.update\(apiKeys\)\.set\(\{ expiresAt \}\)\.where\(eq\(apiKeys\.id, id\)\);\s*\}/,
    );
  });

  it('rotateApiKeyAtomic: one transaction locks the tenant-scoped old row before active checks, successor insert, and old expiry update', () => {
    expect(body).toContain(
      'async rotateApiKeyAtomic(input: RotateApiKeyInput): Promise<RotateApiKeyRepoResult>',
    );
    expect(body).toContain('return this.database.db.transaction(async (tx) => {');
    expect(body).toContain(
      '.where(and(eq(apiKeys.id, input.oldKeyId), eq(apiKeys.accountId, input.accountId)))',
    );
    expect(body).toContain(".for('update');");
    expect(body).toContain("if (locked.revokedAt !== null) return { kind: 'revoked' };");
    expect(body).toContain('.insert(apiKeys)');
    expect(body).toContain('.set({ expiresAt: gracePeriodEndsAt })');
  });

  it('listAllApiKeys tri-state revoked filter: revoked===true → isNotNull(revokedAt); revoked===false → isNull(revokedAt); undefined → no filter; cursor lt(createdAt, parsed-date); accountId optional', () => {
    expect(body).toMatch(
      /if \(opts\.revoked === true\) filters\.push\(isNotNull\(apiKeys\.revokedAt\)\);\s*if \(opts\.revoked === false\) filters\.push\(isNull\(apiKeys\.revokedAt\)\);/,
    );
    // Keyset cursor (createdAt, id) — looked up by cursor id.
    expect(body).toMatch(/lt\(apiKeys\.createdAt, c\.createdAt\),/);
    expect(body).toMatch(
      /and\(eq\(apiKeys\.createdAt, c\.createdAt\), lt\(apiKeys\.id, c\.id\)\),/,
    );
    expect(body).toMatch(
      /if \(opts\.accountId\) filters\.push\(eq\(apiKeys\.accountId, opts\.accountId\)\);/,
    );
  });

  it('listAllApiKeys query: orderBy desc(createdAt) + limit(limit+1); hasMore + slice; nextCursor = last.createdAt.toISOString()', () => {
    expect(body).toMatch(
      /const rows = await this\.database\.db\s*\.select\(\)\s*\.from\(apiKeys\)\s*\.where\(whereClause\)\s*\.orderBy\(desc\(apiKeys\.createdAt\), desc\(apiKeys\.id\)\)\s*\.limit\(opts\.limit \+ 1\);\s*const hasMore = rows\.length > opts\.limit;\s*const items = hasMore \? rows\.slice\(0, opts\.limit\) : rows;\s*const last = items\[items\.length - 1\];\s*return \{\s*items: items\.map\(toApiKeyRow\),\s*nextCursor: hasMore && last \? last\.id : null,\s*\};/,
    );
  });

  it('toApiKeyRow: 11-field ApiKeyRow (id + accountId + name + keyPrefix + keyHash + scopes + lastUsedAt + revokedAt + expiresAt + provenance + createdAt)', () => {
    expect(body).toMatch(
      /function toApiKeyRow\(r: typeof apiKeys\.\$inferSelect\): ApiKeyRow \{\s*return \{\s*id: r\.id,\s*accountId: r\.accountId,\s*name: r\.name,\s*keyPrefix: r\.keyPrefix,\s*keyHash: r\.keyHash,\s*scopes: r\.scopes,\s*lastUsedAt: r\.lastUsedAt,\s*revokedAt: r\.revokedAt,\s*expiresAt: r\.expiresAt,\s*provenance: r\.provenance,\s*createdAt: r\.createdAt,\s*\};\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
