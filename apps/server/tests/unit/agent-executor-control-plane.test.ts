// Increment-2 — unit tests for ControlPlaneAgentExecutor: the plan runner that
// chains mapper → serialize → dispatcher → result-mapper, halting on the first
// failure. Uses a mock IntentDispatcher (the correlator is tested separately).

import { describe, expect, it } from 'vitest';
import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { ExecuteArgs } from '../../src/services/agent-executor.js';
import {
  decodeWireData,
  type ParsedIntentResult,
} from '../../src/services/harness-control-codec.js';
import type { AgentIntent } from '@driftstack/api-types';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

function planArgs(intents: AgentIntent[], sessionId = 'ses_x'): ExecuteArgs {
  return { sessionId, plan: { kind: 'plan', intents, tokensConsumed: 0 } };
}

function okResult(intentId: string, sessionId = 'ses_x', outputData?: unknown): ParsedIntentResult {
  return { sessionId, intentId, success: true, durationMs: 1, outputData };
}
function failResult(
  intentId: string,
  errorCode: ParsedIntentResult['errorCode'],
  sessionId = 'ses_x',
): ParsedIntentResult {
  return { sessionId, intentId, success: false, durationMs: 0, errorCode };
}

/** Mock dispatcher: records dispatches, returns results via a per-call fn. */
function mockDispatcher(respond: (d: IntentDispatch, index: number) => ParsedIntentResult): {
  got: IntentDispatch[];
  dispatcher: IntentDispatcher;
} {
  const got: IntentDispatch[] = [];
  return {
    got,
    dispatcher: {
      dispatch: (d) => {
        const i = got.length;
        got.push(d);
        return Promise.resolve(respond(d, i));
      },
    },
  };
}

// Deterministic intentId generator for assertions.
function seqIds(): () => string {
  let n = 0;
  return () => `int_${++n}`;
}

