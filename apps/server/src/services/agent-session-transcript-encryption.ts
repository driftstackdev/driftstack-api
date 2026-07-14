// Record-bound encryption for live agent-session transcripts. The v2 JSONB
// envelope is deliberately distinct from the generic v1 transcript envelope
// still used by immutable recipe snapshots: accepting one store's ciphertext
// in the other would erase the purpose boundary this module establishes.

import { decryptPlatformSecret, encryptPlatformSecret } from '../lib/platform-secret-encryption.js';
import type { TranscriptEntry } from './agent-decomposer.js';
import {
  isEncryptedAgentTranscript,
  readAgentTranscript,
  parseAgentTranscript,
} from './agent-transcript-encryption.js';

export const AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND =
  'driftstack.agent-session-transcript' as const;

const AGENT_SESSION_TRANSCRIPT_AAD_PURPOSE = 'driftstack.agent-session-transcript.v2';
const MAX_CONTEXT_FIELD_BYTES = 256;

export interface AgentSessionTranscriptEncryptionContext {
  accountId: string;
  sessionId: string;
}

export interface EncryptedAgentSessionTranscript {
  kind: typeof AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND;
  version: 2;
  ciphertext: string;
}

function buildAdditionalAuthenticatedData(
  context: AgentSessionTranscriptEncryptionContext,
): string {
  const { accountId, sessionId } = context;
  for (const [name, value] of [
    ['accountId', accountId],
    ['sessionId', sessionId],
  ] as const) {
    const byteLength = Buffer.byteLength(value, 'utf8');
    if (byteLength === 0 || byteLength > MAX_CONTEXT_FIELD_BYTES) {
      throw new Error(
        `agent-session transcript ${name} must encode to 1..${MAX_CONTEXT_FIELD_BYTES} bytes; got ${byteLength}`,
      );
    }
  }
  // JSON array encoding is canonical for these strings and length-delimits
  // every value through JSON escaping, so ambiguous concatenations cannot
  // relocate a ciphertext between account/session pairs.
  return JSON.stringify([AGENT_SESSION_TRANSCRIPT_AAD_PURPOSE, accountId, sessionId]);
}

export function isEncryptedAgentSessionTranscript(
  value: unknown,
): value is EncryptedAgentSessionTranscript {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    record.kind === AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND &&
    record.version === 2 &&
    typeof record.ciphertext === 'string' &&
    record.ciphertext.length > 0
  );
}

export function encryptAgentSessionTranscript(
  transcript: ReadonlyArray<TranscriptEntry>,
  encryptionKeyBase64: string,
  context: AgentSessionTranscriptEncryptionContext,
): EncryptedAgentSessionTranscript {
  return {
    kind: AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND,
    version: 2,
    ciphertext: encryptPlatformSecret(
      JSON.stringify(transcript),
      encryptionKeyBase64,
      buildAdditionalAuthenticatedData(context),
    ).toString('base64'),
  };
}

/** Strict ordinary reader: plaintext arrays and generic v1 envelopes fail. */
export function readAgentSessionTranscript(
  stored: unknown,
  encryptionKeyBase64: string | undefined,
  context: AgentSessionTranscriptEncryptionContext,
): ReadonlyArray<TranscriptEntry> {
  if (!isEncryptedAgentSessionTranscript(stored)) {
    throw new Error('Agent-session transcript storage is not a v2 envelope.');
  }
  if (encryptionKeyBase64 === undefined) {
    throw new Error('Agent transcript encryption key is unavailable.');
  }
  const plaintext = decryptPlatformSecret(
    Buffer.from(stored.ciphertext, 'base64'),
    encryptionKeyBase64,
    buildAdditionalAuthenticatedData(context),
  );
  return parseAgentTranscript(JSON.parse(plaintext) as unknown);
}

/**
 * Bootstrap-only converter for plaintext arrays and generic v1 envelopes.
 * Already-v2 rows are authenticated and returned unchanged so a migration
 * probe can verify the configured key/context without rewriting ciphertext.
 */
export function convertLegacyAgentSessionTranscript(
  stored: unknown,
  encryptionKeyBase64: string,
  context: AgentSessionTranscriptEncryptionContext,
): EncryptedAgentSessionTranscript {
  if (isEncryptedAgentSessionTranscript(stored)) {
    readAgentSessionTranscript(stored, encryptionKeyBase64, context);
    return stored;
  }
  if (!Array.isArray(stored) && !isEncryptedAgentTranscript(stored)) {
    throw new Error('Agent-session transcript legacy storage is malformed.');
  }
  return encryptAgentSessionTranscript(
    readAgentTranscript(stored, encryptionKeyBase64),
    encryptionKeyBase64,
    context,
  );
}
