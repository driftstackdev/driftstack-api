// THE TAPER, AND THE ONE PROPERTY THE WHOLE FEATURE'S SAFETY RESTS ON:
// inserted time runs out before the turn does. Always. By arithmetic.
//
// ⛔ THE FAILURE MODE THIS FORBIDS. A pacing policy that spent a flat share of
// each segment would, on a long turn, be the reason the turn hit its three
// minute ceiling — "the agent got slower and then it gave up", with no way for
// anyone to tell which of the two happened. The taper makes the answer
// structural: `budget = (remaining − reserve) × f` with f < 1 and clamped at
// zero, so a segment can only ever insert a FRACTION of what is left after the
// reserve, and the reserve is never reached. Past it the budget is exactly
// zero and the turn runs at fast.
//
// ⛔ THE CONSTANTS ARE RECOMPUTED HERE, NOT RESTATED. A test that copied the
// numbers would go green on the day somebody changed the numbers and the
// arithmetic stopped closing. Every assertion below is derived from the
// constants as they are, so the arms fail when a constant moves in a direction
// that breaks the property — and pass when it moves in one that does not.

import { describe, expect, it } from 'vitest';
import {
  PACE_FRACTION,
  PACE_MIN_PAUSE_MS,
  PACE_SEGMENT_CAP_MS,
  PACE_STEP_CAP_MS,
  PACE_TURN_RESERVE_MS,
  paceBaseCeilingMs,
  paceSegmentBudgetMs,
} from '../../src/services/agent-pace.js';
import { AgentRuntime, MAX_TURN_WALL_CLOCK_MS } from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from '../../src/services/agent-executor.js';
import type { DecomposeArgs, DecomposeResult } from '../../src/services/agent-decomposer.js';
import type { AiPaceBand } from '../../src/services/agent-pace.js';
import { STOP_IN_FLIGHT_GRACE_MS } from '../../src/services/agent-executor.js';
import { DRAWN_GAP_MAX_FACTOR } from '../../src/services/agent-executor-control-plane.js';
import type { AgentIntent } from '../../src/services/agent-decomposer.js';
import { budgetFor, draws, names, paceDevice, paceExecutor } from './_helpers/pace-harness.js';
import type { IntentDispatcher } from '../../src/services/agent-executor-control-plane.js';
import type { IntentDispatch } from '../../src/schemas/harness-control-protocol.js';

const BANDS = ['medium', 'slow'] as const;

const PLAN: AgentIntent[] = [
  { kind: 'navigate', url: 'https://shop.test/a' },
  { kind: 'interact', action: 'tap', selector: '#one' },
  { kind: 'navigate', url: 'https://shop.test/b' },
  { kind: 'interact', action: 'tap', selector: '#two' },
  { kind: 'navigate', url: 'https://shop.test/c' },
  { kind: 'interact', action: 'tap', selector: '#three' },
];

