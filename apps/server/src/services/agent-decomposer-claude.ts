// AI-B1.b — real Claude-wired AgentDecomposer implementation.
//
// Calls the Anthropic Messages API via raw fetch (no SDK install) and
// parses a JSON-shaped response into the same DecomposeResult union the
// DeterministicAgentDecomposer returns. Drop-in behind the AgentDecomposer
// interface; the AgentRuntime + executor + sessions repo do not change.
//
// Cost-tolerant path: customer pays via BYOK Anthropic key per
// orchestrator verdict 2026-05-16. The deployment fallback (founder key)
// covers demos + integration tests only — bootstrap resolves the key
// before calling decompose() and never embeds a fallback at this layer.
//
// Contract guarantees (mirroring DeterministicAgentDecomposer):
//   - Token-budget exhaustion → refuse with the standard message, 0
//     tokens charged. Never throws.
//   - AUP-prefilter hit → refuse with the canned reason. Pre-filter
//     short-circuits BEFORE the API call so we don't bill the customer
//     for an obviously-bad task. Never throws.
//   - Anthropic 4xx (auth / quota / validation) → throws. Caller maps
//     to a 502 problem-type so the dashboard surfaces "agent layer
//     misconfigured" rather than charging the customer for nothing.
//   - Anthropic 5xx → single retry with backoff; post-retry 5xx
//     throws. Network errors retried identically.
//   - Malformed JSON content → throws (the wire is broken; surfacing
//     a refuse would silently mask the bug).

import {
  CLAUDE_MODELS,
  DEFAULT_AGENT_MODEL,
  type AgentModel,
  type ModelCallTokens,
  type RequestRegionBytes,
} from '@driftstack/api-types';
import { CLAUDE_MODEL_REQUEST_CAPABILITIES } from '@driftstack/api-types';
import type { CreditModelCallPurpose } from '../db/credit-reservations-repo.js';
import type {
  AgentCreditCall,
  AgentCreditMeter,
  AgentCreditSettlement,
} from './agent-credit-meter.js';
import {
  AgentDecomposerCreditsDeniedError,
  AgentDecomposerSettledError,
  requireAgentDecomposerContinuation,
  type AgentDecomposer,
  type AnswerArgs,
  type AnswerResult,
  type DecomposeArgs,
  type DecomposeResult,
  type DecomposeUsage,
  type TranscriptEntry,
} from './agent-decomposer.js';
// Everything about planning that is not this provider's wire: both prompts,
// both reply schemas, the reply's meaning and its limits, the AUP pre-filter,
// the budget pre-check, the transcript window and the conversation itself. A
// second provider's adapter imports the same module, so the two are asked the
// same question in the same words.
import {
  ANSWER_REPLY_SCHEMA,
  ANSWER_SYSTEM_PROMPT,
  AgentDecomposerCancelledError,
  MAX_AGENT_CUSTOMER_COPY_CHARS,
  MAX_AGENT_SELECTOR_CHARS,
  MAX_AGENT_TAP_LABEL_CHARS,
  MAX_AGENT_TYPED_TEXT_CHARS,
  MAX_AGENT_URL_CHARS,
  MAX_HISTORY_AGENT_ENTRY_CHARS,
  MAX_PLAN_INTENTS,
  PLAN_REPLY_SCHEMA,
  PROVIDER_SAFETY_REFUSAL,
  SYSTEM_PROMPT,
  TRANSCRIPT_MIN_TAIL_ENTRIES,
  TRANSCRIPT_WINDOW_MAX_CHARS,
  TRANSCRIPT_WINDOW_MAX_ENTRIES,
  TRANSCRIPT_WINDOW_STEP,
  abortableSleep,
  asRecord,
  buildAnswerPrompt,
  buildPlannerConversation,
  interpretAnswerText,
  interpretPlanText,
  isEventStreamResponse,
  isCancelled,
  isTokenCount,
  plannerPreflight,
  raceAbort,
  renderHistoryEntry,
  selectTranscriptWindow,
  withTruncationNote,
} from './agent-planner-contract.js';
// Re-exported through __TEST_ONLY__ for the cross-source AUP parity tests.
import { AUP_REFUSAL_PATTERNS } from './agent-decomposer-deterministic.js';
import { TURN_ANSWER_STREAM_CAP_MS } from './agent-turn-bounds.js';

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION_HEADER = '2023-06-01';
// The OUTPUT ceiling for a planning call — thinking AND the plan, together.
//
// ⛔ 2048 WAS SIZED FOR A REPLY WITH NO THINKING, AND THE DEFAULT MODEL THINKS.
// The provider's thinking guide (read 2026-09-18) states that on Claude Opus 5
// and Claude Sonnet 5 "thinking is already on and needs no configuration", that
// thinking tokens "count toward `max_tokens` alongside the response text", and
// that "a `max_tokens` sized for a response with no thinking is often too small
// once Claude starts thinking". Its own worked example spends 1,033–1,630 output
// tokens at the default effort — on an essay-style analysis of a long passage,
// visible answer included, so it shows the ORDER of magnitude a thinking call
// spends and is weak evidence for how much a PLAN call thinks. A full 8-intent
// plan measures 0.8–1.1 KB of JSON (an ESTIMATED 200–470 tokens; JSON tokenizes
// denser than prose), so the plan itself always fit. The HYPOTHESIS this acts on
// — nobody has observed it here — is that the reasoning in front of the plan
// does not: a call that thought for ~1,600 tokens would be cut off mid-JSON, and
// a cut-off plan surfaces as "not valid JSON", which reads as a model fault and
// is billed.
//
// The ceiling is never shown to the model, so raising it does not make a call
// longer; it only stops a call that was already going to run long from being
// thrown away. What it costs is the worst case of a call that WOULD have been
// truncated, which was a failed turn either way. 8192 leaves ~7.7k for reasoning
// above a full plan and stays far inside MAX_ANTHROPIC_RESPONSE_BYTES, which
// bounds the assembled TEXT (a hidden thinking block streams no text).
//
// MEASURED LIVE 2026-09-18: 0 of 400+ planning and read-back calls ended on
// `max_tokens` (every one was `end_turn`), and a planning reply averaged ~110
// output tokens under the shipped thinking policy. The hypothesis above is
// therefore unobserved at today's settings; the ceiling stays because it is
// headroom the model never sees, and `stop_reason` stays on the usage object so
// the day it is reached is visible.
const MAX_OUTPUT_TOKENS = 8192;
const MAX_RETRIES_5XX = 1;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
// Per-request timeout for the Anthropic call. Without it a hung upstream
// (connection open, no response — a real LLM-API degradation mode) would hang
// the customer's chat turn indefinitely: a hang is neither a 5xx nor a thrown
// network error, so the retry below never fires. On timeout the AbortController
// aborts the fetch (caught as a network error → one retry → then a
// transient-classified throw that keeps the session active). This TOTAL bound
// now only governs an upstream that ignored `stream: true` and a non-2xx body —
// both planning and read-back calls stream, and a streamed attempt is bounded by
// silence instead (below). Matches the AbortController timeout every other
// outbound caller already uses (stripe-api, nowpayments, webhook-delivery,
// health-probe, incident-broadcast).
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
// Streaming planning call (B3). A 30s TOTAL budget is the wrong instrument for a
// call whose duration scales with the length of the plan: a long plan blew the
// timer, aborted, backed off 1s and re-ran the WHOLE call — paying twice and
// roughly doubling the wait, for an upstream that was healthy and talking. With
// `stream: true` the discriminator becomes SILENCE, so the per-attempt budget is
// an IDLE timer reset by every delta, plus a generous absolute cap that only a
// genuinely stuck stream can reach.
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 25_000;
// ⛔ SILENCE MEANS TWO DIFFERENT THINGS, DEPENDING ON WHEN IT FALLS. The
// provider's streaming guide (read 2026-09-18): on the models that think by
// default the thinking display is omitted, and then "no thinking text is
// streamed" — the block opens, and nothing but `ping` events ("any number of",
// cadence undocumented) arrives until the reasoning is done. So between
// `message_start` and the first text delta a HEALTHY call can be silent for as
// long as its reasoning takes, and the 25s bound above would abort it, back off,
// pay for the whole call a second time, abort that too, and fail the turn — with
// neither attempt reaching a usage frame, so the spend is never even recorded.
// A false abort here is far dearer than a slow detection, so that one phase gets
// a bound sized to a whole output budget of reasoning. Before `message_start`
// (the upstream has not answered at all — the common hang) and after the first
// text (the model is writing, and text never pauses this long) the short bound
// stands, and the absolute cap below still ends a stream that is truly stuck.
//
// MEASURED LIVE 2026-09-18 (the live eval's meter records the longest gap between
// two chunks of every response): under the shipped thinking policy the longest
// silence in 198 streamed calls was 1.4 s, and 4.5 s with thinking disabled. The
// bound is therefore far from binding today. It is kept at its size because it
// guards a different day — a model left at a higher effort, or a harder page —
// and a false abort there still costs a second full call.
const DEFAULT_STREAM_THINKING_IDLE_TIMEOUT_MS = 120_000;
// The absolute cap. It lives in agent-turn-bounds.ts because the answering call
// is the last thing a turn does, so this number is one of the four the
// cross-process stop claim's TTL is derived from — and a second copy here is the
// one that would drift away from that arithmetic unnoticed.
const DEFAULT_STREAM_TOTAL_TIMEOUT_MS = TURN_ANSWER_STREAM_CAP_MS;
// A legitimate planning reply is only a few KiB of TEXT whatever the output
// ceiling is: the ceiling is mostly headroom for reasoning, and hidden reasoning
// streams no text (a full 8-intent plan measures ~1 KB).
// 64 KiB remains generous while also fitting, with the bounded eight-result
// summary and read-back answer, inside AgentRuntime's 128 KiB AI-turn transcript
// reserve. A broken/compromised upstream therefore cannot make Response.text()
// allocate arbitrarily or cross the transcript limit after turn preflight.
const MAX_ANTHROPIC_RESPONSE_BYTES = 64 * 1024;
// ⛔ The ceiling above measures the PAYLOAD, and SSE framing is not payload.
// Anthropic sends roughly one `content_block_delta` frame per few characters of
// text, and each frame costs ~120 bytes of `event:`/`data:`/JSON wrapper — a
// ~30x expansion. Counting raw stream bytes against a 64 KiB payload ceiling
// therefore trips at ~2 KB of plan JSON, which a single validator-legal `type`
// intent (MAX_AGENT_TYPED_TEXT_CHARS is 10,000) exceeds on its own — and the
// failure is the worst available, since AnthropicResponseTooLargeError is
// exempt from retry and classified FATAL. So the streamed path bounds the
// ASSEMBLED TEXT against MAX_ANTHROPIC_RESPONSE_BYTES (the same quantity the
// buffered path bounded) and keeps this far larger figure purely as a transport
// backstop against an upstream that streams framing forever without ever
// producing text.
const MAX_ANTHROPIC_STREAM_TRANSPORT_BYTES = 4 * 1024 * 1024;

class AnthropicResponseTooLargeError extends Error {
  constructor() {
    super(`Anthropic response body exceeded ${MAX_ANTHROPIC_RESPONSE_BYTES} bytes`);
    this.name = 'AnthropicResponseTooLargeError';
  }
}

/**
 * A provider error delivered as a mid-stream `error` frame rather than as an
 * HTTP status.
 *
 * ⛔ Typed, and not a bare Error, because it is thrown from INSIDE the
 * fetch/read try block — where the generic `catch (networkErr)` retries
 * unconditionally. The buffered path reaches the non-ok branch instead, which
 * retries only a 429 or a 5xx and lets a 4xx escape on the first attempt.
 * Carrying the mapped status out is what lets the streamed path apply that same
 * policy instead of paying twice for an authentication failure.
 */