describe('ControlPlaneAgentExecutor', () => {
  it('runs an all-success plan → every result success, ok:true', async () => {
    const { got, dispatcher } = mockDispatcher((d) =>
      okResult(d.intentId, d.sessionId, { url: 'https://x' }),
    );
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(
      planArgs([
        { kind: 'navigate', url: 'https://x' },
        { kind: 'interact', action: 'tap', selector: '#go' },
        { kind: 'capture', capture: 'screenshot' },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(3);
    expect(res.results.every((r) => r.kind === 'success')).toBe(true);
    // Dispatched the 3 mapped intents in order with the right intentNames.
    expect(got.map((d) => d.intentName)).toEqual(['navigate', 'click', 'screenshot']);
    expect(got.map((d) => d.sessionId)).toEqual(['ses_x', 'ses_x', 'ses_x']);
    // Params are base64-encoded on the wire.
    expect(decodeWireData(got[0]!.inputParams)).toEqual({ url: 'https://x' });
    expect(decodeWireData(got[1]!.inputParams)).toEqual({ strategy: 'css selector', value: '#go' });
  });

  it('#139 dispatches on the AGENT session id (agentSessionId), NOT the driftstack sessionId', async () => {
    // The fleet routing dispatcher resolves agent_sessions.node_id by the AGENT
    // session id. A pure /v1/agent-sessions run has driftstackSessionId=null →
    // sessionId arrives as "unattached"; the executor MUST dispatch on
    // agentSessionId so the node resolves. Regression guard for the live bug where
    // every dispatch stranded as "no automation device is running this session".
    const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId, d.sessionId));
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute({
      sessionId: 'unattached',
      agentSessionId: 'agt_real_id',
      plan: { kind: 'plan', intents: [{ kind: 'navigate', url: 'https://x' }], tokensConsumed: 0 },
    });
    expect(res.ok).toBe(true);
    expect(got).toHaveLength(1);
    expect(got[0]!.sessionId).toBe('agt_real_id'); // NOT 'unattached'
  });

  it('halts on the first dispatch failure (later intents not dispatched)', async () => {
    const { got, dispatcher } = mockDispatcher((d, i) =>
      i === 1 ? failResult(d.intentId, 'intent_webdriver_failed') : okResult(d.intentId),
    );
    // maxRetries:0 — this test isolates halt-on-failure; auto-retry is covered
    // in its own describe block below.
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { maxRetries: 0 });
    const res = await exec.execute(
      planArgs([
        { kind: 'navigate', url: 'https://x' },
        { kind: 'interact', action: 'tap', selector: '#go' },
        { kind: 'capture', capture: 'screenshot' }, // must NOT be dispatched
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(2);
    expect(res.results[0]!.kind).toBe('success');
    expect(res.results[1]!.kind).toBe('failure');
    expect(got).toHaveLength(2); // 3rd intent never dispatched
  });

  it('#139 a failed `wait` does NOT halt the plan — later intents (screenshot) still run', async () => {
    // wait is best-effort synchronization; a wait timeout must not abort the plan
    // and lose the customer's screenshot. Any OTHER failure still halts.
    const { got, dispatcher } = mockDispatcher((d) =>
      d.intentName === 'wait_for'
        ? failResult(d.intentId, 'intent_webdriver_failed') // → condition_not_met for a wait
        : okResult(d.intentId),
    );
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { maxRetries: 0 });
    const res = await exec.execute(
      planArgs([
        { kind: 'navigate', url: 'https://x' },
        { kind: 'wait', condition: 'idle' },
        { kind: 'capture', capture: 'screenshot' },
      ]),
    );
    // navigate ✅, wait ❌ (non-halting), screenshot ✅ — all three dispatched.
    expect(res.results).toHaveLength(3);
    expect(res.results[0]!.kind).toBe('success');
    expect(res.results[1]!.kind).toBe('failure'); // the wait
    expect(res.results[2]!.kind).toBe('success'); // the screenshot STILL ran
    expect(got.map((d) => d.intentName)).toEqual(['navigate', 'wait_for', 'screenshot']);
  });

  it('#139 a timed-out `wait` is single-shot (condition_not_met is not retried — no redundant re-wait)', async () => {
    const { got, dispatcher } = mockDispatcher((d) =>
      failResult(d.intentId, 'intent_webdriver_failed'),
    );
    // maxRetries:3 would normally retry a retryable failure; a wait timeout must
    // NOT (sleep is never reached since shouldRetry is false → no delay needed).
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { maxRetries: 3 });
    const res = await exec.execute(planArgs([{ kind: 'wait', condition: 'idle' }]));
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.kind).toBe('failure');
    expect(got.filter((d) => d.intentName === 'wait_for')).toHaveLength(1); // NOT 4 — single-shot
  });

  it('#139 an UNMAPPABLE `wait` (selector_visible w/ no selector) is non-halting — later steps still run', async () => {
    // A wait that fails at the MAPPING stage (not dispatch) must also not abort the
    // plan + lose the screenshot. Regression for the review finding: the non-halting
    // guarantee originally only covered dispatch-stage wait failures.
    const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId));
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { maxRetries: 0 });
    const res = await exec.execute(
      planArgs([
        { kind: 'navigate', url: 'https://x' },
        { kind: 'wait', condition: 'selector_visible' }, // no selector → mapWait ok:false
        { kind: 'capture', capture: 'screenshot' },
      ]),
    );
    expect(res.results).toHaveLength(3);
    expect(res.results[0]!.kind).toBe('success'); // navigate
    expect(res.results[1]!.kind).toBe('failure'); // the unmappable wait
    expect(res.results[2]!.kind).toBe('success'); // screenshot STILL ran
    // The wait never dispatched (mapping failed); navigate + screenshot did.
    expect(got.map((d) => d.intentName)).toEqual(['navigate', 'screenshot']);
  });

  it('#139 an unmappable NON-wait intent still halts the plan', async () => {
    const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId));
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(
      planArgs([
        { kind: 'interact', action: 'swipe' }, // no harness intent → unmappable, halts
        { kind: 'capture', capture: 'screenshot' }, // must NOT run
      ]),
    );
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.kind).toBe('failure');
    expect(got).toHaveLength(0);
  });

  it('an unsupported intent fails WITHOUT dispatching + halts the plan', async () => {
    const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId));
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(
      planArgs([
        { kind: 'interact', action: 'swipe' }, // no harness intent → unsupported
        { kind: 'navigate', url: 'https://x' }, // must NOT run
      ]),
    );
    expect(res.ok).toBe(false);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.kind).toBe('failure');
    if (res.results[0]!.kind !== 'failure') throw new Error('narrow');
    expect(res.results[0]!.reason).toMatch(/swipe has no harness intent/);
    expect(got).toHaveLength(0); // never reached the dispatcher
  });

  it('maps a dispatch failure to a customer failure reason', async () => {
    const { dispatcher } = mockDispatcher((d) =>
      failResult(d.intentId, 'intent_session_not_established'),
    );
    // Disable BOTH retry budgets so this reason-mapping test fails fast (the
    // session-establish patient retry is exercised in its own tests below).
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), {
      maxRetries: 0,
      sessionEstablishMaxRetries: 0,
    });
    const res = await exec.execute(planArgs([{ kind: 'navigate', url: 'https://x' }]));
    expect(res.ok).toBe(false);
    expect(res.results[0]!.kind).toBe('failure');
    if (res.results[0]!.kind !== 'failure') throw new Error('narrow');
    expect(res.results[0]!.reason).toContain('the browser session was not established');
  });

  it('empty plan → ok:true, no dispatches', async () => {
    const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId));
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(planArgs([]));
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(0);
    expect(got).toHaveLength(0);
  });

  it('success summary carries the navigate url from outputData', async () => {
    const { dispatcher } = mockDispatcher((d) =>
      okResult(d.intentId, d.sessionId, { url: 'https://final' }),
    );
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
    const res = await exec.execute(planArgs([{ kind: 'navigate', url: 'https://x' }]));
    expect(res.results[0]!.kind).toBe('success');
    if (res.results[0]!.kind !== 'success') throw new Error('narrow');
    expect(res.results[0]!.summary).toBe('navigated to https://final');
  });
});

