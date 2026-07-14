// Admin-cockpit secrets Phase A (founder-locked decision 3, 2026-06-04) —
// encryption-at-rest for the `platform_secrets` table (migration 0074).
//
// Mirrors the BYOK pattern exactly (byok-anthropic-encryption.ts): the bytea
// column stores a single blob `[12 bytes IV | 16 bytes auth tag | N bytes
// ciphertext]` so the GCM parameters travel with the ciphertext, AES-256-GCM
// under the shared MFA_ENCRYPTION_KEY env var (the same Q1-verdict reuse the
// BYOK surface made — rotating MFA_ENCRYPTION_KEY rotates all three surfaces'
// ciphertexts together).
//
// The brand type `PlatformSecretPlaintext` is the compiler-enforced taint
// marker so log/error/audit paths refuse to receive a decrypted secret without
// an explicit cast (which a code reviewer would catch). Reveal paths must keep
// the plaintext's lifetime as short as possible.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;

/** Compiler-enforced taint marker for a decrypted platform secret. */
export type PlatformSecretPlaintext = string & {
  readonly __brand: 'platform-secret-plaintext';
};

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `platform-secret encryption key must be ${AES_256_KEY_BYTES} bytes (got ${key.length}); ` +
        'set MFA_ENCRYPTION_KEY to a base64-encoded 32-byte value',
    );
  }
  return key;
}

function encodeAuthenticatedContext(context: string | undefined): Buffer | undefined {
  if (context === undefined) return undefined;
  if (context.length === 0) {
    throw new Error('platform-secret authenticated context is empty; refusing to continue');
  }
  return Buffer.from(context, 'utf8');
}

/** Encrypt a platform secret for at-rest storage. Returns the single
 *  `[IV | tag | ciphertext]` blob for the bytea column. */
export function encryptPlatformSecret(
  plaintext: string,
  keyBase64: string,
  authenticatedContext?: string,
): Buffer {
  if (plaintext.length === 0) {
    throw new Error('platform-secret plaintext is empty; refusing to encrypt');
  }
  const key = decodeKey(keyBase64);
  const context = encodeAuthenticatedContext(authenticatedContext);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  if (context !== undefined) cipher.setAAD(context);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/** Decrypt a stored platform-secret blob. Throws on tampered/garbled input
 *  (GCM auth failure) or a wrong key. */
export function decryptPlatformSecret(
  blob: Buffer,
  keyBase64: string,
  authenticatedContext?: string,
): PlatformSecretPlaintext {
  const key = decodeKey(keyBase64);
  const context = encodeAuthenticatedContext(authenticatedContext);
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES + 1) {
    throw new Error(
      'platform-secret blob too short to contain IV + auth tag + >=1 ciphertext byte',
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (context !== undefined) decipher.setAAD(context);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8') as PlatformSecretPlaintext;
}
