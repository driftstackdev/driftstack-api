// W978 — api-keys lib cross-source invariant. Three-hundred-fourth
// in the drift-guard series. Pins the apps/server/src/lib/api-keys.ts
// API-key issuance + verification primitive:
//
//   Format framing — 'Format: ds_<env>_<32-char-base32>. env ∈
//   {"live", "test"}; "live" for any production-style account,
//   "test" reserved for sandbox accounts (Phase 6+)'.
//
//   Lookup-column framing — 'The lookup column on api_keys is
//   key_prefix — the first 16 chars of the plaintext (which is *not*
//   secret on its own, equivalent to a username). Verification re-
//   hashes the supplied plaintext and constant-time-compares against
//   key_hash (scrypt-kdf encoded)'.
//
//   3 constants — PREFIX_PUBLIC_LEN 16 + RANDOM_BODY_BYTES 20 +
//     BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567' (lowercase
//     RFC 4648 §6 alphabet).
//
//   ApiKeyEnv 2-value union: 'live' | 'test'.
//
//   generateApiKey(env): 20 random bytes → base32 → 'ds_<env>_<body>'
//     (32 base32 chars from 20 bytes via 5-bit grouping).
//
//   keyPrefixFromPlaintext returns plaintext.slice(0, 16).
//
//   hashApiKey uses scrypt-kdf with logN=15 + r=8 + p=1 + base64
//     output (standard scrypt format with embedded params + salt).
//
//   verifyApiKey wraps scrypt-kdf.verify with try/catch returning
//     false on any error.
//
//   constantTimeStringEq uses timingSafeEqual on equal-length
//     Buffer.from(string) — returns false-fast on length mismatch (no
//     timing leak about content length only).
//
//   base32Encode hand-rolled 5-bit-window encoder.
//
// stays in lockstep across apps/server/src/lib/api-keys.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  constantTimeStringEq,
  generateApiKey,
  hashApiKey,
  keyPrefixFromPlaintext,
  verifyApiKey,
} from '../../src/lib/api-keys.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W978 api-keys lib cross-source invariant', () => {
  // ─── Format framing ──────────────────────────────────────────

  it("CRITICAL apps/server/src/lib/api-keys.ts header pins format — 'Format: ds_<env>_<32-char-base32>. env ∈ {live, test}; live for any production-style account, test reserved for sandbox accounts (Phase 6+)'. The ds_-prefix + env-segment + 32-char-base32-body design is the API-key wire format.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/Format: ds_<env>_<32-char-base32>/);
    expect(p).toMatch(/env ∈ \{"live", "test"\}; "live" for any production-style account,/);
    expect(p).toMatch(/"test" reserved for sandbox accounts \(Phase 6\+\)\./);
  });

  // ─── Lookup-column framing ───────────────────────────────────

  it("CRITICAL lookup-column framing — 'The lookup column on api_keys is key_prefix — the first 16 chars of the plaintext (which is *not* secret on its own, equivalent to a username). Verification re-hashes the supplied plaintext and constant-time-compares against key_hash (scrypt-kdf encoded)'. The prefix-as-username + scrypt-kdf-rehash-compare design is the verification security contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/The lookup column on `api_keys` is `key_prefix` — the first 16 chars of/);
    expect(p).toMatch(
      /the plaintext \(which is \*not\* secret on its own, equivalent to a username\)\./,
    );
    expect(p).toMatch(/Verification re-hashes the supplied plaintext and constant-time-compares/);
    expect(p).toMatch(/against `key_hash` \(scrypt-kdf encoded\)\./);
  });

  // ─── 3 constants ─────────────────────────────────────────────

  it('CRITICAL PREFIX_PUBLIC_LEN = 16. The 16-char prefix is what the api_keys.key_prefix index column stores.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/const PREFIX_PUBLIC_LEN = 16;/);
  });

  it('CRITICAL RANDOM_BODY_BYTES = 20 + body produces 32 base32 chars. The 20 bytes × 8 bits / 5 bits = 32 base32 chars relationship is the format-determining constant.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/const RANDOM_BODY_BYTES = 20;/);
    expect(p).toMatch(/\/\/ 20 bytes -> 32 base32 chars/);
  });

  it("CRITICAL BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'. The 32-char lowercase RFC 4648 §6 alphabet (a-z + 2-7) avoids 0/O/1/I/l confusion in copy-paste flows.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';/);
  });

  // ─── ApiKeyEnv 2-value union ─────────────────────────────────

  it("CRITICAL ApiKeyEnv = 'live' | 'test'. The 2-value union matches the Phase-6 sandbox-vs-prod plan.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/export type ApiKeyEnv = 'live' \| 'test';/);
  });

  // ─── generateApiKey signature ────────────────────────────────

  it("CRITICAL generateApiKey signature + body — 'export function generateApiKey(env: ApiKeyEnv): string' + randomBytes(20) + base32Encode + 'ds_${env}_${body}'. The template literal is the V-079 + V-353d-style stable wire format.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/export function generateApiKey\(env: ApiKeyEnv\): string \{/);
    expect(p).toMatch(/const buf = randomBytes\(RANDOM_BODY_BYTES\);/);
    expect(p).toMatch(/const body = base32Encode\(buf\);/);
    expect(p).toMatch(/return `ds_\$\{env\}_\$\{body\}`;/);
  });

  // ─── keyPrefixFromPlaintext ──────────────────────────────────

  it('CRITICAL keyPrefixFromPlaintext returns plaintext.slice(0, PREFIX_PUBLIC_LEN). The 16-char prefix is what makes O(1) index lookup work without exposing the full secret.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/export function keyPrefixFromPlaintext\(plaintext: string\): string \{/);
    expect(p).toMatch(/return plaintext\.slice\(0, PREFIX_PUBLIC_LEN\);/);
  });

  // ─── hashApiKey scrypt params ────────────────────────────────

  it('CRITICAL hashApiKey uses scrypt-kdf with logN=15 + r=8 + p=1 + base64-encoded standard format. The 15/8/1 scrypt parameters are the V-079 KDF-strength contract — bumping logN re-hashes everything.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/export async function hashApiKey\(plaintext: string\): Promise<string> \{/);
    expect(p).toMatch(/scrypt-kdf returns a base64-encoded standard-format hash/);
    expect(p).toMatch(/\("scrypt"\+params\+salt\+key\)\. Defaults: logN=15, r=8, p=1\./);
    expect(p).toMatch(/const buf = await scryptKdf\.kdf\(plaintext, \{ logN: 15, r: 8, p: 1 \}\);/);
    expect(p).toMatch(/return buf\.toString\('base64'\);/);
  });

  // ─── verifyApiKey try/catch ──────────────────────────────────

  it("CRITICAL verifyApiKey wraps scrypt-kdf.verify with try/catch returning false on any error. The catch-all keeps the 3 failure modes (wrong hash + malformed input + corrupt encoding) all surfacing as 'invalid key'.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(
      /export async function verifyApiKey\(plaintext: string, encodedHash: string\): Promise<boolean> \{/,
    );
    expect(p).toMatch(/try \{/);
    expect(p).toMatch(
      /const ok = await scryptKdf\.verify\(Buffer\.from\(encodedHash, 'base64'\), plaintext\);/,
    );
    expect(p).toMatch(/return ok === true;/);
    expect(p).toMatch(/\} catch \{/);
    expect(p).toMatch(/return false;/);
  });

  // ─── constantTimeStringEq length-fast-fail ───────────────────

  it("CRITICAL constantTimeStringEq fast-fails on length mismatch — 'if (a.length !== b.length) return false;'. The length-fast-fail only leaks length difference (not content), which is acceptable.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/export function constantTimeStringEq\(a: string, b: string\): boolean \{/);
    expect(p).toMatch(/if \(a\.length !== b\.length\) return false;/);
    expect(p).toMatch(/return timingSafeEqual\(Buffer\.from\(a\), Buffer\.from\(b\)\);/);
  });

  // ─── base32Encode 5-bit window ───────────────────────────────

  it('CRITICAL base32Encode 5-bit-window encoder — bits/value running counters + while bits>=5 emit + final-partial-byte flush. The hand-rolled encoder matches the RFC 4648 §6 algorithm without depending on an external lib.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts'));
    expect(p).toMatch(/function base32Encode\(buf: Buffer\): string \{/);
    expect(p).toMatch(/let bits = 0;/);
    expect(p).toMatch(/let value = 0;/);
    expect(p).toMatch(/value = \(value << 8\) \| byte;/);
    expect(p).toMatch(/while \(bits >= 5\) \{/);
    expect(p).toMatch(/out \+= BASE32_ALPHABET\[\(value >>> \(bits - 5\)\) & 0x1f\];/);
    expect(p).toMatch(/out \+= BASE32_ALPHABET\[\(value << \(5 - bits\)\) & 0x1f\];/);
  });

  // ─── Runtime — generateApiKey format ─────────────────────────

  it("CRITICAL runtime generateApiKey produces ds_live_<32 base32 chars> for env='live'. The 32-char body is the 20-byte → 5-bit-grouped invariant.", () => {
    const k = generateApiKey('live');
    expect(k).toMatch(/^ds_live_[a-z2-7]{32}$/);
  });

  it("CRITICAL runtime generateApiKey produces ds_test_<32 base32 chars> for env='test'. The lowercase + 2-7 alphabet is what makes the key URL-safe + copy-paste-unambiguous.", () => {
    const k = generateApiKey('test');
    expect(k).toMatch(/^ds_test_[a-z2-7]{32}$/);
  });

  it('CRITICAL runtime generateApiKey produces unique keys per call. randomBytes(20) gives 2^160 entropy; collision-by-chance is negligible.', () => {
    const k1 = generateApiKey('live');
    const k2 = generateApiKey('live');
    expect(k1).not.toBe(k2);
  });

  // ─── Runtime — keyPrefixFromPlaintext ────────────────────────

  it('CRITICAL runtime keyPrefixFromPlaintext returns the first 16 chars. For a live key ds_live_<body> that means the prefix is ds_live_<first 8 of body>.', () => {
    const k = generateApiKey('live');
    const prefix = keyPrefixFromPlaintext(k);
    expect(prefix).toBe(k.slice(0, 16));
    expect(prefix.length).toBe(16);
  });

  // ─── Runtime — hash + verify roundtrip ───────────────────────

  it('CRITICAL runtime hash → verify roundtrip — the same plaintext verifies, a different plaintext does not. The pair forms the API-key auth contract.', async () => {
    const k = generateApiKey('live');
    const h = await hashApiKey(k);
    await expect(verifyApiKey(k, h)).resolves.toBe(true);
    await expect(verifyApiKey('wrong-plaintext', h)).resolves.toBe(false);
  });

  it('CRITICAL runtime verifyApiKey returns false on malformed hash. The try/catch swallows the scrypt-kdf throw and returns false instead of propagating.', async () => {
    await expect(verifyApiKey('any-plaintext', 'not-a-valid-base64-scrypt-hash')).resolves.toBe(
      false,
    );
  });

  // ─── Runtime — constantTimeStringEq ──────────────────────────

  it('CRITICAL runtime constantTimeStringEq returns true on identical strings, false on different-content equal-length strings, false on different-length strings.', () => {
    expect(constantTimeStringEq('abc', 'abc')).toBe(true);
    expect(constantTimeStringEq('abc', 'abd')).toBe(false);
    expect(constantTimeStringEq('abc', 'abcd')).toBe(false);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/api-keys-lib-cross-source-invariant.test.ts'),
      ),
    ).toBe(true);
  });
});
