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
