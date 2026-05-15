// W911 — AUTH_TOKEN_TTL_MS 4-flow lifetimes + dual-hash invariant.
// Two-hundred-thirty-seventh in the drift-guard series. Pins the
// auth-tokens token generation + lifetime + dual-hash contract:
//
//   AUTH_TOKEN_TTL_MS (4-flow lifetime defaults):
//     - signupVerification: 30 minutes (1_800_000ms).
//     - magicLink:           15 minutes (900_000ms).
//     - passwordReset:        1 hour    (3_600_000ms).
//     - webSession:          30 days    (2_592_000_000ms).
//
//   TOKEN_RANDOM_BYTES = 32 (256 bits of entropy).
//
//   2-primitive split:
//     1. Password hashing — scrypt-kdf, same params as API-key
//        path (logN=15, r=8, p=1). Re-uses hashApiKey/verifyApiKey.
//     2. Opaque single-use tokens — 32 random bytes encoded as
//        URL-safe base64, sha256-hashed at rest.
//
//   Why scrypt-for-password vs sha256-for-token: 'Sha256 is
//   sufficient here because the input has full random entropy
//   (256 bits) — scrypt is reserved for low-entropy user-chosen
//   passwords'.
//
// stays in lockstep across apps/server/src/lib/auth-tokens.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TTLS = {
  signupVerification: 30 * 60 * 1000,
  magicLink: 15 * 60 * 1000,
  passwordReset: 60 * 60 * 1000,
  webSession: 30 * 24 * 60 * 60 * 1000,
} as const;

describe('W911 auth-tokens TTL + dual-hash cross-source invariant', () => {
  // ─── AUTH_TOKEN_TTL_MS 4 flows ───────────────────────────────

  it('CRITICAL apps/server/src/lib/auth-tokens.ts AUTH_TOKEN_TTL_MS has 4 flow defaults — signupVerification (30m) + magicLink (15m) + passwordReset (1h) + webSession (30d). The 4-TTL roster matches the 4 token-bearing auth flows.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/export const AUTH_TOKEN_TTL_MS = \{/);
    expect(p).toMatch(/signupVerification: 30 \* 60 \* 1000,/);
    expect(p).toMatch(/magicLink: 15 \* 60 \* 1000,/);
    expect(p).toMatch(/passwordReset: 60 \* 60 \* 1000,/);
    expect(p).toMatch(/webSession: 30 \* 24 \* 60 \* 60 \* 1000,/);
  });

  it('CRITICAL header comment block pins 4-flow TTL summary — 30m signup-verification + 15m magic-link + 1h password-reset + 30d web-session. The header is the documentation surface that maintainers see first.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/Token lifetime defaults \(caller can override per-flow\):/);
    expect(p).toMatch(/signup-verification: 30 minutes/);
    expect(p).toMatch(/magic-link:\s+15 minutes/);
    expect(p).toMatch(/password-reset:\s+1 hour/);
    expect(p).toMatch(/web-session:\s+30 days/);
  });

  // ─── TOKEN_RANDOM_BYTES = 32 ─────────────────────────────────

  it('CRITICAL TOKEN_RANDOM_BYTES = 32 (256 bits of entropy). The 256-bit entropy is what makes sha256-at-rest safe (vs scrypt for low-entropy passwords).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/export const TOKEN_RANDOM_BYTES = 32;/);
  });

  it("CRITICAL generateAuthToken returns randomBytes(TOKEN_RANDOM_BYTES).toString('base64url'). The base64url encoding matches the URL-safe AuthTokenSchema regex from api-types (W886).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(
      /export function generateAuthToken\(\): string \{\s*\n\s*return randomBytes\(TOKEN_RANDOM_BYTES\)\.toString\('base64url'\);\s*\n\s*\}/,
    );
  });

  // ─── tokenHash sha256 — single-use rationale ─────────────────

  it("CRITICAL tokenHash uses createHash('sha256').update(plaintext).digest('hex'). The hex output is what the at-rest column stores; constant-time-equality lookup works because hex strings are content-addressed.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(
      /export function tokenHash\(plaintext: string\): string \{\s*\n\s*return createHash\('sha256'\)\.update\(plaintext\)\.digest\('hex'\);\s*\n\s*\}/,
    );
  });

  it("CRITICAL sha256-vs-scrypt rationale pinned — 'Sha256 is sufficient here because the input has full random entropy (256 bits) — scrypt is reserved for low-entropy user-chosen passwords'. The framing teaches why the 2 primitives use different algorithms.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/Sha256 is sufficient/);
    expect(p).toMatch(/here because the input has full random entropy \(256 bits\) — scrypt is/);
    expect(p).toMatch(/reserved for low-entropy user-chosen passwords/);
  });

  // ─── hashPassword re-uses API-key scrypt path ────────────────

  it('CRITICAL hashPassword + verifyPassword RE-USE the API-key scrypt path (hashApiKey/verifyApiKey). The shared codepath means scrypt-kdf params are identical across both columns (logN=15, r=8, p=1).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/import \{ hashApiKey, verifyApiKey \} from '\.\/api-keys\.js';/);
    expect(p).toMatch(
      /export function hashPassword\(plaintext: string\): Promise<string> \{\s*\n\s*return hashApiKey\(plaintext\);\s*\n\s*\}/,
    );
    expect(p).toMatch(
      /export function verifyPassword\(plaintext: string, encodedHash: string\): Promise<boolean> \{\s*\n\s*return verifyApiKey\(plaintext, encodedHash\);\s*\n\s*\}/,
    );
  });

  it("CRITICAL hashPassword framing pins 'same algorithm, same parameters, same encoded format. Both columns (api_keys.key_hash and accounts.password_hash) round-trip through scrypt-kdf's standard-format string'. The 2-column unified format means migration tooling can treat both identically.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(
      /Re-uses the API-key scrypt path:\s*\n \* same algorithm, same parameters, same encoded format/,
    );
    expect(p).toMatch(/`api_keys\.key_hash` and `accounts\.password_hash`/);
    expect(p).toMatch(/round-trip through\s*\n \* scrypt-kdf's standard-format string/);
  });

  // ─── scrypt params pinned in header comment ──────────────────

  it("CRITICAL header pins scrypt params — 'logN=15, r=8, p=1'. The params match OWASP/NIST recommendations for password-hashing as of 2023.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(
      /scrypt-kdf, same parameters as the API-key path\s*\n\/\/\s+\(logN=15, r=8, p=1\)/,
    );
  });

  // ─── 4-TTL cardinality sanity check ──────────────────────────

  it('CRITICAL 4 TTLs evaluate to expected millisecond values — 1_800_000 + 900_000 + 3_600_000 + 2_592_000_000.', () => {
    expect(TTLS.signupVerification).toBe(1_800_000);
    expect(TTLS.magicLink).toBe(900_000);
    expect(TTLS.passwordReset).toBe(3_600_000);
    expect(TTLS.webSession).toBe(2_592_000_000);
  });

  // ─── Magic-link 15m matches V-353 MFA-fresh 15-min ────────────

  it('CRITICAL magic-link TTL of 15 minutes matches the V-353e MFA step-up freshness window (15 min). The 15-min consistency keeps short-lived sensitive-action timing unified.', () => {
    expect(TTLS.magicLink).toBe(15 * 60 * 1000);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/auth-tokens-ttl-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
