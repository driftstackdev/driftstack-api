// B1 — A TURN IS A LOOP: look → plan as far as you can SEE → act → look again.
//
// THE FAILURE THIS FILE EXISTS FOR (live eval, 2026-09-18, a real model at
// product defaults): six of nine customer tasks completed ZERO times out of two,
// with no unsafe event and no broken step. The first plan of a chat is made
// blind — no page is open yet — and is, correctly, cautious: go there, wait,
// look. Every step SUCCEEDS, so the turn ends "plan-executed". Re-planning fired
// only after a FAILED step, so it never fired, and the customer had to type
// "continue" for a task a person would call one request.
//
// ⛔ WHAT THIS FILE DOES AND DOES NOT PROVE. It proves the LOOP: that a segment
// marked `continue` is followed by a look and another segment in the SAME turn,
// that `done` ends it, and that every bound stops it and SAYS SO. No model runs
// here, so it proves nothing about whether a real planner uses the signal well —
// that is the live eval's question, and a scripted number must never be quoted
// as an answer to it.
//
// ⛔ AND EVERY BOUND HAS ITS OWN ARM AND ITS OWN SENTENCE. A loop that stops at a
// bound shows the customer a column of green ticks over a task that is NOT
// finished — the very failure the loop was built to end, re-created by the
// loop's own limits. So each arm asserts the stop AND the words.

import { isDeepStrictEqual } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  MAX_MODEL_CALLS_PER_TURN,
  MAX_PLANNER_CALLS_PER_TURN,
  MAX_RUNS_OF_ONE_STEP_PER_TURN,
  MAX_TURN_WALL_CLOCK_MS,
  REPLAN_MIN_BUDGET_TOKENS,
  TURN_LOOP_STOP_SENTENCES,
  admitSegment,
  sameSiteEffect,
  segmentRanToItsEnd,
  type AgentTurnProgressEvent,
} from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  consequentialHalt,
  consequentialSignature,
  type AgentExecutor,
  type ExecuteArgs,
  type ExecutorRunResult,
  type IntentResult,
} from '../../src/services/agent-executor.js';
import type {
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
  PlanStatus,
} from '../../src/services/agent-decomposer.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test/' };
const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };
const PAUSE: AgentIntent = { kind: 'behavioral_pause', reading_word_count: 40 };
const SCROLL_DOWN: AgentIntent = { kind: 'scroll', direction: 'down', amount_px: 600 };
const TYPE_QUERY: AgentIntent = {
  kind: 'interact',
  action: 'type',
  selector: '#q',
  value: 'trail stove',
};
const TAP_RESULT: AgentIntent = { kind: 'interact', action: 'tap', selector: '.result a' };
const TAP_SEND: AgentIntent = { kind: 'interact', action: 'tap', selector: '#send' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };
const BUY: AgentIntent = { kind: 'interact', action: 'tap', selector: '#buy', value: 'Buy now' };

function segment(intents: AgentIntent[], status?: PlanStatus, tokens = 100): DecomposeResult {
  return {
    kind: 'plan',
    intents,
    ...(status !== undefined ? { status } : {}),
    tokensConsumed: tokens,
  };
}

function outcomeUnknown(intent: AgentIntent): IntentResult {
  return {
    kind: 'failure',
    intent,
    reason: 'the browser action may have taken effect even though its result was not confirmed',
    diagnosis: { category: 'unknown', retryable: false },
  };
}

interface Harness {
  runs: ExecuteArgs[];
  dispatched: AgentIntent[];
  seen: DecomposeArgs[];
  observes: { n: number };
  events: AgentTurnProgressEvent[];
}

function harness(): Harness {
  return { runs: [], dispatched: [], seen: [], observes: { n: 0 }, events: [] };
}

/** Runs every intent green unless `fails` says otherwise, applies the REAL
 *  consequential gate, and reports a page digest that a test can move. */
function loopExecutor(
  h: Harness,
  opts: {
    fails?: (intent: AgentIntent) => IntentResult | null;
    /** The digest returned by the n-th look (1-based). */
    digest?: (look: number) => string | null;
    onRun?: (run: number) => void | Promise<void>;
    pageText?: string;
  } = {},
): AgentExecutor {
  return {
    execute: async (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      h.runs.push(args);
      await opts.onRun?.(h.runs.length);
      const results: IntentResult[] = [];
      // A copy: the gate CONSUMES a grant when it spends one, exactly as the
      // product's executors do.
      const approved = new Set(args.approvedConsequentialActions ?? []);
      for (const [index, intent] of args.plan.intents.entries()) {
        const halt = consequentialHalt(intent, approved);
        if (halt !== null) {
          results.push(halt);
          return { results, ok: false, awaitingConfirmation: true };
        }
        args.onStepStart?.(intent, index);
        h.dispatched.push(intent);
        const failure = opts.fails?.(intent) ?? null;
        if (failure !== null) {
          results.push(failure);
          if (intent.kind === 'wait') continue;
          return { results, ok: false };
        }
        results.push({ kind: 'success', intent, summary: `did ${intent.kind}` });
      }
      return { results, ok: results.every((r) => r.kind === 'success') };
    },
    observeDigest: (): Promise<string | null> => {
      h.observes.n += 1;
      return Promise.resolve(
        opts.digest === undefined
          ? `page as of look ${String(h.observes.n)}`
          : opts.digest(h.observes.n),
      );
    },
    observe: (): Promise<string | null> => Promise.resolve(opts.pageText ?? 'Weight: 312 g'),
  };
}

