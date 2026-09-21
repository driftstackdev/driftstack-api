// B2 — the control-plane executor honours the customer's Stop.
//
// Three properties, each the reason a Stop can be trusted:
//   · NOTHING IS DISPATCHED AFTER THE STOP IS OBSERVED — not the next step, not
//     a retry of this one, not an element wait.
//   · A STEP THAT MAY CHANGE THE PAGE IS NEVER ABANDONED BLIND. If it was already
//     on its way to the device, its result is waited for (bounded) and recorded;
//     past the bound it is recorded as outcome-unknown, never as "not done".
//   · A STEP THAT ONLY READS OR WAITS IS CUT SHORT AT ONCE — nothing on the page
//     depends on its answer.

import { describe, expect, it } from 'vitest';
import {
  DRAWN_GAP_MAX_FACTOR,
  DRAWN_GAP_MIN_FACTOR,
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import {
  STOP_IN_FLIGHT_GRACE_MS,
  STOPPED_BEFORE_FINISHING_REASON,
  STOPPED_OUTCOME_UNKNOWN_REASON,
  type ExecuteArgs,
} from '../../src/services/agent-executor.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';
import type { AgentIntent } from '@driftstack/api-types';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test' };
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#send' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const WAIT: AgentIntent = { kind: 'wait', condition: 'selector_visible', selector: '#done' };

function ok(d: IntentDispatch, outputData?: unknown): ParsedIntentResult {
  return { sessionId: d.sessionId, intentId: d.intentId, success: true, durationMs: 1, outputData };
}

// These tests pin the wire order of each step exactly, holding each dispatch
// open to land a Stop at a chosen moment. The look before a tap is a separate
// dispatch with its own Stop contract, pinned in
// a-tap-looks-at-what-it-will-land-on-before-it-is-sent.test.ts; here it is off,
// so every held dispatch is the step itself.
const NO_LOOK = { preTapLookTimeoutMs: 0 } as const;

function seqIds(): () => string {
  let n = 0;
  return () => `int_${String(++n)}`;
}

/**
 * A dispatcher whose answers the test releases by hand, so a Stop can land while
 * a dispatch is genuinely in flight.
 */
function heldDispatcher(): {
  dispatcher: IntentDispatcher;
  sent: IntentDispatch[];
  release: (index: number, result?: (d: IntentDispatch) => ParsedIntentResult) => void;
  whenSent: (count: number) => Promise<void>;
} {
  const sent: IntentDispatch[] = [];
  const resolvers: Array<(r: ParsedIntentResult) => void> = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    sent,
    dispatcher: {
      dispatch: (d) =>
        new Promise<ParsedIntentResult>((resolve) => {
          sent.push(d);
          resolvers.push(resolve);
          for (const w of waiters.filter((x) => sent.length >= x.count)) w.resolve();
        }),
    },
    release: (index, result = (d) => ok(d)) => {
      const d = sent[index];
      if (d === undefined) throw new Error(`nothing sent at ${String(index)}`);
      resolvers[index]?.(result(d));
    },
    whenSent: (count) =>
      sent.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
  };
}

/** A sleep the test controls: nothing elapses until `elapse()` says so. */
function manualClock(): {
  sleep: (ms: number) => Promise<void>;
  elapse: (ms: number) => void;
  pending: () => number[];
} {
  const timers: Array<{ ms: number; resolve: () => void }> = [];
  return {
    sleep: (ms) =>
      new Promise<void>((resolve) => {
        timers.push({ ms, resolve });
      }),
    elapse: (ms) => {
      for (const t of timers.filter((x) => x.ms <= ms)) t.resolve();
    },
    pending: () => timers.map((t) => t.ms),
  };
}

function args(intents: AgentIntent[], signal: AbortSignal): ExecuteArgs {
  return {
    sessionId: 'agt_1',
    agentSessionId: 'agt_1',
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
    signal,
  };
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
};

/**
 * R9 — a pending sleep that is one drawn gap around `baseMs`.
 *
 * ⛔ NOT `toContain(baseMs)`. The gaps are drawn now, so a pin on the constant
 * would fail on a working executor; a pin on "some sleep is pending" would pass
 * on one that slept for the wrong reason. The band is the honest middle.
 */
function pendingGapInBand(pending: readonly number[], baseMs: number): boolean {
  const low = Math.round(baseMs * DRAWN_GAP_MIN_FACTOR);
  const high = Math.round(baseMs * DRAWN_GAP_MAX_FACTOR);
  return pending.some((ms) => ms >= low && ms <= high);
}