describe('the arithmetic', () => {
  it('CRITICAL every fraction is below 1 — the single fact that makes inserted time approach the reserve and never reach it', () => {
    for (const band of BANDS) {
      expect(PACE_FRACTION[band]).toBeGreaterThan(0);
      expect(PACE_FRACTION[band]).toBeLessThan(1);
    }
  });

  it('CRITICAL a turn that spends its WHOLE budget every segment still never crosses the reserve, and reaches a zero budget before the wall clock', () => {
    for (const band of BANDS) {
      // The adversarial turn: every segment inserts everything it is allowed to
      // and does no work at all, so elapsed time is pure inserted time. That is
      // the worst case for this property, not the typical one.
      let elapsed = 0;
      let segments = 0;
      let lastBudget = -1;
      for (;;) {
        const budget = paceSegmentBudgetMs({
          band,
          elapsedMs: elapsed,
          turnWallClockMs: MAX_TURN_WALL_CLOCK_MS,
        });
        // ⛔ THE BUDGET IS MONOTONE NON-INCREASING. A taper that could go back
        // up would let a late segment spend more than an early one, which is
        // the opposite of what the word means.
        if (lastBudget >= 0) expect(budget).toBeLessThanOrEqual(lastBudget);
        lastBudget = budget;
        if (budget === 0) break;
        elapsed += budget;
        segments += 1;
        // ⛔ AND THE RESERVE IS NEVER TOUCHED, checked after every single
        // segment rather than only at the end.
        expect(elapsed).toBeLessThan(MAX_TURN_WALL_CLOCK_MS - PACE_TURN_RESERVE_MS);
        // Anti-hang: the loop must terminate because the budget reaches zero,
        // not because a bound rescued it.
        expect(segments).toBeLessThan(10_000);
      }
      // It really did run out — and it ran out with the whole reserve, and more,
      // still unspent.
      expect(segments).toBeGreaterThan(0);
      expect(MAX_TURN_WALL_CLOCK_MS - elapsed).toBeGreaterThan(PACE_TURN_RESERVE_MS);
    }
  });

  it('CRITICAL the budget is already zero well before the turn ceiling — a turn near its clock inserts nothing at all', () => {
    for (const band of BANDS) {
      const zeroFrom = MAX_TURN_WALL_CLOCK_MS - PACE_TURN_RESERVE_MS;
      expect(
        paceSegmentBudgetMs({ band, elapsedMs: zeroFrom, turnWallClockMs: MAX_TURN_WALL_CLOCK_MS }),
      ).toBe(0);
      expect(
        paceSegmentBudgetMs({
          band,
          elapsedMs: MAX_TURN_WALL_CLOCK_MS,
          turnWallClockMs: MAX_TURN_WALL_CLOCK_MS,
        }),
      ).toBe(0);
      // And a segment starting at zero gets the cap or the fraction, whichever
      // is smaller — the formula, not a memory of it.
      const atStart = paceSegmentBudgetMs({
        band,
        elapsedMs: 0,
        turnWallClockMs: MAX_TURN_WALL_CLOCK_MS,
      });
      expect(atStart).toBe(
        Math.min(
          PACE_SEGMENT_CAP_MS[band],
          Math.floor((MAX_TURN_WALL_CLOCK_MS - PACE_TURN_RESERVE_MS) * PACE_FRACTION[band]),
        ),
      );
    }
  });

  it('CRITICAL an unusable clock degrades to NO PACE, never to an unbounded sleep inside a customer turn', () => {
    for (const band of BANDS) {
      expect(
        paceSegmentBudgetMs({
          band,
          elapsedMs: Number.NaN,
          turnWallClockMs: MAX_TURN_WALL_CLOCK_MS,
        }),
      ).toBe(0);
      expect(
        paceSegmentBudgetMs({
          band,
          elapsedMs: 0,
          turnWallClockMs: Number.POSITIVE_INFINITY,
        }),
      ).toBe(0);
    }
  });

  it('CRITICAL no single pause can outlast the grace a Stop gives an in-flight step — the reason the per-step cap is the number it is', () => {
    for (const band of BANDS) {
      // There is no cancel verb on the wire, so after a Stop abandons our wait
      // the device keeps pausing. 9 s under a 15 s grace is what keeps the next
      // turn's first dispatch from landing on a device still inside a dwell.
      expect(PACE_STEP_CAP_MS[band]).toBeLessThan(STOP_IN_FLIGHT_GRACE_MS);
      // And the cap is never REACHED: the base a draw is handed is lowered
      // until the band's own maximum multiplier lands under it, so a long page
      // does not pile every session onto one exact number.
      expect(
        Math.round(paceBaseCeilingMs(band, DRAWN_GAP_MAX_FACTOR) * DRAWN_GAP_MAX_FACTOR),
      ).toBeLessThanOrEqual(PACE_STEP_CAP_MS[band]);
      // A per-step cap below the minimum pause would make the band unreachable
      // rather than bounded.
      expect(PACE_STEP_CAP_MS[band]).toBeGreaterThan(PACE_MIN_PAUSE_MS);
    }
  });
});