async function makeRuntime(
  h: Harness,
  opts: {
    plans: DecomposeResult[] | ((call: number, args: DecomposeArgs) => DecomposeResult);
    executor?: AgentExecutor;
    tokenBudgetTotal?: number;
    nowMs?: () => number;
    answers?: { n: number };
    usageRows?: Array<{ tokensConsumed: number; bundledFlatCostAlreadyPosted?: boolean }>;
    /** Make the n-th token debit of the turn (1-based) throw, as storage can. */
    debitThrowsOn?: number;
  },
) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-18T00:00:00Z'));
  if (opts.debitThrowsOn !== undefined) {
    const debit = sessions.debitTokensIfActive.bind(sessions);
    let debits = 0;
    sessions.debitTokensIfActive = (id, tokens) => {
      debits += 1;
      return debits === opts.debitThrowsOn
        ? Promise.reject(new Error('db blip'))
        : debit(id, tokens);
    };
  }
  const seed = await sessions.create({
    accountId: 'acc_1',
    tokenBudgetTotal: opts.tokenBudgetTotal ?? 100_000,
  });
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        h.seen.push(args);
        const call = h.seen.length;
        const next =
          typeof opts.plans === 'function'
            ? opts.plans(call, args)
            : opts.plans[Math.min(call - 1, opts.plans.length - 1)];
        return Promise.resolve(next ?? segment([SHOT], 'done'));
      },
      answerFromObservation: () => {
        if (opts.answers !== undefined) opts.answers.n += 1;
        return Promise.resolve({ answer: 'It weighs 312 g.', tokensConsumed: 40 });
      },
    },
    executor: opts.executor ?? loopExecutor(h),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
    ...(opts.usageRows !== undefined
      ? {
          usageRecorder: {
            record: (row) => {
              opts.usageRows?.push({
                tokensConsumed: row.tokensConsumed,
                ...(row.bundledFlatCostAlreadyPosted !== undefined
                  ? { bundledFlatCostAlreadyPosted: row.bundledFlatCostAlreadyPosted }
                  : {}),
              });
              return Promise.resolve();
            },
          },
        }
      : {}),
  });
  const turn = (userMessage: string, extra: { approved?: ReadonlySet<string> } = {}) =>
    runtime.runTurn({
      agentSessionId: seed.id,
      userMessage,
      byokApiKey: 'sk-ant-test-fake-key',
      onProgress: (event) => h.events.push(event),
      ...(extra.approved !== undefined ? { approvedConsequentialActions: extra.approved } : {}),
    });
  return { runtime, sessions, seedId: seed.id, turn };
}

/** A planner that never finishes: a DIFFERENT, harmless step every segment, so
 *  only a bound can stop it (no identical-plan stop, no repeat refusal). */
function neverDone(call: number): DecomposeResult {
  return segment([{ kind: 'scroll', direction: 'down', amount_px: 100 * call }], 'continue');
}

describe('B1 — a segment that says `continue` is followed by a look and another segment, in the SAME turn', () => {
  it('search → result → detail → done runs as ONE customer message, where before it needed "please continue"', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [
        segment([NAV, SETTLE], 'continue'),
        segment([TYPE_QUERY, PAUSE], 'continue'),
        segment([TAP_RESULT, SETTLE], 'continue'),
        segment([SHOT], 'done'),
      ],
    });

    const result = await turn('search for a trail stove and tell me how much the first one weighs');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(4);
    expect(h.seen).toHaveLength(4);
    expect(result.executor.ok).toBe(true);
    // Every step of every segment is in the ONE result the customer is shown.
    expect(result.executor.results.map((r) => r.intent.kind)).toEqual([
      'navigate',
      'wait',
      'interact',
      'behavioral_pause',
      'interact',
      'wait',
      'capture',
    ]);
    expect(result.loop).toEqual({ segments: 4, plannerCalls: 4, replans: 0, finalStatus: 'done' });
    // It finished, so there is nothing to apologise for.
    expect(result.notice).toBeUndefined();
    expect(result.answer).toBe('It weighs 312 g.');
  });

  it('⛔ IT LOOKS BEFORE EVERY LATER SEGMENT, and tells the planner what this turn has already done', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV, SETTLE], 'continue'), segment([TYPE_QUERY, SHOT], 'done')],
    });

    await turn('search for a trail stove');

    // The first plan of a chat is blind; the second is made WITH the page.
    expect(h.seen[0]?.observation).toBeUndefined();
    expect(h.seen[0]?.turnProgress).toBeUndefined();
    expect(h.observes.n).toBe(1);
    expect(h.seen[1]?.observation).toBe('page as of look 1');
    // The transcript cannot say what this turn did — it is appended when the
    // turn ENDS — so the planner is told here, or it types into a filled field.
    expect(h.seen[1]?.turnProgress).toEqual({
      segment: 2,
      plannerCallsRemaining: MAX_PLANNER_CALLS_PER_TURN - 2,
      stepsSoFar: ['✓ did navigate', '✓ did wait'],
    });
    // A `continue` is not a failure, and must not be described to the planner as one.
    expect(h.seen[1]?.priorFailure).toBeUndefined();
    // Every call in the turn is planned against the SAME history, which is what
    // keeps them on one cached prefix.
    expect(h.seen[1]?.history).toBe(h.seen[0]?.history);
  });

  it('`done` with NO steps is how a planner, shown the confirmation page, says the job is finished', async () => {
    const h = harness();
    const answers = { n: 0 };
    const { turn, sessions, seedId } = await makeRuntime(h, {
      plans: [segment([NAV, TAP_SEND], 'continue'), segment([], 'done')],
      answers,
    });

    const result = await turn('send the form and tell me what the page says');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(1);
    expect(h.seen).toHaveLength(2);
    expect(result.loop?.finalStatus).toBe('done');
    expect(result.notice).toBeUndefined();
    // ⛔ B5 — NO SEGMENT CAPTURED ANYTHING, and the customer still gets their
    // answer. "The plan ended in a capture" was a proxy for "the model wanted to
    // look"; a loop planner looks after every segment, so the proxy would
    // withhold the answer on exactly the turns that went best.
    expect(answers.n).toBe(1);
    expect(result.answer).toBe('It weighs 312 g.');
    const body = (await sessions.get(seedId))?.transcript.find(
      (e) => e.intents !== undefined,
    )?.body;
    expect(body).not.toContain('NOT finished');
  });
});

describe('B1 — ⛔ a plan WITHOUT a status behaves exactly as it always did', () => {
  it('runs once and ends the turn on success — the deterministic planner, the scripted eval and stored transcripts are untouched', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      // More plans are on offer. A status-less plan must never ask for them.
      plans: [segment([NAV, SETTLE, SHOT]), segment([TAP_RESULT], 'done')],
    });

    const result = await turn('open the shop and take a screenshot');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(1);
    expect(h.seen).toHaveLength(1);
    expect(h.observes.n).toBe(0);
    // And it reports nothing about a loop it did not run.
    expect(result.loop).toBeUndefined();
    expect(result.notice).toBeUndefined();
    // The progress stream is byte-for-byte what a single-plan turn always sent:
    // no offset, no segment, no status, no cause.
    expect(h.events.filter((e) => e.kind === 'plan')).toEqual([
      { kind: 'plan', intents: [NAV, SETTLE, SHOT], total: 3 },
    ]);
    expect(h.events.filter((e) => e.kind === 'phase').every((e) => !('cause' in e))).toBe(true);
  });

  it('and a status-less plan that did NOT ask for information still pays for no read-back without a capture', async () => {
    const h = harness();
    const answers = { n: 0 };
    const { turn } = await makeRuntime(h, { plans: [segment([NAV, SETTLE])], answers });
    await turn('open the shop and tell me the price');
    // The legacy gate is unchanged: no capture in the plan, no read-back.
    expect(answers.n).toBe(0);
  });
});