class AnthropicStreamError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'AnthropicStreamError';
    this.status = status;
  }
}

// #140 read-and-report — the READ-BACK pass (answerFromObservation). The ANSWER
// is short (a sentence or two, ~50–150 tokens), but the ceiling also has to hold
// whatever the model thinks first — see MAX_OUTPUT_TOKENS. The HYPOTHESIS (not
// an observed event — no live call has been made from this change): at 512, a
// default-model read-back that reasons about a 20k-char page for more than ~400
// tokens returns no text block at all; the runtime then reports "couldn't read
// the page back", so the customer's question goes unanswered on a turn that had
// succeeded. 4096 is headroom, not a target: the model never sees it.
// `anthropicStopReason` / `anthropicThinkingTokens` on the usage object are what
// the live eval re-sizes both ceilings from.
const ANSWER_MAX_OUTPUT_TOKENS = 4096;

// v2-#4 Q.1.e / 6.c (#15) — per-call USD cents (recorded in
// usage_records.metadata.cost_usd_cents) are computed from the per-model
// Anthropic list-price rate in the api-types CLAUDE_MODELS registry
// (cents/1k), keyed by the session's selected model. If a rate is wrong,
// historical rows keep their recorded cost (we don't recompute), so the
// audit trail stays internally consistent even when the rate-table drifts.

// ── B3 / B4 — what every request says about thinking and about its reply ──

/**
 * The policy production runs. CHOSEN BY MEASUREMENT (live eval, 2026-09-18, the
 * full 11-task corpus, the product's own request assembly, reply schema on):
 *
 *   model      policy         passed   plan call median (max)   est. cost   hidden thinking
 *   sonnet-5   disabled       32/32    2.6 s (5.9 s)            $0.38       0 tokens
 *   sonnet-5   adaptive-low   32/33    2.4 s (4.4 s)            $0.36       475 tokens / 116 calls
 *   opus-5     disabled       22/22    3.7 s (6.9 s)            $0.74       0 tokens
 *   opus-5     adaptive-low   22/22    3.3 s (4.5 s)            $0.71       310 tokens / 82 calls
 *
 * against the UNCONFIGURED default the product ran before (opus-5, thinking on at
 * the provider's default effort): plan call median 7.0 s (max 21.5 s).
 *
 * ⛔ READ IT AS A TIE, because it is one. On this corpus the two policies are
 * indistinguishable on completion, latency and cost: at low effort the models
 * chose to think on a handful of calls out of two hundred.
 *
 * ⛔ AND DO NOT READ A CAUSE INTO THE HALVING. Either explicit policy, together
 * with the shorter per-segment replies the loop asks for, roughly halves the
 * planning call against the unconfigured default — and that is all the data
 * says. The two arms differ in TWO variables (thinking, and effort: `disabled`
 * sends no effort and so runs at the provider's default), the before/after also
 * spans a prompt change that took planning replies from ~580 to ~110 output
 * tokens and the addition of the reply schema, and the two Opus arms ran
 * concurrently. Which of those bought the seconds was not isolated; a
 * disabled-at-low-effort arm and an old-prompt-new-policy arm would be needed.
 *
 * So the tie is broken on what the measurement cannot see. These fixtures are
 * small, clean pages; a customer's page is not, and `adaptive-low` is the policy
 * under which the model may still reason when a page is genuinely hard, at a
 * measured cost of nothing when it is not. It is also the configuration the
 * provider recommends for the default model, whose documented failure modes
 * with thinking DISABLED (internal tags leaking into visible text —
 * thinking-troubleshooting, read 2026-09-18) would land in the one string a
 * customer reads: the answer. A model that cannot take `adaptive` (see
 * CLAUDE_MODEL_REQUEST_CAPABILITIES) runs `disabled`, which is also what it did
 * before this existed.
 *
 * The longest silence in any adaptive-low response was 1.4 s, against an idle
 * bound of 25 s and a thinking-phase bound of 120 s: the stream bounds cannot
 * kill a healthy call under this policy.
 */
const DEFAULT_THINKING_POLICY: Record<AgentCallKind, AgentThinkingPolicy> = {
  plan: 'adaptive-low',
  answer: 'adaptive-low',
};

/**
 * The models `adaptive-low` has been MEASURED on, with the live corpus (see
 * {@link DEFAULT_THINKING_POLICY}).
 *
 * ⛔ A CAPABILITY IS NOT A MEASUREMENT. The registry says Opus 4.8, Opus 4.7 and
 * Sonnet 4.6 ACCEPT adaptive thinking and an effort level, and an earlier version
 * of this file sent them both on that basis. Those models do not think by
 * default, so that turned thinking ON and dropped effort to `low` for three
 * models no run had exercised — against the provider's own guidance for the 4.x
 * Opus models, which is to step down to `low` only once your evals show the
 * lower level holds quality (effort guide, read 2026-09-18). Until one of them is
 * measured it runs as it always did — no thinking, the provider's default effort
 * — said explicitly rather than by omission, so the request is the same bytes on
 * every call and a change of provider default cannot move it.
 */
const ADAPTIVE_LOW_MEASURED_ON: ReadonlySet<AgentModel> = new Set<AgentModel>([
  'claude-opus-5',
  'claude-sonnet-5',
]);

/** What one request may carry. Narrowed per model, for the life of the process,
 *  by what the provider has REJECTED — see `callConstrained`. */
interface ReplyControlsAllowed {
  /** Constrain the reply to the call's JSON schema. */
  schema: boolean;
  /** Say anything at all about thinking and effort. */
  thinking: boolean;
}

/**
 * The request members that say HOW the model should reply: thinking, effort and
 * the reply schema. A pure function of (model, policy, schema, what the provider
 * accepts), so two calls of one kind in one session always send the same bytes
 * here — which is what keeps them on the same cache entry.
 */
function requestControls(
  model: AgentModel,
  policy: AgentThinkingPolicy,
  schema: Record<string, unknown> | null,
  allowed: ReplyControlsAllowed,
): Record<string, unknown> {
  const capabilities = CLAUDE_MODEL_REQUEST_CAPABILITIES[model];
  // `adaptive` is a 400 on a budget-only model, and its cheapest real thinking
  // (a 1,024-token budget) is not "low effort" — it is more reasoning than the
  // adaptive models spend on a step like this. So there it is `disabled`; and so
  // it is on a model the policy has never been measured on.
  const think =
    policy === 'adaptive-low' &&
    capabilities.thinkingControl === 'adaptive' &&
    ADAPTIVE_LOW_MEASURED_ON.has(model);
  const outputConfig: Record<string, unknown> = {
    ...(allowed.thinking && think && capabilities.supportsEffort ? { effort: 'low' } : {}),
    ...(allowed.schema && schema !== null ? { format: { type: 'json_schema', schema } } : {}),
  };
  return {
    ...(allowed.thinking ? { thinking: think ? { type: 'adaptive' } : { type: 'disabled' } } : {}),
    ...(Object.keys(outputConfig).length > 0 ? { output_config: outputConfig } : {}),
  };
}

/** Which reply control a provider 400 is ABOUT, if it names one. Thinking is
 *  asked first: `effort` lives under `output_config`, so an effort rejection
 *  names both, and the narrower word decides. */
function rejectedReplyControl(err: unknown): keyof ReplyControlsAllowed | null {
  if (!(err instanceof Error) || !/^Anthropic API 400: /.test(err.message)) return null;
  if (/\bthinking\b|\beffort\b/i.test(err.message)) return 'thinking';
  if (/output_config|json_schema|output format|structured output/i.test(err.message)) {
    return 'schema';
  }
  return null;
}

export interface ClaudeAgentDecomposerDeps {
  /** Injectable fetch for tests. Defaults to globalThis.fetch. */
  fetch?: typeof globalThis.fetch;
  /** Retry backoff in ms (test override). Defaults to 1000. */
  retryBackoffMs?: number;
  /** Per-request Anthropic timeout in ms (test override). Defaults to 30000.
   *  Applies to the NON-streamed calls; the streamed planning call is bounded by
   *  the idle + absolute pair below. */
  requestTimeoutMs?: number;
  /** Abort a streamed planning call after this long with NO delta (test
   *  override). Defaults to 25000. */
  streamIdleTimeoutMs?: number;
  /** Silence allowed between `message_start` and the first text delta, where a
   *  model that thinks without streaming its thinking is legitimately quiet
   *  (test override). Defaults to 120000 — or to the idle bound, when the caller
   *  overrode that one and not this. */
  streamThinkingIdleTimeoutMs?: number;
  /** Absolute ceiling on one streamed planning attempt (test override).
   *  Defaults to 300000. */
  streamTotalTimeoutMs?: number;
  /**
   * The thinking configuration per call kind. Defaults to
   * {@link DEFAULT_THINKING_POLICY}. It exists as a dependency so the live eval
   * can MEASURE one policy against another through the product's own request
   * assembly; production constructs the decomposer without it.
   *
   * ⛔ ONE VALUE PER DECOMPOSER INSTANCE, NEVER PER CALL. See
   * {@link AgentThinkingPolicy}: a session whose planning calls disagree about
   * it re-writes its whole cached conversation on every call.
   */
  thinkingPolicy?: Partial<Record<AgentCallKind, AgentThinkingPolicy>>;
  /** Ask the provider to constrain each reply to the call's JSON schema.
   *  Defaults to true; a test or a measurement turns it off. */
  structuredOutput?: boolean;
}

/** The two model calls a turn makes. */
export type AgentCallKind = 'plan' | 'answer';

/**
 * B3 — THINKING IS A DECISION, NOT AN ACCIDENT.
 *
 * Until this existed the request said nothing about thinking, so each model did
 * whatever its default was: Opus 5 and Sonnet 5 THINK by default, with the
 * reasoning hidden. Measured 2026-09-18 on one real planning call: 334 of 581
 * output tokens were reasoning nobody saw, the stream was silent for 4.2 s, and
 * the call took 8.3 s against 3.5 s with thinking off. A turn is now several
 * planning calls, so that difference is paid per SEGMENT.
 *
 *  · `disabled` — `thinking: {type: "disabled"}`. No reasoning tokens; the reply
 *    starts at once. The plan envelope's one-sentence `thought` is the only
 *    deliberation, and it is visible in the reply rather than billed unseen.
 *  · `adaptive-low` — `thinking: {type: "adaptive"}` with
 *    `output_config.effort: "low"`: the cheapest setting that still lets the
 *    model think when it judges a step hard. On a model that cannot take
 *    `adaptive` (see CLAUDE_MODEL_REQUEST_CAPABILITIES) this is `disabled`.
 *
 * ⛔ WHY IT IS FIXED PER CALL KIND FOR THE LIFE OF THE PROCESS. The provider
 * renders the thinking configuration and the resolved effort INTO the prompt
 * (thinking-steering-and-cost, "Prompt caching", read 2026-09-18): changing
 * either between two requests invalidates the message cache, and on some models
 * the system and tools caches too. A planner that thought on hard segments and
 * not on easy ones would re-write the conversation cache on every flip.
 */
export type AgentThinkingPolicy = 'disabled' | 'adaptive-low';

export class ClaudeAgentDecomposer implements AgentDecomposer {
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly retryBackoffMs: number;
  private readonly requestTimeoutMs: number;
  private readonly streamIdleTimeoutMs: number;
  private readonly streamThinkingIdleTimeoutMs: number;
  private readonly streamTotalTimeoutMs: number;
  private readonly thinkingPolicy: Record<AgentCallKind, AgentThinkingPolicy>;
  private readonly structuredOutput: boolean;
  /** Models whose provider REJECTED a schema-constrained request, or one that
   *  said how to think, in this process. See {@link callConstrained}. */
  private readonly structuredOutputRejectedFor = new Set<AgentModel>();
  private readonly thinkingControlRejectedFor = new Set<AgentModel>();

