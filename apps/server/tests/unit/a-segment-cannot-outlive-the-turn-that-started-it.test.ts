// S1 — the turn owns the hard stop, and every segment of it shares the one
// deadline.
//
// The step loop is where the bound is enforced (see
// a-step-loop-that-runs-out-of-time-stops-between-steps-not-inside-one); this
// file is the other half of it: that the RUNTIME hands the executor an instant
// computed once from the top of the turn, that the instant does not renew itself
// per segment, and that a turn ended by it tells the customer so in words.
//
// ⛔ AND IT SAYS SO ON A RE-PLAN TOO (C14). Every other bound records its reason
// only after a `continue`, because after a failure the ✗ row is the message.
// That reasoning does not reach the clock: a row saying a selector was missing
// says nothing about the turn having run out of time before the re-plan that
// would have recovered from it could be asked for. That ending was silent, and
// "send continue" is exactly what the customer needed to be told.

import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  MAX_TURN_WALL_CLOCK_MS,
  TURN_LOOP_STOP_SENTENCES,
  TURN_RAN_OUT_OF_TIME_BEFORE_ANY_STEP_SENTENCE,
  turnLoopStopSentence,
} from '../../src/services/agent-runtime.js';
import { TURN_HARD_STOP_MS } from '../../src/services/agent-turn-bounds.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from '../../src/services/agent-executor.js';
import type {
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
  PlanStatus,
} from '../../src/services/agent-decomposer.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test/' };
const READ: AgentIntent = { kind: 'behavioral_pause', reading_word_count: 900 };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

/** The turn starts here on the injected clock, so the deadline below is a
 *  number the assertions can name rather than whatever a real clock said. */
const TURN_STARTS_AT = 1_000;

function segment(intents: AgentIntent[], status?: PlanStatus): DecomposeResult {
  return {
    kind: 'plan',
    intents,
    ...(status !== undefined ? { status } : {}),
    tokensConsumed: 100,
  };
}

interface Harness {
  runs: ExecuteArgs[];
  seen: DecomposeArgs[];
}

/** Runs every step green, and lets a chosen run report the executor half of the
 *  hard stop: ended between steps, nothing left in flight. */
function executorThatRunsOutOfTimeOn(
  h: Harness,
  opts: {
    hardStopOnRun?: number;
    failOnRun?: number;
    /** The hard stop had ALREADY passed when the run began: nothing was dispatched. */
    beforeAnyStep?: boolean;
    /** Move the injected clock as this run's steps are taken. */
    onRun?: (run: number) => void;
  } = {},
): AgentExecutor {
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      h.runs.push(args);
      const run = h.runs.length;
      opts.onRun?.(run);
      const results: IntentResult[] = [];
      if (opts.failOnRun === run) {
        const intent = args.plan.intents[0] ?? SHOT;
        results.push({
          kind: 'failure',
          intent,
          reason: 'nothing on the page matched that',
          diagnosis: { category: 'element_not_found', retryable: true },
        });
        return Promise.resolve({ results, ok: false });
      }
      if (opts.hardStopOnRun === run) {
        // The first step of the segment settled; the clock passed the hard stop
        // while it was on the wire, so the rest was never started.
        const intent = args.plan.intents[0];
        if (intent !== undefined && opts.beforeAnyStep !== true) {
          results.push({ kind: 'success', intent, summary: 'did it' });
        }
        return Promise.resolve({ results, ok: false, hardStopped: true });
      }
      for (const intent of args.plan.intents) {
        results.push({ kind: 'success', intent, summary: 'did it' });
      }
      return Promise.resolve({ results, ok: true });
    },
    observeDigest: () => Promise.resolve('a page'),
    observe: () => Promise.resolve('Weight: 312 g'),
  };
}

async function makeRuntime(
  h: Harness,
  opts: { plans: DecomposeResult[]; executor: AgentExecutor; nowMs: () => number },
) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        h.seen.push(args);
        const next = opts.plans[Math.min(h.seen.length - 1, opts.plans.length - 1)];
        return Promise.resolve(next ?? segment([SHOT], 'done'));
      },
      answerFromObservation: () =>
        Promise.resolve({ answer: 'It weighs 312 g.', tokensConsumed: 40 }),
    },
    executor: opts.executor,
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    nowMs: opts.nowMs,
  });
  return {
    turn: (userMessage: string) =>
      runtime.runTurn({
        agentSessionId: seed.id,
        userMessage,
        byokApiKey: 'sk-ant-test-fake-key',
      }),
  };
}

