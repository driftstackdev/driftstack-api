// Record-bound encryption for immutable saved-recipe payloads. Intent logs can
// contain credentials while transcript snapshots contain customer/model text,
// so each JSONB envelope is authenticated against its owning account, stable
// recipe ID, and semantic column slot. Plaintext arrays and the context-free v1
// envelopes are accepted only by the bounded bootstrap converter.

import { createDecipheriv } from 'node:crypto';
import { AgentIntentSchema, type AgentIntent } from '@driftstack/api-types';
import { z } from 'zod';
import { encryptPlatformSecret } from '../lib/platform-secret-encryption.js';
import type { TranscriptEntry } from './agent-decomposer.js';
import {
  AGENT_TRANSCRIPT_ENVELOPE_KIND,
  parseAgentTranscript,
} from './agent-transcript-encryption.js';

export const RECIPE_INTENT_LOG_ENVELOPE_KIND = 'driftstack.recipe-intent-log' as const;
export const RECIPE_TRANSCRIPT_SNAPSHOT_ENVELOPE_KIND =
  'driftstack.recipe-transcript-snapshot' as const;

const RECIPE_INTENT_LOG_AAD_PURPOSE = 'driftstack.recipe-intent-log.v2';
const RECIPE_TRANSCRIPT_SNAPSHOT_AAD_PURPOSE = 'driftstack.recipe-transcript-snapshot.v2';
const INTENT_LOG_SLOT = 'intent_log';
const TRANSCRIPT_SNAPSHOT_SLOT = 'transcript_snapshot';
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const AES_256_KEY_BYTES = 32;
const MAX_RECIPE_PAYLOAD_PLAINTEXT_BYTES = 64 * 1024 * 1024;
const MIN_RECIPE_PAYLOAD_BLOB_BYTES = GCM_IV_BYTES + GCM_TAG_BYTES + 1;
const MAX_RECIPE_PAYLOAD_BLOB_BYTES =
  GCM_IV_BYTES + GCM_TAG_BYTES + MAX_RECIPE_PAYLOAD_PLAINTEXT_BYTES;
const MAX_RECIPE_PAYLOAD_BASE64_CHARS = Math.ceil(MAX_RECIPE_PAYLOAD_BLOB_BYTES / 3) * 4;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECIPE_ID_RE = /^rec_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i;

export interface RecipePayloadEncryptionContext {
  accountId: string;
  recipeId: string;
}

export interface EncryptedRecipeIntentLog {
  kind: typeof RECIPE_INTENT_LOG_ENVELOPE_KIND;
  version: 2;
  ciphertext: string;
}

export interface EncryptedRecipeTranscriptSnapshot {
  kind: typeof RECIPE_TRANSCRIPT_SNAPSHOT_ENVELOPE_KIND;
  version: 2;
  ciphertext: string;
}

interface LegacyEncryptedRecipeIntentLog {
  kind: typeof RECIPE_INTENT_LOG_ENVELOPE_KIND;
  version: 1;
  ciphertext: string;
}

interface LegacyEncryptedRecipeTranscriptSnapshot {
  kind: typeof AGENT_TRANSCRIPT_ENVELOPE_KIND;
  version: 1;
  ciphertext: string;
}

export type StoredRecipeIntentLog = ReadonlyArray<AgentIntent> | EncryptedRecipeIntentLog;
export type StoredRecipeTranscriptSnapshot =
  ReadonlyArray<TranscriptEntry> | EncryptedRecipeTranscriptSnapshot;

const RecipeIntentLogSchema = z.array(AgentIntentSchema);

function normalizeContext(context: RecipePayloadEncryptionContext): {
  accountId: string;
  recipeId: string;
} {
  if (!UUID_RE.test(context.accountId)) {
    throw new Error('Recipe payload accountId must be a UUID.');
  }
  if (!RECIPE_ID_RE.test(context.recipeId)) {
    throw new Error('Recipe payload recipeId must use rec_<uuid>.');
  }
  return {
    accountId: context.accountId.toLowerCase(),
    recipeId: context.recipeId.toLowerCase(),
  };
}

function buildAdditionalAuthenticatedData(
  purpose: string,
  slot: typeof INTENT_LOG_SLOT | typeof TRANSCRIPT_SNAPSHOT_SLOT,
  context: RecipePayloadEncryptionContext,
): string {
  const normalized = normalizeContext(context);
  return JSON.stringify([purpose, 2, normalized.accountId, normalized.recipeId, slot]);
}

