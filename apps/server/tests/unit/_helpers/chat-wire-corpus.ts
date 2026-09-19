// A fixed set of calls through the REAL OpenAICompatibleAgentDecomposer, once per
// DIRECT chat-completions row of the provider table, and everything that crossed
// the wire for each: URL, method, headers, redirect policy and the exact request
// body, plus the result (or error) the adapter returned for a canned reply.
//
// ⛔ WHY IT EXISTS. The adapter learned a second dialect — OpenRouter's routing
// object, its unified reasoning control, a cache marker for Anthropic-routed
// models — and every one of those is a member added to a body that seven other
// providers also receive. "Only for OpenRouter rows" is a claim about a branch,
// and most tests assert on PART of a body, so a member that leaked into every
// provider's request would pass them all. This corpus was run against the
// adapter BEFORE the OpenRouter change and frozen in
// `_fixtures/chat-wire-golden.json`; the test beside it demands byte equality.
//
// It uses nothing but the public constructor, the two public methods and the
// table's own `chatTarget`, so the same file drives the code before and after.

import type { AnswerArgs, DecomposeArgs } from '../../../src/services/agent-decomposer.js';
import { OpenAICompatibleAgentDecomposer } from '../../../src/services/agent-decomposer-openai-compatible.js';
import {
  CHAT_PLANNER_MODELS,
  chatTarget,
  type ChatPlannerModel,
} from '../../../src/services/agent-planner-providers.js';

/** A fake key. Recorded, because which header carries it is part of the wire. */
export const CHAT_GOLDEN_KEY = 'sk-chat-golden-not-a-real-key';
/** Rows priced on a fixed day, so a scheduled price change cannot move the record. */
const DAY = new Date('2026-09-18T00:00:00.000Z');

export interface RecordedChatRequest {
  url: string;
  method: string | null;
  /** Header name (lower-cased) → value, sorted by name. */
  headers: Array<[string, string]>;
  redirect: string | null;
  body: string;
}

export interface RecordedChatCall {
  name: string;
  requests: RecordedChatRequest[];
  outcome: { result: unknown } | { error: { name: string; message: string } };
}

type Canned = { kind: 'reply'; text: string } | { kind: 'status'; status: number; body: string };

const USAGE = {
  prompt_tokens: 3200,
  completion_tokens: 140,
  total_tokens: 3340,
  prompt_tokens_details: { cached_tokens: 2048 },
  completion_tokens_details: { reasoning_tokens: 40 },
};

function streamed(text: string): Response {
  const encoder = new TextEncoder();
  const frames = [
    { choices: [{ index: 0, delta: { role: 'assistant', content: text } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    { choices: [], usage: USAGE },
  ]
    .map((f) => `data: ${JSON.stringify(f)}\n\n`)
    .concat('data: [DONE]\n\n');
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        const next = frames.shift();
        if (next === undefined) controller.close();
        else controller.enqueue(encoder.encode(next));
      },
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } },
  );
}

function recordingFetch(replies: ReadonlyArray<Canned>): {
  fetch: typeof globalThis.fetch;
  requests: RecordedChatRequest[];
} {
  const requests: RecordedChatRequest[] = [];
  let index = 0;
  const impl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const pairs: Array<[string, string]> = [];
    new Headers(init?.headers).forEach((value, name) => pairs.push([name, value]));
    pairs.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    requests.push({
      url: typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url,
      method: init?.method ?? null,
      headers: pairs,
      redirect: init?.redirect ?? null,
      body: typeof init?.body === 'string' ? init.body : '<<non-string body>>',
    });
    const reply = replies[index++];
    if (reply === undefined) return Promise.reject(new Error('the corpus ran out of replies'));
    return Promise.resolve(
      reply.kind === 'status'
        ? new Response(reply.body, { status: reply.status })
        : streamed(reply.text),
    );
  };
  return { fetch: impl, requests };
}

