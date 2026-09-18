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

/** The default agent model when a session doesn't pick one (highest-capability).
 *  Bumped to Opus 5, the current-generation Opus; every earlier id stays accepted
 *  so sessions created before the bump still read back. */
export const DEFAULT_AGENT_MODEL: AgentModel = 'claude-opus-5';

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

/**
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
