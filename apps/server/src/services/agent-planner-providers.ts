// WHICH MODEL PLANS, AND HOW TO REACH IT — the provider table, and the factory
// that builds a planner from a model id.
//
// ⛔ EVAL-ONLY FOR EVERY ROW THAT IS NOT CLAUDE. Nothing in production calls
// this factory (bootstrap still constructs `ClaudeAgentDecomposer` directly), no
// non-Claude id is in `AgentModelSchema` or any public enum, and a customer
// cannot pick one. The rows exist so the live eval can run the bake-off the
// owner asked for on the day the keys exist, with no further code.
//
// ⛔ ONE PLACE. Every fact the bake-off depends on — endpoint, model id, key
// variable, how the reply is constrained, how reasoning is turned down, and the
// price the spend cap is enforced at — is in the row, beside the documentation
// it was checked against. A row marked UNVERIFIED says which part nobody has
// confirmed from the provider's own current docs; the first live run is what
// confirms it (a rejected control is dropped and REMEMBERED by the adapter, and
// the report says so, so a wrong guess costs one request, not the run).
//
// Verified 2026-09-18 by fetching each URL cited, unless a field says otherwise;
// the OpenRouter rows on 2026-09-19.
// Prices are list prices in US dollars per million tokens.

import { CLAUDE_MODELS, AgentModelSchema, type AgentModel } from '@driftstack/api-types';
import type { AgentDecomposer } from './agent-decomposer.js';
import {
  ClaudeAgentDecomposer,
  type ClaudeAgentDecomposerDeps,
} from './agent-decomposer-claude.js';
import {
  OpenAICompatibleAgentDecomposer,
  type ChatCompletionsTarget,
  type ChatMaxCompletionTokensCeiling,
  type ChatModelPrices,
  type OpenAICompatibleAgentDecomposerDeps,
  type OpenRouterRoute,
} from './agent-decomposer-openai-compatible.js';

/** A provider reached over OpenAI-style chat completions. */
export interface ChatProvider {
  id: string;
  /** How the provider is named in an error message. */
  label: string;
  baseUrl: string;
  /** The environment variable the live eval reads this provider's key from. A
   *  NAME only — this module never reads the environment. */
  keyEnvVar: string;
  /** Where the endpoint, auth and wire shape were checked. */
  docsUrl: string;
}

/** One model on one chat-completions provider. */
export interface ChatPlannerModel {
  /** `provider:model`, what EVAL_LIVE_MODEL takes. */
  qualifiedId: string;
  provider: ChatProvider;
  /** The provider's own model id. */
  model: string;
  replyFormat: ChatCompletionsTarget['replyFormat'];
  replyFormatSource: string;
  reasoningEffort: string | null;
  reasoningSource: string;
  maxTokensParam: ChatCompletionsTarget['maxTokensParam'];
  prices: ChatModelPrices;
  /** A scheduled list-price change: from `from` (inclusive, UTC date) the
   *  prices are these. The meter prices each call at the rate on the day. */
  priceChange?: { from: string; prices: ChatModelPrices };
  priceSource: string;
  /** What in this row is NOT confirmed from the provider's current docs. */
  unverified: ReadonlyArray<string>;
  /**
   * P6 — a raised output ceiling for this family's ONE retry of a reply
   * truncated at the ordinary constant (`PLAN_MAX_COMPLETION_TOKENS` /
   * `ANSWER_MAX_COMPLETION_TOKENS` in the adapter). Absent everywhere except
   * the row the bake-off measured truncating: see `openrouter:openai/gpt-
   * 5.6-luna` below for the evidence. See `ChatMaxCompletionTokensCeiling`.
   */
  maxCompletionTokensCeiling?: ChatMaxCompletionTokensCeiling;
  /**
   * OpenRouter rows only: the ONE upstream the model is pinned to, and whether
   * Anthropic's automatic cache marker is sent. See `OpenRouterRoute` for what
   * reaches the wire, and why a pin with fallbacks off is what makes a run
   * measure the model it names.
   */
  openRouter?: OpenRouterRoute & {
    /** The upstream as a person names it, for the README and the report. */
    upstreamLabel: string;
    /** Where the pinned endpoint's slug, prices and parameters were read. */
    endpointsSource: string;
  };
}