describe('B1 — ⛔ EVERY BOUND STOPS THE LOOP, AND SAYS SO IN ITS OWN WORDS', () => {
  it('MAX_PLANNER_CALLS_PER_TURN — a planner that says `continue` forever cannot run forever', async () => {
    const h = harness();
    const { turn, sessions, seedId } = await makeRuntime(h, { plans: neverDone });

    const result = await turn('keep scrolling until you find the recall notice and tell me');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.seen).toHaveLength(MAX_PLANNER_CALLS_PER_TURN);
    expect(h.runs).toHaveLength(MAX_PLANNER_CALLS_PER_TURN);
    expect(result.loop?.stopped).toBe('planner_call_limit');
    // Every step is a tick, so the sentence is the only thing that says the
    // task is unfinished.
    expect(result.executor.ok).toBe(true);
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.planner_call_limit);
    // And the NEXT turn's planner is told too, or "continue" is planned as new work.
    const body = (await sessions.get(seedId))?.transcript.find(
      (e) => e.intents !== undefined,
    )?.body;
    expect(body).toContain('the task is NOT finished');
    // The last model call was kept for the read-back, which still ran.
    expect(result.answer).toBe('It weighs 312 g.');
    expect(h.seen.length + 1).toBe(MAX_MODEL_CALLS_PER_TURN);
  });

  it('MAX_TURN_WALL_CLOCK_MS — no NEW segment is started once the turn has run too long', async () => {
    const h = harness();
    let now = 1_000;
    const { turn } = await makeRuntime(h, {
      plans: neverDone,
      nowMs: () => now,
      executor: loopExecutor(h, {
        // The second segment's steps "take" longer than the whole ceiling.
        onRun: (run) => {
          if (run === 2) now += MAX_TURN_WALL_CLOCK_MS;
        },
      }),
    });

    const result = await turn('keep going');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // The segment in flight was NOT cut off — it ran to its end — and no third
    // one was asked for.
    expect(h.runs).toHaveLength(2);
    expect(h.seen).toHaveLength(2);
    expect(result.loop?.stopped).toBe('wall_clock');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.wall_clock);
  });

  it('REPLAN_MIN_BUDGET_TOKENS, re-read EVERY iteration — a segment is never started on a balance that cannot cover it', async () => {
    const h = harness();
    // Each planning call costs 3,000. From 14,000: 11,000 → 8,000 → 5,000, and
    // 5,000 is under the floor, so the FOURTH call must not start.
    expect(REPLAN_MIN_BUDGET_TOKENS).toBe(6_000);
    const { turn, sessions, seedId } = await makeRuntime(h, {
      plans: (call) => ({ ...neverDone(call), tokensConsumed: 3_000 }),
      tokenBudgetTotal: 14_000,
    });

    const result = await turn('keep going');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.seen).toHaveLength(3);
    expect(result.loop?.stopped).toBe('budget_floor');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.budget_floor);
    // Every call that DID run was debited.
    expect((await sessions.get(seedId))?.tokenBudgetRemaining).toBe(14_000 - 9_000);
  });

  it('NO PROGRESS — the same page, the same plan, again → stop. A loop that taps the same thing forever is this design’s own failure mode', async () => {
    const h = harness();
    const same = segment([TAP_RESULT, PAUSE], 'continue');
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), same, same, same],
      executor: loopExecutor(h, { digest: () => 'a page that never changes' }),
    });

    const result = await turn('find the recall notice');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // Asked a third time (that call is real, and billed) — and refused before
    // anything was dispatched again.
    expect(h.seen).toHaveLength(3);
    expect(h.runs).toHaveLength(2);
    expect(h.dispatched.filter((i) => isDeepStrictEqual(i, TAP_RESULT))).toHaveLength(1);
    expect(result.loop?.stopped).toBe('no_progress');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.no_progress);
  });

  it('⛔ EXCEPT ONE MORE SCROLL — a plan that only moves and reads may be repeated ONCE on an unchanged page (content that renders when scrolled into view), and a second repeat is circles', async () => {
    // Measured live, 2026-09-18: a 600px scroll fell short of a lazily rendered
    // price grid. The planner rightly asked for the same scroll again, and the
    // turn stopped as "going in circles" one scroll before the prices appeared.
    // The look is a digest of the DOCUMENT; a scroll moves the VIEWPORT.
    const h = harness();
    const same = segment([SCROLL_DOWN, PAUSE], 'continue');
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), same, same, same, same],
      executor: loopExecutor(h, { digest: () => 'a page that never changes' }),
    });

    const result = await turn('find the recall notice');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // NAV, the scroll, the scroll AGAIN — and the third identical scroll refused.
    expect(h.runs).toHaveLength(3);
    expect(h.seen).toHaveLength(4);
    expect(result.loop?.stopped).toBe('no_progress');
  });

  // ⛔ PIN MOVED, DELIBERATELY (review, 2026-09-18). This used to assert that the
  // same step on a page that DID change is refused as a repeat. That refusal was
  // the defect: "next page", Continue on the second page of a sign-in and a
  // consent banner that came back are all the same step on a page that moved,
  // and refusing them made the customer type "continue" mid-task. What is pinned
  // now is both halves — it RUNS, and it cannot run forever.
  it('the same single step on a page that DID change is the next thing, not a repeat — and it is still bounded', async () => {
    const h = harness();
    const next = segment([TAP_RESULT], 'continue');
    const { turn } = await makeRuntime(h, { plans: [segment([NAV], 'continue'), next] });

    const result = await turn('page through the results');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // Every look differs (the default digest), so each tap is on a moved page.
    expect(h.dispatched.filter((i) => isDeepStrictEqual(i, TAP_RESULT))).toHaveLength(
      MAX_RUNS_OF_ONE_STEP_PER_TURN,
    );
    expect(result.loop?.stopped).toBe('repeat_refused');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.repeat_refused);
  });

  it('a plan that only WAITS or CAPTURES, repeated on an unchanged page, is circles the first time — the one-more allowance is for a scroll', async () => {
    const h = harness();
    const same = segment([SETTLE, SHOT], 'continue');
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV], 'continue'), same, same, same],
      executor: loopExecutor(h, { digest: () => 'a page that never changes' }),
    });

    const result = await turn('wait for the queue');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(2);
    expect(result.loop?.stopped).toBe('no_progress');
  });

  it('⛔ THE WALL CLOCK STARTS AT THE TOP OF THE TURN — a slow FIRST planning call counts against it', async () => {
    const h = harness();
    let now = 1_000;
    const { turn } = await makeRuntime(h, {
      plans: (call) => {
        if (call === 1) now += MAX_TURN_WALL_CLOCK_MS;
        return neverDone(call);
      },
      nowMs: () => now,
    });

    const result = await turn('keep going');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.seen).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
    expect(result.loop?.stopped).toBe('wall_clock');
  });

  it('a planner that ANSWERS A LATER SEGMENT WITH A QUESTION hands the turn back with that question — the steps stand, and no read-back talks over it', async () => {
    const h = harness();
    const answers = { n: 0 };
    const { turn, sessions, seedId } = await makeRuntime(h, {
      plans: [
        segment([NAV, SETTLE], 'continue'),
        {
          kind: 'clarify',
          clarifyingQuestion: 'There are two stoves — which one?',
          tokensConsumed: 80,
        },
      ],
      answers,
    });

    const result = await turn('open the stove and tell me what it weighs');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.results).toHaveLength(2);
    expect(result.notice).toBe('There are two stoves — which one?');
    expect(result.loop?.handedBack).toBe(true);
    // Which KIND of hand-back it was travels with the result, because a
    // question and a refusal are different outcomes for the turn's telemetry.
    expect(result.loop?.handedBackKind).toBe('clarify');
    expect(answers.n).toBe(0);
    const body = (await sessions.get(seedId))?.transcript.find(
      (e) => e.intents !== undefined,
    )?.body;
    expect(body).toContain('stopped part-way to ask the customer');
  });
});

