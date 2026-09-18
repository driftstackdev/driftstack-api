// A stand-in PROVIDER that speaks OpenAI-style chat completions, streamed — the
// wire every non-Claude candidate in the bake-off uses — so the chat adapter and
// the live tier's whole path can be proved with no key, no network and no spend.
//
// ⛔ IT IS NOT A MODEL AND NOT A RECORDING. The replies are functions we wrote;
// nothing here is evidence about how any real provider plans. What it proves is
// the plumbing: the product's request reaches a provider in this wire's shape,
// the product's stream reader reassembles what comes back, usage is counted,
// the meter caps and prices, the report is written and scrubbed.
//
// ⛔ IT LOOKS AT THE AUTHORIZATION HEADER AND KEEPS A BOOLEAN, never the key.

import type { ProviderRequestView } from './provider-wire.js';
import { readProviderRequest } from './provider-wire.js';

/** What one call should do on the wire. */
export type ChatStandInReply =
  | {
      kind: 'reply';
      /** The assistant content, sent as several deltas. */
      text: string;
      /** A strict-mode refusal, sent as `delta.refusal` instead of content. */
      refusal?: string;
      finishReason?: string;
      /** The usage object for the final chunk. Omit to send none at all. */
      usage?: Record<string, unknown> | null;
      /** Put `usage` on the last CHOICE chunk rather than a separate usage-only
       *  chunk (some compatible endpoints do this). */
      usageOnChoiceChunk?: boolean;
      /** End the body without `[DONE]` or a finish reason. */
      truncate?: boolean;
    }
  | { kind: 'status'; status: number; body: string }
  | { kind: 'stream-error'; error: Record<string, unknown> }
  /** Send the first delta, then go silent forever — the shape a Stop pressed
   *  mid-stream has to cut through. The body ignores cancellation on purpose. */
  | { kind: 'hang-mid-stream'; firstText: string }
  /** Never answer at all, and ignore the abort signal. */
  | { kind: 'hang' }
  /** The ordinary, UNSTREAMED completion — an endpoint that ignored
   *  `stream: true`. `usage` as for `reply`. */
  | {
      kind: 'buffered';
      text: string;
      finishReason?: string;
      usage?: Record<string, unknown> | null;
    }
  /** Headers at once, then NOTHING for `silentMs` — the shape of an endpoint
   *  that says nothing until its reasoning is done — then the whole reply. */
  | { kind: 'silent-then-reply'; silentMs: number; text: string }
  /** Headers at once, then an empty delta every `everyMs`, forever: a stream
   *  that is never silent long enough for an idle timer and never ends. */
  | { kind: 'trickle'; everyMs: number };

export type ChatStandInModel = (
  request: ProviderRequestView & { body: Record<string, unknown> },
  callIndex: number,
) => ChatStandInReply;

export interface ChatStandInLog {
  urls: string[];
  bodies: string[];
  requests: Array<ProviderRequestView & { body: Record<string, unknown> }>;
  /** Did the request carry `Authorization: Bearer <expectedKey>`? */
  bearerMatched: boolean[];
  /** Did the request carry an AbortSignal, and was it aborted by the end? */
  signals: Array<AbortSignal | null>;
  /** The redirect policy each request was sent with. */
  redirects: Array<RequestInit['redirect'] | null>;
  /** Whether the reader released each response body (cancelled its stream).
   *  False for a body nobody cancelled, including one read to its end. */
  bodyCancelled: boolean[];
}

const encoder = new TextEncoder();

function chunk(data: unknown): string {
  return `data: ${typeof data === 'string' ? data : JSON.stringify(data)}\n\n`;
}

function streamOf(
  parts: ReadonlyArray<string>,
  hangAfter = false,
  onCancel: () => void = () => undefined,
): ReadableStream<Uint8Array> {
  const queue = [...parts];
  return new ReadableStream<Uint8Array>({
    cancel() {
      onCancel();
    },
    pull(controller) {
      const next = queue.shift();
      if (next !== undefined) {
        controller.enqueue(encoder.encode(next));
        return;
      }
      if (hangAfter) return new Promise<void>(() => undefined);
      controller.close();
      return undefined;
    },
  });
}

/** A deterministic usage block: a cached prefix and some reasoning. */
export function standInChatUsage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    prompt_tokens: 3200,
    completion_tokens: 140,
    total_tokens: 3340,
    prompt_tokens_details: { cached_tokens: 2048 },
    completion_tokens_details: { reasoning_tokens: 40 },
    ...overrides,
  };
}

