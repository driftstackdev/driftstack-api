import { describe, expect, it } from 'vitest';
import type { AgentIntent, IntentResult } from '@driftstack/api-types';
import type { TranscriptEntry } from '../../src/services/agent-decomposer.js';
import {
  publicAgentIntent,
  publicIntentResult,
  publicTranscriptEntry,
} from '../../src/services/agent-public-redaction.js';

describe('agent public-boundary redaction', () => {
  it('omits an explicitly sensitive type value without mutating the encrypted-source intent', () => {
    const source: AgentIntent = {
      kind: 'interact',
      action: 'type',
      selector: '#login',
      value: 'correct horse battery staple',
      sensitive: true,
    };

    expect(publicAgentIntent(source)).toEqual({
      kind: 'interact',
      action: 'type',
      selector: '#login',
      sensitive: true,
    });
    expect(source.value).toBe('correct horse battery staple');
  });

  it.each(['#password', '[autocomplete="one-time-code"]', '[name="api_key"]'])(
    'infers sensitivity from selector %s',
    (selector) => {
      expect(
        publicAgentIntent({
          kind: 'interact',
          action: 'type',
          selector,
          value: 'never-public',
        }),
      ).toEqual({ kind: 'interact', action: 'type', selector, sensitive: true });
    },
  );

  it('preserves non-sensitive typing and non-type intents byte-for-byte', () => {
    const ordinary: AgentIntent = {
      kind: 'interact',
      action: 'type',
      selector: '#search',
      value: 'weather tomorrow',
    };
    const navigate: AgentIntent = { kind: 'navigate', url: 'https://example.com/' };

    expect(publicAgentIntent(ordinary)).toBe(ordinary);
    expect(publicAgentIntent(navigate)).toBe(navigate);
  });

  it.each<IntentResult>([
    {
      kind: 'success',
      intent: {
        kind: 'interact',
        action: 'type',
        selector: '#password',
        value: 'success-secret',
      },
      summary: 'typed into #password',
    },
    {
      kind: 'failure',
      intent: {
        kind: 'interact',
        action: 'type',
        selector: '#otp',
        value: 'failure-secret',
      },
      reason: 'dispatch failed',
    },
    {
      kind: 'confirmation_required',
      intent: {
        kind: 'interact',
        action: 'type',
        selector: '#pin',
        value: 'confirmation-secret',
      },
      category: 'payment',
      matchedText: 'pay now',
    },
  ])('redacts the nested intent on $kind results', (result) => {
    if (result.intent.kind !== 'interact') throw new Error('test fixture must be interact');
    const projected = publicIntentResult(result);
    expect(projected.intent).toEqual({
      kind: 'interact',
      action: 'type',
      selector: result.intent.selector,
      sensitive: true,
    });
    expect(result.intent.value).toContain('secret');
  });

  it('redacts transcript intent copies while preserving free text and source replay data', () => {
    const source: TranscriptEntry = {
      at: '2026-07-13T21:47:00.000Z',
      role: 'agent',
      body: 'typed into #password',
      intents: [
        {
          kind: 'interact',
          action: 'type',
          selector: '#password',
          value: 'stored-only',
        },
      ],
    };

    expect(publicTranscriptEntry(source)).toEqual({
      ...source,
      intents: [
        {
          kind: 'interact',
          action: 'type',
          selector: '#password',
          sensitive: true,
        },
      ],
    });
    expect(source.body).toBe('typed into #password');
    const sourceIntent = source.intents?.[0];
    if (sourceIntent?.kind !== 'interact') throw new Error('test fixture must be interact');
    expect(sourceIntent.value).toBe('stored-only');
  });
});
