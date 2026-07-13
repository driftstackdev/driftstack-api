// Application-layer encryption for agent-session transcripts. The existing
// Postgres column is JSONB, so a versioned ciphertext envelope can replace the
// legacy plaintext array without a table migration or deploy-time lock.

import { AgentIntentSchema } from '@driftstack/api-types';
import { z } from 'zod';
import { decryptPlatformSecret, encryptPlatformSecret } from '../lib/platform-secret-encryption.js';
import type { TranscriptEntry } from './agent-decomposer.js';

export const AGENT_TRANSCRIPT_ENVELOPE_KIND = 'driftstack.agent-transcript' as const;

export interface EncryptedAgentTranscript {
  kind: typeof AGENT_TRANSCRIPT_ENVELOPE_KIND;
  version: 1;
  ciphertext: string;
}

export type StoredAgentTranscript = ReadonlyArray<TranscriptEntry> | EncryptedAgentTranscript;

const TranscriptEntrySchema = z
  .object({
    at: z.string(),
    role: z.enum(['user', 'agent', 'operator']),
    body: z.string(),
    intents: z.array(AgentIntentSchema).optional(),
    awaitingConfirmation: z.boolean().optional(),
    resumeFromIntentIndex: z.number().int().nonnegative().optional(),
  })
  // Preserve additive transcript metadata written by a newer producer instead
  // of making an older reader brick the whole encrypted session.
  .passthrough();
const TranscriptSchema = z.array(TranscriptEntrySchema);

export function encryptAgentTranscript(
  transcript: ReadonlyArray<TranscriptEntry>,
  encryptionKeyBase64: string,
): EncryptedAgentTranscript {
  return {
    kind: AGENT_TRANSCRIPT_ENVELOPE_KIND,
    version: 1,
    ciphertext: encryptPlatformSecret(JSON.stringify(transcript), encryptionKeyBase64).toString(
      'base64',
    ),
  };
}

export function readAgentTranscript(
  stored: unknown,
  encryptionKeyBase64: string | undefined,
): ReadonlyArray<TranscriptEntry> {
  if (Array.isArray(stored)) return TranscriptSchema.parse(stored);
  if (!isEncryptedAgentTranscript(stored)) {
    throw new Error('Agent transcript storage is malformed.');
  }
  if (encryptionKeyBase64 === undefined) {
    throw new Error('Agent transcript encryption key is unavailable.');
  }
  const plaintext = decryptPlatformSecret(
    Buffer.from(stored.ciphertext, 'base64'),
    encryptionKeyBase64,
  );
  return TranscriptSchema.parse(JSON.parse(plaintext) as unknown);
}

export function isEncryptedAgentTranscript(value: unknown): value is EncryptedAgentTranscript {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === AGENT_TRANSCRIPT_ENVELOPE_KIND &&
    record.version === 1 &&
    typeof record.ciphertext === 'string' &&
    record.ciphertext.length > 0
  );
}
