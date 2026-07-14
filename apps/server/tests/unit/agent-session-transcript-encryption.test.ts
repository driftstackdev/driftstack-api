import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';
import {
  AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND,
  convertLegacyAgentSessionTranscript,
  encryptAgentSessionTranscript,
  isEncryptedAgentSessionTranscript,
  readAgentSessionTranscript,
} from '../../src/services/agent-session-transcript-encryption.js';
import { encryptAgentTranscript } from '../../src/services/agent-transcript-encryption.js';

const KEY = randomBytes(32).toString('base64');
const CONTEXT = { accountId: 'acc_owner', sessionId: 'agt_session_a' };
const TRANSCRIPT: ReadonlyArray<TranscriptEntry> = [
  {
    at: '2026-07-14T18:00:00.000Z',
    role: 'user',
    body: 'customer-authored private transcript body',
  },
  {
    at: '2026-07-14T18:00:01.000Z',
    role: 'agent',
    body: 'bounded response',
    awaitingConfirmation: true,
    resumeFromIntentIndex: 0,
  },
];

describe('agent-session transcript v2 encryption', () => {
  it('round-trips a purpose/account/session-bound envelope without plaintext', () => {
    const encrypted = encryptAgentSessionTranscript(TRANSCRIPT, KEY, CONTEXT);

    expect(encrypted).toMatchObject({
      kind: AGENT_SESSION_TRANSCRIPT_ENVELOPE_KIND,
      version: 2,
    });
    expect(isEncryptedAgentSessionTranscript(encrypted)).toBe(true);
    expect(JSON.stringify(encrypted)).not.toContain('customer-authored private transcript body');
    expect(readAgentSessionTranscript(encrypted, KEY, CONTEXT)).toEqual(TRANSCRIPT);
  });

  it('rejects row relocation, wrong keys, and ciphertext tampering', () => {
    const encrypted = encryptAgentSessionTranscript(TRANSCRIPT, KEY, CONTEXT);
    expect(() =>
      readAgentSessionTranscript(encrypted, KEY, { ...CONTEXT, accountId: 'acc_other' }),
    ).toThrow();
    expect(() =>
      readAgentSessionTranscript(encrypted, KEY, { ...CONTEXT, sessionId: 'agt_session_b' }),
    ).toThrow();
    expect(() =>
      readAgentSessionTranscript(encrypted, randomBytes(32).toString('base64'), CONTEXT),
    ).toThrow();

    const bytes = Buffer.from(encrypted.ciphertext, 'base64');
    bytes[bytes.length - 1] = (bytes[bytes.length - 1] ?? 0) ^ 1;
    expect(() =>
      readAgentSessionTranscript(
        { ...encrypted, ciphertext: bytes.toString('base64') },
        KEY,
        CONTEXT,
      ),
    ).toThrow();
  });

  it('validates every authenticated context field by UTF-8 bytes', () => {
    expect(() =>
      encryptAgentSessionTranscript(TRANSCRIPT, KEY, { ...CONTEXT, accountId: '' }),
    ).toThrow(/accountId.*1\.\.256 bytes/i);
    expect(() =>
      encryptAgentSessionTranscript(TRANSCRIPT, KEY, { ...CONTEXT, sessionId: '' }),
    ).toThrow(/sessionId.*1\.\.256 bytes/i);
    expect(() =>
      encryptAgentSessionTranscript(TRANSCRIPT, KEY, {
        ...CONTEXT,
        accountId: 'é'.repeat(129),
      }),
    ).toThrow(/got 258/i);
  });

  it('keeps ordinary reads v2-only while bootstrap converts arrays and v1 envelopes', () => {
    const v1 = encryptAgentTranscript(TRANSCRIPT, KEY);

    expect(() => readAgentSessionTranscript(TRANSCRIPT, KEY, CONTEXT)).toThrow(/not a v2/i);
    expect(() => readAgentSessionTranscript(v1, KEY, CONTEXT)).toThrow(/not a v2/i);

    const arrayV2 = convertLegacyAgentSessionTranscript(TRANSCRIPT, KEY, CONTEXT);
    const envelopeV2 = convertLegacyAgentSessionTranscript(v1, KEY, CONTEXT);
    expect(readAgentSessionTranscript(arrayV2, KEY, CONTEXT)).toEqual(TRANSCRIPT);
    expect(readAgentSessionTranscript(envelopeV2, KEY, CONTEXT)).toEqual(TRANSCRIPT);
  });

  it('fails closed for missing keys, malformed envelopes, and cross-purpose objects', () => {
    const encrypted = encryptAgentSessionTranscript(TRANSCRIPT, KEY, CONTEXT);
    expect(() => readAgentSessionTranscript(encrypted, undefined, CONTEXT)).toThrow(
      /key is unavailable/i,
    );
    expect(() => readAgentSessionTranscript({ ...encrypted, version: 1 }, KEY, CONTEXT)).toThrow(
      /not a v2/i,
    );
    expect(() =>
      readAgentSessionTranscript({ ...encrypted, ciphertext: '' }, KEY, CONTEXT),
    ).toThrow(/not a v2/i);
    expect(() =>
      convertLegacyAgentSessionTranscript({ kind: 'unrelated', version: 2 }, KEY, CONTEXT),
    ).toThrow(/malformed/i);
  });
});
