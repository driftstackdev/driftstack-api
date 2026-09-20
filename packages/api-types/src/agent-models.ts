import { z } from 'zod';

// ───────────────────────────────────────────────────────────────────────────
// Agent model registry (#15 / 6.c — per-session model picker)
// ───────────────────────────────────────────────────────────────────────────
//
// The Claude lineup a customer can pick per agent-session. This is the
// single source of truth for: (a) the selectable model ids + display labels
// surfaced by the dashboard/SDK picker, and (b) the per-model cost-to-serve
// rates the usage writer + cost monitor charge against.
//
// Rates are Anthropic public LIST PRICE (verify quarterly + on model version
// bumps — https://platform.claude.com/docs/en/about-claude/pricing), expressed
// in cents per 1,000 tokens (the unit DEFAULT_COST_RATES / cost-estimator use).
// USD list price is treated ~1:1 with the EUR-cent accounting unit, matching
// the rest of the cost-to-serve rate card. These are an internal accounting
// concept (cost-to-serve) — they do NOT drive customer pricing.

export const AgentModelSchema = z.enum([
  // Claude 5 — the current generation. Listed first: this order IS the picker's
  // order on every surface that renders the registry.
  'claude-opus-5',
  'claude-sonnet-5',
  // Claude 4.x — kept selectable, and kept ACCEPTED forever regardless: sessions
  // created before the 5 lineup landed carry these ids in `agent_sessions.model`,
  // and a value the schema rejects would fail to read back a stored session.
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
]);
export type AgentModel = z.infer<typeof AgentModelSchema>;

/**
 * The default agent model when a session doesn't pick one.
 *
 * ⛔ NOT THE MOST CAPABLE MODEL, ON PURPOSE. It was Opus 5 on the reasoning that
 * the strongest planner is the safest default. Measured on the live eval
 * (2026-09-18, the looping turn, the same tasks, the scorer reading the device's
 * final state): Sonnet 5 completed every conclusive repetition, all on the
 * customer's first message, with a median planning call of 2.3 s against Opus 5's
 * 3.3 s, at roughly a third of the cost per task (~$0.01 vs ~$0.03). Planning a
 * handful of taps from a page digest does not need the largest model, and a
 * customer waiting in a chat pays for its latency on every step. The owner chose
 * Sonnet 5 as the default on that evidence, with cheaper models from other
 * providers to be evaluated once keys exist. Opus 5 stays selectable, and every
 * earlier id stays accepted so stored sessions still read back.
 */
export const DEFAULT_AGENT_MODEL: AgentModel = 'claude-sonnet-5';

export interface AgentModelInfo {
  /** Customer-facing label for the picker. */
  label: string;
  /** Anthropic list price, cents per 1,000 input tokens ($/MTok ÷ 10). */
  inputCentsPer1k: number;
  /** Anthropic list price, cents per 1,000 output tokens ($/MTok ÷ 10). */
  outputCentsPer1k: number;
  /**
   * Prompt-cache price multipliers, each RELATIVE TO `inputCentsPer1k`. They sit
   * beside the base price because a cached token is still an input token — only
   * its rate differs — and a rate that lives in a second file is the one that
   * goes stale. See {@link PROMPT_CACHE_PRICING}.
   */
  cacheWrite5mMultiplier: number;
  cacheWrite1hMultiplier: number;
  cacheReadMultiplier: number;
  /**
   * The shortest prompt prefix this model will cache at all.
   *
   * ⛔ BELOW IT, CACHING SILENTLY DOES NOTHING: no error, the request succeeds,
   * and `cache_creation_input_tokens` simply reads 0. It is NOT monotonic across
   * generations (512 on Opus 5, 4096 on Haiku 4.5), so "it caches on the default
   * model" says nothing about the model a customer picked. The count is of the
   * whole prefix up to a breakpoint (system prompt + any messages before it).
   */
  minCacheablePromptTokens: number;
}

