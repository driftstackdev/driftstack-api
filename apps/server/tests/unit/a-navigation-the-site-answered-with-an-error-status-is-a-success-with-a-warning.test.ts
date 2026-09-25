// P4 — a navigation the site answered with 400 or above is a SUCCESS that says
// so, not a failure.
//
// The status is a fact about the document that loaded. Whether it is fatal is
// not knowable when the navigate returns:
//   · a verification interstitial (a "check you are a person" page, a
//     press-and-hold) is served as 403 or 503, and the customer can complete
//     it — failing the step ended a task a pause and a resume would have
//     carried;
//   · a single-page app served through a 404/403 error document renders the
//     whole app under that status.
// So the step stays green, its summary SAYS what the site answered, and a
// machine-readable `warning` carries the number for a program — and for the
// planner, which reads the step line and decides whether to go on, re-plan or
// ask.
//
// What does NOT change: a load that ERRORED (`intent_page_load_failed`) is still
// a retryable failure, a status under 400 is nothing to report, and a device
// that sends no status is exactly the device it was before.

import { describe, expect, it } from 'vitest';
import { IntentResultSchema } from '@driftstack/api-types';
import { intentResultToCustomer } from '../../src/services/agent-intent-result.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import type { ExecutorRunResult, IntentResult } from '../../src/services/agent-executor.js';
import { describeStepsSoFar } from '../../src/services/agent-runtime.js';
import {
  encodeWireData,
  parseIntentResult,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';

const URL = 'https://example.test/account';
const NAV: AgentIntent = { kind: 'navigate', url: URL };
const SUMMARY_BUDGET = 512;

/** Built through the REAL wire parser, so no payload the schema would reject
 *  reaches an assertion. */
function navigated(outputData: Record<string, unknown>): ParsedIntentResult {
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

function success(result: IntentResult): Extract<IntentResult, { kind: 'success' }> {
  if (result.kind !== 'success') {
    throw new Error(`expected a success, got ${JSON.stringify(result).slice(0, 300)}`);
  }
  return result;
}

/** The words that name the status, as they end a summary. */
function statusWords(result: Extract<IntentResult, { kind: 'success' }>): string {
  const at = result.summary.indexOf(' — the site answered ');
  if (at === -1) throw new Error(`no status words in ${JSON.stringify(result.summary)}`);
  return result.summary.slice(at);
}

describe('P4 — a navigation the site answered with an error status is a success with a warning', () => {
  it.each([403, 404, 429, 503])(
    'a %s is a SUCCESS carrying the status as a warning AND in its words',
    (status) => {
      const result = success(
        intentResultToCustomer(NAV, navigated({ url: URL, http_status: status })),
      );
      expect(result.warning).toEqual({ kind: 'http_error_status', status });
      expect(
        result.summary.startsWith(`navigated to ${URL} — the site answered ${String(status)} `),
      ).toBe(true);
    },
  );

  it.each([
    [404, /\(this address may not exist\)$/],
    [410, /\(this address may not exist\)$/],
    [401, /sign in/],
    [403, /sign-in or a verification step/],
    [429, /fewer requests/],
    [503, /busy, or showing a verification step/],
    [500, /a problem on its side/],
    [502, /a problem on its side/],
  ])('a %s says what the SITE answered, neutrally', (status, expected) => {
    const result = success(
      intentResultToCustomer(NAV, navigated({ url: URL, http_status: status })),
    );
    expect(statusWords(result)).toMatch(expected);
  });

  it('a status with no band of its own is named and nothing more is claimed', () => {
    const result = success(intentResultToCustomer(NAV, navigated({ url: URL, http_status: 418 })));
    expect(result.summary).toBe(`navigated to ${URL} — the site answered 418`);
  });

  it('⛔ a 403 or a 503 never says the page cannot be used — it may be a verification step the customer can complete', () => {
    for (const status of [403, 503]) {
      const words = statusWords(
        success(intentResultToCustomer(NAV, navigated({ url: URL, http_status: status }))),
      );
      expect(words, `status ${String(status)}`).not.toMatch(
        /refus|unusable|cannot|can't|fail|error|block|denied|does not exist/i,
      );
      expect(words, `status ${String(status)}`).toMatch(/verification step/);
    }
  });

  it('customer copy names nothing internal, for every status the site can answer', () => {
    for (let status = 400; status <= 599; status += 1) {
      const result = success(
        intentResultToCustomer(NAV, navigated({ url: URL, http_status: status })),
      );
      expect(result.summary, `status ${String(status)}`).not.toMatch(
        /fleet|\bnode\b|harness|control plane|observer|vantage|interpose|macworker|undetectable|device/i,
      );
    }
  });

  it('⛔ a long URL loses its own tail, never the status words', () => {
    const long = `https://example.test/${'a'.repeat(3_000)}`;
    const result = success(
      intentResultToCustomer(
        { kind: 'navigate', url: long },
        navigated({ url: long, http_status: 404 }),
      ),
    );
    expect(result.summary.length).toBeLessThanOrEqual(SUMMARY_BUDGET);
    expect(result.summary.startsWith('navigated to https://example.test/aaaa')).toBe(true);
    expect(result.summary.endsWith(' — the site answered 404 (this address may not exist)')).toBe(
      true,
    );
  });

  it('⛔ a page that never finished loading AND answered 503 keeps BOTH notes, inside the summary budget', () => {
    const long = `https://example.test/${'b'.repeat(3_000)}`;
    const result = success(
      intentResultToCustomer(
        { kind: 'navigate', url: long },
        navigated({ url: long, loadedAtTimeout: true, http_status: 503 }),
      ),
    );
    expect(result.summary.length).toBeLessThanOrEqual(SUMMARY_BUDGET);
    expect(result.summary).toMatch(
      / \(page never finished loading\) — the site answered 503 \(it may be busy, or showing a verification step\)$/,
    );
    expect(result.warning).toEqual({ kind: 'http_error_status', status: 503 });
  });

  it('both notes on a short URL read as one sentence', () => {
    const result = success(
      intentResultToCustomer(NAV, navigated({ url: URL, loadedAtTimeout: true, http_status: 404 })),
    );
    expect(result.summary).toBe(
      `navigated to ${URL} (page never finished loading) — the site answered 404 (this address may not exist)`,
    );
  });

  it('UNCHANGED: a load that ERRORED is still a failure, and still worth retrying', () => {
    const result = intentResultToCustomer(NAV, {
      sessionId: 'ses_1',
      intentId: 'int_1',
      success: false,
      durationMs: 12,
      errorCode: 'intent_page_load_failed',
    });
    expect(result.kind).toBe('failure');
    expect(result).toMatchObject({ diagnosis: { category: 'page_load_failed', retryable: true } });
    expect(result).not.toHaveProperty('warning');
  });

  it('UNCHANGED: a 200 has nothing to report — no warning, no status words', () => {
    const result = success(intentResultToCustomer(NAV, navigated({ url: URL, http_status: 200 })));
    expect(result).not.toHaveProperty('warning');
    expect(result.summary).toBe(`navigated to ${URL}`);
  });

  it('UNCHANGED: any status under 400 has nothing to report', () => {
    for (const status of [204, 301, 399]) {
      const result = success(
        intentResultToCustomer(NAV, navigated({ url: URL, http_status: status })),
      );
      expect(result, `status ${String(status)}`).not.toHaveProperty('warning');
      expect(result.summary).toBe(`navigated to ${URL}`);
    }
  });

  it('UNCHANGED: a device that sends no status has no opinion — no warning', () => {
    const result = success(intentResultToCustomer(NAV, navigated({ url: URL })));
    expect(result).not.toHaveProperty('warning');
    expect(result.summary).toBe(`navigated to ${URL}`);
  });

  it('the published result type KEEPS the warning — a schema that stripped it would hide it from every customer', () => {
    const result = success(intentResultToCustomer(NAV, navigated({ url: URL, http_status: 403 })));
    expect(IntentResultSchema.parse(result)).toEqual(result);
  });

  it('a warning kind newer than the reader still parses, so a program built today survives the next one', () => {
    const newer = {
      kind: 'success',
      intent: NAV,
      summary: 'navigated',
      warning: { kind: 'something_added_later' },
    };
    expect(IntentResultSchema.safeParse(newer).success).toBe(true);
  });

  it('⛔ THE PLANNER IS SHOWN THE STATUS: the step line it reads keeps the status words, even for a long URL', () => {
    const long = `https://example.test/${'c'.repeat(3_000)}`;
    const warned = intentResultToCustomer(
      { kind: 'navigate', url: long },
      navigated({ url: long, http_status: 404 }),
    );
    const run: ExecutorRunResult = { results: [warned], ok: true };
    const [line] = describeStepsSoFar(run);
    expect(line).toBeDefined();
    expect(line?.startsWith('✓ navigated to https://example.test/cccc')).toBe(true);
    expect(line?.endsWith(' — the site answered 404 (this address may not exist)')).toBe(true);
    expect((line ?? '').length).toBeLessThanOrEqual(241);
  });

  it('⛔ every status note, with the never-finished note beside it, reaches the planner WHOLE', () => {
    const long = `https://example.test/${'d'.repeat(3_000)}`;
    for (let status = 400; status <= 599; status += 1) {
      const warned = success(
        intentResultToCustomer(
          { kind: 'navigate', url: long },
          navigated({ url: long, loadedAtTimeout: true, http_status: status }),
        ),
      );
      const tail = warned.summary.slice(warned.summary.indexOf(' (page never finished loading)'));
      const [line] = describeStepsSoFar({ results: [warned], ok: true });
      expect(line?.endsWith(tail), `status ${String(status)}: ${line ?? ''}`).toBe(true);
    }
  });

  it('a short step line reaches the planner exactly as the transcript carries it', () => {
    const warned = intentResultToCustomer(NAV, navigated({ url: URL, http_status: 429 }));
    expect(describeStepsSoFar({ results: [warned], ok: true })).toEqual([
      `✓ navigated to ${URL} — the site answered 429 (it is asking for fewer requests right now)`,
    ]);
  });
});
