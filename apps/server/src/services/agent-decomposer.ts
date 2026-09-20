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
  /**
   * P4 — the commitment arm's turn-scoped state, carried across an approval.
   *
   * ⛔ WHY IT IS PERSISTED AT ALL. The arm arms on stakes seen ANYWHERE in the
   * turn, because a basket page prints the total and the checkout that follows
   * it often prints no figure of its own. A resume is a NEW turn, so without
   * this the resumed suffix starts unarmed — and a second commitment in that
   * suffix, on a page with no figure, would be dispatched with no approval at
   * all. The prompt count travels with it so the ceiling cannot be reset by
   * approving once.
   *
   * ⛔ AND THE EXTRA-READ ALLOWANCE IS DELIBERATELY NOT HERE. A resume is a new
   * turn and gets its own. Carrying a spent read allowance across would DISARM
   * the resumed suffix — a page read that cannot be taken is a gate that falls
   * back to the caption matcher — and disarming is the one direction a page
   * must never be able to reach. The prompt count travels, so approving once
   * cannot reset the ceiling; the read allowance does not, so approving once
   * cannot spend the gate's eyes.
   *
   * ⛔ NOT PROJECTED INTO A RECIPE'S `intent_log`: it is gate bookkeeping, not
   * a step anybody replays.
   */
  commitment?: {
    sawMoney: boolean;
    amount?: string;
    prompts: number;
  };
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
 * P2 — the placeholder form a PLAN carries in place of a secret.
 *
 * ⛔ THIS IS THE WHOLE SAFETY DESIGN, IN ONE SENTENCE: the model plans
 * `{{credential:username}}`, and the EXECUTOR swaps in the real value in the
 * dispatch params, at the last possible moment. So the secret exists in exactly
 * one place — the dispatch to the device — and never in a prompt, a provider
 * request, a provider log, an executor result, or the encrypted transcript,
 * which are the five places a plaintext credential would otherwise land.
 *
 * The bag's own doc comment is what settles this: "never persisted in
 * plaintext", "rendered as `[redacted]` where applicable". A design that sent
 * the values to the model would contradict both, because a transcript replays
 * the plan the model was given.
 */
export const CREDENTIAL_PLACEHOLDER_PREFIX = '{{credential:';
export const CREDENTIAL_PLACEHOLDER_SUFFIX = '}}';

/** The placeholder text for one credential name. */
export function credentialPlaceholder(name: string): string {
  return `${CREDENTIAL_PLACEHOLDER_PREFIX}${name}${CREDENTIAL_PLACEHOLDER_SUFFIX}`;
}

/**
 * P2 — the credential NAMES a bag holds. Names only: `username`, `password`,
 * and each key of `extras`. This is the only projection of the bag that may
 * reach a model.
 *
 * A key present but empty is NOT advertised: telling the model a saved password
 * exists when the stored value is an empty string produces a plan that types
 * nothing into a login form and reports success.
 */
export function credentialRefsFor(bag: CredentialBag | undefined): ReadonlyArray<string> {
  if (bag === undefined) return [];
  const names: string[] = [];
  if (typeof bag.username === 'string' && bag.username.length > 0) names.push('username');
  if (typeof bag.password === 'string' && bag.password.length > 0) names.push('password');
  for (const [key, value] of Object.entries(bag.extras ?? {})) {
    if (typeof value === 'string' && value.length > 0 && key.length > 0) names.push(key);
  }
  return names;
}

/** The value for one credential name, or undefined. Mirrors
 *  {@link credentialRefsFor} exactly, so a name the model was told about is a
 *  name the executor can resolve. */
export function resolveCredential(
  bag: CredentialBag | undefined,
  name: string,
): string | undefined {
  if (bag === undefined) return undefined;
  if (name === 'username') return bag.username;
  if (name === 'password') return bag.password;
  return bag.extras?.[name];
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
  /**
   * Prompt-cache accounting, straight off the provider's `usage` block.
   *
   * ⛔ ONCE CACHING IS ON, `anthropicInputTokens` IS NOT THE PROMPT SIZE. The
   * provider reports `input_tokens` as the UNCACHED REMAINDER — only what came
   * after the last cache breakpoint — so a 9,000-token prompt served from cache
   * reads as `input_tokens: 40`. The prompt that was actually processed is
   * {@link anthropicPromptTokens}. The three parts are kept separately, and
   * named for the wire fields they mirror, because they are billed at three
   * different rates and a row that stored only their sum could never be
   * re-priced.
   *
   * All undefined for deterministic. Zero (not undefined) on a Claude call the
   * cache did not touch, so "the cache missed" and "this row predates cache
   * accounting" stay distinguishable in stored history.
   */
  /** `usage.cache_creation_input_tokens` — tokens WRITTEN to the cache by this
   *  call. Billed above the base input rate. */
  anthropicCacheCreationInputTokens?: number;
  /** `usage.cache_read_input_tokens` — tokens SERVED from the cache. Billed at a
   *  fraction of the base input rate. A run of zeros here across calls that
   *  share a prefix means the cache is not hitting. */
  anthropicCacheReadInputTokens?: number;
  /** `usage.cache_creation.ephemeral_5m_input_tokens`, when the provider broke
   *  the write down by lifetime. The two lifetimes are priced differently. */
  anthropicCacheCreation5mInputTokens?: number;
  /** `usage.cache_creation.ephemeral_1h_input_tokens`. */
  anthropicCacheCreation1hInputTokens?: number;
  /** The whole prompt the provider processed: uncached + cache-written +
   *  cache-read. This is the SIZE of the request — what occupied the context
   *  window — and is deliberately not what the session budget is debited (see
   *  `tokensConsumed` on the result, which is weighted by price). */
  anthropicPromptTokens?: number;
  /** `usage.output_tokens_details.thinking_tokens`, when reported: how much of
   *  the (billed) output was reasoning rather than the reply. Observability
   *  only — it is already inside `anthropicOutputTokens`. */
  anthropicThinkingTokens?: number;
  /** The provider's `stop_reason`. `max_tokens` means the reply was CUT OFF at
   *  the output ceiling — which otherwise surfaces as unparseable JSON and
   *  reads as a model fault when it is a sizing fault. */
  anthropicStopReason?: string;
  /** Cost in USD cents (integer; rounded up to the nearest cent so
   *  short rows don't undercount). Computed from the per-model rate
   *  table in ClaudeAgentDecomposer. Undefined for deterministic. */
  costUsdCents?: number;
  /** Model identifier used for the call (so future pricing-table
   *  drift is recoverable from history). Undefined for deterministic. */
  model?: string;
}

