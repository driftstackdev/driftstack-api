// AI-CHAT BYOK Anthropic — per-customer encrypted key (migration 0041,
// Tier-3 verdicts LOCKED 2026-05-17). New values in
// `accounts.byok_anthropic_api_key_ciphertext` use an explicit v2 byte prefix
// followed by `[12 bytes IV | 16 bytes auth tag | N bytes ciphertext]`.
// AES-GCM AAD binds a dedicated purpose/version and the owning account UUID, so
// a valid customer credential cannot be relocated to another account. The
// prefixless v1 form is accepted only by the bounded bootstrap converter.
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
const BYOK_ANTHROPIC_KEY_AAD_PURPOSE = 'driftstack.byok-anthropic-key';
const BYOK_ANTHROPIC_KEY_BODY_MAX_CHARS = 512;
const BYOK_ANTHROPIC_KEY_MAX_PLAINTEXT_BYTES =
  Buffer.byteLength('sk-ant-', 'utf8') + BYOK_ANTHROPIC_KEY_BODY_MAX_CHARS;
const BYOK_ANTHROPIC_KEY_MIN_PAYLOAD_BYTES = GCM_IV_BYTES + GCM_TAG_BYTES + 1;
const BYOK_ANTHROPIC_KEY_MAX_PAYLOAD_BYTES =
  GCM_IV_BYTES + GCM_TAG_BYTES + BYOK_ANTHROPIC_KEY_MAX_PLAINTEXT_BYTES;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const BYOK_ANTHROPIC_KEY_V2_PREFIX = 'driftstack:byok-anthropic-key:v2:';
const BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES = Buffer.from(BYOK_ANTHROPIC_KEY_V2_PREFIX, 'utf8');

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

function normalizeAccountId(accountId: string): string {
  if (!UUID_RE.test(accountId)) throw new Error('BYOK accountId must be a UUID.');
  return accountId.toLowerCase();
}

function buildAdditionalAuthenticatedData(accountId: string): Buffer {
  return Buffer.from(
    JSON.stringify([BYOK_ANTHROPIC_KEY_AAD_PURPOSE, 2, normalizeAccountId(accountId)]),
    'utf8',
  );
}

function assertPlaintextKey(plaintext: string): Buffer {
  if (!looksLikeAnthropicKey(plaintext)) {
    throw new Error('BYOK plaintext key does not match the bounded sk-ant- storage shape.');
  }
  const bytes = Buffer.from(plaintext, 'utf8');
  if (bytes.length < 1 || bytes.length > BYOK_ANTHROPIC_KEY_MAX_PLAINTEXT_BYTES) {
    throw new Error('BYOK plaintext key exceeds the storage bound.');
  }
  return bytes;
}

function decryptPayload(blob: Buffer, keyBase64: string, aad?: Buffer): BYOKAnthropicKeyPlaintext {
  if (
    blob.length < BYOK_ANTHROPIC_KEY_MIN_PAYLOAD_BYTES ||
    blob.length > BYOK_ANTHROPIC_KEY_MAX_PAYLOAD_BYTES
  ) {
    throw new Error(
      `BYOK ciphertext payload is ${blob.length.toString()} bytes; expected ` +
        `${BYOK_ANTHROPIC_KEY_MIN_PAYLOAD_BYTES.toString()}..${BYOK_ANTHROPIC_KEY_MAX_PAYLOAD_BYTES.toString()} bytes.`,
    );
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const key = decodeKey(keyBase64);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  if (aad !== undefined) decipher.setAAD(aad);
  decipher.setAuthTag(tag);
  const plaintextBytes = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  if (plaintextBytes.length > BYOK_ANTHROPIC_KEY_MAX_PLAINTEXT_BYTES) {
    throw new Error('BYOK plaintext key exceeds the storage bound.');
  }
  const plaintext = plaintextBytes.toString('utf8');
  if (!Buffer.from(plaintext, 'utf8').equals(plaintextBytes)) {
    throw new Error('BYOK plaintext key is not valid UTF-8.');
  }
  assertPlaintextKey(plaintext);
  return plaintext as BYOKAnthropicKeyPlaintext;
}

export function isByokAnthropicKeyV2Envelope(blob: Buffer): boolean {
  return (
    blob.length >= BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES.length &&
    blob
      .subarray(0, BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES.length)
      .equals(BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES)
  );
}

/** AES-256-GCM encrypt the customer's Anthropic API key into the account-bound
 *  v2 byte envelope stored directly in the `bytea` column. */
export function encryptByokAnthropicKey(
  plaintext: string,
  keyBase64: string,
  accountId: string,
): Buffer {
  const plaintextBytes = assertPlaintextKey(plaintext);
  const key = decodeKey(keyBase64);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(buildAdditionalAuthenticatedData(accountId));
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES, iv, tag, ciphertext]);
}

/** Ordinary v2-only reader. The branded return type marks the plaintext for
 *  compile-time leak protection. */
export function decryptByokAnthropicKey(
  blob: Buffer,
  keyBase64: string,
  accountId: string,
): BYOKAnthropicKeyPlaintext {
  if (!isByokAnthropicKeyV2Envelope(blob)) {
    throw new Error('BYOK Anthropic key storage is not a v2 envelope.');
  }
  if (
    blob.length <
      BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES.length + BYOK_ANTHROPIC_KEY_MIN_PAYLOAD_BYTES ||
    blob.length > BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES.length + BYOK_ANTHROPIC_KEY_MAX_PAYLOAD_BYTES
  ) {
    throw new Error(
      `BYOK v2 envelope is ${blob.length.toString()} bytes; outside the bounded storage shape.`,
    );
  }
  return decryptPayload(
    blob.subarray(BYOK_ANTHROPIC_KEY_V2_PREFIX_BYTES.length),
    keyBase64,
    buildAdditionalAuthenticatedData(accountId),
  );
}

/** Bootstrap-only reader for the prefixless, context-free legacy byte envelope. */
export function decryptLegacyByokAnthropicKey(
  blob: Buffer,
  keyBase64: string,
): BYOKAnthropicKeyPlaintext {
  if (isByokAnthropicKeyV2Envelope(blob)) {
    throw new Error('BYOK Anthropic legacy reader refuses a v2 envelope.');
  }
  return decryptPayload(blob, keyBase64);
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
