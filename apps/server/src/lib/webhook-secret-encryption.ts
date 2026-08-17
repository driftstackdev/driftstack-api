// Record-bound AES-256-GCM envelope for Driftstack outbound-webhook HMAC
// secrets. Ordinary reads accept only v2. The context-free v1 envelope and
// canonical plaintext are retained solely for the bounded bootstrap bridge.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { decryptPlatformSecret } from './platform-secret-encryption.js';
import { AES_256_KEY_BYTES, GCM_IV_BYTES, GCM_TAG_BYTES } from './aes-gcm-parameters.js';
const WEBHOOK_SECRET_UTF8_BYTES = 38;
const WEBHOOK_SECRET_BLOB_BYTES = GCM_IV_BYTES + GCM_TAG_BYTES + WEBHOOK_SECRET_UTF8_BYTES;
const WEBHOOK_SECRET_BASE64_CHARS = 88;
const WEBHOOK_SECRET_AAD_PURPOSE = 'driftstack.outbound-webhook-signing-secret';
const WEBHOOK_SECRET_AAD_ROLE = 'signing-secret';
const WEBHOOK_SECRET_RE = /^whsec_[a-z2-7]{32}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const WEBHOOK_SECRET_V1_PREFIX = 'driftstack:webhook-secret:v1:';
export const WEBHOOK_SECRET_V2_PREFIX = 'driftstack:webhook-secret:v2:';

export interface WebhookSecretEncryptionContext {
  accountId: string;
  endpointId: string;
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `Webhook secret encryption key must decode to ${AES_256_KEY_BYTES.toString()} bytes; ` +
        `got ${key.length.toString()}.`,
    );
  }
  return key;
}

function normalizeUuid(name: 'accountId' | 'endpointId', value: string): string {
  if (!UUID_RE.test(value)) throw new Error(`Webhook secret ${name} must be a UUID.`);
  return value.toLowerCase();
}

function buildAdditionalAuthenticatedData(context: WebhookSecretEncryptionContext): Buffer {
  return Buffer.from(
    JSON.stringify([
      WEBHOOK_SECRET_AAD_PURPOSE,
      2,
      normalizeUuid('accountId', context.accountId),
      normalizeUuid('endpointId', context.endpointId),
      WEBHOOK_SECRET_AAD_ROLE,
    ]),
    'utf8',
  );
}

function validatePlaintext(value: string): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.toString('utf8') !== value) {
    throw new Error('Webhook signing secret is not exact UTF-8.');
  }
  if (bytes.length !== WEBHOOK_SECRET_UTF8_BYTES || !WEBHOOK_SECRET_RE.test(value)) {
    throw new Error('Webhook signing secret must match whsec_<32 lowercase base32 characters>.');
  }
  return value;
}

function decodeCanonicalPayload(payload: string): Buffer {
  if (payload.length !== WEBHOOK_SECRET_BASE64_CHARS || !/^[A-Za-z0-9+/]{88}$/.test(payload)) {
    throw new Error('Webhook secret ciphertext is outside its fixed canonical base64 shape.');
  }
  const blob = Buffer.from(payload, 'base64');
  if (blob.length !== WEBHOOK_SECRET_BLOB_BYTES || blob.toString('base64') !== payload) {
    throw new Error('Webhook secret ciphertext is not canonical base64.');
  }
  return blob;
}

function decryptV2Payload(
  payload: string,
  encryptionKeyBase64: string,
  context: WebhookSecretEncryptionContext,
): string {
  const blob = decodeCanonicalPayload(payload);
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', decodeKey(encryptionKeyBase64), iv);
  decipher.setAAD(buildAdditionalAuthenticatedData(context));
  decipher.setAuthTag(tag);
  const plaintextBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintextBytes.length !== WEBHOOK_SECRET_UTF8_BYTES) {
    throw new Error('Webhook signing secret plaintext has the wrong authenticated byte length.');
  }
  const plaintext = plaintextBytes.toString('utf8');
  if (!Buffer.from(plaintext, 'utf8').equals(plaintextBytes)) {
    throw new Error('Webhook signing secret plaintext is not exact UTF-8.');
  }
  return validatePlaintext(plaintext);
}

/** Encrypt a signing secret for one stable account + endpoint tuple. */
export function encryptWebhookSecret(
  plaintext: string,
  encryptionKeyBase64: string,
  context: WebhookSecretEncryptionContext,
): string {
  const validated = validatePlaintext(plaintext);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', decodeKey(encryptionKeyBase64), iv);
  cipher.setAAD(buildAdditionalAuthenticatedData(context));
  const ciphertext = Buffer.concat([cipher.update(validated, 'utf8'), cipher.final()]);
  const payload = Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  return `${WEBHOOK_SECRET_V2_PREFIX}${payload}`;
}

/** Strict ordinary reader: plaintext and context-free v1 fail closed. */
export function readWebhookSecret(
  stored: string,
  encryptionKeyBase64: string,
  context: WebhookSecretEncryptionContext,
): string {
  if (!stored.startsWith(WEBHOOK_SECRET_V2_PREFIX)) {
    throw new Error('Webhook signing secret storage is not a v2 envelope.');
  }
  return decryptV2Payload(
    stored.slice(WEBHOOK_SECRET_V2_PREFIX.length),
    encryptionKeyBase64,
    context,
  );
}

/**
 * Bootstrap-only bridge. Canonical plaintext and context-free v1 are
 * authenticated/validated, then re-encrypted for the exact record tuple.
 * Existing v2 is authenticated in place for wrong-key/context preflight.
 */
export function convertWebhookSecretToV2(
  stored: string,
  encryptionKeyBase64: string,
  context: WebhookSecretEncryptionContext,
): string {
  if (stored.startsWith(WEBHOOK_SECRET_V2_PREFIX)) {
    readWebhookSecret(stored, encryptionKeyBase64, context);
    return stored;
  }

  let plaintext: string;
  if (stored.startsWith(WEBHOOK_SECRET_V1_PREFIX)) {
    const blob = decodeCanonicalPayload(stored.slice(WEBHOOK_SECRET_V1_PREFIX.length));
    plaintext = decryptPlatformSecret(blob, encryptionKeyBase64);
  } else {
    if (stored.startsWith('driftstack:webhook-secret:')) {
      throw new Error('Webhook signing secret storage has an unknown envelope version.');
    }
    plaintext = stored;
  }
  return encryptWebhookSecret(validatePlaintext(plaintext), encryptionKeyBase64, context);
}