describe('B1 — the loop remembers which page each step LED to', () => {
  it('a planner that DECLINES a later segment hands back a refusal, and says it was one', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [
        segment([NAV, SETTLE], 'continue'),
        {
          kind: 'refuse',
          refuseReason: 'That page asks for something I should not do.',
          tokensConsumed: 60,
        },
      ],
    });
    const result = await turn('open the shop');
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.loop).toMatchObject({ handedBack: true, handedBackKind: 'refuse' });
    expect(result.notice).toBe('That page asks for something I should not do.');
  });

  it('⛔ navigating AGAIN to the page the first navigate already reached is circles — the look after a segment is the page its steps led to', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV, SETTLE], 'continue'), segment([NAV], 'continue'), segment([], 'done')],
      executor: loopExecutor(h, { digest: () => 'the shop front' }),
    });
    const result = await turn('open the shop');
    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.loop?.stopped).toBe('no_progress');
    expect(h.dispatched.filter((i) => i.kind === 'navigate')).toHaveLength(1);
  });
});

describe('B1 — ⛔ SAFETY DOES NOT ERODE ACROSS SEGMENTS', () => {
  it('a purchase reached in a LATER segment halts for confirmation exactly as it would in the first — and the loop never plans past the halt', async () => {
    const h = harness();
    const { turn, sessions, seedId } = await makeRuntime(h, {
      plans: [
        segment([NAV, SETTLE], 'continue'),
        segment([BUY, SHOT], 'continue'),
        segment([SHOT], 'done'),
      ],
    });

    const result = await turn('go to the checkout and place the order');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.awaitingConfirmation).toBe(true);
    // The purchase was NOT dispatched, and the planner was not asked to route
    // around a human decision in progress.
    expect(h.dispatched.some((i) => isDeepStrictEqual(i, BUY))).toBe(false);
    expect(h.seen).toHaveLength(2);
    // The approval resumes the reviewed action, at its index across BOTH segments.
    const entry = (await sessions.get(seedId))?.transcript.find((e) => e.intents !== undefined);
    expect(entry?.intents).toEqual([NAV, SETTLE, BUY, SHOT]);
    expect(entry?.resumeFromIntentIndex).toBe(2);
  });

  it('⛔ APPROVALS ARE NEVER CARRIED FROM ONE SEGMENT TO THE NEXT — a later segment always runs with none', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV, SETTLE], 'continue'), segment([BUY], 'continue')],
    });
    // The customer sends approvals with a FRESH message. There is no halted plan
    // to resume, so they authorise nothing — in ANY segment.
    const halt = consequentialHalt(BUY, new Set());
    if (halt === null) throw new Error('the fixture purchase is not consequential');
    const result = await turn('go to the checkout and place the order', {
      approved: new Set([consequentialSignature(halt.category, halt.matchedText)]),
    });

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs.map((r) => r.approvedConsequentialActions)).toEqual([undefined, undefined]);
    expect(result.executor.awaitingConfirmation).toBe(true);
    expect(h.dispatched.some((i) => isDeepStrictEqual(i, BUY))).toBe(false);
  });

  it('an approval RESUME runs the reviewed action and nothing else — the loop never plans onward from a plan the customer approved', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [
        segment([NAV, SETTLE], 'continue'),
        segment([BUY, SHOT], 'continue'),
        segment([TAP_RESULT], 'done'),
      ],
    });
    const first = await turn('go to the checkout and place the order');
    if (first.kind !== 'plan-executed') throw new Error('type narrow');
    const halt = first.executor.results.at(-1);
    if (halt?.kind !== 'confirmation_required') throw new Error('type narrow');
    const callsBefore = h.seen.length;
    const dispatchedBefore = h.dispatched.length;

    await turn('yes, go ahead', {
      approved: new Set([consequentialSignature(halt.category, halt.matchedText)]),
    });

    // No model call at all, and exactly the reviewed suffix.
    expect(h.seen).toHaveLength(callsBefore);
    expect(h.dispatched.slice(dispatchedBefore)).toEqual([BUY, SHOT]);
  });

  it('⛔ AN APPROVED STEP THAT THEN FAILS IS NOT RE-PLANNED — the grant is still live in that turn, and a re-plan under it could buy something the customer never saw', async () => {
    // This is the arm that gives "never loop an approval resume" its own
    // failing test. A resumed plan carries no status, so it can never CONTINUE;
    // the one way it could go round is a re-plannable failure — and that turn is
    // the only one in the product that holds approvals.
    const h = harness();
    let failBuy = false;
    const { turn } = await makeRuntime(h, {
      plans: [
        segment([NAV, SETTLE], 'continue'),
        segment([BUY], 'continue'),
        segment([{ ...BUY, selector: '#buy-now-instead' }], 'done'),
      ],
      executor: loopExecutor(h, {
        fails: (i) =>
          failBuy && isDeepStrictEqual(i, BUY)
            ? {
                kind: 'failure',
                intent: i,
                reason: 'no element on the page matched this selector',
                diagnosis: { category: 'element_not_found', retryable: true },
              }
            : null,
      }),
    });
    const first = await turn('go to the checkout and place the order');
    if (first.kind !== 'plan-executed') throw new Error('type narrow');
    const halt = first.executor.results.at(-1);
    if (halt?.kind !== 'confirmation_required') throw new Error('type narrow');
    const callsBefore = h.seen.length;
    failBuy = true;

    const resumed = await turn('yes, go ahead', {
      approved: new Set([consequentialSignature(halt.category, halt.matchedText)]),
    });

    if (resumed.kind !== 'plan-executed') throw new Error('type narrow');
    expect(resumed.executor.ok).toBe(false);
    // The failure is re-plannable in any OTHER turn. Here the planner is not asked.
    expect(h.seen).toHaveLength(callsBefore);
    expect(
      h.dispatched.some((i) => i.kind === 'interact' && i.selector === '#buy-now-instead'),
    ).toBe(false);
  });

  it('⛔ A STEP THAT ALREADY RAN IN AN EARLIER SEGMENT IS NEVER RE-RUN — a planner that re-describes the whole task has its prefix dropped', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [
        segment([NAV, TYPE_QUERY], 'continue'),
        // "Carry on" answered with the whole task again, plus the new step.
        segment([NAV, TYPE_QUERY, TAP_RESULT, SHOT], 'done'),
      ],
    });

    await turn('search and open the first result');

    expect(h.runs[1]?.plan.intents).toEqual([TAP_RESULT, SHOT]);
    // Typed ONCE. Typing twice doubles the text in the box.
    expect(h.dispatched.filter((i) => isDeepStrictEqual(i, TYPE_QUERY))).toHaveLength(1);
    expect(h.dispatched.filter((i) => isDeepStrictEqual(i, NAV))).toHaveLength(1);
  });

  it('⛔ AND A REPEAT THAT IS NOT A PREFIX REFUSES THE WHOLE SEGMENT — checked against EVERY earlier segment, not only the last', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [
        segment([NAV, TAP_SEND], 'continue'),
        segment([SETTLE, PAUSE], 'continue'),
        // Two segments later, Send again — behind a step, where trimming cannot see it.
        segment([SCROLL_DOWN, TAP_SEND], 'done'),
      ],
    });

    const result = await turn('send the form');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(2);
    expect(h.dispatched.filter((i) => isDeepStrictEqual(i, TAP_SEND))).toHaveLength(1);
    expect(result.loop?.stopped).toBe('repeat_refused');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.repeat_refused);
  });

  it('pacing is not an effect on the site: a segment that pauses and scrolls like the last one is NOT refused for it', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [
        segment([NAV, PAUSE, SCROLL_DOWN], 'continue'),
        segment([TAP_RESULT, PAUSE, SCROLL_DOWN, SHOT], 'done'),
      ],
    });

    const result = await turn('open the first result');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.runs).toHaveLength(2);
    expect(h.runs[1]?.plan.intents).toEqual([TAP_RESULT, PAUSE, SCROLL_DOWN, SHOT]);
    expect(result.notice).toBeUndefined();
  });

  describe('⛔ a step is what it DOES, not how it is spelled — a reworded tap is still the same tap', () => {
    // The defect (review, 2026-09-18): steps were compared by deep equality, so
    // `tap #send "Send"` then `tap #send` were two different steps and the form
    // went TWICE in one customer message, with no notice. A tap's `value` is
    // only the label used to confirm the right element was found.
    const variants: Array<[string, AgentIntent]> = [
      ['the label dropped', { kind: 'interact', action: 'tap', selector: '#send' }],
      [
        'the label reworded',
        { kind: 'interact', action: 'tap', selector: '#send', value: 'Send message' },
      ],
      [
        'the selector tag-qualified',
        { kind: 'interact', action: 'tap', selector: 'button#send', value: 'Send' },
      ],
      [
        'the selector scoped and listed with a fallback',
        { kind: 'interact', action: 'tap', selector: 'form  #send.primary, .cta', value: 'Send' },
      ],
    ];
    const SEND: AgentIntent = { kind: 'interact', action: 'tap', selector: '#send', value: 'Send' };

    for (const [name, reworded] of variants) {
      it(`with ${name}, Send is dispatched ONCE and the turn says why it stopped`, async () => {
        const h = harness();
        const { turn } = await makeRuntime(h, {
          plans: [
            segment([NAV], 'continue'),
            segment([SEND], 'continue'),
            // Behind a scroll, so this is not merely "the identical plan".
            segment([SCROLL_DOWN, reworded], 'done'),
          ],
          // The page looks the same after the tap — a digest never shows a
          // field's contents, so a sent form and an untouched one can.
          executor: loopExecutor(h, { digest: () => 'the contact form' }),
        });

        const result = await turn('send the form');

        if (result.kind !== 'plan-executed') throw new Error('type narrow');
        expect(
          h.dispatched.filter((i) => i.kind === 'interact' && i.action === 'tap'),
        ).toHaveLength(1);
        expect(result.loop?.stopped).toBe('no_progress');
        expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.no_progress);
      });
    }

    it('and the identical-plan stop reads a reworded plan as the same plan', async () => {
      const h = harness();
      const { turn } = await makeRuntime(h, {
        plans: [
          segment([NAV], 'continue'),
          segment([SEND], 'continue'),
          segment([{ kind: 'interact', action: 'tap', selector: '#send' }], 'continue'),
        ],
        executor: loopExecutor(h, { digest: () => 'the contact form' }),
      });

      const result = await turn('send the form');

      if (result.kind !== 'plan-executed') throw new Error('type narrow');
      expect(h.runs).toHaveLength(2);
      expect(result.loop?.stopped).toBe('no_progress');
    });

    it('⛔ after a FAILURE, the same plan reworded is the same plan — it fails the same way, and is not run again', async () => {
      // The one case only the identical-plan check sees: the step that failed
      // did not RUN, so the repeat guard has nothing to match it against, and a
      // planner that drops the label on its retry would be sent round again.
      const h = harness();
      const GO: AgentIntent = { kind: 'interact', action: 'tap', selector: '#go', value: 'Go' };
      const { turn } = await makeRuntime(h, {
        plans: [
          segment([NAV, GO]),
          segment([NAV, { kind: 'interact', action: 'tap', selector: 'button#go' }]),
        ],
        executor: loopExecutor(h, {
          fails: (intent) =>
            intent.kind === 'interact'
              ? {
                  kind: 'failure',
                  intent,
                  reason: 'no element matched',
                  diagnosis: { category: 'element_not_found', retryable: true },
                }
              : null,
        }),
      });

      const result = await turn('press go');

      if (result.kind !== 'plan-executed') throw new Error('type narrow');
      expect(h.seen).toHaveLength(2);
      expect(h.runs).toHaveLength(1);
      expect(h.dispatched.filter((i) => i.kind === 'interact')).toHaveLength(1);
    });

    it('sameSiteEffect: what is the same act, and what is not', () => {
      const tap = (selector: string, value?: string): AgentIntent => ({
        kind: 'interact',
        action: 'tap',
        selector,
        ...(value !== undefined ? { value } : {}),
      });
      expect(sameSiteEffect(tap('#send', 'Send'), tap('#send'))).toBe(true);
      expect(sameSiteEffect(tap('#send'), tap('BUTTON#send'))).toBe(true);
      expect(sameSiteEffect(tap('#send'), tap('#sender'))).toBe(false);
      // An id inside an ATTRIBUTE is not the element's id.
      expect(sameSiteEffect(tap('#send'), tap('a[href="#send"]'))).toBe(false);
      // Typing DIFFERENT text is a different act; the same text is the same one.
      const type = (value: string): AgentIntent => ({
        kind: 'interact',
        action: 'type',
        selector: '#q',
        value,
      });
      expect(sameSiteEffect(type('stove'), type('stove'))).toBe(true);
      expect(sameSiteEffect(type('stove'), type('tent'))).toBe(false);
      expect(sameSiteEffect(type('stove'), tap('#q'))).toBe(false);
      expect(
        sameSiteEffect(
          { kind: 'navigate', url: 'https://shop.test/list/' },
          { kind: 'navigate', url: 'https://SHOP.test/list#top' },
        ),
      ).toBe(true);
      expect(
        sameSiteEffect(
          { kind: 'navigate', url: 'https://shop.test/list?page=1' },
          { kind: 'navigate', url: 'https://shop.test/list?page=2' },
        ),
      ).toBe(false);
    });
  });

  describe('a repeated step is judged against the PAGE — what a person does all the time still runs', () => {
    const NEXT: AgentIntent = { kind: 'interact', action: 'tap', selector: '#next', value: 'Next' };
    const ENTER: AgentIntent = { kind: 'interact', action: 'press', value: 'Enter' };

    it('a two-page sign-in sharing one Next button finishes in one message', async () => {
      const h = harness();
      const user: AgentIntent = {
        kind: 'interact',
        action: 'type',
        selector: '#identifier',
        value: '{{credential:username}}',
      };
      const pass: AgentIntent = {
        kind: 'interact',
        action: 'type',
        selector: '#password',
        value: '{{credential:password}}',
      };
      const { turn } = await makeRuntime(h, {
        plans: [
          segment([NAV, SETTLE], 'continue'),
          segment([user, NEXT], 'continue'),
          segment([pass, NEXT], 'continue'),
          segment([], 'done'),
        ],
      });

      const result = await turn('sign me in');

      if (result.kind !== 'plan-executed') throw new Error('type narrow');
      expect(h.dispatched.filter((i) => isDeepStrictEqual(i, NEXT))).toHaveLength(2);
      expect(result.notice).toBeUndefined();
      expect(result.loop?.finalStatus).toBe('done');
    });

    it('Enter in the search box and Enter in the next box are two acts on two pages', async () => {
      const h = harness();
      const other: AgentIntent = {
        kind: 'interact',
        action: 'type',
        selector: '#zip',
        value: '94110',
      };
      const { turn } = await makeRuntime(h, {
        plans: [
          segment([NAV], 'continue'),
          segment([TYPE_QUERY, ENTER], 'continue'),
          segment([other, ENTER], 'done'),
        ],
      });

      const result = await turn('search, then set my zip');

      if (result.kind !== 'plan-executed') throw new Error('type narrow');
      expect(h.dispatched.filter((i) => isDeepStrictEqual(i, ENTER))).toHaveLength(2);
      expect(result.notice).toBeUndefined();
    });

    it('⛔ A TRIP BACK IS NOT A RE-DESCRIPTION — a later segment that navigates back to the first URL keeps its navigate, so the rest runs on the page it was planned for', async () => {
      // The defect: the leading-prefix trim, written for a failure re-plan that
      // re-describes the whole task, was applied to a `continue` segment. It
      // dropped the deliberate navigate and ran `tap #delete-draft` on /about.
      const h = harness();
      const about: AgentIntent = { kind: 'interact', action: 'tap', selector: 'a[href="/about"]' };
      const remove: AgentIntent = { kind: 'interact', action: 'tap', selector: '#delete-draft' };
      const { turn } = await makeRuntime(h, {
        plans: [
          segment([NAV, SETTLE], 'continue'),
          segment([about], 'continue'),
          segment([NAV, SETTLE, remove], 'done'),
        ],
      });

      await turn('check the about page, then go back and delete my draft');

      expect(h.runs[2]?.plan.intents).toEqual([NAV, SETTLE, remove]);
      expect(h.dispatched.map((i) => i.kind)).toEqual([
        'navigate',
        'wait',
        'interact',
        'navigate',
        'wait',
        'interact',
      ]);
    });

    it('admitSegment: the rules, one arm each', () => {
      const ran = (intent: AgentIntent, pageBefore?: string, pageAfter?: string) => ({
        intent,
        pageBefore,
        pageAfter,
      });
      const base = { cause: 'continue' as const, pageNow: 'page 3' };
      // Same page as the one it was planned on before → circles.
      expect(
        admitSegment({ ...base, planned: [NEXT], ran: [ran(NEXT, 'page 3', 'page 2')] }),
      ).toEqual({ admitted: false, reason: 'no_progress' });
      // A moved page → it runs.
      expect(
        admitSegment({ ...base, planned: [NEXT], ran: [ran(NEXT, 'page 2', 'page 3')] }).admitted,
      ).toBe(true);
      // A step planned BLIND cannot be shown to have moved anything.
      expect(admitSegment({ ...base, planned: [NEXT], ran: [ran(NEXT, undefined)] })).toEqual({
        admitted: false,
        reason: 'repeat_refused',
      });
      // No look now → nothing shows the page moved.
      expect(
        admitSegment({ ...base, pageNow: undefined, planned: [NEXT], ran: [ran(NEXT, 'page 2')] }),
      ).toEqual({ admitted: false, reason: 'repeat_refused' });
      // The same TEXT into the same box is never the next thing.
      expect(
        admitSegment({ ...base, planned: [TYPE_QUERY], ran: [ran(TYPE_QUERY, 'page 2')] }),
      ).toEqual({ admitted: false, reason: 'repeat_refused' });
      // A re-described job that TYPES the same text again is refused, moved page
      // or not: the same text into the same box doubles what is there.
      expect(
        admitSegment({
          ...base,
          planned: [SCROLL_DOWN, TYPE_QUERY, NEXT],
          ran: [ran(NAV), ran(TYPE_QUERY, 'page 2'), ran(NEXT, 'page 2')],
        }),
      ).toEqual({ admitted: false, reason: 'repeat_refused' });
      // ⛔ SEVERAL repeats on a MOVED page — one form template per step: tap the
      // field, type NEW text, tap Continue. Measured live: this was refused
      // mid-form when any two repeats refused the segment. Each is now judged
      // against the page on its own.
      const FIELD: AgentIntent = { kind: 'interact', action: 'tap', selector: '#postcode' };
      const typed = (value: string): AgentIntent => ({
        kind: 'interact',
        action: 'type',
        selector: '#postcode',
        value,
      });
      expect(
        admitSegment({
          ...base,
          planned: [FIELD, typed('YO1 7HH'), NEXT],
          ran: [ran(FIELD, 'page 2'), ran(typed('LS1 4AP'), 'page 2'), ran(NEXT, 'page 2')],
        }),
      ).toEqual({ admitted: true, intents: [FIELD, typed('YO1 7HH'), NEXT] });
      // … and ONE of several repeats on a page it already ran on refuses the lot.
      expect(
        admitSegment({
          ...base,
          planned: [FIELD, NEXT],
          ran: [ran(FIELD, 'page 2'), ran(NEXT, 'page 3')],
        }),
      ).toEqual({ admitted: false, reason: 'no_progress' });
      // A navigate to the page we are already on goes nowhere.
      expect(
        admitSegment({ ...base, planned: [NAV], ran: [ran(NAV, undefined, 'page 3')] }),
      ).toEqual({ admitted: false, reason: 'no_progress' });
      // After a FAILURE the page is not known to have moved: any repeat refuses,
      // and a partial leading repeat is still trimmed (the P1 behaviour).
      expect(
        admitSegment({
          cause: 'replan',
          pageNow: 'page 3',
          planned: [NEXT],
          ran: [ran(NAV), ran(NEXT, 'page 2', 'page 3')],
        }),
      ).toEqual({ admitted: false, reason: 'repeat_refused' });
      expect(
        admitSegment({
          cause: 'replan',
          pageNow: 'page 3',
          planned: [NAV, TAP_RESULT],
          ran: [ran(NAV), ran(NEXT, 'page 2', 'page 3')],
        }),
      ).toEqual({ admitted: true, intents: [TAP_RESULT] });
    });
  });

  it('⛔ A STORAGE FAILURE MID-LOOP NEVER ERASES WHAT RAN — the turn resolves, the transcript lists the steps, and the customer is told it is unfinished', async () => {
    // The defect: the in-loop token debit was un-guarded. It threw AFTER Send
    // had been dispatched, the turn rejected, and the transcript held only the
    // customer's message — so their retry planned blind and sent the form again.
    const h = harness();
    const { turn, sessions, seedId } = await makeRuntime(h, {
      plans: [
        segment([NAV, SETTLE], 'continue'),
        segment([TAP_SEND], 'continue'),
        segment([SHOT], 'done'),
      ],
      // Debit 1 is the first plan's, 2 the second segment's, 3 the third's.
      debitThrowsOn: 3,
    });

    const result = await turn('send the form');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.dispatched.filter((i) => isDeepStrictEqual(i, TAP_SEND))).toHaveLength(1);
    // The third segment was planned but never paid for, so it never ran.
    expect(h.runs).toHaveLength(2);
    expect(result.loop?.stopped).toBe('planner_unavailable');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.planner_unavailable);
    const entry = (await sessions.get(seedId))?.transcript.find((e) => e.intents !== undefined);
    expect(entry?.intents).toEqual([NAV, SETTLE, TAP_SEND]);
    expect(entry?.body).toContain('the task is NOT finished');
  });

  it('⛔ AN OUTCOME-UNKNOWN STEP IS NEVER FOLLOWED BY ANOTHER SEGMENT — `continue` does not outrank "we cannot say whether that click landed"', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV, TAP_SEND], 'continue'), segment([SHOT], 'done')],
      executor: loopExecutor(h, {
        fails: (i) => (isDeepStrictEqual(i, TAP_SEND) ? outcomeUnknown(i) : null),
      }),
    });

    const result = await turn('send the form');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(h.seen).toHaveLength(1);
    expect(h.runs).toHaveLength(1);
    expect(result.executor.ok).toBe(false);
  });

  it('⛔ AUTHORITY IS RE-CHECKED EVERY ITERATION — a turn that lost control mid-loop asks the planner nothing more', async () => {
    const h = harness();
    const made = await makeRuntime(h, { plans: neverDone });
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
          h.seen.push(args);
          return Promise.resolve(neverDone(h.seen.length));
        },
      },
      executor: loopExecutor(h, {
        // The customer takes the wheel while the second segment is running.
        onRun: async (run) => {
          if (run === 2) await made.sessions.setMode(made.seedId, 'manual', null);
        },
      }),
      sessions: made.sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });

    const result = await runtime.runTurn({
      agentSessionId: made.seedId,
      userMessage: 'keep going',
    });

    expect(result.kind).toBe('ai-control-unavailable');
    expect(h.seen).toHaveLength(2);
    expect(h.runs).toHaveLength(2);
  });

  it('⛔ EVERY SEGMENT WRITES ITS OWN USAGE ROW AND IS DEBITED — the monthly cap sums exactly these rows', async () => {
    const h = harness();
    const usageRows: Array<{ tokensConsumed: number; bundledFlatCostAlreadyPosted?: boolean }> = [];
    const withUsage = (
      tokens: number,
      status: PlanStatus,
      intents: AgentIntent[],
    ): DecomposeResult => ({
      kind: 'plan',
      intents,
      status,
      tokensConsumed: tokens,
      usage: { decomposerKind: 'claude', anthropicInputTokens: tokens, anthropicOutputTokens: 0 },
    });
    const { turn, sessions, seedId } = await makeRuntime(h, {
      plans: [
        withUsage(300, 'continue', [NAV]),
        withUsage(200, 'continue', [TYPE_QUERY]),
        withUsage(100, 'done', [TAP_RESULT]),
      ],
      usageRows,
    });

    await turn('search and open the first result');

    expect(usageRows.map((r) => r.tokensConsumed)).toEqual([300, 200, 100]);
    // The bundled price is flat PER TURN: the first row carries it, the rest say
    // it was already posted — the same split the read-back row uses.
    expect(usageRows.map((r) => r.bundledFlatCostAlreadyPosted)).toEqual([undefined, true, true]);
    expect((await sessions.get(seedId))?.tokenBudgetRemaining).toBe(100_000 - 600);
  });
});