describe('ControlPlaneAgentExecutor — Stop', () => {
  it('CRITICAL a Stop observed between steps dispatches nothing more, and the run says it stopped', async () => {
    const held = heldDispatcher();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), NO_LOOK);
    const run = exec.execute(args([NAV, TAP, SHOT], controller.signal));
    await held.whenSent(1);
    // The navigate lands, THEN the customer presses Stop before the tap is sent.
    held.release(0);
    controller.abort();
    const result = await run;
    expect(held.sent.map((d) => d.intentName)).toEqual(['navigate']);
    expect(result.stopped).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.results.map((r) => r.kind)).toEqual(['success']);
  });

  it('CRITICAL a tap already in flight when Stop arrives is WAITED FOR and recorded as it came back — a click that landed is not reported as not done', async () => {
    const held = heldDispatcher();
    const clock = manualClock();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
    });
    const run = exec.execute(args([NAV, TAP, SHOT], controller.signal));
    await held.whenSent(1);
    held.release(0);
    await held.whenSent(2);
    // Stop while the tap is on the wire.
    controller.abort();
    await flush();
    // The grace timer is running, bounded by the published constant.
    expect(clock.pending()).toContain(STOP_IN_FLIGHT_GRACE_MS);
    held.release(1);
    const result = await run;
    expect(result.stopped).toBe(true);
    expect(result.results.map((r) => r.kind)).toEqual(['success', 'success']);
    // And nothing after it: the screenshot was never sent.
    expect(held.sent.map((d) => d.intentName)).toEqual(['navigate', 'click']);
  });

  it('CRITICAL a tap in flight that does not answer within the bound is recorded OUTCOME-UNKNOWN — "may have happened, check the page", never "did not happen"', async () => {
    const held = heldDispatcher();
    const clock = manualClock();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
    });
    const run = exec.execute(args([TAP, SHOT], controller.signal));
    await held.whenSent(1);
    controller.abort();
    await flush();
    clock.elapse(STOP_IN_FLIGHT_GRACE_MS);
    const result = await run;
    expect(result.stopped).toBe(true);
    const last = result.results.at(-1);
    expect(last).toMatchObject({
      kind: 'failure',
      reason: STOPPED_OUTCOME_UNKNOWN_REASON,
      // `unknown` + not retryable: no re-plan follows it and no retry replays it.
      diagnosis: { category: 'unknown', retryable: false },
    });
    expect(held.sent).toHaveLength(1);
  });

  it('a read-only step in flight is abandoned at once — no grace wait, nothing more sent', async () => {
    const held = heldDispatcher();
    const clock = manualClock();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
    });
    const run = exec.execute(args([WAIT, TAP], controller.signal));
    await held.whenSent(1);
    controller.abort();
    const result = await run;
    expect(clock.pending()).not.toContain(STOP_IN_FLIGHT_GRACE_MS);
    expect(result.stopped).toBe(true);
    expect(result.results).toEqual([
      { kind: 'failure', intent: WAIT, reason: STOPPED_BEFORE_FINISHING_REASON },
    ]);
    expect(held.sent.map((d) => d.intentName)).toEqual(['wait_for']);
  });

  it('a pending ELEMENT WAIT is cut short by Stop, and the step is reported as what it was: not found, not executed', async () => {
    const held = heldDispatcher();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: () => Promise.resolve(),
    });
    const run = exec.execute(args([TAP, SHOT], controller.signal));
    await held.whenSent(1);
    // The tap's lookup finds nothing, so the executor sends a wait_for for it…
    held.release(0, (d) => ({
      sessionId: d.sessionId,
      intentId: d.intentId,
      success: false,
      durationMs: 0,
      errorCode: 'intent_element_not_found',
    }));
    await held.whenSent(2);
    expect(held.sent[1]?.intentName).toBe('wait_for');
    // …and the customer presses Stop while it waits.
    controller.abort();
    const result = await run;
    expect(result.stopped).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({
      kind: 'failure',
      diagnosis: { category: 'element_not_found' },
    });
    // No retry of the tap after the wait, and no screenshot.
    expect(held.sent).toHaveLength(2);
  });

  it('a retry backoff is cut short by Stop and the retry is never sent', async () => {
    const held = heldDispatcher();
    const controller = new AbortController();
    const clock = manualClock();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
      maxRetries: 2,
    });
    const run = exec.execute(args([SHOT], controller.signal));
    await held.whenSent(1);
    // A retryable failure (a read-only dispatch error): the executor would back
    // off and try again.
    held.release(0, (d) => ({
      sessionId: d.sessionId,
      intentId: d.intentId,
      success: false,
      durationMs: 0,
      errorCode: 'intent_dispatch_error',
    }));
    await flush();
    // Proof it is in the backoff, not finished: a retry gap is pending. ⛔ R9 —
    // THE GAP IS DRAWN, so the proof is that a pending sleep sits inside the
    // band around the configured delay, not that it equals it.
    expect(pendingGapInBand(clock.pending(), 400)).toBe(true);
    controller.abort();
    const result = await run;
    expect(result.stopped).toBe(true);
    // The failure that actually happened is what the step reports.
    expect(result.results).toEqual([
      expect.objectContaining({
        kind: 'failure',
        diagnosis: { category: 'session_error', retryable: true },
      }),
    ]);
    expect(held.sent).toHaveLength(1);
  });

  it('a cold-start backoff is cut short by Stop too — the patient establish retry is not sent', async () => {
    const held = heldDispatcher();
    const controller = new AbortController();
    const clock = manualClock();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
    });
    const run = exec.execute(args([TAP], controller.signal));
    await held.whenSent(1);
    held.release(0, (d) => ({
      sessionId: d.sessionId,
      intentId: d.intentId,
      success: false,
      durationMs: 0,
      errorCode: 'intent_session_not_established',
    }));
    await flush();
    expect(pendingGapInBand(clock.pending(), 1_500)).toBe(true);
    controller.abort();
    const result = await run;
    expect(result.stopped).toBe(true);
    expect(held.sent).toHaveLength(1);
  });

  it('a Stop that has already happened when the run starts sends nothing at all', async () => {
    const held = heldDispatcher();
    const controller = new AbortController();
    controller.abort();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), NO_LOOK);
    const result = await exec.execute(args([NAV, TAP], controller.signal));
    expect(result).toEqual({ results: [], ok: false, stopped: true });
    expect(held.sent).toHaveLength(0);
  });

  it('observe() is cut short by Stop and answers null — a read changes nothing, so abandoning it is safe', async () => {
    const held = heldDispatcher();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: () => new Promise<void>(() => undefined),
    });
    const read = exec.observe('agt_1', undefined, controller.signal);
    await held.whenSent(1);
    controller.abort();
    await expect(read).resolves.toBeNull();
    // Already stopped: not even sent.
    await expect(exec.observe('agt_1', undefined, controller.signal)).resolves.toBeNull();
    expect(held.sent).toHaveLength(1);
  });

  it('with no signal at all, a run is exactly what it was before Stop existed', async () => {
    const held = heldDispatcher();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), NO_LOOK);
    const run = exec.execute({
      sessionId: 'agt_1',
      plan: { kind: 'plan', intents: [NAV], tokensConsumed: 0 },
    });
    await held.whenSent(1);
    held.release(0);
    const result = await run;
    // T4 — one new, ADDITIVE field since this pin was written: a bounded
    // per-step trace (verb + duration + ok/failed), attached whenever at
    // least one step ran. It changes nothing about Stop's own behaviour,
    // which is the property this test is really pinning.
    expect(result).toEqual({
      results: [expect.objectContaining({ kind: 'success' })],
      ok: true,
      stepTrace: [{ verb: 'navigate', ms: expect.any(Number), ok: true }],
    });
  });
});

