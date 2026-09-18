// P4 — a 404 LOADED, so the step was green.
//
// `NavigateResultSchema` was `{url} | {url, loadedAtTimeout}` with no failure
// variant. A navigation onto the site's own error page therefore succeeded, the
// plan carried on, and the task died three steps later at a selector that was
// never going to exist on an error page — pointing the customer (and anyone
// debugging) at the wrong step entirely.
//
// ⛔ THE HARD CONSTRAINT IS "ADDITIVE ONLY": a device that has never heard of
// `http_status` must behave EXACTLY as it does today. That is not a nice-to-have
// — the field lands in the server before it lands in any device, so for a while
// every real device is the older one. The absent-field arms below are the real
// subject of this file; the 404 arm is the easy half.

import { describe, expect, it } from 'vitest';
import { intentResultToCustomer } from '../../src/services/agent-intent-result.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import { parseIntentResult, encodeWireData } from '../../src/services/harness-control-codec.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://example.test/missing' };

/** Build the result through the REAL wire parser, so a payload the schema would
 *  reject cannot be smuggled into an assertion. */
function navigateResult(outputData: Record<string, unknown>): ParsedIntentResult {
  return parseIntentResult(
    {
      type: 'intentResult',
      sessionId: 'ses_1',
      intentId: 'int_1',
      success: true,
      durationMs: 12,
      outputData: encodeWireData(outputData),
    },
    'navigate',
  );
}

describe('P4 — an error page is not a successful navigation', () => {
  it('a 404 is a FAILURE on the navigate step, not a green step and a mystery later', () => {
    const result = intentResultToCustomer(
      NAV,
      navigateResult({ url: 'https://example.test/missing', http_status: 404 }),
    );
    expect(result.kind).toBe('failure');
    expect(result).toMatchObject({ diagnosis: { category: 'page_load_failed', retryable: false } });
  });

  it('the failure is NOT retryable — the same URL returns the same status', () => {
    const result = intentResultToCustomer(NAV, navigateResult({ url: 'x', http_status: 500 }));
    // Retrying a 500 three times is three round trips to be told the same thing.
    // The page has to change, not the request.
    expect(result).toMatchObject({ diagnosis: { retryable: false } });
  });

  it.each([
    [404, /does not exist/i],
    [410, /does not exist/i],
    [403, /refused to show/i],
    [401, /signing in/i],
    [429, /slow down/i],
    [503, /on their side/i],
    [418, /returned 418/i],
  ])('a %s says what the SITE did, in words a customer can act on', (status, expected) => {
    const result = intentResultToCustomer(NAV, navigateResult({ url: 'x', http_status: status }));
    if (result.kind !== 'failure') throw new Error('type narrow');
    expect(result.reason).toMatch(expected);
    // Customer-facing copy names nothing internal.
    expect(result.reason).not.toMatch(/fleet|node|control plane|harness|observer|vantage/i);
  });

  it('⛔ ADDITIVE: a device that sends NO status behaves exactly as before — success', () => {
    const result = intentResultToCustomer(NAV, navigateResult({ url: 'https://example.test/' }));
    expect(result.kind).toBe('success');
    expect(result).toMatchObject({ summary: 'navigated to https://example.test/' });
  });

  it('⛔ ADDITIVE: the older `loadedAtTimeout` payload is untouched, with its copy intact', () => {
    const result = intentResultToCustomer(
      NAV,
      navigateResult({ url: 'https://example.test/', loadedAtTimeout: true }),
    );
    expect(result.kind).toBe('success');
    expect(result).toMatchObject({
      summary: 'navigated to https://example.test/ (page never finished loading)',
    });
  });

  it('a 2xx or 3xx is not an opinion the mapper acts on', () => {
    for (const status of [200, 204, 301, 399]) {
      const result = intentResultToCustomer(NAV, navigateResult({ url: 'x', http_status: status }));
      expect(result.kind, `status ${String(status)} must stay a success`).toBe('success');
    }
  });

  it('⛔ A MALFORMED STATUS READS AS ABSENT, NEVER AS ZERO. A `??0` fallback would compare below the error floor and assert "fine" about a payload nobody understood', () => {
    // The schema rejects a non-integer status outright — so the defensive read
    // is exercised through a shape the schema does allow to be missing.
    expect(() => navigateResult({ url: 'x', http_status: 'four-oh-four' })).toThrow();
    const absent = intentResultToCustomer(NAV, navigateResult({ url: 'x' }));
    expect(absent.kind).toBe('success');
  });

  // ⛔ THIS PAIR REPLACES AN ARM THAT COULD NOT FAIL. It was titled "the same
  // field on another verb changes nothing" and its payload carried no
  // `http_status` at all, so deleting the `intent.kind !== 'navigate'` guard in
  // navigateErrorStatus left it green — it pinned nothing. The honest statement
  // is in two halves: an ordinary non-navigate result is untouched, AND the
  // reason another verb cannot smuggle a status in is that no other result
  // schema accepts the field. The kind guard is the belt to that braces.
  it('an ordinary non-navigate result is untouched by any of this', () => {
    const click: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go' };
    const parsed = parseIntentResult(
      {
        type: 'intentResult',
        sessionId: 'ses_1',
        intentId: 'int_1',
        success: true,
        durationMs: 3,
        outputData: encodeWireData({ clicked: '#go', behavioral: true, activated: true }),
      },
      'click',
    );
    expect(intentResultToCustomer(click, parsed).kind).toBe('success');
  });

  it('⛔ AND NO OTHER VERB CAN CARRY A STATUS AT ALL — the result schemas are strict', () => {
    // The moment a second result schema accepts `http_status`, a status starts
    // reaching a code path that was never asked to interpret one, and this arm
    // fails to say so. That is the point: the field's meaning is scoped to a
    // navigation, and the scope is enforced by the wire contract, not by hope.
    const withStatus = {
      type: 'intentResult' as const,
      sessionId: 'ses_1',
      intentId: 'int_1',
      success: true as const,
      durationMs: 3,
    };
    expect(() =>
      parseIntentResult(
        {
          ...withStatus,
          outputData: encodeWireData({
            clicked: '#go',
            behavioral: true,
            activated: true,
            http_status: 404,
          }),
        },
        'click',
      ),
    ).toThrow();
    // And the navigate schema is the one that does accept it, so the assertion
    // above is about strictness rather than about an unrelated parse failure.
    expect(() =>
      parseIntentResult(
        {
          ...withStatus,
          outputData: encodeWireData({ url: 'https://example.test/', http_status: 404 }),
        },
        'navigate',
      ),
    ).not.toThrow();
  });
});
