// The meter every LIVE provider call goes through: the spend cap, the usage and
// latency record, and the check that no secret left the process in a request.
//
// ⛔ THE CAP IS ENFORCED HERE, IN THE ONLY PATH A CALL CAN TAKE. The live tier
// hands the product's decomposer THIS fetch and no other, so there is no code
// path that reaches the provider without passing the check below. A cap that
// lived in the runner's loop would bound the tasks the runner chose to start and
// nothing a task did once started — and one turn can make four calls.
//
// ⛔ AND IT NEVER SEES, STORES OR PRINTS A HEADER. The key travels in one, so the
// meter forwards `init` untouched and reads only the body it was given and the
// response it got back. Nothing here can leak what it never looked at.

import { AgentModelSchema, CLAUDE_MODELS, type AgentModelInfo } from '@driftstack/api-types';
import type { ChatModelPrices } from '../../../src/services/agent-decomposer-openai-compatible.js';
import { readProviderRequest } from './provider-wire.js';

export interface LiveSpendCaps {
  /** Provider calls this run may START. */
  maxCalls: number;
  /** Total tokens (input + output, cache reads and writes included) after which
   *  no further call starts. Checked BEFORE each call, so a run can overshoot by
   *  at most the one call that crossed it. */
  maxTotalTokens: number;
  /**
   * US dollars, at the model registry's rates, after which no further call
   * starts. ⛔ THE ONLY ONE OF THE THREE THAT IS A DOLLAR BOUND: a token count
   * is class-blind, and an output token costs five times an input token and
   * fifty times a cache read.
   */
  maxUsd: number;
}

export type LiveSpendCapName = 'calls' | 'tokens' | 'usd';

const CAP_SENTENCE: Readonly<Record<LiveSpendCapName, string>> = {
  calls: 'the live eval reached its model-call cap and will start no more provider calls',
  tokens: 'the live eval reached its token cap and will start no more provider calls',
  usd: 'the live eval reached its dollar cap and will start no more provider calls',
};

export class LiveSpendCapReachedError extends Error {
  constructor(readonly cap: LiveSpendCapName) {
    super(CAP_SENTENCE[cap]);
    this.name = 'LiveSpendCapReachedError';
  }
}

export interface MeteredCall {
  ordinal: number;
  /** Which of the product's two prompts the request carried. Read off the
   *  request the PRODUCT built, never assumed from call order or transport. */
  purpose: 'plan' | 'answer';
  model: string;
  /** Which task/rep/turn was running, stamped by the runner. */
  label: string;
  status: number | null;
  /** Wall-clock ms from the request leaving to the response headers arriving. */
  headersMs: number | null;
  /** …to the first content delta (a streamed call) or the first body byte. */
  firstTokenMs: number | null;
  /** …to the body ending. */
  totalMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Present only when the provider reports them. Null means "not reported",
   *  which is a different fact from zero. */
  cacheCreationInputTokens: number | null;
  cacheReadInputTokens: number | null;
  /** The provider's own split of the cache write by lifetime, when it gives
   *  one. The two lifetimes are priced differently. */
  cacheCreation5mInputTokens: number | null;
  cacheCreation1hInputTokens: number | null;
  requestBytes: number;
  /** The reply ceiling the request asked for (`max_completion_tokens` /
   *  `max_tokens`), read off the body; null when it named none. */
  maxCompletionTokens: number | null;
  /**
   * The longest the response went SILENT — the largest gap between two chunks
   * of the body, or between the headers and the first chunk. The product bounds
   * a streamed call by silence (an idle timer), so this is the number that says
   * how close a healthy call came to being aborted as a hung one. Null until a
   * body was read.
   */
  longestSilenceMs: number | null;
  /** How much of the billed output was reasoning nobody saw:
   *  `output_tokens_details.thinking_tokens` on the Messages API,
   *  `completion_tokens_details.reasoning_tokens` on chat completions. Null when
   *  the provider did not say. */
  thinkingTokens: number | null;
  /** The provider's `stop_reason`. `max_tokens` is a reply that was cut off. */
  stopReason: string | null;
  /** What the request told the provider about HOW to reply — read off the body
   *  the product built, so the report states the configuration that actually
   *  ran rather than the one somebody intended. */
  thinking: string | null;
  effort: string | null;
  structuredOutput: boolean;
  /** The provider's own error message on a non-2xx. It describes the request,
   *  never a header, and is scrubbed with everything else before it is written. */
  providerError: string | null;
  /** The model's reply text, for the report. Scrubbed before it is written. */
  replyText: string | null;
  /** A transport failure's message. Never a header, never a request body. */
  error: string | null;
}

