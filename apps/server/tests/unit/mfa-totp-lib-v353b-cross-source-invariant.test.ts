// W964 — V-353b mfa-totp lib RFC 6238 + AES-256-GCM cross-source
// invariant. Two-hundred-ninetieth in the drift-guard series. Pins
// the TOTP + recovery-code crypto primitives:
//
//   V-353b anchor — 'V-353b — TOTP (RFC 6238) + AES-256-GCM secret-
//   encryption helpers'.
//
//   Algorithm choices (founder verdict V-353a):
//     - SHA-1 / 30s period / 6 digits — auth-app compat.
//     - ±1 window drift tolerance — total verification range = 90s.
//     - At-rest encryption: AES-256-GCM with env-supplied
//       MFA_ENCRYPTION_KEY (32 random bytes, base64).
//
//   Constants:
//     - TOTP_PERIOD_SECONDS = 30.
//     - TOTP_DIGITS = 6.
//     - TOTP_DRIFT_WINDOWS = 1 (±1 window = 90s total verify range).
//     - SECRET_RAW_BYTES = 20.
//     - GCM_IV_BYTES = 12.
//     - GCM_TAG_BYTES = 16.
//     - BASE32_ALPHABET = uppercase RFC 4648 (Google Authenticator
//       compat — distinct from W912 api-keys lowercase alphabet).
//
//   Exports:
//     - generateTotpSecret → { secretBase32, secretBytes }.
//     - computeTotpCode(secretBytes, whenSeconds) → 6-digit string.
//     - verifyTotpCode(secretBytes, code, nowSeconds?) → boolean.
//     - otpauthUri({ email, secretBase32 }) → otpauth:// URI.
//     - encryptSecret / decryptSecret (AES-256-GCM round-trip).
//     - generateRecoveryCodes(count?) — default 10 codes.
//     - normalizeRecoveryCode(input) — strips whitespace + hyphens.
//
//   Recovery code constants:
//     - RECOVERY_COUNT = 10.
//     - RECOVERY_LENGTH = 10 chars.
//     - RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789' (no
//       ambiguous 0/1/I/O/L; Crockford base32 shape).
//     - Hyphenated: 'ABCDE-FGHJK' format.
//
//   otpauthUri framing — 'Issuer is fixed (Driftstack); label is
//   the user's email so auth apps can show "Driftstack: alice@…".
//   Algorithm is implicit SHA-1; period 30; 6 digits — defaults
//   match every auth app'.
//
//   AES-256-GCM framing — 'AES-256-GCM encryption of the TOTP
//   secret with the env-supplied 32-byte key. Returns base64-encoded
//   ciphertext + iv + tag (text columns; bytea also viable but text
//   is friendlier for direct DB inspection during incidents)'.
//
// stays in lockstep across apps/server/src/lib/mfa-totp.ts.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  TOTP_DIGITS,
  TOTP_DRIFT_WINDOWS,
  TOTP_PERIOD_SECONDS,
  computeTotpCode,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  otpauthUri,
  verifyTotpCode,
} from '../../src/lib/mfa-totp.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const TEST_KEY_BASE64 = randomBytes(32).toString('base64');
const TEST_ACCOUNT_ID = 'acc_mfa_cross_source';