  constructor(deps: ClaudeAgentDecomposerDeps = {}) {
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.requestTimeoutMs = deps.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    // `requestTimeoutMs` is the caller's "bound one attempt" knob. On the
    // streamed path the equivalent bound is SILENCE, so it lands on the idle
    // timer rather than being quietly ignored — otherwise a caller that asked
    // for a 5ms attempt would get the 300s absolute cap instead.
    this.streamIdleTimeoutMs =
      deps.streamIdleTimeoutMs ?? deps.requestTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
    // A caller that tightened the idle bound and said nothing about this one
    // asked for "abort on N ms of silence", so the thinking phase follows it
    // rather than quietly staying at two minutes.
    this.streamThinkingIdleTimeoutMs =
      deps.streamThinkingIdleTimeoutMs ??
      deps.streamIdleTimeoutMs ??
      deps.requestTimeoutMs ??
      DEFAULT_STREAM_THINKING_IDLE_TIMEOUT_MS;
    this.streamTotalTimeoutMs = deps.streamTotalTimeoutMs ?? DEFAULT_STREAM_TOTAL_TIMEOUT_MS;
    this.thinkingPolicy = { ...DEFAULT_THINKING_POLICY, ...deps.thinkingPolicy };
    this.structuredOutput = deps.structuredOutput ?? true;
  }

  async decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    // 6.c / #15 — the session's picked Claude 4.x model (defaults to
    // Opus 4.7 when unset); drives the Anthropic call + the per-model
    // cost-to-serve rate via CLAUDE_MODELS.
    const model = args.model ?? DEFAULT_AGENT_MODEL;
    // 1. Pre-API AUP filter — short-circuit obvious abuse cases so the
    //    Anthropic API never sees them (don't put abusive prompts into
    //    third-party logs, don't bill the customer for an inevitable
    //    refusal). Charges tokens — the input was processed by us.
    // 2. Budget pre-check. Refuse with 0 tokens charged so the customer
    //    isn't billed for the exhaustion refusal itself.
    //
    //    Both are decided by the planner contract (`plannerPreflight`), in that
    //    order, for every provider alike. What this adapter adds is its own
    //    zero-cost usage row: no API call → no Anthropic tokens, no cost, but the
    //    runtime still records a row with decomposerKind=claude so the audit
    //    trail covers the refused turn.
    //
    //    ⚠️ The budget check is a FLOOR, not a forecast: a call admitted here can
    //    debit more than was left; the session repo floors the balance at zero, so
    //    the overspend is forgiven once and the NEXT call is refused. The COST
    //    half of the budget is the debit after the call — see `billableTokens`.
    const preflight = plannerPreflight(args);
    if (preflight !== null) return { ...preflight, usage: makeClaudeUsage(0, 0, model) };

    // 3. Credential check. Bootstrap is responsible for resolving the
    //    BYOK customer key OR the deployment fallback into this arg;
    //    if neither resolved, that's a configuration error that should
    //    surface — not a customer refusal.
    if (args.byokAnthropicApiKey === undefined || args.byokAnthropicApiKey === '') {
      throw new Error('ClaudeAgentDecomposer: no Anthropic API key provided');
    }