/**
 * Prompt-cache price multipliers, relative to base input price.
 *
 * Source: https://platform.claude.com/docs/en/about-claude/pricing#prompt-caching
 * (read 2026-09-18): 5-minute cache write 1.25x, 1-hour cache write 2x, cache
 * read 0.1x. The same page prices the models in this registry per-MTok and every
 * row is exactly these multiples of its base input price (Opus 5: $5 → $6.25 /
 * $10 / $0.50). The one documented exception, a 0.025x read on Claude Fable 5.1
 * and Claude Mythos 5.1, is not a model this registry offers — which is why the
 * multipliers are PER-MODEL fields and not a single constant: the day such a
 * model is added, its row carries its own rate instead of inheriting this one.
 *
 * ⛔ Both ways of getting this wrong look fine. Pricing a cache read at the full
 * input rate overstates cost-to-serve ~10x on exactly the long sessions caching
 * exists for; not pricing it at all understates real spend. A cache WRITE costs
 * MORE than a plain input token, so a turn that only ever writes (a one-call
 * session) is dearer with caching on than off — that is the price of the reads.
 */
export const PROMPT_CACHE_PRICING = {
  cacheWrite5mMultiplier: 1.25,
  cacheWrite1hMultiplier: 2,
  cacheReadMultiplier: 0.1,
} as const;

/*
 * Per-model cost-to-serve rates. Anthropic list price (2026-05-27 founder
 * decision — use real list price, not the retired Opus 4.1 figure):
 *   - Opus 5     — $5 / $25 per MTok  → 0.5c / 2.5c per 1k. VERIFIED against the
 *                  pricing page 2026-09-18 (it had been carried provisionally
 *                  from the 4.x rate; the provisional figure turned out right).
 *   - Sonnet 5   — $2 / $10 per MTok  → 0.2c / 1.0c per 1k. VERIFIED 2026-09-18.
 *                  ⛔ The provisional figure here was Sonnet 4.6's $3 / $15 and it
 *                  was WRONG — every Sonnet 5 usage row before this overstated
 *                  cost-to-serve by 50%. The pricing page states the $2 / $10
 *                  launch price "is now the standard price" and the scheduled
 *                  rise to $3 / $15 "will not occur". Historical rows keep the
 *                  cost they recorded (we never recompute), so the correction
 *                  applies from here on.
 *   - Opus 4.8   — $5 / $25 per MTok  → 0.5c / 2.5c per 1k (latest 4.x Opus;
 *                  mirrors 4.7's list rate pending an Anthropic price update)
 *   - Opus 4.7   — $5 / $25 per MTok  → 0.5c / 2.5c per 1k
 *   - Sonnet 4.6 — $3 / $15 per MTok  → 0.3c / 1.5c per 1k
 *   - Haiku 4.5  — $1 / $5  per MTok  → 0.1c / 0.5c per 1k
 *
 * `minCacheablePromptTokens` — source:
 * https://platform.claude.com/docs/en/build-with-claude/prompt-caching (read
 * 2026-09-18): Opus 5 → 512; Opus 4.8, Sonnet 5, Sonnet 4.6 → 1024; Opus 4.7 →
 * 2048; Haiku 4.5 → 4096.
 */
/**
 * The models an AI session can use, with the label to show for each and the
 * rates a call is costed at. `minCacheablePromptTokens` is the shortest
 * prompt that model will cache, so a prompt below it is never a cache hit.
 */
export const CLAUDE_MODELS: Record<AgentModel, AgentModelInfo> = {
  'claude-opus-5': {
    label: 'Claude Opus 5',
    inputCentsPer1k: 0.5,
    outputCentsPer1k: 2.5,
    ...PROMPT_CACHE_PRICING,
    minCacheablePromptTokens: 512,
  },
  'claude-sonnet-5': {
    label: 'Claude Sonnet 5',
    inputCentsPer1k: 0.2,
    outputCentsPer1k: 1.0,
    ...PROMPT_CACHE_PRICING,
    minCacheablePromptTokens: 1024,
  },
  'claude-opus-4-8': {
    label: 'Claude Opus 4.8',
    inputCentsPer1k: 0.5,
    outputCentsPer1k: 2.5,
    ...PROMPT_CACHE_PRICING,
    minCacheablePromptTokens: 1024,
  },
  'claude-opus-4-7': {
    label: 'Claude Opus 4.7',
    inputCentsPer1k: 0.5,
    outputCentsPer1k: 2.5,
    ...PROMPT_CACHE_PRICING,
    minCacheablePromptTokens: 2048,
  },
  'claude-sonnet-4-6': {
    label: 'Claude Sonnet 4.6',
    inputCentsPer1k: 0.3,
    outputCentsPer1k: 1.5,
    ...PROMPT_CACHE_PRICING,
    minCacheablePromptTokens: 1024,
  },
  'claude-haiku-4-5': {
    label: 'Claude Haiku 4.5',
    inputCentsPer1k: 0.1,
    outputCentsPer1k: 0.5,
    ...PROMPT_CACHE_PRICING,
    minCacheablePromptTokens: 4096,
  },
};