/** See the `status` member of the plan variant of {@link DecomposeResult}. */
export type PlanStatus = 'continue' | 'done';

/**
 * What THIS TURN has already done, handed to the planner when it is asked for the
 * next segment of the same turn (after a segment that said `continue`, or after a
 * step failed).
 *
 * It exists because the transcript cannot say it: a turn's steps are appended to
 * history only when the turn ENDS, so without this a planner asked to carry on
 * would be looking at a page with no record of how it got there — and would type
 * the customer's name into a field it had already filled.
 *
 * ⛔ PAGE-INFLUENCED TEXT. Every line is an executor summary or failure reason,
 * already bounded and credential-scrubbed by the executor, but a navigate summary
 * carries a URL and a failure reason can carry page wording. An implementation
 * frames it as DATA, exactly as it frames {@link DecomposeArgs.observation}.
 */
export interface TurnProgress {
  /** 1 for the first segment of a turn; the planner is only ever handed this
   *  for segment 2 and later. */
  segment: number;
  /** How many more planner calls this turn may make AFTER this one, so a planner
   *  near the end can choose to finish rather than explore. */
  plannerCallsRemaining: number;
  /** One line per step that has already run this turn, oldest first, in the
   *  transcript's own `✓ … / ✗ …` form. */
  stepsSoFar: ReadonlyArray<string>;
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
      /**
       * The planner's own COMPLETION SIGNAL for this plan, when it gave one.
       *
       *  · `continue` — these steps are as far as the planner could SEE. Once they
       *    have run, the runtime reads the page and asks for the next segment in
       *    the SAME turn. This is what ends "the customer has to type continue".
       *  · `done` — once these steps have run the GOAL STATE is reached (the form
       *    is submitted, the item is in the basket, the page that holds the answer
       *    is open). The turn ends and the read-back, if one was asked for, reads
       *    the page these steps ended on. `done` may carry ZERO intents when the
       *    planner, shown the page, finds the goal already reached.
       *
       * ⛔ ABSENT MEANS EXACTLY WHAT A PLAN MEANT BEFORE THIS FIELD EXISTED: run it
       * once, re-plan only after a failed step, end the turn. The deterministic
       * decomposer, every scripted eval plan and every stored transcript carry no
       * status, and none of them may change behaviour because a newer planner can
       * say more. A reader must therefore never default it.
       */
      status?: PlanStatus;
      /**
       * The planner's own reading of the customer's message: `true` when they
       * asked, in ANY language, to be told something found on the page; `false`
       * when they only asked for actions. It is how a question written with no
       * question mark, in a language the runtime's lexical gate does not read,
       * still earns the read-back.
       *
       * ⛔ IT CAN ONLY WIDEN THE READ-BACK GATE. The runtime ORs it with the
       * lexical gate, so `false` never closes a question that gate saw. Absent
       * (the deterministic decomposer, scripted plans, a model that left it out)
       * means the lexical gate decides alone, exactly as before the field existed.
       */
      answerWanted?: boolean;
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
   *  per session).
   *
   * ⛔ P2 — NOTHING MAY SEND THIS TO A MODEL. It holds the customer's real
   * secrets, and a prompt is a third-party request, a provider log and (via the
   * transcript) durable storage. Implementations take the NAMES from
   * {@link credentialRefs} instead and plan against the placeholder
   * {@link CREDENTIAL_PLACEHOLDER_PREFIX} form, which the executor substitutes
   * at dispatch time. The field stays on the interface because it is the type
   * the runtime threads to the EXECUTOR; a decomposer reading it is the bug. */
  credentials?: CredentialBag;
  /**
   * P2 — the NAMES of the credentials this session holds, and nothing else
   * (`['username', 'password']`). This is the half that is safe to put in a
   * prompt: it tells the model a saved value exists and what to call it, so it
   * can plan `type {{credential:username}} into #user` without any secret
   * entering the request, the provider's logs, or the transcript.
   */
  credentialRefs?: ReadonlyArray<string>;
  /**
   * P1 perceive — a BOUNDED digest of what is on the page RIGHT NOW (selectors,
   * kinds and visible text of the interactive elements), when one could be read.
   *
   * ⛔ UNTRUSTED, PAGE-DERIVED DATA. It is reasoned ABOUT, never obeyed — the
   * same stance {@link AnswerArgs.observation} takes. Absent when there is no
   * page yet or it could not be read, and a plan must still be possible without
   * it: perceiving is an improvement to planning, not a precondition for it.
   */
  observation?: string;
  /**
   * P1 re-plan — why the previous plan in THIS turn stopped, in one customer-
   * safe sentence, when this call is a re-plan of the remainder. Absent on the
   * first decomposition of a turn.
   */
  priorFailure?: string;
  /**
   * What this turn has already run, when this call asks for a LATER segment of
   * the same turn. Absent on a turn's first planning call. See
   * {@link TurnProgress}.
   */
  turnProgress?: TurnProgress;
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
   * CLAUDE_MODELS registry; defaults to DEFAULT_AGENT_MODEL (Sonnet 5)
   * when unset. The DeterministicAgentDecomposer ignores it (no LLM call).
   */
  model?: AgentModel;
  /** Internal control-authority fence. Provider-backed implementations must
   * await it immediately before every external attempt (including retries
   * after backoff). False/throw means the admitted turn no longer owns AI
   * control and no new provider request may start. */
  shouldContinue?: () => boolean | Promise<boolean>;
  /**
   * B2 — aborts when the turn is cancelled (the customer pressed Stop). The
   * authority fence above is checked BETWEEN attempts, so on its own it lets a
   * model call already in flight run to completion — up to the whole streamed
   * reply — after the customer has asked the agent to stop. A provider-backed
   * implementation passes this to its HTTP call so the request ends promptly.
   *
   * Optional and additive: an implementation that ignores it is still stopped at
   * the next fence check, only later. An abort is NOT a provider failure: a
   * request that was cut short consumed whatever the provider had already
   * counted, and the caller accounts for what it can observe.
   */
  signal?: AbortSignal;
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
  /**
   * B5 — the turn STOPPED BEFORE ITS TASK WAS FINISHED (it ran out of steps, time
   * or budget, or noticed it was going in circles), so `observation` is the page
   * it got as far as and may well not be the page that holds the answer. Absent
   * on a turn that ran to its end. An implementation tells the model, so that
   * "not reached" is said plainly rather than answered around.
   */
  taskUnfinished?: boolean;
  /** Remaining per-session token budget; the caller gates on this. */
  budgetTokensRemaining: number;
  /** BYOK/fallback Anthropic key — same resolution + secrecy rules as
   *  DecomposeArgs.byokAnthropicApiKey. NEVER logged/echoed/persisted. */
  byokAnthropicApiKey?: string;
  /** Claude model for this call (per-model cost rate); defaults to
   *  DEFAULT_AGENT_MODEL. */
  model?: AgentModel;
  /** Same per-attempt authority fence as {@link DecomposeArgs.shouldContinue}. */
  shouldContinue?: () => boolean | Promise<boolean>;
  /** Same cancellation as {@link DecomposeArgs.signal}: the read-back is a model
   *  call too, and a Stop pressed while it streams must end it. */
  signal?: AbortSignal;
}

