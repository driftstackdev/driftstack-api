import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { encryptPlatformSecret } from '../../src/lib/platform-secret-encryption.js';
import {
  WEBHOOK_SECRET_V1_PREFIX,
  WEBHOOK_SECRET_V2_PREFIX,
  convertWebhookSecretToV2,
  encryptWebhookSecret,
  readWebhookSecret,
  type WebhookSecretEncryptionContext,
} from '../../src/lib/webhook-secret-encryption.js';

const KEY = randomBytes(32).toString('base64');
const OTHER_KEY = randomBytes(32).toString('base64');
const SECRET = `whsec_${'a'.repeat(32)}`;
const OTHER_SECRET = `whsec_${'b'.repeat(32)}`;
const CONTEXT: WebhookSecretEncryptionContext = {
  accountId: '10000000-0000-4000-8000-000000000001',
  endpointId: '20000000-0000-4000-8000-000000000001',
};

function forgeAuthenticatedEnvelope(
  plaintext: Buffer,
  purpose = 'driftstack.outbound-webhook-signing-secret',
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(KEY, 'base64'), iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([purpose, 2, CONTEXT.accountId, CONTEXT.endpointId, 'signing-secret']),
      'utf8',
    ),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return `${WEBHOOK_SECRET_V2_PREFIX}${Buffer.concat([
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]).toString('base64')}`;
}

