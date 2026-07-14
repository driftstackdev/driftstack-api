// Arc 2 sub-slice 8.4 (v2-#8 AI chat + manual side-by-side).
//
// Encryption for the auto-minted gui_control_key. AES-256-GCM uses a
// versioned `[magic | IV | tag | ciphertext]` envelope and canonical
// additional authenticated data (AAD) that binds the ciphertext to its
// purpose, owning account, and one agent-session. Re-uses
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
const MAX_CONTEXT_FIELD_BYTES = 256;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
const GUI_CONTROL_KEY_V2_MAGIC = Buffer.from('DSGCK2', 'ascii');
const GUI_CONTROL_KEY_AAD_PURPOSE = 'driftstack:gui-control-key:v2';

/** The immutable database identity authenticated with each ciphertext. */
export interface GuiControlKeyEncryptionContext {
  accountId: string;
  sessionId: string;
}

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

function buildAdditionalAuthenticatedData(context: GuiControlKeyEncryptionContext): Buffer {
  const { accountId, sessionId } = context;
  for (const [name, value] of [
    ['accountId', accountId],
    ['sessionId', sessionId],
  ] as const) {
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (byteLength === 0 || byteLength > MAX_CONTEXT_FIELD_BYTES) {
      throw new Error(
        `gui_control_key ${name} must encode to 1..${MAX_CONTEXT_FIELD_BYTES} bytes; got ${byteLength}`,
      );
    }
  }
  // JSON's array encoding is canonical for these strings and length-delimits
  // every value through JSON escaping, so concatenation collisions cannot move
  // a ciphertext between account/session pairs.
  return Buffer.from(JSON.stringify([GUI_CONTROL_KEY_AAD_PURPOSE, accountId, sessionId]), 'utf8');
}

/** Generate a fresh gui_control_key plaintext. Format:
 *  `gck_<32 base32 chars>` (20 bytes encoded). */
export function generateGuiControlKey(): GuiControlKeyPlaintext {
  return `gck_${base32Encode(randomBytes(PLAINTEXT_BODY_BYTES))}` as GuiControlKeyPlaintext;
}

export function encryptGuiControlKey(
  plaintext: string,
  keyBase64: string,
  context: GuiControlKeyEncryptionContext,
): Buffer {
  if (plaintext.length === 0) {
    throw new Error('gui_control_key plaintext is empty; refusing to encrypt');
  }
  const key = decodeKey(keyBase64);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(buildAdditionalAuthenticatedData(context));
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([GUI_CONTROL_KEY_V2_MAGIC, iv, tag, ciphertext]);
}

export function decryptGuiControlKey(
  blob: Buffer,
  keyBase64: string,
  context: GuiControlKeyEncryptionContext,
): GuiControlKeyPlaintext {
  const minimumBytes = GUI_CONTROL_KEY_V2_MAGIC.length + GCM_IV_BYTES + GCM_TAG_BYTES + 1;
  if (blob.length < minimumBytes) {
    throw new Error(
      `gui_control_key ciphertext blob is ${blob.length} bytes; expected at least ` +
        `${minimumBytes}`,
    );
  }
  if (!blob.subarray(0, GUI_CONTROL_KEY_V2_MAGIC.length).equals(GUI_CONTROL_KEY_V2_MAGIC)) {
    throw new Error('gui_control_key ciphertext version is unsupported');
  }
  const ivStart = GUI_CONTROL_KEY_V2_MAGIC.length;
  const tagStart = ivStart + GCM_IV_BYTES;
  const ciphertextStart = tagStart + GCM_TAG_BYTES;
  const iv = blob.subarray(ivStart, tagStart);
  const tag = blob.subarray(tagStart, ciphertextStart);
  const ciphertext = blob.subarray(ciphertextStart);
  const key = decodeKey(keyBase64);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(buildAdditionalAuthenticatedData(context));
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return plaintext as GuiControlKeyPlaintext;
}