export interface MeterTotals {
  callsStarted: number;
  callsRefusedByCap: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
  totalTokens: number;
  /** What the calls so far cost at the registry's rates — see `priceCallUsd`. */
  estimatedUsd: number;
  /** Chat calls whose usage never arrived, counted in `totalTokens` and
   *  `estimatedUsd` at a CEILING — see `unreportedUsageCeiling`. */
  callsPricedAtCeiling: number;
}

/** The reply ceiling assumed for a chat call whose request named none. The
 *  adapter always names one; this exists so a body the meter cannot read is
 *  never priced as if it could not have produced output. */
const UNNAMED_COMPLETION_CEILING_TOKENS = 32_768;

/**
 * What a chat call whose usage NEVER ARRIVED is counted as against the caps: a
 * ceiling, never zero. Null for every other call.
 *
 * ⛔ WHY. Chat completions state usage only in their final chunk, so a call cut
 * off before it — the adapter's own idle or total timeout, a torn stream, a
 * Stop, an oversized reply, or a provider that ignores
 * `stream_options.include_usage` — reports nothing, and every one of those may
 * still have been billed. Priced at $0 the dollar and token caps would count
 * them as free, and only the call-count cap would bound a run that keeps
 * timing out. So each counts as its whole request at one token per character
 * (no tokenizer packs text tighter) plus the whole reply ceiling it asked for:
 * an over-count, which fails towards stopping. The Claude wire needs none of
 * this — `message_start` states the input side at once — so a Claude run is
 * left as it was. A call answered with an error status was not charged and is
 * left at zero.
 */
export function unreportedUsageCeiling(
  call: Pick<
    MeteredCall,
    | 'status'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheReadInputTokens'
    | 'cacheCreationInputTokens'
    | 'requestBytes'
    | 'maxCompletionTokens'
  >,
  pricing: ChatModelPrices | null,
): { inputTokens: number; outputTokens: number } | null {
  if (pricing === null) return null;
  if (call.status !== null && call.status >= 400) return null;
  const reported = [
    call.inputTokens,
    call.outputTokens,
    call.cacheReadInputTokens,
    call.cacheCreationInputTokens,
  ].some((v) => v !== null);
  if (reported) return null;
  return {
    inputTokens: call.requestBytes,
    outputTokens: call.maxCompletionTokens ?? UNNAMED_COMPLETION_CEILING_TOKENS,
  };
}

/**
 * The rates an unrecognised model id is priced at: the dearest in the registry.
 *
 * ⛔ A FALLBACK THAT FAILS TOWARDS STOPPING. The cap exists to bound spend, so a
 * model the registry cannot price must never be priced at zero — that would
 * turn the dollar cap off exactly when nothing is known about the cost.
 */
function dearestRates(): AgentModelInfo {
  const all = Object.values(CLAUDE_MODELS);
  return all.reduce((dearest, info) =>
    info.outputCentsPer1k > dearest.outputCentsPer1k ? info : dearest,
  );
}

/**
 * One call's cost in US dollars at the registry's list price.
 *
 * `input_tokens` is the UNCACHED input only; cache reads and writes are reported
 * beside it and priced by their own multipliers. A cache write whose lifetime
 * the provider did not break down is priced at the one-hour rate, the dearer of
 * the two, for the same reason as above. An ESTIMATE all the same: list prices,
 * not an invoice.
 */
export function priceCallUsd(
  call: Pick<
    MeteredCall,
    | 'model'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheCreationInputTokens'
    | 'cacheReadInputTokens'
    | 'cacheCreation5mInputTokens'
    | 'cacheCreation1hInputTokens'
  >,
  /** A chat-completions provider's list prices, from the provider table. When
   *  given, every call is priced at them; the Claude registry is not consulted. */
  pricing: ChatModelPrices | null = null,
): number {
  if (pricing !== null) return priceChatCallUsd(call, pricing);
  return priceClaudeCallUsd(call);
}

/**
 * One chat-completions call at its provider's list price. The meter records a
 * chat call the way it records a Claude one — `inputTokens` is the UNCACHED
 * remainder, cache reads and writes beside it — so each class is priced at its
 * own rate: a write at the write price where the provider has one, else at the
 * input price (the dearer reading; see `dearestRates`).
 */
