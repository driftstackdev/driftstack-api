// W960 — auth-tokens lib V-079 + 4-TTL cross-source invariant.
// Two-hundred-eighty-sixth in the drift-guard series. Pins the user-
// facing auth-flow token primitives:
//
//   Service intro framing — 'Helpers for the user-facing auth flow
//   (signup/verify/login/magic-link/password-reset/web-session).
//   Distinct from api-keys.ts which generates long-lived API keys
//   for SDK consumers'.
//
//   2 primitive groups:
//     1. Password hashing — scrypt-kdf, same parameters as the
//        API-key path (logN=15, r=8, p=1). Re-uses the api-keys
//        hashing functions to avoid divergence.
//     2. Opaque single-use tokens — 32 random bytes encoded as
//        URL-safe base64, sha256-hashed at rest. Plaintext sent
//        ONCE; hash provides constant-time-equality lookup.
//
//   sha256-vs-scrypt rationale — 'Sha256 is sufficient here because
//   the input has full random entropy (256 bits) — scrypt is
//   reserved for low-entropy user-chosen passwords'.
//
//   TOKEN_RANDOM_BYTES = 32.
//
//   AUTH_TOKEN_TTL_MS 4-flow map:
//     - signupVerification: 30 * 60 * 1000 (30 minutes).
//     - magicLink: 15 * 60 * 1000 (15 minutes).
//     - passwordReset: 60 * 60 * 1000 (1 hour).
//     - webSession: 30 * 24 * 60 * 60 * 1000 (30 days).
//
//   5 exports: TOKEN_RANDOM_BYTES + generateAuthToken + tokenHash
//     + hashPassword + verifyPassword + AUTH_TOKEN_TTL_MS.
//
// stays in lockstep across apps/server/src/lib/auth-tokens.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AUTH_TOKEN_TTL_MS,
  TOKEN_RANDOM_BYTES,
  generateAuthToken,
  tokenHash,
} from '../../src/lib/auth-tokens.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W960 auth-tokens lib cross-source invariant', () => {
  // ─── Service intro framing ───────────────────────────────────

  it("CRITICAL apps/server/src/lib/auth-tokens.ts header pins surface — 'Helpers for the user-facing auth flow (signup/verify/login/magic-link/password-reset/web-session). Distinct from api-keys.ts which generates long-lived API keys for SDK consumers'. The user-flow-vs-API-key distinction is the V-079 scope split.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(
      /Helpers for the user-facing auth flow \(signup\/verify\/login\/magic-link\//,
    );
    expect(p).toMatch(
      /password-reset\/web-session\)\. Distinct from `api-keys\.ts` which generates/,
    );
    expect(p).toMatch(/long-lived API keys for SDK consumers\./);
  });

  // ─── 2-primitive split framing ───────────────────────────────

  it("CRITICAL 2-primitive framing — '1. Password hashing — scrypt-kdf, same parameters as the API-key path (logN=15, r=8, p=1). Re-uses the api-keys hashing functions to avoid divergence; the storage column is accounts.password_hash. 2. Opaque single-use tokens — 32 random bytes encoded as URL-safe base64, sha256-hashed at rest. The plaintext is sent ONCE (via Postmark for email-bearing flows; in the response body for web-session login). The hash provides a constant-time-equality lookup index without storing reversible material'. The 2-primitive split is the auth-flow crypto contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/1\. Password hashing — scrypt-kdf, same parameters as the API-key path/);
    expect(p).toMatch(/\(logN=15, r=8, p=1\)\. Re-uses the api-keys hashing functions to/);
    expect(p).toMatch(/avoid divergence; the storage column is `accounts\.password_hash`/);
    expect(p).toMatch(/2\. Opaque single-use tokens — 32 random bytes encoded as URL-safe/);
    expect(p).toMatch(/base64, sha256-hashed at rest\. The plaintext is sent ONCE/);
    expect(p).toMatch(/\(via Postmark for email-bearing flows; in the response body for/);
    expect(p).toMatch(/web-session login\)\. The hash provides a constant-time-equality/);
    expect(p).toMatch(/lookup index without storing reversible material\./);
  });

  // ─── 4-flow TTL header listing ───────────────────────────────

  it("CRITICAL header pins 4-flow TTL listing — 'Token lifetime defaults (caller can override per-flow): - signup-verification: 30 minutes - magic-link: 15 minutes - password-reset: 1 hour - web-session: 30 days'. The 4-flow listing is the customer-facing TTL contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/Token lifetime defaults \(caller can override per-flow\):/);
    expect(p).toMatch(/- signup-verification: 30 minutes/);
    expect(p).toMatch(/- magic-link: {11}15 minutes/);
    expect(p).toMatch(/- password-reset: {8}1 hour/);
    expect(p).toMatch(/- web-session: {10}30 days/);
  });

  // ─── TOKEN_RANDOM_BYTES = 32 ─────────────────────────────────

  it('CRITICAL TOKEN_RANDOM_BYTES = 32. The 32-byte (256-bit) entropy is what makes sha256-at-rest sufficient (matches V-353d mfa-challenge + V-266 cli-authorize 32-byte token primitive).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/export const TOKEN_RANDOM_BYTES = 32;/);
    expect(TOKEN_RANDOM_BYTES).toBe(32);
  });

  // ─── generateAuthToken format ────────────────────────────────

  it("CRITICAL generateAuthToken JSDoc — 'Generate a URL-safe single-use auth token. Returned plaintext is sent to the user once; only tokenHash(plaintext) should ever land in the database'. The plaintext-once + hash-at-rest contract matches V-079 + V-353d + V-266 + V-934 cross-service pattern.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/Generate a URL-safe single-use auth token\. Returned plaintext is sent/);
    expect(p).toMatch(/to the user once; only `tokenHash\(plaintext\)` should ever land in the/);
    expect(p).toMatch(/database\./);
  });

  it('CRITICAL generateAuthToken impl — \'randomBytes(TOKEN_RANDOM_BYTES).toString("base64url")\'. The URL-safe base64 encoding matches W917 mfa-challenge-store generateChallengeToken pattern.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/return randomBytes\(TOKEN_RANDOM_BYTES\)\.toString\('base64url'\);/);
  });

  it('CRITICAL generateAuthToken runtime — returns 43-char base64url string (32 bytes → 43 chars unpadded). Matches W917 mfa-challenge-store generateChallengeToken exactly.', () => {
    const token = generateAuthToken();
    expect(token).toHaveLength(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('CRITICAL generateAuthToken distinct on each call — no collisions in 10 samples. The randomness is what makes per-flow tokens unique.', () => {
    const tokens = new Set<string>();
    for (let i = 0; i < 10; i++) tokens.add(generateAuthToken());
    expect(tokens.size).toBe(10);
  });

  // ─── tokenHash sha256 framing ────────────────────────────────

  it("CRITICAL tokenHash JSDoc — 'Hash an auth token for at-rest storage / lookup. Sha256 is sufficient here because the input has full random entropy (256 bits) — scrypt is reserved for low-entropy user-chosen passwords'. The sha256-vs-scrypt rationale is the 32-byte-entropy justification.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/Hash an auth token for at-rest storage \/ lookup\. Sha256 is sufficient/);
    expect(p).toMatch(/here because the input has full random entropy \(256 bits\) — scrypt is/);
    expect(p).toMatch(/reserved for low-entropy user-chosen passwords\./);
  });

  it('CRITICAL tokenHash impl — sha256 hex digest. Matches W924 auth-cache sha256Hex pattern (lib-level sha256 primitive across services).', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/return createHash\('sha256'\)\.update\(plaintext\)\.digest\('hex'\);/);
  });

  it('CRITICAL tokenHash runtime — returns 64-char hex digest matching /^[0-9a-f]{64}$/. Mechanically verified against createHash round-trip.', () => {
    const hash = tokenHash('test-token');
    const expected = createHash('sha256').update('test-token').digest('hex');
    expect(hash).toBe(expected);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  // ─── hashPassword scrypt-kdf reuse framing ───────────────────

  it("CRITICAL hashPassword JSDoc — 'Hash a password for at-rest storage. Re-uses the API-key scrypt path: same algorithm, same parameters, same encoded format. Both columns (api_keys.key_hash and accounts.password_hash) round-trip through scrypt-kdf's standard-format string'. The same-algo + same-params + same-format triple-match is the V-079 + W912 cross-column invariant.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/Hash a password for at-rest storage\. Re-uses the API-key scrypt path:/);
    expect(p).toMatch(/same algorithm, same parameters, same encoded format\. Both columns/);
    expect(p).toMatch(/\(`api_keys\.key_hash` and `accounts\.password_hash`\) round-trip through/);
    expect(p).toMatch(/scrypt-kdf's standard-format string\./);
  });

  it('CRITICAL hashPassword delegates to hashApiKey + verifyPassword delegates to verifyApiKey. The thin-delegate prevents per-column scrypt-param drift.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/import \{ hashApiKey, verifyApiKey \} from '\.\/api-keys\.js';/);
    expect(p).toMatch(/return hashApiKey\(plaintext\);/);
    expect(p).toMatch(/return verifyApiKey\(plaintext, encodedHash\);/);
  });

  // ─── AUTH_TOKEN_TTL_MS 4-flow map ────────────────────────────

  it("CRITICAL AUTH_TOKEN_TTL_MS framing — 'Default lifetimes per flow (in milliseconds). Caller may override'. The caller-may-override design lets per-route flows pick tighter windows (e.g. dev/test).", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/Default lifetimes per flow \(in milliseconds\)\. Caller may override\./);
  });

  it('CRITICAL AUTH_TOKEN_TTL_MS source-level values: signupVerification 30*60*1000 + magicLink 15*60*1000 + passwordReset 60*60*1000 + webSession 30*24*60*60*1000. Mechanically pinned via source.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/export const AUTH_TOKEN_TTL_MS = \{/);
    expect(p).toMatch(/signupVerification: 30 \* 60 \* 1000,/);
    expect(p).toMatch(/magicLink: 15 \* 60 \* 1000,/);
    expect(p).toMatch(/passwordReset: 60 \* 60 \* 1000,/);
    expect(p).toMatch(/webSession: 30 \* 24 \* 60 \* 60 \* 1000,/);
    expect(p).toMatch(/\} as const;/);
  });

  it('CRITICAL AUTH_TOKEN_TTL_MS runtime — signupVerification=1_800_000 (30 min) + magicLink=900_000 (15 min) + passwordReset=3_600_000 (1 hr) + webSession=2_592_000_000 (30 days). The 4-flow numerics matches W911 V-079 auth-tokens-ttl invariant.', () => {
    expect(AUTH_TOKEN_TTL_MS.signupVerification).toBe(1_800_000);
    expect(AUTH_TOKEN_TTL_MS.magicLink).toBe(900_000);
    expect(AUTH_TOKEN_TTL_MS.passwordReset).toBe(3_600_000);
    expect(AUTH_TOKEN_TTL_MS.webSession).toBe(2_592_000_000);
  });

  it('CRITICAL AUTH_TOKEN_TTL_MS uses `as const` — readonly literal types prevent accidental TTL mutation at compile time.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/auth-tokens.ts'));
    expect(p).toMatch(/\} as const;/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/auth-tokens-lib-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
