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
