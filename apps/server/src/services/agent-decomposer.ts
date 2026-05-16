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
export interface TranscriptEntry {
  /** ISO timestamp the entry was created. */
  at: string;
  /** Whose turn this is. */
  role: 'user' | 'agent';
  /** Free-text content for user turns; serialized DecomposeResult
   *  for agent turns. */
  body: string;
}

/**
 * Customer-supplied credentials for log-in flows the agent might
 * need to drive. Held in-memory for the agent-session lifetime;
 * never persisted. Logged in transcripts as `[redacted]`.
 */
export interface CredentialBag {
  username?: string;
  password?: string;
  /** Free-form per-credential metadata (e.g. 2FA seed, recovery
   *  email). Each key is treated as sensitive. */
  extras?: Readonly<Record<string, string>>;
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
    }
  | {
      kind: 'clarify';
      /** Free-text question for the customer when the task is
       *  ambiguous (e.g. "which dashboard do you mean?"). */
      clarifyingQuestion: string;
      tokensConsumed: number;
    }
  | {
      kind: 'refuse';
      /** Customer-facing reason. Matches the AUP-refusal corpus
       *  the launch-checklist requires ≥95% coverage on. */
      refuseReason: string;
      tokensConsumed: number;
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
      action: 'tap' | 'type' | 'scroll' | 'swipe';
      selector?: string;
      value?: string;
    }
  | { kind: 'wait'; condition: 'idle' | 'selector_visible'; selector?: string; timeoutMs?: number }
  | { kind: 'capture'; capture: 'screenshot' | 'dom_snapshot' | 'pdf' };

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
}
