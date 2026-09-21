// S10/§4.5 — a task that runs out of the AI credits set aside for it keeps its
// steps and says why.
//
// Running out of credits can land at three different moments in a turn, and the
// right answer is different at each one. The failure this file exists for is the
// single wrong answer that would cover all three: treating the refusal as an
// ordinary planner error.
//
//   · FIRST PLAN — nothing has happened. Ending the turn as a transient refuse
//     would tell the customer "the AI is briefly unavailable, send it again",
//     which is advice that cannot work and which buys a second refusal.
//   · A LATER SEGMENT — steps have RUN, possibly a submit. Throwing would reject
//     a turn whose work stands, and the customer would retry and do it twice.
//   · THE READ-BACK — every step has run and been published. Failing the turn
//     over the answer half would throw away a completed task.
//
// ⛔ AND THE RE-ASK IS THE TRAP. The runtime asks a malformed planning reply
// again, once. That re-ask is one more billable attempt, so it passes through
// admission like any other — and an admission refusal ON the re-ask must end the
// turn as credits, never as "the reply was malformed", which is the error the
// re-ask loop was holding when the refusal arrived.

import { describe, expect, it } from 'vitest';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import {
  AgentRuntime,
  AgentTurnCreditsExhaustedError,
  TURN_LOOP_STOP_SENTENCES,
  TURN_NOTICE_REASONS,
  classifyDecomposerError,
} from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from '../../src/services/agent-executor.js';
import {
  AgentDecomposerCreditsDeniedError,
  type AgentIntent,
  type DecomposeArgs,
  type DecomposeResult,
} from '../../src/services/agent-decomposer.js';
import type {
  AgentCreditDecision,
  AgentCreditMeter,
} from '../../src/services/agent-credit-meter.js';
import { classifyTurn } from '../../src/services/agent-turn-telemetry.js';

const NAV: AgentIntent = { kind: 'navigate', url: 'https://shop.test/' };
const SCROLL: AgentIntent = { kind: 'scroll', direction: 'down', amount_px: 600 };

function segment(intents: AgentIntent[], status?: 'continue' | 'done'): DecomposeResult {
  return {
    kind: 'plan',
    intents,
    ...(status !== undefined ? { status } : {}),
    tokensConsumed: 100,
  };
}

function greenExecutor(dispatched: AgentIntent[]): AgentExecutor {
  return {
    execute: (a: ExecuteArgs): Promise<ExecutorRunResult> => {
      const results: IntentResult[] = [];
      for (const intent of a.plan.intents) {
        dispatched.push(intent);
        results.push({ kind: 'success', intent, summary: `did ${intent.kind}` });
      }
      return Promise.resolve({ results, ok: true });
    },
    observeDigest: () => Promise.resolve('a page'),
    observe: () => Promise.resolve('Weight: 312 g'),
  };
}

/** A meter that refuses from the n-th attempt on (1-based), admitting before it. */
function refusingFrom(n: number, seen: number[] = []): AgentCreditMeter {
  let attempts = 0;
  return {
    kind: 'enforce',
    // S11 — the meter names its task so the usage row can carry the join.
    reservationId: 'res-out-of-credits',
    admit: (attempt): Promise<AgentCreditDecision> => {
      attempts += 1;
      seen.push(attempts);
      if (attempts >= n) {
        return Promise.resolve({ outcome: 'refused' as const, reason: 'did_not_fit' });
      }
      return Promise.resolve({
        outcome: 'admitted' as const,
        call: {
          maxOutputTokens: attempt.maxOutputTokens,
          markSent: () => Promise.resolve(true),
          settle: () => Promise.resolve(),
        },
      });
    },
  };
}

async function runtimeWith(opts: {
  plans: DecomposeResult[] | ((call: number) => DecomposeResult | Promise<DecomposeResult>);
  dispatched: AgentIntent[];
  seen: DecomposeArgs[];
  answers?: { n: number };
}) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (a: DecomposeArgs): Promise<DecomposeResult> => {
        opts.seen.push(a);
        const call = opts.seen.length;
        const next =
          typeof opts.plans === 'function'
            ? opts.plans(call)
            : opts.plans[Math.min(call - 1, opts.plans.length - 1)];
        return Promise.resolve(next ?? segment([SCROLL], 'done'));
      },
      answerFromObservation: (a) => {
        if (opts.answers !== undefined) opts.answers.n += 1;
        // The read-back is a billable attempt: it asks the same question.
        if (a.creditMeter !== undefined) {
          return a.creditMeter
            .admit({
              purpose: 'answer',
              model: 'claude-opus-4-7',
              regions: {
                oneHourRegionBytes: 0,
                fiveMinuteRegionBytes: 0,
                uncachedRegionBytes: 900,
              },
              maxOutputTokens: 4096,
              historyBytes: 0,
            })
            .then((decision) => {
              if (decision.outcome === 'refused') {
                throw new AgentDecomposerCreditsDeniedError(decision.reason);
              }
              return { answer: 'It weighs 312 g.', tokensConsumed: 40 };
            });
        }
        return Promise.resolve({ answer: 'It weighs 312 g.', tokensConsumed: 40 });
      },
    },
    executor: greenExecutor(opts.dispatched),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
  });
  return {
    sessions,
    seedId: seed.id,
    turn: (userMessage: string, creditMeter?: AgentCreditMeter) =>
      runtime.runTurn({
        agentSessionId: seed.id,
        userMessage,
        byokApiKey: 'sk-ant-test-fake-key',
        ...(creditMeter !== undefined ? { creditMeter } : {}),
      }),
  };
}

