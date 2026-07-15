import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  convertPlatformSecretValueToV2,
  decryptPlatformSecretValue,
  encryptPlatformSecretValue,
  isPlatformSecretValueV2Envelope,
  isValidPlatformSecretValue,
  PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES,
  PLATFORM_SECRET_VALUE_V2_PREFIX,
} from '../../src/lib/platform-secret-value-encryption.js';

const KEY = Buffer.alloc(32, 81).toString('base64');
const WRONG_KEY = Buffer.alloc(32, 82).toString('base64');

function encryptRaw(
  plaintext: Buffer,
  args: { key?: string; aad?: Buffer; prefix?: string } = {},
): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(args.key ?? KEY, 'base64'), iv);
  if (args.aad !== undefined) cipher.setAAD(args.aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([
    ...(args.prefix === undefined ? [] : [Buffer.from(args.prefix, 'utf8')]),
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

describe('name-bound platform-secret value encryption', () => {
  it('roundtrips an explicit v2 envelope with a random IV', () => {
    const a = encryptPlatformSecretValue('sk-live-secret', KEY, 'stripe_secret_key');
    const b = encryptPlatformSecretValue('sk-live-secret', KEY, 'stripe_secret_key');
    expect(isPlatformSecretValueV2Envelope(a)).toBe(true);
    expect(a.subarray(0, Buffer.byteLength(PLATFORM_SECRET_VALUE_V2_PREFIX)).toString('utf8')).toBe(
      PLATFORM_SECRET_VALUE_V2_PREFIX,
    );
    expect(a.equals(b)).toBe(false);
    expect(decryptPlatformSecretValue(a, KEY, 'stripe_secret_key')).toBe('sk-live-secret');
  });

  it('rejects cross-name relocation and a wrong semantic purpose', () => {
    const stored = encryptPlatformSecretValue('secret', KEY, 'stripe_secret_key');
    expect(() => decryptPlatformSecretValue(stored, KEY, 'postmark_server_token')).toThrow();

    const wrongPurpose = encryptRaw(Buffer.from('secret'), {
      prefix: PLATFORM_SECRET_VALUE_V2_PREFIX,
      aad: Buffer.from(
        JSON.stringify(['driftstack.unrelated-purpose', 2, 'stripe_secret_key', 'value']),
      ),
    });
    expect(() => decryptPlatformSecretValue(wrongPurpose, KEY, 'stripe_secret_key')).toThrow();
  });

  it('rejects tampering and the wrong encryption key', () => {
    const stored = encryptPlatformSecretValue('secret', KEY, 'stripe_secret_key');
    const tampered = Buffer.from(stored);
    tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0xff;
    expect(() => decryptPlatformSecretValue(tampered, KEY, 'stripe_secret_key')).toThrow();
    expect(() => decryptPlatformSecretValue(stored, WRONG_KEY, 'stripe_secret_key')).toThrow();
  });

  it('keeps prefixless legacy bytes bootstrap-only and converts them for the exact name', () => {
    const legacy = encryptRaw(Buffer.from('legacy-value'));
    expect(() => decryptPlatformSecretValue(legacy, KEY, 'legacy_key')).toThrow(/not a v2/);
    const converted = convertPlatformSecretValueToV2(legacy, KEY, 'legacy_key');
    expect(isPlatformSecretValueV2Envelope(converted)).toBe(true);
    expect(decryptPlatformSecretValue(converted, KEY, 'legacy_key')).toBe('legacy-value');
    expect(convertPlatformSecretValueToV2(converted, KEY, 'legacy_key')).toBe(converted);
  });

  it('enforces 1-8192 exact UTF-8 bytes rather than UTF-16 code units', () => {
    const exactAscii = 'a'.repeat(PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES);
    const exactMultibyte = 'é'.repeat(PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES / 2);
    for (const value of [exactAscii, exactMultibyte]) {
      expect(isValidPlatformSecretValue(value)).toBe(true);
      const stored = encryptPlatformSecretValue(value, KEY, 'bounded_key');
      expect(decryptPlatformSecretValue(stored, KEY, 'bounded_key')).toBe(value);
    }
    for (const value of ['', 'a'.repeat(8193), 'é'.repeat(4097), '\ud800']) {
      expect(isValidPlatformSecretValue(value)).toBe(false);
      expect(() => encryptPlatformSecretValue(value, KEY, 'bounded_key')).toThrow(/UTF-8/);
    }
  });

  it('rejects malformed, unknown-version, truncated, oversized and non-UTF-8 envelopes', () => {
    const prefix = Buffer.from(PLATFORM_SECRET_VALUE_V2_PREFIX, 'utf8');
    const unknownVersion = Buffer.from('driftstack:platform-secret-value:v3:not-v2');
    for (const blob of [
      Buffer.concat([prefix, Buffer.alloc(28)]),
      Buffer.concat([prefix, Buffer.alloc(28 + 8193)]),
      unknownVersion,
    ]) {
      expect(() => decryptPlatformSecretValue(blob, KEY, 'bounded_key')).toThrow();
    }
    expect(() => convertPlatformSecretValueToV2(unknownVersion, KEY, 'bounded_key')).toThrow(
      /unknown envelope version/,
    );
    const invalidUtf8Legacy = encryptRaw(Buffer.from([0xff]));
    expect(() => convertPlatformSecretValueToV2(invalidUtf8Legacy, KEY, 'bounded_key')).toThrow(
      /UTF-8/,
    );
  });

  it('rejects invalid record names and malformed keys', () => {
    const badKey = Buffer.alloc(8).toString('base64');
    expect(() => encryptPlatformSecretValue('value', badKey, 'valid_name')).toThrow(/32/);
    for (const name of ['', 'Bad', '_leading', 'a'.repeat(65), '../path']) {
      expect(() => encryptPlatformSecretValue('value', KEY, name)).toThrow(/name/);
    }
  });
});
