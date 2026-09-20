// S3 — Stop means stop during a pause.
//
// THE DEFECT THIS FILE EXISTS FOR. A `behavioral_pause` is replay-unsafe, so
// Stop treated it like a tap: it waited out the fifteen-second in-flight grace
// and then recorded "this step was already running when the task was stopped,
// and I could not confirm whether it happened — check the page before doing it
// again". About a step whose entire effect is to wait. The customer, having
// pressed Stop, watched "Stopping…" for fifteen seconds and was then sent to
// inspect a page for the consequences of a pause.
//
// A pause changes nothing on the page, so it is the one intent that is provably
// safe to abandon the instant Stop arrives. That is a different property from
// being safe to RETRY, and the two are kept apart — see
// a-pause-is-stop-abandonable-without-becoming-retry-safe.

import { describe, expect, it } from 'vitest';
import {
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

const READ: AgentIntent = { kind: 'behavioral_pause', reading_word_count: 900 };
const DWELL: AgentIntent = { kind: 'behavioral_pause', duration_ms: 9_000 };
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#send' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

const NO_LOOK = { preTapLookTimeoutMs: 0 } as const;

function seqIds(): () => string {
  let n = 0;
  return () => `int_${String(++n)}`;
}

function heldDispatcher(): {
  dispatcher: IntentDispatcher;
  sent: IntentDispatch[];
  whenSent: (count: number) => Promise<void>;
} {
  const sent: IntentDispatch[] = [];
  const waiters: Array<{ count: number; resolve: () => void }> = [];
  return {
    sent,
    dispatcher: {
      // Never answers — exactly the device that is mid-dwell when Stop lands.
      dispatch: (d) =>
        new Promise<ParsedIntentResult>(() => {
          sent.push(d);
          for (const w of waiters.filter((x) => sent.length >= x.count)) w.resolve();
        }),
    },
    whenSent: (count) =>
      sent.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
  };
}

/** A sleep the test controls: nothing elapses until `elapse()` says so, so an
 *  arm that waits out the grace is visible as a pending timer rather than as a
 *  test that takes fifteen seconds. */
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

describe('a stopped pause is abandoned, not reported as outcome-unknown', () => {
  it('CRITICAL a reading pause hit by Stop is abandoned AT ONCE — no grace wait, and the sentence is "it did not finish"', async () => {
    const held = heldDispatcher();
    const clock = manualClock();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
    });
    const run = exec.execute(args([READ, TAP], controller.signal));

    await held.whenSent(1);
    controller.abort();
    const result = await run;

    // The grace timer was never armed: the customer is not made to wait out
    // fifteen seconds for an answer nothing depends on.
    expect(clock.pending()).not.toContain(STOP_IN_FLIGHT_GRACE_MS);
    expect(result.stopped).toBe(true);
    expect(result.results).toEqual([
      { kind: 'failure', intent: READ, reason: STOPPED_BEFORE_FINISHING_REASON },
    ]);
    // ⛔ AND NOT THE OTHER SENTENCE. "Check the page before doing it again" is
    // what a stopped tap says, and it is nonsense about a pause.
    expect(result.results[0]).not.toMatchObject({ reason: STOPPED_OUTCOME_UNKNOWN_REASON });
    // Nothing after it reached the device.
    expect(held.sent.map((d) => d.intentName)).toEqual(['behavioral_pause']);
  });

  it('a plain {duration_ms} pause is abandoned the same way — the property is the pause, not the reading variant', async () => {
    const held = heldDispatcher();
    const clock = manualClock();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      sleep: clock.sleep,
    });
    const run = exec.execute(args([DWELL, SHOT], controller.signal));

    await held.whenSent(1);
    controller.abort();
    const result = await run;

    expect(clock.pending()).not.toContain(STOP_IN_FLIGHT_GRACE_MS);
    expect(result.results).toEqual([
      { kind: 'failure', intent: DWELL, reason: STOPPED_BEFORE_FINISHING_REASON },
    ]);
  });

  it('CRITICAL a TAP in flight is still waited for and still reported outcome-unknown — the branch is about the pause, not about Stop', async () => {
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
    // The grace IS armed here, and running it out is what produces the honest
    // "I could not confirm whether it happened".
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
    expect(clock.pending()).toContain(STOP_IN_FLIGHT_GRACE_MS);
    clock.elapse(STOP_IN_FLIGHT_GRACE_MS);
    const result = await run;

    expect(result.results.at(-1)).toMatchObject({
      kind: 'failure',
      reason: STOPPED_OUTCOME_UNKNOWN_REASON,
      diagnosis: { category: 'unknown', retryable: false },
    });
  });

  it('a pause that has already settled when Stop lands is recorded as what it was, not overwritten by the abandon path', async () => {
    const sent: IntentDispatch[] = [];
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(
      {
        dispatch: (d) => {
          sent.push(d);
          return Promise.resolve({
            sessionId: d.sessionId,
            intentId: d.intentId,
            success: true,
            durationMs: 1,
          });
        },
      },
      seqIds(),
      NO_LOOK,
    );
    const result = await exec.execute({
      ...args([READ, TAP], controller.signal),
      // Stop lands the moment the pause's own result has been recorded.
      onStep: () => controller.abort(),
    });

    expect(result.stopped).toBe(true);
    expect(result.results.map((r) => r.kind)).toEqual(['success']);
    expect(sent.map((d) => d.intentName)).toEqual(['behavioral_pause']);
  });
});
