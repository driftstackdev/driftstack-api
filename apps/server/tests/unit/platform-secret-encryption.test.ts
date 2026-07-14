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
    const blob = encryptPlatformSecret(plaintext, key);
    // Blob layout: 12 bytes IV + 16 bytes tag + N bytes ciphertext.
    expect(blob.length).toBeGreaterThanOrEqual(12 + 16 + plaintext.length);
    const decrypted = decryptPlatformSecret(blob, key);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypt produces a different ciphertext on each call (random IV)', () => {
    const key = makeKey();
    const plaintext = 'sk-live-determinism-check';
    const a = encryptPlatformSecret(plaintext, key);
    const b = encryptPlatformSecret(plaintext, key);
    expect(Buffer.compare(a, b)).not.toBe(0);
    expect(decryptPlatformSecret(a, key)).toBe(plaintext);
    expect(decryptPlatformSecret(b, key)).toBe(plaintext);
  });

  // Regression: encryptPlatformSecret previously had no empty-plaintext
  // guard, unlike its siblings encryptByokAnthropicKey and
  // encryptGuiControlKey, which both refuse an empty string.
  it('encrypt rejects an empty plaintext', () => {
    const key = makeKey();
    expect(() => encryptPlatformSecret('', key)).toThrow(/empty.*refusing/i);
  });

  // Regression: decryptPlatformSecret previously accepted an exact
  // IV+tag-only (28-byte) blob with zero ciphertext bytes; its siblings
  // require >= 1 ciphertext byte (blob.length < IV + TAG + 1).
  it('decrypt rejects a blob that is exactly IV + tag with zero ciphertext bytes', () => {
    const key = makeKey();
    const ivTagOnly = Buffer.alloc(12 + 16); // 28 bytes, no ciphertext at all
    expect(() => decryptPlatformSecret(ivTagOnly, key)).toThrow(/too short/i);
  });

  it('decrypt accepts a blob with exactly one ciphertext byte (boundary)', () => {
    const key = makeKey();
    const blob = encryptPlatformSecret('a', key);
    expect(blob.length).toBe(12 + 16 + 1);
    expect(decryptPlatformSecret(blob, key)).toBe('a');
  });

  it('decrypt rejects a tampered blob (GCM auth failure)', () => {
    const key = makeKey();
    const plaintext = 'sk-live-tamper-detection-test';
    const blob = encryptPlatformSecret(plaintext, key);
    const tampered = Buffer.from(blob);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
    expect(() => decryptPlatformSecret(tampered, key)).toThrow();
  });

  it('decrypt rejects a different key (key-mismatch ⇒ GCM auth failure)', () => {
    const keyA = makeKey();
    const keyB = makeKey();
    const blob = encryptPlatformSecret('sk-live-wrong-key-test', keyA);
    expect(() => decryptPlatformSecret(blob, keyB)).toThrow();
  });

  it('authenticated context round-trips only under the exact same context', () => {
    const key = makeKey();
    const blob = encryptPlatformSecret('context-bound-value', key, 'purpose:record-a');
    expect(decryptPlatformSecret(blob, key, 'purpose:record-a')).toBe('context-bound-value');
    expect(() => decryptPlatformSecret(blob, key, 'purpose:record-b')).toThrow();
    expect(() => decryptPlatformSecret(blob, key)).toThrow();
  });

  it('rejects an explicitly empty authenticated context', () => {
    const key = makeKey();
    expect(() => encryptPlatformSecret('value', key, '')).toThrow(/authenticated context is empty/);
    const blob = encryptPlatformSecret('value', key);
    expect(() => decryptPlatformSecret(blob, key, '')).toThrow(/authenticated context is empty/);
  });

  it('encrypt/decrypt reject a key that does not decode to 32 bytes', () => {
    const tooShortKey = Buffer.alloc(16).toString('base64');
    expect(() => encryptPlatformSecret('v', tooShortKey)).toThrow(/32 bytes/);
    const key = makeKey();
    const blob = encryptPlatformSecret('v', key);
    expect(() => decryptPlatformSecret(blob, tooShortKey)).toThrow(/32 bytes/);
  });
});