    // 4. Build the request body. System prompt is constant; messages
    //    interleave the prior transcript so the model sees its own
    //    plans + executor results.
    // ⛔ `let`, BECAUSE RUNG 3 OF THE FIT LADDER REBUILDS IT (§4.5, M4). A plan
    // call that cannot fit at any allowed output ceiling is asked again with
    // fewer BYTES of conversation history — the same mechanism as the character
    // window, measured the way the bound is measured. With no meter this is
    // written once and never touched, and the request is what it always was.
    let messages = buildMessages(args);
    let history = args.history;
    const buildBody = (allowed: ReplyControlsAllowed, maxTokens: number): string =>
      JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...requestControls(model, this.thinkingPolicy.plan, PLAN_REPLY_SCHEMA, allowed),
        system: buildSystemBlocks(),
        messages,
        // B3 — stream the planning call. The RESULT is unchanged: the deltas are
        // reassembled into the same envelope shape the non-streamed call returns,
        // so parsing, validation, usage accounting and error classification below
        // are the ones that already shipped. What changes is that a slow plan is
        // now bounded by silence rather than by total duration.
        stream: true,
      });

    // 5. Call Anthropic with single retry on 5xx.
    const response = await this.callConstrained(
      model,
      buildBody,
      args.byokAnthropicApiKey,
      args.shouldContinue,
      args.signal,
      MAX_OUTPUT_TOKENS,
      args.creditMeter === undefined
        ? undefined
        : {
            meter: args.creditMeter,
            purpose: 'plan',
            model,
            historyBytes: () => droppableHistoryBytes(messages),
            trimHistory: (budgetBytes: number): boolean => {
              // Oldest first, one entry at a time, rebuilding through the same
              // contract the request is always built from — so a trimmed call is
              // the call the planner would have made on a shorter session, not a
              // second way of assembling a prompt.
              while (droppableHistoryBytes(messages) > budgetBytes && history.length > 1) {
                history = history.slice(1);
                messages = buildMessages({ ...args, history });
              }
              return droppableHistoryBytes(messages) <= budgetBytes;
            },
          },
    );

    // 6. Parse the response. Token accounting comes from the API's
    //    usage block — input + output combined, since the customer
    //    pays for both halves of the trip. The model threads through so
    //    the recorded cost uses its per-model rate.
    return parseAnthropicResponse(response, model, {
      // Only a LATER segment of a turn may answer "nothing left to do". On a
      // turn's first call an empty plan is still the "it did nothing" defect and
      // still becomes a clarify.
      allowEmptyDone: args.turnProgress !== undefined,
    });
  }

  /**
   * #140 read-and-report — answer the customer's question from observed page
   * content. Reuses decompose()'s Anthropic call machinery (callWithRetry); a
   * distinct, tighter ANSWER_SYSTEM_PROMPT drives a concise factual answer. The
   * observation is hard-bounded + framed as untrusted data. Same failure
   * contract as decompose(): upstream 5xx-after-retry / 4xx / malformed JSON
   * throw (the runtime treats a throw as "couldn't read the page back" and
   * falls back to the plan result — never a fabricated answer).
   */
  async answerFromObservation(args: AnswerArgs): Promise<AnswerResult> {
    const model = args.model ?? DEFAULT_AGENT_MODEL;
    if (args.byokAnthropicApiKey === undefined || args.byokAnthropicApiKey === '') {
      throw new Error('ClaudeAgentDecomposer: no Anthropic API key provided');
    }
    // The question and the hard-bounded, fenced observation: the contract's, so
    // every provider reads back from the same words.
    const prompt = buildAnswerPrompt(args);
    // ⛔ NO `cache_control` HERE, ON PURPOSE. A cache entry is only worth its
    // write premium if a LATER request reads the same prefix, and nothing about
    // this request repeats: the system prompt is ~250 tokens — under the 512
    // minimum of even the most permissive model in CLAUDE_MODELS, so a marker on
    // it would silently do nothing — and the one large part, the observation, is
    // a different page on every call. Marking the observation would pay the 1.25x
    // write on up to ~5k tokens per read-back for an entry no request ever reads.
    const buildBody = (allowed: ReplyControlsAllowed, maxTokens: number): string =>
      JSON.stringify({
        model,
        max_tokens: maxTokens,
        ...requestControls(model, this.thinkingPolicy.answer, ANSWER_REPLY_SCHEMA, allowed),
        system: prompt.system,
        messages: [{ role: 'user', content: prompt.userText }],
        // Streamed for the same reason the planning call is (B3): with the output
        // ceiling now sized for a model that thinks first, a TOTAL timer would
        // abort a healthy read-back for being slow, back off, and pay for the
        // whole call a second time. Silence is the honest discriminator. An
        // upstream that answers with the ordinary envelope is still read as one.
        stream: true,
      });
    const response = await this.callConstrained(
      model,
      buildBody,
      args.byokAnthropicApiKey,
      args.shouldContinue,
      args.signal,
      ANSWER_MAX_OUTPUT_TOKENS,
      args.creditMeter === undefined
        ? undefined
        : {
            meter: args.creditMeter,
            purpose: 'answer',
            model,
            // ⛔ A READ-BACK CARRIES NO HISTORY WINDOW (§4.5): the question and
            // one page. There is nothing it could drop, and asking it to drop
            // something would be asking it to drop the question.
            historyBytes: () => 0,
            trimHistory: () => false,
          },
    );
    return parseAnswerResponse(response, model);
  }

  /**
   * B3/B4 — one provider call that says how to think and is CONSTRAINED to the
   * call's JSON schema, with the plainer request as the second line rather than
   * the only one.
   *
   * ⛔ WHY THERE IS A SECOND LINE AT ALL. A reply control the provider stops
   * accepting — a schema keyword it drops, a thinking type a model added to the
   * picker does not take — is a 400 on EVERY turn of EVERY customer on that
   * model until the next deploy, for features whose whole purpose is to make
   * replies faster and more reliable. So a 400 that names a control is answered
   * by re-sending the same request without THAT control, and the model is
   * remembered for the life of the process so the doomed request is not sent
   * again. Without the schema the defensive parser does what it did before
   * constrained replies existed; without the thinking members the model does
   * whatever its default is, which is what every model did before B3.
   *
   * ⛔ AND WHY IT IS NOT SILENT. Nothing else 400s on these words, and a request
   * that was rejected is not billed, so each fallback costs latency once per
   * process per model. What it must not do is hide: `structuredOutputRejected`
   * and `thinkingControlRejected` expose the sets so an operator surface (and a
   * test) can see a fallback is live. Bounded: each control can be dropped once,
   * so a call makes at most three attempts.
   */
  private async callConstrained(
    model: AgentModel,
    buildBody: (allowed: ReplyControlsAllowed, maxTokens: number) => string,
    apiKey: string,
    shouldContinue: DecomposeArgs['shouldContinue'] | AnswerArgs['shouldContinue'],
    /** The caller's Stop. A cancelled attempt is never a control rejection, so
     *  it leaves this loop at once through the rethrow below. */
    signal: AbortSignal | undefined,
    /** The output ceiling this kind of call asks for when nothing is in its way. */
    ceilingTokens: number,
    /** S10/§4.5 — what this turn's AI credits allow. Undefined meters nothing,
     *  and the request is then byte for byte what it was before the meter
     *  existed. A reply-control resend goes round this loop and is admitted
     *  again, because it is a second billable attempt. */
    metering: AttemptMetering | undefined,
  ): Promise<unknown> {
    for (;;) {
      const allowed: ReplyControlsAllowed = {
        schema:
          this.structuredOutput &&
          CLAUDE_MODEL_REQUEST_CAPABILITIES[model].supportsStructuredOutput &&
          !this.structuredOutputRejectedFor.has(model),
        thinking: !this.thinkingControlRejectedFor.has(model),
      };
      try {
        return await this.callWithRetry(
          (maxTokens) => buildBody(allowed, maxTokens),
          apiKey,
          shouldContinue,
          {
            streaming: true,
            signal,
            model,
            ceilingTokens,
            metering,
          },
        );
      } catch (err) {
        const rejected = rejectedReplyControl(err);
        // Only a control this attempt actually SENT can be what was rejected;
        // anything else is an error to surface, never a reason to go round again.
        if (rejected === null || !allowed[rejected]) throw err;
        (rejected === 'schema'
          ? this.structuredOutputRejectedFor
          : this.thinkingControlRejectedFor
        ).add(model);
      }
    }
  }

  /** Models the provider refused a schema-constrained request for, this process. */
  get structuredOutputRejected(): ReadonlyArray<AgentModel> {
    return [...this.structuredOutputRejectedFor];
  }

  /** Models the provider refused a thinking or effort setting for, this process. */
  get thinkingControlRejected(): ReadonlyArray<AgentModel> {
    return [...this.thinkingControlRejectedFor];
  }

  private async callWithRetry(
    /** The request body at a given output ceiling. Rendered PER ATTEMPT, because
     *  admission may lower `max_tokens` or ask for a shorter history (§4.5). */
    render: (maxTokens: number) => string,
    apiKey: string,
    shouldContinue: DecomposeArgs['shouldContinue'] | AnswerArgs['shouldContinue'],
    /** `streaming` reads an Anthropic SSE body and reassembles the non-streamed
     *  envelope from it. Everything else about the call — headers, retry policy,
     *  size ceiling, error text — is identical either way.
     *
     *  `signal` is the caller's Stop (B2). It is linked to the attempt's own
     *  controller, so the transport is told to end the request, AND raced
     *  against the fetch and every stream read, so the call returns promptly
     *  even from a transport that ignores its signal. An aborted call throws
     *  {@link AgentDecomposerCancelledError} — never retried, never another
     *  attempt — carrying the usage `message_start` had already reported, which
     *  `model` prices.
     *
     *  `metering` is §4.5's admission. Undefined leaves every byte, every
     *  header and every timer exactly as they were. */
    opts: {
      streaming?: boolean;
      signal?: AbortSignal;
      model?: AgentModel;
      ceilingTokens: number;
      metering?: AttemptMetering;
    },
  ): Promise<unknown> {
    let attempt = 0;
    const signal = opts.signal;
    // Single retry on 5xx; let 4xx + post-retry 5xx escape as exceptions.
    while (true) {
      // A Stop that landed before this attempt: no request at all.
      if (isCancelled(signal)) throw new AgentDecomposerCancelledError();
      // This is the last asynchronous boundary before each provider attempt.
      // It runs for the initial call and every loop entered after backoff.
      await requireAgentDecomposerContinuation(shouldContinue);
      // ⛔ §4.5 — EVERY BILLABLE ATTEMPT IS ADMITTED BEFORE IT IS SENT, AND
      // THIS IS THE ONLY PLACE A REQUEST IS BUILT. A 5xx retry, a 429 retry, a
      // reply-control resend (through `callConstrained`) and the runtime's one
      // re-ask of a malformed plan all arrive here, so each is a separate
      // admission, a separate call row and a separate settlement — which is what
      // makes the task's committed total the total of what it may actually spend.
      //
      // It sits AFTER the authority fence and BEFORE the post-fence Stop check
      // on purpose: a Stop that lands while admission runs then ends the attempt
      // with the call admitted and nothing sent, which the `finally` below
      // settles `never_sent` at zero charge (§4.6).
      const { body, call: admitted } = await admitOneAttempt(
        opts.ceilingTokens,
        opts.metering,
        render,
      );
      // §4.6 — what this attempt cost, as the one fact known about it right now:
      // nothing left the process. Every later point that learns more replaces it.
      let settlement: AgentCreditSettlement = NEVER_SENT;
      try {
        // ⛔ AND AGAIN AFTER IT. The fence is awaited, so a Stop can land while it
        // runs; the listener below is attached only after this point, and an
        // already-aborted signal never fires it — so without this check the
        // request would go out with a transport signal nobody will ever abort:
        // billed in full and never read. Nothing is awaited between here and the
        // listener, so no Stop can slip between them.
        if (isCancelled(signal)) throw new AgentDecomposerCancelledError();
        let res: Response;
        // Per-attempt timeout: a hung upstream aborts here rather than hanging
        // the turn forever. The abort surfaces as a network error in the catch
        // below (retried once, then thrown → transient-classified refuse).
        // The body is read INSIDE this try so the abort timer stays armed THROUGH
        // it — clearing the timer after fetch() (headers) but before res.json()
        // left the body read unbounded (only undici's ~300s default backstops),
        // the bug-class fixed in stripe-api bc72ff48.
        const ac = new AbortController();
        // A streamed attempt is bounded by SILENCE — an idle timer the reader
        // re-arms on every chunk — plus an absolute cap that only a stream which
        // never stops trickling can reach. A non-streamed one keeps the single
        // total timer it has always had. The idle timer is armed BEFORE the fetch
        // so an upstream that opens a connection and never sends headers is
        // covered by the same bound as one that goes quiet mid-body. All of them
        // abort the same controller, so the catch below treats any of them as the
        // network failure it is.
        const attemptTimeoutMs =
          opts.streaming === true ? this.streamIdleTimeoutMs : this.requestTimeoutMs;
        let timer = setTimeout(() => ac.abort(), attemptTimeoutMs);
        const rearmIdle = (awaitingFirstText: boolean): void => {
          clearTimeout(timer);
          if (awaitingFirstText) {
            // See DEFAULT_STREAM_THINKING_IDLE_TIMEOUT_MS: the one phase in which
            // a healthy call is expected to be quiet.
            timer = setTimeout(() => ac.abort(), this.streamThinkingIdleTimeoutMs);
            return;
          }
          timer = setTimeout(() => ac.abort(), attemptTimeoutMs);
        };
        const capTimer =
          opts.streaming === true
            ? setTimeout(() => ac.abort(), this.streamTotalTimeoutMs)
            : undefined;
        let bodyText: string;
        let streamedEnvelope: unknown;
        // The usage frames seen so far, so a cancelled call can say what it had
        // already been charged. Filled by the stream reader.
        const observedUsage: Record<string, unknown> = {};
        // §4.6 — whether this attempt's request left the process. It is the fact
        // that decides between charging nothing and charging something, and it is
        // written to the call's own row before the request goes out, so a crash
        // between the two is priced the same way from either side.
        let sent = false;
        // §4.6 — whether the provider has already answered this attempt with a
        // REJECTION, in either of the two ways it says that: a non-2xx status, or
        // a 200 event-stream whose first frame is an error. Both are "rejected
        // rather than served", charged nothing; and both can be followed by a
        // failure — an error body too large to read, a Stop during that read —
        // that would otherwise be priced as a transport failure at the whole
        // bound. Recorded as it arrives, so no later fault can lose it.
        let providerRejected = false;
        const onCancel = (): void => ac.abort();
        signal?.addEventListener('abort', onCancel, { once: true });
        try {
          if (admitted !== null) {
            // §4.5 — its own tiny statement, committed IMMEDIATELY before the
            // request. False means the task was settled around this call (a lapsed
            // lease), so the request must not go out: nobody would pay for it.
            if (!(await admitted.markSent())) {
              throw new AgentDecomposerCreditsDeniedError('settled');
            }
            sent = true;
            settlement = SENT_WITH_NO_RECORD;
          }
          res = await raceAbort(
            this.fetchImpl(ANTHROPIC_API_URL, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': ANTHROPIC_VERSION_HEADER,
                ...(opts.streaming === true ? { accept: 'text/event-stream' } : {}),
              },
              body,
              redirect: 'error',
              signal: ac.signal,
            }),
            signal,
          );
          // Only a 2xx event-stream is read as one. A non-2xx carries an ordinary
          // JSON problem body, and an upstream that ignored `stream: true` answers
          // with the ordinary envelope — both fall through to the buffered read, so
          // neither degrades into a "missing text content" protocol error.
          if (!res.ok) providerRejected = true;
          if (opts.streaming === true && res.ok && isEventStreamResponse(res)) {
            streamedEnvelope = await readAnthropicStream(res, rearmIdle, observedUsage, signal);
            bodyText = '';
          } else {
            bodyText = await raceAbort(readBoundedBody(res), signal);
          }
        } catch (networkErr) {
          // A refusal by the credit meter is not a transport failure and must
          // never buy a second paid attempt at the same refusal. It also outranks
          // the Stop reading below: the request never went out either way, and
          // this says WHY.
          if (networkErr instanceof AgentDecomposerCreditsDeniedError) throw networkErr;
          // §4.6 — a request that went out and was cut short is settled from the
          // usage the provider had already stated (`partial_usage`), or, when it
          // stated none, at its bound (`no_record`). Set here, before every exit
          // from this catch, so a retry, a rethrow and a cancellation all pay the
          // same way for the same attempt.
          if (sent) settlement = settlementFromObserved(observedUsage);
          // ⛔ A REJECTION THE PROVIDER ALREADY STATED IS NOT A TRANSPORT
          // FAILURE — AND §4.6 PRICES THOSE DIFFERENTLY. `no_record` is the row
          // for "sent, no usage AND NO STATUS", and it charges the WHOLE BOUND
          // (L5, the owner's rule for a request that may have run). An attempt
          // the provider REJECTED has a status and produced nothing, so it is
          // `provider_rejected` at zero — whichever of the two ways the status
          // reached us, and whatever failed afterwards:
          //  · a 200 event-stream whose first frame is `{"type":"error"}`
          //    (`AnthropicStreamError` carries the status that frame stands for,
          //    and the retry policy below already decides from that number);
          //  · a non-2xx whose body then could not be read, or whose read the
          //    customer Stopped.
          // Without this, ONE overloaded provider costs a task nothing when it
          // answers with a status and two whole bounds when it answers with a
          // frame — the 529 is retried — for the same event.
          //
          // Only while nothing has been observed: a frame that interrupted a
          // reply already under way is the table's `partial_usage` and stays
          // one, so the reply the provider did serve is still paid for.
          if (
            sent &&
            settlement.basis === 'no_record' &&
            (providerRejected || networkErr instanceof AnthropicStreamError)
          ) {
            settlement = PROVIDER_REJECTED;
          }
          // ⛔ THE CUSTOMER'S STOP OUTRANKS EVERY OTHER READING OF THIS FAILURE.
          // Whatever the transport made of the abort — an AbortError, a torn
          // stream, our own race — it is a cancellation: not retried, not a
          // provider error, and reported with what had already been counted.
          if (isCancelled(signal)) {
            throw new AgentDecomposerCancelledError(
              observedClaudeSpend(observedUsage, opts.model ?? DEFAULT_AGENT_MODEL),
            );
          }
          // Size is a deterministic protocol violation, not a transient network
          // failure. Do not spend a second request on the same oversized body.
          if (networkErr instanceof AnthropicResponseTooLargeError) throw networkErr;
          // A provider error that arrived as a stream FRAME is a status, not a
          // transport failure, so it gets the status branch's policy rather than
          // this one's: retry a 429 or a 5xx, let a 4xx escape on the first
          // attempt. Without this an authentication_error is re-sent once with a
          // backoff — double the latency of the failure B3 set out to stop paying
          // twice for — where the identical failure on an HTTP status is not.
          if (networkErr instanceof AnthropicStreamError) {
            const retryable = networkErr.status === 429 || networkErr.status >= 500;
            if (!retryable || attempt >= MAX_RETRIES_5XX) throw networkErr;
          }
          if (attempt < MAX_RETRIES_5XX) {
            attempt++;
            await abortableSleep(this.retryBackoffMs, signal);
            await requireAgentDecomposerContinuation(shouldContinue);
            continue;
          }
          throw networkErr;
        } finally {
          clearTimeout(timer);
          if (capTimer !== undefined) clearTimeout(capTimer);
          signal?.removeEventListener('abort', onCancel);
        }

        if (res.ok) {
          // An assembled stream is already an envelope object; there is no text to
          // re-parse. Everything else parses OUTSIDE the try so a malformed-JSON
          // success body throws (not retried) — same semantics as the prior
          // res.json().
          if (streamedEnvelope !== undefined) {
            if (sent) settlement = settlementFromEnvelope(streamedEnvelope, observedUsage);
            return streamedEnvelope;
          }
          // ⛔ THE SETTLEMENT IS READ FROM THE SAME TEXT, SEPARATELY, so that the
          // line below stays the one thing this branch does with a buffered body:
          // a success body nobody can parse must still throw here, unretried, and
          // a settlement that threw first would turn that into a different error.
          // It costs one extra parse of at most 64 KiB, on the rare path where an
          // upstream ignored `stream: true`.
          if (sent) settlement = settlementFromBufferedBody(bodyText, observedUsage);
          return JSON.parse(bodyText) as unknown;
        }

        // §4.6 — a non-2xx status arrived before any stream, so the provider
        // rejected the request rather than serving it: charged nothing.
        if (sent) settlement = PROVIDER_REJECTED;

        // Retry transient throttles too, not just 5xx: a 429 (rate-limit) is
        // recoverable with backoff. If the retries still exhaust on a 429,
        // classifyDecomposerError treats it as transient → the turn degrades to a
        // retryable refuse (session kept alive), NOT a customer-facing 500.
        if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES_5XX) {
          attempt++;
          await abortableSleep(this.retryBackoffMs, signal);
          await requireAgentDecomposerContinuation(shouldContinue);
          continue;
        }

        throw new Error(`Anthropic API ${res.status}: ${bodyText.slice(0, 300)}`);
      } finally {
        // ⛔ IN THE `finally`, SO THAT NO EXIT FROM AN ATTEMPT CAN LEAVE A CALL
        // OPEN (§4.6). A thrown fetch, a Stop, a rejected status, a retry that
        // goes round again — each settles the call it admitted before the next
        // one is admitted. A call left `started` holds its whole BOUND against the
        // task until the lease keeper finds it ninety seconds later and charges
        // the customer for a request that may never have gone out.
        //
        // `settle` is contracted never to throw, so this cannot replace the
        // turn's own outcome with a database error.
        if (admitted !== null) await admitted.settle(settlement);
      }
    }
  }
}