describe('B1 — a best-effort wait that timed out does not stop a segment that asked to continue', () => {
  it('segmentRanToItsEnd: a failed WAIT is not a failed segment; anything else is', () => {
    const ok = (intent: AgentIntent): IntentResult => ({ kind: 'success', intent, summary: 'ok' });
    const failed = (intent: AgentIntent): IntentResult => ({
      kind: 'failure',
      intent,
      reason: 'x',
    });
    expect(segmentRanToItsEnd({ results: [ok(NAV), failed(SETTLE), ok(PAUSE)], ok: false })).toBe(
      true,
    );
    expect(segmentRanToItsEnd({ results: [ok(NAV), failed(TAP_SEND)], ok: false })).toBe(false);
    expect(segmentRanToItsEnd({ results: [ok(NAV)], ok: false, awaitingConfirmation: true })).toBe(
      false,
    );
    expect(segmentRanToItsEnd({ results: [ok(NAV)], ok: false, authorityLost: true })).toBe(false);
  });
});

describe('B1 — ⛔ a timed-out trailing wait is not a FAILED segment, and must not end the turn silently', () => {
  it('three segments that each end in a wait that times out spend NO recovery, and the turn that then stops says so', async () => {
    // The defect: the cause check asked "did the last step fail re-plannably?"
    // before "did the segment run to its end?", so a best-effort wait timing out
    // read as a failure. Three of them ended a healthy turn at three planning
    // calls, with `continue` still standing, no sentence, and no "not finished"
    // line for the next turn's planner.
    const h = harness();
    const { turn, sessions, seedId } = await makeRuntime(h, {
      plans: (call) =>
        segment(
          [
            { kind: 'scroll', direction: 'down', amount_px: 100 * call },
            { kind: 'wait', condition: 'selector_visible', selector: '#late', timeoutMs: 500 },
          ],
          'continue',
        ),
      executor: loopExecutor(h, {
        fails: (i) =>
          i.kind === 'wait'
            ? {
                kind: 'failure',
                intent: i,
                reason: 'the condition was not met in time',
                diagnosis: { category: 'condition_not_met', retryable: false },
              }
            : null,
      }),
    });

    const result = await turn('wait for the late panel and read it');

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.loop?.replans).toBe(0);
    expect(h.seen).toHaveLength(MAX_PLANNER_CALLS_PER_TURN);
    expect(result.loop?.stopped).toBe('planner_call_limit');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.planner_call_limit);
    const body = (await sessions.get(seedId))?.transcript.find(
      (e) => e.intents !== undefined,
    )?.body;
    expect(body).toContain('the task is NOT finished');
  });
});

