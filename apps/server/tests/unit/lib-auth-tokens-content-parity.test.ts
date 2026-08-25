// W388.A — drift guard for apps/server/src/lib/auth-tokens.ts.
// User-facing auth-flow primitives (signup verify / magic-link /
// password reset / web session) — distinct from api-keys.ts SDK-
// consumer keys. The 4 TTL constants are referenced by /docs/
// emails-reference and the customer-dashboard auth pages; the
// scrypt-kdf delegation is referenced by /trust/security-overview.
//
//   • 2 primitives: scrypt password hashing + opaque sha256-hashed
//     single-use tokens.
//   • TOKEN_RANDOM_BYTES = 32 (full 256-bit entropy random tokens).
//   • generateAuthToken: URL-safe base64 (randomBytes(32).toString
//     ('base64url')).
//   • tokenHash: sha256 hex (sufficient for full-entropy input;
//     scrypt reserved for low-entropy user passwords).
//   • hashPassword / verifyPassword DELEGATE to api-keys.ts
//     (single scrypt path, no divergence).
//   • AUTH_TOKEN_TTL_MS 4 constants: signupVerification=30min /
//     magicLink=15min / passwordReset=1h / webSession=30d.
//   • Module-comment framing pinned (storage column
//     accounts.password_hash, plaintext sent ONCE).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W388.A apps/server/src/lib/auth-tokens.ts content parity', () => {
  const body = read(LIB);

  it('framing: distinct from api-keys.ts (user-facing auth flow, not SDK consumers)', () => {
    expect(body).toMatch(
      /Helpers for the user-facing auth flow \(signup\/verify\/login\/magic-link\/\s*\/\/\s*password-reset\/web-session\)\. Distinct from `api-keys\.ts`/,
    );
  });

  it('2 primitives framing: scrypt-kdf password hash + opaque sha256-hashed tokens', () => {
    expect(body).toMatch(
      /Password hashing — scrypt-kdf, same parameters as the API-key path\s*\/\/\s*\(logN=15, r=8, p=1\)/,
    );
    expect(body).toMatch(/Re-uses the api-keys hashing functions to\s*\/\/\s*avoid divergence/);
    expect(body).toMatch(
      /Opaque single-use tokens — 32 random bytes encoded as URL-safe\s*\/\/\s*base64, sha256-hashed at rest/,
    );
  });

  it('plaintext-sent-ONCE framing pinned (Postmark for email flows; response body for web-session)', () => {
    expect(body).toMatch(
      /The plaintext is sent ONCE\s*\/\/\s*\(via Postmark for email-bearing flows; in the response body for\s*\/\/\s*web-session login\)/,
    );
  });

  it('TTL defaults framing pinned in module comment (4 lifetimes)', () => {
    expect(body).toMatch(/signup-verification: 30 minutes/);
    expect(body).toMatch(/magic-link: {11}15 minutes/);
    expect(body).toMatch(/password-reset: {8}1 hour/);
    expect(body).toMatch(/web-session: {10}30 days/);
  });

  it('TOKEN_RANDOM_BYTES = 32 (256-bit entropy floor)', () => {
    expect(body).toMatch(/export const TOKEN_RANDOM_BYTES = 32;/);
  });

  it('generateAuthToken: randomBytes(32).toString("base64url")', () => {
    expect(body).toMatch(
      /export function generateAuthToken\(\): string \{\s*return randomBytes\(TOKEN_RANDOM_BYTES\)\.toString\('base64url'\);\s*\}/,
    );
  });

  it('tokenHash: sha256 hex (sufficient — scrypt reserved for low-entropy passwords)', () => {
    expect(body).toMatch(
      /Sha256 is sufficient\s*\*\s*here because the input has full random entropy \(256 bits\) — scrypt is\s*\*\s*reserved for low-entropy user-chosen passwords/,
    );
    expect(body).toMatch(
      /export function tokenHash\(plaintext: string\): string \{\s*return createHash\('sha256'\)\.update\(plaintext\)\.digest\('hex'\);\s*\}/,
    );
  });

  it('hashPassword: DELEGATES to hashApiKey (single scrypt path, no divergence)', () => {
    expect(body).toMatch(/import \{ hashApiKey, verifyApiKey \} from '\.\/api-keys\.js';/);
    expect(body).toMatch(
      /export function hashPassword\(plaintext: string\): Promise<string> \{\s*return hashApiKey\(plaintext\);\s*\}/,
    );
  });

  it('verifyPassword: DELEGATES to verifyApiKey (single scrypt path, no divergence)', () => {
    expect(body).toMatch(
      /export function verifyPassword\(plaintext: string, encodedHash: string\): Promise<boolean> \{\s*return verifyApiKey\(plaintext, encodedHash\);\s*\}/,
    );
  });

  it('accounts.password_hash + api_keys.key_hash framing: both round-trip via scrypt-kdf standard format', () => {
    expect(body).toMatch(
      /Both columns\s*\*\s*\(`api_keys\.key_hash` and `accounts\.password_hash`\) round-trip through\s*\*\s*scrypt-kdf's standard-format string/,
    );
  });

  it('AUTH_TOKEN_TTL_MS as-const: 4 keys with exact millisecond values', () => {
    expect(body).toMatch(/export const AUTH_TOKEN_TTL_MS = \{/);
    expect(body).toMatch(/signupVerification: 30 \* 60 \* 1000,/);
    expect(body).toMatch(/magicLink: 15 \* 60 \* 1000,/);
    expect(body).toMatch(/passwordReset: 60 \* 60 \* 1000,/);
    expect(body).toMatch(/webSession: 30 \* 24 \* 60 \* 60 \* 1000,/);
    expect(body).toMatch(/\} as const;/);
  });

  it('imports: createHash + randomBytes from node:crypto (no other deps)', () => {
    expect(body).toMatch(/import \{ createHash, randomBytes \} from 'node:crypto';/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
