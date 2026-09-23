// P6 — THE OPENAI-COMPATIBLE PLANNER'S ONE BOUNDED RETRY OF A MALFORMED REPLY.
//
// The bake-off (2026-09-20, run 22) found the routed GPT family producing a
// reply nobody could read in 6 of 170 safety trials — sometimes plain garbled
// text, sometimes a reply cut off at the output ceiling because this family's
// reasoning spends the same budget the reply does. Today that throws and the
// turn errors on a transient formatting slip. This file proves the adapter's
// own fix, directly against the real `OpenAICompatibleAgentDecomposer` and a
// stand-in that speaks its wire — no key, no network, no other file's state.
//
// ⛔ NOT COVERED HERE: the RUNTIME's own separate, outer, whole-call retry
// (`planWithOneRetryOnMalformedReply` in `agent-runtime.ts`) and how the two
// layers share one re-ask per planning step — see
// `a-planning-step-is-re-asked-once-in-total-and-the-re-ask-is-a-counted-call`.
// This file is about the retry INSIDE one `decompose()` call: the same
// messages, plus one fixed corrective line, at a raised ceiling when the family
// has one. The read-back call (`answerFromObservation`) is never re-asked.

import { describe, expect, it } from 'vitest';
import {
  OpenAICompatibleAgentDecomposer,
  __TEST_ONLY__,
  type ChatCompletionsTarget,
  type ChatModelPrices,
} from '../../src/services/agent-decomposer-openai-compatible.js';
import type { AnswerArgs, DecomposeArgs } from '../../src/services/agent-decomposer.js';
import { chatStandInProvider, type ChatStandInReply } from '../eval/_lib/stand-in-chat-provider.js';

const KEY = 'sk-standin-not-real';

const PLAN_OK = JSON.stringify({
  thought: 'The page is not open yet.',
  kind: 'plan',
  intents: [{ kind: 'navigate', url: 'https://example.com/' }],
});
const ANSWER_OK = JSON.stringify({ kind: 'answer', answer: 'Your IP address is 203.0.113.7.' });

const PRICES: ChatModelPrices = {
  inputUsdPerMTok: 1,
  cachedInputUsdPerMTok: 0.1,
  cacheWriteUsdPerMTok: null,
  outputUsdPerMTok: 2,
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
    prices: PRICES,
    ...overrides,
  };
}

function decomposeArgs(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
  return {
    task: 'open example.com',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [{ at: '2026-09-19T00:00:00.000Z', role: 'user', body: 'open example.com' }],
    budgetTokensRemaining: 100_000,
    ...overrides,
  };
}

function answerArgs(overrides: Partial<AnswerArgs> = {}): AnswerArgs {
  return {
    task: 'what is my IP address',
    observation: 'the page says: your IP is 203.0.113.7',
    budgetTokensRemaining: 100_000,
    ...overrides,
  };
}

function adapter(
  replies: ReadonlyArray<ChatStandInReply>,
  targetOverrides: Partial<ChatCompletionsTarget> = {},
) {
  const provider = chatStandInProvider({
    model: (_request, index) => replies[index] ?? { kind: 'status', status: 599, body: 'ran out' },
    expectedKey: KEY,
  });
  const dec = new OpenAICompatibleAgentDecomposer({
    target: target(targetOverrides),
    apiKey: KEY,
    fetch: provider.fetch,
    retryBackoffMs: 0,
  });
  return { dec, log: provider.log };
}