/** Internal sentinel used to preserve an authority revocation through the
 * decomposer's ordinary transient-error classification. It contains no
 * customer data, provider response, or credential detail. */
export class AgentDecomposerContinuationDeniedError extends Error {
  constructor() {
    super('agent control authority is no longer current');
    this.name = 'AgentDecomposerContinuationDeniedError';
  }
}

/** A provider response consumed billable tokens but failed the strict content
 * codec. Carry only validated accounting evidence—never raw provider content
 * or credentials—so the runtime can meter/debit the settled call before
 * preserving the ordinary fatal/transient error contract. */
export class AgentDecomposerSettledError extends Error {
  readonly tokensConsumed: number;
  readonly usage: DecomposeUsage;

  constructor(message: string, evidence: { tokensConsumed: number; usage: DecomposeUsage }) {
    super(message);
    this.name = 'AgentDecomposerSettledError';
    this.tokensConsumed = evidence.tokensConsumed;
    this.usage = evidence.usage;
  }
}

/** Fail closed when an optional continuation check rejects or throws. */
export async function requireAgentDecomposerContinuation(
  check: DecomposeArgs['shouldContinue'] | AnswerArgs['shouldContinue'],
): Promise<void> {
  if (check === undefined) return;
  try {
    if (await check()) return;
  } catch {
    // A broken authority store must deny new provider work, not fail open.
  }
  throw new AgentDecomposerContinuationDeniedError();
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
