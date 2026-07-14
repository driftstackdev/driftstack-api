// V-396 — unit tests for V-353b TOTP + recovery-code primitives.
//
// Covers the algorithm-level invariants that integration tests can't
// pin without time travel:
//
//   - RFC 6238 known-vector cross-check (computeTotpCode).
//   - ±1 step drift acceptance + 2-step rejection (verifyTotpCode).
//   - AES-256-GCM secret round-trip + tamper detection (encrypt/decrypt).
//   - Recovery code shape: 10 codes, Crockford base32 alphabet, no
//     ambiguous chars (0/1/I/O/L), hyphenated 5+5.
//   - normalizeRecoveryCode: lowercase + hyphen + whitespace tolerance.

import { describe, expect, it } from 'vitest';
import { createCipheriv, randomBytes } from 'node:crypto';
import {
  computeTotpCode,
  decryptLegacyMfaSecret,
  decryptSecret,
  encryptSecret,
  generateRecoveryCodes,
  generateTotpSecret,
  normalizeRecoveryCode,
  MFA_TOTP_SECRET_V2_PREFIX,
  TOTP_DIGITS,
  TOTP_DRIFT_WINDOWS,
  TOTP_PERIOD_SECONDS,
  verifyTotpCode,
} from '../../src/lib/mfa-totp.js';

const KEY_BASE64 = randomBytes(32).toString('base64');
const ACCOUNT_ID = 'acc_mfa_unit';

function encryptLegacySecret(secretBytes: Buffer, keyBase64 = KEY_BASE64) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(secretBytes), cipher.final()]);
  return {
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
  };
}

describe('computeTotpCode (RFC 6238)', () => {
  // RFC 6238 Appendix B test vectors are for the SHA-1 case with the
  // 20-byte ASCII secret "12345678901234567890". Several published
  // vectors at well-known timestamps:
  //   T=59          → 94287082 (8-digit) → 287082 (6-digit truncated)
  //   T=1111111109  → 07081804 (8-digit) → 081804 (6-digit truncated)
  it('matches the RFC 6238 known vector for the SHA-1 case', () => {
    const secret = Buffer.from('12345678901234567890', 'utf8');
    expect(computeTotpCode(secret, 59)).toBe('287082');
    expect(computeTotpCode(secret, 1111111109)).toBe('081804');
  });

  it('produces a 6-digit zero-padded numeric code', () => {
    const { secretBytes } = generateTotpSecret();
    for (let i = 0; i < 100; i++) {
      const code = computeTotpCode(secretBytes, i * 10000);
      expect(code).toMatch(/^\d{6}$/);
      expect(code.length).toBe(TOTP_DIGITS);
    }
  });
});

describe('verifyTotpCode drift window (V-353b ±1)', () => {
  const { secretBytes } = generateTotpSecret();
  const now = 1_750_000_000;
  const period = TOTP_PERIOD_SECONDS;

  it('accepts the code for the current step', () => {
    const code = computeTotpCode(secretBytes, now);
    expect(verifyTotpCode(secretBytes, code, now)).toBe(true);
  });

  it('accepts a code from one step in the past (clock-ahead client)', () => {
    const code = computeTotpCode(secretBytes, now - period);
    expect(verifyTotpCode(secretBytes, code, now)).toBe(true);
  });

  it('accepts a code from one step in the future (clock-behind client)', () => {
    const code = computeTotpCode(secretBytes, now + period);
    expect(verifyTotpCode(secretBytes, code, now)).toBe(true);
  });

  it('rejects a code from two steps in the past (outside drift window)', () => {
    const code = computeTotpCode(secretBytes, now - 2 * period);
    expect(verifyTotpCode(secretBytes, code, now)).toBe(false);
  });

  it('rejects a code from two steps in the future', () => {
    const code = computeTotpCode(secretBytes, now + 2 * period);
    expect(verifyTotpCode(secretBytes, code, now)).toBe(false);
  });

  it('exposes the constants the founder verdict pins', () => {
    expect(TOTP_PERIOD_SECONDS).toBe(30);
    expect(TOTP_DIGITS).toBe(6);
    expect(TOTP_DRIFT_WINDOWS).toBe(1);
  });

  it('rejects malformed input (non-numeric, wrong length, empty)', () => {
    expect(verifyTotpCode(secretBytes, '', now)).toBe(false);
    expect(verifyTotpCode(secretBytes, '12345', now)).toBe(false);
    expect(verifyTotpCode(secretBytes, '1234567', now)).toBe(false);
    expect(verifyTotpCode(secretBytes, 'abcdef', now)).toBe(false);
    expect(verifyTotpCode(secretBytes, '12 34 56', now)).toBe(false);
  });

  it('rejects a code computed against a different secret', () => {
    const a = generateTotpSecret().secretBytes;
    const b = generateTotpSecret().secretBytes;
    const codeA = computeTotpCode(a, now);
    expect(verifyTotpCode(b, codeA, now)).toBe(false);
  });
});

