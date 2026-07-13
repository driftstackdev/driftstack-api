// Application-layer encryption for saved recipe intent logs. Recipes deliberately
// outlive their source agent session, and interact:type intents can contain
// passwords, OTPs, PINs, or card values. The existing JSONB column therefore
// stores a versioned AES-256-GCM envelope rather than the plaintext intent array.

import { AgentIntentSchema, type AgentIntent } from '@driftstack/api-types';
import { z } from 'zod';
import { decryptPlatformSecret, encryptPlatformSecret } from '../lib/platform-secret-encryption.js';

export const RECIPE_INTENT_LOG_ENVELOPE_KIND = 'driftstack.recipe-intent-log' as const;

export interface EncryptedRecipeIntentLog {
  kind: typeof RECIPE_INTENT_LOG_ENVELOPE_KIND;
  version: 1;
  ciphertext: string;
}

export type StoredRecipeIntentLog = ReadonlyArray<AgentIntent> | EncryptedRecipeIntentLog;

const RecipeIntentLogSchema = z.array(AgentIntentSchema);

export function encryptRecipeIntentLog(
  intentLog: ReadonlyArray<AgentIntent>,
  encryptionKeyBase64: string,
): EncryptedRecipeIntentLog {
  return {
    kind: RECIPE_INTENT_LOG_ENVELOPE_KIND,
    version: 1,
    ciphertext: encryptPlatformSecret(JSON.stringify(intentLog), encryptionKeyBase64).toString(
      'base64',
    ),
  };
}

export function readRecipeIntentLog(
  stored: unknown,
  encryptionKeyBase64: string | undefined,
): ReadonlyArray<AgentIntent> {
  if (Array.isArray(stored)) return RecipeIntentLogSchema.parse(stored);
  if (!isEncryptedRecipeIntentLog(stored)) {
    throw new Error('Recipe intent-log storage is malformed.');
  }
  if (encryptionKeyBase64 === undefined) {
    throw new Error('Recipe payload encryption key is unavailable.');
  }
  const plaintext = decryptPlatformSecret(
    Buffer.from(stored.ciphertext, 'base64'),
    encryptionKeyBase64,
  );
  return RecipeIntentLogSchema.parse(JSON.parse(plaintext) as unknown);
}

export function isEncryptedRecipeIntentLog(value: unknown): value is EncryptedRecipeIntentLog {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === RECIPE_INTENT_LOG_ENVELOPE_KIND &&
    record.version === 1 &&
    typeof record.ciphertext === 'string' &&
    record.ciphertext.length > 0
  );
}
