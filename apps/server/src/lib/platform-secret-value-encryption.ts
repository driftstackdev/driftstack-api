// Name-bound AES-256-GCM envelope for values stored in `platform_secrets`.
// Ordinary reads accept only the explicit v2 byte envelope. The prefixless,
// context-free byte format from migration 0074 is retained solely for the
// bounded synchronous bootstrap converter.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { PlatformSecretPlaintext } from './platform-secret-encryption.js';

const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const PLATFORM_SECRET_VALUE_AAD_PURPOSE = 'driftstack.platform-secret-value';
const PLATFORM_SECRET_VALUE_AAD_ROLE = 'value';
const PLATFORM_SECRET_NAME_RE = /^[a-z0-9](?:[a-z0-9_]{0,62}[a-z0-9])?$/;

export const PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES = 8192;
const PLATFORM_SECRET_VALUE_ENVELOPE_FAMILY_PREFIX = 'driftstack:platform-secret-value:';
export const PLATFORM_SECRET_VALUE_V2_PREFIX = 'driftstack:platform-secret-value:v2:';
const PLATFORM_SECRET_VALUE_ENVELOPE_FAMILY_PREFIX_BYTES = Buffer.from(
  PLATFORM_SECRET_VALUE_ENVELOPE_FAMILY_PREFIX,
  'utf8',
);
const PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES = Buffer.from(PLATFORM_SECRET_VALUE_V2_PREFIX, 'utf8');
const PLATFORM_SECRET_VALUE_MIN_PAYLOAD_BYTES = GCM_IV_BYTES + GCM_TAG_BYTES + 1;
const PLATFORM_SECRET_VALUE_MAX_PAYLOAD_BYTES =
  GCM_IV_BYTES + GCM_TAG_BYTES + PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES;

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `Platform-secret value encryption key must decode to ${AES_256_KEY_BYTES.toString()} bytes; ` +
        `got ${key.length.toString()}.`,
    );
  }
  return key;
}

function normalizeName(name: string): string {
  if (!PLATFORM_SECRET_NAME_RE.test(name)) {
    throw new Error('Platform-secret name must be a lowercase snake_case slug (1-64 chars).');
  }
  return name;
}

function buildAdditionalAuthenticatedData(name: string): Buffer {
  return Buffer.from(
    JSON.stringify([
      PLATFORM_SECRET_VALUE_AAD_PURPOSE,
      2,
      normalizeName(name),
      PLATFORM_SECRET_VALUE_AAD_ROLE,
    ]),
    'utf8',
  );
}

/** True only for a nonempty, exact UTF-8 string within the storage byte cap. */
export function isValidPlatformSecretValue(value: string): boolean {
  const bytes = Buffer.from(value, 'utf8');
  return (
    bytes.length >= 1 &&
    bytes.length <= PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES &&
    bytes.toString('utf8') === value
  );
}

function encodePlaintext(value: string): Buffer {
  if (!isValidPlatformSecretValue(value)) {
    throw new Error(
      `Platform-secret value must be 1-${PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES.toString()} exact UTF-8 bytes.`,
    );
  }
  return Buffer.from(value, 'utf8');
}

function decryptPayload(
  payload: Buffer,
  keyBase64: string,
  additionalAuthenticatedData?: Buffer,
): PlatformSecretPlaintext {
  if (
    payload.length < PLATFORM_SECRET_VALUE_MIN_PAYLOAD_BYTES ||
    payload.length > PLATFORM_SECRET_VALUE_MAX_PAYLOAD_BYTES
  ) {
    throw new Error(
      `Platform-secret ciphertext payload is ${payload.length.toString()} bytes; expected ` +
        `${PLATFORM_SECRET_VALUE_MIN_PAYLOAD_BYTES.toString()}..${PLATFORM_SECRET_VALUE_MAX_PAYLOAD_BYTES.toString()} bytes.`,
    );
  }

  const iv = payload.subarray(0, GCM_IV_BYTES);
  const tag = payload.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = payload.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', decodeKey(keyBase64), iv);
  if (additionalAuthenticatedData !== undefined) {
    decipher.setAAD(additionalAuthenticatedData);
  }
  decipher.setAuthTag(tag);
  const plaintextBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const plaintext = plaintextBytes.toString('utf8');
  if (
    plaintextBytes.length < 1 ||
    plaintextBytes.length > PLATFORM_SECRET_VALUE_MAX_UTF8_BYTES ||
    !Buffer.from(plaintext, 'utf8').equals(plaintextBytes)
  ) {
    throw new Error('Platform-secret plaintext is not within the exact UTF-8 storage bound.');
  }
  return plaintext as PlatformSecretPlaintext;
}

export function isPlatformSecretValueV2Envelope(blob: Buffer): boolean {
  return (
    blob.length >= PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES.length &&
    blob
      .subarray(0, PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES.length)
      .equals(PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES)
  );
}

/** Encrypt one platform-secret value for its stable name. */
export function encryptPlatformSecretValue(
  plaintext: string,
  keyBase64: string,
  name: string,
): Buffer {
  const plaintextBytes = encodePlaintext(plaintext);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', decodeKey(keyBase64), iv);
  cipher.setAAD(buildAdditionalAuthenticatedData(name));
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  return Buffer.concat([
    PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES,
    iv,
    cipher.getAuthTag(),
    ciphertext,
  ]);
}

/** Strict ordinary reader: prefixless legacy storage fails closed. */
export function decryptPlatformSecretValue(
  blob: Buffer,
  keyBase64: string,
  name: string,
): PlatformSecretPlaintext {
  if (!isPlatformSecretValueV2Envelope(blob)) {
    throw new Error('Platform-secret value storage is not a v2 envelope.');
  }
  return decryptPayload(
    blob.subarray(PLATFORM_SECRET_VALUE_V2_PREFIX_BYTES.length),
    keyBase64,
    buildAdditionalAuthenticatedData(name),
  );
}

/**
 * Bootstrap-only bridge from the prefixless, context-free legacy format.
 * Existing v2 values are authenticated in place for wrong-key/name preflight.
 */
export function convertPlatformSecretValueToV2(
  blob: Buffer,
  keyBase64: string,
  name: string,
): Buffer {
  if (isPlatformSecretValueV2Envelope(blob)) {
    decryptPlatformSecretValue(blob, keyBase64, name);
    return blob;
  }
  if (
    blob.length >= PLATFORM_SECRET_VALUE_ENVELOPE_FAMILY_PREFIX_BYTES.length &&
    blob
      .subarray(0, PLATFORM_SECRET_VALUE_ENVELOPE_FAMILY_PREFIX_BYTES.length)
      .equals(PLATFORM_SECRET_VALUE_ENVELOPE_FAMILY_PREFIX_BYTES)
  ) {
    throw new Error('Platform-secret value storage has an unknown envelope version.');
  }
  const plaintext = decryptPayload(blob, keyBase64);
  return encryptPlatformSecretValue(plaintext, keyBase64, name);
}
