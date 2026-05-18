// LK.2 — AES-256-GCM envelope for per-Mac LiveKit API secrets.
//
// Same envelope as BYOK Anthropic + gui_control_key + MFA TOTP —
// single host-resident MFA_ENCRYPTION_KEY. The reused key is fine
// (single trust boundary; rotating MFA_ENCRYPTION_KEY rotates all
// four secret classes at once).
//
// Storage form: base64(AES-256-GCM([IV(12) | tag(16) | ciphertext]))
// — the fleet_nodes.livekit_api_secret_ciphertext column is TEXT
// (per LK.1 migration; binary not chosen so JSON payloads + log
// dumps stay portable across the existing tooling).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const AES_256_KEY_BYTES = 32;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must decode to ${AES_256_KEY_BYTES.toString()} bytes; got ${key.length.toString()}. ` +
        "Regenerate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

/** Encrypt the per-Mac LiveKit API secret with the shared
 *  MFA_ENCRYPTION_KEY and return a base64-encoded
 *  `[IV | tag | ciphertext]` string suitable for the TEXT column. */
export function encryptLivekitSecret(plaintext: string, keyBase64: string): string {
  if (plaintext.length === 0) {
    throw new Error('LiveKit API secret is empty; refusing to encrypt');
  }
  const key = decodeKey(keyBase64);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]).toString('base64');
}

/** Decrypt a stored base64 `[IV | tag | ciphertext]` blob back to
 *  the plaintext LiveKit API secret. Used at JWT-mint time (LK.3) —
 *  the plaintext never escapes the server process. */
export function decryptLivekitSecret(ciphertextBase64: string, keyBase64: string): string {
  const blob = Buffer.from(ciphertextBase64, 'base64');
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES + 1) {
    throw new Error(
      `LiveKit ciphertext blob is ${blob.length.toString()} bytes; expected at least ` +
        `${(GCM_IV_BYTES + GCM_TAG_BYTES + 1).toString()} (iv + tag + >=1 byte ciphertext)`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const key = decodeKey(keyBase64);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
