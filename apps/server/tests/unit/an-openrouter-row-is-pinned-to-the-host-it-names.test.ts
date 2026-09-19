// ONE OPENROUTER KEY, AND EVERY RUN MEASURES THE MODEL ON THE HOST IT NAMES.
//
// The provider table's `openrouter:` rows reach Claude, OpenAI, Gemini and an
// open-weights host through one aggregator. What makes that a fair comparison
// rather than a lottery is the PIN: each request carries `provider: {only:
// [one host], allow_fallbacks: false, require_parameters: true}`, so it is
// served by the host the row names or refused — never by another host, and
// never by one that ignores the reply schema. This file pins that request
// shape, the dialect's other members (unified `reasoning`, Anthropic's
// automatic `cache_control`), the fee-inclusive prices, the honest wording of
// OpenRouter's two account/routing refusals, and the usage `cost` parse.
//
// That none of this reaches a DIRECT provider is pinned byte for byte by
// `the-direct-chat-wire-does-not-move-when-openrouter-is-added.test.ts`.

import { describe, expect, it } from 'vitest';
import {
  OpenAICompatibleAgentDecomposer,
  __TEST_ONLY__,
} from '../../src/services/agent-decomposer-openai-compatible.js';
import type { DecomposeArgs } from '../../src/services/agent-decomposer.js';
import { PlannerProviderStatusError } from '../../src/services/agent-planner-contract.js';
import {
  CHAT_PLANNER_MODELS,
  OPENROUTER_FEE_RATE,
  chatTarget,
  withOpenRouterFee,
  type ChatPlannerModel,
} from '../../src/services/agent-planner-providers.js';
import {
  chatStandInProvider,
  standInChatUsage,
  type ChatStandInReply,
} from '../eval/_lib/stand-in-chat-provider.js';

const KEY = 'sk-or-standin-not-real';
const DAY = new Date('2026-09-19T00:00:00Z');
const PLAN = JSON.stringify({
  thought: 'Open the page first.',
  kind: 'plan',
  intents: [{ kind: 'navigate', url: 'https://example.com/' }],
});

function row(id: string): ChatPlannerModel {
  const found = CHAT_PLANNER_MODELS.find((m) => m.qualifiedId === id);
  if (found === undefined) throw new Error(`no row ${id}`);
  return found;
}

const OPENROUTER_ROWS = CHAT_PLANNER_MODELS.filter((m) => m.provider.id === 'openrouter');

function args(): DecomposeArgs {
  return {
    task: 'open example.com',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [{ at: '2026-09-19T00:00:00.000Z', role: 'user', body: 'open example.com' }],
    budgetTokensRemaining: 100_000,
  };
}

function adapter(id: string, replies: ReadonlyArray<ChatStandInReply>) {
  const provider = chatStandInProvider({
    model: (_r, i) => replies[i] ?? { kind: 'status', status: 599, body: 'stand-in ran out' },
    expectedKey: KEY,
  });
  const dec = new OpenAICompatibleAgentDecomposer({
    target: chatTarget(row(id), DAY),
    apiKey: KEY,
    fetch: provider.fetch,
    retryBackoffMs: 0,
  });
  return { dec, log: provider.log };
}

const orError = (status: number, message: string, metadata?: Record<string, unknown>) =>
  JSON.stringify({ error: { code: status, message, ...(metadata ? { metadata } : {}) } });

describe('the OpenRouter rows of the provider table', () => {
  it('the comparison the owner asked for is all there: the six slugs verified in the catalogue, one key, one base URL', () => {
    expect(OPENROUTER_ROWS.map((m) => m.model).sort()).toEqual(
      [
        'anthropic/claude-haiku-4.5',
        'anthropic/claude-opus-5',
        'anthropic/claude-sonnet-5',
        'google/gemini-3.8-flash',
        'openai/gpt-5.6-luna',
        'z-ai/glm-5.3-flash',
      ].sort(),
    );
    for (const m of OPENROUTER_ROWS) {
      expect(m.qualifiedId).toBe(`openrouter:${m.model}`);
      expect(m.provider.baseUrl).toBe('https://openrouter.ai/api/v1');
      expect(m.provider.keyEnvVar).toBe('OPENROUTER_API_KEY');
      // max_tokens is the member every pinned endpoint lists, and
      // require_parameters routes only to endpoints that support every one sent.
      expect(m.maxTokensParam).toBe('max_tokens');
    }
  });

  it('every OpenRouter row is pinned to exactly one named upstream, cited; no direct row carries a pin', () => {
    for (const m of OPENROUTER_ROWS) {
      expect(m.openRouter, m.qualifiedId).toBeDefined();
      expect(m.openRouter?.only, m.qualifiedId).toMatch(/^[a-z0-9-]+(\/[a-z0-9-]+)*$/);
      expect(m.openRouter?.endpointsSource).toBe(
        `https://openrouter.ai/api/v1/models/${m.model}/endpoints`,
      );
      // Anthropic caches nothing without a marker; the others cache on their own.
      expect(m.openRouter?.cacheControl, m.qualifiedId).toBe(m.openRouter?.only === 'anthropic');
    }
    for (const m of CHAT_PLANNER_MODELS.filter((r) => r.provider.id !== 'openrouter')) {
      expect(m.openRouter, m.qualifiedId).toBeUndefined();
      expect('openRouter' in chatTarget(m, DAY), m.qualifiedId).toBe(false);
    }
  });

  it('a price is the upstream list price PLUS the 5.5% fee, on every token class, and says so', () => {
    expect(OPENROUTER_FEE_RATE).toBe(0.055);
    expect(
      withOpenRouterFee({
        inputUsdPerMTok: 2,
        cachedInputUsdPerMTok: 0.2,
        cacheWriteUsdPerMTok: 2.5,
        outputUsdPerMTok: 10,
      }),
    ).toEqual({
      inputUsdPerMTok: 2.11,
      cachedInputUsdPerMTok: 0.211,
      cacheWriteUsdPerMTok: 2.6375,
      outputUsdPerMTok: 10.55,
    });
    const sonnet = row('openrouter:anthropic/claude-sonnet-5');
    expect(sonnet.prices.outputUsdPerMTok).toBe(10.55);
    for (const m of OPENROUTER_ROWS) {
      expect(m.priceSource, m.qualifiedId).toContain(m.openRouter?.endpointsSource ?? '∅');
      expect(m.priceSource, m.qualifiedId).toContain('https://openrouter.ai/pricing');
    }
  });
});

