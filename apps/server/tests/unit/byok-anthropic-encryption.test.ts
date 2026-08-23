// AI-CHAT BYOK Anthropic — encryption helper unit tests.
// AES-256-GCM round-trip + format validation + tamper detection.

import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  BYOK_ANTHROPIC_KEY_V2_PREFIX,
  decryptByokAnthropicKey,
  decryptLegacyByokAnthropicKey,
  encryptByokAnthropicKey,
  isByokAnthropicKeyV2Envelope,
  looksLikeAnthropicKey,
} from '../../src/lib/byok-anthropic-encryption.js';

const ACCOUNT_A = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_B = '22222222-2222-2222-2222-222222222222';

function makeKey(): string {
  return randomBytes(32).toString('base64');
}

function encryptLegacyForTest(plaintext: string, keyBase64: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function encryptWithContextForTest(
  plaintext: string | Buffer,
  keyBase64: string,
  accountId: string,
  purpose = 'driftstack.byok-anthropic-key',
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  cipher.setAAD(Buffer.from(JSON.stringify([purpose, 2, accountId]), 'utf8'));
  const ciphertext = Buffer.concat([
    typeof plaintext === 'string' ? cipher.update(plaintext, 'utf8') : cipher.update(plaintext),
    cipher.final(),
  ]);
  return Buffer.concat([
    Buffer.from(BYOK_ANTHROPIC_KEY_V2_PREFIX, 'utf8'),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

describe('BYOK Anthropic encryption', () => {
  it('encrypt + decrypt round-trips the customer key plaintext', () => {
    const key = makeKey();
    const plaintext = 'sk-ant-api03-totally-fake-test-vector-not-a-real-key-1234567890';
    const blob = encryptByokAnthropicKey(plaintext, key, ACCOUNT_A);
    expect(isByokAnthropicKeyV2Envelope(blob)).toBe(true);
    expect(blob.subarray(0, Buffer.byteLength(BYOK_ANTHROPIC_KEY_V2_PREFIX)).toString('utf8')).toBe(
      BYOK_ANTHROPIC_KEY_V2_PREFIX,
    );
    const decrypted = decryptByokAnthropicKey(blob, key, ACCOUNT_A);
    expect(decrypted).toBe(plaintext);
  });

  it('encrypt produces a different ciphertext on each call (random IV)', () => {
    const key = makeKey();
    const plaintext = 'sk-ant-api03-test-determinism-check';
    const a = encryptByokAnthropicKey(plaintext, key, ACCOUNT_A);
    const b = encryptByokAnthropicKey(plaintext, key, ACCOUNT_A);
    expect(Buffer.compare(a, b)).not.toBe(0);
    // Both still decrypt to the same plaintext though.
    expect(decryptByokAnthropicKey(a, key, ACCOUNT_A)).toBe(plaintext);
    expect(decryptByokAnthropicKey(b, key, ACCOUNT_A)).toBe(plaintext);
  });

  it('encrypt rejects an empty plaintext', () => {
    const key = makeKey();
    expect(() => encryptByokAnthropicKey('', key, ACCOUNT_A)).toThrow(/bounded sk-ant-/i);
  });

  it('decrypt rejects a too-short blob (< IV + tag + 1 byte)', () => {
    const key = makeKey();
    const prefix = Buffer.from(BYOK_ANTHROPIC_KEY_V2_PREFIX, 'utf8');
    const tooShort = Buffer.concat([prefix, Buffer.alloc(12 + 16)]);
    expect(() => decryptByokAnthropicKey(tooShort, key, ACCOUNT_A)).toThrow(/bounded storage/);
  });

  it('decrypt rejects a tampered tag (GCM authenticity check)', () => {
    const key = makeKey();
    const plaintext = 'sk-ant-api03-tamper-detection-test';
    const blob = encryptByokAnthropicKey(plaintext, key, ACCOUNT_A);
    // Flip the last bit of the auth tag after the v2 marker.
    const tampered = Buffer.from(blob);
    const tagEnd = Buffer.byteLength(BYOK_ANTHROPIC_KEY_V2_PREFIX) + 27;
    tampered[tagEnd] = tampered[tagEnd]! ^ 0x01;
    expect(() => decryptByokAnthropicKey(tampered, key, ACCOUNT_A)).toThrow();
  });

  it('decrypt rejects a different key (key-mismatch ⇒ GCM auth failure)', () => {
    const keyA = makeKey();
    const keyB = makeKey();
    const blob = encryptByokAnthropicKey('sk-ant-api03-wrong-key-test', keyA, ACCOUNT_A);
    expect(() => decryptByokAnthropicKey(blob, keyB, ACCOUNT_A)).toThrow();
  });

  it('encrypt rejects a key that does not decode to 32 bytes', () => {
    const tooShortKey = Buffer.alloc(16).toString('base64');
    expect(() => encryptByokAnthropicKey('sk-ant-api03-x', tooShortKey, ACCOUNT_A)).toThrow(
      /must decode to 32 bytes/,
    );
  });

  it('binds the credential to the owning account and canonicalizes UUID case', () => {
    const key = makeKey();
    const plaintext = 'sk-ant-api03-account-bound';
    const blob = encryptByokAnthropicKey(plaintext, key, ACCOUNT_A.toUpperCase());
    expect(decryptByokAnthropicKey(blob, key, ACCOUNT_A)).toBe(plaintext);
    expect(() => decryptByokAnthropicKey(blob, key, ACCOUNT_B)).toThrow();
  });

  it('ordinary reads reject legacy bytes; the bootstrap-only reader accepts only legacy', () => {
    const key = makeKey();
    const plaintext = 'sk-ant-api03-legacy-bootstrap-only';
    const legacy = encryptLegacyForTest(plaintext, key);
    expect(() => decryptByokAnthropicKey(legacy, key, ACCOUNT_A)).toThrow(/not a v2/);
    expect(decryptLegacyByokAnthropicKey(legacy, key)).toBe(plaintext);
    const v2 = encryptByokAnthropicKey(plaintext, key, ACCOUNT_A);
    expect(() => decryptLegacyByokAnthropicKey(v2, key)).toThrow(/refuses a v2/);
  });

  it('rejects a valid GCM envelope authenticated for a different purpose', () => {
    const key = makeKey();
    const wrongPurpose = encryptWithContextForTest(
      'sk-ant-api03-wrong-purpose',
      key,
      ACCOUNT_A,
      'driftstack.byok-anthropic-key.wrong-purpose',
    );
    expect(() => decryptByokAnthropicKey(wrongPurpose, key, ACCOUNT_A)).toThrow();
  });

  it('rejects authenticated plaintext that is invalid UTF-8 or not an Anthropic-key shape', () => {
    const key = makeKey();
    const invalidUtf8 = encryptWithContextForTest(Buffer.from([0xff]), key, ACCOUNT_A);
    expect(() => decryptByokAnthropicKey(invalidUtf8, key, ACCOUNT_A)).toThrow(/valid UTF-8/);
    const wrongShape = encryptWithContextForTest('sk-openai-not-an-anthropic-key', key, ACCOUNT_A);
    expect(() => decryptByokAnthropicKey(wrongShape, key, ACCOUNT_A)).toThrow(/bounded sk-ant-/);
  });

  it('rejects malformed account identities before encryption or decryption', () => {
    const key = makeKey();
    expect(() => encryptByokAnthropicKey('sk-ant-api03-test', key, 'not-a-uuid')).toThrow(/UUID/);
    const blob = encryptByokAnthropicKey('sk-ant-api03-test', key, ACCOUNT_A);
    expect(() => decryptByokAnthropicKey(blob, key, 'not-a-uuid')).toThrow(/UUID/);
  });

  it('bounds complete v2 bytes and rejects truncation or extension before plaintext use', () => {
    const key = makeKey();
    const blob = encryptByokAnthropicKey('sk-ant-' + 'a'.repeat(512), key, ACCOUNT_A);
    expect(decryptByokAnthropicKey(blob, key, ACCOUNT_A)).toBe('sk-ant-' + 'a'.repeat(512));
    expect(() => decryptByokAnthropicKey(blob.subarray(0, -1), key, ACCOUNT_A)).toThrow();
    expect(() =>
      decryptByokAnthropicKey(Buffer.concat([blob, Buffer.from([0])]), key, ACCOUNT_A),
    ).toThrow(/bounded storage/);
  });

  it('looksLikeAnthropicKey accepts well-formed Anthropic key prefixes', () => {
    expect(looksLikeAnthropicKey('sk-ant-api03-abc123-XYZ_-456')).toBe(true);
    expect(looksLikeAnthropicKey('sk-ant-future-api04-format-12345')).toBe(true);
    // 512-char body is the upper bound (real keys are ~108 chars) — still accepted.
    expect(looksLikeAnthropicKey('sk-ant-' + 'a'.repeat(512))).toBe(true);
  });

  it('looksLikeAnthropicKey rejects garbage / wrong prefixes', () => {
    expect(looksLikeAnthropicKey('')).toBe(false);
    expect(looksLikeAnthropicKey('sk-ant-')).toBe(false); // empty body
    expect(looksLikeAnthropicKey('sk_ant_api03_under_score')).toBe(false);
    expect(looksLikeAnthropicKey('hey-there-anthropic-key')).toBe(false);
    expect(looksLikeAnthropicKey('sk-openai-totally-wrong-vendor')).toBe(false);
    // Over the 512-char body bound — an oversized blob is rejected before we
    // encrypt + store it (capped only by bodyLimit otherwise).
    expect(looksLikeAnthropicKey('sk-ant-' + 'a'.repeat(513))).toBe(false);
  });

  // V-1379 — three storage-bound throws in this module were in the never-executed set, and
  // they are not the same kind of dark. The payload RANGE check had simply never run in
  // either direction; the two "exceeds the storage bound" throws around it cannot run at
  // all, because a check that fires first covers exactly the same ground.
  //
  //   plaintext ≤ 519 bytes  ⟺  blob ≤ 547 bytes      (GCM ciphertext length == plaintext
  //   length, and blob = 12 iv + 16 tag + ciphertext), and 519 = len('sk-ant-') + 512,
  //   which is precisely what `looksLikeAnthropicKey` already allows.
  //
  // So the encrypt-side bound sits behind a regex admitting the same maximum, and the
  // decrypt-side one behind a payload range that is the same inequality plus 28. Both are
  // defence in depth rather than gaps — but only while those numbers agree, which is what
  // the last arm pins.
  it('CRITICAL a stored payload SHORTER than iv+tag+1 is refused before any decrypt. Nothing had exercised this range check in either direction, and a blob that short cannot carry a tag at all — the subarray slicing below it would silently read past the end.', () => {
    const key = makeKey();
    // Driven through the LEGACY reader on purpose. `decryptByokAnthropicKey` gates the
    // whole envelope on the same numbers first, so this range can only be reached by the
    // one caller that does not: `decryptLegacyByokAnthropicKey` hands its blob straight to
    // `decryptPayload`, which is exactly the path a pre-v2 stored row takes.
    const tooShort = randomBytes(28); // iv + tag, zero bytes of ciphertext
    expect(() => decryptLegacyByokAnthropicKey(tooShort, key)).toThrow(/expected 29\.\.547/);
  });

  it('CRITICAL a stored payload LONGER than the bound is refused before any decrypt, and the boundary is exact: a payload at 547 bytes gets past the size gate and fails on authentication instead. Asserting only the refusal would pass against a range that rejects legitimate rows one byte early.', () => {
    const key = makeKey();
    const blob = (ciphertextBytes: number): Buffer =>
      Buffer.concat([randomBytes(12), randomBytes(16), Buffer.alloc(ciphertextBytes, 7)]);

    expect(() => decryptLegacyByokAnthropicKey(blob(520), key)).toThrow(/expected 29\.\.547/);
    expect(
      () => decryptLegacyByokAnthropicKey(blob(519), key),
      'exactly at the bound the size gate must let it through',
    ).not.toThrow(/expected 29\.\.547/);
  });

  it('CRITICAL the two "exceeds the storage bound" throws are unreachable BY ARITHMETIC, not by omission — and stay that way only while these three numbers agree. The key shape admits 519 bytes, the plaintext bound is 519, and the payload bound is 519 + 28; move any one of them and a real gap opens where a dead branch used to be.', () => {
    const PREFIX_BYTES = Buffer.byteLength('sk-ant-', 'utf8');
    const BODY_MAX_CHARS = 512;
    const MAX_PLAINTEXT = PREFIX_BYTES + BODY_MAX_CHARS;

    // The shape check runs first on the encrypt side and admits exactly the bound.
    const atMax = `sk-ant-${'a'.repeat(BODY_MAX_CHARS)}`;
    expect(Buffer.byteLength(atMax, 'utf8'), 'the longest accepted key IS the bound').toBe(
      MAX_PLAINTEXT,
    );
    expect(looksLikeAnthropicKey(atMax), 'the shape check accepts it').toBe(true);
    expect(
      looksLikeAnthropicKey(`sk-ant-${'a'.repeat(BODY_MAX_CHARS + 1)}`),
      'and refuses one character more, so the byte bound after it can never fire',
    ).toBe(false);

    // The payload range runs first on the decrypt side and is the same inequality plus 28.
    // GCM does not pad, so ciphertext length equals plaintext length.
    const key = makeKey();
    const envelope = encryptWithContextForTest(Buffer.alloc(MAX_PLAINTEXT, 97), key, ACCOUNT_A);
    expect(
      envelope.length - Buffer.byteLength(BYOK_ANTHROPIC_KEY_V2_PREFIX, 'utf8'),
      'a max-length plaintext produces a blob of exactly iv + tag + 519',
    ).toBe(12 + 16 + MAX_PLAINTEXT);
  });
});
