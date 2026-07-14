// W432.C — drift guard for packages/api-types/src/api-keys.ts.
// API key public contract. Drift here either leaks plaintext on the
// list shape (security regression — ApiKeySchema includes plaintext)
// or removes the key_prefix display-hint field (dashboard UI breaks
// the "ds_live_a1b2…" partial reveal).
//
//   • ApiKeySchema shape pinned: 8 fields; plaintext NEVER included
//     in list/get returns; key_prefix display hint; last_used_at +
//     revoked_at + expires_at all nullable ISO8601.
//   • CreateApiKeyRequest: name 1..120 + bounded unique request-only
//     scopes list + optional expires_at.
//   • CreateApiKeyResponse extends ApiKeySchema with plaintext
//     (shown ONCE at creation; never retrievable later).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/src/api-keys.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W432.C packages/api-types/src/api-keys.ts content parity', () => {
  const body = read(LIB);

  it("imports: z from 'zod' + ApiKeyIdSchema + request-list + response scope + Iso8601Schema from './common.js'", () => {
    expect(body).toMatch(/import \{ z \} from 'zod';/);
    expect(body).toMatch(
      /import \{\s*ApiKeyIdSchema,\s*ApiKeyScopeListRequestSchema,\s*ApiKeyScopeSchema,\s*Iso8601Schema,\s*\} from '\.\/common\.js';/,
    );
  });

  it('ApiKeySchema shape pinned: id + name + key_prefix (display hint) + scopes array + nullable last_used_at + revoked_at + expires_at + created_at; plaintext NEVER on list/get rationale comment', () => {
    expect(body).toMatch(
      /\/\/ API key as returned in list \/ get responses \(NEVER includes plaintext\)\./,
    );
    expect(body).toMatch(
      /export const ApiKeySchema = z\.object\(\{\s*\n?\s*id: ApiKeyIdSchema,\s*\n?\s*name: z\.string\(\),\s*\n?\s*\/\/ First chars of plaintext; useful as a display hint \("ds_live_a1b2…"\)\.\s*\n?\s*key_prefix: z\.string\(\),\s*\n?\s*scopes: z\.array\(ApiKeyScopeSchema\),\s*\n?\s*last_used_at: Iso8601Schema\.nullable\(\),\s*\n?\s*revoked_at: Iso8601Schema\.nullable\(\),\s*\n?\s*expires_at: Iso8601Schema\.nullable\(\),\s*\n?\s*created_at: Iso8601Schema,\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(/export type ApiKey = z\.infer<typeof ApiKeySchema>;/);
  });

  it('CreateApiKeyRequestSchema: name min 1 max 120 + bounded unique request scope schema + optional expires_at; response scope array remains tolerant', () => {
    expect(body).toMatch(/\/\/ Create-key request: name \+ scopes\./);
    expect(body).toMatch(
      /export const CreateApiKeyRequestSchema = z\.object\(\{\s*\n?\s*name: z\.string\(\)\.min\(1\)\.max\(120\),\s*\n?\s*scopes: ApiKeyScopeListRequestSchema,\s*\n?\s*expires_at: Iso8601Schema\.optional\(\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export type CreateApiKeyRequest = z\.infer<typeof CreateApiKeyRequestSchema>;/,
    );
  });

  it('CreateApiKeyResponseSchema extends ApiKeySchema with plaintext (shown ONCE at creation; not retrievable later); .describe rationale pinned', () => {
    expect(body).toMatch(
      /\/\/ Create-key response: the persisted key MET PLUS the plaintext \(returned\s*\n?\s*\/\/ once, never again\)\./,
    );
    expect(body).toMatch(
      /export const CreateApiKeyResponseSchema = ApiKeySchema\.extend\(\{\s*\n?\s*plaintext: z\s*\n?\s*\.string\(\)\s*\n?\s*\.describe\('The plaintext key\. Shown once at creation; not retrievable later\.'\),\s*\n?\s*\}\);/,
    );
    expect(body).toMatch(
      /export type CreateApiKeyResponse = z\.infer<typeof CreateApiKeyResponseSchema>;/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