// ── C1 — PROMPT CACHING ─────────────────────────────────────────────────
//
// Facts, all from the provider's prompt-caching guide (read 2026-09-18;
// https://platform.claude.com/docs/en/build-with-claude/prompt-caching):
//  · The cache is a PREFIX match over tools → system → messages. One changed
//    byte at position N invalidates every breakpoint at or after N.
//  · At most 4 `cache_control` breakpoints per request. This request spends 2,
//    plus up to 2 more only in the long-gap case below.
//  · Two lifetimes: 5 minutes (write 1.25x base input) and 1 hour (write 2x). A
//    read is 0.1x and refreshes the entry for free. A 1-hour entry must come
//    BEFORE any 5-minute entry in the request.
//  · A prefix shorter than the model's minimum silently does not cache
//    (CLAUDE_MODELS[model].minCacheablePromptTokens).
//  · A breakpoint looks BACK at most 20 blocks for an entry an earlier request
//    wrote; entries exist only where an earlier request put a breakpoint.
//
// ⛔ THE ORDER IS THE HIT RATE. Everything that varies per call — the page
// observation, the saved-credential names, the prior-failure note, the archetype
// tag — is rendered into ONE trailing block AFTER the last breakpoint. Nothing
// volatile may be concatenated into a block that carries, or precedes, a
// `cache_control` marker: that is what "poisoning the prefix" means, and it
// fails silently — every call succeeds and simply pays full price.

interface CacheControl {
  type: 'ephemeral';
  ttl?: '1h';
}

interface AgentRequestTextBlock {
  type: 'text';
  text: string;
  cache_control?: CacheControl;
}

interface AgentRequestMessage {
  role: 'user' | 'assistant';
  // ⛔ ALWAYS the block form, never a bare string, even for a message with no
  // marker. The message that carries the marker moves forward every turn, so a
  // message rendered as blocks on turn N would be rendered as a string on turn
  // N+1. The provider documents those as equivalent; rendering every message
  // one way means the cached prefix does not depend on that staying true.
  content: AgentRequestTextBlock[];
}

// The static instructions: identical for every customer, session and call, so
// the longest-lived entry. One hour, because the gap that matters for THIS
// block is the gap between a customer's turns — reading a result, deciding,
// typing — which routinely passes five minutes and rarely an hour. The prompt
// measures 8,602 chars: ~2,150 tokens at chars/4, nearer 2,800 on the newer
// tokenizer. Writing it at 2x instead of sending it plain costs one extra
// prompt's worth per cold hour (1.1–1.4 cents on the dearest model here); the
// alternative is re-paying the full prompt, and its time to first token, on
// every turn that follows a pause.
//
// ⚠️ On claude-opus-4-7 (minimum 2048) the margin is UNVERIFIED: chars/4 puts
// the prompt at ~2,150, five percent over, on a tokenizer nobody here has
// measured. If the real count is under 2048 this marker silently does nothing
// on that model and caching starts only once system + history pass the minimum.
// The live eval settles it: `cache_creation_input_tokens > 0` on a cold first
// call, per model.
//
// ⚠️ On claude-haiku-4-5 this marker does NOTHING on its own: that model still
// uses the older tokenizer, so the prompt is ~2,150 tokens against a 4096
// minimum. The conversation marker below covers system + history TOGETHER, so
// there caching begins only once the two pass 4096 — and a windowed
// conversation of short entries measures ~1,100–1,700 tokens, which means on
// Haiku 4.5 a typical session NEVER caches. That costs nothing (a marker under
// the minimum is not billed as a write) and saves nothing; it is stated here so
// nobody reads "caching is on" as "caching is on for every model".
// `a-cached-prefix-…` pins which models clear the minimum, so a prompt edit that
// drops another one below it fails a test instead of a budget.
const SYSTEM_CACHE_CONTROL: CacheControl = { type: 'ephemeral', ttl: '1h' };
// The conversation prefix: per-session, rewritten as the session grows, and
// re-read within seconds by the re-plan calls of the same turn. Five minutes
// covers that and any brisk follow-up at the cheaper 1.25x write; a slower
// follow-up still reads the system entry above.
const CONVERSATION_CACHE_CONTROL: CacheControl = { type: 'ephemeral' };

// ── S10 — WHAT ONE ATTEMPT COSTS AT MOST, AND WHAT IT COST (§4.5, §4.6) ─────
//
// ⛔ THE MARKERS ARE DERIVED FROM THE CONSTANTS THE REQUEST IS BUILT FROM, not
// written out again. A cache marker whose shape changed would otherwise move the
// wire and leave this splitter matching nothing — and a body with no markers
// splits entirely into the CHEAPEST region, so the "bound" would stop bounding
// silently, in the direction that under-charges. Here the two cannot diverge.
//
// ⛔ AND PAGE TEXT CANNOT FORGE ONE. Inside a JSON string every quote is
// backslash-escaped, so a page that renders the marker's own characters into the
// conversation serializes as `\"cache_control\":...` and does not match. The
// split is therefore on real markers only, whatever the model is shown.
const ONE_HOUR_CACHE_MARKER = `"cache_control":${JSON.stringify(SYSTEM_CACHE_CONTROL)}`;
const FIVE_MINUTE_CACHE_MARKER = `"cache_control":${JSON.stringify(CONVERSATION_CACHE_CONTROL)}`;

/**
 * The serialized body's bytes, split into §4.5's three regions.
 *
 *   R1  everything up to and including the LAST 1-hour marker — the reply
 *       controls, the tool definitions and the system block — priced at the
 *       1-hour write rate
 *   R2  what follows, up to and including the last 5-minute marker
 *   R3  only what is rendered after the last marker
 *
 * ⛔ BYTES, NOT CHARACTERS. Every input token stands for at least one byte of
 * the UTF-8 sent, whatever the language; a character count would under-count
 * every multi-byte character and the upper bound would not be one. The three
 * always sum to the body's own byte length, because the cuts fall on the ASCII
 * boundaries of a marker.
 *
 * A request with no markers — the read-back — is all R3, which is what §4.5 says
 * of it. A 5-minute marker that somehow preceded the 1-hour one is swallowed
 * into R1 and priced DEARER, which keeps the bound a bound.
 */
export function splitRequestRegionsAtCacheMarkers(body: string): RequestRegionBytes {
  const oneHour = body.lastIndexOf(ONE_HOUR_CACHE_MARKER);
  const oneHourEnd = oneHour === -1 ? 0 : oneHour + ONE_HOUR_CACHE_MARKER.length;
  const fiveMinute = body.lastIndexOf(FIVE_MINUTE_CACHE_MARKER);
  const fiveMinuteEnd =
    fiveMinute === -1
      ? oneHourEnd
      : Math.max(oneHourEnd, fiveMinute + FIVE_MINUTE_CACHE_MARKER.length);
  return {
    oneHourRegionBytes: Buffer.byteLength(body.slice(0, oneHourEnd), 'utf8'),
    fiveMinuteRegionBytes: Buffer.byteLength(body.slice(oneHourEnd, fiveMinuteEnd), 'utf8'),
    uncachedRegionBytes: Buffer.byteLength(body.slice(fiveMinuteEnd), 'utf8'),
  };
}

/**
 * How many of a planning request's bytes are conversation history the caller
 * could drop and still ask the same question.
 *
 * Every message but the LAST: the last one carries the customer's task and the
 * turn-local context, which is the question itself. Text only — the JSON
 * scaffolding around it is not what dropping an entry removes, and counting it
 * would claim more is droppable than is.
 */
function droppableHistoryBytes(messages: ReadonlyArray<AgentRequestMessage>): number {
  let bytes = 0;
  for (let i = 0; i < messages.length - 1; i++) {
    for (const block of messages[i]!.content) bytes += Buffer.byteLength(block.text, 'utf8');
  }
  return bytes;
}

/** What one call kind tells the meter about itself, for every attempt it makes. */
interface AttemptMetering {
  readonly meter: AgentCreditMeter;
  readonly purpose: CreditModelCallPurpose;
  readonly model: AgentModel;
  /** Droppable history in the request as it stands now. */
  historyBytes: () => number;
  /** Rebuild inside this many bytes of history; false when it cannot shrink further. */
  trimHistory: (budgetBytes: number) => boolean;
}

/**
 * The ladder can only be climbed a bounded number of times, because every rung
 * that asks for a rebuild strictly shrinks the request (`fitCall`'s own
 * guarantee, and `trimHistory` drops at least one entry per round). This is the
 * backstop for a meter that does not honour that: refuse, never loop.
 */
const MAX_FIT_LADDER_ROUNDS = 8;

/**
 * §4.5 — the request this attempt will send, and the credit call it was
 * admitted under. `call` is null when nothing meters this turn, which is every
 * turn today.
 */