describe('pace runs out of budget before a turn runs out of clock', () => {
  it('CRITICAL a segment given a small budget stops inserting and KEEPS GOING — it degrades to fast, it never fails', async () => {
    const d = paceDevice();
    // Enough for one pause and not two.
    const pace = budgetFor('slow', 4_000, { pageWordCount: 250 });
    const res = await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_budget',
      agentSessionId: 'agt_budget',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace,
    });
    expect(res.ok).toBe(true);
    // Every planned step still ran.
    expect(res.results).toHaveLength(PLAN.length);
    expect(names(d.sent).filter((n) => n === 'navigate')).toHaveLength(3);
    // The pauses that did happen fit inside the budget it was given.
    expect(pace.pausedMs).toBeLessThanOrEqual(4_000);
    expect(pace.segmentRemainingMs).toBeGreaterThanOrEqual(0);
  });

  it('CRITICAL a segment with NO budget behaves exactly like fast on the wire — same verbs, same order', async () => {
    const spent = paceDevice();
    await paceExecutor(spent.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_spent',
      agentSessionId: 'agt_spent',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace: budgetFor('slow', 0, { pageWordCount: 250 }),
    });
    const off = paceDevice();
    await paceExecutor(off.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_spent',
      agentSessionId: 'agt_spent',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
    });
    expect(names(spent.sent)).toEqual(names(off.sent));
    expect(names(spent.sent)).not.toContain('behavioral_pause');
  });

  it('CRITICAL NEGATIVE CONTROL — the SAME plan with a full budget does insert, so "it stopped" above is a budget fact and not a fixture that never paces', async () => {
    const d = paceDevice();
    const pace = budgetFor('slow', 30_000, { pageWordCount: 250 });
    await paceExecutor(d.dispatcher, { makeRandom: () => draws([0]) }).execute({
      sessionId: 'ses_full',
      agentSessionId: 'agt_full',
      plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
      pace,
    });
    expect(names(d.sent).filter((n) => n === 'behavioral_pause').length).toBeGreaterThan(1);
    expect(pace.pausedMs).toBeGreaterThan(0);
  });

  it('a pause is REFUSED rather than trimmed to what is left, so the last beat of a spent segment is not the same number every time', async () => {
    // ⛔ THE TRAP. Clamping to the remainder would make every turn end with a
    // pause of exactly the leftover — a constant, produced by the very
    // mechanism that exists to avoid constants. So the policy declines instead.
    const durations = new Set<number>();
    for (const seed of [0, 0.2, 0.45, 0.7, 0.99]) {
      const d = paceDevice();
      const pace = budgetFor('slow', 5_000, { pageWordCount: 250 });
      await paceExecutor(d.dispatcher, { makeRandom: () => draws([0, seed]) }).execute({
        sessionId: `ses_trim_${String(seed)}`,
        agentSessionId: `agt_trim_${String(seed)}`,
        plan: { kind: 'plan', intents: PLAN, tokensConsumed: 0 },
        pace,
      });
      for (const s of d.sent.filter((x) => x.name === 'behavioral_pause')) {
        durations.add(Number(s.params.duration_ms));
      }
      // Nothing was ever asked for that the budget did not have.
      expect(pace.pausedMs).toBeLessThanOrEqual(5_000);
    }
    // No pause equals the budget it was drawn against, which is what a trimmed
    // one would.
    expect(durations.has(5_000)).toBe(false);
    expect(durations.size).toBeGreaterThan(1);
  });
});

// ── THE RUNTIME SEAM: the taper is re-seeded per segment, from the turn's own
//    elapsed clock, and the flag is the only thing that turns it on ──────────

/** An executor that records the pace state it was handed, per segment. */
function recordingExecutor(runs: ExecuteArgs[], seenBudgets: Array<number | null>): AgentExecutor {
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      runs.push(args);
      seenBudgets.push(args.pace === undefined ? null : args.pace.segmentRemainingMs);
      const results: IntentResult[] = args.plan.intents.map((intent) => ({
        kind: 'success' as const,
        intent,
        summary: 'ok',
      }));
      return Promise.resolve({ results, ok: true });
    },
    observeDigest: (): Promise<string | null> => Promise.resolve('page: Shop\n#go · button'),
  };
}

async function runOneTurn(opts: {
  pace?: AiPaceBand;
  /** Milliseconds the runtime's monotonic clock advances on every read. A
   *  stepping clock is what makes the taper observable in one short test. */
  msPerClockRead: number;
  plans: DecomposeResult[];
}): Promise<{ runs: ExecuteArgs[]; budgets: Array<number | null> }> {
  const runs: ExecuteArgs[] = [];
  const budgets: Array<number | null> = [];
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_pace', tokenBudgetTotal: 100_000 });
  let tick = 0;
  let planned = 0;
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (_args: DecomposeArgs): Promise<DecomposeResult> => {
        const next = opts.plans[Math.min(planned, opts.plans.length - 1)];
        planned += 1;
        return Promise.resolve(next ?? DONE);
      },
    },
    executor: recordingExecutor(runs, budgets),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    nowMs: () => tick++ * opts.msPerClockRead,
    ...(opts.pace !== undefined ? { pace: opts.pace } : {}),
  });
  await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'go to the shop and tap go' });
  return { runs, budgets };
}

