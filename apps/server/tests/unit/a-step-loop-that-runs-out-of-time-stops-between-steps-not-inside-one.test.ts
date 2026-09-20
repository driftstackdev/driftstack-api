// S1 — the executor's step loop learns what time it is.
//
// THE DEFECT THIS FILE EXISTS FOR. The turn's wall clock is checked at the top
// of the TURN loop, so it decides whether to ask for another segment and can say
// nothing about the segment already running. The step loop had no clock at all.
// Eight steps each pausing near the device's 300s cap, each with its own 315s
// dispatch deadline, is tens of minutes inside ONE segment before the loop
// reaches the bound that would have refused segment two — and it is reachable
// today by a plan that asks for a long pause.
//
// ⛔ AND IT STOPS BETWEEN STEPS, NEVER INSIDE ONE. The runtime's refusal to cut a
// segment is a real invariant: abandoning a plan halfway leaves dispatched
// actions in a state nobody can describe. The arms in the first block below hold
// a dispatch open across the moment the turn runs out of time, and assert the
// step that was on the wire settled and was recorded — the bound ends the loop,
// never a step.
//
// ⛔ AND A STEP IS NOT ONE DISPATCH. Its retry budgets — two general retries,
// eight cold-start retries, one element wait — each send a fresh dispatch with
// its own deadline, so a step that spent them would run for as long again after
// the turn was over, and the stop claim's TTL is derived from arithmetic that
// says exactly one dispatch is left in flight past the hard stop. The second
// block is that half: no new attempt is STARTED past the deadline, and each arm
// is paired with the same run inside the deadline so it is the clock being
// tested rather than a retry that never happens.

import { describe, expect, it } from 'vitest';
import {
  ControlPlaneAgentExecutor,
  type IntentDispatcher,
} from '../../src/services/agent-executor-control-plane.js';
import type { ExecuteArgs } from '../../src/services/agent-executor.js';
import type { ParsedIntentResult } from '../../src/services/harness-control-codec.js';
import type { AgentIntent } from '@driftstack/api-types';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test' };
const READ: AgentIntent = { kind: 'behavioral_pause', reading_word_count: 900 };
const TAP: AgentIntent = { kind: 'interact', action: 'tap', selector: '#send' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };

// The look before a tap is a separate dispatch with its own contract; off here,
// so every held dispatch below is the step itself.
const NO_LOOK = { preTapLookTimeoutMs: 0 } as const;

const HARD_STOP_AT = 300_000;

function ok(d: IntentDispatch): ParsedIntentResult {
  return { sessionId: d.sessionId, intentId: d.intentId, success: true, durationMs: 1 };
}

function seqIds(): () => string {
  let n = 0;
  return () => `int_${String(++n)}`;
}

/** A dispatcher the test releases by hand, so the clock can pass the hard stop
 *  while a step is genuinely on the wire. */
function heldDispatcher(): {
  dispatcher: IntentDispatcher;
  sent: IntentDispatch[];
  release: (index: number) => void;
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
    release: (index) => {
      const d = sent[index];
      if (d === undefined) throw new Error(`nothing sent at ${String(index)}`);
      resolvers[index]?.(ok(d));
    },
    whenSent: (count) =>
      sent.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.push({ count, resolve });
          }),
  };
}

/** The injected clock. Nothing here reads real time. */
function clock(start = 0): { now: () => number; set: (ms: number) => void } {
  let ms = start;
  return {
    now: () => ms,
    set: (next) => {
      ms = next;
    },
  };
}

function args(
  intents: AgentIntent[],
  extra: Partial<ExecuteArgs> = {},
): ExecuteArgs & { started: AgentIntent[] } {
  const started: AgentIntent[] = [];
  return {
    sessionId: 'agt_1',
    agentSessionId: 'agt_1',
    plan: { kind: 'plan', intents, tokensConsumed: 0 },
    onStepStart: (intent) => started.push(intent),
    started,
    ...extra,
  };
}

