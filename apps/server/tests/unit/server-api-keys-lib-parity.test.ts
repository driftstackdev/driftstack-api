// W746 — server-side apps/server/src/lib/api-keys.ts canonical
// API-key format + scrypt-kdf hashing + base32 encoding parity.
// Seventy-second in the cross-SDK drift-guard series.
//
// The lib is the cryptographic core of the entire API-key surface:
// every API call goes through verifyApiKey(). Drift here would
// break authentication for every customer.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/api-keys.ts');

describe('W746 server api-keys lib (format + scrypt + base32) parity', () => {
  it('api-keys.ts file exists', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  it("CRITICAL key format pinned — `ds_<env>_<32-char-base32>`. The 3-segment structure is what makes keys identifiable in logs (`ds_live_*` vs `ds_test_*`) without decoding. Drift to a different shape would break every customer's key + log-search workflow.", () => {
    const l = read(LIB);

    expect(l).toMatch(
      /Format: ds_<env>_<32-char-base32>\s*\n\/\/\s+env ∈ \{"live", "test"\}; "live" for any production-style account,\s*\n\/\/\s+"test" reserved for sandbox accounts \(Phase 6\+\)/,
    );
  });

  it('CRITICAL ApiKeyEnv 2-value union pinned — `live` | `test`. Drift to a 3rd env (sandbox, dev, etc.) would change the key-prefix discrimination in the customer dashboard + admin panel.', () => {
    const l = read(LIB);
    expect(l).toMatch(/export type ApiKeyEnv = 'live' \| 'test';/);
  });

  it('CRITICAL PREFIX_PUBLIC_LEN = 16 pinned. The 16-char prefix is what gets stored as `key_prefix` in the api_keys DB column for fast lookup. Drift would mismatch the column index + force a migration.', () => {
    const l = read(LIB);
    expect(l).toMatch(/const PREFIX_PUBLIC_LEN = 16;/);
  });

  it('CRITICAL RANDOM_BODY_BYTES = 20 pinned (-> 32 base32 chars). 20 bytes = 160 bits entropy — adequate-but-not-overkill per the W716 webhook-signing equivalent. Drift to fewer bytes would weaken the key; more would push past 32 chars.', () => {
    const l = read(LIB);
    expect(l).toMatch(/const RANDOM_BODY_BYTES = 20; \/\/ 20 bytes -> 32 base32 chars/);
  });

  it('CRITICAL RFC 4648 lowercase base32 alphabet pinned — `abcdefghijklmnopqrstuvwxyz234567`. Matches W716 webhook-signing alphabet. Drift to uppercase OR Crockford (no I/L/O/U) would silently produce different keys.', () => {
    const l = read(LIB);
    expect(l).toMatch(/const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';/);
  });

  it('CRITICAL key_prefix lookup column framing pinned — "the first 16 chars of the plaintext (which is *not* secret on its own, equivalent to a username). Verification re-hashes the supplied plaintext and constant-time-compares against key_hash (scrypt-kdf encoded)". The 2-column split (prefix lookup + hash compare) is what makes verification both fast + safe.', () => {
    const l = read(LIB);

    expect(l).toMatch(
      /The lookup column on `api_keys` is `key_prefix` — the first 16 chars of\s*\n\/\/\s+the plaintext \(which is \*not\* secret on its own, equivalent to a username\)/,
    );
    expect(l).toMatch(
      /Verification re-hashes the supplied plaintext and constant-time-compares\s*\n\/\/\s+against `key_hash` \(scrypt-kdf encoded\)/,
    );
  });

  it('CRITICAL generateApiKey(env) signature + impl pinned — `ds_${env}_${body}` template. Drift to a different separator (e.g. dash) would break customer log-parsers.', () => {
    const l = read(LIB);

    expect(l).toMatch(
      /export function generateApiKey\(env: ApiKeyEnv\): string \{\s*\n\s+const buf = randomBytes\(RANDOM_BODY_BYTES\);\s*\n\s+const body = base32Encode\(buf\);\s*\n\s+return `ds_\$\{env\}_\$\{body\}`;/,
    );
  });

  it('CRITICAL keyPrefixFromPlaintext slices first PREFIX_PUBLIC_LEN chars. Drift to slicing by env-strip (e.g. dropping `ds_live_`) would break the column lookup.', () => {
    const l = read(LIB);

    expect(l).toMatch(
      /export function keyPrefixFromPlaintext\(plaintext: string\): string \{\s*\n\s+return plaintext\.slice\(0, PREFIX_PUBLIC_LEN\);/,
    );
  });

  it('CRITICAL scrypt-kdf params pinned — logN=15, r=8, p=1. Drift to weaker params would silently weaken every customer key; drift to stronger would slow auth verification 5-10x.', () => {
    const l = read(LIB);

    expect(l).toMatch(/scrypt-kdf returns a base64-encoded standard-format hash/);
    expect(l).toMatch(/\("scrypt"\+params\+salt\+key\)\. Defaults: logN=15, r=8, p=1/);

    expect(l).toMatch(/const buf = await scryptKdf\.kdf\(plaintext, \{ logN: 15, r: 8, p: 1 \}\)/);
  });

  it('CRITICAL hashApiKey returns base64-encoded hash. The base64 encoding is what makes the hash storable in a TEXT column without binary-encoding gymnastics.', () => {
    const l = read(LIB);

    expect(l).toMatch(
      /export async function hashApiKey\(plaintext: string\): Promise<string> \{[\s\S]*?return buf\.toString\('base64'\);/,
    );
  });

  it('CRITICAL verifyApiKey returns boolean (NOT throws). The try/catch + `ok === true` pattern means malformed hashes return false instead of crashing the request handler. Drift to throwing would force every auth callsite to wrap in try/catch.', () => {
    const l = read(LIB);

    expect(l).toMatch(
      /export async function verifyApiKey\(plaintext: string, encodedHash: string\): Promise<boolean> \{\s*\n\s+try \{\s*\n\s+const ok = await scryptKdf\.verify\(Buffer\.from\(encodedHash, 'base64'\), plaintext\);\s*\n\s+return ok === true;\s*\n\s+\} catch \{\s*\n\s+return false;/,
    );
  });

  it('CRITICAL constantTimeStringEq pinned with timingSafeEqual. Drift to `===` would let timing attacks reveal plaintext-prefix matches. The length-mismatch fast-path is intentional (timingSafeEqual itself throws on different-length buffers).', () => {
    const l = read(LIB);

    expect(l).toMatch(
      /export function constantTimeStringEq\(a: string, b: string\): boolean \{\s*\n\s+if \(a\.length !== b\.length\) return false;\s*\n\s+return timingSafeEqual\(Buffer\.from\(a\), Buffer\.from\(b\)\);/,
    );
  });

  it('CRITICAL base32Encode 5-bit-grouping with high-bit carry. Standard RFC 4648 base32 (NOT Crockford). Same encoder shape as W716 webhook-signing — drift would silently produce different keys.', () => {
    const l = read(LIB);

    // 5-bit grouping.
    expect(l).toMatch(/value = \(value << 8\) \| byte/);
    expect(l).toMatch(/bits \+= 8/);
    expect(l).toMatch(/while \(bits >= 5\)/);
    expect(l).toMatch(/out \+= BASE32_ALPHABET\[\(value >>> \(bits - 5\)\) & 0x1f\]/);

    // Tail-byte handling (left-shift to align).
    expect(l).toMatch(
      /if \(bits > 0\) \{\s*\n\s+out \+= BASE32_ALPHABET\[\(value << \(5 - bits\)\) & 0x1f\]/,
    );
  });

  it('CRITICAL randomBytes + timingSafeEqual imports from node:crypto. The CSPRNG randomBytes is what gives keys 160-bit entropy; drift to Math.random would silently weaken every customer key to predictable.', () => {
    const l = read(LIB);
    expect(l).toMatch(/import \{ randomBytes, timingSafeEqual \} from 'node:crypto';/);
  });

  it("CRITICAL scrypt-kdf imported as default — `import scryptKdf from 'scrypt-kdf'`. Drift to a different import shape (named) would break the .kdf() + .verify() calls.", () => {
    const l = read(LIB);
    expect(l).toMatch(/import scryptKdf from 'scrypt-kdf';/);
  });

  it('CRITICAL 4 exported functions pinned — generateApiKey + keyPrefixFromPlaintext + hashApiKey + verifyApiKey + constantTimeStringEq. (5 total: also includes constantTimeStringEq.) Drift to dropping any would force the route handlers to inline the logic.', () => {
    const l = read(LIB);

    expect(l).toMatch(/^export function generateApiKey\(/m);
    expect(l).toMatch(/^export function keyPrefixFromPlaintext\(/m);
    expect(l).toMatch(/^export async function hashApiKey\(/m);
    expect(l).toMatch(/^export async function verifyApiKey\(/m);
    expect(l).toMatch(/^export function constantTimeStringEq\(/m);
    expect(l).toMatch(/^export type ApiKeyEnv = /m);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(resolve(REPO_ROOT, 'apps/server/tests/unit/server-api-keys-lib-parity.test.ts')),
    ).toBe(true);
  });
});
