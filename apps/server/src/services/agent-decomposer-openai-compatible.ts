// The planner, spoken over an OpenAI-style CHAT COMPLETIONS endpoint.
//
// ⛔ EVAL-ONLY UNTIL THE OWNER PICKS A PROVIDER. Every shortlisted challenger to
// Claude — OpenAI, Google's compatibility endpoint, Baseten, Fireworks,
// Cerebras, Mistral, Inception — speaks this one wire, so one adapter serves
// the whole bake-off. Nothing in production constructs it; the factory that can
// is not wired into bootstrap, and no non-Claude id is in any public model enum.
//
// What it shares with the Claude adapter is everything that is not wire format,
// imported from `agent-planner-contract.ts`: both prompts, both reply schemas,
// the transcript window, the turn assembly (so page text and credential NAMES
// sit in the same fenced, untrusted positions), the AUP pre-filter, the budget
// pre-check, and the reply's meaning — plan, clarify or refuse, with the same
// field limits and the same zero-intent clarify. A result from this adapter is
// the same DecomposeResult / AnswerResult a Claude result is.
//
// What is its own is the transport, and each piece mirrors a decision the
// Claude adapter already made and measured:
//  · streamed (SSE), bounded by SILENCE with a longer allowance before the first
//    text (a reasoning model is quiet while it thinks) and an absolute cap;
//  · the reply constrained to the call's JSON schema where the provider can do
//    it — strictly where it documents strict mode — and a 400 that names the
//    constraint answered by sending the same request without it, once, and
//    remembering that for the life of the process;
//  · reasoning controlled per provider, the same way;
//  · usage read from the provider's final chunk (`stream_options.include_usage`),
//    including cached-prompt and reasoning tokens where it reports them;
//  · the authority fence before every attempt, and the caller's Stop signal
//    honoured throughout.

import {
  requireAgentDecomposerContinuation,
  type AgentDecomposer,
  type AnswerArgs,
  type AnswerResult,
  type DecomposeArgs,
  type DecomposeResult,
} from './agent-decomposer.js';
import {
  ANSWER_REPLY_SCHEMA,
  AgentDecomposerCancelledError,
  PLAN_REPLY_SCHEMA,
  PROVIDER_SAFETY_REFUSAL,
  PlannerProviderStatusError,
  SYSTEM_PROMPT,
  abortableSleep,
  asRecord,
  buildAnswerPrompt,
  buildPlannerConversation,
  interpretAnswerText,
  interpretPlanText,
  isCancelled,
  isEventStreamResponse,
  isTokenCount,
  plannerPreflight,
  raceAbort,
  strictReplySchema,
} from './agent-planner-contract.js';

/**
 * How a provider can be asked to constrain a reply to a JSON schema.
 *
 *  · `json_schema_strict` — `response_format: {type: "json_schema", json_schema:
 *    {name, strict: true, schema}}` with the schema in strict form (every member
 *    required, optional ones nullable; see `strictReplySchema`). Constrained
 *    decoding: the reply cannot be anything else.
 *  · `json_schema` — the same member without `strict`, and the schema as the
 *    Claude adapter sends it. What the provider does with it (constrained
 *    decoding, or the schema prepended to the prompt) is the provider's; the
 *    defensive parser holds either way.
 *  · `none` — no `response_format` at all; the prompt's own OUTPUT FORMAT
 *    section and the defensive parser are the whole contract.
 */
export type ChatReplyFormat = 'json_schema_strict' | 'json_schema' | 'none';

/** Which request member bounds the reply's length. OpenAI deprecated
 *  `max_tokens` in favour of `max_completion_tokens` (which also bounds
 *  reasoning); most compatible endpoints still document `max_tokens`. */
export type ChatMaxTokensParam = 'max_completion_tokens' | 'max_tokens';

