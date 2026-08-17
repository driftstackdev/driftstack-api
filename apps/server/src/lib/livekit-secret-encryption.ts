// LK.2 — AES-256-GCM envelope for per-Mac LiveKit API secrets.
//
// The single host-resident MFA_ENCRYPTION_KEY. The reused key is fine
// (single trust boundary; rotating MFA_ENCRYPTION_KEY rotates all encrypted
// stores together). LiveKit v2 uses a distinct purpose and
// authenticates the owning fleet-node UUID plus the paired API key + SFU URL,
// so a valid ciphertext cannot be moved to another node or credential tuple.
//
// Storage form: driftstack:livekit-api-secret:v2:base64([IV|tag|ciphertext]).
// The fleet_nodes.livekit_api_secret_ciphertext column remains TEXT; the
// explicit prefix makes the no-DDL boot cutover and v2-only runtime reader
// unambiguous.

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { AES_256_KEY_BYTES, GCM_IV_BYTES, GCM_TAG_BYTES } from './aes-gcm-parameters.js';
const MAX_NODE_ID_BYTES = 64;
const MAX_API_KEY_BYTES = 1_024;
const MAX_WS_URL_BYTES = 16_384;
const MAX_API_SECRET_BYTES = 4_096;
const LIVEKIT_SECRET_AAD_PURPOSE = 'driftstack.livekit-api-secret';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const LIVEKIT_SECRET_V2_PREFIX = 'driftstack:livekit-api-secret:v2:';

export interface LivekitSecretContext {
  nodeId: string;
  apiKey: string;
  wsUrl: string;
}

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

function decodeCanonicalBase64(value: string): Buffer {
  const decoded = Buffer.from(value, 'base64');
  if (value.length === 0 || decoded.toString('base64') !== value) {
    throw new Error('LiveKit ciphertext is not canonical base64.');
  }
  return decoded;
}

function assertBoundedUtf8(name: string, value: string, maxBytes: number): void {
  const encoded = Buffer.from(value, 'utf8');
  if (encoded.toString('utf8') !== value) {
    throw new Error(`LiveKit ${name} is not valid Unicode text.`);
  }
  if (encoded.length < 1 || encoded.length > maxBytes) {
    throw new Error(
      `LiveKit ${name} must encode to 1..${maxBytes.toString()} bytes; got ${encoded.length.toString()}.`,
    );
  }
}

function normalizeContext(context: LivekitSecretContext): LivekitSecretContext {
  assertBoundedUtf8('nodeId', context.nodeId, MAX_NODE_ID_BYTES);
  if (!UUID_RE.test(context.nodeId)) {
    throw new Error('LiveKit nodeId must be a UUID.');
  }
  assertBoundedUtf8('apiKey', context.apiKey, MAX_API_KEY_BYTES);
  assertBoundedUtf8('wsUrl', context.wsUrl, MAX_WS_URL_BYTES);
  return { ...context, nodeId: context.nodeId.toLowerCase() };
}

function buildLivekitSecretAad(context: LivekitSecretContext): Buffer {
  const normalized = normalizeContext(context);
  return Buffer.from(
    JSON.stringify([
      LIVEKIT_SECRET_AAD_PURPOSE,
      2,
      normalized.nodeId,
      normalized.apiKey,
      normalized.wsUrl,
    ]),
    'utf8',
  );
}

function assertSecretBytes(plaintext: Buffer): void {
  if (plaintext.length < 1 || plaintext.length > MAX_API_SECRET_BYTES) {
    throw new Error(
      `LiveKit API secret must encode to 1..${MAX_API_SECRET_BYTES.toString()} bytes; got ${plaintext.length.toString()}.`,
    );
  }
}

function decryptPayload(
  payloadBase64: string,
  keyBase64: string,
  additionalAuthenticatedData?: Buffer,
): string {
  const blob = decodeCanonicalBase64(payloadBase64);
  if (blob.length < GCM_IV_BYTES + GCM_TAG_BYTES + 1) {
    throw new Error(
      `LiveKit ciphertext blob is ${blob.length.toString()} bytes; expected at least ` +
        `${(GCM_IV_BYTES + GCM_TAG_BYTES + 1).toString()} (iv + tag + >=1 byte ciphertext)`,
    );
  }
  if (blob.length > GCM_IV_BYTES + GCM_TAG_BYTES + MAX_API_SECRET_BYTES) {
    throw new Error('LiveKit ciphertext exceeds the API-secret storage bound.');
  }
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const ciphertext = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', decodeKey(keyBase64), iv);
  if (additionalAuthenticatedData !== undefined) decipher.setAAD(additionalAuthenticatedData);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  assertSecretBytes(plaintext);
  const decoded = plaintext.toString('utf8');
  if (!Buffer.from(decoded, 'utf8').equals(plaintext)) {
    throw new Error('LiveKit API secret is not valid UTF-8.');
  }
  return decoded;
}

/** Encrypt a LiveKit API secret under its exact fleet-node credential tuple. */
export function encryptLivekitSecret(
  plaintext: string,
  keyBase64: string,
  context: LivekitSecretContext,
): string {
  const plaintextBytes = Buffer.from(plaintext, 'utf8');
  if (plaintextBytes.toString('utf8') !== plaintext) {
    throw new Error('LiveKit API secret is not valid Unicode text.');
  }
  assertSecretBytes(plaintextBytes);
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', decodeKey(keyBase64), iv);
  cipher.setAAD(buildLivekitSecretAad(context));
  const ciphertext = Buffer.concat([cipher.update(plaintextBytes), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${LIVEKIT_SECRET_V2_PREFIX}${Buffer.concat([iv, tag, ciphertext]).toString('base64')}`;
}

/** Runtime v2-only reader used for LiveKit token minting and node dispatch. */
export function decryptLivekitSecret(
  envelope: string,
  keyBase64: string,
  context: LivekitSecretContext,
): string {
  if (!envelope.startsWith(LIVEKIT_SECRET_V2_PREFIX)) {
    throw new Error('LiveKit API secret storage is not a v2 envelope.');
  }
  return decryptPayload(
    envelope.slice(LIVEKIT_SECRET_V2_PREFIX.length),
    keyBase64,
    buildLivekitSecretAad(context),
  );
}

/** Bootstrap-only reader for the context-free legacy base64 envelope. */
export function decryptLegacyLivekitSecret(envelope: string, keyBase64: string): string {
  if (envelope.startsWith(LIVEKIT_SECRET_V2_PREFIX)) {
    throw new Error('LiveKit legacy secret reader refuses a v2 envelope.');
  }
  return decryptPayload(envelope, keyBase64);
}
