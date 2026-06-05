// Increment-2 — unit tests for intentResultToCustomer: harness ParsedIntentResult
// → customer IntentResult. Covers per-intent success summaries, the failure-reason
// mapping for all 5 error codes (+ message append/cap), and that the output is a
// valid api-types IntentResult.

import { describe, expect, it } from 'vitest';
import type { AgentIntent } from '@driftstack/api-types';
import { IntentResultSchema } from '@driftstack/api-types';
import { intentResultToCustomer } from '../../src/services/agent-intent-result.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';
import { HARNESS_ERROR_CODES } from '../../src/schemas/harness-control-protocol.js';

function ok(outputData?: unknown): ParsedIntentResult {
  return { sessionId: 'ses_x', intentId: 'int_1', success: true, durationMs: 5, outputData };
}
function fail(
  errorCode: ParsedIntentResult['errorCode'],
  errorMessage?: string,
): ParsedIntentResult {
  return {
    sessionId: 'ses_x',
    intentId: 'int_1',
    success: false,
    durationMs: 0,
    errorCode,
    errorMessage,
  };
}

describe('intentResultToCustomer — success summaries', () => {
  it('navigate uses the returned url', () => {
    const intent: AgentIntent = { kind: 'navigate', url: 'https://example.com' };
    const r = intentResultToCustomer(intent, ok({ url: 'https://example.com/landing' }));
    expect(r).toEqual({
      kind: 'success',
      intent,
      summary: 'navigated to https://example.com/landing',
    });
  });

  it('navigate falls back to generic when outputData has no url', () => {
    const r = intentResultToCustomer({ kind: 'navigate', url: 'https://x' }, ok({}));
    expect(r.kind).toBe('success');
    if (r.kind !== 'success') throw new Error('narrow');
    expect(r.summary).toBe('navigated');
  });

  it('interact tap/type include the selector; scroll/swipe are generic', () => {
    expect(
      (
        intentResultToCustomer({ kind: 'interact', action: 'tap', selector: '#go' }, ok()) as {
          summary: string;
        }
      ).summary,
    ).toBe('tapped #go');
    expect(
      (
        intentResultToCustomer(
          { kind: 'interact', action: 'type', selector: '#email', value: 'a@b' },
          ok(),
        ) as { summary: string }
      ).summary,
    ).toBe('typed into #email');
    expect(
      (intentResultToCustomer({ kind: 'interact', action: 'scroll' }, ok()) as { summary: string })
        .summary,
    ).toBe('scrolled');
  });

  it('wait:selector_visible names the selector; capture variants are descriptive', () => {
    expect(
      (
        intentResultToCustomer(
          { kind: 'wait', condition: 'selector_visible', selector: '.ready' },
          ok(),
        ) as { summary: string }
      ).summary,
    ).toBe('condition met: .ready visible');
    expect(
      (
        intentResultToCustomer({ kind: 'capture', capture: 'screenshot' }, ok()) as {
          summary: string;
        }
      ).summary,
    ).toBe('captured screenshot');
    expect(
      (
        intentResultToCustomer({ kind: 'capture', capture: 'dom_snapshot' }, ok()) as {
          summary: string;
        }
      ).summary,
    ).toBe('captured DOM snapshot');
  });

  it('never sets captureId (capture storage is a separate concern)', () => {
    const r = intentResultToCustomer(
      { kind: 'capture', capture: 'screenshot' },
      ok({ screenshot_b64: 'AAAA' }),
    );
    expect(r.kind).toBe('success');
    if (r.kind !== 'success') throw new Error('narrow');
    expect(r.captureId).toBeUndefined();
  });
});

describe('intentResultToCustomer — failure reasons', () => {
  const intent: AgentIntent = { kind: 'navigate', url: 'https://x' };

  it('maps every harness error code to a non-empty base reason', () => {
    for (const code of HARNESS_ERROR_CODES) {
      const r = intentResultToCustomer(intent, fail(code));
      expect(r.kind).toBe('failure');
      if (r.kind !== 'failure') throw new Error('narrow');
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('appends the harness message when present', () => {
    const r = intentResultToCustomer(intent, fail('intent_missing_parameter', 'url is required'));
    expect(r.kind).toBe('failure');
    if (r.kind !== 'failure') throw new Error('narrow');
    expect(r.reason).toBe('a required parameter was missing: url is required');
  });

  it('caps an over-long harness message', () => {
    const long = 'x'.repeat(500);
    const r = intentResultToCustomer(intent, fail('intent_webdriver_failed', long));
    if (r.kind !== 'failure') throw new Error('narrow');
    expect(r.reason.length).toBeLessThan(250);
    expect(r.reason.endsWith('…')).toBe(true);
  });

  it('handles a failure with no code + no message (defensive)', () => {
    const r = intentResultToCustomer(intent, {
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: false,
      durationMs: 0,
    });
    if (r.kind !== 'failure') throw new Error('narrow');
    expect(r.reason).toBe('the action failed');
  });
});

describe('intentResultToCustomer — output validity', () => {
  it('every produced result validates against the api-types IntentResultSchema', () => {
    const samples: Array<[AgentIntent, ParsedIntentResult]> = [
      [{ kind: 'navigate', url: 'https://x' }, ok({ url: 'https://x' })],
      [{ kind: 'interact', action: 'tap', selector: '#a' }, ok()],
      [{ kind: 'capture', capture: 'screenshot' }, ok()],
      [{ kind: 'navigate', url: 'https://x' }, fail('intent_webdriver_failed', 'no such element')],
    ];
    for (const [intent, parsed] of samples) {
      expect(IntentResultSchema.safeParse(intentResultToCustomer(intent, parsed)).success).toBe(
        true,
      );
    }
  });
});