describe('ControlPlaneAgentExecutor — doc-132 §5.3 auto-retry of transient failures', () => {
  // Instant sleep + records backoff calls, so tests never actually wait.
  function instantSleep(): { sleep: (ms: number) => Promise<void>; calls: number[] } {
    const calls: number[] = [];
    return {
      calls,
      sleep: (ms) => {
        calls.push(ms);
        return Promise.resolve();
      },
    };
  }

  it('retries a RETRYABLE failure and succeeds on a later attempt → overall success', async () => {
    // Fail (webdriver → element_not_found, retryable) on attempts 0-1, succeed on attempt 2.
    const { got, dispatcher } = mockDispatcher((d, i) =>
      i < 2 ? failResult(d.intentId, 'intent_webdriver_failed') : okResult(d.intentId),
    );
    const { sleep, calls } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), {
      maxRetries: 2,
      retryDelayMs: 400,
      sleep,
    });
    const res = await exec.execute(
      planArgs([{ kind: 'interact', action: 'tap', selector: '#go' }]),
    );
    expect(res.ok).toBe(true);
    expect(res.results).toHaveLength(1);
    expect(res.results[0]!.kind).toBe('success');
    expect(got).toHaveLength(3); // attempt 0 + 2 retries, last one succeeded
    // Each retry got a fresh intentId (a distinct dispatch to correlate).
    expect(new Set(got.map((d) => d.intentId)).size).toBe(3);
    expect(calls).toEqual([400, 400]); // backoff before each of the 2 retries
  });

  it('a RETRYABLE failure exhausting all attempts → failure after 1 + maxRetries dispatches', async () => {
    const { got, dispatcher } = mockDispatcher((d) =>
      failResult(d.intentId, 'intent_webdriver_failed'),
    );
    const { sleep, calls } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), {
      maxRetries: 2,
      retryDelayMs: 0,
      sleep,
    });
    const res = await exec.execute(
      planArgs([{ kind: 'interact', action: 'tap', selector: '#go' }]),
    );
    expect(res.ok).toBe(false);
    expect(res.results[0]!.kind).toBe('failure');
    expect(got).toHaveLength(3); // 1 + 2 retries
    expect(calls).toHaveLength(2); // slept before each retry, not after the final failure
  });

  it('a NON-retryable failure (invalid_request) is surfaced on the first attempt — never retried', async () => {
    const { got, dispatcher } = mockDispatcher((d) =>
      failResult(d.intentId, 'intent_missing_parameter'),
    );
    const { sleep, calls } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { maxRetries: 2, sleep });
    const res = await exec.execute(planArgs([{ kind: 'navigate', url: 'https://x' }]));
    expect(res.ok).toBe(false);
    expect(res.results[0]!.kind).toBe('failure');
    expect(got).toHaveLength(1); // not retried
    expect(calls).toHaveLength(0);
  });

  it('maxRetries:0 disables retry entirely (a retryable failure is dispatched once)', async () => {
    const { got, dispatcher } = mockDispatcher((d) =>
      failResult(d.intentId, 'intent_webdriver_failed'),
    );
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { maxRetries: 0 });
    const res = await exec.execute(
      planArgs([{ kind: 'interact', action: 'tap', selector: '#go' }]),
    );
    expect(res.ok).toBe(false);
    expect(got).toHaveLength(1);
  });

  it('does NOT auto-retry a session_error on a side-effecting interact (dispatch timeout/drop may have already applied the tap → double-submit hazard)', async () => {
    // intent_dispatch_error → diagnosis category session_error. For an interact
    // (tap/type/press) this is the transmitted-but-unacked class: the action MAY
    // have executed, so a fresh-intentId retry would double-apply it.
    const { got, dispatcher } = mockDispatcher((d) =>
      failResult(d.intentId, 'intent_dispatch_error'),
    );
    const { sleep, calls } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { maxRetries: 2, sleep });
    const res = await exec.execute(
      planArgs([{ kind: 'interact', action: 'tap', selector: '#pay' }]),
    );
    expect(res.ok).toBe(false);
    expect(res.results[0]!.kind).toBe('failure');
    expect(got).toHaveLength(1); // failed safe: dispatched exactly once, no retry
    expect(calls).toHaveLength(0);
  });

  it('intent_session_not_established on an interact IS retried patiently — the DEFINITELY-not-executed cold-start case (no session existed), safe for any kind', async () => {
    // The box fork WebDriver is still warming up (~7-10s). Unlike a dispatch
    // TIMEOUT (intent_dispatch_error, maybe-executed), session_not_established
    // means the interact never ran, so retrying a side-effecting type through the
    // cold-start window can't double-apply. Succeeds once the fork is up.
    let n = 0;
    const { got, dispatcher } = mockDispatcher((d) =>
      n++ < 3
        ? failResult(d.intentId, 'intent_session_not_established')
        : okResult(d.intentId, d.sessionId),
    );
    const { sleep } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { sleep });
    const res = await exec.execute(
      planArgs([{ kind: 'interact', action: 'type', selector: '#q', value: 'hi' }]),
    );
    expect(res.ok).toBe(true); // retried through the cold-start → succeeded
    expect(got).toHaveLength(4); // 3 not-established + 1 success
  });

  it('a dispatch TIMEOUT/DROP (intent_dispatch_error = maybe-executed) on an interact is NOT auto-retried (double-apply fail-safe)', async () => {
    // The transmitted-but-unacked case: the type MAY have landed, so a fresh-
    // intentId retry would double-submit. Single-shot for a side-effecting interact.
    const { got, dispatcher } = mockDispatcher((d) =>
      failResult(d.intentId, 'intent_dispatch_error'),
    );
    const { sleep } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), { maxRetries: 2, sleep });
    const res = await exec.execute(
      planArgs([{ kind: 'interact', action: 'type', selector: '#q', value: 'hi' }]),
    );
    expect(res.ok).toBe(false);
    expect(got).toHaveLength(1);
  });

  it('a session_error on a NON-side-effecting kind (navigate) STILL retries — double-apply is harmless there', async () => {
    // navigate to the same URL twice is idempotent, so the maybe-executed
    // concern does not apply; keep the useful transient-recovery retry.
    let n = 0;
    const { got, dispatcher } = mockDispatcher((d) =>
      n++ < 2
        ? failResult(d.intentId, 'intent_dispatch_error')
        : okResult(d.intentId, d.sessionId, { url: 'https://x' }),
    );
    const { sleep } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), {
      maxRetries: 2,
      retryDelayMs: 0,
      sleep,
    });
    const res = await exec.execute(planArgs([{ kind: 'navigate', url: 'https://x' }]));
    expect(res.ok).toBe(true);
    expect(got).toHaveLength(3); // retried through the transient dispatch errors
  });

  it('a WEBDRIVER failure on an interact STILL retries — the atomic command errored WITHOUT tapping (proven not applied)', async () => {
    let n = 0;
    const { got, dispatcher } = mockDispatcher((d) =>
      n++ < 1 ? failResult(d.intentId, 'intent_webdriver_failed') : okResult(d.intentId),
    );
    const { sleep } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), {
      maxRetries: 2,
      retryDelayMs: 0,
      sleep,
    });
    const res = await exec.execute(
      planArgs([{ kind: 'interact', action: 'tap', selector: '#go' }]),
    );
    expect(res.ok).toBe(true);
    expect(got).toHaveLength(2); // element_not_found retried, then succeeded
  });

  it('retries only the FAILING step, not the whole plan — earlier successes are not re-dispatched', async () => {
    // intent 0 (navigate) succeeds once; intent 1 (interact) fails-retryable twice then succeeds.
    const { got, dispatcher } = mockDispatcher((d) => {
      if (d.intentName === 'navigate')
        return okResult(d.intentId, d.sessionId, { url: 'https://x' });
      // `got` already includes this dispatch, so clickCount is 1-based: fail
      // the first 3 clicks (counts 1-3), succeed on the 4th.
      const clickCount = got.filter((g) => g.intentName === 'click').length;
      return clickCount <= 3
        ? failResult(d.intentId, 'intent_webdriver_failed')
        : okResult(d.intentId);
    });
    const { sleep } = instantSleep();
    const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds(), {
      maxRetries: 3,
      retryDelayMs: 0,
      sleep,
    });
    const res = await exec.execute(
      planArgs([
        { kind: 'navigate', url: 'https://x' },
        { kind: 'interact', action: 'tap', selector: '#go' },
      ]),
    );
    expect(res.ok).toBe(true);
    expect(got.filter((g) => g.intentName === 'navigate')).toHaveLength(1); // not re-run
    expect(got.filter((g) => g.intentName === 'click')).toHaveLength(4); // 3 fails + 1 success
  });

  // #139 go-live — the consequential-action confirmation gate must survive the
  // StubAgentExecutor → ControlPlaneAgentExecutor swap. A real fleet box would
  // EXECUTE a purchase/payment/deletion; dropping the halt would let it run
  // unconfirmed. These pin that ControlPlaneAgentExecutor applies the SAME gate.
  describe('consequential-action confirmation gate (#139/#130)', () => {
    it('halts BEFORE dispatching an unapproved consequential tap (never reaches the box)', async () => {
      const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId));
      const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
      const res = await exec.execute(
        planArgs([
          { kind: 'navigate', url: 'https://shop.example.com' },
          { kind: 'interact', action: 'tap', selector: 'Buy Now' }, // purchase
          { kind: 'capture', capture: 'screenshot' }, // must NOT run
        ]),
      );
      expect(res.ok).toBe(false);
      expect(res.awaitingConfirmation).toBe(true);
      // navigate dispatched; the purchase halted (confirmation_required); capture never reached.
      expect(res.results).toHaveLength(2);
      expect(res.results[0]!.kind).toBe('success');
      expect(res.results[1]!.kind).toBe('confirmation_required');
      if (res.results[1]!.kind !== 'confirmation_required') throw new Error('narrow');
      expect(res.results[1]!.category).toBe('purchase');
      // Only the navigate hit the dispatcher — the consequential tap was NOT dispatched.
      expect(got.map((d) => d.intentName)).toEqual(['navigate']);
    });

    it('proceeds to dispatch when the consequential action is pre-approved', async () => {
      const { got, dispatcher } = mockDispatcher((d) => okResult(d.intentId));
      const exec = new ControlPlaneAgentExecutor(dispatcher, seqIds());
      const res = await exec.execute({
        sessionId: 'ses_x',
        plan: {
          kind: 'plan',
          intents: [{ kind: 'interact', action: 'tap', selector: 'Buy Now' }],
          tokensConsumed: 0,
        },
        // signature = `${category}:${matchedText.toLowerCase()}` (consequentialSignature).
        approvedConsequentialActions: new Set(['purchase:buy now']),
      });
      expect(res.ok).toBe(true);
      expect(res.awaitingConfirmation).toBeUndefined();
      expect(got.map((d) => d.intentName)).toEqual(['click']); // the approved tap WAS dispatched
    });
  });
});