describe('encryptSecret + decryptSecret (AES-256-GCM)', () => {
  it('round-trips an arbitrary secret', () => {
    const { secretBytes } = generateTotpSecret();
    const enc = encryptSecret(secretBytes, KEY_BASE64, ACCOUNT_ID);
    const dec = decryptSecret(enc, KEY_BASE64, ACCOUNT_ID);
    expect(dec.equals(secretBytes)).toBe(true);
    expect(enc.ciphertext.startsWith(MFA_TOTP_SECRET_V2_PREFIX)).toBe(true);
  });

  it('produces a fresh IV every call (no nonce reuse)', () => {
    const { secretBytes } = generateTotpSecret();
    const a = encryptSecret(secretBytes, KEY_BASE64, ACCOUNT_ID);
    const b = encryptSecret(secretBytes, KEY_BASE64, ACCOUNT_ID);
    expect(a.iv).not.toBe(b.iv);
    expect(a.ciphertext).not.toBe(b.ciphertext);
  });

  it('throws on tampered ciphertext', () => {
    const { secretBytes } = generateTotpSecret();
    const enc = encryptSecret(secretBytes, KEY_BASE64, ACCOUNT_ID);
    const tampered = Buffer.from(enc.ciphertext.slice(MFA_TOTP_SECRET_V2_PREFIX.length), 'base64');
    tampered[0] = (tampered[0]! ^ 0xff) & 0xff;
    expect(() =>
      decryptSecret(
        {
          ...enc,
          ciphertext: `${MFA_TOTP_SECRET_V2_PREFIX}${tampered.toString('base64')}`,
        },
        KEY_BASE64,
        ACCOUNT_ID,
      ),
    ).toThrow();
  });

  it('throws on tampered auth tag', () => {
    const { secretBytes } = generateTotpSecret();
    const enc = encryptSecret(secretBytes, KEY_BASE64, ACCOUNT_ID);
    const badTag = Buffer.from(enc.tag, 'base64');
    badTag[0] = (badTag[0]! ^ 0xff) & 0xff;
    expect(() =>
      decryptSecret({ ...enc, tag: badTag.toString('base64') }, KEY_BASE64, ACCOUNT_ID),
    ).toThrow();
  });

  it('throws when the key is the wrong length', () => {
    const { secretBytes } = generateTotpSecret();
    const tooShort = randomBytes(16).toString('base64');
    expect(() => encryptSecret(secretBytes, tooShort, ACCOUNT_ID)).toThrow(/32 bytes/);
  });

  it('binds a v2 tuple to its owning account and refuses legacy ordinary reads', () => {
    const { secretBytes } = generateTotpSecret();
    const enc = encryptSecret(secretBytes, KEY_BASE64, ACCOUNT_ID);
    expect(() => decryptSecret(enc, KEY_BASE64, 'acc_other')).toThrow();

    const legacy = encryptLegacySecret(secretBytes);
    expect(() => decryptSecret(legacy, KEY_BASE64, ACCOUNT_ID)).toThrow(/not a v2/i);
    expect(decryptLegacyMfaSecret(legacy, KEY_BASE64).equals(secretBytes)).toBe(true);
    expect(() => decryptLegacyMfaSecret(enc, KEY_BASE64)).toThrow(/refuses a v2/i);
  });

  it('rejects missing context, non-canonical fields, and non-20-byte secrets', () => {
    const { secretBytes } = generateTotpSecret();
    const enc = encryptSecret(secretBytes, KEY_BASE64, ACCOUNT_ID);
    expect(() => decryptSecret(enc, KEY_BASE64, '')).toThrow(/accountId/);
    expect(() => decryptSecret({ ...enc, iv: `${enc.iv}\n` }, KEY_BASE64, ACCOUNT_ID)).toThrow(
      /canonical base64/,
    );
    expect(() => encryptSecret(Buffer.alloc(19), KEY_BASE64, ACCOUNT_ID)).toThrow(/expected 20/);
  });

  it('rejects an authenticated v2 plaintext with the wrong TOTP seed length', () => {
    const key = Buffer.from(KEY_BASE64, 'base64');
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(
      Buffer.from(JSON.stringify(['driftstack.mfa-totp-secret', 2, ACCOUNT_ID]), 'utf8'),
    );
    const ciphertext = Buffer.concat([cipher.update(Buffer.alloc(19, 4)), cipher.final()]);
    const envelope = {
      ciphertext: `${MFA_TOTP_SECRET_V2_PREFIX}${ciphertext.toString('base64')}`,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
    };
    expect(() => decryptSecret(envelope, KEY_BASE64, ACCOUNT_ID)).toThrow(/expected 20/);
  });
});

describe('generateRecoveryCodes (V-353b)', () => {
  it('produces 10 codes by default', () => {
    expect(generateRecoveryCodes()).toHaveLength(10);
  });

  it('every code is hyphenated 5+5 Crockford base32 (no 0/1/I/O/L)', () => {
    const codes = generateRecoveryCodes(50);
    for (const c of codes) {
      // Format: 5 chars, hyphen, 5 chars.
      expect(c).toMatch(
        /^[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}-[ABCDEFGHJKMNPQRSTVWXYZ23456789]{5}$/,
      );
      // None of the ambiguous characters appear.
      expect(c).not.toMatch(/[01IOL]/);
    }
  });

  it('produces unique codes (no duplicate within a single batch is the load-bearing property; the alphabet is large enough that 10 codes in 50-call batches collide vanishingly often)', () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe('normalizeRecoveryCode', () => {
  it('uppercases and strips hyphens + whitespace', () => {
    expect(normalizeRecoveryCode('abcde-fghjk')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode(' abcde - fghjk ')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('ABCDE-FGHJK')).toBe('ABCDEFGHJK');
    expect(normalizeRecoveryCode('AB CD EF GH JK')).toBe('ABCDEFGHJK');
  });
});
