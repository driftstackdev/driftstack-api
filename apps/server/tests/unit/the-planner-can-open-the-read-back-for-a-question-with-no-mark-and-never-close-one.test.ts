// I18N — A QUESTION WITH NO MARK STILL GETS ITS ANSWER, BECAUSE THE PLANNER SAID
// IT WAS ONE.
//
// The read-back gate's lexical half reads question marks in every script and
// English words. It cannot read "зайди на apteka.test и скажи, до скольки аптека
// работает в субботу" — an imperative a Russian customer writes with no mark —
// and it should not try: the common question words of most languages double as
// ordinary words, so a word list would buy read-backs for instructions. The
// planner already reads the customer's message in whatever language it is
// written in, so it says so on the plan: `answerWanted`.
//
// ⛔ TWO DIRECTIONS, AND ONLY ONE OF THEM IS ALLOWED.
//   · `answerWanted: true` OPENS the read-back for a question the lexical gate
//     missed.
//   · `answerWanted: false` NEVER CLOSES one the lexical gate saw. A model that
//     misjudged a plainly written question must not be able to leave the customer
//     with nothing — the P5 silence, brought back by the signal meant to end it.
// And every OTHER conjunct of the gate still binds: the flag widens "did they
// ask", never "can we answer".

import { describe, expect, it } from 'vitest';
import { AgentRuntime, asksForInformation } from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from '../../src/services/agent-executor.js';
import type {
  AgentIntent,
  DecomposeResult,
  PlanStatus,
} from '../../src/services/agent-decomposer.js';

const RUSSIAN_NO_MARK = 'зайди на apteka.test и скажи, до скольки аптека работает в субботу';
const CHINESE_NO_MARK = '打开 chaguan.test 的茶单，告诉我一壶西湖龙井多少钱';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://apteka.test/' };
const SETTLE: AgentIntent = { kind: 'wait', condition: 'idle' };
const TAP_HOURS: AgentIntent = { kind: 'interact', action: 'tap', selector: 'a[href="/chasy"]' };
const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

function plan(
  intents: AgentIntent[],
  opts: { status?: PlanStatus; answerWanted?: boolean } = {},
): DecomposeResult {
  return {
    kind: 'plan',
    intents,
    ...(opts.status !== undefined ? { status: opts.status } : {}),
    ...(opts.answerWanted !== undefined ? { answerWanted: opts.answerWanted } : {}),
    tokensConsumed: 100,
  };
}

async function turn(
  message: string,
  plans: DecomposeResult[],
  opts: { failAll?: boolean } = {},
): Promise<{ answer: string | undefined; unavailable: string | undefined; answerCalls: number }> {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-19T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  let looks = 0;
  const executor: AgentExecutor = {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> => {
      const results: IntentResult[] = [];
      for (const intent of args.plan.intents) {
        if (opts.failAll === true) {
          results.push({
            kind: 'failure',
            intent,
            reason: 'the page did not load',
            diagnosis: { category: 'unknown', retryable: false },
          });
          return Promise.resolve({ results, ok: false });
        }
        results.push({ kind: 'success', intent, summary: 'ok' });
      }
      return Promise.resolve({ results, ok: true });
    },
    observeDigest: () => {
      looks += 1;
      return Promise.resolve(`page as of look ${String(looks)}`);
    },
    observe: () => Promise.resolve('Суббота 09:00–18:00'),
  };
  let call = 0;
  let answerCalls = 0;
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (): Promise<DecomposeResult> => {
        const next = plans[Math.min(call, plans.length - 1)]!;
        call += 1;
        return Promise.resolve(next);
      },
      answerFromObservation: () => {
        answerCalls += 1;
        return Promise.resolve({
          answer: 'В субботу аптека работает до 18:00.',
          tokensConsumed: 40,
        });
      },
    },
    executor,
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
  });
  const result = await runtime.runTurn({
    agentSessionId: seed.id,
    userMessage: message,
    byokApiKey: 'sk-ant-test-fake-key',
  });
  if (result.kind !== 'plan-executed')
    throw new Error(`expected plan-executed, got ${result.kind}`);
  return { answer: result.answer, unavailable: result.readbackUnavailable, answerCalls };
}