async function admitOneAttempt(
  ceilingTokens: number,
  metering: AttemptMetering | undefined,
  render: (maxTokens: number) => string,
): Promise<{ body: string; call: AgentCreditCall | null }> {
  let body = render(ceilingTokens);
  if (metering === undefined) return { body, call: null };
  for (let round = 0; round < MAX_FIT_LADDER_ROUNDS; round++) {
    const decision = await metering.meter.admit({
      purpose: metering.purpose,
      model: metering.model,
      regions: splitRequestRegionsAtCacheMarkers(body),
      maxOutputTokens: ceilingTokens,
      historyBytes: metering.historyBytes(),
    });
    if (decision.outcome === 'nothing_to_meter') return { body, call: null };
    if (decision.outcome === 'refused') {
      throw new AgentDecomposerCreditsDeniedError(decision.reason);
    }
    if (decision.outcome === 'rebuild') {
      if (!metering.trimHistory(decision.historyByteBudget)) {
        throw new AgentDecomposerCreditsDeniedError('did_not_fit');
      }
      body = render(ceilingTokens);
      continue;
    }
    // ⛔ THE CEILING IT WAS ADMITTED UNDER IS THE CEILING THAT IS SENT. The bound
    // committed against the task was priced at this number, so sending a higher
    // one would let the call cost more than the task set aside for it. Rebuilding
    // at a LOWER ceiling only ever shrinks the body — `max_tokens` is rendered
    // inside R1, the dearest region — so the bound stays an upper bound.
    if (decision.call.maxOutputTokens !== ceilingTokens) {
      body = render(decision.call.maxOutputTokens);
    }
    return { body, call: decision.call };
  }
  throw new AgentDecomposerCreditsDeniedError('did_not_fit');
}

/** §4.6 — the request never left this process. Charged nothing. */
const NEVER_SENT: AgentCreditSettlement = Object.freeze({ basis: 'never_sent' });
/** §4.6 — it went out and left nothing behind. Charged its whole bound (L5). */
const SENT_WITH_NO_RECORD: AgentCreditSettlement = Object.freeze({ basis: 'no_record' });
/** §4.6 — a non-2xx status before any stream. Charged nothing. */
const PROVIDER_REJECTED: AgentCreditSettlement = Object.freeze({ basis: 'provider_rejected' });

/** §4.6 — a call cut short, from the usage frames it had already produced. */
function settlementFromObserved(observedUsage: Record<string, unknown>): AgentCreditSettlement {
  const usage = modelCallTokensFrom(observedUsage);
  return usage === null ? SENT_WITH_NO_RECORD : { basis: 'partial_usage', usage };
}

/** §4.6 — a call that finished, from the usage block its envelope carried. */
function settlementFromEnvelope(
  envelope: unknown,
  observedUsage: Record<string, unknown>,
): AgentCreditSettlement {
  const record = asRecord(envelope);
  const usage = record === undefined ? null : modelCallTokensFrom(record.usage);
  return usage === null
    ? settlementFromObserved(observedUsage)
    : { basis: 'provider_usage', usage };
}

/** The same, for an upstream that answered with a buffered body. */
function settlementFromBufferedBody(
  bodyText: string,
  observedUsage: Record<string, unknown>,
): AgentCreditSettlement {
  try {
    return settlementFromEnvelope(JSON.parse(bodyText) as unknown, observedUsage);
  } catch {
    // A 200 whose body is not JSON is a call the provider served and we cannot
    // read: `no_record`, at the bound — never zero, which would record a paid
    // call as free.
    return settlementFromObserved(observedUsage);
  }
}

/**
 * The provider's usage block as the credit ledger prices it — each kind of token
 * kept apart, because each is billed at its own rate.
 *
 * Null when there is no usage block or it cannot be read. Null is "cannot say",
 * never zero: a settlement of zero tokens would record a paid call as free.
 * `parseAnthropicUsage` and `splitCacheWrites` are the same readers the usage row
 * and the token debit already use, so a call cannot be priced two ways.
 */
function modelCallTokensFrom(usage: unknown): ModelCallTokens | null {
  const record = asRecord(usage);
  if (record === undefined || Object.keys(record).length === 0) return null;
  try {
    const parts = parseAnthropicUsage({ usage: record });
    const { write5m, write1h } = splitCacheWrites(parts);
    return {
      uncachedInput: parts.inputTokens,
      output: parts.outputTokens,
      cacheRead: parts.cacheReadInputTokens,
      cacheWrite5m: write5m,
      cacheWrite1h: write1h,
    };
  } catch {
    return null;
  }
}

function buildSystemBlocks(): AgentRequestTextBlock[] {
  return [{ type: 'text', text: SYSTEM_PROMPT, cache_control: SYSTEM_CACHE_CONTROL }];
}

// A breakpoint finds an earlier entry only within 20 blocks. 15 leaves slack
// for the blocks this file adds itself (the omission note, the trailing block).
const CACHE_LOOKBACK_SAFE_BLOCKS = 15;
const MAX_INTERMEDIATE_BREAKPOINTS = 2;

/**
 * The planning conversation, rendered for the Messages API: the neutral turns
 * from `buildPlannerConversation`, one text block per part, with this
 * provider's cache markers placed on the part the contract says ends the
 * stable prefix — and the volatile tail AFTER it.
 */
function buildMessages(args: DecomposeArgs): AgentRequestMessage[] {
  const conversation = buildPlannerConversation(args);
  const messages: AgentRequestMessage[] = conversation.turns.map((turn) => ({
    role: turn.role,
    content: turn.parts.map((part) => ({ type: 'text' as const, text: part.text })),
  }));
  // Which transcript role produced each message, in step with `messages`: the
  // long-gap breakpoints below need to tell a CUSTOMER entry (where an earlier
  // planning call left a cache entry) from an operator one (where none did).
  const sourceRoles = conversation.turns.map((turn) => turn.source);
  const lastMsg = messages[messages.length - 1];
  if (lastMsg !== undefined && lastMsg.role === 'user' && conversation.volatileTail !== null) {
    // ── the breakpoint ──
    // On the TASK block, which at this moment is the last block that will be
    // rendered identically by every later request: calls 2..4 of this turn
    // resend it unchanged, and next turn it is replayed from the transcript as
    // the same bytes (`entry.body` === `args.task`). So this one entry is read
    // by the re-plans of this turn AND found, by lookback, by the next turn.
    const taskBlock = lastMsg.content[lastMsg.content.length - 1]!;
    taskBlock.cache_control = CONVERSATION_CACHE_CONTROL;
    placeIntermediateBreakpoints(messages, sourceRoles);
    // ── everything volatile, AFTER it ──
    lastMsg.content.push({ type: 'text', text: conversation.volatileTail });
  }
  return messages;
}

/**
 * The next request finds this turn's cache entry by walking back at most 20
 * blocks from its own breakpoint. A normal turn adds two or three blocks, so
 * that always succeeds. A long run of OPERATOR entries (a person driving the
 * session by hand between two AI turns) can add more than 20, and then the
 * lookback walks off the end and the whole conversation is re-written at the
 * write premium — with byte-identical payloads, so nothing looks wrong.
 *
 * When the previous customer entry (where the last planning call left its
 * entry) is further back than the safe distance, drop a stepping-stone marker
 * every `CACHE_LOOKBACK_SAFE_BLOCKS`: each one can reach the entry behind it.
 * Bounded at two, which with the system and task markers is the provider's
 * limit of four; a gap longer than that costs one full re-write and no more.
 */
function placeIntermediateBreakpoints(
  messages: AgentRequestMessage[],
  sourceRoles: ReadonlyArray<TranscriptEntry['role']>,
): void {
  const taskIndex = messages.length - 1;
  let previousCustomerIndex = -1;
  for (let k = taskIndex - 1; k >= 0; k--) {
    if (sourceRoles[k] === 'user') {
      previousCustomerIndex = k;
      break;
    }
  }
  if (previousCustomerIndex === -1) return;
  let placed = 0;
  for (
    let k = taskIndex - CACHE_LOOKBACK_SAFE_BLOCKS;
    k > previousCustomerIndex && placed < MAX_INTERMEDIATE_BREAKPOINTS;
    k -= CACHE_LOOKBACK_SAFE_BLOCKS
  ) {
    const content = messages[k]!.content;
    content[content.length - 1]!.cache_control = CONVERSATION_CACHE_CONTROL;
    placed++;
  }
}

function requireAnthropicEnvelope(json: unknown): Record<string, unknown> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Anthropic response envelope was not a JSON object');
  }
  return json as Record<string, unknown>;
}

function extractAnthropicText(
  envelope: Record<string, unknown>,
  missingTextMessage: string,
): string {
  if (!Array.isArray(envelope.content)) {
    throw new Error('Anthropic response content was not an array');
  }
  const textBlock = envelope.content.find(
    (candidate): candidate is { type: string; text: string } =>
      typeof candidate === 'object' &&
      candidate !== null &&
      (candidate as Record<string, unknown>).type === 'text' &&
      typeof (candidate as Record<string, unknown>).text === 'string',
  );
  if (textBlock === undefined) throw new Error(missingTextMessage);
  return textBlock.text;
}

/** The provider's `usage` block, validated. Field names mirror the wire. */
interface AnthropicUsageParts {
  /** `input_tokens` — ⛔ the UNCACHED REMAINDER once caching is on, not the prompt. */
  inputTokens: number;
  outputTokens: number;
  /** `cache_creation_input_tokens` — written to the cache by this call. */
  cacheCreationInputTokens: number;
  /** `cache_read_input_tokens` — served from the cache. */
  cacheReadInputTokens: number;
  /** `cache_creation.ephemeral_5m_input_tokens`, when the breakdown is present. */
  cacheCreation5mInputTokens?: number;
  /** `cache_creation.ephemeral_1h_input_tokens`, when the breakdown is present. */
  cacheCreation1hInputTokens?: number;
  /** `output_tokens_details.thinking_tokens`, when reported. */
  thinkingTokens?: number;
}

const USAGE_INVALID = 'Anthropic response usage was missing or invalid';

/**
 * A cache/detail counter that a response MAY omit.
 *
 * ⛔ ABSENT is zero; PRESENT-BUT-WRONG throws. The two must not collapse. A
 * response with no cache fields is one the cache did not touch (every response
 * before caching was switched on, and every test double, has that shape). A
 * response whose cache field is `"120"` or `-1` is a broken wire, and coercing
 * it to zero would quietly record a cached call as costing nothing for its
 * largest part — the same silent under-count the required fields already refuse.
 * `null` is the provider's own spelling of "not applicable" on these fields.
 */
function optionalTokenCount(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isTokenCount(value)) throw new Error(USAGE_INVALID);
  return value;
}

function parseAnthropicUsage(envelope: Record<string, unknown>): AnthropicUsageParts {
  const usageRecord = asRecord(envelope.usage);
  if (usageRecord === undefined) throw new Error(USAGE_INVALID);
  const inputTokens = usageRecord.input_tokens;
  const outputTokens = usageRecord.output_tokens;
  if (!isTokenCount(inputTokens) || !isTokenCount(outputTokens)) throw new Error(USAGE_INVALID);
  const cacheReadInputTokens = optionalTokenCount(usageRecord.cache_read_input_tokens) ?? 0;
  const breakdown = asRecord(usageRecord.cache_creation);
  const cacheCreation5mInputTokens = optionalTokenCount(breakdown?.ephemeral_5m_input_tokens);
  const cacheCreation1hInputTokens = optionalTokenCount(breakdown?.ephemeral_1h_input_tokens);
  // ⛔ THE WRITE TOTAL IS THE LARGER OF THE TWO WAYS THE PROVIDER STATES IT. It
  // sends a total and a per-lifetime split; they should agree. When the total is
  // absent (or smaller than its own split) the split is the better witness, and
  // trusting the bare total would price thousands of written tokens — the
  // DEAREST kind of input — at nothing, in the cost, the debit and the prompt
  // size alike. Throwing instead would discard a paid call with no usage row,
  // which is the worse of the two failures.
  const cacheCreationInputTokens = Math.max(
    optionalTokenCount(usageRecord.cache_creation_input_tokens) ?? 0,
    (cacheCreation5mInputTokens ?? 0) + (cacheCreation1hInputTokens ?? 0),
  );
  const thinkingTokens = optionalTokenCount(
    asRecord(usageRecord.output_tokens_details)?.thinking_tokens,
  );
  if (
    !Number.isSafeInteger(
      inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
    )
  ) {
    throw new Error(USAGE_INVALID);
  }
  return {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens,
    ...(cacheCreation5mInputTokens !== undefined ? { cacheCreation5mInputTokens } : {}),
    ...(cacheCreation1hInputTokens !== undefined ? { cacheCreation1hInputTokens } : {}),
    ...(thinkingTokens !== undefined ? { thinkingTokens } : {}),
  };
}