/** ⛔ EVERY SEGMENT'S PLAN MUST BE DISTINCT. The runtime's no-progress guard
 *  stops a turn that re-issues the same plan, so a fixture whose segments were
 *  identical would run ONE segment and every taper assertion below would be
 *  vacuously true of a single number. */
function segmentPlan(selector: string, status: 'continue' | 'done'): DecomposeResult {
  return {
    kind: 'plan',
    intents: [{ kind: 'interact', action: 'tap', selector }],
    tokensConsumed: 10,
    status,
  };
}

const DONE: DecomposeResult = segmentPlan('#done', 'done');
const SEGMENTS: DecomposeResult[] = [
  segmentPlan('#one', 'continue'),
  segmentPlan('#two', 'continue'),
  segmentPlan('#three', 'continue'),
  segmentPlan('#four', 'continue'),
  DONE,
];

describe('the runtime seam', () => {
  it('CRITICAL with the flag at its default the executor is threaded NO pace at all — not a band with a zero budget', async () => {
    const { runs } = await runOneTurn({ msPerClockRead: 0, plans: [DONE] });
    expect(runs.length).toBeGreaterThan(0);
    for (const run of runs) expect(run.pace).toBeUndefined();
  });

  it('CRITICAL an explicit `fast` is the same as the default — fast is the absence of a budget, not a band with one', async () => {
    const { runs } = await runOneTurn({ pace: 'fast', msPerClockRead: 0, plans: [DONE] });
    for (const run of runs) expect(run.pace).toBeUndefined();
  });

  it('CRITICAL the budget TAPERS across a turn\u2019s segments, computed from the turn\u2019s own elapsed clock', async () => {
    // A turn whose clock advances a long way between segments. Each segment
    // must get no more than the one before it, and a segment starting past the
    // reserve must get nothing.
    const { budgets } = await runOneTurn({
      pace: 'slow',
      msPerClockRead: 12_000,
      plans: SEGMENTS,
    });
    const seeded = budgets.filter((b): b is number => b !== null);
    expect(seeded.length).toBeGreaterThan(1);
    for (let i = 1; i < seeded.length; i += 1) {
      expect(seeded[i]).toBeLessThanOrEqual(seeded[i - 1] as number);
    }
    // The first segment got a real allowance and the last got none.
    expect(seeded[0]).toBeGreaterThan(0);
    expect(seeded.at(-1)).toBe(0);
  });

  it('the turn\u2019s pace object is ONE object across every segment — a per-segment budget would be three budgets and no taper', async () => {
    const { runs } = await runOneTurn({
      pace: 'slow',
      msPerClockRead: 1_000,
      plans: SEGMENTS,
    });
    const paced = runs.map((r) => r.pace).filter((p) => p !== undefined);
    expect(paced.length).toBeGreaterThan(1);
    for (const p of paced) expect(p).toBe(paced[0]);
  });

  it('the planner is told how much of the turn\u2019s clock is left, and it is a real remaining figure', async () => {
    const seen: DecomposeArgs[] = [];
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-17T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_ms', tokenBudgetTotal: 100_000 });
    let tick = 0;
    let planned = 0;
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
          seen.push(args);
          const next = SEGMENTS[Math.min(planned, SEGMENTS.length - 1)];
          planned += 1;
          return Promise.resolve(next ?? DONE);
        },
      },
      executor: recordingExecutor([], []),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      nowMs: () => tick++ * 4_000,
    });
    await runtime.runTurn({ agentSessionId: seed.id, userMessage: 'go' });
    const later = seen.filter((a) => a.turnProgress !== undefined);
    expect(later.length).toBeGreaterThan(0);
    for (const args of later) {
      const left = args.turnProgress?.msRemaining;
      expect(left).toBeDefined();
      expect(left as number).toBeGreaterThanOrEqual(0);
      expect(left as number).toBeLessThanOrEqual(MAX_TURN_WALL_CLOCK_MS);
    }
    // It is not a constant: the segment planned at 45 s in has less left than
    // the whole ceiling.
    expect(later[0]?.turnProgress?.msRemaining).toBeLessThan(MAX_TURN_WALL_CLOCK_MS);
  });
});

