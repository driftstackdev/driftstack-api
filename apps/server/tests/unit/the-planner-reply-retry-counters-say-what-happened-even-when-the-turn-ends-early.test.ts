// #18 — THE CHAT ADAPTER'S RETRY COUNTERS SAY WHAT HAPPENED.
//
// `plannerReplyRetried` / `plannerReplyRetryRecovered` ride the turn's
// `agent_turn_action_paths` line: how many planning calls the OpenAI-compatible
// adapter re-asked, and how many of those re-asks produced the reply the turn
// used. The audit (s13/s14 finding 18) found three ways they lied, one test each:
//
//  · a provider REFUSAL on the re-ask was counted as a recovery — the malformed
//    reply was never recovered, the provider declined;
//  · a re-ask that ALSO failed was never counted at all, because the runtime
//    only read the markers off a returned result, never off a thrown error —
//    live run 30 shows it: three double failures, `retried: 0`;
//  · a count taken on a later segment was LOST when the turn ended in the loop,
//    because the counts were only written onto the turn's result after a
//    segment ran or a read-back answered. (The audit's own throwaway file is
//    gone; this is that scenario rebuilt: a later segment's re-ask, then the
//    loop ends with nothing left to run and no question to read back.)
//
// The REAL adapter under the REAL runtime, against a stand-in chat provider.

import { describe, expect, it } from 'vitest';
import { AgentRuntime } from '../../src/services/agent-runtime.js';
import { InMemoryAgentSessionsRepo } from '../../src/services/agent-sessions.js';
import {
  OpenAICompatibleAgentDecomposer,
  type ChatCompletionsTarget,
} from '../../src/services/agent-decomposer-openai-compatible.js';
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
const GARBLED: ChatStandInReply = { kind: 'reply', text: 'Sure! First I will open the page.' };
const ANSWER_OK: ChatStandInReply = {
  kind: 'reply',
  text: JSON.stringify({ kind: 'answer', answer: 'It weighs 312 g.' }),
};

function target(): ChatCompletionsTarget {
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
  };
}

function planReply(intents: unknown[], status: 'continue' | 'done'): ChatStandInReply {
  return {
    kind: 'reply',
    text: JSON.stringify({ thought: 'Looking at the page.', kind: 'plan', status, intents }),
  };
}

const FIRST_SEGMENT = planReply(
  [{ kind: 'scroll', direction: 'down', amount_px: 600 }],
  'continue',
);

function isAnswerCall(request: Parameters<ChatStandInModel>[0]): boolean {
  const format = request.body.response_format as { json_schema?: { name?: string } } | undefined;
  return format?.json_schema?.name === 'answer_reply';
}

/** Plan calls get `plans[n]` in order (the last one repeating); answer calls get
 *  a good answer. */
function scripted(plans: ReadonlyArray<ChatStandInReply>): ChatStandInModel {
  let planCall = 0;
  return (request) => {
    if (isAnswerCall(request)) return ANSWER_OK;
    const reply = plans[Math.min(planCall, plans.length - 1)]!;
    planCall += 1;
    return reply;
  };
}

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

function chatAdapter(model: ChatStandInModel) {
  const provider = chatStandInProvider({ model, expectedKey: KEY });
  const dec = new OpenAICompatibleAgentDecomposer({
    target: target(),
    apiKey: KEY,
    fetch: provider.fetch,
    retryBackoffMs: 0,
  });
  return { dec, log: provider.log };
}

async function runTurn(model: ChatStandInModel, userMessage: string) {
  const { dec, log } = chatAdapter(model);
  const sessions = new InMemoryAgentSessionsRepo(() => new Date('2026-09-23T00:00:00Z'));
  const seed = await sessions.create({ accountId: 'acc_18', tokenBudgetTotal: 100_000 });
  const runtime = new AgentRuntime({
    decomposer: dec,
    executor: readingExecutor(),
    sessions,
    archetype: 'iphone16pro_ios18_7_safari26_4',
  });
  const result = await runtime.runTurn({
    agentSessionId: seed.id,
    userMessage,
    byokApiKey: 'sk-ant-test-fake-key',
  });
  return { result, log };
}

describe('#18 — the adapter retry counters', () => {
  it('a provider REFUSAL on the re-ask is counted as retried, NOT as recovered', async () => {
    const { dec, log } = chatAdapter(
      scripted([GARBLED, { kind: 'reply', text: '', refusal: 'I will not help with that.' }]),
    );
    const result = await dec.decompose({
      task: 'open example.com',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      history: [{ at: '2026-09-23T00:00:00.000Z', role: 'user', body: 'open example.com' }],
      budgetTokensRemaining: 100_000,
    });
    expect(log.requests).toHaveLength(2);
    // Still the refusal the customer is owed…
    expect(result.kind).toBe('refuse');
    // …but the malformed reply was never recovered: the provider declined.
    expect(result.plannerReplyRetried).toBe(true);
    expect(result.plannerReplyRetryRecovered).toBe(false);
  });

  it('a re-ask that ALSO fails is counted as retried (and not recovered) on the turn’s line', async () => {
    // Segment 1 runs; segment 2's reply is unreadable twice, which ends the
    // loop. The read-back still runs and answers, so the turn's counts are
    // written after it — this isolates the thrown-error half of the bug.
    const { result } = await runTurn(
      scripted([FIRST_SEGMENT, GARBLED]),
      'how heavy is the trail stove?',
    );
    expect(result.kind).toBe('plan-executed');
    if (result.kind !== 'plan-executed') throw new Error('narrow');
    expect(result.answer, 'the read-back ran').toBe('It weighs 312 g.');
    expect(result.executor.actionPaths?.plannerReplyRetried).toBe(1);
    expect(result.executor.actionPaths?.plannerReplyRetryRecovered).toBe(0);
  });

  it('a count taken on a later segment SURVIVES a turn that ends in the loop, with no read-back after it', async () => {
    // Segment 2's reply is unreadable once and the re-ask recovers it — with
    // "done, nothing left to run". The loop ends there, the customer asked no
    // question, and no later step writes the counts for it.
    const { result, log } = await runTurn(
      scripted([FIRST_SEGMENT, GARBLED, planReply([], 'done')]),
      'scroll down the page',
    );
    expect(log.requests).toHaveLength(3);
    expect(result.kind).toBe('plan-executed');
    if (result.kind !== 'plan-executed') throw new Error('narrow');
    expect(result.loop?.finalStatus).toBe('done');
    expect(result.answer).toBeUndefined();
    expect(result.readbackUnavailable).toBeUndefined();
    expect(result.executor.actionPaths?.plannerReplyRetried).toBe(1);
    expect(result.executor.actionPaths?.plannerReplyRetryRecovered).toBe(1);
  });
});