const OPENAI: ChatProvider = {
  id: 'openai',
  label: 'OpenAI',
  baseUrl: 'https://api.openai.com/v1',
  keyEnvVar: 'OPENAI_API_KEY',
  docsUrl:
    'https://developers.openai.com/api/reference/python/resources/chat/subresources/completions/methods/create',
};
const GOOGLE: ChatProvider = {
  id: 'google',
  label: 'Google Gemini',
  // The Developer API's OpenAI-compatibility endpoint (labelled beta by Google).
  // Paid tier only for the bake-off: the free tier uses content to improve
  // products (research rows, 2026-09-18).
  baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
  keyEnvVar: 'GEMINI_API_KEY',
  docsUrl: 'https://ai.google.dev/gemini-api/docs/openai',
};
const BASETEN: ChatProvider = {
  id: 'baseten',
  label: 'Baseten',
  baseUrl: 'https://inference.baseten.co/v1',
  keyEnvVar: 'BASETEN_API_KEY',
  docsUrl: 'https://docs.baseten.co/inference/model-apis/reasoning',
};
const FIREWORKS: ChatProvider = {
  id: 'fireworks',
  label: 'Fireworks',
  baseUrl: 'https://api.fireworks.ai/inference/v1',
  keyEnvVar: 'FIREWORKS_API_KEY',
  docsUrl: 'https://docs.fireworks.ai/api-reference/post-chatcompletions',
};
const CEREBRAS: ChatProvider = {
  id: 'cerebras',
  label: 'Cerebras',
  baseUrl: 'https://api.cerebras.ai/v1',
  keyEnvVar: 'CEREBRAS_API_KEY',
  docsUrl: 'https://inference-docs.cerebras.ai/capabilities/prompt-caching',
};
const MISTRAL: ChatProvider = {
  id: 'mistral',
  label: 'Mistral',
  // The EU endpoint: api.mistral.ai is global with no committed inference
  // location (research rows, 2026-09-18).
  baseUrl: 'https://api.eu.mistral.ai/v1',
  keyEnvVar: 'MISTRAL_API_KEY',
  docsUrl: 'https://docs.mistral.ai/api/',
};
const INCEPTION: ChatProvider = {
  id: 'inception',
  label: 'Inception',
  baseUrl: 'https://api.inceptionlabs.ai/v1',
  keyEnvVar: 'INCEPTION_API_KEY',
  docsUrl: 'https://docs.inceptionlabs.ai/get-started/models',
};

/**
 * ONE key for the cross-provider comparison: OpenRouter speaks chat
 * completions (verified 2026-09-19: "pointing its baseURL to
 * https://openrouter.ai/api/v1") and reaches Claude, OpenAI, Gemini and the
 * open-weights hosts behind a single `Authorization: Bearer` key.
 *
 * ⛔ FOR THE COMPARISON, NOT FOR PRODUCTION, AND ON SYNTHETIC PAGES ONLY. It is
 * an extra network hop (latency is one of the two things being chosen on, so
 * final latency numbers come from direct keys), and OpenRouter's zero-data-
 * retention list has NO endpoint for first-party Anthropic or first-party
 * OpenAI (https://openrouter.ai/api/v1/endpoints/zdr, fetched 2026-09-19) — so
 * nothing but the eval's fixture pages may be sent through it.
 */
const OPENROUTER: ChatProvider = {
  id: 'openrouter',
  label: 'OpenRouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  keyEnvVar: 'OPENROUTER_API_KEY',
  docsUrl: 'https://openrouter.ai/docs/quickstart',
};

/**
 * OpenRouter's platform fee on pay-as-you-go ("Standard") credit: 5.5%
 * (https://openrouter.ai/pricing, fetched 2026-09-19). Token prices themselves
 * are the upstream's list price, passed through (each row's endpoints page).
 *
 * ⛔ THE FEE IS ON THE CREDIT, SO IT IS ON EVERY TOKEN. A dollar of credit buys
 * a dollar of list-price tokens and costs $1.055; pricing the cap at list alone
 * would under-count every call by 5.5%, and the cap must fail towards stopping.
 */
export const OPENROUTER_FEE_RATE = 0.055;

/** Upstream list prices with OpenRouter's fee on every token class. Rounded to
 *  the micro-dollar so the table reads as prices, not float noise. */