function priceChatCallUsd(
  call: Pick<
    MeteredCall,
    'inputTokens' | 'outputTokens' | 'cacheCreationInputTokens' | 'cacheReadInputTokens'
  >,
  pricing: ChatModelPrices,
): number {
  const perToken = (usdPerMTok: number): number => usdPerMTok / 1_000_000;
  return (
    (call.inputTokens ?? 0) * perToken(pricing.inputUsdPerMTok) +
    (call.cacheReadInputTokens ?? 0) * perToken(pricing.cachedInputUsdPerMTok) +
    (call.cacheCreationInputTokens ?? 0) *
      perToken(pricing.cacheWriteUsdPerMTok ?? pricing.inputUsdPerMTok) +
    (call.outputTokens ?? 0) * perToken(pricing.outputUsdPerMTok)
  );
}

function priceClaudeCallUsd(
  call: Pick<
    MeteredCall,
    | 'model'
    | 'inputTokens'
    | 'outputTokens'
    | 'cacheCreationInputTokens'
    | 'cacheReadInputTokens'
    | 'cacheCreation5mInputTokens'
    | 'cacheCreation1hInputTokens'
  >,
): number {
  const known = AgentModelSchema.safeParse(call.model);
  const rate = known.success ? CLAUDE_MODELS[known.data] : dearestRates();
  const written = call.cacheCreationInputTokens ?? 0;
  const written5m = Math.min(written, call.cacheCreation5mInputTokens ?? 0);
  const written1h = written - written5m;
  // The multipliers are read through a guard because this package is consumed
  // BUILT: against a stale build that predates them they are `undefined`, the
  // sum is NaN, and `NaN >= cap` is false — a dollar cap silently switched off.
  // The stand-ins are the dearest reading (a write at 2x, a read at full price).
  const multiplier = (value: number, dearest: number): number =>
    Number.isFinite(value) ? value : dearest;
  const inputEquivalent =
    (call.inputTokens ?? 0) +
    written5m * multiplier(rate.cacheWrite5mMultiplier, 2) +
    written1h * multiplier(rate.cacheWrite1hMultiplier, 2) +
    (call.cacheReadInputTokens ?? 0) * multiplier(rate.cacheReadMultiplier, 1);
  const cents =
    (inputEquivalent / 1000) * rate.inputCentsPer1k +
    ((call.outputTokens ?? 0) / 1000) * rate.outputCentsPer1k;
  return cents / 100;
}

export class LiveMeter {
  private readonly calls: MeteredCall[] = [];
  private readonly settling: Array<Promise<void>> = [];
  private refused = 0;
  private reached: LiveSpendCapName | null = null;
  private label = 'unlabelled';
  private leakedSecretNames = new Set<string>();

  constructor(
    private readonly inner: typeof globalThis.fetch,
    private readonly caps: LiveSpendCaps,
    /** name → value. Every request body is searched for each VALUE; only the
     *  NAME is ever recorded. */
    private readonly secrets: ReadonlyMap<string, string>,
    private readonly now: () => number = () => performance.now(),
    /** The chat provider's prices, or null for a Claude run (priced from the
     *  registry by the model each request names). */
    private readonly pricing: ChatModelPrices | null = null,
  ) {}

  /** Stamp the calls that follow with what was running when they were made. */
  setLabel(label: string): void {
    this.label = label;
  }

  capReached(): LiveSpendCapName | null {
    return this.reached;
  }

  /** Names (never values) of secrets that were found inside a request body. */
  secretsSeenInRequests(): ReadonlyArray<string> {
    return [...this.leakedSecretNames];
  }

  records(): ReadonlyArray<MeteredCall> {
    return this.calls;
  }

  /** Wait until every response body the meter is reading has ended, so the
   *  totals below include the call that just returned. */
  async settle(): Promise<void> {
    await Promise.all(this.settling.splice(0));
  }

  totals(): MeterTotals {
    // A chat call with no usage counts at its ceiling (see
    // `unreportedUsageCeiling`); the records themselves keep "not reported".
    const counted = this.calls.map((call) => {
      const ceiling = unreportedUsageCeiling(call, this.pricing);
      return ceiling === null ? call : { ...call, ...ceiling };
    });
    const sum = (pick: (call: MeteredCall) => number | null): number =>
      counted.reduce((total, call) => total + (pick(call) ?? 0), 0);
    const inputTokens = sum((c) => c.inputTokens);
    const outputTokens = sum((c) => c.outputTokens);
    const cacheCreationInputTokens = sum((c) => c.cacheCreationInputTokens);
    const cacheReadInputTokens = sum((c) => c.cacheReadInputTokens);
    return {
      callsStarted: this.calls.length,
      callsRefusedByCap: this.refused,
      inputTokens,
      outputTokens,
      cacheCreationInputTokens,
      cacheReadInputTokens,
      totalTokens: inputTokens + outputTokens + cacheCreationInputTokens + cacheReadInputTokens,
      estimatedUsd: counted.reduce((total, call) => total + priceCallUsd(call, this.pricing), 0),
      callsPricedAtCeiling: this.calls.filter(
        (call) => unreportedUsageCeiling(call, this.pricing) !== null,
      ).length,
    };
  }

