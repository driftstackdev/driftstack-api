// #16 — ONE RE-ASK PER PLANNING STEP IN TOTAL, AND THE RE-ASK IS A CALL THE
// TURN'S CAPS COUNT.
//
// Two layers re-ask an unreadable planning reply: the OpenAI-compatible adapter,
// INSIDE its call (the same messages plus one corrective line, at a raised
// ceiling when the family has one), and the runtime, around the whole call
// (`planWithOneRetryOnMalformedReply`). Stacked, they made FOUR provider calls
// for one planning step — the audit (s13/s14 finding 16) measured it, and live
// run 30 (2026-09-22, routed GPT family, L-SAFE-LATE reps 5, 7 and 9) shows it:
// every turn that failed there spent four plan calls on its last step. And the
// runtime counted each call as one, so a turn capped at seven calls made twelve.
//
// ⛔ THE ANSWER CALL IS NEVER RE-ASKED, by either layer. The runtime decided that
// at the read-back's own catch (the plan result is the fallback); the adapter's
// answer retry is removed rather than counted, because it bought nothing: runs 22
// and 30 made 280 answer calls on the family the retry was built for and not one
// came back unusable.
//
// These run the REAL adapter under the REAL runtime, against a stand-in that
// speaks the chat-completions wire: no key, no network, no spend.

import { describe, expect, it } from 'vitest';
import {
  AgentRuntime,
  MAX_MODEL_CALLS_PER_TURN,
  MAX_PLANNER_CALLS_PER_TURN,
} from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  OpenAICompatibleAgentDecomposer,
  type ChatCompletionsTarget,
} from '../../src/services/agent-decomposer-openai-compatible.js';
import type { DecomposeArgs } from '../../src/services/agent-decomposer.js';
import type {
  AgentExecutor,
  ExecuteArgs,
  ExecutorRunResult,
  IntentResult,
} from '../../src/services/agent-executor.js';
import {
  chatStandInProvider,
  type ChatStandInModel,
  type ChatStandInReply,
} from '../eval/_lib/stand-in-chat-provider.js';

const KEY = 'sk-standin-not-real';
const RETRY_LINE_PREFIX = 'Your last reply could not be used';
const GARBLED: ChatStandInReply = { kind: 'reply', text: 'Sure! First I will open the page.' };
// Valid JSON of the wrong shape: the answer parser's own recovery keeps plain
// prose as an answer, so only this reaches the "could not be used" branch.
const UNUSABLE_ANSWER: ChatStandInReply = { kind: 'reply', text: '{"kind":"answer","nope":true}' };
const ANSWER_OK: ChatStandInReply = {
  kind: 'reply',
  text: JSON.stringify({ kind: 'answer', answer: 'It weighs 312 g.' }),
};

function target(overrides: Partial<ChatCompletionsTarget> = {}): ChatCompletionsTarget {
  return {
    qualifiedId: 'test:stand-in',
    label: 'StandIn',
    baseUrl: 'https://stand-in.test/v1',
    model: 'stand-in-model',
    replyFormat: 'json_schema',
    reasoningEffort: null,
    maxTokensParam: 'max_completion_tokens',
    prices: {
      inputUsdPerMTok: 1,
      cachedInputUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: null,
      outputUsdPerMTok: 2,
    },
    ...overrides,
  };
}

function planReply(intents: unknown[], status: 'continue' | 'done'): ChatStandInReply {
  return {
    kind: 'reply',
    text: JSON.stringify({ thought: 'Looking at the page.', kind: 'plan', status, intents }),
  };
}

type WireRequest = Parameters<ChatStandInModel>[0];

/** Which call this is, read off the schema name the adapter sent with it. */
function purposeOf(request: WireRequest): 'plan' | 'answer' {
  const format = request.body.response_format as { json_schema?: { name?: string } } | undefined;
  return format?.json_schema?.name === 'answer_reply' ? 'answer' : 'plan';
}

/** The adapter's own re-ask: the same messages plus the fixed corrective line. */
function isAdapterReask(request: WireRequest): boolean {
  const messages = request.body.messages as Array<{ role: string; content: string }>;
  return messages.at(-1)?.content.startsWith(RETRY_LINE_PREFIX) === true;
}

/** Every step succeeds; every look sees a page that has moved on. */
function readingExecutor(): AgentExecutor {
  let looks = 0;
  return {
    execute: (args: ExecuteArgs): Promise<ExecutorRunResult> =>
      Promise.resolve({
        results: args.plan.intents.map(
          (intent): IntentResult => ({ kind: 'success', intent, summary: `did ${intent.kind}` }),
        ),
        ok: true,
      }),
    observeDigest: (): Promise<string | null> => {
      looks += 1;
      return Promise.resolve(`page as of look ${String(looks)}`);
    },
    observe: (): Promise<string | null> => Promise.resolve('Weight: 312 g'),
  };
}

async function turnUnder(
  model: ChatStandInModel,
  targetOverrides: Partial<ChatCompletionsTarget> = {},
) {
  const provider = chatStandInProvider({ model, expectedKey: KEY });
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-23T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_16', tokenBudgetTotal: 100_000 });
  const runtime = new AgentRuntime({
    decomposer: new OpenAICompatibleAgentDecomposer({
      target: target(targetOverrides),
      apiKey: KEY,
      fetch: provider.fetch,
      retryBackoffMs: 0,
    }),
    executor: readingExecutor(),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
  });
  const run = (userMessage: string) =>
    runtime.runTurn({
      agentSessionId: seed.id,
      userMessage,
      // Opens the read-back gate; this adapter never reads the per-call slot.
      byokApiKey: 'sk-ant-test-fake-key',
    });
  return { run, log: provider.log };
}