/**
 * What each model ACCEPTS on a request, beside what it costs.
 *
 * A separate map rather than new members of {@link AgentModelInfo}, so every
 * existing reader and fixture of that interface is untouched.
 *
 * Sources, all read 2026-09-18:
 *  · https://platform.claude.com/docs/en/build-with-claude/thinking-troubleshooting
 *    (the per-model table): Opus 5 and Sonnet 5 think BY DEFAULT and accept
 *    `adaptive` and `disabled` (Opus 5 only at effort `high` or below); Opus
 *    4.8 / 4.7 and Sonnet 4.6 accept both and default to off; Haiku 4.5 is
 *    extended-thinking only — `adaptive` is a 400 there — and defaults to off.
 *  · https://platform.claude.com/docs/en/build-with-claude/effort — the
 *    supported-model list has no Haiku 4.5, so `output_config.effort` must not be
 *    sent to it.
 *  · https://platform.claude.com/docs/en/build-with-claude/structured-outputs —
 *    `output_config.format` is supported on every model in this registry.
 *
 * ⛔ WHY THIS IS DATA AND NOT A CONSTANT IN THE CALLER: a thinking configuration
 * one model requires is a 400 on another, and a 400 is a failed turn for a
 * customer who merely picked a different model in the picker.
 */
export interface AgentModelRequestCapabilities {
  /** `adaptive`: accepts `thinking: {type: "adaptive"}` and `{type: "disabled"}`.
   *  `budget`: extended thinking only — `adaptive` is rejected, `disabled` is
   *  accepted and is also what omitting the parameter means. */
  thinkingControl: 'adaptive' | 'budget';
  /** Whether `output_config.effort` is accepted at all. */
  supportsEffort: boolean;
  /** Whether `output_config.format` (a JSON-schema-constrained reply) is accepted. */
  supportsStructuredOutput: boolean;
}

export const CLAUDE_MODEL_REQUEST_CAPABILITIES: Record<AgentModel, AgentModelRequestCapabilities> =
  {
    'claude-opus-5': {
      thinkingControl: 'adaptive',
      supportsEffort: true,
      supportsStructuredOutput: true,
    },
    'claude-sonnet-5': {
      thinkingControl: 'adaptive',
      supportsEffort: true,
      supportsStructuredOutput: true,
    },
    'claude-opus-4-8': {
      thinkingControl: 'adaptive',
      supportsEffort: true,
      supportsStructuredOutput: true,
    },
    'claude-opus-4-7': {
      thinkingControl: 'adaptive',
      supportsEffort: true,
      supportsStructuredOutput: true,
    },
    'claude-sonnet-4-6': {
      thinkingControl: 'adaptive',
      supportsEffort: true,
      supportsStructuredOutput: true,
    },
    'claude-haiku-4-5': {
      thinkingControl: 'budget',
      supportsEffort: false,
      supportsStructuredOutput: true,
    },
  };

// ───────────────────────────────────────────────────────────────────────────
// Which key may run a model, and what a call on it costs at list price
// ───────────────────────────────────────────────────────────────────────────

/**
 * Which key a model may run on.
 *
 *  · `any_key` — your own model key, or the bundled key when your plan
 *    includes model usage.
 *  · `own_key_only` — your own model key only. Opus-class models are
 *    own-key-only: they cost several times more per turn than Sonnet, so a
 *    bundled key never runs them.
 *
 * ⛔ A TOTAL MAP OVER THE ENUM, ON PURPOSE. Adding a model to
 * {@link AgentModelSchema} without deciding its key policy is a type error here,
 * rather than a model that silently inherits `any_key` and runs on the
 * deployment's key. The desktop app's model picker reads this too, and marks
 * such a model "(needs your own key)" when the account is known to have no key.
 * The customer dashboard has no model picker.
 */
export type AgentModelKeyPolicy = 'any_key' | 'own_key_only';

export const CLAUDE_MODEL_KEY_POLICY: Record<AgentModel, AgentModelKeyPolicy> = {
  'claude-opus-5': 'own_key_only',
  'claude-sonnet-5': 'any_key',
  'claude-opus-4-8': 'own_key_only',
  'claude-opus-4-7': 'own_key_only',
  'claude-sonnet-4-6': 'any_key',
  'claude-haiku-4-5': 'any_key',
};

