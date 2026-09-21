// P1 — a planning reply nobody could read is asked again, ONCE.
//
// THE MEASURED FAILURE (live, 2026-09-20). 2 of 170 turns on the production
// default model died on a planner reply that was not valid JSON — one ran away
// to the 8,192-token output ceiling and one was simply malformed. A cheaper
// model did it 6 times in 170. The customer saw a turn that never started: no
// steps, no answer, a 5xx.
//
// WHY A RETRY IS SOUND HERE AND ALMOST NOWHERE ELSE. Planning has NO SIDE
// EFFECTS. Nothing has been dispatched, nothing on the page has moved, so asking
// the same question again cannot do anything twice. That reasoning does not
// extend to a rejected key, a 4xx, a throttle, or the ANSWER call — see the
// negative controls below and the note at the read-back's own catch.
//
// ⛔ NEVER A FREE CALL, and half this file is about that. The retry is a real
// provider call: it is billed, it is debited, it counts against the turn's
// planner-call and model-call caps, and it runs on the turn's clock. A second
// unreadable reply fails the turn exactly as today, on the same error.

import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  MAX_MALFORMED_PLAN_RETRIES,
  MAX_PLANNER_CALLS_PER_TURN,
  MAX_TURN_WALL_CLOCK_MS,
  plannerReplyWasMalformed,
  classifyDecomposerError,
} from '../../src/services/agent-runtime.js';
import { AgentDecomposerSettledError } from '../../src/services/agent-decomposer.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import { StubAgentExecutor } from '../../src/services/agent-executor.js';
import type {
  AgentIntent,
  DecomposeArgs,
  DecomposeResult,
  DecomposeUsage,
} from '../../src/services/agent-decomposer.js';

const SHOT: AgentIntent = { kind: 'capture', capture: 'screenshot' };

const USAGE: DecomposeUsage = {
  decomposerKind: 'claude',
  anthropicInputTokens: 30,
  anthropicOutputTokens: 10,
  costUsdCents: 1,
  model: 'claude-opus-4-8',
};

/** The provider answered, was paid for, and the content codec refused it. */
function unreadable(
  message = 'Anthropic response was not valid JSON',
): AgentDecomposerSettledError {
  return new AgentDecomposerSettledError(message, { tokensConsumed: 40, usage: USAGE });
}

/** The same class as it arrives when the reply stopped at the output ceiling. */
function truncated(): AgentDecomposerSettledError {
  return unreadable(
    'Anthropic response was not valid JSON (the reply was cut off at the output limit)',
  );
}

interface Harness {
  calls: number;
  usageRows: Array<{ tokensConsumed: number }>;
}

