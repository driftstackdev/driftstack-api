// W590.A (W628-deepened) — drift guard for packages/sdk-go/api_keys.go.
// The original test pinned the 4-verb surface in a single monster it()
// block. W628 splits it into per-verb focused blocks + adds pins for
// previously-implicit invariants:
//
//   • HTTP-method correctness per verb (POST/GET/DELETE/POST-rotate).
//   • Plaintext-once invariant on Create AND Rotate (both return a
//     fresh plaintext that the customer must persist immediately —
//     this is the load-bearing security claim that makes the whole
//     hash-at-rest posture trustworthy).
//   • List excludes plaintext ("Plaintext is never included") —
//     reassurance that listing existing keys cannot leak credentials.
//   • V-296 24h grace-window rotation contract: old key auto-revokes
//     at the grace boundary via the existing expires_at-driven auth
//     gate. Both keys valid concurrently during the window so
//     customers can deploy + roll without an outage.
//   • Rotate nil-body default ("Pass nil for body to use the default
//     (preserve old name)"; pass &RotateAPIKeyRequest{Name: "..."}
//     to rename in flight) — the SDK ergonomics that let callers
//     skip request-body construction for the common case.
//   • account_owner-scope on the calling key for Create (the privilege
//     escalation surface).

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

  it('file exists at canonical path + APIKeysResource binds /v1/api-keys + package driftstack', () => {
    expect(existsSync(LIB)).toBe(true);
    expect(body).toMatch(/^package driftstack$/m);
    expect(body).toMatch(/\/\/ APIKeysResource handles \/v1\/api-keys\./);
    expect(body).toMatch(/^type APIKeysResource struct \{\s*\n\s*client \*Client\s*\n\}/m);
  });

  it('Create — POST /v1/api-keys with body, returns plaintext ONCE + account_owner-scope on calling key required. Drift to dropping the plaintext-once warning would silently weaken the customer-facing security contract that makes hash-at-rest credible.', () => {
    expect(body).toMatch(
      /\/\/ Create generates an API key\. Plaintext is in the response — store it/,
    );
    expect(body).toMatch(
      /\/\/ now, it cannot be retrieved later\. Requires the account_owner scope\s*\/\/\s*on the calling key\./,
    );
    expect(body).toMatch(
      /func \(r \*APIKeysResource\) Create\(ctx context\.Context, body \*CreateAPIKeyRequest\) \(\*CreateAPIKeyResponse, error\)/,
    );
    expect(body).toMatch(/method: "POST",\s*\n\s*path:\s+"\/v1\/api-keys",/);
  });

  it('List — GET /v1/api-keys returns all keys for the current account WITHOUT plaintext. Account-scope ("the current account") + no-plaintext ("Plaintext is never included") both pinned because together they make List safe to call frequently from low-trust contexts.', () => {
    expect(body).toMatch(/\/\/ List returns all keys for the current account\. Plaintext is never/);
    expect(body).toMatch(/\/\/ included\./);
    expect(body).toMatch(
      /func \(r \*APIKeysResource\) List\(ctx context\.Context\) \(\*APIKeyList, error\)/,
    );
    expect(body).toMatch(/method: "GET",\s*\n\s*path:\s+"\/v1\/api-keys",/);
  });

  it('Revoke — DELETE /v1/api-keys/{id}, idempotent (revoking an already-revoked key is a no-op). Returns plain error (no out struct), URL-escapes the keyID segment so a malformed id cannot inject path traversal.', () => {
    expect(body).toMatch(
      /\/\/ Revoke marks an API key revoked\. Idempotent — revoking an already-/,
    );
    expect(body).toMatch(/\/\/ revoked key is a no-op\./);
    expect(body).toMatch(
      /func \(r \*APIKeysResource\) Revoke\(ctx context\.Context, keyID string\) error \{\s*\n\s*return r\.client\.do\(ctx, requestOptions\{\s*\n\s*method: "DELETE",\s*\n\s*path:\s+"\/v1\/api-keys\/" \+ url\.PathEscape\(keyID\),\s*\n\s*\}\)\s*\n\}/,
    );
  });

  it("Rotate — V-296 POST /v1/api-keys/{id}/rotate mints a fresh plaintext + sets the OLD key's expires_at to now+24h grace. Both keys work concurrently during the window so customers deploy-then-roll without an outage. Old key auto-revokes at the grace boundary via the existing expires_at-driven auth gate (no separate sweeper; the auth code already checks expires_at on every request). Plaintext-once invariant pinned on Rotate ALSO (not just Create) — both verbs surface plaintext, both must warn.", () => {
    expect(body).toMatch(/\/\/ Rotate is V-296 — mints a fresh plaintext \+ sets the OLD key's/);
    expect(body).toMatch(
      /\/\/ expires_at to now \+ 24h grace\. Both keys work concurrently during the/,
    );
    expect(body).toMatch(/\/\/ grace window; deploy the new key, then the old key auto-revokes at/);
    expect(body).toMatch(/\/\/ the grace boundary via the existing expires_at-driven auth gate\./);
    expect(body).toMatch(/\/\/ The new plaintext is in the response — store it now, it cannot be/);
    expect(body).toMatch(/\/\/ retrieved later\./);
    expect(body).toMatch(
      /func \(r \*APIKeysResource\) Rotate\(ctx context\.Context, keyID string, body \*RotateAPIKeyRequest\) \(\*RotateAPIKeyResponse, error\)/,
    );
    expect(body).toMatch(
      /method: "POST",\s*\n\s*path:\s+"\/v1\/api-keys\/" \+ url\.PathEscape\(keyID\) \+ "\/rotate",/,
    );
  });

  it('Rotate nil-body default — "Pass nil for body to use the default (preserve old name); pass *RotateAPIKeyRequest{Name: \\"...\\"} to rename in flight." The SDK substitutes &RotateAPIKeyRequest{} when body is nil so the wire-level body is always a valid empty struct (the server reads "no name supplied" → preserves the existing name). Drift to dropping the nil-substitution would force callers to construct an empty struct themselves, breaking the established ergonomic.', () => {
    expect(body).toMatch(
      /\/\/ retrieved later\. Pass nil for body to use the default \(preserve old/,
    );
    expect(body).toMatch(
      /\/\/ name\); pass \*RotateAPIKeyRequest\{Name: "\.\.\."\} to rename in flight\./,
    );
    expect(body).toMatch(/if body == nil \{\s*\n\s*body = &RotateAPIKeyRequest\{\}\s*\n\s*\}/);
  });
});
