// W386.B — drift guard for apps/server/src/lib/api-keys.ts. This
// is the security-critical API-key issuance + verification module
// referenced by /trust/security-overview ("scrypt N=2^15, r=8, p=1
// + apps/server/src/lib/api-keys.ts · hashApiKey() / verifyApiKey()").
// Behavioural tests cover round-tripping, but a content-parity
// guard catches silent drift in:
//
//   • Format spec: `ds_<env>_<32-char-base32>`.
//   • PREFIX_PUBLIC_LEN = 16 (key_prefix column width).
//   • RANDOM_BODY_BYTES = 20 (20 bytes → 32 base32 chars).
//   • BASE32_ALPHABET = RFC 4648 lowercase a-z + 2-7 (no padding).
//   • ApiKeyEnv union: 'live' | 'test'.
//   • scrypt-kdf params: logN: 15 (N=2^15), r: 8, p: 1 — matches
//     trust-page claim.
//   • timingSafeEqual + length-pre-check (constantTimeStringEq).
//   • verifyApiKey returns false on throw (no info-leak).
//   • Phase 6+ "test" sandbox-account framing pinned.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W386.B apps/server/src/lib/api-keys.ts content parity', () => {
  const body = read(LIB);

  it('format spec pinned: ds_<env>_<32-char-base32>', () => {
    expect(body).toMatch(/Format: ds_<env>_<32-char-base32>/);
  });

  it('env semantics pinned: "live" prod + "test" Phase 6+ sandbox reservation', () => {
    expect(body).toMatch(
      /env ∈ \{"live", "test"\}; "live" for any production-style account,\s*\/\/\s*"test" reserved for sandbox accounts \(Phase 6\+\)/,
    );
  });

  it('key_prefix column framing: first 16 chars (NOT secret, equivalent to a username)', () => {
    expect(body).toMatch(
      /first 16 chars of\s*\/\/\s*the plaintext \(which is \*not\* secret on its own, equivalent to a username\)/,
    );
  });

  it('verification re-hash + constant-time compare framing', () => {
    expect(body).toMatch(
      /Verification re-hashes the supplied plaintext and constant-time-compares\s*\/\/\s*against `key_hash` \(scrypt-kdf encoded\)/,
    );
  });

  it('PREFIX_PUBLIC_LEN = 16 + RANDOM_BODY_BYTES = 20 (32 base32 chars)', () => {
    expect(body).toMatch(/const PREFIX_PUBLIC_LEN = 16;/);
    expect(body).toMatch(/const RANDOM_BODY_BYTES = 20; \/\/ 20 bytes -> 32 base32 chars/);
  });

  it('BASE32_ALPHABET = RFC 4648 lowercase a-z + digits 2-7 (no padding chars)', () => {
    expect(body).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';/);
  });

  it('ApiKeyEnv union: "live" | "test"', () => {
    expect(body).toMatch(/export type ApiKeyEnv = 'live' \| 'test';/);
  });

  it('generateApiKey: returns ds_${env}_${body} format via randomBytes(20) → base32Encode', () => {
    expect(body).toMatch(/export function generateApiKey\(env: ApiKeyEnv\): string/);
    expect(body).toMatch(/const buf = randomBytes\(RANDOM_BODY_BYTES\);/);
    expect(body).toMatch(/const body = base32Encode\(buf\);/);
    expect(body).toMatch(/return `ds_\$\{env\}_\$\{body\}`;/);
  });

  it('keyPrefixFromPlaintext: slice(0, PREFIX_PUBLIC_LEN)', () => {
    expect(body).toMatch(
      /export function keyPrefixFromPlaintext\(plaintext: string\): string \{\s*return plaintext\.slice\(0, PREFIX_PUBLIC_LEN\);\s*\}/,
    );
  });

  it('hashApiKey: scrypt-kdf with logN=15 (N=2^15), r=8, p=1 — matches /trust/security-overview claim', () => {
    expect(body).toMatch(/export async function hashApiKey\(plaintext: string\): Promise<string>/);
    expect(body).toMatch(
      /const buf = await scryptKdf\.kdf\(plaintext, \{ logN: 15, r: 8, p: 1 \}\);/,
    );
    expect(body).toMatch(/return buf\.toString\('base64'\);/);
  });

  it('hashApiKey docs: scrypt-kdf returns base64-encoded standard-format hash', () => {
    expect(body).toMatch(
      /scrypt-kdf returns a base64-encoded standard-format hash\s*\/\/\s*\("scrypt"\+params\+salt\+key\)/,
    );
  });

  it('verifyApiKey: returns false on throw (no info-leak)', () => {
    expect(body).toMatch(
      /export async function verifyApiKey\(plaintext: string, encodedHash: string\): Promise<boolean>/,
    );
    expect(body).toMatch(/scryptKdf\.verify\(Buffer\.from\(encodedHash, 'base64'\), plaintext\)/);
    expect(body).toMatch(/return ok === true;/);
    expect(body).toMatch(/\} catch \{\s*return false;\s*\}/);
  });

  it('constantTimeStringEq: length pre-check + timingSafeEqual (no early-exit on length-mismatch)', () => {
    expect(body).toMatch(
      /export function constantTimeStringEq\(a: string, b: string\): boolean \{\s*if \(a\.length !== b\.length\) return false;\s*return timingSafeEqual\(Buffer\.from\(a\), Buffer\.from\(b\)\);\s*\}/,
    );
  });

  it('imports: randomBytes + timingSafeEqual from node:crypto + scryptKdf', () => {
    expect(body).toMatch(/import \{ randomBytes, timingSafeEqual \} from 'node:crypto';/);
    expect(body).toMatch(/import scryptKdf from 'scrypt-kdf';/);
  });

  it('base32Encode helper: bit-shift implementation with 5-bit groups + tail-bits handling', () => {
    expect(body).toMatch(/function base32Encode\(buf: Buffer\): string/);
    expect(body).toMatch(/while \(bits >= 5\) \{/);
    expect(body).toMatch(/out \+= BASE32_ALPHABET\[\(value >>> \(bits - 5\)\) & 0x1f\];/);
    expect(body).toMatch(
      /if \(bits > 0\) \{[\s\S]+?out \+= BASE32_ALPHABET\[\(value << \(5 - bits\)\) & 0x1f\];/,
    );
  });

  it('file exists at canonical path referenced by /trust/security-overview', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
