// V-353b — TOTP (RFC 6238) + AES-256-GCM secret-encryption helpers.
//
// Algorithm choices (founder verdict V-353a):
//   - SHA-1 / 30s period / 6 digits — auth-app compat (Google
//     Authenticator, 1Password, Authy, Bitwarden, etc. all support).
//   - ±1 window drift tolerance — total verification range = 90s.
//   - At-rest encryption: AES-256-GCM with the env-supplied
//     `MFA_ENCRYPTION_KEY` (32 random bytes, base64). Single key for v1;
//     rotation deferred to a runbook + future migration.
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
  timingSafeEqual,
} from 'node:crypto';

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
export const TOTP_DRIFT_WINDOWS = 1;

const SECRET_RAW_BYTES = 20;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

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
 * supplied 32-byte key. Returns base64-encoded ciphertext + iv + tag
 * (text columns; bytea also viable but text is friendlier for
 * direct DB inspection during incidents).
 */
export function encryptSecret(
  secretBytes: Buffer,
  keyBase64: string,
): { ciphertext: string; iv: string; tag: string } {
  const key = decodeKey(keyBase64);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secretBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
  };
}

export function decryptSecret(
  args: { ciphertext: string; iv: string; tag: string },
  keyBase64: string,
): Buffer {
  const key = decodeKey(keyBase64);
  const ciphertext = Buffer.from(args.ciphertext, 'base64');
  const iv = Buffer.from(args.iv, 'base64');
  const tag = Buffer.from(args.tag, 'base64');
  if (iv.length !== GCM_IV_BYTES) {
    throw new Error(`MFA secret IV is ${iv.length} bytes; expected ${GCM_IV_BYTES}`);
  }
  if (tag.length !== GCM_TAG_BYTES) {
    throw new Error(`MFA secret tag is ${tag.length} bytes; expected ${GCM_TAG_BYTES}`);
  }
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
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
  const buf = randomBytes(RECOVERY_LENGTH);
  let s = '';
  for (let i = 0; i < RECOVERY_LENGTH; i++) {
    s += RECOVERY_ALPHABET[buf[i]! % RECOVERY_ALPHABET.length];
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