export function withOpenRouterFee(upstream: ChatModelPrices): ChatModelPrices {
  const fee = (usd: number): number => Math.round(usd * (1 + OPENROUTER_FEE_RATE) * 1e6) / 1e6;
  return {
    inputUsdPerMTok: fee(upstream.inputUsdPerMTok),
    cachedInputUsdPerMTok: fee(upstream.cachedInputUsdPerMTok),
    cacheWriteUsdPerMTok:
      upstream.cacheWriteUsdPerMTok === null ? null : fee(upstream.cacheWriteUsdPerMTok),
    outputUsdPerMTok: fee(upstream.outputUsdPerMTok),
  };
}

const OPENROUTER_FEE_SOURCE = '+5.5% OpenRouter fee (https://openrouter.ai/pricing)';
const OPENROUTER_REASONING_SOURCE = 'https://openrouter.ai/docs/use-cases/reasoning-tokens';
const OPENROUTER_STRUCTURED_SOURCE = 'https://openrouter.ai/docs/features/structured-outputs';
const openRouterEndpoints = (slug: string): string =>
  `https://openrouter.ai/api/v1/models/${slug}/endpoints`;

const GEMINI_PROMO_PRICES: ChatModelPrices = {
  inputUsdPerMTok: 0.75,
  cachedInputUsdPerMTok: 0.075,
  cacheWriteUsdPerMTok: null,
  outputUsdPerMTok: 3.75,
};
const GEMINI_2027_PRICES: ChatModelPrices = {
  inputUsdPerMTok: 1.5,
  cachedInputUsdPerMTok: 0.15,
  cacheWriteUsdPerMTok: null,
  outputUsdPerMTok: 7.5,
};

/** The chat-completions rows. The Claude models are not here: they are the
 *  api-types registry (`CLAUDE_MODELS`), priced and capability-described there. */
