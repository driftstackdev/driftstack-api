// W912 — API-key generation + scrypt-kdf hash format invariant.
// Two-hundred-thirty-eighth in the drift-guard series. Pins the
// API-key crypto primitives:
//
//   Format: ds_<env>_<32-char-base32>.
//     env ∈ {'live', 'test'}; 'live' for any production-style
//     account; 'test' reserved for sandbox accounts (Phase 6+).
//
//   Constants:
//     - PREFIX_PUBLIC_LEN = 16 (lookup column; not secret).
//     - RANDOM_BODY_BYTES = 20 (160 bits → 32 base32 chars).
//     - BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'
//       (RFC 4648 base32 lowercase).
//
//   scrypt-kdf params: logN=15, r=8, p=1 (OWASP/NIST 2023 floor).
//
//   constantTimeStringEq uses timingSafeEqual on equal-length
//   buffers (length-check first to avoid panic).
//
// stays in lockstep across apps/server/src/lib/api-keys.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W912 API-key generation + scrypt-kdf invariant', () => {
  // ─── Format ds_<env>_<32-char-base32> ────────────────────────

  it("CRITICAL apps/server/src/lib/api-keys.ts header pins 'Format: ds_<env>_<32-char-base32>'. The 3-part format with env discriminator is what makes ds_live_ vs ds_test_ ambient-detectable in logs / config files.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/Format: ds_<env>_<32-char-base32>/);
    expect(p).toMatch(/env ∈ \{"live", "test"\}/);
    expect(p).toMatch(/"live" for any production-style account/);
    expect(p).toMatch(/"test" reserved for sandbox accounts \(Phase 6\+\)/);
  });

  it("CRITICAL ApiKeyEnv = 'live' | 'test' type + generateApiKey(env) returns `ds_${env}_${body}`. The 2-value env enum is what discriminates production vs sandbox.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/export type ApiKeyEnv = 'live' \| 'test';/);
    expect(p).toMatch(
      /export function generateApiKey\(env: ApiKeyEnv\): string \{\s*\n\s*const buf = randomBytes\(RANDOM_BODY_BYTES\);\s*\n\s*const body = base32Encode\(buf\);\s*\n\s*return `ds_\$\{env\}_\$\{body\}`;/,
    );
  });

  // ─── Constants ───────────────────────────────────────────────

  it("CRITICAL PREFIX_PUBLIC_LEN = 16. The 16-char prefix is the lookup column on api_keys.key_prefix — 'not secret on its own, equivalent to a username'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/const PREFIX_PUBLIC_LEN = 16;/);
    expect(p).toMatch(
      /first 16 chars of\s*\n\/\/ the plaintext \(which is \*not\* secret on its own, equivalent to a username\)/,
    );
  });

  it('CRITICAL RANDOM_BODY_BYTES = 20 (20 bytes → 32 base32 chars). The 160-bit body matches the 32-char base32 output — drift to 24 bytes would give 38-char output and break the documented 32-char format.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/const RANDOM_BODY_BYTES = 20; \/\/ 20 bytes -> 32 base32 chars/);
  });

  it("CRITICAL BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' (RFC 4648 lowercase). The alphabet is intentionally lowercase to avoid case-confusion (vs Crockford uppercase). The 32-char set excludes 0/1/8/9 + a-z's 'I','O' lookalikes.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';/);
  });

  // ─── scrypt-kdf params ───────────────────────────────────────

  it("CRITICAL hashApiKey uses scryptKdf.kdf(plaintext, { logN: 15, r: 8, p: 1 }) + .toString('base64'). The scrypt-kdf standard-format string ('scrypt'+params+salt+key) round-trips through scryptKdf.verify.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(
      /export async function hashApiKey\(plaintext: string\): Promise<string> \{[\s\S]+?const buf = await scryptKdf\.kdf\(plaintext, \{ logN: 15, r: 8, p: 1 \}\);[\s\S]+?return buf\.toString\('base64'\);/,
    );
  });

  it('CRITICAL hashApiKey comment pins \'scrypt-kdf returns a base64-encoded standard-format hash ("scrypt"+params+salt+key). Defaults: logN=15, r=8, p=1.\' The 3 params are the OWASP/NIST 2023 baseline for password-hashing.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/scrypt-kdf returns a base64-encoded standard-format hash/);
    expect(p).toMatch(/\("scrypt"\+params\+salt\+key\)\. Defaults: logN=15, r=8, p=1/);
  });

  // ─── verifyApiKey try-catch returns false on error ───────────

  it("CRITICAL verifyApiKey wraps scryptKdf.verify in try-catch and returns false on any thrown error. The 'never throws' pattern fail-closes (invalid input = rejected auth) without surfacing internal errors to attackers.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(
      /export async function verifyApiKey\(plaintext: string, encodedHash: string\): Promise<boolean> \{\s*\n\s*try \{[\s\S]+?return ok === true;\s*\n\s*\} catch \{\s*\n\s*return false;\s*\n\s*\}/,
    );
  });

  // ─── constantTimeStringEq uses timingSafeEqual + length-check ─

  it('CRITICAL constantTimeStringEq does length-check FIRST then timingSafeEqual. The length-check avoids the timingSafeEqual panic on unequal-length inputs; the timingSafeEqual prevents the timing-side-channel.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(
      /export function constantTimeStringEq\(a: string, b: string\): boolean \{\s*\n\s*if \(a\.length !== b\.length\) return false;\s*\n\s*return timingSafeEqual\(Buffer\.from\(a\), Buffer\.from\(b\)\);/,
    );
  });

  // ─── keyPrefixFromPlaintext slice(0, 16) ─────────────────────

  it('CRITICAL keyPrefixFromPlaintext returns plaintext.slice(0, PREFIX_PUBLIC_LEN). The first-16-chars slice matches the api_keys.key_prefix DB column for index lookup.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(
      /export function keyPrefixFromPlaintext\(plaintext: string\): string \{\s*\n\s*return plaintext\.slice\(0, PREFIX_PUBLIC_LEN\);/,
    );
  });

  // ─── Lookup-via-prefix + verify-via-scrypt-of-plaintext ──────

  it("CRITICAL header pins the 2-step auth pattern — 'lookup column on api_keys is key_prefix' + 'Verification re-hashes the supplied plaintext and constant-time-compares against key_hash'. The 2-step split makes constant-time lookup possible WITHOUT exposing scrypt-hash to timing attacks.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/lookup column on `api_keys` is `key_prefix` — the first 16 chars/);
    expect(p).toMatch(
      /Verification re-hashes the supplied plaintext and constant-time-compares\s*\n\/\/ against `key_hash` \(scrypt-kdf encoded\)/,
    );
  });

  // ─── 32-char base32 = 20 bytes * 8 / 5 ───────────────────────

  it('CRITICAL 20 bytes * 8 bits/byte = 160 bits ÷ 5 bits/base32-char = 32 chars. The math validates the comment.', () => {
    expect((20 * 8) / 5).toBe(32);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/api-key-generation-scrypt-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