function decodeKey(keyBase64: string): Buffer {
  const key = Buffer.from(keyBase64, 'base64');
  if (key.length !== AES_256_KEY_BYTES) {
    throw new Error(`Recipe payload encryption key must decode to ${AES_256_KEY_BYTES} bytes.`);
  }
  return key;
}

function decodeCiphertextBase64(ciphertext: string): Buffer {
  if (
    ciphertext.length < Math.ceil(MIN_RECIPE_PAYLOAD_BLOB_BYTES / 3) * 4 ||
    ciphertext.length > MAX_RECIPE_PAYLOAD_BASE64_CHARS ||
    ciphertext.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(ciphertext)
  ) {
    throw new Error('Recipe payload ciphertext is outside the canonical bounded base64 shape.');
  }
  const blob = Buffer.from(ciphertext, 'base64');
  if (
    blob.length < MIN_RECIPE_PAYLOAD_BLOB_BYTES ||
    blob.length > MAX_RECIPE_PAYLOAD_BLOB_BYTES ||
    blob.toString('base64') !== ciphertext
  ) {
    throw new Error('Recipe payload ciphertext is not canonical bounded base64.');
  }
  return blob;
}

function decryptJson(
  ciphertext: string,
  keyBase64: string,
  authenticatedContext?: string,
): unknown {
  const blob = decodeCiphertextBase64(ciphertext);
  const iv = blob.subarray(0, GCM_IV_BYTES);
  const tag = blob.subarray(GCM_IV_BYTES, GCM_IV_BYTES + GCM_TAG_BYTES);
  const encrypted = blob.subarray(GCM_IV_BYTES + GCM_TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', decodeKey(keyBase64), iv);
  if (authenticatedContext !== undefined) {
    decipher.setAAD(Buffer.from(authenticatedContext, 'utf8'));
  }
  decipher.setAuthTag(tag);
  const plaintextBytes = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  if (plaintextBytes.length > MAX_RECIPE_PAYLOAD_PLAINTEXT_BYTES) {
    throw new Error('Recipe payload plaintext exceeds the storage bound.');
  }
  const plaintext = plaintextBytes.toString('utf8');
  if (!Buffer.from(plaintext, 'utf8').equals(plaintextBytes)) {
    throw new Error('Recipe payload plaintext is not exact UTF-8.');
  }
  return JSON.parse(plaintext) as unknown;
}

function encryptJson(
  value: unknown,
  encryptionKeyBase64: string,
  authenticatedContext: string,
): string {
  const plaintext = JSON.stringify(value);
  if (Buffer.byteLength(plaintext, 'utf8') > MAX_RECIPE_PAYLOAD_PLAINTEXT_BYTES) {
    throw new Error('Recipe payload plaintext exceeds the storage bound.');
  }
  return encryptPlatformSecret(plaintext, encryptionKeyBase64, authenticatedContext).toString(
    'base64',
  );
}

function hasExactEnvelopeShape(
  value: unknown,
  kind: string,
  version: number,
): value is { kind: string; version: number; ciphertext: string } {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 3 &&
    record.kind === kind &&
    record.version === version &&
    typeof record.ciphertext === 'string' &&
    record.ciphertext.length > 0
  );
}

export function isEncryptedRecipeIntentLog(value: unknown): value is EncryptedRecipeIntentLog {
  return hasExactEnvelopeShape(value, RECIPE_INTENT_LOG_ENVELOPE_KIND, 2);
}

export function isEncryptedRecipeTranscriptSnapshot(
  value: unknown,
): value is EncryptedRecipeTranscriptSnapshot {
  return hasExactEnvelopeShape(value, RECIPE_TRANSCRIPT_SNAPSHOT_ENVELOPE_KIND, 2);
}

function isLegacyEncryptedRecipeIntentLog(value: unknown): value is LegacyEncryptedRecipeIntentLog {
  return hasExactEnvelopeShape(value, RECIPE_INTENT_LOG_ENVELOPE_KIND, 1);
}

function isLegacyEncryptedRecipeTranscriptSnapshot(
  value: unknown,
): value is LegacyEncryptedRecipeTranscriptSnapshot {
  return hasExactEnvelopeShape(value, AGENT_TRANSCRIPT_ENVELOPE_KIND, 1);
}

export function encryptRecipeIntentLog(
  intentLog: ReadonlyArray<AgentIntent>,
  encryptionKeyBase64: string,
  context: RecipePayloadEncryptionContext,
): EncryptedRecipeIntentLog {
  const validated = RecipeIntentLogSchema.parse(intentLog);
  return {
    kind: RECIPE_INTENT_LOG_ENVELOPE_KIND,
    version: 2,
    ciphertext: encryptJson(
      validated,
      encryptionKeyBase64,
      buildAdditionalAuthenticatedData(RECIPE_INTENT_LOG_AAD_PURPOSE, INTENT_LOG_SLOT, context),
    ),
  };
}