export const CHAT_PLANNER_MODELS: ReadonlyArray<ChatPlannerModel> = [
  {
    qualifiedId: 'openai:gpt-5.6-luna',
    provider: OPENAI,
    model: 'gpt-5.6-luna',
    replyFormat: 'json_schema_strict',
    replyFormatSource: 'https://developers.openai.com/api/docs/guides/structured-outputs',
    // "Reasoning.effort supports: none, low, medium (default), high, xhigh, and max".
    reasoningEffort: 'none',
    reasoningSource: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    maxTokensParam: 'max_completion_tokens',
    // Cache writes at 1.25x the uncached input rate.
    prices: {
      inputUsdPerMTok: 0.2,
      cachedInputUsdPerMTok: 0.02,
      cacheWriteUsdPerMTok: 0.25,
      outputUsdPerMTok: 1.2,
    },
    priceSource: 'https://developers.openai.com/api/docs/models/gpt-5.6-luna',
    unverified: [
      'whether chat completions report cache writes as prompt_tokens_details.cache_write_tokens (the caching guide names the Responses-API field)',
    ],
  },
  {
    qualifiedId: 'google:gemini-3.8-flash',
    provider: GOOGLE,
    model: 'gemini-3.8-flash',
    replyFormat: 'json_schema',
    replyFormatSource: 'https://ai.google.dev/gemini-api/docs/openai',
    // The compatibility layer maps reasoning_effort onto thinking_level;
    // "Reasoning cannot be turned off for … 3 models", and this model does not
    // accept "minimal" — so "low" is its floor.
    reasoningEffort: 'low',
    reasoningSource: 'https://ai.google.dev/gemini-api/docs/models/gemini-3.8-flash',
    maxTokensParam: 'max_tokens',
    prices: GEMINI_PROMO_PRICES,
    priceChange: { from: '2027-01-01', prices: GEMINI_2027_PRICES },
    priceSource: 'https://ai.google.dev/gemini-api/docs/pricing',
    unverified: [
      'response_format json_schema through the compatibility endpoint (the page shows structured output via a parsed schema, and does not name json_schema or strict)',
      'which usage fields the compatibility endpoint reports for cached and reasoning tokens',
      'the cache minimum of 4,096 tokens (research rows) means the ~3k-token static prefix will usually not cache',
    ],
  },
  {
    qualifiedId: 'google:gemini-3.6-flash',
    provider: GOOGLE,
    model: 'gemini-3.6-flash',
    replyFormat: 'json_schema',
    replyFormatSource: 'https://ai.google.dev/gemini-api/docs/openai',
    reasoningEffort: 'minimal',
    reasoningSource: 'https://ai.google.dev/gemini-api/docs/openai',
    maxTokensParam: 'max_tokens',
    prices: GEMINI_PROMO_PRICES,
    priceChange: { from: '2027-01-01', prices: GEMINI_2027_PRICES },
    priceSource: 'https://ai.google.dev/gemini-api/docs/pricing',
    unverified: [
      'that gemini-3.6-flash accepts "minimal" (the compatibility page maps minimal → thinking_level minimal; the model page fetched does not list its levels)',
      'response_format json_schema through the compatibility endpoint',
    ],
  },
  {
    qualifiedId: 'baseten:deepseek-v4.1-flash',
    provider: BASETEN,
    model: 'deepseek-ai/DeepSeek-V4.1-Flash',
    replyFormat: 'json_schema',
    replyFormatSource: 'https://docs.baseten.co/development/model-apis/overview',
    // "none", "low", "high" (default), "max" — "Set reasoning_effort to none to
    // request a direct answer".
    reasoningEffort: 'none',
    reasoningSource: 'https://docs.baseten.co/inference/model-apis/reasoning',
    maxTokensParam: 'max_tokens',
    prices: {
      inputUsdPerMTok: 0.3,
      cachedInputUsdPerMTok: 0.03,
      cacheWriteUsdPerMTok: null,
      outputUsdPerMTok: 1.2,
    },
    priceSource: 'https://www.baseten.co/library/deepseek-v41-flash/',
    unverified: [
      'json_schema support and whether it is enforced during generation (not stated on the pages fetched)',
      'whether usage reports cached prompt tokens',
    ],
  },
  {
    qualifiedId: 'fireworks:deepseek-v4.1-flash',
    provider: FIREWORKS,
    model: 'accounts/fireworks/models/deepseek-v4p1-flash',
    // "enforced during generation"; json_schema mode disables reasoning output.
    replyFormat: 'json_schema',
    replyFormatSource:
      'https://docs.fireworks.ai/structured-responses/structured-response-formatting',
    reasoningEffort: 'none',
    reasoningSource: 'https://docs.fireworks.ai/guides/reasoning',
    maxTokensParam: 'max_tokens',
    prices: {
      inputUsdPerMTok: 0.22,
      cachedInputUsdPerMTok: 0.007,
      cacheWriteUsdPerMTok: null,
      outputUsdPerMTok: 0.66,
    },
    priceSource: 'https://fireworks.ai/models/deepseek-ai/deepseek-v4p1-flash',
    unverified: [
      'reasoning_effort "none" for DeepSeek V4.1 specifically (documented generically only)',
    ],
  },
  {
    qualifiedId: 'cerebras:qwen-3.8-27b',
    provider: CEREBRAS,
    model: 'qwen-3.8-27b',
    // strict: true is constrained decoding; ≤ 5,000 schema characters, no
    // recursion, no oneOf/allOf, anyOf only below the root.
    replyFormat: 'json_schema_strict',
    replyFormatSource: 'https://inference-docs.cerebras.ai/capabilities/structured-outputs',
    reasoningEffort: 'none',
    reasoningSource: 'https://inference-docs.cerebras.ai/models/qwen-3.8-27b',
    maxTokensParam: 'max_completion_tokens',
    // "Input tokens, whether served from the cache or processed fresh, are billed
    // at the standard input token rate."
    prices: {
      inputUsdPerMTok: 0.99,
      cachedInputUsdPerMTok: 0.99,
      cacheWriteUsdPerMTok: null,
      outputUsdPerMTok: 1.49,
    },
    priceSource: 'https://inference-docs.cerebras.ai/models/qwen-3.8-27b',
    unverified: ['streaming together with strict structured outputs (neither page addresses it)'],
  },
  {
    qualifiedId: 'mistral:mistral-small-2603',
    provider: MISTRAL,
    model: 'mistral-small-2603',
    // json_schema "guarantees the message … follows the schema"; no `strict`
    // member is documented, so none is sent.
    replyFormat: 'json_schema',
    replyFormatSource: 'https://docs.mistral.ai/api/',
    reasoningEffort: 'none',
    reasoningSource: 'https://docs.mistral.ai/api/',
    maxTokensParam: 'max_tokens',
    prices: {
      inputUsdPerMTok: 0.165,
      cachedInputUsdPerMTok: 0.0165,
      cacheWriteUsdPerMTok: null,
      outputUsdPerMTok: 0.66,
    },
    priceSource: 'research rows 2026-09-18 (EU endpoint, +10%); not re-fetched this round',
    unverified: [
      'the price (taken from the research rows, not re-fetched)',
      'that mistral-small-2603 is served on api.eu.mistral.ai',
      'the usage field Mistral reports cached tokens in',
      'that stream_options.include_usage is honoured (the API page does not name it; without it every call is metered at its ceiling)',
    ],
  },
  {
    qualifiedId: 'inception:mercury-2.5',
    provider: INCEPTION,
    model: 'mercury-2.5',
    replyFormat: 'json_schema',
    replyFormatSource: 'https://docs.inceptionlabs.ai/get-started/models',
    // "instant", "low", "medium" (default), "high"; instant is the lowest-latency.
    reasoningEffort: 'instant',
    reasoningSource: 'https://docs.inceptionlabs.ai/capabilities/reasoning-efforts',
    maxTokensParam: 'max_tokens',
    // LIST price, although it is shown at 80% off ($0.04 / $0.004 / $0.15): a
    // spend cap enforced at a promotion that can end mid-run would under-count,
    // and the cap must fail towards stopping.
    prices: {
      inputUsdPerMTok: 0.2,
      cachedInputUsdPerMTok: 0.02,
      cacheWriteUsdPerMTok: null,
      outputUsdPerMTok: 0.75,
    },
    priceSource: 'https://docs.inceptionlabs.ai/get-started/models',
    unverified: [
      'the response_format request shape (structured outputs are listed as a feature; the request member is not documented on the pages fetched)',
      'whether reasoning can be switched fully off',
    ],
  },

  // ── THE SAME MODELS THROUGH ONE OPENROUTER KEY ─────────────────────────
  //
  // Verified 2026-09-19 against OpenRouter's current docs and each model's
  // endpoints list (every slug below resolved there). Each row is PINNED to one
  // upstream — `provider: {only: [that one], allow_fallbacks: false,
  // require_parameters: true}` — chosen as the first-party host where one
  // serves structured outputs, so a run measures the model it names on the host
  // it names, and a host without json_schema is refused rather than routed to.
  // `max_tokens` everywhere: it is the member every pinned endpoint lists in
  // its supported parameters, and `require_parameters` routes only to
  // endpoints that support every parameter sent.
  {
    // The like-for-like CONTROL: the product's default model, through the same
    // hop the challengers take. Its gap to a direct `claude-sonnet-5` run is the
    // aggregator's own cost in latency and caching, not the model's.
    qualifiedId: 'openrouter:anthropic/claude-sonnet-5',
    provider: OPENROUTER,
    model: 'anthropic/claude-sonnet-5',
    // The schema as the Claude adapter writes it, no `strict` member: Anthropic
    // constrains decoding to the schema either way, and this is the schema the
    // product sends Claude today.
    replyFormat: 'json_schema',
    replyFormatSource: OPENROUTER_STRUCTURED_SOURCE,
    // The product's policy for this model is adaptive thinking at effort low.
    reasoningEffort: 'low',
    reasoningSource: OPENROUTER_REASONING_SOURCE,
    maxTokensParam: 'max_tokens',
    prices: withOpenRouterFee({
      inputUsdPerMTok: 2,
      cachedInputUsdPerMTok: 0.2,
      cacheWriteUsdPerMTok: 2.5,
      outputUsdPerMTok: 10,
    }),
    priceSource: `${openRouterEndpoints('anthropic/claude-sonnet-5')} (upstream "anthropic") ${OPENROUTER_FEE_SOURCE}`,
    unverified: [
      'that reasoning.effort "low" reaches Claude as adaptive thinking at effort low, as the product sends it (OpenRouter\'s reasoning guide describes a thinking-budget mapping for Anthropic models)',
      'that prompt_tokens includes the cached part for an Anthropic-routed call, as it does for OpenAI',
    ],
    openRouter: {
      only: 'anthropic',
      cacheControl: true,
      upstreamLabel: 'Anthropic (first-party)',
      endpointsSource: openRouterEndpoints('anthropic/claude-sonnet-5'),
    },
  },
  {
    qualifiedId: 'openrouter:anthropic/claude-opus-5',
    provider: OPENROUTER,
    model: 'anthropic/claude-opus-5',
    replyFormat: 'json_schema',
    replyFormatSource: OPENROUTER_STRUCTURED_SOURCE,
    reasoningEffort: 'low',
    reasoningSource: OPENROUTER_REASONING_SOURCE,
    maxTokensParam: 'max_tokens',
    prices: withOpenRouterFee({
      inputUsdPerMTok: 5,
      cachedInputUsdPerMTok: 0.5,
      cacheWriteUsdPerMTok: 6.25,
      outputUsdPerMTok: 25,
    }),
    priceSource: `${openRouterEndpoints('anthropic/claude-opus-5')} (upstream "anthropic") ${OPENROUTER_FEE_SOURCE}`,
    unverified: [
      'that reasoning.effort "low" reaches Claude as adaptive thinking at effort low',
      'that prompt_tokens includes the cached part for an Anthropic-routed call',
    ],
    openRouter: {
      only: 'anthropic',
      cacheControl: true,
      upstreamLabel: 'Anthropic (first-party)',
      endpointsSource: openRouterEndpoints('anthropic/claude-opus-5'),
    },
  },
  {
    qualifiedId: 'openrouter:anthropic/claude-haiku-4.5',
    provider: OPENROUTER,
    model: 'anthropic/claude-haiku-4.5',
    replyFormat: 'json_schema',
    replyFormatSource: OPENROUTER_STRUCTURED_SOURCE,
    // A budget-thinking model, which the product runs with thinking OFF; off is
    // Anthropic's default, so nothing is sent.
    reasoningEffort: null,
    reasoningSource: OPENROUTER_REASONING_SOURCE,
    maxTokensParam: 'max_tokens',
    prices: withOpenRouterFee({
      inputUsdPerMTok: 1,
      cachedInputUsdPerMTok: 0.1,
      cacheWriteUsdPerMTok: 1.25,
      outputUsdPerMTok: 5,
    }),
    priceSource: `${openRouterEndpoints('anthropic/claude-haiku-4.5')} (upstream "anthropic") ${OPENROUTER_FEE_SOURCE}`,
    // Verified, and it decides the cost: OpenRouter's caching guide gives Haiku
    // 4.5 a 4,096-token cache minimum, above the ~3k-token static prefix, so
    // its calls will usually pay full input.
    unverified: ['that prompt_tokens includes the cached part for an Anthropic-routed call'],
    openRouter: {
      only: 'anthropic',
      cacheControl: true,
      upstreamLabel: 'Anthropic (first-party)',
      endpointsSource: openRouterEndpoints('anthropic/claude-haiku-4.5'),
    },
  },
  {
    qualifiedId: 'openrouter:openai/gpt-5.6-luna',
    provider: OPENROUTER,
    model: 'openai/gpt-5.6-luna',
    replyFormat: 'json_schema_strict',
    replyFormatSource: OPENROUTER_STRUCTURED_SOURCE,
    reasoningEffort: 'none',
    reasoningSource: OPENROUTER_REASONING_SOURCE,
    maxTokensParam: 'max_tokens',
    // The STANDARD tier: the base slug "openai" does not match openai/flex or
    // openai/fast ("service tier endpoints … are not matched by base slugs").
    prices: withOpenRouterFee({
      inputUsdPerMTok: 0.2,
      cachedInputUsdPerMTok: 0.02,
      cacheWriteUsdPerMTok: 0.25,
      outputUsdPerMTok: 1.2,
    }),
    priceSource: `${openRouterEndpoints('openai/gpt-5.6-luna')} (upstream "openai", standard tier) ${OPENROUTER_FEE_SOURCE}`,
    unverified: [
      'that reasoning.effort "none" is accepted for this model (the reasoning guide lists "none"; the model\'s own supported efforts were not readable from the catalogue)',
    ],
    openRouter: {
      only: 'openai',
      cacheControl: false,
      upstreamLabel: 'OpenAI (first-party, standard tier)',
      endpointsSource: openRouterEndpoints('openai/gpt-5.6-luna'),
    },
    // P6 — MEASURED, NOT GUESSED. Hard safety corpus, run 22 (2026-09-20,
    // /private/tmp/ds-gate/live-eval/run22-safety/or-gpt-5.6-luna-safety.json):
    // 2 of 170 trials truncated at the ordinary PLAN_MAX_COMPLETION_TOKENS
    // (8,192) with the reply still incomplete — L-SAFE-INJECTION rep 7 (this
    // rep's total output tokens: 8,321) and L-SAFE-UGC-TOOL rep 10 (8,329),
    // both landing right at the ceiling despite `reasoning_effort: "none"`
    // being sent (`requestControls.effortSent` in that same report) — this
    // family spends the shared budget on reasoning the request asked it not
    // to produce (the qualification-run verdict says so explicitly: "the
    // output ceiling was tuned for a model whose reasoning does not spend the
    // output budget — luna's does"). Doubled for margin: 16,384. (It had an
    // answer ceiling too, removed with the read-back retry it raised, #16.)
    maxCompletionTokensCeiling: { plan: 16_384 },
  },
  {
    qualifiedId: 'openrouter:google/gemini-3.8-flash',
    provider: OPENROUTER,
    model: 'google/gemini-3.8-flash',
    replyFormat: 'json_schema',
    replyFormatSource: OPENROUTER_STRUCTURED_SOURCE,
    // Reasoning cannot be off on Gemini 3 Flash; OpenRouter maps effort
    // straight onto thinkingLevel ("low" → "low").
    reasoningEffort: 'low',
    reasoningSource: OPENROUTER_REASONING_SOURCE,
    maxTokensParam: 'max_tokens',
    // Vertex, not AI Studio: the same list price, and it is the upstream on
    // OpenRouter's zero-retention list for this model. The storage-priced cache
    // write is priced at the input rate here (null), the dearer reading.
    prices: withOpenRouterFee(GEMINI_PROMO_PRICES),
    priceChange: { from: '2027-01-01', prices: withOpenRouterFee(GEMINI_2027_PRICES) },
    priceSource: `${openRouterEndpoints('google/gemini-3.8-flash')} (upstream "google-vertex/global") ${OPENROUTER_FEE_SOURCE}`,
    unverified: [
      'the cache minimum: Google documents 4,096 tokens for 3.x Flash, so the static prefix will usually not cache',
    ],
    openRouter: {
      only: 'google-vertex/global',
      cacheControl: false,
      upstreamLabel: 'Google Vertex AI (global)',
      endpointsSource: openRouterEndpoints('google/gemini-3.8-flash'),
    },
  },
  {
    qualifiedId: 'openrouter:z-ai/glm-5.3-flash',
    provider: OPENROUTER,
    model: 'z-ai/glm-5.3-flash',
    replyFormat: 'json_schema',
    replyFormatSource: OPENROUTER_STRUCTURED_SOURCE,
    // Not "none": the research rows record reasoning as MANDATORY for this
    // model, and a mandatory-reasoning model rejects effort "none".
    reasoningEffort: 'low',
    reasoningSource: OPENROUTER_REASONING_SOURCE,
    maxTokensParam: 'max_tokens',
    // Together: a US host, unquantised as listed ("unknown", not fp4/fp8),
    // structured_outputs in its supported parameters, and 99% uptime over a
    // day when checked. The Z.AI first-party endpoint does not list
    // structured outputs. No cache write price is listed (null → input rate).
    prices: withOpenRouterFee({
      inputUsdPerMTok: 0.15,
      cachedInputUsdPerMTok: 0.03,
      cacheWriteUsdPerMTok: null,
      outputUsdPerMTok: 0.5,
    }),
    priceSource: `${openRouterEndpoints('z-ai/glm-5.3-flash')} (upstream "together") ${OPENROUTER_FEE_SOURCE}`,
    unverified: [
      'that reasoning is mandatory and accepts "low" (from the research rows; the catalogue did not show the reasoning config when re-checked)',
      'whether Together enforces json_schema during generation or treats it as guidance',
      "Together is not on OpenRouter's zero-retention list for this model",
    ],
    openRouter: {
      only: 'together',
      cacheControl: false,
      upstreamLabel: 'Together',
      endpointsSource: openRouterEndpoints('z-ai/glm-5.3-flash'),
    },
  },
];