describe('decompose() — a malformed plan reply', () => {
  it('a malformed reply followed by a well-formed one is USED — both calls billed, and the result says it was retried and recovered', async () => {
    const { dec, log } = adapter([
      {
        kind: 'reply',
        text: 'Sure! Step one is to open the page.',
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      },
      { kind: 'reply', text: PLAN_OK, usage: { prompt_tokens: 120, completion_tokens: 20 } },
    ]);
    const result = await dec.decompose(decomposeArgs());
    expect(log.requests).toHaveLength(2);
    if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
    expect(result.intents).toEqual([{ kind: 'navigate', url: 'https://example.com/' }]);
    expect(result.plannerReplyRetried).toBe(true);
    expect(result.plannerReplyRetryRecovered).toBe(true);
    // Both calls' tokens summed: (100+10) + (120+20).
    expect(result.tokensConsumed).toBe(250);
    // The retry sent the SAME messages, plus exactly one appended user line
    // quoting the first failure's reason — the fixed retry line, verbatim.
    const first = log.requests[0]!.body.messages as Array<{ role: string; content: string }>;
    const second = log.requests[1]!.body.messages as Array<{ role: string; content: string }>;
    expect(second.length).toBe(first.length + 1);
    expect(second.slice(0, first.length)).toEqual(first);
    expect(second[second.length - 1]).toEqual({
      role: 'user',
      content: __TEST_ONLY__.malformedReplyRetryLine('StandIn response was not valid JSON'),
    });
    // Not truncated, so the retry used the SAME ceiling as the first call —
    // no family ceiling is even configured on this target.
    expect(log.requests[0]!.body.max_completion_tokens).toBe(
      __TEST_ONLY__.PLAN_MAX_COMPLETION_TOKENS,
    );
    expect(log.requests[1]!.body.max_completion_tokens).toBe(
      __TEST_ONLY__.PLAN_MAX_COMPLETION_TOKENS,
    );
  });

  it('two malformed replies in a row end the call with BOTH reasons in the message, and the thrown error is marked retried-but-not-recovered', async () => {
    const { dec, log } = adapter([
      { kind: 'reply', text: 'first garble, not json' },
      { kind: 'reply', text: 'second garble, still not json' },
    ]);
    const caught = await dec.decompose(decomposeArgs()).catch((err: unknown) => err);
    expect(log.requests).toHaveLength(2);
    expect(caught).toBeInstanceOf(Error);
    const err = caught as Error & {
      plannerReplyRetried?: boolean;
      plannerReplyRetryRecovered?: boolean;
    };
    // The runtime's classifier matches on the phrase, unaltered by the retry.
    expect(err.message).toContain('StandIn response was not valid JSON');
    expect(err.message).toContain('retried once');
    expect(err.plannerReplyRetried).toBe(true);
    expect(err.plannerReplyRetryRecovered).toBe(false);
  });

  it('a reply cut off at the output ceiling, on a family with a CONFIGURED raised ceiling, is retried at the RAISED value and recovers', async () => {
    const { dec, log } = adapter(
      [
        { kind: 'reply', text: '{"kind":"plan","in', finishReason: 'length' },
        { kind: 'reply', text: PLAN_OK },
      ],
      { maxCompletionTokensCeiling: { plan: 20_000, answer: 9_000 } },
    );
    const result = await dec.decompose(decomposeArgs());
    expect(log.requests).toHaveLength(2);
    expect(log.requests[0]!.body.max_completion_tokens).toBe(
      __TEST_ONLY__.PLAN_MAX_COMPLETION_TOKENS,
    );
    expect(log.requests[1]!.body.max_completion_tokens).toBe(20_000);
    if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
    expect(result.plannerReplyRetried).toBe(true);
    expect(result.plannerReplyRetryRecovered).toBe(true);
  });

  it('a reply cut off at the output ceiling, on a family with NO configured ceiling, is never retried — the existing truncation error stands', async () => {
    const { dec, log } = adapter([
      { kind: 'reply', text: '{"kind":"plan","in', finishReason: 'length' },
    ]);
    const caught = await dec.decompose(decomposeArgs()).catch((err: unknown) => err);
    expect(log.requests).toHaveLength(1);
    expect((caught as Error).message).toContain('cut off at the output limit');
  });

  it('a strict-mode refusal is a refuse result, never retried as a malformed reply', async () => {
    const { dec, log } = adapter([{ kind: 'reply', text: '', refusal: 'I will not.' }]);
    const result = await dec.decompose(decomposeArgs());
    expect(result.kind).toBe('refuse');
    expect(log.requests).toHaveLength(1);
  });

  it('Stop landing between the two calls means the retry is never sent', async () => {
    const { dec, log } = adapter([{ kind: 'reply', text: 'garbled, not json' }]);
    let calls = 0;
    // True on the first attempt, false from the retry's own fence check on.
    const shouldContinue = (): boolean => {
      calls += 1;
      return calls === 1;
    };
    const caught = await dec
      .decompose(decomposeArgs({ shouldContinue }))
      .catch((err: unknown) => err);
    expect(log.requests).toHaveLength(1);
    expect((caught as Error).name).toBe('AgentDecomposerContinuationDeniedError');
  });
});

describe('answerFromObservation() — the read-back call is NEVER re-asked', () => {
  // #16 — the runtime never retries a failed read-back (the plan result is the
  // fallback; see the note at the read-back's own catch), and the adapter's own
  // answer retry is removed rather than counted: runs 22 and 30 made 280 answer
  // calls on the family it was built for, and none came back unusable.
  it('a malformed read-back reply is thrown after ONE call, for the runtime’s fallback — even when a good one would follow', async () => {
    const { dec, log } = adapter([
      // Valid JSON, wrong shape — no `answer` string — so `interpretAnswerText`
      // actually throws rather than recovering plain prose as the answer (its
      // OWN, separate fallback for hand-written JSON with a broken wrapper).
      { kind: 'reply', text: '{"kind":"answer","nope":true}' },
      { kind: 'reply', text: ANSWER_OK },
    ]);
    const caught = await dec.answerFromObservation(answerArgs()).catch((err: unknown) => err);
    expect(log.requests).toHaveLength(1);
    expect(caught).toBeInstanceOf(Error);
    expect((caught as { plannerReplyRetried?: boolean }).plannerReplyRetried).toBeUndefined();
  });

  it('a read-back cut off at the output ceiling is not re-asked either, even on a family with a raised answer ceiling', async () => {
    const { dec, log } = adapter(
      [
        { kind: 'reply', text: '{"kind":"answer","answer":"Your IP', finishReason: 'length' },
        { kind: 'reply', text: ANSWER_OK },
      ],
      { maxCompletionTokensCeiling: { plan: 20_000, answer: 9_000 } },
    );
    await expect(dec.answerFromObservation(answerArgs())).rejects.toThrow(/output limit/);
    expect(log.requests).toHaveLength(1);
    expect(log.requests[0]!.body.max_completion_tokens).toBe(
      __TEST_ONLY__.ANSWER_MAX_COMPLETION_TOKENS,
    );
  });

  it('⛔ NON-VACUITY: a well-formed read-back is used as-is', async () => {
    const { dec, log } = adapter([{ kind: 'reply', text: ANSWER_OK }]);
    const result = await dec.answerFromObservation(answerArgs());
    expect(log.requests).toHaveLength(1);
    expect(result.answer).toBe('Your IP address is 203.0.113.7.');
  });
});