const TASK = 'open https://example.com and capture the page';
const PLAN = JSON.stringify({
  thought: 'The page is not open yet.',
  kind: 'plan',
  status: 'continue',
  intents: [
    { kind: 'navigate', url: 'https://example.com/' },
    { kind: 'wait', condition: 'idle' },
  ],
});
const ANSWER = JSON.stringify({ kind: 'answer', answer: 'Your IP address is 203.0.113.7.' });

function decomposeArgs(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
  return {
    task: TASK,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [{ at: '2026-09-01T00:00:00.000Z', role: 'user', body: TASK }],
    budgetTokensRemaining: 100_000,
    ...overrides,
  };
}

function answerArgs(): AnswerArgs {
  return {
    task: 'what is my ip address?',
    observation: '<html><body><p>Your IP address is 203.0.113.7</p></body></html>',
    budgetTokensRemaining: 100_000,
  };
}

interface CorpusCall {
  name: string;
  replies: ReadonlyArray<Canned>;
  run: (d: OpenAICompatibleAgentDecomposer) => Promise<unknown>;
}

const CALLS: ReadonlyArray<CorpusCall> = [
  {
    name: 'first plan',
    replies: [{ kind: 'reply', text: PLAN }],
    run: (d) => d.decompose(decomposeArgs()),
  },
  {
    name: 'continue — page observed, with credential names and a prior failure',
    replies: [{ kind: 'reply', text: PLAN }],
    run: (d) =>
      d.decompose(
        decomposeArgs({
          credentialRefs: ['username'],
          observation: 'text: Sign in\n#user input "Email"',
          priorFailure: 'The step "tap #login" failed: element not found.',
          turnProgress: { segment: 2, plannerCallsRemaining: 4, stepsSoFar: ['✓ navigate'] },
        }),
      ),
  },
  {
    name: 'read-back',
    replies: [{ kind: 'reply', text: ANSWER }],
    run: (d) => d.answerFromObservation(answerArgs()),
  },
  {
    name: 'the schema refused, then the same call without it',
    replies: [
      {
        kind: 'status',
        status: 400,
        body: '{"error":{"message":"response_format is not supported"}}',
      },
      { kind: 'reply', text: PLAN },
    ],
    run: (d) => d.decompose(decomposeArgs()),
  },
  {
    name: 'reasoning refused, then the same call without it',
    replies: [
      {
        kind: 'status',
        status: 400,
        body: '{"error":{"message":"reasoning_effort is not supported"}}',
      },
      { kind: 'reply', text: PLAN },
    ],
    run: (d) => d.decompose(decomposeArgs()),
  },
];

/** The rows this corpus pins: every chat row that is NOT reached through an
 *  aggregator. Their wire must not move when the aggregator's dialect is added. */
export function directChatRows(): ReadonlyArray<ChatPlannerModel> {
  return CHAT_PLANNER_MODELS.filter((row) => row.provider.id !== 'openrouter');
}

export async function runChatWireCorpus(): Promise<RecordedChatCall[]> {
  const out: RecordedChatCall[] = [];
  for (const row of directChatRows()) {
    for (const call of CALLS) {
      const recorder = recordingFetch(call.replies);
      const decomposer = new OpenAICompatibleAgentDecomposer({
        target: chatTarget(row, DAY),
        apiKey: CHAT_GOLDEN_KEY,
        fetch: recorder.fetch,
        retryBackoffMs: 0,
      });
      let outcome: RecordedChatCall['outcome'];
      try {
        outcome = { result: JSON.parse(JSON.stringify(await call.run(decomposer))) as unknown };
      } catch (err) {
        outcome = {
          error:
            err instanceof Error
              ? { name: err.name, message: err.message }
              : { name: 'non-error', message: String(err) },
        };
      }
      out.push({ name: `${row.qualifiedId} — ${call.name}`, requests: recorder.requests, outcome });
    }
  }
  return out;
}