describe('a task that runs out of credits keeps its steps and says why', () => {
  it('CRITICAL a FIRST plan that is refused ends the turn before any call, typed for the route to map', async () => {
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const { turn } = await runtimeWith({
      plans: (): DecomposeResult => {
        throw new AgentDecomposerCreditsDeniedError('did_not_fit');
      },
      dispatched,
      seen,
    });

    const err = await turn('open the shop', refusingFrom(1)).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AgentTurnCreditsExhaustedError);
    expect((err as AgentTurnCreditsExhaustedError).reason).toBe('did_not_fit');
    // ⛔ NOTHING RAN. Not a step, not a second planning call.
    expect(dispatched).toEqual([]);
    expect(seen).toHaveLength(1);
  });

  it('CRITICAL a first-plan refusal is not re-read as "the AI is briefly unavailable"', async () => {
    // The default classification of an unknown planner error is `transient`,
    // which the runtime answers with a refuse telling the customer to send the
    // message again. That would be false advice AND a second refused turn, so
    // the typed reading must come first.
    expect(classifyDecomposerError(new AgentDecomposerCreditsDeniedError('did_not_fit'))).toBe(
      'transient',
    );
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const { turn } = await runtimeWith({
      plans: (): DecomposeResult => {
        throw new AgentDecomposerCreditsDeniedError('did_not_fit');
      },
      dispatched,
      seen,
    });
    const result = await turn('open the shop', refusingFrom(1)).catch(() => null);
    expect(result).toBeNull();
  });

  it('CRITICAL an admission refusal ON THE ONE RE-ASK of a malformed reply ends the turn as credits, not as a malformed reply', async () => {
    // The real adapter, so the re-ask really is a second billable attempt going
    // through admission. Attempt 1 answers with a reply nobody can read; the
    // runtime re-asks; attempt 2 is refused by the meter.
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const attempts: number[] = [];
    const bodies: string[] = [];
    const decomposer = new ClaudeAgentDecomposer({
      fetch: (_u: unknown, init?: RequestInit) => {
        bodies.push(typeof init?.body === 'string' ? init.body : '');
        return Promise.resolve(
          new Response(
            JSON.stringify({
              content: [{ type: 'text', text: 'not JSON at all' }],
              usage: { input_tokens: 10, output_tokens: 5 },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          ),
        );
      },
    });
    const runtime = new AgentRuntime({
      decomposer,
      executor: greenExecutor([]),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });

    const err = await runtime
      .runTurn({
        agentSessionId: seed.id,
        userMessage: 'open the shop',
        byokApiKey: 'sk-ant-test-fake-key',
        creditMeter: refusingFrom(2, attempts),
      })
      .catch((e: unknown) => e);

    // Attempt 1 was admitted and sent; the re-ask asked again and was refused.
    expect(attempts).toEqual([1, 2]);
    expect(bodies).toHaveLength(1);
    expect(err).toBeInstanceOf(AgentTurnCreditsExhaustedError);
  });

  it('CRITICAL a LATER segment refused keeps every step that ran and says why, on a plan that asked to continue', async () => {
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const meter = refusingFrom(2);
    const { turn } = await runtimeWith({
      plans: (call): DecomposeResult => {
        if (call === 1) return segment([NAV, SCROLL], 'continue');
        throw new AgentDecomposerCreditsDeniedError('did_not_fit');
      },
      dispatched,
      seen,
    });

    const result = await turn('open the shop and scroll', meter);

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    // ⛔ THE STEPS STAND.
    expect(dispatched).toEqual([NAV, SCROLL]);
    expect(result.executor.results).toHaveLength(2);
    expect(result.loop?.stopped).toBe('credits_used');
    expect(result.notice).toBe(TURN_LOOP_STOP_SENTENCES.credits_used);
    expect(result.notice).toMatch(/used all the AI credits set aside for it/);
    expect(result.notice).toMatch(/not finished/);
    expect(result.noticeReason).toBe(TURN_NOTICE_REASONS.credits_used);
  });

  it('CRITICAL it says so after a FAILED step too, where the ✗ row cannot say it', async () => {
    // ⛔ THE CONTINUE-ONLY RULE DOES NOT REACH THIS ENDING. It exists because
    // after a failed step the ✗ row is the message — and that row says what went
    // wrong with a STEP. It says nothing about the re-plan that would have
    // recovered from it being refused for want of credits, so without this the
    // customer sees a failed step and no reason the agent stopped trying.
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_1', tokenBudgetTotal: 100_000 });
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: (a: DecomposeArgs): Promise<DecomposeResult> => {
          seen.push(a);
          if (seen.length === 1) return Promise.resolve(segment([NAV, SCROLL]));
          throw new AgentDecomposerCreditsDeniedError('did_not_fit');
        },
      },
      executor: {
        execute: (a: ExecuteArgs): Promise<ExecutorRunResult> => {
          const results: IntentResult[] = [];
          for (const intent of a.plan.intents) {
            dispatched.push(intent);
            if (intent === SCROLL) {
              results.push({
                kind: 'failure',
                intent,
                reason: 'the page would not scroll',
                diagnosis: { category: 'element_not_found', retryable: true },
              });
              return Promise.resolve({ results, ok: false });
            }
            results.push({ kind: 'success', intent, summary: 'did navigate' });
          }
          return Promise.resolve({ results, ok: true });
        },
        observeDigest: () => Promise.resolve('a page'),
        observe: () => Promise.resolve('some text'),
      },
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });

    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'open the shop and scroll',
      byokApiKey: 'sk-ant-test-fake-key',
      creditMeter: refusingFrom(2),
    });

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(seen).toHaveLength(2);
    expect(result.executor.ok).toBe(false);
    expect(result.loop?.stopped).toBe('credits_used');
  });

  it('CRITICAL a refused segment is filed as a death the telemetry already has a word for (L1)', async () => {
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const { turn } = await runtimeWith({
      plans: (call): DecomposeResult => {
        if (call === 1) return segment([NAV], 'continue');
        throw new AgentDecomposerCreditsDeniedError('did_not_fit');
      },
      dispatched,
      seen,
    });
    const result = await turn('open the shop', refusingFrom(2));

    // No migration: `death_reason` is a CHECK-constrained column and this ending
    // is filed under the word that is true of it and already exists.
    const classified = classifyTurn({
      status: 200,
      body: {},
      result,
      sawPlanning: true,
      sawAnswering: false,
    });
    expect(classified).toMatchObject({ outcome: 'failed', deathReason: 'budget_exhausted' });
  });

  it('CRITICAL a READ-BACK that is refused is skipped, not failed: the steps stand and the question is answered about', async () => {
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const answers = { n: 0 };
    const { turn, sessions, seedId } = await runtimeWith({
      plans: [segment([NAV], 'done')],
      dispatched,
      seen,
      answers,
    });

    // The scripted planner does not meter itself, so the read-back — which does
    // — is the first attempt this meter sees, and it is refused.
    const result = await turn('open the shop — how much does the stove weigh?', refusingFrom(1));

    if (result.kind !== 'plan-executed') throw new Error('type narrow');
    expect(result.executor.ok).toBe(true);
    expect(dispatched).toEqual([NAV]);
    expect(answers.n).toBe(1);
    // The turn is not failed, and the customer is told which of the two things
    // happened — not the generic "it did not complete", which reads as a fault.
    expect(result.readbackUnavailable).toBe(
      'I finished the steps above, but this task ran out of AI credits before I could answer your question.',
    );
    const session = await sessions.get(seedId);
    expect(session?.transcript.at(-1)?.body).toBe(result.readbackUnavailable);
  });

  it('CRITICAL a turn given NO meter hands none on, and no model call is ever metered', async () => {
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const { turn } = await runtimeWith({
      plans: [segment([NAV], 'continue'), segment([SCROLL], 'done')],
      dispatched,
      seen,
    });

    const result = await turn('open the shop and scroll');

    expect(result.kind).toBe('plan-executed');
    // ⛔ EVERY planner call this turn made — the first plan and the re-plan —
    // carried no meter. An own-key turn is exactly this shape: the route gives
    // the runtime no meter, so nothing about credits is reachable from it.
    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call.creditMeter).toBeUndefined();
  });

  it('CRITICAL a turn given a meter hands THAT meter to every call it makes', async () => {
    const dispatched: AgentIntent[] = [];
    const seen: DecomposeArgs[] = [];
    const answers = { n: 0 };
    const meter = refusingFrom(99);
    const { turn } = await runtimeWith({
      plans: [segment([NAV], 'continue'), segment([SCROLL], 'done')],
      dispatched,
      seen,
      answers,
    });

    await turn('open the shop and scroll — what does it weigh?', meter);

    expect(seen).toHaveLength(2);
    for (const call of seen) expect(call.creditMeter).toBe(meter);
    // And the read-back, which is a model call like any other.
    expect(answers.n).toBe(1);
  });
});