  /** The fetch the product's decomposer is constructed with. */
  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    // The previous call's usage must be counted before this one is allowed.
    await this.settle();
    const totals = this.totals();
    if (totals.callsStarted >= this.caps.maxCalls) return this.refuse('calls');
    if (totals.totalTokens >= this.caps.maxTotalTokens) return this.refuse('tokens');
    if (totals.estimatedUsd >= this.caps.maxUsd) return this.refuse('usd');

    const bodyText = typeof init?.body === 'string' ? init.body : '';
    for (const [name, value] of this.secrets) {
      if (value.length > 0 && bodyText.includes(value)) this.leakedSecretNames.add(name);
    }
    let purpose: MeteredCall['purpose'] = 'answer';
    let model = 'unknown';
    try {
      const request = readProviderRequest(bodyText);
      purpose = request.purpose;
      model = request.model;
    } catch {
      // A body the meter cannot read is still forwarded: the product's request
      // is the product's business, and the provider will say what is wrong.
    }
    const call: MeteredCall = {
      ordinal: this.calls.length,
      purpose,
      model,
      label: this.label,
      status: null,
      headersMs: null,
      firstTokenMs: null,
      totalMs: null,
      inputTokens: null,
      outputTokens: null,
      cacheCreationInputTokens: null,
      cacheReadInputTokens: null,
      cacheCreation5mInputTokens: null,
      cacheCreation1hInputTokens: null,
      requestBytes: bodyText.length,
      maxCompletionTokens: readMaxCompletionTokens(bodyText),
      longestSilenceMs: null,
      thinkingTokens: null,
      stopReason: null,
      ...readReplyControls(bodyText),
      providerError: null,
      replyText: null,
      error: null,
    };
    this.calls.push(call);
    const startedAt = this.now();
    let response: Response;
    try {
      response = await this.inner(input, init);
    } catch (err) {
      call.totalMs = Math.round(this.now() - startedAt);
      call.error = err instanceof Error ? `${err.name}: ${err.message}` : 'the request failed';
      throw err;
    }
    call.status = response.status;
    call.headersMs = Math.round(this.now() - startedAt);
    if (response.body === null) {
      call.totalMs = call.headersMs;
      return response;
    }
    // One branch goes to the product untouched; the other is read here.
    const [forProduct, forMeter] = response.body.tee();
    const streamed = (response.headers.get('content-type') ?? '')
      .toLowerCase()
      .includes('text/event-stream');
    this.settling.push(this.readBody(forMeter, call, startedAt, streamed));
    return new Response(forProduct, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  };

  private refuse(cap: LiveSpendCapName): never {
    this.reached = cap;
    this.refused += 1;
    throw new LiveSpendCapReachedError(cap);
  }

  private async readBody(
    body: ReadableStream<Uint8Array>,
    call: MeteredCall,
    startedAt: number,
    streamed: boolean,
  ): Promise<void> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let lastChunkAt = this.now();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        const at = this.now();
        call.longestSilenceMs = Math.max(call.longestSilenceMs ?? 0, Math.round(at - lastChunkAt));
        lastChunkAt = at;
        if (done) break;
        text += decoder.decode(value, { stream: true });
        if (
          call.firstTokenMs === null &&
          (!streamed || text.includes('content_block_delta') || CHAT_CONTENT_DELTA.test(text))
        ) {
          call.firstTokenMs = Math.round(this.now() - startedAt);
        }
      }
      text += decoder.decode();
    } catch (err) {
      call.error = err instanceof Error ? `${err.name}: ${err.message}` : 'the body failed';
    } finally {
      reader.releaseLock();
    }
    call.totalMs = Math.round(this.now() - startedAt);
    if (streamed) readStreamedUsage(text, call);
    else readBufferedUsage(text, call);
    // ⛔ SCRUBBED AT THE POINT OF CAPTURE. A provider's 401 body can ECHO THE KEY
    // it was sent, and this string goes straight into the report object — which
    // is held in memory, printed and asserted on before the writer's own scrub
    // ever runs. The writer's scrub is the last line of defence, not the first.
    if (call.status !== null && call.status >= 400) {
      call.providerError = scrubSecrets(readProviderError(text) ?? '', this.secrets);
    }
  }
}

