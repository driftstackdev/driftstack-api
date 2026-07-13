// V-361 — AI agent layer NL→intent decomposer interface. AI-1
// slice = interface + types scaffold; concrete impl lands in
// follow-up slices (B1 Anthropic client wire + prompt template,
// B2 intent executor against existing session API, B3 per-session
// token budget enforcer, B4 recipe-library writer).
//
// Design doc: docs/internal/ai-chat-agent-layer-design.md
// Scope reversal: founder verdict 2026-05-16 moved this from v1.1
// → v1.0 launch arc ("close to finishing all tasks earlier on, and
// can work on these things just fine, so we should just do it
// before launch — a great feature that can attract many customers").
//
// Activation pattern follows the same all-or-nothing posture as
// Postmark / LiveKit / OAuth-client / session-egress — bootstrap
// wires `agentDecomposer` into AppDeps only when the Anthropic key
// path is configured (BYOK or bundled). Until then the /agent
// dashboard surface stays unregistered (404), matching the
// pre-Stripe-wire posture of /v1/billing.

/**
 * One turn in the chat transcript — either the customer's natural-
 * language task input, or the agent's decomposed plan / clarifying
 * question / refusal. Stored per agent-session in `agent_sessions`
 * (D1 design doc; landed under a separate slice).
 */

import type { AgentModel } from '@driftstack/api-types';

export interface TranscriptEntry {
  /** ISO timestamp the entry was created. */
  at: string;
  /**
   * Whose turn this is. 'operator' (Arc 2 sub-slice 8.6) is the
   * manual-mode actor — the human driving intents directly without a
   * decomposer call. Recipes assembly + dashboard UI both branch on
   * this so manual-driven turns render distinctly.
   */
  role: 'user' | 'agent' | 'operator';
  /** Free-text content for user turns; serialized DecomposeResult
   *  for agent turns. */
  body: string;
  /**
   * Structured plan intents for plan-executed agent turns
   * (Q.5.c, orchestrator handoff #3 follow-up). Undefined for
   * user turns + clarify/refuse agent turns. The recipes route
   * assembles a recipe's intent_log by flatMapping transcript[]
   * for this field so replay-as-script becomes possible without
   * re-running the LLM decomposer.
   */
  intents?: ReadonlyArray<AgentIntent>;
  /**
   * True only for an agent plan entry whose executor halted before a
   * consequential action. Approval resumption is bound to the immediately
   * preceding entry carrying this marker; completed plans are never replayed.
   */
  awaitingConfirmation?: boolean;
  /**
   * Zero-based index of the first intent that did not execute because the plan
   * paused for confirmation. Approval resumes from this exact suffix; omitting
   * it fails closed instead of replaying an already-applied plan prefix.
   */
  resumeFromIntentIndex?: number;
}

/**
 * Customer-supplied credentials for log-in flows the agent might
 * need to drive. Held in-memory for the agent-session lifetime and never
 * persisted in plaintext; transcript copies are protected by the encrypted
 * transcript envelope and rendered as `[redacted]` where applicable.
 */
export interface CredentialBag {
  username?: string;
  password?: string;
  /** Free-form per-credential metadata (e.g. 2FA seed, recovery
   *  email). Each key is treated as sensitive. */
  extras?: Readonly<Record<string, string>>;
}

/**
 * v2-#4 Q.1.e — per-call usage telemetry. ClaudeAgentDecomposer fills
 * this in; DeterministicAgentDecomposer leaves it `undefined`. The
 * AgentRuntime records a usage row when this is present so we can
 * cost-track every decompose() call even before the bundled-LLM tier
 * launches (founder Q.1.e verdict: cost-tracked, unbilled at v1.0).
 */