describe('a segment cannot outlive the turn that started it', () => {
  it('CRITICAL every segment is handed the SAME deadline, computed once from the top of the turn', async () => {
    const h: Harness = { runs: [], seen: [] };
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), segment([READ], 'continue'), segment([SHOT], 'done')],
      executor: executorThatRunsOutOfTimeOn(h),
      nowMs: () => TURN_STARTS_AT,
    });

    await turn('read me the recall notice');

    expect(h.runs).toHaveLength(3);
    // ⛔ ONE DEADLINE, NOT ONE PER SEGMENT. A per-run duration would silently be
    // three hard stops — the trap the element-wait ceiling was rebuilt to avoid.
    for (const run of h.runs) {
      expect(run.turnHardStopAtMs).toBe(TURN_STARTS_AT + TURN_HARD_STOP_MS);
    }
  });

  it('CRITICAL a turn ended by the hard stop tells the customer it took too long and to send "continue"', async () => {
    const h: Harness = { runs: [], seen: [] };
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), segment([READ, READ], 'continue')],
      executor: executorThatRunsOutOfTimeOn(h, { hardStopOnRun: 2 }),
      nowMs: () => TURN_STARTS_AT,
    });

    const result = await turn('read me every recall notice on the page');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // The segment that ran out of time is the last one: no further look, no
    // further plan call.
    expect(h.runs).toHaveLength(2);
    expect(h.seen).toHaveLength(2);
    expect(result.loop?.stopped).toBe('wall_clock');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.wall_clock);
    expect(result.noticeReason).toBe('time_limit');
    // The steps that DID run are still the turn's record.
    expect(result.executor.results.map((r) => r.kind)).toEqual(['success', 'success']);
  });

  it('CRITICAL a turn that ran out of time BEFORE any step does not claim "the steps above"', async () => {
    const h: Harness = { runs: [], seen: [] };
    const { turn } = await makeRuntime(h, {
      // One slow planning call can use the whole of the turn's time, so the very
      // first run comes back with the hard stop set and nothing dispatched.
      plans: [segment([NAV], 'continue')],
      executor: executorThatRunsOutOfTimeOn(h, { hardStopOnRun: 1, beforeAnyStep: true }),
      nowMs: () => TURN_STARTS_AT,
    });

    const result = await turn('read me every recall notice on the page');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.results).toEqual([]);
    // Same ending in one word — a program branches on this, not on the prose.
    expect(result.loop?.stopped).toBe('wall_clock');
    expect(result.noticeReason).toBe('time_limit');
    // …and a sentence that is true of a turn with no steps in it.
    expect(result.notice).toBe(TURN_RAN_OUT_OF_TIME_BEFORE_ANY_STEP_SENTENCE);
    expect(result.notice).not.toMatch(/steps above/);
    // CONTROL: the helper keeps the ordinary sentence the moment one step ran,
    // and never swaps the sentence of any OTHER ending.
    expect(turnLoopStopSentence('wall_clock', 1)).toBe(TURN_LOOP_STOP_SENTENCES.wall_clock);
    expect(turnLoopStopSentence('no_progress', 0)).toBe(TURN_LOOP_STOP_SENTENCES.no_progress);
  });

  it('CRITICAL ⛔ C14 — the hard stop says so after a RE-PLAN too, where every other bound is silent', async () => {
    const h: Harness = { runs: [], seen: [] };
    const { turn } = await makeRuntime(h, {
      // The first segment fails on a missing element, which is re-plannable; the
      // re-planned segment is the one that runs out of time.
      plans: [segment([NAV]), segment([READ, READ])],
      executor: executorThatRunsOutOfTimeOn(h, { failOnRun: 1, hardStopOnRun: 2 }),
      nowMs: () => TURN_STARTS_AT,
    });

    const result = await turn('open the recall notice');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(2);
    // The ✗ row says what went wrong with the step. It cannot say the turn ran
    // out of clock, and before this it was the only thing the customer saw.
    expect(result.loop?.stopped).toBe('wall_clock');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.wall_clock);
    expect(result.noticeReason).toBe('time_limit');
  });

  it('CRITICAL ⛔ C14 — the three-minute bound reached on a RE-PLAN also gets its sentence', async () => {
    const h: Harness = { runs: [], seen: [] };
    let now = TURN_STARTS_AT;
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), segment([SHOT], 'done')],
      executor: executorThatRunsOutOfTimeOn(h, {
        failOnRun: 1,
        // The failing segment took the whole of the turn's wall clock, so the
        // re-plan that would have recovered from it is never asked for.
        onRun: () => {
          now = TURN_STARTS_AT + MAX_TURN_WALL_CLOCK_MS;
        },
      }),
      nowMs: () => now,
    });

    const result = await turn('open the recall notice');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(1);
    expect(h.seen).toHaveLength(1);
    // The ✗ row is on the screen either way; what was missing was the sentence
    // telling the customer the turn ran out of time and "continue" is the move.
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.wall_clock);
    expect(result.noticeReason).toBe('time_limit');
    expect(result.loop?.stopped).toBe('wall_clock');
  });

  it('a turn that finishes inside the hard stop is unchanged — no notice, no reason', async () => {
    const h: Harness = { runs: [], seen: [] };
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), segment([SHOT], 'done')],
      executor: executorThatRunsOutOfTimeOn(h),
      nowMs: () => TURN_STARTS_AT,
    });

    const result = await turn('take a screenshot of the recall notice');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.loop?.stopped).toBeUndefined();
    expect(result.notice).toBeUndefined();
    expect(result.noticeReason).toBeUndefined();
  });
});
