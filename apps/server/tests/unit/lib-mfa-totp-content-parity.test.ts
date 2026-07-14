// W387.A — drift guard for apps/server/src/lib/mfa-totp.ts. The
// MFA module is referenced by /trust/security-overview and
// /legal/privacy: TOTP RFC 6238 + AES-256-GCM at-rest +
// scrypt-hashed recovery codes. Behavioural tests cover round-
// tripping; this guard pins the security-relevant constants +
// algorithm choices a CISO reviewer cross-references against the
// marketing claim.
//
//   • V-353b framing pinned (founder verdict V-353a).
//   • TOTP_PERIOD_SECONDS = 30 (auth-app compat — Google
//     Authenticator / 1Password / Authy / Bitwarden).
//   • TOTP_DIGITS = 6.
//   • TOTP_DRIFT_WINDOWS = 1 (±1 window = 90s total range).
//   • SHA-1 algorithm (auth-app compat).
//   • 20-byte secret, base32-encoded for otpauth:// URI.
//   • GCM_IV_BYTES = 12, GCM_TAG_BYTES = 16 (AES-256-GCM constants).
//   • Issuer "Driftstack" + email label in otpauth URI.
//   • Recovery codes: 10 codes, 10 chars each, ambiguity-stripped
//     base32 (drops 0/1/I/O/L per Crockford), hyphenated middle.
//   • normalizeRecoveryCode strips whitespace + hyphens + uppercases.
//   • decodeKey: 32-byte hard requirement (no fallback, throws).
//   • MFA_ENCRYPTION_KEY env-var generator command in error message.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/src/lib/mfa-totp.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W387.A apps/server/src/lib/mfa-totp.ts content parity', () => {
  const body = read(LIB);

  it('V-353b framing pinned + founder verdict V-353a referenced', () => {
    expect(body).toMatch(/V-353b — TOTP \(RFC 6238\) \+ AES-256-GCM secret-encryption helpers/);
    expect(body).toMatch(/Algorithm choices \(founder verdict V-353a\):/);
  });

  it('SHA-1 / 30s / 6 digits algorithm choice pinned (auth-app compat)', () => {
    expect(body).toMatch(/SHA-1 \/ 30s period \/ 6 digits — auth-app compat/);
    expect(body).toMatch(
      /Google\s*\n?\s*\/\/\s*Authenticator, 1Password, Authy, Bitwarden, etc\. all support/,
    );
  });

  it('±1 window drift tolerance = 90s total verification range', () => {
    expect(body).toMatch(/±1 window drift tolerance — total verification range = 90s/);
  });

  it('AES-256-GCM at-rest encryption framing pinned (MFA_ENCRYPTION_KEY = 32 random bytes base64)', () => {
    expect(body).toMatch(
      /At-rest encryption: AES-256-GCM with the env-supplied\s*\n?\s*\/\/\s*`MFA_ENCRYPTION_KEY` \(32 random bytes, base64\)/,
    );
    expect(body).toMatch(/The v2 envelope binds/);
    expect(body).toMatch(/its purpose \+ account identity as GCM additional authenticated data/);
  });

  it('TOTP constants: TOTP_PERIOD_SECONDS=30, TOTP_DIGITS=6, TOTP_DRIFT_WINDOWS=1', () => {
    expect(body).toMatch(/export const TOTP_PERIOD_SECONDS = 30;/);
    expect(body).toMatch(/export const TOTP_DIGITS = 6;/);
    expect(body).toMatch(/export const TOTP_DRIFT_WINDOWS = 1;/);
  });

  it('SECRET_RAW_BYTES = 20 + GCM_IV_BYTES = 12 + GCM_TAG_BYTES = 16', () => {
    expect(body).toMatch(/const SECRET_RAW_BYTES = 20;/);
    expect(body).toMatch(/const GCM_IV_BYTES = 12;/);
    expect(body).toMatch(/const GCM_TAG_BYTES = 16;/);
  });

  it('BASE32_ALPHABET = RFC 4648 uppercase A-Z + 2-7 (different from api-keys.ts lowercase)', () => {
    expect(body).toMatch(/const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';/);
  });

  it('generateTotpSecret: 20-byte randomBytes → base32Encode → { secretBase32, secretBytes }', () => {
    expect(body).toMatch(
      /export function generateTotpSecret\(\): \{ secretBase32: string; secretBytes: Buffer \}/,
    );
    expect(body).toMatch(/const buf = randomBytes\(SECRET_RAW_BYTES\);/);
    expect(body).toMatch(/return \{ secretBase32: base32Encode\(buf\), secretBytes: buf \};/);
  });

  it('computeTotpCode: BE-64 counter + HMAC-SHA1 + RFC-6238 dynamic-truncation + mod 10^digits + padStart', () => {
    expect(body).toMatch(/const counter = Math\.floor\(whenSeconds \/ TOTP_PERIOD_SECONDS\);/);
    expect(body).toMatch(/counterBuf\.writeBigUInt64BE\(BigInt\(counter\)\);/);
    expect(body).toMatch(
      /const hmac = createHmac\('sha1', secretBytes\)\.update\(counterBuf\)\.digest\(\);/,
    );
    expect(body).toMatch(/const offset = hmac\[hmac\.length - 1\]! & 0x0f;/);
    expect(body).toMatch(/const mod = truncated % 10 \*\* TOTP_DIGITS;/);
    expect(body).toMatch(/return mod\.toString\(\)\.padStart\(TOTP_DIGITS, '0'\);/);
  });

  it('verifyTotpCodeWithCounter: regex /^\\d{6}$/ pre-check + constant-time per-window compare + returns the matched timestep counter (replay defence); verifyTotpCode is the boolean wrapper', () => {
    // The matching logic now lives in verifyTotpCodeWithCounter (returns the
    // matched counter so the replay guard can persist + compare it); the regex
    // pre-check returns null there. verifyTotpCode is a thin boolean wrapper.
    expect(body).toMatch(/if \(!\/\^\\d\{6\}\$\/\.test\(code\)\) return null;/);
    expect(body).toMatch(/timingSafeEqual\(candidateBuf, codeBuf\)/);
    expect(body).toMatch(
      /for \(let drift = -TOTP_DRIFT_WINDOWS; drift <= TOTP_DRIFT_WINDOWS; drift\+\+\)/,
    );
    expect(body).toMatch(/matchedCounter = Math\.floor\(whenSeconds \/ TOTP_PERIOD_SECONDS\);/);
    expect(body).toMatch(
      /export function verifyTotpCode\([\s\S]*?\): boolean \{\s*\n?\s*return verifyTotpCodeWithCounter\(secretBytes, code, nowSeconds\) !== null;/,
    );
  });

  it('otpauthUri: issuer "Driftstack" + email label + 4 query params (secret/issuer/algorithm/digits/period)', () => {
    expect(body).toMatch(/const issuer = 'Driftstack';/);
    expect(body).toMatch(/const label = encodeURIComponent\(`\$\{issuer\}:\$\{args\.email\}`\);/);
    expect(body).toMatch(/algorithm: 'SHA1',/);
    expect(body).toMatch(/digits: String\(TOTP_DIGITS\),/);
    expect(body).toMatch(/period: String\(TOTP_PERIOD_SECONDS\),/);
    expect(body).toMatch(/return `otpauth:\/\/totp\/\$\{label\}\?\$\{params\.toString\(\)\}`;/);
  });

  it('encryptSecret writes an explicit v2 prefix and purpose/account AAD', () => {
    expect(body).toMatch(/export const MFA_TOTP_SECRET_V2_PREFIX = 'driftstack:mfa-totp:v2:';/);
    expect(body).toMatch(/const MFA_TOTP_SECRET_AAD_PURPOSE = 'driftstack\.mfa-totp-secret';/);
    expect(body).toMatch(/const cipher = createCipheriv\('aes-256-gcm', key, iv\);/);
    expect(body).toMatch(/cipher\.setAAD\(buildMfaTotpSecretAad\(accountId\)\);/);
    expect(body).toMatch(/const tag = cipher\.getAuthTag\(\);/);
    expect(body).toMatch(
      /ciphertext: `\$\{MFA_TOTP_SECRET_V2_PREFIX\}\$\{ciphertext\.toString\('base64'\)\}`,/,
    );
    expect(body).toMatch(/iv: iv\.toString\('base64'\),/);
    expect(body).toMatch(/tag: tag\.toString\('base64'\),/);
  });

  it('decryptSecret enforces v2, canonical encoding, IV/tag sizes, account AAD and 20-byte plaintext', () => {
    expect(body).toMatch(/MFA secret storage is not a v2 envelope/);
    expect(body).toMatch(/decodeCanonicalBase64/);
    expect(body).toMatch(
      /if \(iv\.length !== GCM_IV_BYTES\) \{[\s\S]+?MFA secret IV is \$\{iv\.length\} bytes; expected \$\{GCM_IV_BYTES\}/,
    );
    expect(body).toMatch(
      /if \(tag\.length !== GCM_TAG_BYTES\) \{[\s\S]+?MFA secret tag is \$\{tag\.length\} bytes; expected \$\{GCM_TAG_BYTES\}/,
    );
    expect(body).toMatch(/decipher\.setAAD\(additionalAuthenticatedData\);/);
    expect(body).toMatch(/decipher\.setAuthTag\(tag\);/);
    expect(body).toMatch(/MFA TOTP secret is \$\{secretBytes\.length\.toString\(\)\} bytes/);
  });

  it('legacy tuple decryption is explicitly bootstrap-only and refuses v2', () => {
    expect(body).toMatch(
      /\/\*\* Bootstrap-only reader for the prefixless, context-free legacy tuple\. \*\//,
    );
    expect(body).toMatch(/export function decryptLegacyMfaSecret/);
    expect(body).toMatch(/MFA legacy secret reader refuses a v2 envelope/);
  });

  it('decodeKey: 32-byte hard requirement + generator command in error', () => {
    expect(body).toMatch(/if \(key\.length !== 32\)/);
    expect(body).toMatch(/MFA_ENCRYPTION_KEY must decode to 32 bytes; got \$\{key\.length\}/);
    expect(body).toMatch(/Generate with: node -e/);
    expect(body).toMatch(/require\('crypto'\)\.randomBytes\(32\)\.toString\('base64'\)/);
  });

  it('Recovery codes: 10 count + 10-char length + Crockford-style alphabet (drops 0/1/I/O/L)', () => {
    expect(body).toMatch(/const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';/);
    expect(body).toMatch(/const RECOVERY_LENGTH = 10;/);
    expect(body).toMatch(/const RECOVERY_COUNT = 10;/);
  });

  it('Recovery alphabet: no ambiguous chars (no 0/1/I/O/L in RECOVERY_ALPHABET)', () => {
    const m = body.match(/const RECOVERY_ALPHABET = '([^']+)';/);
    expect(m).not.toBeNull();
    const alphabet = m![1]!;
    for (const ambiguous of ['0', '1', 'I', 'O', 'L']) {
      expect(
        alphabet,
        `recovery alphabet should not contain ambiguous char: ${ambiguous}`,
      ).not.toContain(ambiguous);
    }
  });

  it('Recovery code framing: shown ONCE at enrollment + scrypt-hashed (same KDF as API keys)', () => {
    expect(body).toMatch(
      /Raw codes are shown ONCE at enrollment and scrypt-hashed\s*\n?\s*\*\s*before persisting \(same KDF as API keys\)/,
    );
  });

  it('Recovery hyphenation: "ABCDE-FGHJK" middle-split for readability', () => {
    expect(body).toMatch(/return `\$\{s\.slice\(0, 5\)\}-\$\{s\.slice\(5\)\}`;/);
  });

  it('normalizeRecoveryCode: strip whitespace + hyphens, uppercase (accepts "abcde-fghjk" or "ABCDEFGHJK")', () => {
    expect(body).toMatch(
      /export function normalizeRecoveryCode\(input: string\): string \{\s*\n?\s*return input\.replace\(\/\[\\s-\]\/g, ''\)\.toUpperCase\(\);\s*\n?\s*\}/,
    );
  });

  it('imports: createCipheriv + createDecipheriv + createHmac + randomBytes + timingSafeEqual from node:crypto', () => {
    expect(body).toMatch(
      /import \{[\s\S]+?createCipheriv,[\s\S]+?createDecipheriv,[\s\S]+?createHmac,[\s\S]+?randomBytes,[\s\S]+?timingSafeEqual,[\s\S]+?\} from 'node:crypto';/,
    );
  });

  it('file exists at canonical path referenced by /trust/security-overview', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