describe('B6 — progress stays true across segments', () => {
  it('every later `plan` event says where in the turn it starts, and every step index is in the turn’s ONE list', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, {
      plans: [segment([NAV, SETTLE], 'continue'), segment([TYPE_QUERY, SHOT], 'done')],
    });

    await turn('search for a trail stove');

    expect(h.events.filter((e) => e.kind === 'plan')).toEqual([
      { kind: 'plan', intents: [NAV, SETTLE], total: 2, status: 'continue' },
      {
        kind: 'plan',
        intents: [TYPE_QUERY, SHOT],
        total: 4,
        offset: 2,
        segment: 2,
        status: 'done',
      },
    ]);
    expect(h.events.filter((e) => e.kind === 'step_start').map((e) => e.index)).toEqual([
      0, 1, 2, 3,
    ]);
    // The customer is told the agent is LOOKING and CONTINUING — not that it is
    // planning from scratch, and not that something went wrong.
    const later = h.events.filter((e) => e.kind === 'phase' && e.segment === 2);
    expect(later).toEqual([
      { kind: 'phase', phase: 'reading_page', segment: 2, cause: 'continue' },
      { kind: 'phase', phase: 'planning', segment: 2, cause: 'continue' },
    ]);
  });

  it('a stop at a bound is streamed as a `notice`, after the steps and never before them', async () => {
    const h = harness();
    const { turn } = await makeRuntime(h, { plans: neverDone });
    await turn('keep going');
    const notice = h.events.at(-1);
    expect(notice).toEqual({
      kind: 'notice',
      notice: TURN_LOOP_STOP_SENTENCES.planner_call_limit,
    });
  });
});

describe('B1 — the customer-visible sentences name no internals', () => {
  it.each(Object.entries(TURN_LOOP_STOP_SENTENCES))('%s', (_reason, sentence) => {
    expect(sentence).not.toMatch(
      /\b(fleet|node|control plane|harness|observer|vantage|segment|planner|model|token|digest|port)\b/i,
    );
    // Each one says the task is not done, and what to do next.
    expect(sentence).toMatch(/not finished|stopped/i);
  });
});