export interface DecomposeUsage {
  /** Discriminator used by the metering layer to render per-source
   *  reports + drive the future billed/unbilled toggle. */
  decomposerKind: 'claude' | 'deterministic';
  /** Anthropic input tokens reported by the API `usage.input_tokens`
   *  field. Undefined for deterministic. */
  anthropicInputTokens?: number;
  /** Anthropic output tokens reported by the API `usage.output_tokens`
   *  field. Undefined for deterministic. */
  anthropicOutputTokens?: number;
  /** Cost in USD cents (integer; rounded up to the nearest cent so
   *  short rows don't undercount). Computed from the per-model rate
   *  table in ClaudeAgentDecomposer. Undefined for deterministic. */
  costUsdCents?: number;
  /** Model identifier used for the call (so future pricing-table
   *  drift is recoverable from history). Undefined for deterministic. */
  model?: string;
}

/**
 * The agent emits one of these per turn. The transport layer
 * (SSE / WebSocket) marshals the discriminated union into the
 * shape the UI expects.
 */
export type DecomposeResult =
  | {
      kind: 'plan';
      /** Ordered sequence of intent calls the agent wants to make
       *  against the existing /v1/sessions/:id/* surface. The
       *  shape mirrors the session API exactly — the agent cannot
       *  invent new intent verbs. */
      intents: ReadonlyArray<AgentIntent>;
      tokensConsumed: number;
      /** v2-#4 Q.1.e — per-call usage telemetry. Optional so the
       *  deterministic decomposer + legacy callers don't have to
       *  populate it. AgentRuntime records a usage row when present. */
      usage?: DecomposeUsage;
    }
  | {
      kind: 'clarify';
      /** Free-text question for the customer when the task is
       *  ambiguous (e.g. "which dashboard do you mean?"). */
      clarifyingQuestion: string;
      tokensConsumed: number;
      usage?: DecomposeUsage;
    }
  | {
      kind: 'refuse';
      /** Customer-facing reason. Matches the AUP-refusal corpus
       *  the launch-checklist requires ≥95% coverage on. */
      refuseReason: string;
      tokensConsumed: number;
      usage?: DecomposeUsage;
    };

/**
 * The intent vocabulary the agent can call. Mirrors the existing
 * /v1/sessions/:id/{navigate,interact,wait,capture} routes; the
 * agent cannot invent new verbs (the prompt template includes the
 * vocabulary as a constraint). Schema-locked so the executor
 * (B2 follow-up) is a trivial switch.
 */
export type AgentIntent =
  | { kind: 'navigate'; url: string }
  | {
      kind: 'interact';
      // W540 — 'press' added (A3-W677 contract-first): the agent could type
      // text but never press a key (Enter to submit, Escape to dismiss).
      // `value` carries the key name; maps onto the driver interact press.
      action: 'tap' | 'type' | 'scroll' | 'swipe' | 'press';
      selector?: string;
      value?: string;
      /** Type-only: suppress behavioral typo correction for OTP/PIN/card values. */
      sensitive?: boolean;
    }
  | { kind: 'wait'; condition: 'idle' | 'selector_visible'; selector?: string; timeoutMs?: number }
  | { kind: 'capture'; capture: 'screenshot' | 'dom_snapshot' | 'pdf' }
  // Behavioural intents (Agent-3 API-gap, W140) — map server-side onto the
  // harness scroll / behavioral_pause control-plane intents.
  | { kind: 'scroll'; direction: 'up' | 'down'; amount_px?: number }
  | { kind: 'behavioral_pause'; duration_ms?: number; reading_word_count?: number };

/**
 * Per-call decomposer input. The service is stateless across calls;
 * callers thread the transcript explicitly so the agent has full
 * multi-turn context without the service holding session state.
 */