/** Strict ordinary reader: plaintext arrays and context-free v1 fail. */
export function readRecipeIntentLog(
  stored: unknown,
  encryptionKeyBase64: string | undefined,
  context: RecipePayloadEncryptionContext,
): ReadonlyArray<AgentIntent> {
  if (!isEncryptedRecipeIntentLog(stored)) {
    throw new Error('Recipe intent-log storage is not a v2 envelope.');
  }
  if (encryptionKeyBase64 === undefined) {
    throw new Error('Recipe payload encryption key is unavailable.');
  }
  return RecipeIntentLogSchema.parse(
    decryptJson(
      stored.ciphertext,
      encryptionKeyBase64,
      buildAdditionalAuthenticatedData(RECIPE_INTENT_LOG_AAD_PURPOSE, INTENT_LOG_SLOT, context),
    ),
  );
}

export function encryptRecipeTranscriptSnapshot(
  transcript: ReadonlyArray<TranscriptEntry>,
  encryptionKeyBase64: string,
  context: RecipePayloadEncryptionContext,
): EncryptedRecipeTranscriptSnapshot {
  const validated = parseAgentTranscript(transcript);
  return {
    kind: RECIPE_TRANSCRIPT_SNAPSHOT_ENVELOPE_KIND,
    version: 2,
    ciphertext: encryptJson(
      validated,
      encryptionKeyBase64,
      buildAdditionalAuthenticatedData(
        RECIPE_TRANSCRIPT_SNAPSHOT_AAD_PURPOSE,
        TRANSCRIPT_SNAPSHOT_SLOT,
        context,
      ),
    ),
  };
}

/** Strict ordinary reader: plaintext arrays and generic transcript v1 fail. */
export function readRecipeTranscriptSnapshot(
  stored: unknown,
  encryptionKeyBase64: string | undefined,
  context: RecipePayloadEncryptionContext,
): ReadonlyArray<TranscriptEntry> {
  if (!isEncryptedRecipeTranscriptSnapshot(stored)) {
    throw new Error('Recipe transcript-snapshot storage is not a v2 envelope.');
  }
  if (encryptionKeyBase64 === undefined) {
    throw new Error('Recipe payload encryption key is unavailable.');
  }
  return parseAgentTranscript(
    decryptJson(
      stored.ciphertext,
      encryptionKeyBase64,
      buildAdditionalAuthenticatedData(
        RECIPE_TRANSCRIPT_SNAPSHOT_AAD_PURPOSE,
        TRANSCRIPT_SNAPSHOT_SLOT,
        context,
      ),
    ),
  );
}

/** Bootstrap-only plaintext/v1 converter; an already-v2 value is authenticated. */
export function convertRecipeIntentLogToV2(
  stored: unknown,
  encryptionKeyBase64: string,
  context: RecipePayloadEncryptionContext,
): EncryptedRecipeIntentLog {
  if (isEncryptedRecipeIntentLog(stored)) {
    readRecipeIntentLog(stored, encryptionKeyBase64, context);
    return stored;
  }
  let value: unknown;
  if (Array.isArray(stored)) {
    value = stored;
  } else if (isLegacyEncryptedRecipeIntentLog(stored)) {
    value = decryptJson(stored.ciphertext, encryptionKeyBase64);
  } else {
    throw new Error('Recipe intent-log legacy storage is malformed.');
  }
  return encryptRecipeIntentLog(RecipeIntentLogSchema.parse(value), encryptionKeyBase64, context);
}

/** Bootstrap-only plaintext/generic-v1 converter; v2 authenticates in place. */
export function convertRecipeTranscriptSnapshotToV2(
  stored: unknown,
  encryptionKeyBase64: string,
  context: RecipePayloadEncryptionContext,
): EncryptedRecipeTranscriptSnapshot {
  if (isEncryptedRecipeTranscriptSnapshot(stored)) {
    readRecipeTranscriptSnapshot(stored, encryptionKeyBase64, context);
    return stored;
  }
  let value: unknown;
  if (Array.isArray(stored)) {
    value = stored;
  } else if (isLegacyEncryptedRecipeTranscriptSnapshot(stored)) {
    value = decryptJson(stored.ciphertext, encryptionKeyBase64);
  } else {
    throw new Error('Recipe transcript-snapshot legacy storage is malformed.');
  }
  return encryptRecipeTranscriptSnapshot(parseAgentTranscript(value), encryptionKeyBase64, context);
}