describe('ControlPlaneAgentExecutor — Stop, round 2', () => {
  it('CRITICAL a Stop during the LAST step, which then comes back done, is not a stop: every planned step ran', async () => {
    const held = heldDispatcher();
    const clock = manualClock();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
    });
    const run = exec.execute(args([NAV, TAP], controller.signal));
    await held.whenSent(1);
    held.release(0);
    await held.whenSent(2);
    controller.abort();
    await flush();
    held.release(1);
    const result = await run;
    expect(result.stopped).toBeUndefined();
    expect(result.ok).toBe(true);
    expect(result.results.map((r) => r.kind)).toEqual(['success', 'success']);
  });

  it('the LAST step coming back OUTCOME-UNKNOWN is still a stop — it may not have happened', async () => {
    const held = heldDispatcher();
    const clock = manualClock();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
    });
    const run = exec.execute(args([TAP], controller.signal));
    await held.whenSent(1);
    controller.abort();
    await flush();
    clock.elapse(STOP_IN_FLIGHT_GRACE_MS);
    const result = await run;
    expect(result.stopped).toBe(true);
  });

  it('CRITICAL a Stop that lands during the authority read before a step: the step is never announced, and never sent', async () => {
    const held = heldDispatcher();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), NO_LOOK);
    const announced: number[] = [];
    const result = await exec.execute({
      ...args([NAV, TAP], controller.signal),
      shouldContinue: () => {
        // The customer presses Stop while this read is out.
        controller.abort();
        return Promise.resolve(true);
      },
      onStepStart: (_intent, index) => {
        announced.push(index);
      },
    });
    expect(announced).toEqual([]);
    expect(held.sent).toHaveLength(0);
    expect(result.stopped).toBe(true);
  });
});