/** The prices in force on `day` (UTC). */
export function chatPricesOn(row: ChatPlannerModel, day: Date): ChatModelPrices {
  if (row.priceChange !== undefined && day.toISOString().slice(0, 10) >= row.priceChange.from) {
    return row.priceChange.prices;
  }
  return row.prices;
}

export class UnknownPlannerModelError extends Error {
  constructor(id: string) {
    super(
      `"${id}" is not a planner model. Use a Claude model (${Object.keys(CLAUDE_MODELS).join(', ')}, optionally as anthropic:<id>) or one of: ${CHAT_PLANNER_MODELS.map((m) => m.qualifiedId).join(', ')}`,
    );
    this.name = 'UnknownPlannerModelError';
  }
}

/** A model id, resolved to the adapter family that serves it. */
export type PlannerModelSelection =
  | { kind: 'claude'; model: AgentModel }
  | { kind: 'chat'; row: ChatPlannerModel };

/**
 * `claude-sonnet-5`, `anthropic:claude-sonnet-5` → the Claude adapter;
 * `openai:gpt-5.6-luna` and the other rows above → the chat-completions adapter.
 * Anything else throws, naming what would have been accepted: a typo must never
 * quietly measure a different model than the one it was meant to.
 */
export function resolvePlannerModel(id: string): PlannerModelSelection {
  const trimmed = id.trim();
  const claudeId = trimmed.startsWith('anthropic:') ? trimmed.slice('anthropic:'.length) : trimmed;
  const claude = AgentModelSchema.safeParse(claudeId);
  if (claude.success) return { kind: 'claude', model: claude.data };
  const row = CHAT_PLANNER_MODELS.find((m) => m.qualifiedId === trimmed);
  if (row === undefined) throw new UnknownPlannerModelError(trimmed);
  return { kind: 'chat', row };
}

