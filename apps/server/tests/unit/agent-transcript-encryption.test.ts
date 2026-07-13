import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TRANSCRIPT_ENVELOPE_KIND,
  encryptAgentTranscript,
  readAgentTranscript,
} from '../../src/services/agent-transcript-encryption.js';

const KEY = randomBytes(32).toString('base64');
const transcript = [
  { at: '2026-07-12T00:00:00.000Z', role: 'user' as const, body: 'sign in' },
  {
    at: '2026-07-12T00:00:01.000Z',
    role: 'agent' as const,
    body: 'typed into #password',
    awaitingConfirmation: true,
    intents: [
      {
        kind: 'interact' as const,
        action: 'type' as const,
        selector: '#password',
        value: 'correct horse battery staple',
        sensitive: true,
      },
    ],
  },
];

describe('agent transcript encryption', () => {
  it('round-trips a structured transcript without plaintext in the envelope', () => {
    const encrypted = encryptAgentTranscript(transcript, KEY);
    expect(encrypted.kind).toBe(AGENT_TRANSCRIPT_ENVELOPE_KIND);
    expect(JSON.stringify(encrypted)).not.toContain('correct horse battery staple');
    expect(readAgentTranscript(encrypted, KEY)).toEqual(transcript);
  });

  it('keeps legacy array rows readable for compatibility', () => {
    expect(readAgentTranscript(transcript, undefined)).toEqual(transcript);
  });

  it('fails closed on missing/wrong keys and malformed plaintext', () => {
    const encrypted = encryptAgentTranscript(transcript, KEY);
    expect(() => readAgentTranscript(encrypted, undefined)).toThrow(/key is unavailable/i);
    expect(() => readAgentTranscript(encrypted, randomBytes(32).toString('base64'))).toThrow();
    expect(() => readAgentTranscript({ ciphertext: 'raw' }, KEY)).toThrow(/malformed/i);
    expect(() =>
      readAgentTranscript([{ at: 'x', role: 'intruder', body: 'x' }], undefined),
    ).toThrow();
  });
});
