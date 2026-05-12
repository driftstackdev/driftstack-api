// W428.A — drift guard for packages/sdk-typescript/src/resources/api-keys.ts.
// ApiKeysResource — V-296 rotate-with-grace + admin-scope create.
// Drift here either strips the "shown ONCE" plaintext invariant
// (consumer fails to store + loses access) or breaks the V-296
// rotated_from + grace_period_ends_at fields (rotation pipeline
// silently drops the auto-revoke timestamp).
//
//   • Framing pinned: typed methods for /v1/api-keys.
//   • ApiKeyList envelope: data: ApiKey[] (plaintext never returned
//     on list).
//   • V-296 RotateApiKeyResponse extends CreateApiKeyResponse with
//     rotated_from + grace_period_ends_at; new plaintext shown ONCE.
//   • RotateApiKeyOptions.name optional (defaults to old name).
//   • 4 verbs: create (admin scope) + list (no plaintext) + revoke
//     (idempotent, encoded :keyId) + rotate (V-296 24h grace).
//   • All :keyId path segments encodeURIComponent-wrapped.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/api-keys.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W428.A packages/sdk-typescript/src/resources/api-keys.ts content parity', () => {
  const body = read(LIB);

  it('Framing pinned: typed methods for /v1/api-keys', () => {
    expect(body).toMatch(/\/\/ ApiKeysResource — typed methods for \/v1\/api-keys\./);
  });

  it('imports: ApiKey + CreateApiKeyRequest + CreateApiKeyResponse + HttpClient', () => {
    expect(body).toMatch(
      /import type \{ ApiKey, CreateApiKeyRequest, CreateApiKeyResponse \} from '@driftstack\/api-types';/,
    );
    expect(body).toMatch(/import type \{ HttpClient \} from '\.\.\/http\.js';/);
  });

  it('ApiKeyList envelope: data: ApiKey[]', () => {
    expect(body).toMatch(/export interface ApiKeyList \{\s*\n?\s*data: ApiKey\[\];\s*\n?\s*\}/);
  });

  it('V-296 RotateApiKeyResponse: extends CreateApiKeyResponse + rotated_from + grace_period_ends_at; framing pinned (new plaintext shown ONCE; old key auto-revokes via existing expires_at-driven auth gate)', () => {
    expect(body).toMatch(
      /\*\s*V-296 — response shape for POST \/v1\/api-keys\/:id\/rotate\. Includes the\s*\n?\s*\*\s*new key's plaintext \(shown ONCE\), the previous key's id, and the\s*\n?\s*\*\s*timestamp at which the previous key auto-revokes via the existing\s*\n?\s*\*\s*expires_at-driven auth gate\./,
    );
    expect(body).toMatch(
      /export interface RotateApiKeyResponse extends CreateApiKeyResponse \{\s*\n?\s*rotated_from: string;\s*\n?\s*grace_period_ends_at: string;\s*\n?\s*\}/,
    );
  });

  it('RotateApiKeyOptions.name optional; defaults to old key name when omitted', () => {
    expect(body).toMatch(
      /export interface RotateApiKeyOptions \{\s*\n?\s*\/\*\* Optional new name for the rotated key\. Defaults to the old name\. \*\/\s*\n?\s*name\?: string;\s*\n?\s*\}/,
    );
  });

  it("create verb: POST /v1/api-keys; plaintext shown ONCE; requires 'admin' scope on calling key", () => {
    expect(body).toMatch(
      /\*\s*Create a new API key\. The plaintext is returned ONCE in the response;\s*\n?\s*\*\s*store it now — it cannot be retrieved later\. Requires the `admin` scope\s*\n?\s*\*\s*on the calling key\./,
    );
    expect(body).toMatch(
      /create\(body: CreateApiKeyRequest\): Promise<CreateApiKeyResponse> \{\s*\n?\s*return this\.http\.request<CreateApiKeyResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: '\/v1\/api-keys',\s*\n?\s*body,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('list verb: GET /v1/api-keys; plaintext never included on list response', () => {
    expect(body).toMatch(
      /\/\*\* List all API keys for the current account\. Plaintext is never included\. \*\//,
    );
    expect(body).toMatch(
      /list\(\): Promise<ApiKeyList> \{\s*\n?\s*return this\.http\.request<ApiKeyList>\(\{ method: 'GET', path: '\/v1\/api-keys' \}\);\s*\n?\s*\}/,
    );
  });

  it('revoke verb: DELETE /v1/api-keys/:keyId encoded; idempotent (re-revoke = no-op)', () => {
    expect(body).toMatch(
      /\/\*\* Revoke an API key\. Idempotent — revoking an already-revoked key is a no-op\. \*\//,
    );
    expect(body).toMatch(
      /revoke\(keyId: string\): Promise<void> \{\s*\n?\s*return this\.http\.request<void>\(\{\s*\n?\s*method: 'DELETE',\s*\n?\s*path: `\/v1\/api-keys\/\$\{encodeURIComponent\(keyId\)\}`,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('V-296 rotate verb: POST /v1/api-keys/:keyId/rotate encoded; both keys concurrent during 24h grace; old expires_at = now+24h; new plaintext shown ONCE', () => {
    expect(body).toMatch(
      /\*\s*V-296 — rotate an API key\. Mints a fresh plaintext \+ sets the OLD key's\s*\n?\s*\*\s*expires_at to now \+ 24h grace\. Both keys work concurrently during the\s*\n?\s*\*\s*grace window; deploy the new key, then the old key auto-revokes at the\s*\n?\s*\*\s*grace boundary via the existing expires_at-driven auth gate\./,
    );
    expect(body).toMatch(
      /\*\s*The new plaintext is returned ONCE in the response — store it now\./,
    );
    expect(body).toMatch(
      /rotate\(keyId: string, options: RotateApiKeyOptions = \{\}\): Promise<RotateApiKeyResponse> \{\s*\n?\s*return this\.http\.request<RotateApiKeyResponse>\(\{\s*\n?\s*method: 'POST',\s*\n?\s*path: `\/v1\/api-keys\/\$\{encodeURIComponent\(keyId\)\}\/rotate`,\s*\n?\s*body: options,\s*\n?\s*\}\);\s*\n?\s*\}/,
    );
  });

  it('All :keyId segments encodeURIComponent-wrapped (2 occurrences: revoke + rotate)', () => {
    const matches = body.match(/encodeURIComponent\(keyId\)/g);
    expect(matches).not.toBeNull();
    expect((matches ?? []).length).toBe(2);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
