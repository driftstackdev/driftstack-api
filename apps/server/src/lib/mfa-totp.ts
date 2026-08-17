// V-353b — TOTP (RFC 6238) + AES-256-GCM secret-encryption helpers.
//
// Algorithm choices (founder verdict V-353a):
//   - SHA-1 / 30s period / 6 digits — auth-app compat (Google
//     Authenticator, 1Password, Authy, Bitwarden, etc. all support).
//   - ±1 window drift tolerance — total verification range = 90s.
//   - At-rest encryption: AES-256-GCM with the env-supplied
//     `MFA_ENCRYPTION_KEY` (32 random bytes, base64). The v2 envelope binds
//     its purpose + account identity as GCM additional authenticated data.
//
// The TOTP secret itself is 20 bytes random, base32-encoded for the
// otpauth:// URI, AES-GCM-encrypted at rest. Verification reads the
// ciphertext + iv + tag from `account_mfa`, decrypts in memory only,
// computes the windows around `now`, constant-time compares.

import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  randomInt,
  timingSafeEqual,
} from 'node:crypto';
import { GCM_IV_BYTES, GCM_TAG_BYTES } from './aes-gcm-parameters.js';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_DRIFT_WINDOWS = 1;

const SECRET_RAW_BYTES = 20;
const MAX_ACCOUNT_ID_BYTES = 256;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export const MFA_TOTP_SECRET_V2_PREFIX = 'driftstack:mfa-totp:v2:';
const MFA_TOTP_SECRET_AAD_PURPOSE = 'driftstack.mfa-totp-secret';

/** V-353b — generate a fresh 20-byte TOTP secret + return its base32-
 *  encoded form (what auth apps consume). The plaintext is never
 *  persisted; caller encrypts via `encryptSecret` before insert. */
export function generateTotpSecret(): { secretBase32: string; secretBytes: Buffer } {
  const buf = randomBytes(SECRET_RAW_BYTES);
  return { secretBase32: base32Encode(buf), secretBytes: buf };
}

/** V-353b — compute the RFC-6238 6-digit code at `whenSeconds` for the
 *  given raw secret bytes. Used by the verifier; tests can call this
 *  directly to compute a valid code for a given moment. */
export function computeTotpCode(secretBytes: Buffer, whenSeconds: number): string {
  const counter = Math.floor(whenSeconds / TOTP_PERIOD_SECONDS);
  const counterBuf = Buffer.alloc(8);
  // Big-endian 64-bit. Node's writeBigUInt64BE handles this directly.
  counterBuf.writeBigUInt64BE(BigInt(counter));
  const hmac = createHmac('sha1', secretBytes).update(counterBuf).digest();
  const offset = hmac[hmac.length - 1]! & 0x0f;
  const truncated =
    ((hmac[offset]! & 0x7f) << 24) |
    ((hmac[offset + 1]! & 0xff) << 16) |
    ((hmac[offset + 2]! & 0xff) << 8) |
    (hmac[offset + 3]! & 0xff);
  const mod = truncated % 10 ** TOTP_DIGITS;
  return mod.toString().padStart(TOTP_DIGITS, '0');
}

/**
 * V-353b — verify a 6-digit code against the raw secret with the ±1-window
 * drift tolerance. Returns the MATCHED timestep counter (floor(when/30)) on
 * success, or null on failure. The counter is what the replay guard persists
 * + compares against last_used_totp_counter so each 30s window is single-use.
 * Constant-time per-window compare; all windows are checked (no early break)
 * so the work is independent of which window matched.
 */
export function verifyTotpCodeWithCounter(
  secretBytes: Buffer,
  code: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const codeBuf = Buffer.from(code, 'utf8');
  let matchedCounter: number | null = null;
  for (let drift = -TOTP_DRIFT_WINDOWS; drift <= TOTP_DRIFT_WINDOWS; drift++) {
    const whenSeconds = nowSeconds + drift * TOTP_PERIOD_SECONDS;
    const candidate = computeTotpCode(secretBytes, whenSeconds);
    const candidateBuf = Buffer.from(candidate, 'utf8');
    if (candidateBuf.length === codeBuf.length && timingSafeEqual(candidateBuf, codeBuf)) {
      matchedCounter = Math.floor(whenSeconds / TOTP_PERIOD_SECONDS);
    }
  }
  return matchedCounter;
}

/** V-353b — boolean convenience wrapper over {@link verifyTotpCodeWithCounter}.
 *  Use the counter-returning variant on the replay-guarded paths (verifyCode);
 *  this is for paths that don't persist a counter (enrollment confirmation). */
export function verifyTotpCode(
  secretBytes: Buffer,
  code: string,
  nowSeconds: number = Math.floor(Date.now() / 1000),
): boolean {
  return verifyTotpCodeWithCounter(secretBytes, code, nowSeconds) !== null;
}

/** V-353b — `otpauth://` URI for the QR code. Issuer is fixed
 *  ("Driftstack"); label is the user's email so auth apps can show
 *  "Driftstack: alice@…". Algorithm is implicit SHA-1; period 30; 6
 *  digits — defaults match every auth app. */