describe('the step loop stops between steps when the turn runs out of time', () => {
  it('CRITICAL the step on the wire when the hard stop passes IS FINISHED AND RECORDED, and the next one is never sent', async () => {
    const held = heldDispatcher();
    const time = clock();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      now: time.now,
    });
    const a = args([NAV, READ, SHOT], { turnHardStopAtMs: HARD_STOP_AT });
    const run = exec.execute(a);

    await held.whenSent(1);
    // The turn runs out of time WHILE the navigate is on the wire…
    time.set(HARD_STOP_AT);
    // …and the navigate still comes back, and still counts.
    held.release(0);
    const result = await run;

    expect(held.sent.map((d) => d.intentName)).toEqual(['navigate']);
    expect(result.results.map((r) => r.kind)).toEqual(['success']);
    expect(result.hardStopped).toBe(true);
    expect(result.ok).toBe(false);
    // Nobody pressed Stop: this is the turn's own bound, and it must not be
    // reported as the customer's.
    expect(result.stopped).toBeUndefined();
    // The step that never ran was never announced as starting either — a
    // "step 2 of 3 is running" for a step nothing was sent for is the lie the
    // announcement order exists to prevent.
    expect(a.started).toEqual([NAV]);
  });

  it('a long segment of pauses is bounded at the hard stop instead of running for as long as the plan asks', async () => {
    const held = heldDispatcher();
    const time = clock();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      now: time.now,
    });
    // Eight reading pauses: today each can hold the wire for minutes, and the
    // segment ran all eight whatever the clock said.
    const plan = [READ, READ, READ, READ, READ, READ, READ, READ];
    const run = exec.execute(args(plan, { turnHardStopAtMs: HARD_STOP_AT }));

    // Each pause takes a third of the hard stop; the third one takes the clock
    // past it, so the fourth is never sent.
    for (let i = 0; i < 3; i += 1) {
      await held.whenSent(i + 1);
      time.set((i + 1) * (HARD_STOP_AT / 3));
      held.release(i);
    }
    const result = await run;

    expect(held.sent).toHaveLength(3);
    expect(result.results).toHaveLength(3);
    expect(result.hardStopped).toBe(true);
  });

  it('the bound is the instant itself: a loop that reaches it exactly stops, and a turn with time left does not', async () => {
    const time = clock();
    const exec = new ControlPlaneAgentExecutor(
      { dispatch: (d) => Promise.resolve(ok(d)) },
      seqIds(),
      { ...NO_LOOK, now: time.now },
    );

    time.set(HARD_STOP_AT - 1);
    const before = await exec.execute(args([NAV, SHOT], { turnHardStopAtMs: HARD_STOP_AT }));
    expect(before.hardStopped).toBeUndefined();
    expect(before.results).toHaveLength(2);

    time.set(HARD_STOP_AT);
    const a = args([NAV, SHOT], { turnHardStopAtMs: HARD_STOP_AT });
    const at = await exec.execute(a);
    // Nothing at all: the deadline had already passed when the run started, so
    // not even the first step is announced.
    expect(at.hardStopped).toBe(true);
    expect(at.results).toEqual([]);
    expect(a.started).toEqual([]);
  });

  it('a caller that sets no hard stop is unaffected, however far the clock has run', async () => {
    const time = clock(10 * HARD_STOP_AT);
    const exec = new ControlPlaneAgentExecutor(
      { dispatch: (d) => Promise.resolve(ok(d)) },
      seqIds(),
      { ...NO_LOOK, now: time.now },
    );

    const result = await exec.execute(args([NAV, READ, TAP, SHOT]));

    expect(result.results).toHaveLength(4);
    expect(result.ok).toBe(true);
    expect(result.hardStopped).toBeUndefined();
  });

  it('the customer pressing Stop wins over the bound — a Stop is answered as a Stop, not as "this took too long"', async () => {
    const held = heldDispatcher();
    const time = clock();
    const controller = new AbortController();
    const exec = new ControlPlaneAgentExecutor(held.dispatcher, seqIds(), {
      ...NO_LOOK,
      now: time.now,
    });
    const run = exec.execute(
      args([NAV, SHOT], { turnHardStopAtMs: HARD_STOP_AT, signal: controller.signal }),
    );

    await held.whenSent(1);
    held.release(0);
    // Both are true at the same moment. Stop is checked first, on purpose.
    time.set(HARD_STOP_AT);
    controller.abort();
    const result = await run;

    expect(result.stopped).toBe(true);
    expect(result.hardStopped).toBeUndefined();
  });
});