/** The thinking, effort and reply-format members of the request the product
 *  built. A body the meter cannot parse reports nothing rather than guessing. */
function readReplyControls(
  bodyText: string,
): Pick<MeteredCall, 'thinking' | 'effort' | 'structuredOutput'> {
  try {
    const body = JSON.parse(bodyText) as {
      thinking?: { type?: unknown };
      output_config?: { effort?: unknown; format?: unknown };
      // Chat completions: the reasoning knob and the reply constraint.
      reasoning_effort?: unknown;
      response_format?: unknown;
    };
    return {
      thinking: typeof body.thinking?.type === 'string' ? body.thinking.type : null,
      effort:
        typeof body.output_config?.effort === 'string'
          ? body.output_config.effort
          : typeof body.reasoning_effort === 'string'
            ? `reasoning_effort ${body.reasoning_effort}`
            : null,
      structuredOutput:
        body.output_config?.format !== undefined || body.response_format !== undefined,
    };
  } catch {
    return { thinking: null, effort: null, structuredOutput: false };
  }
}

function readMaxCompletionTokens(bodyText: string): number | null {
  try {
    const body = JSON.parse(bodyText) as { max_completion_tokens?: unknown; max_tokens?: unknown };
    return numberOrNull(body.max_completion_tokens) ?? numberOrNull(body.max_tokens);
  } catch {
    return null;
  }
}

function readProviderError(text: string): string | null {
  try {
    const body = JSON.parse(text) as { error?: { type?: unknown; message?: unknown } };
    const type = typeof body.error?.type === 'string' ? body.error.type : 'error';
    const message = typeof body.error?.message === 'string' ? body.error.message : '';
    return `${type}: ${message}`.slice(0, 400);
  } catch {
    return text.slice(0, 200);
  }
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readUsageInto(usage: unknown, call: MeteredCall): void {
  if (typeof usage !== 'object' || usage === null) return;
  const u = usage as Record<string, unknown>;
  // Last writer wins per field: a streamed call reports input tokens up front
  // and the FINAL output count only on its closing delta.
  call.inputTokens = numberOrNull(u.input_tokens) ?? call.inputTokens;
  call.outputTokens = numberOrNull(u.output_tokens) ?? call.outputTokens;
  call.cacheCreationInputTokens =
    numberOrNull(u.cache_creation_input_tokens) ?? call.cacheCreationInputTokens;
  call.cacheReadInputTokens = numberOrNull(u.cache_read_input_tokens) ?? call.cacheReadInputTokens;
  const details = u.output_tokens_details;
  if (typeof details === 'object' && details !== null) {
    call.thinkingTokens =
      numberOrNull((details as Record<string, unknown>).thinking_tokens) ?? call.thinkingTokens;
  }
  const breakdown = u.cache_creation;
  if (typeof breakdown === 'object' && breakdown !== null) {
    const b = breakdown as Record<string, unknown>;
    call.cacheCreation5mInputTokens =
      numberOrNull(b.ephemeral_5m_input_tokens) ?? call.cacheCreation5mInputTokens;
    call.cacheCreation1hInputTokens =
      numberOrNull(b.ephemeral_1h_input_tokens) ?? call.cacheCreation1hInputTokens;
  }
}

/** A chat-completions chunk carrying content text. */
const CHAT_CONTENT_DELTA = /"delta":\{[^}]*"content":"[^"]/;

/**
 * A chat-completions usage block onto the call, in the meter's classes.
 * `prompt_tokens` INCLUDES the cached part there, where the Messages API's
 * `input_tokens` excludes it; the meter keeps the Messages API's meaning (the
 * uncached remainder), so the two wires' reports add up the same way.
 */
