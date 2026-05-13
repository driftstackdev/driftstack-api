// W590.A — drift guard for packages/sdk-go/api_keys.go.
// APIKeysResource Go parity. 4 verbs + V-296 24h grace rotate.
//
//   • Create: plaintext-once + admin-scope framing.
//   • List: plaintext never included.
//   • Revoke: idempotent DELETE.
//   • Rotate: V-296; nil body → default name preserved; new
//     plaintext shown ONCE; old key's expires_at = now+24h.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-go/api_keys.go');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W590.A packages/sdk-go/api_keys.go content parity', () => {
  const body = read(LIB);

  it('APIKeysResource struct + Create plaintext-once+admin-scope + List no-plaintext + Revoke idempotent-DELETE + V-296 Rotate 24h grace nil-body default pinned', () => {
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ APIKeysResource handles \/v1\/api-keys\./);
    expect(body).toMatch(/^type APIKeysResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
    expect(body).toMatch(
      /\/\/ Create generates an API key\. Plaintext is in the response — store it/,
    );
    expect(body).toMatch(
      /\/\/ now, it cannot be retrieved later\. Requires the admin scope on the/,
    );
    expect(body).toMatch(/\/\/ calling key\./);
    expect(body).toMatch(
      /func \(r \*APIKeysResource\) Create\(ctx context\.Context, body \*CreateAPIKeyRequest\) \(\*CreateAPIKeyResponse, error\) \{/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/api-keys",/);
    expect(body).toMatch(/\/\/ List returns all keys for the current account\. Plaintext is never/);
    expect(body).toMatch(/\/\/ included\./);
    expect(body).toMatch(
      /func \(r \*APIKeysResource\) List\(ctx context\.Context\) \(\*APIKeyList, error\) \{/,
    );
    expect(body).toMatch(
      /\/\/ Revoke marks an API key revoked\. Idempotent — revoking an already-/,
    );
    expect(body).toMatch(/\/\/ revoked key is a no-op\./);
    expect(body).toMatch(
      /func \(r \*APIKeysResource\) Revoke\(ctx context\.Context, keyID string\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/api-keys\/" \+ url\.PathEscape\(keyID\),\s*\n\s*\}\)\s*\n\}/,
    );
    expect(body).toMatch(/\/\/ Rotate is V-296 — mints a fresh plaintext \+ sets the OLD key's/);
    expect(body).toMatch(
      /\/\/ expires_at to now \+ 24h grace\. Both keys work concurrently during the/,
    );
    expect(body).toMatch(/\/\/ grace window; deploy the new key, then the old key auto-revokes at/);
    expect(body).toMatch(/\/\/ the grace boundary via the existing expires_at-driven auth gate\./);
    expect(body).toMatch(
      /func \(r \*APIKeysResource\) Rotate\(ctx context\.Context, keyID string, body \*RotateAPIKeyRequest\) \(\*RotateAPIKeyResponse, error\) \{\s*\n\s*if body == nil \{\s*\n\s*body = &RotateAPIKeyRequest\{\}\s*\n\s*\}/,
    );
    expect(body).toMatch(/path:\s+"\/v1\/api-keys\/" \+ url\.PathEscape\(keyID\) \+ "\/rotate",/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
