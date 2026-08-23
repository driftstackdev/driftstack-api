import { createCipheriv, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  decryptLegacyLivekitSecret,
  decryptLivekitSecret,
  encryptLivekitSecret,
  LIVEKIT_SECRET_V2_PREFIX,
  type LivekitSecretContext,
} from '../../src/lib/livekit-secret-encryption.js';

const CONTEXT: LivekitSecretContext = {
  nodeId: '11111111-1111-4111-8111-111111111111',
  apiKey: 'lk_api_key_a',
  wsUrl: 'wss://node-a.example.test:7880',
};

function makeKey(): string {
  return randomBytes(32).toString('base64');
}

function encryptLegacy(plaintext: string, keyBase64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}

function encryptWithWrongPurpose(
  plaintext: string,
  keyBase64: string,
  context: LivekitSecretContext,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
  cipher.setAAD(
    Buffer.from(
      JSON.stringify([
        'driftstack.some-other-secret',
        2,
        context.nodeId,
        context.apiKey,
        context.wsUrl,
      ]),
      'utf8',
    ),
  );
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `${LIVEKIT_SECRET_V2_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
}

describe('LiveKit API secret record-bound v2 envelope', () => {
  it('round-trips under the exact node credential tuple and emits an explicit v2 prefix', () => {
    const key = makeKey();
    const plaintext = 'lk_secret_test_abc_def_ghi_jkl_mno_pqr_stu_vwx_yz';
    const envelope = encryptLivekitSecret(plaintext, key, CONTEXT);
    expect(envelope).not.toBe(plaintext);
    expect(envelope.startsWith(LIVEKIT_SECRET_V2_PREFIX)).toBe(true);
    expect(decryptLivekitSecret(envelope, key, CONTEXT)).toBe(plaintext);
  });

  it('normalizes UUID case so a Postgres lowercase UUID round-trip keeps the same context', () => {
    const key = makeKey();
    const upper = { ...CONTEXT, nodeId: CONTEXT.nodeId.toUpperCase() };
    const envelope = encryptLivekitSecret('lk_test_xyz', key, upper);
    expect(decryptLivekitSecret(envelope, key, CONTEXT)).toBe('lk_test_xyz');
  });

  it('uses a fresh IV for identical plaintext and context', () => {
    const key = makeKey();
    const a = encryptLivekitSecret('lk_test_xyz', key, CONTEXT);
    const b = encryptLivekitSecret('lk_test_xyz', key, CONTEXT);
    expect(a).not.toBe(b);
    expect(decryptLivekitSecret(a, key, CONTEXT)).toBe('lk_test_xyz');
    expect(decryptLivekitSecret(b, key, CONTEXT)).toBe('lk_test_xyz');
  });

  it.each([
    ['node', { ...CONTEXT, nodeId: '22222222-2222-4222-8222-222222222222' }],
    ['API key', { ...CONTEXT, apiKey: 'lk_api_key_b' }],
    ['WebSocket URL', { ...CONTEXT, wsUrl: 'wss://node-b.example.test:7880' }],
  ])('rejects relocation to a different %s context', (_label, movedContext) => {
    const key = makeKey();
    const envelope = encryptLivekitSecret('lk_test_xyz', key, CONTEXT);
    expect(() => decryptLivekitSecret(envelope, key, movedContext)).toThrow();
  });

  it('rejects an envelope authenticated under a different store purpose', () => {
    const key = makeKey();
    const envelope = encryptWithWrongPurpose('lk_test_xyz', key, CONTEXT);
    expect(() => decryptLivekitSecret(envelope, key, CONTEXT)).toThrow();
  });

  it('rejects wrong keys and ciphertext tampering', () => {
    const key = makeKey();
    const envelope = encryptLivekitSecret('lk_test_xyz', key, CONTEXT);
    expect(() => decryptLivekitSecret(envelope, makeKey(), CONTEXT)).toThrow();

    const payload = Buffer.from(envelope.slice(LIVEKIT_SECRET_V2_PREFIX.length), 'base64');
    payload[payload.length - 1] = payload[payload.length - 1]! ^ 1;
    const tampered = `${LIVEKIT_SECRET_V2_PREFIX}${payload.toString('base64')}`;
    expect(() => decryptLivekitSecret(tampered, key, CONTEXT)).toThrow();
  });

  it('keeps the legacy reader bootstrap-only and the runtime reader v2-only', () => {
    const key = makeKey();
    const legacy = encryptLegacy('lk_legacy_secret', key);
    expect(decryptLegacyLivekitSecret(legacy, key)).toBe('lk_legacy_secret');
    expect(() => decryptLivekitSecret(legacy, key, CONTEXT)).toThrow(/not a v2/);

    const v2 = encryptLivekitSecret('lk_v2_secret', key, CONTEXT);
    expect(() => decryptLegacyLivekitSecret(v2, key)).toThrow(/refuses a v2/);
  });

  it('rejects empty/oversized secrets, malformed contexts, and wrong-length keys', () => {
    const key = makeKey();
    expect(() => encryptLivekitSecret('', key, CONTEXT)).toThrow(/1\.\.4096/);
    expect(() => encryptLivekitSecret('x'.repeat(4097), key, CONTEXT)).toThrow(/1\.\.4096/);
    expect(() => encryptLivekitSecret('secret', key, { ...CONTEXT, nodeId: 'not-a-uuid' })).toThrow(
      /UUID/,
    );
    expect(() => encryptLivekitSecret('secret', key, { ...CONTEXT, apiKey: '' })).toThrow(
      /1\.\.1024/,
    );
    expect(() =>
      encryptLivekitSecret('secret', randomBytes(16).toString('base64'), CONTEXT),
    ).toThrow(/must decode to 32 bytes/);
  });

  it('CRITICAL bounds context fields from ABOVE, not just below', () => {
    // `assertBoundedUtf8` is one compound condition — `< 1 || > maxBytes` — and
    // only its lower half was pinned (the `apiKey: ''` arm above). Deleting
    // `|| encoded.length > maxBytes` left all 22,425 tests green, so the upper
    // bounds on the two context fields that reach the GCM AAD unchecked were
    // enforced by nothing.
    //
    // nodeId is deliberately NOT pinned here: it is bounded at 64 bytes but must
    // also be a UUID, so an over-long nodeId is refused either way and such an
    // arm would pass whether or not the bound exists.
    const key = makeKey();
    const atApiKeyLimit = 'k'.repeat(1024);
    const atWsUrlLimit = `wss://${'u'.repeat(16384 - 6)}`;

    // At the limit the value is legal, and round-tripping proves acceptance is
    // real rather than an error thrown somewhere later.
    for (const context of [
      { ...CONTEXT, apiKey: atApiKeyLimit },
      { ...CONTEXT, wsUrl: atWsUrlLimit },
    ]) {
      expect(decryptLivekitSecret(encryptLivekitSecret('lk_s', key, context), key, context)).toBe(
        'lk_s',
      );
    }

    // One byte past it is refused, and the message names the bound that refused.
    expect(() =>
      encryptLivekitSecret('lk_s', key, { ...CONTEXT, apiKey: `${atApiKeyLimit}x` }),
    ).toThrow(/apiKey must encode to 1\.\.1024 bytes/);
    expect(() =>
      encryptLivekitSecret('lk_s', key, { ...CONTEXT, wsUrl: `${atWsUrlLimit}x` }),
    ).toThrow(/wsUrl must encode to 1\.\.16384 bytes/);

    // The bound counts BYTES, not characters — a multi-byte string at the
    // character limit is over the byte limit, and only an encoded-length check
    // can tell those apart.
    expect(() =>
      encryptLivekitSecret('lk_s', key, { ...CONTEXT, apiKey: 'é'.repeat(513) }),
    ).toThrow(/apiKey must encode to 1\.\.1024 bytes/);
  });

  // V-1378 — four refusals on this envelope were in the never-executed set, and each is
  // the encoding half of a compound guard whose LENGTH half is already pinned. The sibling
  // module makes the case plainly: `webhook-secret-encryption` refuses a lone surrogate
  // because such a value "encodes to U+FFFD replacement bytes, so the value sealed into the
  // envelope is NOT the value the caller passed". A LiveKit API secret stored that way
  // signs room tokens nobody can reproduce, and a node id stored that way authenticates a
  // credential tuple that does not match the row it came from.
  function rawV2Envelope(bytes: Buffer, keyBase64: string, context: LivekitSecretContext): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', Buffer.from(keyBase64, 'base64'), iv);
    cipher.setAAD(
      Buffer.from(
        JSON.stringify([
          'driftstack.livekit-api-secret',
          2,
          context.nodeId.toLowerCase(),
          context.apiKey,
          context.wsUrl,
        ]),
        'utf8',
      ),
    );
    const ciphertext = Buffer.concat([cipher.update(bytes), cipher.final()]);
    return `${LIVEKIT_SECRET_V2_PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64')}`;
  }

  it('CRITICAL a context field that is not valid Unicode is refused, not silently replaced. `assertBoundedUtf8` checks encoding BEFORE length and only the length half was exercised; a lone surrogate in apiKey encodes to U+FFFD, so the AAD would bind a tuple that differs from the row the credential came from and every later decrypt under the real value would fail authentication.', () => {
    const key = makeKey();
    const loneSurrogate = 'lk_api_key_\uD800';
    // The premise, asserted rather than assumed: this does not survive a UTF-8 round trip.
    expect(Buffer.from(loneSurrogate, 'utf8').toString('utf8')).not.toBe(loneSurrogate);

    expect(() =>
      encryptLivekitSecret('secret', key, { ...CONTEXT, apiKey: loneSurrogate }),
    ).toThrow(/apiKey is not valid Unicode text/);
    expect(
      () => encryptLivekitSecret('secret', key, { ...CONTEXT, apiKey: 'lk_ok' }),
      'and a well-formed context of the same shape still encrypts',
    ).not.toThrow();
  });

  it('CRITICAL an API secret that is not valid Unicode is refused on the way IN. Its length passes, so only the encoding check stands between a lone surrogate and an envelope sealed around a value the caller never held — one that would mint LiveKit tokens signed with a secret nobody can reproduce.', () => {
    const key = makeKey();
    const loneSurrogate = 'sec\uDC00ret';
    expect(Buffer.from(loneSurrogate, 'utf8').toString('utf8')).not.toBe(loneSurrogate);

    expect(() => encryptLivekitSecret(loneSurrogate, key, CONTEXT)).toThrow(
      /API secret is not valid Unicode text/,
    );
  });

  it('CRITICAL a stored blob that decrypts to non-UTF-8 bytes is refused on the way OUT. Authentication succeeds — the envelope is genuine — so nothing before this point objects; without it the caller receives a lossy U+FFFD rendering of the secret and signs with it.', () => {
    const key = makeKey();
    // 0xFF is not a valid UTF-8 lead byte. One byte, so the length bound passes and the
    // encoding check is the only thing left.
    const envelope = rawV2Envelope(Buffer.from([0xff]), key, CONTEXT);

    expect(() => decryptLivekitSecret(envelope, key, CONTEXT)).toThrow(
      /API secret is not valid UTF-8/,
    );
    expect(
      decryptLivekitSecret(rawV2Envelope(Buffer.from('ok', 'utf8'), key, CONTEXT), key, CONTEXT),
      'the same construction with valid bytes round-trips, so the refusal is the encoding check',
    ).toBe('ok');
  });

  it('CRITICAL an oversized stored blob is refused BEFORE any decrypt is attempted. The bound is what stops a row of arbitrary size being handed to the cipher; the encrypt path caps the plaintext at 4096 bytes, so this shape can only arrive from storage, which is exactly the case the check exists for.', () => {
    const key = makeKey();
    const oversized = Buffer.concat([
      randomBytes(12),
      randomBytes(16),
      Buffer.alloc(4097, 7), // one byte past MAX_API_SECRET_BYTES
    ]).toString('base64');

    expect(() =>
      decryptLivekitSecret(`${LIVEKIT_SECRET_V2_PREFIX}${oversized}`, key, CONTEXT),
    ).toThrow(/exceeds the API-secret storage bound/);

    const atBound = Buffer.concat([
      randomBytes(12),
      randomBytes(16),
      Buffer.alloc(4096, 7),
    ]).toString('base64');
    expect(
      () => decryptLivekitSecret(`${LIVEKIT_SECRET_V2_PREFIX}${atBound}`, key, CONTEXT),
      'exactly at the bound it must get past the size gate and fail on authentication instead',
    ).toThrow(/Unsupported state or unable to authenticate data|auth/i);
  });

  it('rejects noncanonical base64 and truncated payloads before decryption', () => {
    const key = makeKey();
    const envelope = encryptLivekitSecret('lk_test_xy', key, CONTEXT);
    const payload = envelope.slice(LIVEKIT_SECRET_V2_PREFIX.length);
    expect(payload.endsWith('=')).toBe(true);
    expect(() =>
      decryptLivekitSecret(
        `${LIVEKIT_SECRET_V2_PREFIX}${payload.replace(/=+$/, '')}`,
        key,
        CONTEXT,
      ),
    ).toThrow(/canonical base64/);
    expect(() => decryptLivekitSecret(`${LIVEKIT_SECRET_V2_PREFIX}AAAA`, key, CONTEXT)).toThrow(
      /at least/,
    );
  });
});