describe('I18N — the planner can open the read-back for a question with no mark', () => {
  it('the premise: the lexical gate alone does NOT read these questions', () => {
    // Without this the arms below would prove nothing about the planner: a
    // lexical match would open the gate on its own.
    expect(asksForInformation(RUSSIAN_NO_MARK)).toBe(false);
    expect(asksForInformation(CHINESE_NO_MARK)).toBe(false);
  });

  it('⛔ a markless Russian question is ANSWERED when the planner says the customer wanted an answer', async () => {
    const { answer, answerCalls } = await turn(RUSSIAN_NO_MARK, [
      plan([NAV, TAP_HOURS, SETTLE], { status: 'done', answerWanted: true }),
    ]);
    expect(answerCalls).toBe(1);
    expect(answer).toBe('В субботу аптека работает до 18:00.');
  });

  it('and the SAME turn without the planner’s word stays silent — the flag is what opened it', async () => {
    const { answer, unavailable, answerCalls } = await turn(RUSSIAN_NO_MARK, [
      plan([NAV, TAP_HOURS, SETTLE], { status: 'done' }),
    ]);
    expect(answerCalls).toBe(0);
    expect(answer).toBeUndefined();
    expect(unavailable).toBeUndefined();
  });

  it('a planner that says it only on a LATER segment still opens it — the word is kept across the turn', async () => {
    const { answer, answerCalls } = await turn(CHINESE_NO_MARK, [
      // The blind first segment says nothing about it…
      plan([NAV, SETTLE], { status: 'continue' }),
      // …and the segment planned from the page does.
      plan([TAP_HOURS], { status: 'done', answerWanted: true }),
    ]);
    expect(answerCalls).toBe(1);
    expect(answer).toBeDefined();
  });

  it('a later segment that finds the answer ALREADY on the page — an empty `done` — still opens it', async () => {
    const { answerCalls } = await turn(CHINESE_NO_MARK, [
      plan([NAV, SETTLE], { status: 'continue' }),
      plan([], { status: 'done', answerWanted: true }),
    ]);
    expect(answerCalls).toBe(1);
  });

  it('a later segment saying `false` does not take back an earlier `true`', async () => {
    const { answerCalls } = await turn(CHINESE_NO_MARK, [
      plan([NAV, SETTLE], { status: 'continue', answerWanted: true }),
      plan([TAP_HOURS], { status: 'done', answerWanted: false }),
    ]);
    expect(answerCalls).toBe(1);
  });
});

describe('I18N — the planner can never CLOSE a question the lexical gate saw', () => {
  it.each([
    ['an English question', 'go to apteka.test and tell me when it closes on Saturday'],
    ['a Chinese question with its full-width mark', CHINESE_NO_MARK + '？'],
    ['a Russian question with its mark', RUSSIAN_NO_MARK + '?'],
  ])('⛔ `answerWanted: false` on %s still gets the answer', async (_label, message) => {
    expect(asksForInformation(message)).toBe(true);
    const { answer, answerCalls } = await turn(message, [
      plan([NAV, TAP_HOURS, SETTLE], { status: 'done', answerWanted: false }),
    ]);
    expect(answerCalls).toBe(1);
    expect(answer).toBeDefined();
  });
});

describe('I18N — the planner widens "did they ask", never "can we answer"', () => {
  it('a turn whose steps FAILED is not read back, whatever the planner said', async () => {
    const { answerCalls } = await turn(
      RUSSIAN_NO_MARK,
      [plan([NAV], { status: 'done', answerWanted: true })],
      { failAll: true },
    );
    expect(answerCalls).toBe(0);
  });

  it('a planner that does not speak the loop still needs a capture in the plan', async () => {
    // No status: the capture is the runtime's only sign the plan looked at the
    // result, and `answerWanted` does not stand in for it.
    const without = await turn(RUSSIAN_NO_MARK, [plan([NAV, TAP_HOURS], { answerWanted: true })]);
    expect(without.answerCalls).toBe(0);
    const withCapture = await turn(RUSSIAN_NO_MARK, [
      plan([NAV, TAP_HOURS, SHOT], { answerWanted: true }),
    ]);
    expect(withCapture.answerCalls).toBe(1);
  });
});
