// AI-CHAT BYOK Anthropic — encryption helper unit tests.
// AES-256-GCM round-trip + format validation + tamper detection.

import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptByokAnthropicKey,
  encryptByokAnthropicKey,
  looksLikeAnthropicKey,
} from '../../src/lib/byok-anthropic-encryption.js';

function makeKey(): string {
  return randomBytes(32).toString('base64');
}

describe('BYOK Anthropic encryption', () => {
  it('encrypt + decrypt round-trips the customer key plaintext', () => {
    const key = makeKey();
    const plaintext = 'sk-ant-api03-totally-fake-test-vector-not-a-real-key-1234567890';
    const blob = encryptByokAnthropicKey(plaintext, key);
    // Blob layout: 12 bytes IV + 16 bytes tag + N bytes ciphertext.
    expect(blob.length).toBeGreaterThanOrEqual(12 + 16 + plaintext.length);
    const decrypted = decryptByokAnthropicKey(blob, key);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypt produces a different ciphertext on each call (random IV)', () => {
    const key = makeKey();
    const plaintext = 'sk-ant-api03-test-determinism-check';
    const a = encryptByokAnthropicKey(plaintext, key);
    const b = encryptByokAnthropicKey(plaintext, key);
    expect(Buffer.compare(a, b)).not.toBe(0);
    // Both still decrypt to the same plaintext though.
    expect(decryptByokAnthropicKey(a, key)).toBe(plaintext);
    expect(decryptByokAnthropicKey(b, key)).toBe(plaintext);
  });

  it('encrypt rejects an empty plaintext', () => {
    const key = makeKey();
    expect(() => encryptByokAnthropicKey('', key)).toThrow(/empty.*refusing/i);
  });

  it('decrypt rejects a too-short blob (< IV + tag + 1 byte)', () => {
    const key = makeKey();
    const tooShort = Buffer.alloc(12 + 16); // missing the ciphertext byte
    expect(() => decryptByokAnthropicKey(tooShort, key)).toThrow(/at least.*byte ciphertext/);
  });

  it('decrypt rejects a tampered tag (GCM authenticity check)', () => {
    const key = makeKey();
    const plaintext = 'sk-ant-api03-tamper-detection-test';
    const blob = encryptByokAnthropicKey(plaintext, key);
    // Flip the last bit of the auth tag (bytes 12..28).
    const tampered = Buffer.from(blob);
    tampered[27] = tampered[27]! ^ 0x01;
    expect(() => decryptByokAnthropicKey(tampered, key)).toThrow(/auth tag|Unsupported|bad/i);
  });

  it('decrypt rejects a different key (key-mismatch ⇒ GCM auth failure)', () => {
    const keyA = makeKey();
    const keyB = makeKey();
    const blob = encryptByokAnthropicKey('sk-ant-api03-wrong-key-test', keyA);
    expect(() => decryptByokAnthropicKey(blob, keyB)).toThrow();
  });

  it('encrypt rejects a key that does not decode to 32 bytes', () => {
    const tooShortKey = Buffer.alloc(16).toString('base64');
    expect(() => encryptByokAnthropicKey('sk-ant-api03-x', tooShortKey)).toThrow(
      /must decode to 32 bytes/,
    );
  });

  it('looksLikeAnthropicKey accepts well-formed Anthropic key prefixes', () => {
    expect(looksLikeAnthropicKey('sk-ant-api03-abc123-XYZ_-456')).toBe(true);
    expect(looksLikeAnthropicKey('sk-ant-future-api04-format-12345')).toBe(true);
  });

  it('looksLikeAnthropicKey rejects garbage / wrong prefixes', () => {
    expect(looksLikeAnthropicKey('')).toBe(false);
    expect(looksLikeAnthropicKey('sk-ant-')).toBe(false); // empty body
    expect(looksLikeAnthropicKey('sk_ant_api03_under_score')).toBe(false);
    expect(looksLikeAnthropicKey('hey-there-anthropic-key')).toBe(false);
    expect(looksLikeAnthropicKey('sk-openai-totally-wrong-vendor')).toBe(false);
  });
});