// ── REVIEW (S6, turn safety) — THE DISPATCH A BEAT CAN PUT BEHIND THE DEADLINE ──
//
// ⛔ THE INVARIANT THIS PROTECTS IS NOT PACE'S, IT IS THE STOP CLAIM'S.
// `agent-turn-bounds.ts` composes the longest turn the constants permit as
// hard stop + ONE dispatch deadline + read-back + answer stream, and says in
// its own words what makes that true: "`runIntent` asks this same hard stop
// before starting another attempt, which is what leaves exactly one dispatch
// past the deadline. Move that check and this number stops being true."
//
// `runIntent` deliberately does NOT refuse its FIRST attempt — "a null result
// is a step the loop above has just admitted past this same deadline" — so the
// premise is that nothing sits between the step loop's hard-stop check and the
// step's own first dispatch. A pacing beat sits exactly there, and a
// `behavioral_pause` carries a 315 s dispatch deadline of its own: a device
// that stops answering turns one beat into 315 s, AFTER which the look and the
// step's own dispatch still go out because the first attempt is never refused.
// That is a second dispatch deadline past the hard stop, which the claim TTL's
// margin is explicitly documented NOT to cover.
//
// The fix is the one the beat already applies to Stop: ask again afterwards.
// Returning here leaves nothing in flight — the beat settled, the step was
// never announced — so the "never cut off" invariant holds exactly as it does
// at the top of the loop.
describe('the turn’s hard stop, across an inserted beat', () => {
  const TAPS: AgentIntent[] = [
    { kind: 'interact', action: 'tap', selector: '#one' },
    { kind: 'interact', action: 'tap', selector: '#two' },
  ];
  const HARD_STOP_AT = 10_000;

  it('CRITICAL a beat that outlives the hard stop does not let the step behind it reach the wire', async () => {
    const d = paceDevice();
    let clock = HARD_STOP_AT - 1_000;
    // A device that holds the pause past the turn's hard stop — which is not a
    // pathological fixture: `behavioral_pause` is a SINGLE_CAP_LONG_INTENT and
    // its correlator deadline is 315,000 ms.
    const holdsThePause: IntentDispatcher = {
      dispatch: (frame: IntentDispatch) => {
        if (frame.intentName === 'behavioral_pause') clock = HARD_STOP_AT + 1_000;
        return d.dispatcher.dispatch(frame);
      },
    };
    const pace = budgetFor('slow', 30_000);
    const res = await paceExecutor(holdsThePause, {
      now: () => clock,
      // draw 1: step 0's chance (no page read yet, so no beat); draw 2: step
      // 1's chance, under the idle frequency; draw 3: that beat's duration.
      makeRandom: () => draws([0, 0, 0.5]),
    }).execute({
      sessionId: 'ses_hardstop_beat',
      agentSessionId: 'agt_hardstop_beat',
      plan: { kind: 'plan', intents: TAPS, tokensConsumed: 0 },
      pace,
      turnHardStopAtMs: HARD_STOP_AT,
    });
    const sent = names(d.sent);
    // ANTI-VACUITY: the beat really happened, so "nothing after it" is a fact
    // about the deadline and not about a fixture that never paced.
    expect(sent, 'the fixture inserted no beat at all').toContain('behavioral_pause');
    expect(
      sent.slice(sent.lastIndexOf('behavioral_pause') + 1),
      'a step reached the wire after the beat had already carried the turn past its hard stop',
    ).toEqual([]);
    expect(res.hardStopped).toBe(true);
    // The step that had already settled is still reported; only the one that
    // was never announced is dropped.
    expect(res.results).toHaveLength(1);
  });

  it('NEGATIVE CONTROL — the same plan and the same beat with the hard stop still ahead runs both steps', async () => {
    const d = paceDevice();
    const pace = budgetFor('slow', 30_000);
    const res = await paceExecutor(d.dispatcher, {
      now: () => HARD_STOP_AT - 1_000,
      makeRandom: () => draws([0, 0, 0.5]),
    }).execute({
      sessionId: 'ses_hardstop_ok',
      agentSessionId: 'agt_hardstop_ok',
      plan: { kind: 'plan', intents: TAPS, tokensConsumed: 0 },
      pace,
      turnHardStopAtMs: HARD_STOP_AT,
    });
    expect(names(d.sent)).toContain('behavioral_pause');
    expect(res.hardStopped).toBeUndefined();
    expect(res.results).toHaveLength(2);
    expect(res.ok).toBe(true);
  });
});