/** The adapter's view of a row, with the prices in force on `day`. */
export function chatTarget(row: ChatPlannerModel, day: Date = new Date()): ChatCompletionsTarget {
  return {
    qualifiedId: row.qualifiedId,
    label: row.provider.label,
    baseUrl: row.provider.baseUrl,
    model: row.model,
    replyFormat: row.replyFormat,
    reasoningEffort: row.reasoningEffort,
    maxTokensParam: row.maxTokensParam,
    prices: chatPricesOn(row, day),
    // Only the two members the wire needs; a direct row gets no key at all, so
    // its target — and its request — is what it always was.
    ...(row.openRouter !== undefined
      ? { openRouter: { only: row.openRouter.only, cacheControl: row.openRouter.cacheControl } }
      : {}),
    // P6 — absent for every row but the one the bake-off measured truncating,
    // so every other target's request is byte-identical to before this field
    // existed (see `ChatMaxCompletionTokensCeiling`).
    ...(row.maxCompletionTokensCeiling !== undefined
      ? { maxCompletionTokensCeiling: row.maxCompletionTokensCeiling }
      : {}),
  };
}

export interface CreatePlannerOptions {
  /** Deps for the Claude adapter. Its key arrives per call, as in production. */
  claude?: ClaudeAgentDecomposerDeps;
  /** Deps for a chat-completions adapter, minus the target the id chose. Its
   *  key is REQUIRED here, and is never taken from a call's Anthropic-key slot. */
  chat?: Omit<OpenAICompatibleAgentDecomposerDeps, 'target'>;
  /** The day the chat row is priced for. Today by default. */
  day?: Date;
}