describe('an OpenRouter request', () => {
  it('carries the pin — only the named host, fallbacks OFF, every parameter required — plus unified reasoning and, for Claude, the automatic cache marker', async () => {
    const { dec, log } = adapter('openrouter:anthropic/claude-sonnet-5', [
      { kind: 'reply', text: PLAN },
    ]);
    await dec.decompose(args());
    expect(log.urls).toEqual(['https://openrouter.ai/api/v1/chat/completions']);
    expect(log.bearerMatched).toEqual([true]);
    const body = log.requests[0]!.body;
    expect(body.model).toBe('anthropic/claude-sonnet-5');
    expect(body.provider).toEqual({
      only: ['anthropic'],
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(body.reasoning).toEqual({ effort: 'low' });
    expect('reasoning_effort' in body).toBe(false);
    expect(body.cache_control).toEqual({ type: 'ephemeral' });
    expect(body.max_tokens).toBe(__TEST_ONLY__.PLAN_MAX_COMPLETION_TOKENS);
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
    // The dialect's members come LAST, so the part of the body every provider
    // shares keeps its order.
    expect(Object.keys(body).slice(-2)).toEqual(['provider', 'cache_control']);
  });

  it('a non-Anthropic row gets the pin and no cache marker; a row with no reasoning setting sends no reasoning member at all', async () => {
    const luna = adapter('openrouter:openai/gpt-5.6-luna', [{ kind: 'reply', text: PLAN }]);
    await luna.dec.decompose(args());
    const lunaBody = luna.log.requests[0]!.body;
    expect(lunaBody.provider).toEqual({
      only: ['openai'],
      allow_fallbacks: false,
      require_parameters: true,
    });
    expect(lunaBody.reasoning).toEqual({ effort: 'none' });
    expect('cache_control' in lunaBody).toBe(false);
    expect(lunaBody.response_format).toMatchObject({ json_schema: { strict: true } });

    const gemini = adapter('openrouter:google/gemini-3.8-flash', [{ kind: 'reply', text: PLAN }]);
    await gemini.dec.decompose(args());
    expect(gemini.log.requests[0]!.body.provider).toMatchObject({ only: ['google-vertex/global'] });

    const haiku = adapter('openrouter:anthropic/claude-haiku-4.5', [{ kind: 'reply', text: PLAN }]);
    await haiku.dec.decompose(args());
    const haikuBody = haiku.log.requests[0]!.body;
    expect('reasoning' in haikuBody).toBe(false);
    expect('reasoning_effort' in haikuBody).toBe(false);
  });

  it('a 400 naming `reasoning` drops the reasoning member and keeps the pin — the pin is never a control the adapter drops', async () => {
    const { dec, log } = adapter('openrouter:anthropic/claude-sonnet-5', [
      { kind: 'status', status: 400, body: orError(400, 'reasoning is not supported') },
      { kind: 'reply', text: PLAN },
    ]);
    await dec.decompose(args());
    expect(log.requests).toHaveLength(2);
    expect('reasoning' in log.requests[1]!.body).toBe(false);
    expect(log.requests[1]!.body.provider).toEqual(log.requests[0]!.body.provider);
    expect(dec.rejectedControls).toEqual(['reasoning']);
  });
});

describe('OpenRouter’s refusals say what actually happened', () => {
  it('⛔ 402 is the ACCOUNT: "out of credits", thrown at once with its status, never retried', async () => {
    const { dec, log } = adapter('openrouter:openai/gpt-5.6-luna', [
      {
        kind: 'status',
        status: 402,
        body: orError(402, 'Insufficient credits. Add more using https://openrouter.ai/credits'),
      },
    ]);
    const err = await dec.decompose(args()).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PlannerProviderStatusError);
    expect((err as PlannerProviderStatusError).status).toBe(402);
    expect((err as Error).message).toMatch(
      /^OpenRouter API 402: the OpenRouter account is out of credits/,
    );
    expect((err as Error).message).toContain('Insufficient credits');
    expect(log.requests).toHaveLength(1);
  });

  it('⛔ 503 under a pin is the pin holding: the message names the pinned host and says no other was tried; retried once like any 5xx', async () => {
    const refusal = {
      kind: 'status',
      status: 503,
      body: orError(503, 'No available model provider meets your routing requirements'),
    } as const;
    const { dec, log } = adapter('openrouter:anthropic/claude-sonnet-5', [refusal, refusal]);
    const err = await dec.decompose(args()).catch((e: unknown) => e);
    expect((err as PlannerProviderStatusError).status).toBe(503);
    expect((err as Error).message).toContain('the pinned upstream "anthropic" could not serve');
    expect((err as Error).message).toContain('fallbacks are off, so no other host was tried');
    expect(log.requests).toHaveLength(2);
  });

  it('a 404 that says no endpoint matched is the same fact as the 503; any other 404 keeps its own words', () => {
    const route = { only: 'together', cacheControl: false };
    const say = __TEST_ONLY__.openRouterStatusMessage;
    expect(
      say(404, orError(404, 'No endpoints found matching your data policy'), route, 'OpenRouter'),
    ).toContain('the pinned upstream "together"');
    expect(say(404, orError(404, 'Model not found'), route, 'OpenRouter')).toBe(
      'OpenRouter API 404: Model not found',
    );
  });

  it('an upstream error keeps its own words plus the upstream that said them — and a 400 still names the control, so the schema fallback reads it', async () => {
    const { dec, log } = adapter('openrouter:anthropic/claude-sonnet-5', [
      {
        kind: 'status',
        status: 400,
        body: orError(400, 'response_format: schema too complex', { provider_name: 'Anthropic' }),
      },
      { kind: 'reply', text: PLAN },
    ]);
    await dec.decompose(args());
    expect(dec.rejectedControls).toEqual(['schema']);
    expect('response_format' in log.requests[1]!.body).toBe(false);
    expect(
      __TEST_ONLY__.openRouterStatusMessage(
        400,
        orError(400, 'bad', { provider_name: 'Anthropic' }),
        { only: 'anthropic', cacheControl: true },
        'OpenRouter',
      ),
    ).toBe('OpenRouter API 400: bad (upstream: Anthropic)');
  });

  it('a MID-STREAM error frame (HTTP 200, `finish_reason: "error"`) is worded as its HTTP twin', async () => {
    const { dec } = adapter('openrouter:openai/gpt-5.6-luna', [
      { kind: 'stream-error', error: { code: 402, message: 'Insufficient credits' } },
    ]);
    const err = await dec.decompose(args()).catch((e: unknown) => e);
    expect((err as PlannerProviderStatusError).status).toBe(402);
    expect((err as Error).message).toContain('out of credits');
  });

  it('a DIRECT provider’s refusal is untouched: its body, as it always was', () => {
    // The OpenRouter wording is reached only through a target's `openRouter`;
    // the direct wording is pinned byte for byte by the golden wire test.
    expect(chatTarget(row('openai:gpt-5.6-luna'), DAY).openRouter).toBeUndefined();
  });
});

describe('OpenRouter’s usage', () => {
  it('reads `cost`, cached and cache-written prompt tokens and reasoning tokens; the budget debit is the same with or without a cost', () => {
    const base = standInChatUsage({
      prompt_tokens: 3000,
      completion_tokens: 200,
      prompt_tokens_details: { cached_tokens: 2000, cache_write_tokens: 500 },
      completion_tokens_details: { reasoning_tokens: 50 },
    });
    const parse = __TEST_ONLY__.parseChatUsage;
    const withCost = parse({ ...base, cost: 0.0042 }, 'OpenRouter');
    expect(withCost).toEqual({
      promptTokens: 3000,
      cachedPromptTokens: 2000,
      cacheWriteTokens: 500,
      completionTokens: 200,
      reasoningTokens: 50,
      reportedCostUsd: 0.0042,
    });
    const prices = row('openrouter:anthropic/claude-sonnet-5').prices;
    expect(__TEST_ONLY__.chatBillableTokens(withCost, prices)).toBe(
      __TEST_ONLY__.chatBillableTokens(parse(base, 'OpenRouter'), prices),
    );
  });

  it('a cost that is not a plain non-negative number is DROPPED, never fatal — a paid, usable reply is not thrown away over a report figure', () => {
    const parse = __TEST_ONLY__.parseChatUsage;
    for (const cost of [-1, '0.01', Number.NaN, null, { usd: 1 }]) {
      const parts = parse({ prompt_tokens: 10, completion_tokens: 2, cost }, 'OpenRouter');
      expect('reportedCostUsd' in parts, JSON.stringify(cost) ?? 'undefined').toBe(false);
    }
    expect(parse({ prompt_tokens: 10, completion_tokens: 2, cost: 0 }, 'OpenRouter')).toMatchObject(
      {
        reportedCostUsd: 0,
      },
    );
  });
});