/** List prices in US dollars per million tokens. */
export interface ChatModelPrices {
  inputUsdPerMTok: number;
  /** A prompt token served from the provider's cache. Equal to the input price
   *  where the provider gives no cache discount. */
  cachedInputUsdPerMTok: number;
  /** A prompt token WRITTEN to the cache, where the provider charges for that
   *  separately; null where it does not. */
  cacheWriteUsdPerMTok: number | null;
  /** Output, reasoning included: every shortlisted provider bills reasoning as
   *  output. */
  outputUsdPerMTok: number;
}

/** One model on one provider, as this adapter needs to call it. The table of
 *  these, with the documentation each setting was verified against, is
 *  `agent-planner-providers.ts`. */
export interface ChatCompletionsTarget {
  /** Provider-qualified id, e.g. `openai:gpt-5.6-luna`. */
  qualifiedId: string;
  /** The provider's name, used in error messages (`${label} API 401: …`). */
  label: string;
  /** Up to and excluding `/chat/completions`, no trailing slash. */
  baseUrl: string;
  /** The provider's own model id, sent as `model`. */
  model: string;
  replyFormat: ChatReplyFormat;
  /** `reasoning_effort` and the value to send, or null to send nothing. */
  reasoningEffort: string | null;
  maxTokensParam: ChatMaxTokensParam;
  prices: ChatModelPrices;
}

// The ceilings the Claude adapter uses, for the same reason: they bound
// reasoning AND reply together, and the model never sees them, so they are
// headroom rather than a target (see MAX_OUTPUT_TOKENS in the Claude adapter).
const PLAN_MAX_COMPLETION_TOKENS = 8192;
const ANSWER_MAX_COMPLETION_TOKENS = 4096;
const MAX_RETRIES = 1;
const DEFAULT_RETRY_BACKOFF_MS = 1000;
// The same silence bounds as the Claude adapter, and the same reasoning for the
// long one: between the response headers and the first content a reasoning
// model streams nothing while it thinks, so that phase alone waits longer.
const DEFAULT_IDLE_TIMEOUT_MS = 25_000;
const DEFAULT_THINKING_IDLE_TIMEOUT_MS = 120_000;
const DEFAULT_TOTAL_TIMEOUT_MS = 300_000;
// The PAYLOAD ceiling (assembled reply text) and a separate transport backstop
// for the framing — the same split, and the same sizes, as the Claude adapter.
const MAX_REPLY_TEXT_BYTES = 64 * 1024;
const MAX_STREAM_TRANSPORT_BYTES = 4 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;

class ChatReplyTooLargeError extends Error {
  constructor(label: string) {
    super(`${label} response body exceeded ${String(MAX_REPLY_TEXT_BYTES)} bytes`);
    this.name = 'ChatReplyTooLargeError';
  }
}

export interface OpenAICompatibleAgentDecomposerDeps {
  target: ChatCompletionsTarget;
  /**
   * The provider key, handed over by whoever built this adapter.
   *
   * ⛔ NEVER `args.byokAnthropicApiKey`. That slot carries a customer's
   * ANTHROPIC key, and reading it here would send a customer's secret for one
   * company to another. This adapter takes the key for ITS provider from its
   * constructor and ignores the per-call slot entirely.
   */
  apiKey: string;
  fetch?: typeof globalThis.fetch;
  retryBackoffMs?: number;
  idleTimeoutMs?: number;
  thinkingIdleTimeoutMs?: number;
  totalTimeoutMs?: number;
  /** False to send no `response_format`, to measure the parser on its own. */
  structuredOutput?: boolean;
}

/** The reply, reassembled from the stream (or read from a buffered body). */
interface ChatReply {
  text: string;
  /** A strict-mode refusal: the provider's own words, never shown. */
  refusal: string;
  finishReason: string | null;
  usage: Record<string, unknown> | null;
}

/** A chat-completions usage block, validated. */
interface ChatUsageParts {
  /** `prompt_tokens` — the WHOLE prompt, cached part included. */
  promptTokens: number;
  /** `prompt_tokens_details.cached_tokens` (or DeepSeek's
   *  `prompt_cache_hit_tokens`), when reported. */
  cachedPromptTokens: number;
  /** `prompt_tokens_details.cache_write_tokens`, when reported. */
  cacheWriteTokens: number;
  /** `completion_tokens` — reasoning included. */
  completionTokens: number;
  /** `completion_tokens_details.reasoning_tokens`, when reported. */
  reasoningTokens?: number;
}