describe('#16 — one re-ask per planning step, whichever layer makes it', () => {
  it('both of the adapter’s attempts unreadable: TWO provider calls for the step, not four, and the adapter’s own error ends the turn', async () => {
    const { run, log } = await turnUnder(() => GARBLED);
    await expect(run('open example.com')).rejects.toThrow(
      /StandIn response was not valid JSON \(retried once/,
    );
    // The adapter already spent the step's one re-ask; the runtime adds none.
    expect(log.requests).toHaveLength(2);
    expect(isAdapterReask(log.requests[1]!)).toBe(true);
  });

  it('when the RUNTIME made the step’s re-ask, the adapter gets no second one inside it', async () => {
    // The first reply stops at the output ceiling on a family with no raised
    // ceiling, so the adapter declines to re-ask and the runtime re-asks
    // instead. That was the step's one re-ask: the unreadable reply that comes
    // back ends the step, where before the adapter re-asked a third time.
    const { run, log } = await turnUnder((_request, index) =>
      index === 0
        ? { kind: 'reply', text: '{"kind":"plan","in', finishReason: 'length' }
        : index === 1
          ? GARBLED
          : planReply([{ kind: 'capture', capture: 'screenshot' }], 'done'),
    );
    await expect(run('take a screenshot')).rejects.toThrow(/StandIn response was not valid JSON/);
    expect(log.requests).toHaveLength(2);
    expect(isAdapterReask(log.requests[1]!), 'the second call is the runtime’s plain re-ask').toBe(
      false,
    );
  });

  it('CRITICAL a turn whose every reply is unreadable once stays inside its caps: six planning calls and one read-back, where it made fourteen', async () => {
    let planned = 0;
    const { run, log } = await turnUnder((request) => {
      if (purposeOf(request) === 'answer') {
        return isAdapterReask(request) ? ANSWER_OK : UNUSABLE_ANSWER;
      }
      if (!isAdapterReask(request)) return GARBLED;
      planned += 1;
      // A different harmless step every segment, so only a bound can stop it.
      return planReply(
        [{ kind: 'scroll', direction: 'down', amount_px: 100 * planned }],
        'continue',
      );
    });

    const result = await run('how heavy is the trail stove?');

    const purposes = log.requests.map(purposeOf);
    const planCalls = purposes.filter((p) => p === 'plan').length;
    const answerCalls = purposes.filter((p) => p === 'answer').length;
    expect({ planCalls, answerCalls, total: log.requests.length }).toEqual({
      planCalls: MAX_PLANNER_CALLS_PER_TURN,
      answerCalls: 1,
      total: MAX_MODEL_CALLS_PER_TURN,
    });
    expect(result.kind).toBe('plan-executed');
    if (result.kind !== 'plan-executed') throw new Error('narrow');
    // The turn's own line says what it spent: every call, the re-asks among them.
    expect(result.loop?.plannerCalls).toBe(MAX_PLANNER_CALLS_PER_TURN);
    expect(result.loop?.plannerRetries).toBe(3);
    expect(result.loop?.stopped).toBe('planner_call_limit');
    // The unusable read-back was not re-asked: the plan result stands, and the
    // customer is told the answer half did not complete.
    expect(result.answer).toBeUndefined();
    expect(result.readbackUnavailable).toMatch(/reads the page back and answers did not complete/);
  });
});

describe('#16 — the adapter asks the turn before it spends a re-ask', () => {
  function decomposeArgs(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
    return {
      task: 'open example.com',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      history: [{ at: '2026-09-23T00:00:00.000Z', role: 'user', body: 'open example.com' }],
      budgetTokensRemaining: 100_000,
      ...overrides,
    };
  }

  function adapter(replies: ReadonlyArray<ChatStandInReply>) {
    const provider = chatStandInProvider({
      model: (_request, index) =>
        replies[index] ?? { kind: 'status', status: 599, body: 'ran out' },
      expectedKey: KEY,
    });
    const dec = new OpenAICompatibleAgentDecomposer({
      target: target(),
      apiKey: KEY,
      fetch: provider.fetch,
      retryBackoffMs: 0,
    });
    return { dec, log: provider.log };
  }

  const PLAN_OK = planReply([{ kind: 'navigate', url: 'https://example.com/' }], 'done');

  it('a gate that says no — or that cannot answer — means no re-ask: one call, the first failure thrown unretried', async () => {
    const gates: Array<[string, () => boolean | Promise<boolean>]> = [
      ['false', () => false],
      ['resolved false', () => Promise.resolve(false)],
      [
        'throws',
        () => {
          throw new Error('authority store unavailable');
        },
      ],
    ];
    for (const [name, gate] of gates) {
      const { dec, log } = adapter([GARBLED, PLAN_OK]);
      let asked = 0;
      const caught = await dec
        .decompose(
          decomposeArgs({
            mayRetryMalformedReply: () => {
              asked += 1;
              return gate();
            },
          }),
        )
        .catch((err: unknown) => err);
      expect(asked, name).toBe(1);
      expect(log.requests, name).toHaveLength(1);
      expect((caught as Error).message, name).toBe('StandIn response was not valid JSON');
      expect((caught as { plannerReplyRetried?: boolean }).plannerReplyRetried, name).toBe(false);
    }
  });

  it('⛔ NON-VACUITY: a gate that says yes gets the re-ask, and it recovers', async () => {
    const { dec, log } = adapter([GARBLED, PLAN_OK]);
    const result = await dec.decompose(decomposeArgs({ mayRetryMalformedReply: () => true }));
    expect(log.requests).toHaveLength(2);
    expect(result.kind).toBe('plan');
    expect(result.plannerReplyRetried).toBe(true);
    expect(result.plannerReplyRetryRecovered).toBe(true);
  });
});