export function chatStandInProvider(args: { model: ChatStandInModel; expectedKey: string }): {
  fetch: typeof globalThis.fetch;
  log: ChatStandInLog;
} {
  const log: ChatStandInLog = {
    urls: [],
    bodies: [],
    requests: [],
    bearerMatched: [],
    signals: [],
    redirects: [],
    bodyCancelled: [],
  };
  const impl = (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const body = JSON.parse(bodyText) as Record<string, unknown>;
    const request = { ...readProviderRequest(bodyText), body };
    const index = log.requests.length;
    log.urls.push(typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url);
    log.bodies.push(bodyText);
    log.requests.push(request);
    log.bearerMatched.push(
      new Headers(init?.headers).get('authorization') === `Bearer ${args.expectedKey}`,
    );
    log.signals.push(init?.signal ?? null);
    log.redirects.push(init?.redirect ?? null);
    log.bodyCancelled.push(false);
    const cancelled = (): void => {
      log.bodyCancelled[index] = true;
    };
    const reply = args.model(request, index);
    if (reply.kind === 'hang') return new Promise<Response>(() => undefined);
    if (reply.kind === 'status') {
      return Promise.resolve(new Response(reply.body, { status: reply.status }));
    }
    const sse = { status: 200, headers: { 'content-type': 'text/event-stream' } };
    if (reply.kind === 'buffered') {
      const usage = reply.usage === undefined ? standInChatUsage() : reply.usage;
      return Promise.resolve(
        new Response(
          JSON.stringify({
            object: 'chat.completion',
            choices: [
              {
                index: 0,
                message: { role: 'assistant', content: reply.text },
                finish_reason: reply.finishReason ?? 'stop',
              },
            ],
            ...(usage !== null ? { usage } : {}),
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    if (reply.kind === 'silent-then-reply') {
      const parts = [
        chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: reply.text } }] }),
        chunk({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
        chunk({ choices: [], usage: standInChatUsage() }),
        chunk('[DONE]'),
      ];
      let first = true;
      const body = new ReadableStream<Uint8Array>({
        cancel: cancelled,
        async pull(controller) {
          if (first) {
            first = false;
            await new Promise((r) => setTimeout(r, reply.silentMs));
          }
          const next = parts.shift();
          if (next === undefined) controller.close();
          else controller.enqueue(encoder.encode(next));
        },
      });
      return Promise.resolve(new Response(body, sse));
    }
    if (reply.kind === 'trickle') {
      let stopped = false;
      const body = new ReadableStream<Uint8Array>({
        cancel() {
          stopped = true;
          cancelled();
        },
        async pull(controller) {
          await new Promise((r) => setTimeout(r, reply.everyMs));
          if (stopped) return;
          controller.enqueue(encoder.encode(chunk({ choices: [{ index: 0, delta: {} }] })));
        },
      });
      return Promise.resolve(new Response(body, sse));
    }
    if (reply.kind === 'stream-error') {
      return Promise.resolve(new Response(streamOf([chunk({ error: reply.error })]), sse));
    }
    if (reply.kind === 'hang-mid-stream') {
      return Promise.resolve(
        new Response(
          streamOf(
            [
              chunk({
                choices: [{ index: 0, delta: { role: 'assistant', content: reply.firstText } }],
              }),
            ],
            true,
            cancelled,
          ),
          sse,
        ),
      );
    }
    const third = Math.max(1, Math.ceil(reply.text.length / 3));
    const deltas = [
      reply.text.slice(0, third),
      reply.text.slice(third, 2 * third),
      reply.text.slice(2 * third),
    ].filter((t) => t.length > 0);
    const parts: string[] = [
      chunk({ choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] }),
      ...(reply.refusal !== undefined
        ? [chunk({ choices: [{ index: 0, delta: { refusal: reply.refusal } }] })]
        : deltas.map((content) => chunk({ choices: [{ index: 0, delta: { content } }] }))),
    ];
    if (reply.truncate !== true) {
      const usage = reply.usage === undefined ? standInChatUsage() : reply.usage;
      const finish = {
        choices: [{ index: 0, delta: {}, finish_reason: reply.finishReason ?? 'stop' }],
        ...(reply.usageOnChoiceChunk === true && usage !== null ? { usage } : {}),
      };
      parts.push(chunk(finish));
      if (reply.usageOnChoiceChunk !== true && usage !== null) {
        parts.push(chunk({ choices: [], usage }));
      }
      parts.push(chunk('[DONE]'));
    }
    // Split the second chunk across two network reads: a reader that assumes a
    // read is a frame breaks here.
    const second = parts[1] ?? '';
    const cut = Math.floor(second.length / 2);
    const split = [parts[0] ?? '', second.slice(0, cut), second.slice(cut), ...parts.slice(2)];
    return Promise.resolve(new Response(streamOf(split.filter((p) => p.length > 0)), sse));
  };
  return { fetch: impl, log };
}