async function runtimeFor(opts: {
  h: Harness;
  plan: (call: number, args: DecomposeArgs) => DecomposeResult | Error;
  nowMs?: () => number;
  tokenBudgetTotal?: number;
}) {
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
  const seed = await sessions.create({
    accountId: 'acc_p1',
    tokenBudgetTotal: opts.tokenBudgetTotal ?? 100_000,
  });
  const runtime = new AgentRuntime({
    decomposer: {
      decompose: (args: DecomposeArgs): Promise<DecomposeResult> => {
        opts.h.calls += 1;
        const next = opts.plan(opts.h.calls, args);
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
    executor: new StubAgentExecutor(),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    usageRecorder: {
      record: (row) => {
        opts.h.usageRows.push({ tokensConsumed: row.tokensConsumed });
        return Promise.resolve();
      },
    },
    ...(opts.nowMs !== undefined ? { nowMs: opts.nowMs } : {}),
  });
  return {
    sessions,
    seedId: seed.id,
    turn: () => runtime.runTurn({ agentSessionId: seed.id, userMessage: 'take a screenshot' }),
  };
}

describe('P1 — plannerReplyWasMalformed names exactly the paid-but-unreadable class', () => {
  it('the unreadable-reply messages are in, and they are the same set classifyDecomposerError calls fatal', () => {
    for (const message of [
      'Anthropic response was not valid JSON',
      'Anthropic response was not valid JSON (the reply was cut off at the output limit)',
      'Anthropic response missing text content block',
      'Anthropic response was not a JSON object',
      'Anthropic response has unknown result kind',
      'Anthropic clarify response missing clarifyingQuestion',
      'Anthropic refuse response missing refuseReason',
      'OpenRouter response content was invalid',
    ]) {
      expect(plannerReplyWasMalformed(new Error(message)), message).toBe(true);
      // ⛔ THE TWO READERS MUST BE ABOUT ONE SET. If they ever diverge, a turn
      // either retries something it should not or fails a reply it could have
      // re-asked for — and nothing would say which.
      expect(classifyDecomposerError(new Error(message)), message).toBe('fatal');
    }
  });

  it('⛔ NEGATIVE CONTROL: a status, a throttle, a key rejection and a network fault are NOT this class', () => {
    for (const message of [
      'Anthropic API 400: invalid_request_error',
      'Anthropic API 401: authentication_error',
      'Anthropic API 429: rate_limit_error',
      'Anthropic API 529: overloaded',
      'fetch failed',
      'ECONNRESET',
      'no Anthropic API key configured',
    ]) {
      expect(plannerReplyWasMalformed(new Error(message)), message).toBe(false);
    }
    // Including a 4xx whose BODY quotes one of the phrases: the status is what
    // it is about, and a body is the provider's words, not ours.
    expect(
      plannerReplyWasMalformed(new Error('Anthropic API 400: response was not valid JSON')),
    ).toBe(false);
    // ⛔ AND IN THE OTHER LANE'S SPELLING, which is the one this screen used to
    // miss. `OpenRouter response ...` errors are in the class above, so the
    // status screen has to cover `OpenRouter API 400:` too — otherwise a request
    // that was wrong the first time buys a second paid call whenever the
    // provider's own words happen to quote one of the phrases.
    for (const message of [
      'OpenRouter API 400: response_format was not a JSON object',
      'OpenRouter API 401: no auth credentials found',
      'OpenRouter API 402: the OpenRouter account is out of credits',
      'DeepSeek API 400: the request body was not valid JSON',
    ]) {
      expect(plannerReplyWasMalformed(new Error(message)), message).toBe(false);
    }
    // Non-vacuity: the same lane's genuinely unreadable reply is still in class,
    // so the screen narrows by STATUS and not by provider name.
    expect(
      plannerReplyWasMalformed(new Error('OpenRouter response envelope was not a JSON object')),
    ).toBe(true);
    expect(plannerReplyWasMalformed('not an error at all')).toBe(false);
  });
});

describe('P1 — one unreadable reply is asked again and the turn succeeds', () => {
  it('CRITICAL garbage once, then a good plan: the turn runs, with TWO planner calls counted and BOTH billed', async () => {
    const h: Harness = { calls: 0, usageRows: [] };
    const { turn, sessions, seedId } = await runtimeFor({
      h,
      plan: (call) =>
        call === 1
          ? unreadable()
          : { kind: 'plan', intents: [SHOT], status: 'done', tokensConsumed: 100, usage: USAGE },
    });

    const result = await turn();
    expect(result.kind).toBe('plan-executed');
    expect(h.calls).toBe(2);
    // ⛔ NEVER A FREE CALL: the discarded reply has its own usage row and its own
    // debit, taken BEFORE the second attempt was made.
    expect(h.usageRows.map((row) => row.tokensConsumed)).toEqual([40, 100]);
    expect((await sessions.get(seedId))?.tokenBudgetRemaining).toBe(100_000 - 40 - 100);
    // …and the turn says it retried, on its own line.
    if (result.kind !== 'plan-executed') throw new Error('narrow');
    expect(result.loop?.plannerRetries).toBe(MAX_MALFORMED_PLAN_RETRIES);
    expect(result.loop?.plannerCalls).toBe(2);
  });

  it('a reply cut off at the OUTPUT CEILING is treated exactly the same', async () => {
    // One of the two measured deaths was a run-away to the 8,192-token limit.
    // It arrives as the same class with a note appended, and the note must not
    // make it a different decision.
    const h: Harness = { calls: 0, usageRows: [] };
    const { turn } = await runtimeFor({
      h,
      plan: (call) =>
        call === 1
          ? truncated()
          : { kind: 'plan', intents: [SHOT], status: 'done', tokensConsumed: 100, usage: USAGE },
    });
    expect((await turn()).kind).toBe('plan-executed');
    expect(h.calls).toBe(2);
  });

  it('the RETRY SENDS THE SAME REQUEST — no prompt change, no different model, no backoff', async () => {
    const seen: DecomposeArgs[] = [];
    const h: Harness = { calls: 0, usageRows: [] };
    const { turn } = await runtimeFor({
      h,
      plan: (call, args) => {
        seen.push(args);
        return call === 1
          ? unreadable()
          : { kind: 'plan', intents: [SHOT], status: 'done', tokensConsumed: 100, usage: USAGE };
      },
    });
    await turn();
    expect(seen).toHaveLength(2);
    // The only thing that differs between the two attempts is the sample.
    const scrub = (args: DecomposeArgs) => ({
      task: args.task,
      archetype: args.archetype,
      model: args.model,
      budgetTokensRemaining: args.budgetTokensRemaining,
      history: args.history,
      observation: args.observation,
      turnProgress: args.turnProgress,
    });
    expect(scrub(seen[1]!)).toEqual(scrub(seen[0]!));
  });
});

describe('P1 — a second unreadable reply fails the turn exactly as today', () => {
  it('CRITICAL garbage twice: the same error, two calls, two rows, two debits', async () => {
    const h: Harness = { calls: 0, usageRows: [] };
    const second = unreadable('Anthropic response has unknown result kind');
    const { turn, sessions, seedId } = await runtimeFor({
      h,
      plan: (call) => (call === 1 ? unreadable() : second),
    });

    // ⛔ THE SECOND ERROR IS WHAT ENDS THE TURN — the one that actually ended
    // it, not a remembered copy of the first.
    await expect(turn()).rejects.toBe(second);
    expect(h.calls).toBe(2);
    expect(h.usageRows).toHaveLength(2);
    expect((await sessions.get(seedId))?.tokenBudgetRemaining).toBe(100_000 - 80);
    // The session survives, and nothing but the customer's own message is in
    // the transcript — today's behaviour, unchanged.
    const after = await sessions.get(seedId);
    expect(after?.status).toBe('active');
    expect(after?.transcript).toHaveLength(1);
  });

  it('⛔ MUTATION ARM: three unreadable replies do NOT buy a third call', async () => {
    const h: Harness = { calls: 0, usageRows: [] };
    const { turn } = await runtimeFor({ h, plan: () => unreadable() });
    await expect(turn()).rejects.toThrow(/not valid JSON/);
    expect(h.calls).toBe(1 + MAX_MALFORMED_PLAN_RETRIES);
    expect(MAX_MALFORMED_PLAN_RETRIES).toBe(1);
  });
});

describe('P1 — negative controls: what is NOT retried', () => {
  it('⛔ a 4xx is not retried — the request is wrong, and re-sending it is wrong again', async () => {
    const h: Harness = { calls: 0, usageRows: [] };
    const { turn } = await runtimeFor({
      h,
      plan: () => new Error('Anthropic API 400: invalid_request_error'),
    });
    await expect(turn()).rejects.toThrow(/Anthropic API 400/);
    expect(h.calls).toBe(1);
  });

  it('⛔ a transient fault is not retried HERE — it already degrades to a refuse, with the adapter’s own backoff behind it', async () => {
    const h: Harness = { calls: 0, usageRows: [] };
    const { turn } = await runtimeFor({ h, plan: () => new Error('fetch failed') });
    const result = await turn();
    expect(result.kind).toBe('refuse');
    expect(h.calls).toBe(1);
  });

  it('CRITICAL ⛔ the retry runs on the turn’s CLOCK: past the wall clock, the first unreadable reply ends it', async () => {
    // The turn's own bound, asked again. A retry outside it would let an
    // unreadable reply extend a turn past the ceiling the customer is waiting
    // against.
    const h: Harness = { calls: 0, usageRows: [] };
    let ticks = 0;
    const { turn } = await runtimeFor({
      h,
      // Time jumps past the wall clock while the first call is in flight.
      nowMs: () => (ticks++ === 0 ? 0 : MAX_TURN_WALL_CLOCK_MS + 1),
      plan: (call) =>
        call === 1
          ? unreadable()
          : { kind: 'plan', intents: [SHOT], status: 'done', tokensConsumed: 100, usage: USAGE },
    });
    await expect(turn()).rejects.toThrow(/not valid JSON/);
    expect(h.calls, 'a turn that is out of time does not start another call').toBe(1);
    // The discarded reply is still billed — the call happened.
    expect(h.usageRows).toHaveLength(1);
  });

  it('CRITICAL ⛔ the retry respects the customer’s STOP', async () => {
    const h: Harness = { calls: 0, usageRows: [] };
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_stop', tokenBudgetTotal: 100_000 });
    // Declared before the decomposer that reaches back into it: the Stop has
    // to come from the product's own path, and that path is a method on the
    // runtime the turn is running under.
    const runtime: AgentRuntime = new AgentRuntime({
      decomposer: {
        decompose: async (): Promise<DecomposeResult> => {
          h.calls += 1;
          // The customer presses Stop while the call is in flight, through the
          // product's own path — the turn runs under a controller the runtime
          // owns, not under a signal a caller hands it.
          await runtime.requestTurnStop(seed.id);
          throw unreadable();
        },
      },
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
    });
    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'take a screenshot',
    });
    expect(h.calls, 'a stopped turn does not start another provider call').toBe(1);
    expect(result.kind).toBe('stopped');
  });

  it('CRITICAL ⛔ the retry respects AUTHORITY: control that changed hands mid-call gets no second call', async () => {
    // ⛔ THIS IS THE RACE THE GATE WAS ADDED FOR. The unreadable reply can land
    // after the admitted controller has been replaced; a retry there would
    // start a provider call on a turn the successor owns, charge it to this
    // session, and replace the typed conflict contract with whatever came back.
    const h: Harness = { calls: 0, usageRows: [] };
    const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-20T00:00:00Z'));
    const seed = await sessions.create({ accountId: 'acc_auth', tokenBudgetTotal: 100_000 });
    const runtime = new AgentRuntime({
      decomposer: {
        decompose: async (): Promise<DecomposeResult> => {
          h.calls += 1;
          // Control changes hands while the call is in flight.
          await sessions.setModeIfActive(seed.id, 'manual', null);
          await sessions.setModeIfActive(seed.id, 'ai', null);
          throw unreadable();
        },
      },
      executor: new StubAgentExecutor(),
      sessions,
      archetype: 'iphone16pro_ios18_7_safari26_4',
      usageRecorder: {
        record: (row) => {
          h.usageRows.push({ tokensConsumed: row.tokensConsumed });
          return Promise.resolve();
        },
      },
    });
    const result = await runtime.runTurn({
      agentSessionId: seed.id,
      userMessage: 'take a screenshot',
    });
    expect(h.calls).toBe(1);
    expect(result.kind).toBe('ai-control-unavailable');
    // The one call that DID happen is still billed.
    expect(h.usageRows).toHaveLength(1);
  });
});