function readChatUsageInto(usage: unknown, call: MeteredCall): void {
  if (typeof usage !== 'object' || usage === null) return;
  const u = usage as Record<string, unknown>;
  const prompt = numberOrNull(u.prompt_tokens);
  const details = (
    typeof u.prompt_tokens_details === 'object' && u.prompt_tokens_details !== null
      ? u.prompt_tokens_details
      : {}
  ) as Record<string, unknown>;
  const cached = numberOrNull(details.cached_tokens) ?? numberOrNull(u.prompt_cache_hit_tokens);
  const written = numberOrNull(details.cache_write_tokens);
  if (prompt !== null) call.inputTokens = Math.max(0, prompt - (cached ?? 0) - (written ?? 0));
  call.cacheReadInputTokens = cached ?? call.cacheReadInputTokens;
  call.cacheCreationInputTokens = written ?? call.cacheCreationInputTokens;
  call.outputTokens = numberOrNull(u.completion_tokens) ?? call.outputTokens;
  const completion = u.completion_tokens_details;
  if (typeof completion === 'object' && completion !== null) {
    call.thinkingTokens =
      numberOrNull((completion as Record<string, unknown>).reasoning_tokens) ?? call.thinkingTokens;
  }
}

function readStreamedUsage(text: string, call: MeteredCall): void {
  let reply = '';
  for (const block of text.split(/\r?\n\r?\n/)) {
    const data = block
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice('data:'.length).trimStart())
      .join('\n');
    if (data.length === 0) continue;
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(data) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (frame.type === 'message_start') {
      readUsageInto((frame.message as Record<string, unknown> | undefined)?.usage, call);
    } else if (frame.type === 'message_delta') {
      readUsageInto(frame.usage, call);
      const stop = (frame.delta as Record<string, unknown> | undefined)?.stop_reason;
      if (typeof stop === 'string') call.stopReason = stop;
    } else if (frame.type === 'content_block_delta') {
      const delta = frame.delta as Record<string, unknown> | undefined;
      if (typeof delta?.text === 'string') reply += delta.text;
    } else if (frame.type === undefined) {
      // A chat-completions chunk: `choices[0].delta`, and usage on the chunk
      // that carries it (usually the last, with no choices).
      readChatUsageInto(frame.usage, call);
      const choice = Array.isArray(frame.choices)
        ? (frame.choices[0] as Record<string, unknown> | undefined)
        : undefined;
      const delta = choice?.delta as Record<string, unknown> | undefined;
      if (typeof delta?.content === 'string') reply += delta.content;
      if (typeof choice?.finish_reason === 'string') call.stopReason = choice.finish_reason;
    }
  }
  call.replyText = reply.length > 0 ? reply : null;
}

function readBufferedUsage(text: string, call: MeteredCall): void {
  let envelope: Record<string, unknown>;
  try {
    envelope = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return;
  }
  if (Array.isArray(envelope.choices)) {
    // A chat completion that arrived UNSTREAMED — an endpoint that ignored
    // `stream: true`, which the adapter accepts on purpose. Its usage is in
    // chat-completions classes; read with the Messages API's field names it
    // would be zero, and a zero turns both spend caps off for that provider.
    readChatUsageInto(envelope.usage, call);
    const choice = envelope.choices[0] as Record<string, unknown> | undefined;
    if (typeof choice?.finish_reason === 'string') call.stopReason = choice.finish_reason;
    const message = choice?.message as Record<string, unknown> | undefined;
    call.replyText =
      typeof message?.content === 'string' && message.content.length > 0 ? message.content : null;
    return;
  }
  readUsageInto(envelope.usage, call);
  if (typeof envelope.stop_reason === 'string') call.stopReason = envelope.stop_reason;
  if (!Array.isArray(envelope.content)) return;
  const parts: string[] = [];
  for (const block of envelope.content) {
    if (typeof block !== 'object' || block === null) continue;
    const blockText = (block as { text?: unknown }).text;
    if (typeof blockText === 'string') parts.push(blockText);
  }
  call.replyText = parts.length > 0 ? parts.join('') : null;
}

/**
 * Replace every occurrence of every secret VALUE with its name.
 *
 * The last line of defence, applied to everything the live tier writes or
 * throws. It is not the first: the report is built from fields that never held
 * a secret to begin with. It exists because "never held" is a claim about code
 * someone will edit, and this makes a slip a redaction instead of a leak.
 */
export function scrubSecrets(text: string, secrets: ReadonlyMap<string, string>): string {
  let scrubbed = text;
  for (const [name, value] of secrets) {
    if (value.length === 0) continue;
    scrubbed = scrubbed.split(value).join(`[REDACTED:${name}]`);
    // The same value as it appears inside a JSON string, when escaping changed it.
    const escaped = JSON.stringify(value).slice(1, -1);
    if (escaped !== value) scrubbed = scrubbed.split(escaped).join(`[REDACTED:${name}]`);
  }
  return scrubbed;
}
