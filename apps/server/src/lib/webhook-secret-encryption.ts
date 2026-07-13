// Application-layer envelope for outbound-webhook HMAC secrets. The database
// columns remain text so this can roll out without a table rewrite; legacy
// `whsec_...` values stay readable until the bounded bootstrap upgrader replaces
// them with this versioned ciphertext representation.

import { decryptPlatformSecret, encryptPlatformSecret } from './platform-secret-encryption.js';

export const WEBHOOK_SECRET_ENVELOPE_PREFIX = 'driftstack:webhook-secret:v1:';

export function isEncryptedWebhookSecret(stored: string): boolean {
  return stored.startsWith(WEBHOOK_SECRET_ENVELOPE_PREFIX);
}

export function encryptWebhookSecret(plaintext: string, encryptionKeyBase64: string): string {
  return `${WEBHOOK_SECRET_ENVELOPE_PREFIX}${encryptPlatformSecret(
    plaintext,
    encryptionKeyBase64,
  ).toString('base64')}`;
}

export function readWebhookSecret(stored: string, encryptionKeyBase64: string | undefined): string {
  if (!isEncryptedWebhookSecret(stored)) return stored;
  if (encryptionKeyBase64 === undefined) {
    throw new Error('Webhook secret encryption key is unavailable.');
  }
  const encoded = stored.slice(WEBHOOK_SECRET_ENVELOPE_PREFIX.length);
  if (encoded.length === 0) throw new Error('Webhook secret ciphertext is malformed.');
  return decryptPlatformSecret(Buffer.from(encoded, 'base64'), encryptionKeyBase64);
}