describe('P1 — the retry is counted, so the turn has fewer calls left', () => {
  it('CRITICAL a retried turn reaches the planner-call limit one segment sooner', async () => {
    // ⛔ THE "NEVER A FREE CALL" PROPERTY, STATED AS A DIFFERENCE BETWEEN TWO
    // RUNS rather than as a number. A planner that never says `done` is stopped
    // only by the call cap, so the number of SEGMENTS it gets is exactly the
    // budget it was left — and a turn that spent one call on an unreadable
    // reply must get one fewer.
    const segments = async (withRetry: boolean): Promise<number> => {
      const h: Harness = { calls: 0, usageRows: [] };
      let planned = 0;
      const { turn } = await runtimeFor({
        h,
        plan: (call) => {
          if (withRetry && call === 1) return unreadable();
          planned += 1;
          return {
            kind: 'plan',
            // A DIFFERENT harmless step each time, so only a bound can stop it.
            intents: [{ kind: 'scroll', direction: 'down', amount_px: 100 * planned }],
            status: 'continue',
            tokensConsumed: 100,
            usage: USAGE,
          };
        },
      });
      const result = await turn();
      expect(result.kind).toBe('plan-executed');
      if (result.kind !== 'plan-executed') throw new Error('narrow');
      expect(result.loop?.stopped).toBe('planner_call_limit');
      return planned;
    };

    const without = await segments(false);
    const withOne = await segments(true);
    expect(without).toBe(MAX_PLANNER_CALLS_PER_TURN);
    expect(withOne, 'the retry was charged to the same budget the segments spend').toBe(
      MAX_PLANNER_CALLS_PER_TURN - 1,
    );
  });
});