describe('a step that runs out of time does not start another attempt at itself', () => {
  /** Answers every dispatch with the same failure, and lets the arm move the
   *  clock as the first one lands. */
  function failsWith(
    errorCode: ParsedIntentResult['errorCode'],
    sent: IntentDispatch[],
    onFirst?: () => void,
  ): IntentDispatcher {
    return {
      dispatch: (d) => {
        sent.push(d);
        if (sent.length === 1) onFirst?.();
        return Promise.resolve({
          sessionId: d.sessionId,
          intentId: d.intentId,
          success: false,
          durationMs: 1,
          errorCode,
        } satisfies ParsedIntentResult);
      },
    };
  }

  it('CRITICAL the retry budget stops at the deadline — a step is not one dispatch, and the claim TTL is derived as if it were', async () => {
    const time = clock();
    const sent: IntentDispatch[] = [];
    const exec = new ControlPlaneAgentExecutor(
      // A dispatch that could not be sent: retryable for a wait, and the class
      // whose own deadline is five minutes on a box that stopped answering.
      failsWith('intent_dispatch_error', sent, () => time.set(HARD_STOP_AT)),
      seqIds(),
      { ...NO_LOOK, now: time.now, sleep: () => Promise.resolve() },
    );

    const result = await exec.execute(args([SETTLE], { turnHardStopAtMs: HARD_STOP_AT }));

    expect(
      sent,
      'a second attempt here is another five-minute deadline after the turn is over',
    ).toHaveLength(1);
    // The step is reported as what the attempt that DID run came back with —
    // never as nothing, and never as a step that was cut short.
    expect(result.results.at(-1)).toMatchObject({ kind: 'failure', intent: SETTLE });
  });

  it('the same failure IS retried while the turn still has time — the arm above is the clock, not a retry that never happens', async () => {
    const time = clock();
    const sent: IntentDispatch[] = [];
    const exec = new ControlPlaneAgentExecutor(failsWith('intent_dispatch_error', sent), seqIds(), {
      ...NO_LOOK,
      now: time.now,
      sleep: () => Promise.resolve(),
    });

    await exec.execute(args([SETTLE], { turnHardStopAtMs: HARD_STOP_AT }));

    expect(sent.length).toBeGreaterThan(1);
  });

  it('CRITICAL an element wait is not started past the deadline either — it asks the device for seconds and is bounded in minutes', async () => {
    const time = clock();
    const sent: IntentDispatch[] = [];
    const exec = new ControlPlaneAgentExecutor(
      failsWith('intent_element_not_found', sent, () => time.set(HARD_STOP_AT)),
      seqIds(),
      { ...NO_LOOK, now: time.now, sleep: () => Promise.resolve() },
    );

    await exec.execute(args([TAP], { turnHardStopAtMs: HARD_STOP_AT }));

    expect(sent.map((d) => d.intentName)).toEqual(['click']);
  });

  it('and the element wait DOES run while the turn still has time', async () => {
    const time = clock();
    const sent: IntentDispatch[] = [];
    const exec = new ControlPlaneAgentExecutor(
      failsWith('intent_element_not_found', sent),
      seqIds(),
      { ...NO_LOOK, now: time.now, sleep: () => Promise.resolve() },
    );

    await exec.execute(args([TAP], { turnHardStopAtMs: HARD_STOP_AT }));

    expect(sent.map((d) => d.intentName)).toContain('wait_for');
  });
});