export interface DecomposeArgs {
  /** Free-text NL task from the customer. */
  task: string;
  /** Locked archetype the agent is driving — affects prompt
   *  framing (mobile-Safari-specific affordances). */
  archetype: string;
  /** Full transcript so far. The agent sees its own prior plans
   *  + the executor's intent-by-intent results, so multi-turn
   *  conversations stay coherent. */
  history: ReadonlyArray<TranscriptEntry>;
  /** Optional sensitive credentials the agent may need (opt-in
   *  per session). */
  credentials?: CredentialBag;
  /** Remaining per-session token budget (tier-tiered cap, see
   *  B3 design). When 0, calls return a refuse with reason
   *  "token budget exhausted; start a new session". */
  budgetTokensRemaining: number;
  /**
   * BYOK Anthropic API key (Tier-3 verdict LOCKED 2026-05-16:
   * BYOK for v1.0; bundled-LLM billing deferred to v1.1).
   *
   * The runtime resolves this in priority order:
   *   1. Customer-supplied key (stored encrypted per-account; passed
   *      through here per request — never persisted in transcript).
   *   2. Deployment fallback (`config.byokAnthropic.fallbackApiKey`,
   *      env `DRIFTSTACK_ANTHROPIC_FALLBACK_API_KEY`) — for the
   *      founder's own demos + integration tests.
   *
   * The DeterministicAgentDecomposer ignores this (no LLM call); the
   * real Claude-wired AI-B1.b impl uses it as the Authorization
   * header `x-api-key` value when calling Anthropic. NEVER logged,
   * NEVER echoed into transcript or error responses.
   */
  byokAnthropicApiKey?: string;
  /**
   * 6.c / #15 — Claude 4.x model the AI agent runs this turn, sourced
   * from the session's `agent_sessions.model`. The ClaudeAgentDecomposer
   * looks up its per-model cost-to-serve rate in the api-types
   * CLAUDE_MODELS registry; defaults to DEFAULT_AGENT_MODEL (Opus 4.7)
   * when unset. The DeterministicAgentDecomposer ignores it (no LLM call).
   */
  model?: AgentModel;
}

/**
 * #140 perceive-then-act (read-and-report) — the READ-BACK pass. After the
 * plan runs and page content is observed, the agent answers the customer's
 * original question FROM that content (e.g. "get the IP" → "Your IP is 1.2.3.4").
 */
export interface AnswerArgs {
  /** The customer's original question/task (the same NL string decompose saw). */
  task: string;
  /** Observed page content the answer is drawn from. This is UNTRUSTED,
   *  page-derived DATA — the impl frames it as data, never as instructions. */
  observation: string;
  /** Remaining per-session token budget; the caller gates on this. */
  budgetTokensRemaining: number;
  /** BYOK/fallback Anthropic key — same resolution + secrecy rules as
   *  DecomposeArgs.byokAnthropicApiKey. NEVER logged/echoed/persisted. */
  byokAnthropicApiKey?: string;
  /** Claude model for this call (per-model cost rate); defaults to
   *  DEFAULT_AGENT_MODEL. */
  model?: AgentModel;
}

export interface AnswerResult {
  /** Concise NL answer to the task, drawn ONLY from the observation. States
   *  plainly when the asked-for info is not present (never invents a value). */
  answer: string;
  /** Total tokens (input+output) for the read-back call — the caller debits +
   *  records these, exactly like a decompose turn. */
  tokensConsumed: number;
  usage?: DecomposeUsage;
}

/**
 * Service interface; impl lands in B1 (Anthropic Claude Opus 4.7
 * wire) per the design doc. Bootstrap wires the concrete instance
 * once the Anthropic credentials path is configured.
 */
export interface AgentDecomposer {
  /**
   * NL → intent decomposition for a single turn. Caller threads
   * the full transcript; the service is stateless. Returns one of
   * plan / clarify / refuse per the prompt-template branching.
   *
   * MUST never throw on AUP violations or token-budget exhaustion
   * — those surface as DecomposeResult discriminants instead. Only
   * non-recoverable errors (Anthropic upstream 5xx after retries,
   * credential decryption failure) escape as exceptions.
   */
  decompose(args: DecomposeArgs): Promise<DecomposeResult>;

  /**
   * #140 read-and-report — answer the customer's question from observed page
   * content. OPTIONAL: only the Claude-wired impl provides it (an LLM call);
   * the DeterministicAgentDecomposer omits it and the runtime feature-detects
   * (`if (decomposer.answerFromObservation)`) before use. Same never-log-the-key
   * + upstream-5xx-throws contract as decompose(); the observation is treated as
   * untrusted data by the impl's prompt frame.
   */
  answerFromObservation?(args: AnswerArgs): Promise<AnswerResult>;
}
