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

// The payload byte-bound on the DECRYPT path, made attributable.
//
// A mutation ledger over this module found 6 of 7 refusals covered and this one
// unnoticed — not because nothing exercises it. The truncated/oversized envelope
// test above feeds exactly these payloads, but asserts `.toThrow()` with no
// message, so neutralising the bound still throws: the payload flows on, GCM
// authentication fails on the empty-or-overlong ciphertext, and the test stays
// green on a crypto-internal error instead.
//
// That is precisely the trade this repo already refuses elsewhere — the
// over-long-key arm in webhook-secret-encryption exists for the same reason. A
// named refusal says which secret and what length; "unable to authenticate data"
// says nothing an operator can act on, and a truncated column and a wrong key
// look identical through it.
//
// Reachable because the v2 envelope check upstream validates the PREFIX only.
// Anything after it is unbounded, so a truncated row reaches here with a
// two-byte payload.
describe('platform-secret-value-encryption — payload bound, attributed', () => {
  const prefix = Buffer.from(PLATFORM_SECRET_VALUE_V2_PREFIX, 'utf8');
  // Derived, not hand-copied: raising the exported UTF-8 bound must not silently
  // leave these arms asserting a stale byte count. The 12 + 16 is the AES-GCM IV
  // and tag, fixed by the algorithm rather than by this module's policy.
  const GCM_OVERHEAD_BYTES = 12 + 16;
  const MIN_PAYLOAD = GCM_OVERHEAD_BYTES + 1;
  const MAX_PAYLOAD = GCM_OVERHEAD_BYTES + PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES;

  it('CRITICAL names the byte count when a stored envelope is one byte under the minimum payload, rather than letting it fall through to a GCM authentication failure that cannot distinguish a truncated row from a wrong key', () => {
    const short = Buffer.concat([prefix, Buffer.alloc(MIN_PAYLOAD - 1)]);
    expect(() => decryptPlatformSecretValue(short, KEY, 'bounded_key')).toThrow(
      new RegExp(`${(MIN_PAYLOAD - 1).toString()} bytes; expected ${MIN_PAYLOAD.toString()}\\.\\.`),
    );
  });

  it('CRITICAL names the byte count when a stored envelope is one byte over the maximum payload', () => {
    const long = Buffer.concat([prefix, Buffer.alloc(MAX_PAYLOAD + 1)]);
    expect(() => decryptPlatformSecretValue(long, KEY, 'bounded_key')).toThrow(
      new RegExp(
        `${(MAX_PAYLOAD + 1).toString()} bytes; expected .*\\.\\.${MAX_PAYLOAD.toString()} bytes`,
      ),
    );
  });
});
