// I18N — THE PLANNER'S `answerWanted` REACHES THE RUNTIME FROM BOTH ADAPTERS.
//
// The runtime opens the read-back for a question with no mark (a Russian or
// Chinese customer's ordinary way of asking) only because the planner said the
// customer wanted an answer. That word is worth nothing if one adapter drops it
// on the way in, and the two adapters read replies differently: the Claude one
// reads a reply that OMITS a member it has nothing to say about, the
// chat-completions one — in strict mode — a reply where every member is present
// and "nothing to say" is spelled `null`.
//
// ⛔ ABSENT IS SILENCE, NEVER A GUESS. A reply without the member (every stored
// transcript, every model that ignores it, the schema-less fallback) must come
// back WITHOUT it, so the lexical gate decides alone — exactly what a plan meant
// before the field existed.

import { describe, expect, it } from 'vitest';
import type { DecomposeArgs, DecomposeResult } from '../../src/services/agent-decomposer.js';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import {
  OpenAICompatibleAgentDecomposer,
  type ChatCompletionsTarget,
} from '../../src/services/agent-decomposer-openai-compatible.js';
import {
  PLAN_REPLY_SCHEMA,
  SYSTEM_PROMPT,
  strictReplySchema,
} from '../../src/services/agent-planner-contract.js';
import { chatStandInProvider } from '../eval/_lib/stand-in-chat-provider.js';

const CHAT_KEY = 'sk-chat-standin-not-real';

const TARGET: ChatCompletionsTarget = {
  qualifiedId: 'openai:gpt-5.6-luna',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.test/v1',
  model: 'gpt-5.6-luna',
  replyFormat: 'json_schema_strict',
  reasoningEffort: 'none',
  maxTokensParam: 'max_completion_tokens',
  prices: {
    inputUsdPerMTok: 0.2,
    cachedInputUsdPerMTok: 0.02,
    cacheWriteUsdPerMTok: 0.25,
    outputUsdPerMTok: 1.2,
  },
};

function args(laterSegment: boolean): DecomposeArgs {
  return {
    task: 'зайди на apteka.test и скажи, до скольки аптека работает в субботу',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [],
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: 'sk-ant-test-fake-key',
    // A later segment of the turn: the only place an empty `done` is a real answer.
    ...(laterSegment
      ? { turnProgress: { segment: 2, plannerCallsRemaining: 3, stepsSoFar: ['✓ navigate'] } }
      : {}),
  };
}

function replyText(answerWanted: boolean | null | undefined): string {
  return JSON.stringify({
    kind: 'plan',
    status: 'continue',
    ...(answerWanted !== undefined ? { answerWanted } : {}),
    intents: [{ kind: 'navigate', url: 'https://apteka.test/' }],
  });
}

async function viaClaude(text: string, laterSegment = false): Promise<DecomposeResult> {
  const dec = new ClaudeAgentDecomposer({
    fetch: () =>
      Promise.resolve(
        new Response(
          JSON.stringify({
            content: [{ type: 'text', text }],
            usage: { input_tokens: 120, output_tokens: 40 },
          }),
          { status: 200 },
        ),
      ),
    retryBackoffMs: 0,
  });
  return dec.decompose(args(laterSegment));
}

async function viaChat(text: string, laterSegment = false): Promise<DecomposeResult> {
  const provider = chatStandInProvider({
    model: () => ({ kind: 'reply', text }),
    expectedKey: CHAT_KEY,
  });
  const dec = new OpenAICompatibleAgentDecomposer({
    target: TARGET,
    apiKey: CHAT_KEY,
    fetch: provider.fetch,
    retryBackoffMs: 0,
  });
  return dec.decompose(args(laterSegment));
}

describe.each([
  ['the Claude adapter', viaClaude],
  ['the chat-completions adapter (strict)', viaChat],
])('%s carries `answerWanted`', (_label, decompose) => {
  it('true is carried', async () => {
    const result = await decompose(replyText(true));
    if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
    expect(result.answerWanted).toBe(true);
  });

  it('false is carried as false', async () => {
    const result = await decompose(replyText(false));
    if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
    expect(result.answerWanted).toBe(false);
  });

  it('absent comes back absent — never defaulted', async () => {
    const result = await decompose(replyText(undefined));
    if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
    expect('answerWanted' in result).toBe(false);
  });

  it('a non-boolean is read as silence, not coerced', async () => {
    const result = await decompose(
      JSON.stringify({
        kind: 'plan',
        status: 'continue',
        answerWanted: 'yes',
        intents: [{ kind: 'navigate', url: 'https://apteka.test/' }],
      }),
    );
    if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
    expect('answerWanted' in result).toBe(false);
  });

  it('an EMPTY `done` in a later segment carries it too — the page already held the answer', async () => {
    // A loop planner shown a page that already answers the question says "done"
    // with no steps. That is the turn that went best, and it must not lose the
    // customer's answer because it had nothing left to do.
    const result = await decompose(
      JSON.stringify({ kind: 'plan', status: 'done', answerWanted: true, intents: [] }),
      true,
    );
    if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
    expect(result.intents).toEqual([]);
    expect(result.answerWanted).toBe(true);
  });
});

describe('I18N — a strict reply spells "nothing to say" as null', () => {
  it('the chat adapter reads `answerWanted: null` as absent', async () => {
    const result = await viaChat(replyText(null));
    if (result.kind !== 'plan') throw new Error(`expected a plan, got ${result.kind}`);
    expect('answerWanted' in result).toBe(false);
  });
});

describe('I18N — the model is asked for it, in the schema and in the words', () => {
  it('the plan schema offers an OPTIONAL boolean, and the strict form makes it required-but-nullable', () => {
    const schema = PLAN_REPLY_SCHEMA as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(schema.properties.answerWanted).toEqual({ type: 'boolean' });
    // Optional: a reply without it is still a valid plan.
    expect(schema.required).not.toContain('answerWanted');
    const strict = strictReplySchema(PLAN_REPLY_SCHEMA) as {
      properties: Record<string, unknown>;
      required: string[];
    };
    expect(strict.properties.answerWanted).toEqual({ type: ['boolean', 'null'] });
    expect(strict.required).toContain('answerWanted');
  });

  it('the planner prompt says what it means, in one sentence, language-neutrally', () => {
    // Without the words, a provider that ignores the schema (or the schema-less
    // fallback) would never be asked for the field at all.
    expect(SYSTEM_PROMPT).toContain(
      'On every plan, set "answerWanted" to true when the customer, in any language,\n' +
        'asks to be told something found on the page, and to false when they only ask\n' +
        'for actions.',
    );
  });
});