export function otpauthUri(args: { email: string; secretBase32: string }): string {
  const issuer = 'Driftstack';
  const label = encodeURIComponent(`${issuer}:${args.email}`);
  const params = new URLSearchParams({
    secret: args.secretBase32,
    issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/**
 * V-353b — AES-256-GCM encryption of the TOTP secret with the env-
 * supplied 32-byte key. The ciphertext carries an explicit v2 prefix and
 * authenticates the store purpose + owning account. IV + tag remain separate
 * base64 text columns for the existing no-DDL storage shape.
 */
export function encryptSecret(
  secretBytes: Buffer,
  keyBase64: string,
  accountId: string,
): { ciphertext: string; iv: string; tag: string } {
  assertTotpSecretLength(secretBytes);
  const key = decodeKey(keyBase64);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(buildMfaTotpSecretAad(accountId));
  const ciphertext = Buffer.concat([cipher.update(secretBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: `${MFA_TOTP_SECRET_V2_PREFIX}${ciphertext.toString('base64')}`,
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(
  args: { ciphertext: string; iv: string; tag: string },
  keyBase64: string,
  accountId: string,
): Buffer {
  if (!args.ciphertext.startsWith(MFA_TOTP_SECRET_V2_PREFIX)) {
    throw new Error('MFA secret storage is not a v2 envelope.');
  }
  const plaintext = decryptSecretPayload(
    {
      ciphertext: args.ciphertext.slice(MFA_TOTP_SECRET_V2_PREFIX.length),
      iv: args.iv,
      tag: args.tag,
    },
    keyBase64,
    buildMfaTotpSecretAad(accountId),
  );
  assertTotpSecretLength(plaintext);
  return plaintext;
}

/** Bootstrap-only reader for the prefixless, context-free legacy tuple. */
export function decryptLegacyMfaSecret(
  args: { ciphertext: string; iv: string; tag: string },
  keyBase64: string,
): Buffer {
  if (args.ciphertext.startsWith(MFA_TOTP_SECRET_V2_PREFIX)) {
    throw new Error('MFA legacy secret reader refuses a v2 envelope.');
  }
  const plaintext = decryptSecretPayload(args, keyBase64);
  assertTotpSecretLength(plaintext);
  return plaintext;
}

function decryptSecretPayload(
  args: { ciphertext: string; iv: string; tag: string },
  keyBase64: string,
  additionalAuthenticatedData?: Buffer,
): Buffer {
  const key = decodeKey(keyBase64);
  const ciphertext = decodeCanonicalBase64(args.ciphertext, 'ciphertext');
  const iv = decodeCanonicalBase64(args.iv, 'IV');
  const tag = decodeCanonicalBase64(args.tag, 'tag');
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(`MFA secret IV is ${iv.length} bytes; expected ${GCM_IV_BYTES}`);
  }
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error(`MFA secret tag is ${tag.length} bytes; expected ${GCM_TAG_BYTES}`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (additionalAuthenticatedData !== undefined) {
    decipher.setAAD(additionalAuthenticatedData);
  }
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

function buildMfaTotpSecretAad(accountId: string): Buffer {
  const accountIdBytes = Buffer.byteLength(accountId, 'utf8');
  if (accountIdBytes < 1 || accountIdBytes > MAX_ACCOUNT_ID_BYTES) {
    throw new Error(
      `MFA secret accountId must encode to 1..${MAX_ACCOUNT_ID_BYTES.toString()} bytes; got ${accountIdBytes.toString()}`,
    );
  }
  return Buffer.from(JSON.stringify([MFA_TOTP_SECRET_AAD_PURPOSE, 2, accountId]), 'utf8');
}

function assertTotpSecretLength(secretBytes: Buffer): void {
  if (secretBytes.length !== SECRET_RAW_BYTES) {
    throw new Error(
      `MFA TOTP secret is ${secretBytes.length.toString()} bytes; expected ${SECRET_RAW_BYTES.toString()}`,
    );
  }
}

function decodeCanonicalBase64(value: string, field: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (value.length === 0 || decoded.toString('base64') !== value) {
    throw new Error(`MFA secret ${field} is not canonical base64.`);
  }
  return decoded;
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== 32) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must decode to 32 bytes; got ${key.length}. ` +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

/** V-353b — recovery code generator. 10 codes, each 10 base32 chars
 *  with no ambiguous letters (drops 0/1/I/O/L; uses Crockford base32
 *  shape). Raw codes are shown ONCE at enrollment and scrypt-hashed
 *  before persisting (same KDF as API keys). */
const RECOVERY_ALPHABET = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';
const RECOVERY_LENGTH = 10;
const RECOVERY_COUNT = 10;

export function generateRecoveryCodes(count = RECOVERY_COUNT): string[] {
  const out: string[] = [];
  for (let i = 0; i < count; i++) out.push(generateRecoveryCode());
  return out;
}

function generateRecoveryCode(): string {
  // crypto.randomInt draws a UNIFORM index in [0, len). A `randomBytes % len`
  // pick would be modulo-biased (256 % 29 ≠ 0 → the first 24 alphabet chars
  // ~12.5% more likely per char). Negligible for a rate-limited, scrypt-hashed,
  // single-use code, but unbiased selection is free here and keeps the per-char
  // entropy at the full log2(29) rather than a hair under it.
  let s = '';
  for (let i = 0; i < RECOVERY_LENGTH; i++) {
    s += RECOVERY_ALPHABET[randomInt(RECOVERY_ALPHABET.length)];
  }
  // Hyphenate in the middle for readability: ABCDE-FGHJK.
  return `${s.slice(0, 5)}-${s.slice(5)}`;
}

/** V-353b — normalize a user-typed recovery code: uppercase, strip
 *  hyphens / whitespace. Lets the caller paste "abcde-fghjk" or
 *  "ABCDEFGHJK" interchangeably. */
export function normalizeRecoveryCode(input: string): string {
  return input.replace(/[\s-]/g, '').toUpperCase();
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}