type ChatControl = 'schema' | 'reasoning';

export class OpenAICompatibleAgentDecomposer implements AgentDecomposer {
  readonly target: ChatCompletionsTarget;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly retryBackoffMs: number;
  private readonly idleTimeoutMs: number;
  private readonly thinkingIdleTimeoutMs: number;
  private readonly totalTimeoutMs: number;
  private readonly structuredOutput: boolean;
  /** Controls this provider REJECTED in this process; see `callConstrained`. */
  private readonly rejected = new Set<ChatControl>();

  constructor(deps: OpenAICompatibleAgentDecomposerDeps) {
    this.target = deps.target;
    this.apiKey = deps.apiKey;
    this.fetchImpl = deps.fetch ?? globalThis.fetch.bind(globalThis);
    this.retryBackoffMs = deps.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
    this.idleTimeoutMs = deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.thinkingIdleTimeoutMs =
      deps.thinkingIdleTimeoutMs ?? deps.idleTimeoutMs ?? DEFAULT_THINKING_IDLE_TIMEOUT_MS;
    this.totalTimeoutMs = deps.totalTimeoutMs ?? DEFAULT_TOTAL_TIMEOUT_MS;
    this.structuredOutput = deps.structuredOutput ?? true;
  }

  /** Reply controls the provider refused in this process, for an operator
   *  surface and for tests: a live fallback must not be invisible. */
  get rejectedControls(): ReadonlyArray<ChatControl> {
    return [...this.rejected];
  }

  async decompose(args: DecomposeArgs): Promise<DecomposeResult> {
    // The AUP pre-filter, then the budget: the contract's, in the contract's
    // order, before anything reaches a third party.
    const preflight = plannerPreflight(args);
    if (preflight !== null) return preflight;
    if (this.apiKey === '') {
      throw new Error(`${this.target.label}: no API key provided`);
    }
    const conversation = buildPlannerConversation(args);
    const messages: Array<{ role: string; content: string }> = [
      { role: 'system', content: SYSTEM_PROMPT },
    ];
    for (const [index, turn] of conversation.turns.entries()) {
      const isLast = index === conversation.turns.length - 1;
      // One string per turn: not every compatible endpoint accepts an array of
      // content parts on an assistant message. The parts are joined, the
      // volatile tail goes LAST — so everything before it is a byte-stable
      // prefix, which is all automatic prefix caching needs.
      const texts = turn.parts.map((part) => part.text);
      if (isLast && conversation.volatileTail !== null) texts.push(conversation.volatileTail);
      messages.push({ role: turn.role, content: texts.join('\n\n') });
    }
    const reply = await this.callConstrained(
      (allowed) =>
        this.requestBody(
          messages,
          PLAN_MAX_COMPLETION_TOKENS,
          'plan_reply',
          PLAN_REPLY_SCHEMA,
          allowed,
        ),
      args.shouldContinue,
      args.signal,
    );
    const tokensConsumed = this.accountFor(reply);
    // The provider's own safety stop: a refusal, never a parse failure.
    if (reply.refusal.length > 0 || reply.finishReason === 'content_filter') {
      return { kind: 'refuse', refuseReason: PROVIDER_SAFETY_REFUSAL, tokensConsumed };
    }
    try {
      const interpreted = interpretPlanText(reply.text, {
        label: this.target.label,
        truncated: reply.finishReason === 'length',
        allowEmptyDone: args.turnProgress !== undefined,
        nullMeansAbsent: this.sentStrict(),
      });
      return { ...interpreted, tokensConsumed };
    } catch (error) {
      throw unusableReply(error, this.target.label);
    }
  }

