// Increment-2 — unit tests for intentResultToCustomer: harness ParsedIntentResult
// → customer IntentResult. Covers per-intent success summaries, the failure-reason
// mapping for all live error codes (+ message append/cap), and that the output is a
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

  it('redacts credentials from a returned redirect URL before customer and transcript boundaries', () => {
    const intent: AgentIntent = { kind: 'navigate', url: 'https://example.com/start' };
    const r = intentResultToCustomer(
      intent,
      ok({
        url: 'https://user:password@example.com/callback?code=AUTH_CODE&keep=ok#access_token=ACCESS_TOKEN',
      }),
    );
    expect(r.kind).toBe('success');
    if (r.kind !== 'success') throw new Error('narrow');
    expect(r.summary).not.toMatch(/password|AUTH_CODE|ACCESS_TOKEN/);
    expect(r.summary).toContain('https://[redacted]@example.com/callback');
    expect(r.summary).toContain('code=[redacted]');
    expect(r.summary).toContain('keep=ok');
    expect(r.summary).toContain('access_token=[redacted]');
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

  it('W140 scroll + behavioral_pause summaries', () => {
    const s = (intent: Parameters<typeof intentResultToCustomer>[0]): string =>
      (intentResultToCustomer(intent, ok()) as { summary: string }).summary;
    expect(s({ kind: 'scroll', direction: 'down', amount_px: 800 })).toBe('scrolled down 800px');
    expect(s({ kind: 'scroll', direction: 'up' })).toBe('scrolled up');
    expect(s({ kind: 'behavioral_pause', reading_word_count: 120 })).toBe(
      'paused to read ~120 words',
    );
    expect(s({ kind: 'behavioral_pause', duration_ms: 2500 })).toBe('paused 2500ms');
    expect(s({ kind: 'behavioral_pause' })).toBe('paused');
  });

  it('W173 scroll surfaces distance_capped from outputData (mirrors capped/timeout_capped)', () => {
    const sum = (intent: Parameters<typeof intentResultToCustomer>[0], out: unknown): string =>
      (intentResultToCustomer(intent, ok(out)) as { summary: string }).summary;
    // clamp engaged → "(capped)" appended (with + without amount_px)
    expect(
      sum({ kind: 'scroll', direction: 'down', amount_px: 99999 }, { distance_capped: true }),
    ).toBe('scrolled down 99999px (capped)');
    expect(sum({ kind: 'scroll', direction: 'up' }, { distance_capped: true })).toBe(
      'scrolled up (capped)',
    );
    // not capped / absent / non-bool → no suffix (forward-compatible default)
    expect(
      sum({ kind: 'scroll', direction: 'down', amount_px: 800 }, { distance_capped: false }),
    ).toBe('scrolled down 800px');
    expect(sum({ kind: 'scroll', direction: 'down', amount_px: 800 }, {})).toBe(
      'scrolled down 800px',
    );
    expect(sum({ kind: 'scroll', direction: 'up' }, { distance_capped: 'yes' })).toBe(
      'scrolled up',
    );
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
    // The appended harness message is capped (MAX_MESSAGE_LEN=200) so it can't
    // bloat the row — the full 500-char string must not survive, and the reason
    // ends in the ellipsis the cap adds. (Total length depends on the — now
    // intent-kind-specialized — base, so assert the message-cap invariant
    // directly rather than a fixed total-length bound.)
    expect(r.reason).not.toContain(long);
    expect(r.reason).not.toContain('x'.repeat(201));
    expect(r.reason.endsWith('…')).toBe(true);
    expect(r.reason.length).toBeLessThan(400);
  });

  it('redacts credential material from harness diagnostics while preserving guidance', () => {
    const r = intentResultToCustomer(
      { kind: 'interact', action: 'tap', selector: '#continue' },
      fail(
        'intent_webdriver_failed',
        'no such element #continue after https://user:hunter2@internal.test/cb?token=LIVE_TOKEN; Authorization: Bearer bearer-live-secret',
      ),
    );
    if (r.kind !== 'failure') throw new Error('narrow');
    expect(r.reason).toContain('no such element #continue');
    expect(r.reason).not.toMatch(/hunter2|LIVE_TOKEN|bearer-live-secret/);
    expect(r.reason).toContain('https://[redacted]@internal.test');
    expect(r.reason).toContain('token=[redacted]');
    expect(r.reason).toContain('Bearer [redacted]');
  });

  it('doc-132 §5.3 — intent_webdriver_failed is specialized by intent kind (actionable "why"), other codes are not', () => {
    // interact → element-not-found guidance
    const interactR = intentResultToCustomer(
      { kind: 'interact', action: 'tap', selector: '#go' },
      fail('intent_webdriver_failed'),
    );
    if (interactR.kind !== 'failure') throw new Error('narrow');
    expect(interactR.reason).toContain('target element');
    expect(interactR.reason).toContain('try a broader selector');

    // navigate → page-load guidance (distinct from interact)
    const navigateR = intentResultToCustomer(
      { kind: 'navigate', url: 'https://x' },
      fail('intent_webdriver_failed'),
    );
    if (navigateR.kind !== 'failure') throw new Error('narrow');
    expect(navigateR.reason).toContain("couldn't load the page");
    expect(navigateR.reason).not.toBe(interactR.reason);

    // wait → condition-never-met guidance
    const waitR = intentResultToCustomer(
      { kind: 'wait', condition: 'selector_visible', selector: '.ready' },
      fail('intent_webdriver_failed'),
    );
    if (waitR.kind !== 'failure') throw new Error('narrow');
    expect(waitR.reason).toContain('wait condition was never met');

    // The appended harness message (naming the exact selector/url) still rides
    // along after the specialized base.
    const withMsg = intentResultToCustomer(
      { kind: 'interact', action: 'tap', selector: '#go' },
      fail('intent_webdriver_failed', 'no such element: #go'),
    );
    if (withMsg.kind !== 'failure') throw new Error('narrow');
    expect(withMsg.reason).toContain('no such element: #go');

    // A NON-webdriver code is unchanged (still its A3-locked base copy).
    const paramR = intentResultToCustomer(
      { kind: 'interact', action: 'tap', selector: '#go' },
      fail('intent_missing_parameter'),
    );
    if (paramR.kind !== 'failure') throw new Error('narrow');
    expect(paramR.reason).toBe('a required parameter was missing');
  });

  it('doc-132 §5.3 slice 2 — every failure carries a structured diagnosis {category, retryable} consistent with the prose reason', () => {
    const cases: Array<[AgentIntent, Parameters<typeof fail>[0], string, boolean]> = [
      [
        { kind: 'interact', action: 'tap', selector: '#a' },
        'intent_webdriver_failed',
        'element_not_found',
        true,
      ],
      [{ kind: 'navigate', url: 'https://x' }, 'intent_webdriver_failed', 'page_load_failed', true],
      [
        { kind: 'wait', condition: 'selector_visible', selector: '.r' },
        'intent_webdriver_failed',
        'condition_not_met',
        true,
      ],
      [
        { kind: 'capture', capture: 'screenshot' },
        'intent_webdriver_failed',
        'capture_failed',
        true,
      ],
      [{ kind: 'scroll', direction: 'down' }, 'intent_webdriver_failed', 'scroll_failed', true],
      [{ kind: 'behavioral_pause' }, 'intent_webdriver_failed', 'unknown', true],
      [
        { kind: 'navigate', url: 'https://x' },
        'intent_session_not_established',
        'session_error',
        true,
      ],
      [{ kind: 'navigate', url: 'https://x' }, 'intent_dispatch_error', 'session_error', true],
      [{ kind: 'navigate', url: 'https://x' }, 'intent_deadline_exceeded', 'session_error', false],
      [
        { kind: 'navigate', url: 'https://x' },
        'intent_deadline_cleanup_unconfirmed',
        'session_error',
        false,
      ],
      [{ kind: 'navigate', url: 'https://x' }, 'session_paused', 'session_error', true],
      [{ kind: 'navigate', url: 'https://x' }, 'session_intent_in_flight', 'session_error', true],
      [
        { kind: 'navigate', url: 'https://x' },
        'intent_missing_parameter',
        'invalid_request',
        false,
      ],
      [
        { kind: 'navigate', url: 'https://x' },
        'intent_invalid_parameter',
        'invalid_request',
        false,
      ],
      [{ kind: 'navigate', url: 'https://x' }, 'intent_not_implemented', 'invalid_request', false],
      [{ kind: 'navigate', url: 'https://x' }, 'intent_script_failed', 'invalid_request', false],
      [{ kind: 'capture', capture: 'dom_snapshot' }, 'result_too_large', 'result_too_large', false],
    ];
    for (const [caseIntent, code, category, retryable] of cases) {
      const r = intentResultToCustomer(caseIntent, fail(code));
      if (r.kind !== 'failure') throw new Error('narrow');
      expect(r.diagnosis).toEqual({ category, retryable });
    }
    // No error code at all → unknown / not retryable (defensive).
    const noCode = intentResultToCustomer(intent, {
      sessionId: 'ses_x',
      intentId: 'int_1',
      success: false,
      durationMs: 0,
    });
    if (noCode.kind !== 'failure') throw new Error('narrow');
    expect(noCode.diagnosis).toEqual({ category: 'unknown', retryable: false });
  });

  it('maps script failures as non-retryable and paused sessions as resume-guided retryable failures', () => {
    const script = intentResultToCustomer(
      { kind: 'navigate', url: 'https://x' },
      fail('intent_script_failed', 'SyntaxError'),
    );
    if (script.kind !== 'failure') throw new Error('narrow');
    expect(script.reason).toContain('script for this action was invalid');
    expect(script.diagnosis).toEqual({ category: 'invalid_request', retryable: false });

    const paused = intentResultToCustomer(
      { kind: 'interact', action: 'tap', selector: '#continue' },
      fail('session_paused'),
    );
    if (paused.kind !== 'failure') throw new Error('narrow');
    expect(paused.reason).toContain('resume it before retrying');
    expect(paused.diagnosis).toEqual({ category: 'session_error', retryable: true });

    const busy = intentResultToCustomer(
      { kind: 'navigate', url: 'https://x' },
      fail('session_intent_in_flight'),
    );
    if (busy.kind !== 'failure') throw new Error('narrow');
    expect(busy.reason).toContain('wait, then retry');
    expect(busy.diagnosis).toEqual({ category: 'session_error', retryable: true });

    const deadline = intentResultToCustomer(
      { kind: 'scroll', direction: 'down' },
      fail('intent_deadline_exceeded'),
    );
    if (deadline.kind !== 'failure') throw new Error('narrow');
    expect(deadline.reason).toContain('start a new session');
    expect(deadline.reason).toContain('do not retry against this session');
    expect(deadline.diagnosis).toEqual({ category: 'session_error', retryable: false });

    const cleanupUnconfirmed = intentResultToCustomer(
      { kind: 'scroll', direction: 'down' },
      fail('intent_deadline_cleanup_unconfirmed'),
    );
    if (cleanupUnconfirmed.kind !== 'failure') throw new Error('narrow');
    expect(cleanupUnconfirmed.reason).toContain('permanently fenced');
    expect(cleanupUnconfirmed.reason).toContain('start a new session');
    expect(cleanupUnconfirmed.reason).toContain('do not retry against this session');
    expect(cleanupUnconfirmed.diagnosis).toEqual({
      category: 'session_error',
      retryable: false,
    });
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