/**
 * Split a call's cache WRITE into the two lifetimes, which are priced apart.
 *
 * The provider reports a total and, separately, a per-lifetime breakdown. When
 * the breakdown is missing, or does not add up to the total, the part that
 * cannot be attributed is priced at the DEARER (1-hour) rate. This request does
 * send a 1-hour marker, so that is a real possibility and not mere caution, and
 * it keeps the recorded cost an upper bound — the same rule the cent rounding
 * below already follows.
 *
 * `parseAnthropicUsage` has already raised the total to at least the sum of the
 * split, so `total - reported5m` is never below the reported 1-hour figure. The
 * `Math.max` repeats that rule for a caller that assembled the parts by hand:
 * a split that outweighs its total must never price the difference at zero.
 */
function splitCacheWrites(parts: AnthropicUsageParts): { write5m: number; write1h: number } {
  const reported5m = parts.cacheCreation5mInputTokens ?? 0;
  const reported1h = parts.cacheCreation1hInputTokens ?? 0;
  const total = Math.max(parts.cacheCreationInputTokens, reported5m + reported1h);
  return { write5m: reported5m, write1h: total - reported5m };
}

/** Strip the float noise a product like `3 * 0.1` carries, so a `Math.ceil`
 *  after it cannot round 0.30000000000000004 up to a whole extra unit. */
function settle(value: number): number {
  return Number(value.toFixed(6));
}

/**
 * What this call is DEBITED from the session's token budget.
 *
 * ⛔ THE BUDGET IS TWO GUARDS AND THEY WANT DIFFERENT NUMBERS.
 *  · As a SIZE guard ("will the next prompt fit?") it wants the whole prompt,
 *    cached or not. That is the pre-check in `decompose`: `estimateTokens`
 *    never discounts for the cache (and is a known-low floor — see there).
 *  · As a COST guard ("how much of what the customer allowed is spent?") it
 *    wants what the call COST. That is this number.
 *
 * So the debit weights each token by the rate it was billed at, relative to a
 * plain input token: uncached input and output count 1, a cache read counts
 * 0.1, a cache write counts 1.25 (5-minute) or 2 (1-hour). With no cache
 * activity it is exactly `input + output`, which is what it always was.
 *
 * Why not debit the raw total: a session re-sends its whole prefix on every
 * call, and the ~2.2k-token system prompt alone is then 2% of a default 100k
 * budget PER CALL, four calls a turn. The budget would end sessions over tokens
 * that cost a tenth of what it charged for them, and switching the cache on
 * would change nothing a customer could feel. Why not ignore cached tokens: a cache
 * WRITE is dearer than plain input, and a read is not free; a debit that
 * skipped them would let a session outspend its budget in real money.
 *
 * The raw prompt size is kept beside it, on `usage.anthropicPromptTokens`.
 */
function billableTokens(parts: AnthropicUsageParts, model: AgentModel): number {
  const rate = CLAUDE_MODELS[model];
  const { write5m, write1h } = splitCacheWrites(parts);
  const weightedCache =
    write5m * rate.cacheWrite5mMultiplier +
    write1h * rate.cacheWrite1hMultiplier +
    parts.cacheReadInputTokens * rate.cacheReadMultiplier;
  return parts.inputTokens + parts.outputTokens + Math.ceil(settle(weightedCache));
}

// The documented `stop_reason` values (the provider's "handling stop reasons"
// guide, read 2026-09-18).
const KNOWN_STOP_REASONS: ReadonlySet<string> = new Set([
  'end_turn',
  'max_tokens',
  'stop_sequence',
  'tool_use',
  'pause_turn',
  'refusal',
  'model_context_window_exceeded',
]);

/**
 * The provider's `stop_reason`, when it sent one.
 *
 * ⛔ AN ALLOW-LIST, NOT A PASS-THROUGH. This value is written to the usage row
 * and, through the recorder, into the customer-readable audit payload; on the
 * streamed path nothing but the 4 MiB transport backstop bounds it. Every other
 * upstream-authored string in this file is bounded before it reaches a sink, and
 * this one is an enum, so anything outside it is recorded as `other` — still
 * visibly "the provider said something", never the something itself.
 */
function readStopReason(envelope: Record<string, unknown>): string | undefined {
  if (typeof envelope.stop_reason !== 'string') return undefined;
  return KNOWN_STOP_REASONS.has(envelope.stop_reason) ? envelope.stop_reason : 'other';
}

function parseAnthropicResponse(
  json: unknown,
  model: AgentModel,
  opts: { allowEmptyDone?: boolean } = {},
): DecomposeResult {
  const envelope = requireAnthropicEnvelope(json);
  const parts = parseAnthropicUsage(envelope);
  const stopReason = readStopReason(envelope);
  const tokensConsumed = billableTokens(parts, model);
  const usage = makeClaudeUsage(parts.inputTokens, parts.outputTokens, model, parts, stopReason);
  // The provider's own safety stop. It arrives as an HTTP 200 whose content need
  // not match any schema, so read as a plan it surfaces as "not valid JSON" — a
  // fatal protocol error and a 502 — when what happened is that the model
  // declined. That is a refusal, and the customer is owed it as one.
  if (stopReason === 'refusal') {
    return {
      kind: 'refuse',
      refuseReason: PROVIDER_SAFETY_REFUSAL,
      tokensConsumed,
      usage,
    };
  }
  try {
    const truncated = stopReason === 'max_tokens';
    const text = extractAnthropicText(
      envelope,
      withTruncationNote('Anthropic response missing text content block', truncated),
    );
    // The meaning of the reply is the contract's, shared with every provider.
    const interpreted = interpretPlanText(text, {
      label: 'Anthropic',
      truncated,
      ...(opts.allowEmptyDone !== undefined ? { allowEmptyDone: opts.allowEmptyDone } : {}),
    });
    return { ...interpreted, tokensConsumed, usage };
  } catch (error) {
    throw new AgentDecomposerSettledError(
      error instanceof Error ? error.message : 'Anthropic response content was invalid',
      {
        tokensConsumed,
        usage,
      },
    );
  }
}

/**
 * #140 read-and-report — parse the read-back answer response: the Anthropic
 * envelope and usage here, the answer's meaning in the contract
 * (`interpretAnswerText`), which requires a non-empty `answer` string (a
 * blank/malformed answer throws so the runtime falls back to the plan result
 * rather than surfacing an empty reply).
 */
function parseAnswerResponse(json: unknown, model: AgentModel): AnswerResult {
  const envelope = requireAnthropicEnvelope(json);
  const parts = parseAnthropicUsage(envelope);
  const stopReason = readStopReason(envelope);
  const tokensConsumed = billableTokens(parts, model);
  const usage = makeClaudeUsage(parts.inputTokens, parts.outputTokens, model, parts, stopReason);
  try {
    const truncated = stopReason === 'max_tokens';
    const text = extractAnthropicText(
      envelope,
      withTruncationNote('Anthropic answer response missing text content block', truncated),
    );
    const answer = interpretAnswerText(text, { label: 'Anthropic', truncated });
    return { answer, tokensConsumed, usage };
  } catch (error) {
    throw new AgentDecomposerSettledError(
      error instanceof Error ? error.message : 'Anthropic answer response content was invalid',
      { tokensConsumed, usage },
    );
  }
}

/**
 * B2 — what a call cancelled mid-stream had already been charged, as far as the
 * stream said. Anthropic reports the input side (uncached, cache written, cache
 * read) in `message_start`, so this is usually the whole input cost of the call
 * and an output count that is only a floor. Undefined when no usage frame had
 * arrived: "not observed" must never be recorded as zero.
 */
function observedClaudeSpend(
  usageFields: Record<string, unknown>,
  model: AgentModel,
): { tokensConsumed: number; usage: DecomposeUsage } | undefined {
  if (Object.keys(usageFields).length === 0) return undefined;
  try {
    const parts = parseAnthropicUsage({ usage: usageFields });
    return {
      tokensConsumed: billableTokens(parts, model),
      usage: makeClaudeUsage(parts.inputTokens, parts.outputTokens, model, parts),
    };
  } catch {
    return undefined;
  }
}

/**
 * v2-#4 Q.1.e — assemble the per-call usage block from Anthropic's
 * reported input/output tokens. Cost is rounded UP to the nearest
 * cent so micro-rows don't undercount (treats partial cents as a
 * conservative upper bound on what we'd bill if/when bundled-LLM
 * billing turns on).
 */
function makeClaudeUsage(
  inputTokens: number,
  outputTokens: number,
  model: AgentModel = DEFAULT_AGENT_MODEL,
  /** The full validated usage block. Omitted by the paths that made no call. */
  cache?: AnthropicUsageParts,
  stopReason?: string,
): DecomposeUsage {
  // Per-model Anthropic list-price rate (cents per 1k tokens) from the
  // canonical registry. Math.ceil so micro-rows don't undercount.
  const rate = CLAUDE_MODELS[model];
  const parts: AnthropicUsageParts = cache ?? {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens: 0,
    cacheReadInputTokens: 0,
  };
  const { write5m, write1h } = splitCacheWrites(parts);
  const inputCents = (inputTokens / 1000) * rate.inputCentsPer1k;
  const outputCents = (outputTokens / 1000) * rate.outputCentsPer1k;
  // ⛔ A CACHED TOKEN IS AN INPUT TOKEN AT A DIFFERENT RATE, and both wrong
  // answers look fine. Priced at the full input rate, a long session's cost is
  // overstated ~10x on its largest part; left out, real spend is understated and
  // a cache WRITE — which costs MORE than plain input — is recorded as free.
  const cacheCents =
    ((write5m * rate.cacheWrite5mMultiplier +
      write1h * rate.cacheWrite1hMultiplier +
      parts.cacheReadInputTokens * rate.cacheReadMultiplier) /
      1000) *
    rate.inputCentsPer1k;
  const costUsdCents = Math.ceil(settle(inputCents + outputCents + cacheCents));
  return {
    decomposerKind: 'claude',
    anthropicInputTokens: inputTokens,
    anthropicOutputTokens: outputTokens,
    anthropicCacheCreationInputTokens: parts.cacheCreationInputTokens,
    anthropicCacheReadInputTokens: parts.cacheReadInputTokens,
    ...(parts.cacheCreation5mInputTokens !== undefined
      ? { anthropicCacheCreation5mInputTokens: parts.cacheCreation5mInputTokens }
      : {}),
    ...(parts.cacheCreation1hInputTokens !== undefined
      ? { anthropicCacheCreation1hInputTokens: parts.cacheCreation1hInputTokens }
      : {}),
    anthropicPromptTokens:
      inputTokens + parts.cacheCreationInputTokens + parts.cacheReadInputTokens,
    ...(parts.thinkingTokens !== undefined
      ? { anthropicThinkingTokens: parts.thinkingTokens }
      : {}),
    ...(stopReason !== undefined ? { anthropicStopReason: stopReason } : {}),
    costUsdCents,
    model,
  };
}

/**
 * Anthropic streaming error events carry a typed `error.type`, not a status. Map
 * it back onto the status the SAME failure would have arrived as on the
 * non-streamed path, so `classifyDecomposerError` keeps sorting transient from
 * fatal by exactly the rules it already has. An unrecognised type is treated as
 * a 500: transient, retried, and never silently swallowed.
 */