  async answerFromObservation(args: AnswerArgs): Promise<AnswerResult> {
    if (this.apiKey === '') {
      throw new Error(`${this.target.label}: no API key provided`);
    }
    const prompt = buildAnswerPrompt(args);
    const messages = [
      { role: 'system', content: prompt.system },
      { role: 'user', content: prompt.userText },
    ];
    const reply = await this.callConstrained(
      (allowed) =>
        this.requestBody(
          messages,
          ANSWER_MAX_COMPLETION_TOKENS,
          'answer_reply',
          ANSWER_REPLY_SCHEMA,
          allowed,
        ),
      args.shouldContinue,
      args.signal,
    );
    const tokensConsumed = this.accountFor(reply);
    try {
      if (reply.refusal.length > 0 || reply.finishReason === 'content_filter') {
        throw new Error(`${this.target.label} answer response was a refusal`);
      }
      const answer = interpretAnswerText(reply.text, {
        label: this.target.label,
        truncated: reply.finishReason === 'length',
        nullMeansAbsent: this.sentStrict(),
      });
      return { answer, tokensConsumed };
    } catch (error) {
      throw unusableReply(error, this.target.label);
    }
  }

  /** Whether the schema that is sent now is the strict form. */
  private sentStrict(): boolean {
    return (
      this.structuredOutput &&
      this.target.replyFormat === 'json_schema_strict' &&
      !this.rejected.has('schema')
    );
  }

  private requestBody(
    messages: ReadonlyArray<{ role: string; content: string }>,
    maxTokens: number,
    schemaName: string,
    schema: Record<string, unknown>,
    allowed: Record<ChatControl, boolean>,
  ): string {
    const format = this.target.replyFormat;
    const responseFormat =
      allowed.schema && format === 'json_schema_strict'
        ? {
            type: 'json_schema',
            json_schema: { name: schemaName, strict: true, schema: strictReplySchema(schema) },
          }
        : allowed.schema && format === 'json_schema'
          ? { type: 'json_schema', json_schema: { name: schemaName, schema } }
          : null;
    return JSON.stringify({
      model: this.target.model,
      messages,
      [this.target.maxTokensParam]: maxTokens,
      ...(allowed.reasoning && this.target.reasoningEffort !== null
        ? { reasoning_effort: this.target.reasoningEffort }
        : {}),
      ...(responseFormat !== null ? { response_format: responseFormat } : {}),
      stream: true,
      // Without this a streamed chat completion reports no usage at all, and a
      // paid call with no usage is a spend nobody can see.
      stream_options: { include_usage: true },
    });
  }

  /**
   * One call with the reply constrained and reasoning set, and the plainer
   * request as the second line — the Claude adapter's `callConstrained`, for the
   * same reason: a control the provider stops accepting would otherwise be a 400
   * on every call until the next deploy. A 400 that names a control this attempt
   * SENT drops that control, remembers it, and goes once more; each control can
   * be dropped once, so a call makes at most three attempts.
   */
  private async callConstrained(
    buildBody: (allowed: Record<ChatControl, boolean>) => string,
    shouldContinue: DecomposeArgs['shouldContinue'],
    signal: AbortSignal | undefined,
  ): Promise<ChatReply> {
    for (;;) {
      const allowed: Record<ChatControl, boolean> = {
        schema:
          this.structuredOutput &&
          this.target.replyFormat !== 'none' &&
          !this.rejected.has('schema'),
        reasoning: this.target.reasoningEffort !== null && !this.rejected.has('reasoning'),
      };
      try {
        return await this.callWithRetry(buildBody(allowed), shouldContinue, signal);
      } catch (err) {
        const control = rejectedChatControl(err, allowed);
        if (control === null) throw err;
        this.rejected.add(control);
      }
    }
  }

