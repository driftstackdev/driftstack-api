import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentIntent } from '@driftstack/api-types';
import { describe, expect, it } from 'vitest';
import { intentResultToCustomer } from '../../src/services/agent-intent-result.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const API_TYPES = readFileSync(
  resolve(REPO_ROOT, 'packages/api-types/src/agent-intents.ts'),
  'utf8',
);
const SDK_TYPES = readFileSync(
  resolve(REPO_ROOT, 'packages/sdk-typescript/src/resources/agent-sessions.ts'),
  'utf8',
);
const DOCS = readFileSync(resolve(REPO_ROOT, 'apps/docs/src/pages/api/agent-sessions.md'), 'utf8');

function lostReply(
  errorCode: 'intent_webdriver_failed' | 'intent_dispatch_error',
): ParsedIntentResult {
  return {
    sessionId: 'ses_x',
    intentId: 'int_x',
    success: false,
    durationMs: 12,
    errorCode,
  };
}

const OUTCOME_UNKNOWN_INTENTS: AgentIntent[] = [
  {
    kind: 'navigate',
    url: 'https://id.example.test/oauth/callback?code=consume-once',
  },
  { kind: 'interact', action: 'tap', selector: '#buy' },
  { kind: 'interact', action: 'type', selector: '#email', value: 'a@b.test' },
  { kind: 'interact', action: 'press', value: 'ENTER' },
  { kind: 'interact', action: 'scroll' },
  { kind: 'scroll', direction: 'down', amount_px: 500 },
  { kind: 'behavioral_pause', reading_word_count: 120 },
  { kind: 'behavioral_pause', duration_ms: 1_000 },
];

const AMBIGUOUS_CODES = ['intent_webdriver_failed', 'intent_dispatch_error'] as const;
const OUTCOME_UNKNOWN_CASES = OUTCOME_UNKNOWN_INTENTS.flatMap((intent) =>
  AMBIGUOUS_CODES.map((errorCode) => [intent, errorCode] as const),
);

describe('agent failure diagnosis cross-source invariant', () => {
  it.each(OUTCOME_UNKNOWN_CASES)(
    'executable mapper classifies ambiguous %s / %s as outcome-unknown and non-replayable',
    (intent, errorCode) => {
      const result = intentResultToCustomer(intent, lostReply(errorCode));

      expect(result.kind).toBe('failure');
      if (result.kind !== 'failure') throw new Error('narrow');
      expect(result.diagnosis).toEqual({ category: 'unknown', retryable: false });
      expect(result.reason).toContain(
        'may have taken effect even though its result was not confirmed',
      );
      expect(DOCS).toContain(`"reason": "${result.reason}"`);
      expect(DOCS).toContain('"diagnosis": { "category": "unknown", "retryable": false }');
    },
  );

  it.each(AMBIGUOUS_CODES)('retains read-only capture as the %s retry control', (errorCode) => {
    const result = intentResultToCustomer(
      { kind: 'capture', capture: 'screenshot' },
      lostReply(errorCode),
    );

    expect(result.kind).toBe('failure');
    if (result.kind !== 'failure') throw new Error('narrow');
    expect(result.diagnosis?.retryable).toBe(true);
    expect(result.reason).not.toContain(
      'may have taken effect even though its result was not confirmed',
    );
  });

  it('API types, TypeScript SDK and docs define retryable as automatic-replay safety', () => {
    for (const source of [API_TYPES, SDK_TYPES]) {
      expect(source).toMatch(/automatic(?:ally)?\s*\n?\s*(?:\*\s+)?replay/);
      expect(source).toMatch(/outcome (?:may be|is) unknown/);
      expect(source).toMatch(/state (?:inspection|must be inspected)/);
    }
    expect(DOCS).toContain('means automatic replay of the same step is considered safe');
    expect(DOCS).toContain('never replay automatically');
    expect(DOCS).toMatch(/does not prove that the\s+action succeeded or failed/);
    expect(DOCS).toMatch(
      /applies to `navigate`,\s*\n?\s*`interact`, `scroll`, and `behavioral_pause`/,
    );
    expect(DOCS).toMatch(
      /Read-only\s*\n?\s*`capture` remains eligible for bounded automatic replay/,
    );
  });

  it('forbids the retired element-not-found retry example for ambiguous interact failures', () => {
    expect(DOCS).not.toContain('try a broader selector or wait for it to appear');
    expect(DOCS).not.toContain(
      '"diagnosis": { "category": "element_not_found", "retryable": true }',
    );
  });
});