/**
 * Build the planner for a model id.
 *
 * ⛔ A CLAUDE ID GETS EXACTLY WHAT PRODUCTION BUILDS: `new
 * ClaudeAgentDecomposer(deps)`, which serves every Claude model and takes the
 * model per call from the session. Wiring this into bootstrap for Claude ids is
 * therefore a no-op on the wire; see the provider lane's hand-off for the line.
 */
export function createPlannerDecomposer(
  id: string,
  options: CreatePlannerOptions = {},
): { decomposer: AgentDecomposer; selection: PlannerModelSelection } {
  const selection = resolvePlannerModel(id);
  switch (selection.kind) {
    case 'claude':
      return { decomposer: new ClaudeAgentDecomposer(options.claude ?? {}), selection };
    case 'chat': {
      if (options.chat === undefined || options.chat.apiKey === '') {
        throw new Error(
          `${selection.row.qualifiedId} needs its provider key (${selection.row.provider.keyEnvVar})`,
        );
      }
      return {
        decomposer: new OpenAICompatibleAgentDecomposer({
          ...options.chat,
          target: chatTarget(selection.row, options.day ?? new Date()),
        }),
        selection,
      };
    }
    default: {
      // Exhaustiveness: a selection kind added without a case here must not
      // fall through to a planner nobody chose.
      const _exhaustive: never = selection;
      void _exhaustive;
      throw new UnknownPlannerModelError(id);
    }
  }
}
