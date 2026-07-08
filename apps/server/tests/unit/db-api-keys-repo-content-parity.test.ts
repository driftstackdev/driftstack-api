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
//   • markRevoked: update revokedAt where id.
//   • setExpiresAt: update expiresAt where id.
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

  it('imports: and/desc/eq/isNotNull/isNull/lt from drizzle-orm; ApiKeyRow + ApiKeysRepo/NewApiKeyInput; Database; apiKeys schema', () => {
    expect(body).toMatch(
      /import \{ type SQL, and, desc, eq, isNotNull, isNull, lt, or \} from 'drizzle-orm';/,
    );
    expect(body).toMatch(/import type \{ ApiKeyRow \} from '\.\.\/services\/auth\.js';/);
    expect(body).toMatch(
      /import type \{ ApiKeysRepo, NewApiKeyInput \} from '\.\.\/services\/api-keys\.js';/,
    );
    expect(body).toMatch(/import \{ apiKeys \} from '\.\/schema\.js';/);
  });

  it("insertApiKey: 7-field values (accountId + name + scopes + keyPrefix + keyHash + expiresAt + provenance); returning(); throws 'insertApiKey returned no row'", () => {
    expect(body).toMatch(
      /\.values\(\{\s*\n?\s*accountId: input\.accountId,\s*\n?\s*name: input\.name,\s*\n?\s*scopes: input\.scopes,\s*\n?\s*keyPrefix: input\.keyPrefix,\s*\n?\s*keyHash: input\.keyHash,\s*\n?\s*expiresAt: input\.expiresAt,\s*\n?\s*provenance: input\.provenance \?\? null,\s*\n?\s*\}\)\s*\n?\s*\.returning\(\);\s*\n?\s*if \(!row\) throw new Error\('insertApiKey returned no row'\);/,
    );
  });

  it('listApiKeys(accountId): account-scoped + orderBy desc(createdAt); rows.map(toApiKeyRow)', () => {
    expect(body).toMatch(
      /async listApiKeys\(accountId: string\): Promise<ApiKeyRow\[\]> \{\s*\n?\s*const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(apiKeys\)\s*\n?\s*\.where\(eq\(apiKeys\.accountId, accountId\)\)\s*\n?\s*\.orderBy\(desc\(apiKeys\.createdAt\)\);\s*\n?\s*return rows\.map\(toApiKeyRow\);\s*\n?\s*\}/,
    );
  });

  it('findApiKey: account-scoped via and(eq(id), eq(accountId)) + limit 1; findApiKeyUnscoped: id-only no account scope', () => {
    expect(body).toMatch(
      /async findApiKey\(id: string, accountId: string\): Promise<ApiKeyRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(apiKeys\)\s*\n?\s*\.where\(and\(eq\(apiKeys\.id, id\), eq\(apiKeys\.accountId, accountId\)\)\)\s*\n?\s*\.limit\(1\);\s*\n?\s*return row \? toApiKeyRow\(row\) : null;\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async findApiKeyUnscoped\(id: string\): Promise<ApiKeyRow \| null> \{\s*\n?\s*const \[row\] = await this\.database\.db\.select\(\)\.from\(apiKeys\)\.where\(eq\(apiKeys\.id, id\)\)\.limit\(1\);\s*\n?\s*return row \? toApiKeyRow\(row\) : null;\s*\n?\s*\}/,
    );
  });

  it('markRevoked: update set revokedAt where id; setExpiresAt: update set expiresAt where id', () => {
    expect(body).toMatch(
      /async markRevoked\(id: string, at: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\.update\(apiKeys\)\.set\(\{ revokedAt: at \}\)\.where\(eq\(apiKeys\.id, id\)\);\s*\n?\s*\}/,
    );
    expect(body).toMatch(
      /async setExpiresAt\(id: string, expiresAt: Date\): Promise<void> \{\s*\n?\s*await this\.database\.db\.update\(apiKeys\)\.set\(\{ expiresAt \}\)\.where\(eq\(apiKeys\.id, id\)\);\s*\n?\s*\}/,
    );
  });

  it('listAllApiKeys tri-state revoked filter: revoked===true → isNotNull(revokedAt); revoked===false → isNull(revokedAt); undefined → no filter; cursor lt(createdAt, parsed-date); accountId optional', () => {
    expect(body).toMatch(
      /if \(opts\.revoked === true\) filters\.push\(isNotNull\(apiKeys\.revokedAt\)\);\s*\n?\s*if \(opts\.revoked === false\) filters\.push\(isNull\(apiKeys\.revokedAt\)\);/,
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
      /const rows = await this\.database\.db\s*\n?\s*\.select\(\)\s*\n?\s*\.from\(apiKeys\)\s*\n?\s*\.where\(whereClause\)\s*\n?\s*\.orderBy\(desc\(apiKeys\.createdAt\), desc\(apiKeys\.id\)\)\s*\n?\s*\.limit\(opts\.limit \+ 1\);\s*\n?\s*const hasMore = rows\.length > opts\.limit;\s*\n?\s*const items = hasMore \? rows\.slice\(0, opts\.limit\) : rows;\s*\n?\s*const last = items\[items\.length - 1\];\s*\n?\s*return \{\s*\n?\s*items: items\.map\(toApiKeyRow\),\s*\n?\s*nextCursor: hasMore && last \? last\.id : null,\s*\n?\s*\};/,
    );
  });

  it('toApiKeyRow: 11-field ApiKeyRow (id + accountId + name + keyPrefix + keyHash + scopes + lastUsedAt + revokedAt + expiresAt + provenance + createdAt)', () => {
    expect(body).toMatch(
      /function toApiKeyRow\(r: typeof apiKeys\.\$inferSelect\): ApiKeyRow \{\s*\n?\s*return \{\s*\n?\s*id: r\.id,\s*\n?\s*accountId: r\.accountId,\s*\n?\s*name: r\.name,\s*\n?\s*keyPrefix: r\.keyPrefix,\s*\n?\s*keyHash: r\.keyHash,\s*\n?\s*scopes: r\.scopes,\s*\n?\s*lastUsedAt: r\.lastUsedAt,\s*\n?\s*revokedAt: r\.revokedAt,\s*\n?\s*expiresAt: r\.expiresAt,\s*\n?\s*provenance: r\.provenance,\s*\n?\s*createdAt: r\.createdAt,\s*\n?\s*\};\s*\n?\s*\}/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
