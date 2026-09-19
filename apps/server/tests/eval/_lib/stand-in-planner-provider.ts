// A stand-in PROVIDER that speaks the real one's wire format — streamed for a
// planning call, buffered for a read-back — so the whole live path can be
// proved with no key, no network and no spend.
//
// WHAT IT PROVES. Everything between the customer's words and the device except
// the model's judgment: the product's request assembly reaches a provider, the
// product's streaming parser reassembles what comes back, the plan is validated
// and executed, the meter counts and caps, the report is written and scrubbed.
// The "model" here is a function we wrote, so NOTHING it does is evidence about
// planning quality — that is the one thing only a real key can buy.
//
// ⛔ IT IS NOT A RECORDING and is never filed as one. No model produced these
// replies. See `recordings/README.md` for why that distinction is kept.
//
// ⛔ IT LOOKS AT THE KEY HEADER AND KEEPS A BOOLEAN. Whether the product sent the
// key it was given is worth knowing (a live run with no key header would fail
// at the provider for a reason nobody could see); the key itself is not kept.

import { readProviderRequest, type ProviderRequestView } from './provider-wire.js';

export interface StandInReply {
  /** The assistant's reply text — for a plan, the JSON object the product's
   *  parser expects. */
  text: string;
  /** Reported usage. Defaults to a deterministic estimate from the sizes. */
  inputTokens?: number;
  outputTokens?: number;
  /** Reported only when set, so a test can prove the meter reads them AND that
   *  an absent field stays "not reported" rather than becoming zero. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
}

/** The stand-in "model": the request the product built → what to say back. */
export type StandInModel = (request: ProviderRequestView, callIndex: number) => StandInReply;

export interface StandInProviderLog {
  requests: ProviderRequestView[];
  /** One entry per request: did it carry the expected key, in the key header? */
  keyHeaderMatched: boolean[];
  /** Raw request bodies, so a test can search them for a secret. */
  bodies: string[];
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

function chunked(parts: ReadonlyArray<string>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const queue = [...parts];
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const next = queue.shift();
      if (next === undefined) {
        controller.close();
        return;
      }
      controller.enqueue(encoder.encode(next));
    },
  });
}

function headerValue(init: RequestInit | undefined, name: string): string | null {
  const headers = init?.headers;
  if (headers === undefined) return null;
  return new Headers(headers).get(name);
}

export function standInProvider(args: { model: StandInModel; expectedKey: string }): {
  fetch: typeof globalThis.fetch;
  log: StandInProviderLog;
} {
  const log: StandInProviderLog = { requests: [], keyHeaderMatched: [], bodies: [] };
  const impl: typeof globalThis.fetch = (_url, init) => {
    const bodyText = typeof init?.body === 'string' ? init.body : '';
    const request = readProviderRequest(bodyText);
    const callIndex = log.requests.length;
    log.requests.push(request);
    log.bodies.push(bodyText);
    log.keyHeaderMatched.push(headerValue(init, 'x-api-key') === args.expectedKey);
    const reply = args.model(request, callIndex);
    const usage = {
      input_tokens: reply.inputTokens ?? Math.ceil(bodyText.length / 4),
      ...(reply.cacheCreationInputTokens !== undefined
        ? { cache_creation_input_tokens: reply.cacheCreationInputTokens }
        : {}),
      ...(reply.cacheReadInputTokens !== undefined
        ? { cache_read_input_tokens: reply.cacheReadInputTokens }
        : {}),
    };
    const outputTokens = reply.outputTokens ?? Math.max(1, Math.ceil(reply.text.length / 4));
    if (!request.stream) {
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'msg_standin',
            type: 'message',
            role: 'assistant',
            model: request.model,
            content: [{ type: 'text', text: reply.text }],
            stop_reason: 'end_turn',
            usage: { ...usage, output_tokens: outputTokens },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }
    // The reply goes out in several deltas, and the FIRST delta frame is split
    // across two network chunks — the shape that breaks a parser which assumes a
    // chunk is a frame.
    const third = Math.max(1, Math.ceil(reply.text.length / 3));
    const deltas = [
      reply.text.slice(0, third),
      reply.text.slice(third, 2 * third),
      reply.text.slice(2 * third),
    ].filter((part) => part.length > 0);
    const frames: string[] = [
      sse('message_start', {
        type: 'message_start',
        message: {
          id: 'msg_standin',
          type: 'message',
          role: 'assistant',
          model: request.model,
          content: [],
          stop_reason: null,
          usage: { ...usage, output_tokens: 1 },
        },
      }),
      sse('content_block_start', {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }),
      sse('ping', { type: 'ping' }),
      ...deltas.map((text) =>
        sse('content_block_delta', {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'text_delta', text },
        }),
      ),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: outputTokens },
      }),
      sse('message_stop', { type: 'message_stop' }),
    ];
    const firstDelta = frames[3] ?? '';
    const cut = Math.floor(firstDelta.length / 2);
    const parts = [
      ...frames.slice(0, 3),
      firstDelta.slice(0, cut),
      firstDelta.slice(cut),
      ...frames.slice(4),
    ];
    return Promise.resolve(
      new Response(chunked(parts), {
        status: 200,
        headers: { 'content-type': 'text/event-stream' },
      }),
    );
  };
  return { fetch: impl, log };
}

// ── stand-in "models" ────────────────────────────────────────────────

const OBSERVATION_OPEN = '<<<PAGE_OBSERVATION';

/** The page digest the product put in the CURRENT planning request, or null
 *  when it planned blind. Read off the request, the way a model reads it. */
export function observationIn(request: ProviderRequestView): string | null {
  const last = [...request.messages].reverse().find((m) => m.role === 'user');
  if (last === undefined) return null;
  const at = last.text.indexOf(OBSERVATION_OPEN);
  return at === -1 ? null : last.text.slice(at + OBSERVATION_OPEN.length);
}

/** A plan reply. With no `status` it is the pre-loop envelope, byte for byte:
 *  the runtime runs it once, exactly as it always did. */
export function planReply(
  intents: ReadonlyArray<unknown>,
  status?: 'continue' | 'done',
  answerWanted?: boolean,
): StandInReply {
  return {
    text: JSON.stringify({
      kind: 'plan',
      ...(status !== undefined ? { status } : {}),
      ...(answerWanted !== undefined ? { answerWanted } : {}),
      intents,
    }),
  };
}

export function answerReply(answer: string): StandInReply {
  return { text: JSON.stringify({ kind: 'answer', answer }) };
}

export function clarifyReply(clarifyingQuestion: string): StandInReply {
  return { text: JSON.stringify({ kind: 'clarify', clarifyingQuestion }) };
}

export function refuseReply(refuseReason: string): StandInReply {
  return { text: JSON.stringify({ kind: 'refuse', refuseReason }) };
}