  private async callWithRetry(
    body: string,
    shouldContinue: DecomposeArgs['shouldContinue'],
    signal: AbortSignal | undefined,
  ): Promise<ChatReply> {
    const label = this.target.label;
    let attempt = 0;
    for (;;) {
      if (isCancelled(signal)) throw new AgentDecomposerCancelledError();
      // The authority fence: the last asynchronous boundary before EVERY
      // provider attempt, the first and each retry alike.
      await requireAgentDecomposerContinuation(shouldContinue);
      // ⛔ AND AGAIN AFTER IT. The fence is awaited, so a Stop can land while it
      // runs; the listener below is attached only after this point, and an
      // already-aborted signal never fires it — so without this check the
      // request would go out with a transport signal nobody will ever abort:
      // billed in full and never read. Nothing is awaited between here and the
      // listener, so no Stop can slip between them.
      if (isCancelled(signal)) throw new AgentDecomposerCancelledError();
      const ac = new AbortController();
      let timer = setTimeout(() => ac.abort(), this.idleTimeoutMs);
      const rearm = (awaitingFirstText: boolean): void => {
        clearTimeout(timer);
        timer = setTimeout(
          () => ac.abort(),
          awaitingFirstText ? this.thinkingIdleTimeoutMs : this.idleTimeoutMs,
        );
      };
      const capTimer = setTimeout(() => ac.abort(), this.totalTimeoutMs);
      const onCancel = (): void => ac.abort();
      signal?.addEventListener('abort', onCancel, { once: true });
      // Every wait in this attempt is raced against BOTH controllers: the
      // caller's Stop (a cancellation) and this attempt's own timers (a network
      // failure, retried once). The timers abort `ac`, which the transport is
      // also given — but the bound must not depend on the transport honouring
      // it, any more than Stop's does. The Stop race is the OUTER one, and its
      // listener on `signal` rejects synchronously while `onCancel` (registered
      // first) aborts `ac`; so a Stop always settles as a cancellation, never
      // as the timeout its own abort of `ac` also triggers.
      const bounded = <T>(promise: Promise<T>): Promise<T> =>
        raceAbort(raceTimedOut(promise, ac.signal, label), signal);
      let res: Response;
      let reply: ChatReply | undefined;
      let errorText = '';
      try {
        res = await bounded(
          this.fetchImpl(`${this.target.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              authorization: `Bearer ${this.apiKey}`,
              accept: 'text/event-stream',
            },
            body,
            redirect: 'error',
            signal: ac.signal,
          }),
        );
        if (!res.ok) {
          errorText = await bounded(readBoundedText(res, MAX_ERROR_BODY_BYTES));
        } else {
          // ⛔ THE THINKING ALLOWANCE STARTS AT THE HEADERS, not at the first
          // chunk. Nothing in chat completions promises an early frame: an
          // endpoint may send headers and then nothing until its reasoning is
          // done — the one phase in which a healthy call is quiet. Left on the
          // plain idle timer, that call is aborted and paid for twice.
          rearm(true);
          if (isEventStreamResponse(res)) {
            reply = await readChatStream(res, label, rearm, bounded);
          } else {
            // An endpoint that ignored `stream: true`: the ordinary completion.
            reply = readChatCompletion(
              await bounded(readBoundedText(res, MAX_REPLY_TEXT_BYTES, label)),
              label,
            );
          }
        }
      } catch (networkErr) {
        // ⛔ A STOP NEEDS NO BRANCH HERE, AND HAS NONE ON PURPOSE. The fetch and
        // every read are raced against the signal, and the race rejects
        // synchronously on abort — before a transport's own AbortError can
        // settle — so a stopped call arrives as AgentDecomposerCancelledError.
        // Below, it is either the error thrown on the last attempt, or it meets
        // the abortable backoff, which rejects with the same type at once; it
        // is never sent again. (Mutation-checked: a rethrow here changes
        // nothing observable.) No `observed` spend: chat completions state
        // usage only in their final chunk, so a stopped call knows nothing of
        // what it cost.
        if (networkErr instanceof ChatReplyTooLargeError) throw networkErr;
        if (networkErr instanceof PlannerProviderStatusError) {
          const retryable = networkErr.status === 429 || networkErr.status >= 500;
          if (!retryable || attempt >= MAX_RETRIES) throw networkErr;
        }
        if (attempt < MAX_RETRIES) {
          attempt++;
          await abortableSleep(this.retryBackoffMs, signal);
          continue;
        }
        throw networkErr;
      } finally {
        clearTimeout(timer);
        clearTimeout(capTimer);
        signal?.removeEventListener('abort', onCancel);
      }
      if (reply !== undefined) return reply;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        attempt++;
        await abortableSleep(this.retryBackoffMs, signal);
        continue;
      }
      throw new PlannerProviderStatusError(
        res.status,
        `${label} API ${String(res.status)}: ${errorText.slice(0, 300)}`,
      );
    }
  }

  /** The call's usage, validated, and what it is debited from the session's
   *  budget — weighted by price the way the Claude adapter's debit is. */
  private accountFor(reply: ChatReply): number {
    return chatBillableTokens(parseChatUsage(reply.usage, this.target.label), this.target.prices);
  }
}

/**
 * A paid reply this adapter cannot use.
 *
 * ⛔ WHY NOT `AgentDecomposerSettledError`, which is what the Claude adapter
 * throws here so the runtime debits the spend. That type carries a
 * `DecomposeUsage`, whose `decomposerKind` is `'claude' | 'deterministic'` and
 * whose counters are named for Anthropic's wire; filling it in for another
 * provider would record a non-Claude call as a Claude one. So this is a plain
 * Error with the same wording — which the runtime classifies exactly as it
 * classifies the Claude one — and the spend stays visible to the live eval's
 * meter, which reads it off the wire. Widening `decomposerKind` is the change
 * that would let it settle properly.
 */
function unusableReply(error: unknown, label: string): Error {
  return error instanceof Error ? error : new Error(`${label} response content was invalid`);
}

/**
 * Which reply control a provider's refusal of the request is ABOUT, among those
 * this attempt SENT — or null, and the error stands.
 *
 * ⛔ 400 AND 422 ALIKE. Providers that validate requests FastAPI-style answer an
 * unsupported parameter with 422, and not every shortlisted provider documents
 * which it uses; a control rejected with the "wrong" one would otherwise fail
 * every call, where the point is to run the day the key exists.
 *
 * ⛔ THE CONTROL NAMED BY ITS PARAMETER FIRST, then by what it is about. A
 * message can mention both ("json_schema is not supported with reasoning");
 * the order below picks one, and if dropping it does not change the error, the
 * same message on the next attempt picks the OTHER — the first is no longer
 * sent — so each control is still dropped at most once.
 */
function rejectedChatControl(
  err: unknown,
  sent: Readonly<Record<ChatControl, boolean>>,
): ChatControl | null {
  if (!(err instanceof PlannerProviderStatusError)) return null;
  if (err.status !== 400 && err.status !== 422) return null;
  const named: Array<[RegExp, ChatControl]> = [
    [/reasoning_effort/i, 'reasoning'],
    [/response_format/i, 'schema'],
    [/json_schema|\bstrict\b|\bschema\b|structured output/i, 'schema'],
    [/reasoning/i, 'reasoning'],
  ];
  for (const [pattern, control] of named) {
    if (sent[control] && pattern.test(err.message)) return control;
  }
  return null;
}

/**
 * `promise`, unless this attempt's own controller aborts first (an idle or
 * total timer) — then a plain Error, which the retry policy treats as the
 * network failure a hung upstream is. See `bounded` in `callWithRetry`.
 */
function raceTimedOut<T>(promise: Promise<T>, attempt: AbortSignal, label: string): Promise<T> {
  const timedOut = (): Error => new Error(`${label} request timed out`);
  if (attempt.aborted) {
    promise.catch(() => undefined);
    return Promise.reject(timedOut());
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(timedOut());
    attempt.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        attempt.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err: unknown) => {
        attempt.removeEventListener('abort', onAbort);
        reject(err instanceof Error ? err : new Error('the request failed with a non-error value'));
      },
    );
  });
}

/**
 * The provider's usage block, validated. ⛔ ABSENT IS AN ERROR, not zero: a paid
 * call whose usage never arrived must not be recorded as free. Optional details
 * absent are zero; present-but-wrong throw.
 */
function parseChatUsage(usage: Record<string, unknown> | null, label: string): ChatUsageParts {
  const invalid = `${label} response usage was missing or invalid`;
  if (usage === null) throw new Error(invalid);
  const promptTokens = usage.prompt_tokens;
  const completionTokens = usage.completion_tokens;
  if (!isTokenCount(promptTokens) || !isTokenCount(completionTokens)) throw new Error(invalid);
  const optional = (value: unknown): number | undefined => {
    if (value === undefined || value === null) return undefined;
    if (!isTokenCount(value)) throw new Error(invalid);
    return value;
  };
  const promptDetails = asRecord(usage.prompt_tokens_details);
  const cachedPromptTokens =
    optional(promptDetails?.cached_tokens) ?? optional(usage.prompt_cache_hit_tokens) ?? 0;
  const cacheWriteTokens = optional(promptDetails?.cache_write_tokens) ?? 0;
  if (cachedPromptTokens + cacheWriteTokens > promptTokens) throw new Error(invalid);
  const reasoningTokens = optional(asRecord(usage.completion_tokens_details)?.reasoning_tokens);
  return {
    promptTokens,
    cachedPromptTokens,
    cacheWriteTokens,
    completionTokens,
    ...(reasoningTokens !== undefined ? { reasoningTokens } : {}),
  };
}

/**
 * The budget debit: uncached prompt and completion at one each, cached and
 * cache-written prompt tokens weighted by their price relative to plain input —
 * the Claude adapter's rule (`billableTokens`), with this provider's rates.
 */
function chatBillableTokens(parts: ChatUsageParts, prices: ChatModelPrices): number {
  const uncached = parts.promptTokens - parts.cachedPromptTokens - parts.cacheWriteTokens;
  const readWeight = prices.cachedInputUsdPerMTok / prices.inputUsdPerMTok;
  const writeWeight =
    (prices.cacheWriteUsdPerMTok ?? prices.inputUsdPerMTok) / prices.inputUsdPerMTok;
  const weighted = parts.cachedPromptTokens * readWeight + parts.cacheWriteTokens * writeWeight;
  return uncached + parts.completionTokens + Math.ceil(Number(weighted.toFixed(6)));
}

/** A body read up to `max` bytes. With a `label`, crossing it is the payload
 *  error; without one (an error body) the excess is simply not read. */
async function readBoundedText(res: Response, max: number, label?: string): Promise<string> {
  if (res.body === null) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > max) {
        void reader.cancel().catch(() => undefined);
        if (label !== undefined) throw new ChatReplyTooLargeError(label);
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

/** A non-streamed chat completion. */
function readChatCompletion(bodyText: string, label: string): ChatReply {
  let body: unknown;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`${label} response envelope was not a JSON object`);
  }
  const envelope = asRecord(body);
  if (envelope === undefined) throw new Error(`${label} response envelope was not a JSON object`);
  const choice = Array.isArray(envelope.choices) ? asRecord(envelope.choices[0]) : undefined;
  const message = asRecord(choice?.message);
  if (message === undefined) throw new Error(`${label} response missing text content`);
  const text = typeof message.content === 'string' ? message.content : '';
  if (text.length > MAX_REPLY_TEXT_BYTES) throw new ChatReplyTooLargeError(label);
  return {
    text,
    refusal: typeof message.refusal === 'string' ? message.refusal : '',
    finishReason: typeof choice?.finish_reason === 'string' ? choice.finish_reason : null,
    usage: asRecord(envelope.usage) ?? null,
  };
}

/** The status a mid-stream `error` object stands for, so the retry policy and
 *  the classifier treat it as the same failure arriving as an HTTP status. */
function streamErrorStatus(error: Record<string, unknown>): number {
  const code = error.code ?? error.status;
  if (typeof code === 'number' && code >= 400 && code < 600) return code;
  if (typeof code === 'string' && /^[45]\d\d$/.test(code)) return Number(code);
  const type = [error.type, code].filter((v): v is string => typeof v === 'string').join(' ');
  if (/auth|api_key|permission/i.test(type)) return 401;
  if (/rate_limit|quota/i.test(type)) return 429;
  if (/invalid_request/i.test(type)) return 400;
  return 500;
}

/**
 * Reassemble a streamed chat completion: the text deltas, a strict-mode refusal,
 * the finish reason, and the usage from the final chunk.
 *
 * ⛔ A STREAM THAT ENDS WITHOUT `[DONE]` OR A FINISH REASON WAS CUT OFF. It
 * would otherwise parse as a short reply and be settled as a model fault; as a
 * plain Error it reaches the retry instead, which is what a torn transport is.
 */
async function readChatStream(
  res: Response,
  label: string,
  onChunk: (awaitingFirstText: boolean) => void,
  /** Races each read against the Stop and the attempt's timers. */
  bounded: <T>(promise: Promise<T>) => Promise<T>,
): Promise<ChatReply> {
  if (res.body === null) throw new Error(`${label} response envelope was not a JSON object`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let bytes = 0;
  let text = '';
  let refusal = '';
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | null = null;
  let done = false;
  const errors: PlannerProviderStatusError[] = [];
  const consume = (block: string): void => {
    const data: string[] = [];
    for (const line of block.split(/\r?\n/)) {
      if (line.startsWith('data:')) data.push(line.slice('data:'.length).trimStart());
    }
    if (data.length === 0) return;
    const payload = data.join('\n');
    if (payload.trim() === '[DONE]') {
      done = true;
      return;
    }
    let chunk: Record<string, unknown> | undefined;
    try {
      chunk = asRecord(JSON.parse(payload));
    } catch {
      return;
    }
    if (chunk === undefined) return;
    const error = asRecord(chunk.error);
    if (error !== undefined) {
      const status = streamErrorStatus(error);
      const message = typeof error.message === 'string' ? error.message : 'stream error';
      errors.push(
        new PlannerProviderStatusError(
          status,
          `${label} API ${String(status)}: ${message.slice(0, 300)}`,
        ),
      );
      done = true;
      return;
    }
    const chunkUsage = asRecord(chunk.usage);
    if (chunkUsage !== undefined) usage = chunkUsage;
    const choice = Array.isArray(chunk.choices) ? asRecord(chunk.choices[0]) : undefined;
    if (choice === undefined) return;
    const delta = asRecord(choice.delta);
    if (typeof delta?.content === 'string') text += delta.content;
    if (typeof delta?.refusal === 'string') refusal += delta.refusal;
    if (text.length + refusal.length > MAX_REPLY_TEXT_BYTES)
      throw new ChatReplyTooLargeError(label);
    if (typeof choice.finish_reason === 'string') finishReason = choice.finish_reason;
  };
  try {
    for (;;) {
      const { done: ended, value } = await bounded(reader.read());
      if (ended) break;
      bytes += value.byteLength;
      if (bytes > MAX_STREAM_TRANSPORT_BYTES) throw new ChatReplyTooLargeError(label);
      buffer += decoder.decode(value, { stream: true });
      let at = buffer.search(/\r?\n\r?\n/);
      while (at !== -1) {
        const sep = /\r?\n\r?\n/.exec(buffer.slice(at))?.[0] ?? '\n\n';
        consume(buffer.slice(0, at));
        buffer = buffer.slice(at + sep.length);
        at = buffer.search(/\r?\n\r?\n/);
      }
      onChunk(text.length === 0 && refusal.length === 0);
    }
    buffer += decoder.decode();
    if (buffer.trim().length > 0) consume(buffer);
  } catch (err) {
    void reader.cancel().catch(() => undefined);
    throw err;
  } finally {
    reader.releaseLock();
  }
  const firstError = errors[0];
  if (firstError !== undefined) throw firstError;
  if (!done && finishReason === null) {
    throw new Error(`${label} stream ended before the message completed`);
  }
  return { text, refusal, finishReason, usage };
}

export const __TEST_ONLY__ = {
  PLAN_MAX_COMPLETION_TOKENS,
  ANSWER_MAX_COMPLETION_TOKENS,
  MAX_REPLY_TEXT_BYTES,
  parseChatUsage,
  chatBillableTokens,
  rejectedChatControl,
};