const ANTHROPIC_STREAM_ERROR_STATUS: Record<string, number> = {
  invalid_request_error: 400,
  authentication_error: 401,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  overloaded_error: 529,
};

/** The `usage` fields a stream frame may carry that the accounting reads. */
const STREAMED_USAGE_KEYS = [
  'input_tokens',
  'output_tokens',
  'cache_creation_input_tokens',
  'cache_read_input_tokens',
  'cache_creation',
  'output_tokens_details',
] as const;

/**
 * Reassemble an Anthropic SSE response into the ordinary non-streamed envelope:
 * `{ content: [{ type: 'text', text }], usage: { input_tokens, output_tokens } }`.
 *
 * Returning the SAME SHAPE is the whole point — the plan parse, the field
 * validation, the usage accounting and the error classification downstream are
 * then provably the ones that already shipped, rather than a parallel copy that
 * can drift. Only the transport changed.
 *
 * `onChunk` resets the caller's idle bound on every chunk, so a healthy-but-slow
 * plan is never aborted for taking long; only a stream that goes quiet is.
 */
async function readAnthropicStream(
  res: Response,
  /** `awaitingFirstText` is true from `message_start` until the first text
   *  arrives — the phase in which a model that thinks unseen is silent. */
  onChunk: (awaitingFirstText: boolean) => void,
  /** Receives the usage fields as they arrive — the same object the envelope
   *  is built from — so a call cancelled mid-stream still knows them. */
  usageFields: Record<string, unknown> = {},
  /** The caller's Stop: each read is raced against it. */
  signal?: AbortSignal,
): Promise<unknown> {
  if (res.body === null) throw new Error('Anthropic response envelope was not a JSON object');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let text = '';
  let bytesRead = 0;
  // ⛔ ABSENT, never 0. A zero default would make the assembled
  // envelope ALWAYS satisfy parseAnthropicUsage, so a stream whose usage frames
  // are missing (a future API revision, a lost frame) would bill a zero-cost
  // row instead of throwing the protocol error the buffered path throws — and
  // the bundled-LLM monthly soft-cap, whose ONLY enforcement is that row, would
  // silently stop advancing for the turn.
  //
  // Held as the raw wire fields, merged frame over frame, and handed to
  // parseAnthropicUsage UNVALIDATED — so the streamed and buffered paths share
  // one validator instead of this reader growing a second, laxer one.
  //
  // ⛔ LAST FRAME WINS, FOR EVERY FIELD. The streaming guide states the counts
  // on `message_delta` are CUMULATIVE, and its own examples show `input_tokens`
  // and both cache counters restated there (and changed, when a server tool ran
  // mid-message). Reading the input side from `message_start` alone — which is
  // what this did while it knew only two fields — records the opening figure,
  // not the billed one.
  //
  // ⛔ A LATER FRAME MAY RESTATE A COUNT; IT MAY NEVER ERASE ONE. `null` is the
  // provider's spelling of "nothing to say about this field in this frame", and
  // a `message_delta` is allowed to carry it for the input side. Copied over the
  // figure `message_start` reported, a null cache counter records a cached call
  // as uncached (a silent under-count of real spend, and a live eval reading
  // "the cache never hits"), and a null `input_tokens` fails validation outright
  // — a paid call thrown away with no usage row at all.
  const mergeUsage = (usage: Record<string, unknown> | undefined): void => {
    if (usage === undefined) return;
    for (const key of STREAMED_USAGE_KEYS) {
      const value = usage[key];
      if (value === undefined || value === null) continue;
      // The two nested blocks (the per-lifetime write split, the output detail)
      // follow the same rule one level down, so a restated block with a null
      // member cannot blank the split and re-price a 5-minute write at 2x.
      const nested = asRecord(value);
      const held = asRecord(usageFields[key]);
      if (nested === undefined || held === undefined) {
        usageFields[key] = value;
        continue;
      }
      const merged: Record<string, unknown> = { ...held };
      for (const [member, memberValue] of Object.entries(nested)) {
        if (memberValue !== undefined && memberValue !== null) merged[member] = memberValue;
      }
      usageFields[key] = merged;
    }
  };
  let stopReason: string | undefined;
  let sawMessageStart = false;
  // A body that closes cleanly but EARLY (an intermediary cutting a chunked
  // response) assembles into an envelope that looks whole. Recording the
  // terminal frame is what lets a truncated stream be re-raised as the
  // transport failure it is — retried — rather than parsed into a settled
  // "not valid JSON" that is classified fatal and billed.
  let sawTerminalFrame = false;
  // Collected rather than held in a `let`: the assignment happens inside the
  // frame closure, where narrowing a nullable local back to `Error` at the
  // terminal check is not something the compiler will do.
  const streamErrors: Error[] = [];
  const consume = (block: string): void => {
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (data.length === 0) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data.join('\n'));
    } catch {
      // A frame we cannot read is not a plan we may act on, but it is also not
      // proof the stream is broken — the terminal shape check below decides.
      return;
    }
    if (typeof parsed !== 'object' || parsed === null) return;
    const frame = parsed as Record<string, unknown>;
    if (frame.type === 'message_start') {
      sawMessageStart = true;
      const message = frame.message as Record<string, unknown> | undefined;
      mergeUsage(message?.usage as Record<string, unknown> | undefined);
      return;
    }
    if (frame.type === 'content_block_delta') {
      const delta = frame.delta as Record<string, unknown> | undefined;
      if (typeof delta?.text === 'string') text += delta.text;
      // The PAYLOAD ceiling, applied to the same quantity the buffered read
      // applied it to. Checked here rather than on the raw stream so the limit
      // still means "the model wrote too much", not "the transport framed it".
      if (text.length > MAX_ANTHROPIC_RESPONSE_BYTES) throw new AnthropicResponseTooLargeError();
      return;
    }
    if (frame.type === 'message_delta') {
      // The authoritative output count: it is only final on the last
      // message_delta, so the last one wins rather than the first.
      mergeUsage(frame.usage as Record<string, unknown> | undefined);
      // `stop_reason` on a message_delta is the other shape a completed stream
      // ends with; either it or message_stop proves the body was not truncated.
      const delta = frame.delta as Record<string, unknown> | undefined;
      if (delta?.stop_reason !== undefined && delta.stop_reason !== null) sawTerminalFrame = true;
      // Carried into the envelope: `max_tokens` is how a reply cut off at the
      // output ceiling announces itself, and the buffered envelope has it too.
      if (typeof delta?.stop_reason === 'string') stopReason = delta.stop_reason;
      return;
    }
    if (frame.type === 'message_stop') {
      sawTerminalFrame = true;
      return;
    }
    if (frame.type === 'error') {
      const error = frame.error as Record<string, unknown> | undefined;
      const errorType = typeof error?.type === 'string' ? error.type : 'api_error';
      const message = typeof error?.message === 'string' ? error.message : errorType;
      const status = ANTHROPIC_STREAM_ERROR_STATUS[errorType] ?? 500;
      // An error frame IS the upstream's terminal: the stream is over and the
      // absence of message_stop after it is not truncation.
      sawTerminalFrame = true;
      streamErrors.push(
        new AnthropicStreamError(
          status,
          `Anthropic API ${status.toString()}: ${message.slice(0, 300)}`,
        ),
      );
    }
  };

  try {
    for (;;) {
      const { done, value } = await raceAbort(reader.read(), signal);
      if (done) break;
      bytesRead += value.byteLength;
      // Transport backstop only — see MAX_ANTHROPIC_STREAM_TRANSPORT_BYTES. The
      // payload ceiling lives on the assembled text, in `consume`.
      if (bytesRead > MAX_ANTHROPIC_STREAM_TRANSPORT_BYTES) {
        throw new AnthropicResponseTooLargeError();
      }
      buffer += decoder.decode(value, { stream: true });
      let idx = buffer.search(/\r?\n\r?\n/);
      while (idx !== -1) {
        const sep = /\r?\n\r?\n/.exec(buffer.slice(idx))?.[0] ?? '\n\n';
        consume(buffer.slice(0, idx));
        buffer = buffer.slice(idx + sep.length);
        idx = buffer.search(/\r?\n\r?\n/);
      }
      // Progress: reset the caller's idle bound. A long plan is slow, not stuck.
      // AFTER the frames in this chunk are consumed, so the bound that gets
      // armed is the one for the phase the stream is now in.
      onChunk(sawMessageStart && text.length === 0);
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) consume(buffer);
  } catch (err) {
    // Release the connection on the abandon path too; never await it, so a
    // hostile stream cannot delay the rejection.
    void reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }

  // An error frame is the upstream's own verdict on the call and outranks
  // whatever partial text arrived before it.
  const firstError = streamErrors[0];
  if (firstError !== undefined) throw firstError;
  // A plain Error (not a typed one) on purpose: the caller's network catch is
  // exactly the right handler for a body that stopped early, and it retries.
  if (!sawTerminalFrame) {
    throw new Error('Anthropic stream ended before the message completed');
  }
  return {
    content: [{ type: 'text', text }],
    ...(stopReason !== undefined ? { stop_reason: stopReason } : {}),
    // Omitted, not zeroed, when a usage frame never arrived — parseAnthropicUsage
    // then throws exactly as it does for a buffered envelope with no usage block.
    usage: usageFields,
  };
}

async function readBoundedBody(res: Response): Promise<string> {
  const declaredLength = res.headers.get('content-length');
  if (declaredLength !== null) {
    const bytes = Number(declaredLength);
    if (Number.isFinite(bytes) && bytes > MAX_ANTHROPIC_RESPONSE_BYTES) {
      // Best-effort connection/resource release; never await cancellation on
      // the error path because a hostile stream must not delay rejection.
      void res.body?.cancel().catch(() => undefined);
      throw new AnthropicResponseTooLargeError();
    }
  }
  if (res.body === null) return '';

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytesRead += value.byteLength;
      if (bytesRead > MAX_ANTHROPIC_RESPONSE_BYTES) {
        void reader.cancel().catch(() => undefined);
        throw new AnthropicResponseTooLargeError();
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

// Exported for parity tests — the SYSTEM_PROMPT shape is itself a
// product surface (drift = silent behavior change).
export const __TEST_ONLY__ = {
  SYSTEM_PROMPT,
  AUP_REFUSAL_PATTERNS,
  ANTHROPIC_API_URL,
  ANTHROPIC_VERSION_HEADER,
  MAX_ANTHROPIC_RESPONSE_BYTES,
  MAX_PLAN_INTENTS,
  MAX_AGENT_URL_CHARS,
  MAX_AGENT_SELECTOR_CHARS,
  MAX_AGENT_TYPED_TEXT_CHARS,
  MAX_AGENT_TAP_LABEL_CHARS,
  MAX_AGENT_CUSTOMER_COPY_CHARS,
  makeClaudeUsage,
  ANSWER_SYSTEM_PROMPT,
  MAX_OUTPUT_TOKENS,
  ANSWER_MAX_OUTPUT_TOKENS,
  TRANSCRIPT_WINDOW_MAX_ENTRIES,
  TRANSCRIPT_WINDOW_STEP,
  TRANSCRIPT_MIN_TAIL_ENTRIES,
  TRANSCRIPT_WINDOW_MAX_CHARS,
  MAX_HISTORY_AGENT_ENTRY_CHARS,
  buildMessages,
  buildSystemBlocks,
  selectTranscriptWindow,
  renderHistoryEntry,
  parseAnthropicUsage,
  billableTokens,
  DEFAULT_THINKING_POLICY,
  PLAN_REPLY_SCHEMA,
  ANSWER_REPLY_SCHEMA,
  requestControls,
};
