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
}

/**
 * Per-model cost-to-serve rates. Anthropic list price (2026-05-27 founder
 * decision — use real list price, not the retired Opus 4.1 figure):
 *   - Opus 5     — ⚠️ PROVISIONAL: carries the Opus 4.x list rate (0.5c / 2.5c)
 *                  because the 5-generation list price was NOT verified when the
 *                  model was added. Same treatment 4.8 got on its own bump. This
 *                  is cost-to-serve accounting only — it does not touch customer
 *                  pricing — but it WILL under- or over-state margin until the
 *                  next quarterly pass confirms the real figure. Verify first.
 *   - Sonnet 5   — ⚠️ PROVISIONAL for the same reason: carries Sonnet 4.6's rate.
 *   - Opus 4.8   — $5 / $25 per MTok  → 0.5c / 2.5c per 1k (latest 4.x Opus;
 *                  mirrors 4.7's list rate pending an Anthropic price update)
 *   - Opus 4.7   — $5 / $25 per MTok  → 0.5c / 2.5c per 1k
 *   - Sonnet 4.6 — $3 / $15 per MTok  → 0.3c / 1.5c per 1k
 *   - Haiku 4.5  — $1 / $5  per MTok  → 0.1c / 0.5c per 1k
 */
export const CLAUDE_MODELS: Record<AgentModel, AgentModelInfo> = {
  'claude-opus-5': {
    label: 'Claude Opus 5',
    inputCentsPer1k: 0.5,
    outputCentsPer1k: 2.5,
  },
  'claude-sonnet-5': {
    label: 'Claude Sonnet 5',
    inputCentsPer1k: 0.3,
    outputCentsPer1k: 1.5,
  },
  'claude-opus-4-8': {
    label: 'Claude Opus 4.8',
    inputCentsPer1k: 0.5,
    outputCentsPer1k: 2.5,
  },
  'claude-opus-4-7': {
    label: 'Claude Opus 4.7',
    inputCentsPer1k: 0.5,
    outputCentsPer1k: 2.5,
  },
  'claude-sonnet-4-6': {
    label: 'Claude Sonnet 4.6',
    inputCentsPer1k: 0.3,
    outputCentsPer1k: 1.5,
  },
  'claude-haiku-4-5': {
    label: 'Claude Haiku 4.5',
    inputCentsPer1k: 0.1,
    outputCentsPer1k: 0.5,
  },
};
