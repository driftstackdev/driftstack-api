// Admin-cockpit secrets Phase A — dedicated lib-level unit tests for
// platform-secret-encryption.ts, mirroring the sibling BYOK / gui-control-key
// crypto test files (byok-anthropic-encryption.test.ts,
// gui-control-key-encryption.test.ts). Pins the same input-validation guards
// those siblings enforce: refuse an empty plaintext on encrypt, and require
// the stored blob to contain at least one ciphertext byte on decrypt.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptPlatformSecret,
  encryptPlatformSecret,
} from '../../src/lib/platform-secret-encryption.js';

function makeKey(): string {
  return randomBytes(32).toString('base64');
}

describe('platform-secret encryption', () => {
  it('encrypt + decrypt round-trips the plaintext', () => {
    const key = makeKey();
    const plaintext = 'sk-live-totally-fake-test-vector-not-a-real-secret-1234567890';
    const blob = encryptPlatformSecret(plaintext, key, undefined);
    // Blob layout: 12 bytes IV + 16 bytes tag + N bytes ciphertext.
    expect(blob.length).toBeGreaterThanOrEqual(12 + 16 + plaintext.length);
    const decrypted = decryptPlatformSecret(blob, key, undefined);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypt produces a different ciphertext on each call (random IV)', () => {
    const key = makeKey();
    const plaintext = 'sk-live-determinism-check';
    const a = encryptPlatformSecret(plaintext, key, undefined);
    const b = encryptPlatformSecret(plaintext, key, undefined);
    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(decryptPlatformSecret(a, key, undefined)).toBe(plaintext);
    expect(decryptPlatformSecret(b, key, undefined)).toBe(plaintext);
  });

  // Regression: encryptPlatformSecret previously had no empty-plaintext
  // guard, unlike its siblings encryptByokAnthropicKey and
  // encryptGuiControlKey, which both refuse an empty string.
  it('encrypt rejects an empty plaintext', () => {
    const key = makeKey();
    expect(() => encryptPlatformSecret('', key, undefined)).toThrow(/empty.*refusing/i);
  });

  // Regression: decryptPlatformSecret previously accepted an exact
  // IV+tag-only (28-byte) blob with zero ciphertext bytes; its siblings
  // require >= 1 ciphertext byte (blob.length < IV + TAG + 1).
  it('decrypt rejects a blob that is exactly IV + tag with zero ciphertext bytes', () => {
    const key = makeKey();
    const ivTagOnly = Buffer.alloc(12 + 16); // 28 bytes, no ciphertext at all
    expect(() => decryptPlatformSecret(ivTagOnly, key, undefined)).toThrow(/too short/i);
  });

  it('decrypt accepts a blob with exactly one ciphertext byte (boundary)', () => {
    const key = makeKey();
    const blob = encryptPlatformSecret('a', key, undefined);
    expect(blob.length).toBe(12 + 16 + 1);
    expect(decryptPlatformSecret(blob, key, undefined)).toBe('a');
  });

  it('decrypt rejects a tampered blob (GCM auth failure)', () => {
    const key = makeKey();
    const plaintext = 'sk-live-tamper-detection-test';
    const blob = encryptPlatformSecret(plaintext, key, undefined);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => decryptPlatformSecret(tampered, key, undefined)).toThrow();
  });

  it('decrypt rejects a different key (key-mismatch ⇒ GCM auth failure)', () => {
    const keyA = makeKey();
    const keyB = makeKey();
    const blob = encryptPlatformSecret('sk-live-wrong-key-test', keyA, undefined);
    expect(() => decryptPlatformSecret(blob, keyB, undefined)).toThrow();
  });

  it('authenticated context round-trips only under the exact same context', () => {
    const key = makeKey();
    const blob = encryptPlatformSecret('context-bound-value', key, 'purpose:record-a');
    expect(decryptPlatformSecret(blob, key, 'purpose:record-a')).toBe('context-bound-value');
    expect(() => decryptPlatformSecret(blob, key, 'purpose:record-b')).toThrow();
    expect(() => decryptPlatformSecret(blob, key, undefined)).toThrow();
  });

  it('rejects an explicitly empty authenticated context', () => {
    const key = makeKey();
    expect(() => encryptPlatformSecret('value', key, '')).toThrow(/authenticated context is empty/);
    const blob = encryptPlatformSecret('value', key, undefined);
    expect(() => decryptPlatformSecret(blob, key, '')).toThrow(/authenticated context is empty/);
  });

  it('encrypt/decrypt reject a key that does not decode to 32 bytes', () => {
    const tooShortKey = Buffer.alloc(16).toString('base64');
    expect(() => encryptPlatformSecret('v', tooShortKey, undefined)).toThrow(/32 bytes/);
    const key = makeKey();
    const blob = encryptPlatformSecret('v', key, undefined);
    expect(() => decryptPlatformSecret(blob, tooShortKey, undefined)).toThrow(/32 bytes/);
  });
});

// ─── the key-length check is an EQUALITY, not a floor ──────────────────────
//
// A census of guard conditions found `key.length !== AES_256_KEY_BYTES` at EIGHT
// independent modules — one per secret type. Every one is covered for a SHORT
// key; measured across the whole unit suite, relaxing `!==` to `<` survived in
// five of the eight. A test that only sends short keys cannot see the
// difference, and an over-long key is the realistic shape: a 64-byte key pasted
// where 32 was wanted, or base64 that decoded with trailing bytes.
//
// ⚠️ What it costs is an opaque failure, not a silent one — measured:
// `createCipheriv('aes-256-gcm', <48 bytes>)` throws "Invalid key length". So
// relaxing this check trades a named, module-level refusal for a crypto-internal
// error with no indication of which secret or which key was wrong. Same argument
// as the PROFILE_MASTER_KEY fail-closed refusal, not a plaintext hazard.
describe('platform-secret-encryption — over-long key', () => {
  it('CRITICAL a 48-byte key is refused just as a 16-byte one is. The check is an equality; a floor would accept this and hand node:crypto a key it rejects with "Invalid key length", losing which secret was misconfigured.', () => {
    // base64 STRING, matching the parameter type — a Buffer compiles under
    // vitest and fails `npm run typecheck`, which this repo asserts as a test.
    const LONGKEY = Buffer.alloc(48, 7).toString('base64');
    expect(() => encryptPlatformSecret('x', LONGKEY, undefined)).toThrow(
      /32 bytes|must be 32|AES/i,
    );
  });
});
