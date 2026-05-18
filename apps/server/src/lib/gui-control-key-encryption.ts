// Arc 2 sub-slice 8.4 (v2-#8 AI chat + manual side-by-side).
//
// Encryption for the auto-minted gui_control_key. Same AES-256-GCM
// scheme + canonical `[IV | tag | ciphertext]` blob as the BYOK
// Anthropic crypto (lib/byok-anthropic-encryption.ts). Re-uses
// MFA_ENCRYPTION_KEY per Q2=C (24h-TTL, MFA-key pattern).
//
// The plaintext format is `gck_<32 base32 chars>` — a 20-byte
// random body prefixed with `gck_` so logs / Sentry breadcrumbs can
// recognise it without leaking. The customer's gui-client uses this
// as a bearer token for the manual-control plane (sub-slice 8.4
// route surfaces it). NOT an API key; scoped to a single
// agent-session and its 24h TTL.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;
const PLAINTEXT_BODY_BYTES = 20;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

/** Compile-time taint marker so the gui-control-key plaintext can't
 *  be assigned to a raw `string` without an explicit cast — matches
 *  the BYOK taint pattern. */
export type GuiControlKeyPlaintext = string & {
  readonly __brand: 'gui-control-key-plaintext';
};

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must decode to ${AES_256_KEY_BYTES} bytes; got ${key.length}.`,
    );
  }
  return key;
}

function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 0x1f];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
  }
  return out;
}

/** Generate a fresh gui_control_key plaintext. Format:
 *  `gck_<32 base32 chars>` (20 bytes encoded). */
export function generateGuiControlKey(): GuiControlKeyPlaintext {
  return `gck_${base32Encode(randomBytes(PLAINTEXT_BODY_BYTES))}` as GuiControlKeyPlaintext;
}

export function encryptGuiControlKey(plaintext: string, keyBase64: string): Buffer {
  if (plaintext.length === 0) {
    throw new Error('gui_control_key plaintext is empty; refusing to encrypt');
  }
  const key = decodeKey(keyBase64);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decryptGuiControlKey(blob: Buffer, keyBase64: string): GuiControlKeyPlaintext {
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES + 1) {
    throw new Error(
      `gui_control_key ciphertext blob is ${blob.length} bytes; expected at least ` +
        `${GCM_IV_BYTES + GCM_TAG_BYTES + 1}`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const key = decodeKey(keyBase64);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return plaintext as GuiControlKeyPlaintext;
}
