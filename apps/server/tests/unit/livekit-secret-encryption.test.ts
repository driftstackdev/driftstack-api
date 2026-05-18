// LK.2 — AES-256-GCM round-trip for the per-Mac LiveKit secret
// envelope. Mirrors the BYOK Anthropic + gui_control_key encryption
// tests; the same MFA_ENCRYPTION_KEY threads through all three.

import { describe, expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  encryptLivekitSecret,
  decryptLivekitSecret,
} from '../../src/lib/livekit-secret-encryption.js';

function makeKey(): string {
  return randomBytes(32).toString('base64');
}

describe('LK.2 — encryptLivekitSecret / decryptLivekitSecret', () => {
  it('round-trips plaintext through the AES-256-GCM envelope', () => {
    const key = makeKey();
    const plaintext = 'lk_secret_test_abc_def_ghi_jkl_mno_pqr_stu_vwx_yz';
    const ciphertext = encryptLivekitSecret(plaintext, key);
    expect(ciphertext).not.toBe(plaintext);
    expect(decryptLivekitSecret(ciphertext, key)).toBe(plaintext);
  });

  it('returns base64-encoded output (TEXT-column safe)', () => {
    const key = makeKey();
    const ciphertext = encryptLivekitSecret('lk_test_xyz', key);
    // base64 alphabet only — no raw bytes / control chars.
    expect(ciphertext).toMatch(/^[A-Za-z0-9+/]+=*$/);
  });

  it('different IVs per call → different ciphertexts for the same plaintext', () => {
    const key = makeKey();
    const a = encryptLivekitSecret('lk_test_xyz', key);
    const b = encryptLivekitSecret('lk_test_xyz', key);
    expect(a).not.toBe(b);
    expect(decryptLivekitSecret(a, key)).toBe('lk_test_xyz');
    expect(decryptLivekitSecret(b, key)).toBe('lk_test_xyz');
  });

  it('rejects empty plaintext (refuses to encrypt)', () => {
    const key = makeKey();
    expect(() => encryptLivekitSecret('', key)).toThrow(/empty/);
  });

  it('rejects wrong-key decryption (auth-tag mismatch throws)', () => {
    const keyA = makeKey();
    const keyB = makeKey();
    const ciphertext = encryptLivekitSecret('lk_test_xyz', keyA);
    expect(() => decryptLivekitSecret(ciphertext, keyB)).toThrow();
  });

  it('rejects keys that decode to the wrong length', () => {
    const shortKey = randomBytes(16).toString('base64');
    expect(() => encryptLivekitSecret('lk_test_xyz', shortKey)).toThrow(/must decode to 32 bytes/);
  });

  it('rejects truncated ciphertext blobs at decrypt time', () => {
    const key = makeKey();
    // Below the iv+tag+1 minimum.
    expect(() => decryptLivekitSecret('AAAA', key)).toThrow(/at least/);
  });
});