describe('W964 V-353b mfa-totp lib cross-source invariant', () => {
  // ─── V-353b anchor + RFC 6238 framing ────────────────────────

  it("CRITICAL apps/server/src/lib/mfa-totp.ts header pins V-353b anchor — 'V-353b — TOTP (RFC 6238) + AES-256-GCM secret-encryption helpers'. The V-353b + RFC 6238 + AES-256-GCM combination is the policy provenance.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/V-353b — TOTP \(RFC 6238\) \+ AES-256-GCM secret-encryption helpers\./);
  });

  // ─── V-353a founder-verdict algorithm choices ────────────────

  it('CRITICAL V-353a algorithm-choice framing pins auth-app-compatible TOTP and account-bound AES-GCM v2', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/Algorithm choices \(founder verdict V-353a\):/);
    expect(p).toMatch(/- SHA-1 \/ 30s period \/ 6 digits — auth-app compat \(Google/);
    expect(p).toMatch(/Authenticator, 1Password, Authy, Bitwarden, etc\. all support\)\./);
    expect(p).toMatch(/- ±1 window drift tolerance — total verification range = 90s\./);
    expect(p).toMatch(/- At-rest encryption: AES-256-GCM with the env-supplied/);
    expect(p).toMatch(/`MFA_ENCRYPTION_KEY` \(32 random bytes, base64\)\. The v2 envelope binds/);
    expect(p).toMatch(/its purpose \+ account identity as GCM additional authenticated data\./);
  });

  // ─── TOTP_PERIOD_SECONDS / TOTP_DIGITS / TOTP_DRIFT_WINDOWS ──

  it('CRITICAL TOTP constants — TOTP_PERIOD_SECONDS = 30 + TOTP_DIGITS = 6 + TOTP_DRIFT_WINDOWS = 1. Mechanically verified via exports.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/export const TOTP_PERIOD_SECONDS = 30;/);
    expect(p).toMatch(/export const TOTP_DIGITS = 6;/);
    expect(p).toMatch(/export const TOTP_DRIFT_WINDOWS = 1;/);
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_DRIFT_WINDOWS).toBe(1);
  });

  // ─── Secret + AES-GCM byte constants ─────────────────────────

  it('CRITICAL byte-length constants — SECRET_RAW_BYTES = 20 + GCM_IV_BYTES = 12 + GCM_TAG_BYTES = 16. The 12-byte IV + 16-byte tag are AES-256-GCM standard sizes; 20-byte secret matches RFC 4226 §5 minimum-recommended.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/const SECRET_RAW_BYTES = 20;/);
    // The AES-GCM parameters are IMPORTED, not redeclared. Ten encryption
    // modules each held their own copy with their own pin like this one, so
    // every copy was covered and nothing required the ten to agree.
    expect(p).toContain("from './aes-gcm-parameters.js'");
    expect(p).not.toMatch(/const (?:AES_256_KEY_BYTES|GCM_IV_BYTES|GCM_TAG_BYTES) = /);
  });

  // ─── BASE32_ALPHABET uppercase (distinct from W912 api-keys) ─

  it("CRITICAL BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' (uppercase RFC 4648). Distinct from W912 api-keys + W917 mfa-challenge + W959 webhook-signing which use lowercase — uppercase is what auth apps (Google Authenticator etc.) display.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';/);
  });

  // ─── generateTotpSecret framing ──────────────────────────────

  it("CRITICAL generateTotpSecret JSDoc — 'V-353b — generate a fresh 20-byte TOTP secret + return its base32-encoded form (what auth apps consume). The plaintext is never persisted; caller encrypts via encryptSecret before insert'. The plaintext-never-persisted + encrypt-before-insert design is the V-353b at-rest contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/V-353b — generate a fresh 20-byte TOTP secret \+ return its base32-/);
    expect(p).toMatch(/encoded form \(what auth apps consume\)\. The plaintext is never/);
    expect(p).toMatch(/persisted; caller encrypts via `encryptSecret` before insert\./);
  });

  // ─── computeTotpCode HOTP truncate framing ───────────────────

  it("CRITICAL computeTotpCode JSDoc — 'V-353b — compute the RFC-6238 6-digit code at whenSeconds for the given raw secret bytes. Used by the verifier; tests can call this directly to compute a valid code for a given moment'. The compute-for-given-moment design is the test-seam contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/V-353b — compute the RFC-6238 6-digit code at `whenSeconds` for the/);
    expect(p).toMatch(/given raw secret bytes\. Used by the verifier; tests can call this/);
    expect(p).toMatch(/directly to compute a valid code for a given moment\./);
  });

  it('CRITICAL computeTotpCode RFC-6238 dynamic-truncation impl — HMAC-SHA1 over big-endian-counter + offset = last-byte-low-4 + 4-byte mask & 0x7fffffff + mod 10^6. The HOTP standard truncation algorithm.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/const counter = Math\.floor\(whenSeconds \/ TOTP_PERIOD_SECONDS\);/);
    expect(p).toMatch(/counterBuf\.writeBigUInt64BE\(BigInt\(counter\)\);/);
    expect(p).toMatch(
      /const hmac = createHmac\('sha1', secretBytes\)\.update\(counterBuf\)\.digest\(\);/,
    );
    expect(p).toMatch(/const offset = hmac\[hmac\.length - 1\]! & 0x0f;/);
  });

  // ─── verifyTotpCode ±1 drift + constant-time ─────────────────

  it("CRITICAL verifyTotpCodeWithCounter JSDoc — 'verify a 6-digit code against the raw secret with the ±1-window drift tolerance'. The replay-defence refactor returns the matched timestep counter; verifyTotpCode is the boolean wrapper. The ±1-drift + timingSafeEqual is the verification contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/verify a 6-digit code against the raw secret with the ±1-window/);
    expect(p).toMatch(/Constant-time per-window compare/);
    // The boolean wrapper delegates to the counter-returning variant.
    expect(p).toMatch(
      /export function verifyTotpCode\([\s\S]*?\): boolean \{\s*\n?\s*return verifyTotpCodeWithCounter\(secretBytes, code, nowSeconds\) !== null;/,
    );
  });

  it('CRITICAL verifyTotpCodeWithCounter rejects non-6-digit inputs early — /^\\d{6}$/ regex → return null. The shape-check-first design avoids HMAC computation on obviously-malformed inputs.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/if \(!\/\^\\d\{6\}\$\/\.test\(code\)\) return null;/);
  });

  it('CRITICAL verifyTotpCode iterates ±1 drift windows — `for (let drift = -TOTP_DRIFT_WINDOWS; drift <= TOTP_DRIFT_WINDOWS; drift++)`. The 3-window scan (drift -1, 0, +1) is the 90s verify-range.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(
      /for \(let drift = -TOTP_DRIFT_WINDOWS; drift <= TOTP_DRIFT_WINDOWS; drift\+\+\)/,
    );
  });

  it('CRITICAL verifyTotpCode uses timingSafeEqual per-window. Matches the W961/W962/W963 constant-time compare convention.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(
      /if \(candidateBuf\.length === codeBuf\.length && timingSafeEqual\(candidateBuf, codeBuf\)\)/,
    );
  });

  // ─── otpauthUri Driftstack issuer framing ────────────────────

  it("CRITICAL otpauthUri JSDoc — 'V-353b — otpauth:// URI for the QR code. Issuer is fixed (Driftstack); label is the user's email so auth apps can show \"Driftstack: alice@…\". Algorithm is implicit SHA-1; period 30; 6 digits — defaults match every auth app'. The Driftstack-issuer + Driftstack:email-label is the customer-facing auth-app display contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/V-353b — `otpauth:\/\/` URI for the QR code\. Issuer is fixed/);
    expect(p).toMatch(/\("Driftstack"\); label is the user's email so auth apps can show/);
    expect(p).toMatch(/"Driftstack: alice@…"\. Algorithm is implicit SHA-1; period 30; 6/);
    expect(p).toMatch(/digits — defaults match every auth app\./);
  });

  it("CRITICAL otpauthUri impl — issuer='Driftstack' + label=encodeURIComponent('Driftstack:<email>') + params (secret + issuer + algorithm=SHA1 + digits=6 + period=30). Mechanically pinned via source.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/const issuer = 'Driftstack';/);
    expect(p).toMatch(/const label = encodeURIComponent\(`\$\{issuer\}:\$\{args\.email\}`\);/);
    expect(p).toMatch(/algorithm: 'SHA1',/);
    expect(p).toMatch(/digits: String\(TOTP_DIGITS\),/);
    expect(p).toMatch(/period: String\(TOTP_PERIOD_SECONDS\),/);
    expect(p).toMatch(/return `otpauth:\/\/totp\/\$\{label\}\?\$\{params\.toString\(\)\}`;/);
  });

  // ─── AES-256-GCM encryption framing ──────────────────────────

  it('CRITICAL encryptSecret JSDoc pins explicit v2 ciphertext and purpose/account authenticated context', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/V-353b — AES-256-GCM encryption of the TOTP secret with the env-/);
    expect(p).toMatch(/supplied 32-byte key\. The ciphertext carries an explicit v2 prefix/);
    expect(p).toMatch(/authenticates the store purpose \+ owning account/);
    expect(p).toMatch(/base64 text columns for the existing no-DDL storage shape/);
  });

  it("CRITICAL decryptSecret validates IV + tag byte-lengths — 'MFA secret IV is X bytes; expected GCM_IV_BYTES' + 'MFA secret tag is X bytes; expected GCM_TAG_BYTES'. The 2-bound check prevents constructor mismatch + AES-GCM library quirks.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/`MFA secret IV is \$\{iv\.length\} bytes; expected \$\{GCM_IV_BYTES\}`/);
    expect(p).toMatch(/`MFA secret tag is \$\{tag\.length\} bytes; expected \$\{GCM_TAG_BYTES\}`/);
  });

  // ─── decodeKey 32-byte validation framing ────────────────────

  it("CRITICAL decodeKey throws on non-32-byte key — 'MFA_ENCRYPTION_KEY must decode to 32 bytes; got X. Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"'. The error message includes the operator-actionable command to generate a fresh key.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/`MFA_ENCRYPTION_KEY must decode to 32 bytes; got \$\{key\.length\}\. `/);
    expect(p).toMatch(
      /"Generate with: node -e \\"console\.log\(require\('crypto'\)\.randomBytes\(32\)\.toString\('base64'\)\)\\""/,
    );
  });

  // ─── Recovery code framing ───────────────────────────────────

  it("CRITICAL generateRecoveryCodes JSDoc — 'V-353b — recovery code generator. 10 codes, each 10 base32 chars with no ambiguous letters (drops 0/1/I/O/L; uses Crockford base32 shape). Raw codes are shown ONCE at enrollment and scrypt-hashed before persisting (same KDF as API keys)'. The 10x10 chars + no-ambiguous-letters + show-once design is the V-353b recovery contract.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/V-353b — recovery code generator\. 10 codes, each 10 base32 chars/);
    expect(p).toMatch(/with no ambiguous letters \(drops 0\/1\/I\/O\/L; uses Crockford base32/);
    expect(p).toMatch(/shape\)\. Raw codes are shown ONCE at enrollment and scrypt-hashed/);
    expect(p).toMatch(/before persisting \(same KDF as API keys\)\./);
  });

  it("CRITICAL RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789' — Crockford-shaped (no 0/1/I/O/L). RECOVERY_LENGTH = 10. RECOVERY_COUNT = 10.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';/);
    expect(p).toMatch(/const RECOVERY_LENGTH = 10;/);
    expect(p).toMatch(/const RECOVERY_COUNT = 10;/);
  });

  it("CRITICAL generateRecoveryCode hyphenates 'ABCDE-FGHJK' format — `${s.slice(0, 5)}-${s.slice(5)}`. The 5-char-hyphen-5-char layout is the human-readable format.", () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/return `\$\{s\.slice\(0, 5\)\}-\$\{s\.slice\(5\)\}`;/);
  });

  // ─── normalizeRecoveryCode framing ───────────────────────────

  it('CRITICAL normalizeRecoveryCode JSDoc — \'V-353b — normalize a user-typed recovery code: uppercase, strip hyphens / whitespace. Lets the caller paste "abcde-fghjk" or "ABCDEFGHJK" interchangeably\'. The case-insensitive + hyphen-tolerant input design is the customer-paste-UX contract.', () => {
    const p = read(resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts'));
    expect(p).toMatch(/V-353b — normalize a user-typed recovery code: uppercase, strip/);
    expect(p).toMatch(/hyphens \/ whitespace\. Lets the caller paste "abcde-fghjk" or/);
    expect(p).toMatch(/"ABCDEFGHJK" interchangeably\./);
    expect(p).toMatch(/return input\.replace\(\/\[\\s-\]\/g, ''\)\.toUpperCase\(\);/);
  });

  // ─── Runtime parity: generateTotpSecret ──────────────────────

  it('CRITICAL generateTotpSecret runtime — secretBytes is 20-byte Buffer; secretBase32 is 32 chars uppercase RFC 4648. The 20-byte + 32-char-base32 pair matches W912 api-keys (lowercase) shape but uppercase.', () => {
    const { secretBase32, secretBytes } = generateTotpSecret();
    expect(secretBytes.length).toBe(20);
    expect(secretBase32).toHaveLength(32);
    expect(secretBase32).toMatch(/^[A-Z2-7]{32}$/);
  });

  // ─── Runtime parity: computeTotpCode + verifyTotpCode ────────

  it('CRITICAL computeTotpCode runtime — 6-digit string, padStart-zero-padded. Verified against fixed test vector.', () => {
    const secret = Buffer.from('12345678901234567890', 'utf8');
    // RFC 6238 Appendix B test vector @ T=59 (Unix time) with SHA-1: '94287082'
    // But we use first 6 digits → '287082'.
    const code = computeTotpCode(secret, 59);
    expect(code).toHaveLength(6);
    expect(code).toMatch(/^\d{6}$/);
    // Specifically test the RFC 6238 SHA1 vector: T=59s → code '287082' (last 6 digits of '94287082').
    expect(code).toBe('287082');
  });

  it('CRITICAL computeTotpCode → verifyTotpCode round-trip → true. The compute-verify identity is the TOTP primitive correctness invariant.', () => {
    const { secretBytes } = generateTotpSecret();
    const now = Math.floor(Date.now() / 1000);
    const code = computeTotpCode(secretBytes, now);
    expect(verifyTotpCode(secretBytes, code, now)).toBe(true);
  });

  it('CRITICAL verifyTotpCode ±1 drift window — code at T-30s + code at T+30s both verify at T (90s total range).', () => {
    const { secretBytes } = generateTotpSecret();
    const now = 1747370000;
    const codeMinus = computeTotpCode(secretBytes, now - TOTP_PERIOD_SECONDS);
    const codePlus = computeTotpCode(secretBytes, now + TOTP_PERIOD_SECONDS);
    expect(verifyTotpCode(secretBytes, codeMinus, now)).toBe(true);
    expect(verifyTotpCode(secretBytes, codePlus, now)).toBe(true);
  });

  it('CRITICAL verifyTotpCode rejects code at T-60s OR T+60s (outside ±1 window). The 2-window rejection bounds the verify-range at 90s.', () => {
    const { secretBytes } = generateTotpSecret();
    const now = 1747370000;
    const codeMinusFar = computeTotpCode(secretBytes, now - 2 * TOTP_PERIOD_SECONDS);
    const codePlusFar = computeTotpCode(secretBytes, now + 2 * TOTP_PERIOD_SECONDS);
    expect(verifyTotpCode(secretBytes, codeMinusFar, now)).toBe(false);
    expect(verifyTotpCode(secretBytes, codePlusFar, now)).toBe(false);
  });

  it("CRITICAL verifyTotpCode rejects non-6-digit inputs ('abc' / '12345' / '1234567'). Early-shape-check before HMAC.", () => {
    const { secretBytes } = generateTotpSecret();
    const now = Math.floor(Date.now() / 1000);
    expect(verifyTotpCode(secretBytes, 'abc', now)).toBe(false);
    expect(verifyTotpCode(secretBytes, '12345', now)).toBe(false);
    expect(verifyTotpCode(secretBytes, '1234567', now)).toBe(false);
  });

  // ─── Runtime parity: encryptSecret + decryptSecret ───────────

  it('CRITICAL encryptSecret + decryptSecret round-trip — encrypted bytes decrypt back to original. The AES-256-GCM symmetric primitive correctness.', () => {
    const original = Buffer.alloc(20, 7);
    const enc = encryptSecret(original, TEST_KEY_BASE64, TEST_ACCOUNT_ID);
    const dec = decryptSecret(enc, TEST_KEY_BASE64, TEST_ACCOUNT_ID);
    expect(dec.equals(original)).toBe(true);
  });

  it('CRITICAL encryptSecret returns 3-field { ciphertext, iv, tag } all base64-encoded. IV is 12 bytes (16 base64 chars); tag is 16 bytes (24 base64 chars).', () => {
    const enc = encryptSecret(Buffer.alloc(20, 8), TEST_KEY_BASE64, TEST_ACCOUNT_ID);
    expect(Buffer.from(enc.iv, 'base64').length).toBe(12);
    expect(Buffer.from(enc.tag, 'base64').length).toBe(16);
    expect(typeof enc.ciphertext).toBe('string');
  });

  it('CRITICAL decryptSecret throws on wrong-length IV (e.g. 11 or 13 bytes). The byte-count guard rejects misformed input early.', () => {
    const enc = encryptSecret(Buffer.alloc(20, 9), TEST_KEY_BASE64, TEST_ACCOUNT_ID);
    // Substitute a 4-byte IV.
    const badIv = Buffer.alloc(4).toString('base64');
    expect(() => decryptSecret({ ...enc, iv: badIv }, TEST_KEY_BASE64, TEST_ACCOUNT_ID)).toThrow(
      /MFA secret IV/,
    );
  });

  it('CRITICAL decryptSecret throws on 32-byte-mismatch key. The decodeKey guard requires base64 → 32 bytes.', () => {
    const shortKey = randomBytes(16).toString('base64'); // 16 bytes, not 32
    const enc = encryptSecret(Buffer.alloc(20, 10), TEST_KEY_BASE64, TEST_ACCOUNT_ID);
    expect(() => decryptSecret(enc, shortKey, TEST_ACCOUNT_ID)).toThrow(
      /MFA_ENCRYPTION_KEY must decode to 32 bytes/,
    );
  });

  // ─── Runtime parity: otpauthUri ──────────────────────────────

  it("CRITICAL otpauthUri runtime — 'otpauth://totp/Driftstack:alice@x.com?secret=...&issuer=Driftstack&algorithm=SHA1&digits=6&period=30' shape. Mechanically verified.", () => {
    const uri = otpauthUri({ email: 'alice@x.com', secretBase32: 'JBSWY3DPEHPK3PXP' });
    expect(uri).toMatch(/^otpauth:\/\/totp\/Driftstack%3Aalice/);
    expect(uri).toContain('secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Driftstack');
    expect(uri).toContain('algorithm=SHA1');
    expect(uri).toContain('digits=6');
    expect(uri).toContain('period=30');
  });

  // ─── Runtime parity: generateRecoveryCodes ──────────────────

  it('CRITICAL generateRecoveryCodes runtime — returns 10 strings by default. Each is 11 chars (5+hyphen+5) using RECOVERY_ALPHABET (no 0/1/I/O/L).', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(10);
    for (const code of codes) {
      expect(code).toHaveLength(11); // 5+1+5
      expect(code).toMatch(/^[A-HJ-NP-TV-Z2-9]{5}-[A-HJ-NP-TV-Z2-9]{5}$/);
    }
  });

  it('CRITICAL generateRecoveryCodes distinct on each call — no collisions in 10 codes (entropy floor). The randomness is what makes recovery codes unguessable.', () => {
    const codes = generateRecoveryCodes();
    expect(new Set(codes).size).toBe(10);
  });

  // ─── Runtime parity: normalizeRecoveryCode ───────────────────

  it("CRITICAL normalizeRecoveryCode runtime — 'abcde-fghjk' → 'ABCDEFGHJK'. Strips hyphens + uppercases. Hyphenless lowercase input also works.", () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDEFGHJK')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('abcde fghjk')).toBe('ABCDEFGHJK'); // strips whitespace
    expect(normalizeRecoveryCode('  AB-CD-EF  ')).toBe('ABCDEF');
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/mfa-totp-lib-v353b-cross-source-invariant.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
