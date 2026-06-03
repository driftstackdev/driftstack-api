// AI-CHAT BYOK Anthropic — per-customer encrypted key (migration 0041,
// Tier-3 verdicts LOCKED 2026-05-17). The bytea column on
// `accounts.byok_anthropic_api_key_ciphertext` stores a single blob
// `[12 bytes IV | 16 bytes auth tag | N bytes ciphertext]` so the GCM
// parameters travel with the ciphertext.
//
// Encryption key: AES-256 via the shared MFA_ENCRYPTION_KEY env var
// (Q1 verdict — reuse for operational simplicity). The same key is
// used by `mfa-totp.ts`; rotating MFA_ENCRYPTION_KEY simultaneously
// rotates both surfaces' ciphertexts.
//
// Plaintext leaves the AgentRuntime exactly once per request — the
// brand type `BYOKAnthropicKeyPlaintext` is the compiler-enforced
// taint marker so log/error/audit paths refuse to receive it without
// an explicit cast (which a code reviewer would catch).

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;

/** Compiler-enforced taint marker for the decrypted BYOK plaintext.
 *  Internal call sites must `as` an explicit cast to assign to a raw
 *  `string` — meant to make log/error/audit paths visibly unsafe in
 *  code review. */
export type BYOKAnthropicKeyPlaintext = string & {
  readonly __brand: 'byok-anthropic-plaintext';
};

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(
      `MFA_ENCRYPTION_KEY must decode to ${AES_256_KEY_BYTES} bytes; got ${key.length}. ` +
        "Generate with: node -e \"console.log(require('crypto').randomBytes(32).toString('base64'))\"",
    );
  }
  return key;
}

/** AES-256-GCM encrypt the customer's Anthropic API key. Returns the
 *  canonical `[IV | tag | ciphertext]` blob that the `bytea` column
 *  stores directly. */
export function encryptByokAnthropicKey(plaintext: string, keyBase64: string): Buffer {
  if (plaintext.length === 0) {
    throw new Error('BYOK plaintext key is empty; refusing to encrypt');
  }
  const key = decodeKey(keyBase64);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

/** AES-256-GCM decrypt the customer's Anthropic API key from the
 *  `bytea` column's `[IV | tag | ciphertext]` blob. The branded
 *  return type marks the plaintext for compile-time leak protection. */
export function decryptByokAnthropicKey(
  blob: Buffer,
  keyBase64: string,
): BYOKAnthropicKeyPlaintext {
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES + 1) {
    throw new Error(
      `BYOK ciphertext blob is ${blob.length} bytes; expected at least ` +
        `${GCM_IV_BYTES + GCM_TAG_BYTES + 1} (iv + tag + >=1 byte ciphertext)`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const key = decodeKey(keyBase64);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  return plaintext as BYOKAnthropicKeyPlaintext;
}

/** Lightweight prefix sanity-check that the customer provided what
 *  looks like an Anthropic key. Used at PUT time before storing —
 *  not a substitute for a real connection test (the POST /test endpoint
 *  fires a small Anthropic call to verify). */
export function looksLikeAnthropicKey(s: string): boolean {
  // Anthropic API keys are documented as `sk-ant-api03-...` (base prefix
  // `sk-ant-`). Allow some forward compatibility for future `apiNN`
  // versions — match `sk-ant-` + 1 to 512 chars. The upper bound rejects an
  // oversized blob (real keys are ~108 chars); without it a customer could PUT
  // a ~1 MB "key" we'd encrypt + store, bounded only by the request bodyLimit.
  return /^sk-ant-[A-Za-z0-9_-]{1,512}$/.test(s);
}