/**
 * The registry row for a model id, or null when the registry has no price for it.
 *
 * ⛔ AN OWN-PROPERTY LOOKUP, NOT `CLAUDE_MODELS[id]`. A stored id is typed
 * `AgentModel` but read from a database column by a cast, so the type proves
 * nothing about the value; and a plain index would answer `toString` or
 * `__proto__` with something that is not a price. Unknown means null — never a
 * default rate — because a model with no price is a model nobody can meter.
 */
export function agentModelListPrice(model: string): AgentModelInfo | null {
  const parsed = AgentModelSchema.safeParse(model);
  if (!parsed.success) return null;
  return Object.prototype.hasOwnProperty.call(CLAUDE_MODELS, parsed.data)
    ? CLAUDE_MODELS[parsed.data]
    : null;
}

/**
 * Why the deployment's key refuses a model, or null when it may run it.
 *
 *  · `unpriced` — no list price in the registry. A call on the deployment's key
 *    would be unmetered, so it must not happen. The customer's own key still
 *    runs it: the provider bills them directly.
 *  · `own_key_only` — see {@link CLAUDE_MODEL_KEY_POLICY}.
 *
 * An unknown `claude-opus-*` id is `unpriced` first: both are refusals, and
 * "we cannot price this" is the more fundamental of the two.
 */
export type DeploymentKeyModelRefusal = 'unpriced' | 'own_key_only';

export function deploymentKeyModelRefusal(model: string): DeploymentKeyModelRefusal | null {
  if (agentModelListPrice(model) === null) return 'unpriced';
  const parsed = AgentModelSchema.parse(model);
  return CLAUDE_MODEL_KEY_POLICY[parsed] === 'own_key_only' ? 'own_key_only' : null;
}

/**
 * The token counts of ONE model call, split the way the provider bills them.
 * `uncachedInput` is the provider's `input_tokens`, which — once caching is on —
 * is only the part of the prompt after the last cache breakpoint.
 */
export interface ModelCallTokens {
  uncachedInput: number;
  output: number;
  cacheRead: number;
  /** Tokens written to the 5-minute cache. */
  cacheWrite5m: number;
  /** Tokens written to the 1-hour cache. */
  cacheWrite1h: number;
}

/**
 * The list-price cost of one model call, in MILLICENTS (thousandths of a US cent),
 * or null when the model has no price in the registry or a count is not a
 * non-negative finite number. Null is "cannot say", never zero: a row that read 0
 * would claim a paid call was free.
 *
 * Every part at its own rate: uncached input at the input rate, output at the
 * output rate, a cache read at `cacheReadMultiplier` of the input rate, and each
 * cache write at its lifetime's multiplier.
 *
 * ⛔ NO ROUNDING UP. The per-call figure elsewhere (`costUsdCents`) is ceilinged to
 * a whole cent, which is right for a conservative per-row estimate and wrong for
 * a ledger: a session of two hundred small calls would be overstated by up to two
 * dollars. The arithmetic is done in microcents (tokens × cents-per-1k × 1000),
 * which is an integer for every rate in the registry, and the result is only
 * rounded to the nearest microcent to shed floating-point noise — so the value
 * is exact to 0.001 millicent, and never biased up or down.
 */
export function listPriceCostMillicents(model: string, tokens: ModelCallTokens): number | null {
  const rate = agentModelListPrice(model);
  if (rate === null) return null;
  const counts = [
    tokens.uncachedInput,
    tokens.output,
    tokens.cacheRead,
    tokens.cacheWrite5m,
    tokens.cacheWrite1h,
  ];
  if (!counts.every((n) => Number.isFinite(n) && n >= 0)) return null;
  const microcents =
    tokens.uncachedInput * rate.inputCentsPer1k * 1000 +
    tokens.output * rate.outputCentsPer1k * 1000 +
    tokens.cacheRead * rate.inputCentsPer1k * rate.cacheReadMultiplier * 1000 +
    tokens.cacheWrite5m * rate.inputCentsPer1k * rate.cacheWrite5mMultiplier * 1000 +
    tokens.cacheWrite1h * rate.inputCentsPer1k * rate.cacheWrite1hMultiplier * 1000;
  return Math.round(microcents) / 1000;
}