describe('record-bound webhook secret encryption', () => {
  it('round-trips a fixed canonical v2 envelope without retaining plaintext', () => {
    const stored = encryptWebhookSecret(SECRET, KEY, CONTEXT);
    expect(stored.startsWith(WEBHOOK_SECRET_V2_PREFIX)).toBe(true);
    expect(stored.slice(WEBHOOK_SECRET_V2_PREFIX.length)).toMatch(/^[A-Za-z0-9+/]{88}$/);
    expect(stored).not.toContain(SECRET);
    expect(readWebhookSecret(stored, KEY, CONTEXT)).toBe(SECRET);
    expect(
      readWebhookSecret(stored, KEY, {
        accountId: CONTEXT.accountId.toUpperCase(),
        endpointId: CONTEXT.endpointId.toUpperCase(),
      }),
    ).toBe(SECRET);
  });

  it('binds ciphertext to purpose, account and endpoint while sharing one rotation role', () => {
    const stored = encryptWebhookSecret(SECRET, KEY, CONTEXT);
    expect(() =>
      readWebhookSecret(stored, KEY, {
        ...CONTEXT,
        accountId: '10000000-0000-4000-8000-000000000002',
      }),
    ).toThrow();
    expect(() =>
      readWebhookSecret(stored, KEY, {
        ...CONTEXT,
        endpointId: '20000000-0000-4000-8000-000000000002',
      }),
    ).toThrow();
    expect(() =>
      readWebhookSecret(
        forgeAuthenticatedEnvelope(Buffer.from(SECRET), 'driftstack.wrong-purpose'),
        KEY,
        CONTEXT,
      ),
    ).toThrow();

    // Current and previous slots intentionally use this same semantic context,
    // so an atomic current -> previous SQL copy remains readable during grace.
    expect(readWebhookSecret(stored, KEY, CONTEXT)).toBe(SECRET);
  });

  it('rejects cross-row relocation, wrong key and ciphertext tampering', () => {
    const first = encryptWebhookSecret(SECRET, KEY, CONTEXT);
    const secondContext = {
      accountId: CONTEXT.accountId,
      endpointId: '20000000-0000-4000-8000-000000000002',
    };
    const second = encryptWebhookSecret(OTHER_SECRET, KEY, secondContext);
    expect(() => readWebhookSecret(first, KEY, secondContext)).toThrow();
    expect(() => readWebhookSecret(second, KEY, CONTEXT)).toThrow();
    expect(() => readWebhookSecret(first, OTHER_KEY, CONTEXT)).toThrow();

    const last = first.at(-1)!;
    const tampered = `${first.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
    expect(() => readWebhookSecret(tampered, KEY, CONTEXT)).toThrow();
  });

  it('checks canonical fixed bounds before decode and validates authenticated plaintext', () => {
    const stored = encryptWebhookSecret(SECRET, KEY, CONTEXT);
    expect(() => readWebhookSecret(stored.slice(0, -1), KEY, CONTEXT)).toThrow(/fixed canonical/);
    expect(() => readWebhookSecret(`${stored}A`, KEY, CONTEXT)).toThrow(/fixed canonical/);
    expect(() =>
      readWebhookSecret(`${WEBHOOK_SECRET_V2_PREFIX}${'='.repeat(88)}`, KEY, CONTEXT),
    ).toThrow(/fixed canonical/);
    expect(() =>
      readWebhookSecret(forgeAuthenticatedEnvelope(Buffer.from('x'.repeat(38))), KEY, CONTEXT),
    ).toThrow(/must match/);
    expect(() =>
      readWebhookSecret(
        forgeAuthenticatedEnvelope(Buffer.concat([Buffer.from([0xff]), Buffer.alloc(37, 0x61)])),
        KEY,
        CONTEXT,
      ),
    ).toThrow(/exact UTF-8/);
  });

  it('accepts canonical plaintext and v1 only through the bootstrap converter', () => {
    const legacyV1 = `${WEBHOOK_SECRET_V1_PREFIX}${encryptPlatformSecret(SECRET, KEY).toString(
      'base64',
    )}`;
    expect(() => readWebhookSecret(SECRET, KEY, CONTEXT)).toThrow(/not a v2/);
    expect(() => readWebhookSecret(legacyV1, KEY, CONTEXT)).toThrow(/not a v2/);

    for (const legacy of [SECRET, legacyV1]) {
      const converted = convertWebhookSecretToV2(legacy, KEY, CONTEXT);
      expect(converted.startsWith(WEBHOOK_SECRET_V2_PREFIX)).toBe(true);
      expect(readWebhookSecret(converted, KEY, CONTEXT)).toBe(SECRET);
    }

    const alreadyV2 = encryptWebhookSecret(SECRET, KEY, CONTEXT);
    expect(convertWebhookSecretToV2(alreadyV2, KEY, CONTEXT)).toBe(alreadyV2);
  });

  it('rejects invalid keys, contexts, plaintext and unknown envelope versions', () => {
    const invalidKey = Buffer.alloc(8).toString('base64');
    expect(() => encryptWebhookSecret(SECRET, invalidKey, CONTEXT)).toThrow(/32/);
    expect(() => encryptWebhookSecret('whsec_invalid', KEY, CONTEXT)).toThrow(/must match/);
    expect(() =>
      encryptWebhookSecret(SECRET, KEY, { ...CONTEXT, endpointId: 'not-a-uuid' }),
    ).toThrow(/UUID/);
    expect(() =>
      convertWebhookSecretToV2('driftstack:webhook-secret:v3:anything', KEY, CONTEXT),
    ).toThrow(/unknown envelope version/);
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
describe('webhook-secret-encryption — over-long key', () => {
  it('CRITICAL a 48-byte key is refused just as a 16-byte one is. The check is an equality; a floor would accept this and hand node:crypto a key it rejects with "Invalid key length", losing which secret was misconfigured.', () => {
    // base64 STRING, matching the parameter type — a Buffer compiles under
    // vitest and fails `npm run typecheck`, which this repo asserts as a test.
    const LONGKEY = Buffer.alloc(48, 7).toString('base64');
    // A VALID secret and a valid context: the secret-format check and the
    // context both fire earlier, so the key length has to be the only thing
    // wrong or the arm measures a different refusal.
    expect(() => encryptWebhookSecret(SECRET, LONGKEY, CONTEXT)).toThrow(
      /32 bytes|must be 32|AES/i,
    );
  });
});

// The exact-UTF-8 check on the INPUT secret (validatePlaintext). Found by
// mutating every throw in the module and recording which ones no test notices:
// 7 of 10 were covered, and this was the only uncovered one that is actually
// reachable.
//
// The other two zero-red sites are NOT coverage gaps, they are structurally
// unreachable, and both are unreachable for the same reason — the fixed 88-char
// shape check runs first and pins every downstream size:
//
//   "ciphertext is not canonical base64" — 66 bytes encodes to exactly 88 base64
//     chars with no leftover padding bits, so every string passing the shape
//     check round-trips identically. Verified over 200k random 88-char samples:
//     zero non-canonical, zero wrong-length.
//   "plaintext has the wrong authenticated byte length" — the shape check forces
//     a 66-byte blob, so the ciphertext is 66-12-16 = 38 bytes, and AES-GCM
//     preserves length. An authenticated plaintext can only ever be 38 bytes.
//
// Neither can be tested without first disabling the guard above it, so they are
// left alone deliberately rather than pinned with a test that proves nothing.
describe('webhook-secret-encryption — non-round-trippable input secret', () => {
  it('CRITICAL refuses a signing secret that is not exact UTF-8. A lone surrogate encodes to U+FFFD replacement bytes, so the value sealed into the envelope is NOT the value the caller passed — the secret would be stored and dual-signed against a string nobody holds, and every delivery signature would verify for no one.', () => {
    const loneSurrogate = `whsec_${'\uD800'.repeat(32)}`;
    // The premise of the arm, asserted rather than assumed: this string does not
    // survive a UTF-8 round trip.
    expect(Buffer.from(loneSurrogate, 'utf8').toString('utf8')).not.toBe(loneSurrogate);
    expect(() => encryptWebhookSecret(loneSurrogate, KEY, CONTEXT)).toThrow(/not exact UTF-8/);
  });

  // V-1376 — swept the six re-encode canonicality checks in the server by mutation. Four
  // are load-bearing (proxy secrets, LiveKit, TOTP, profile DEKs) and one was completely
  // dark (recipe payloads, V-1375). This one SURVIVES its mutation — replacing
  // `blob.toString('base64') !== payload` with nothing leaves 594 webhook tests green —
  // and that is correct rather than a gap: this envelope is fixed-length, and at this
  // length base64 has no slack bits to respell.
  //
  // 12 (IV) + 16 (tag) + 38 (secret) = 66 bytes, and 66 % 3 === 0, so the encoding is
  // exactly 88 characters with no padding. Every group of 3 bytes maps onto 4 characters
  // with nothing left over, so the shape check one line above — 88 chars, alphabet only,
  // no `=` — already admits only the canonical spelling.
  //
  // The arithmetic is what makes that true, so the arithmetic is what is pinned. Change
  // the secret length to something where the blob is not a multiple of 3 and the tail
  // gains slack bits, the re-encode comparison becomes reachable, and it would then need
  // the deterministic respelling arm that recipe payloads got in V-1375.
  it('CRITICAL the canonicality check is unreachable BY ARITHMETIC, not by omission. It survives mutation because a fixed 88-character encoding of 66 bytes has no slack bits — if that stops being true the check becomes live and untested, so the length relationship is the thing under guard.', () => {
    const IV_BYTES = 12;
    const TAG_BYTES = 16;
    const SECRET_BYTES = 38;
    const blobBytes = IV_BYTES + TAG_BYTES + SECRET_BYTES;

    expect(
      blobBytes % 3,
      'the blob length gained slack bits — the re-encode check is now live',
    ).toBe(0);
    expect(
      Buffer.alloc(blobBytes).toString('base64'),
      'and encodes to the pinned width',
    ).toHaveLength(88);
    expect(
      Buffer.alloc(blobBytes).toString('base64').includes('='),
      'padding means slack, and slack means respellable',
    ).toBe(false);

    // The claim itself, not just its arithmetic: nothing matching the shape check can be
    // non-canonical. A single counter-example here is the whole finding reversed.
    const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    for (let i = 0; i < 2_000; i += 1) {
      const candidate = Array.from(randomBytes(88), (b) => ALPHABET[b & 63]).join('');
      expect(
        Buffer.from(candidate, 'base64').toString('base64'),
        'an 88-character alphabet string that re-encodes differently — the check IS reachable',
      ).toBe(candidate);
    }
  });
});
