// B3 — the planning call streams, and streaming changed nothing about the plan.
//
// Before: the Anthropic planning call was a single buffered POST under a 30s
// TOTAL timeout. A long plan is not a sick upstream — it is a healthy one
// talking for longer than 30s — but the timer could not tell those apart. It
// aborted, backed off a second, and re-ran the WHOLE call: double the cost and
// roughly double the wait, for a provider that was working fine.
//
// The fix replaces "how long did this take?" with "how long has it been
// SILENT?". Which is only safe if the assembled result is byte-for-byte the
// result the buffered call produced — so that is the first thing pinned here,
// against the same fixture shape the buffered tests use.
//
// Mutation-proved: drop `stream: true`, drop the `accept` header, drop the
// usage carried on `message_delta`, or replace the idle timer with a total one,
// and a named arm below fails.

import { describe, expect, it } from 'vitest';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import type { DecomposeArgs, DecomposeResult } from '../../src/services/agent-decomposer.js';

const PLAN = {
  kind: 'plan',
  intents: [
    { kind: 'navigate', url: 'https://example.com' },
    { kind: 'capture', capture: 'screenshot' },
  ],
};
const USAGE = { input_tokens: 120, output_tokens: 80 };

function args(overrides: Partial<DecomposeArgs> = {}): DecomposeArgs {
  return {
    task: 'open https://example.com and capture the page',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [],
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: 'sk-ant-test-fake-key',
    ...overrides,
  };
}

/** The ordinary buffered envelope — the shape every pre-existing test uses. */
function bufferedResponse(): Response {
  return new Response(
    // `stop_reason` is on every real envelope, streamed or not; it is carried
    // onto the usage object, so a fixture without it is not "the same reply".
    JSON.stringify({
      content: [{ type: 'text', text: JSON.stringify(PLAN) }],
      stop_reason: 'end_turn',
      usage: USAGE,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

/**
 * The same content as an Anthropic SSE, split across deltas at an arbitrary
 * boundary so the assembler is genuinely joining fragments rather than reading
 * one whole payload. `input_tokens` arrives on `message_start` and the final
 * `output_tokens` only on `message_delta`, exactly as the provider sends them.
 */
function streamedResponse(chunks?: string[]): Response {
  const text = JSON.stringify(PLAN);
  const cut = Math.floor(text.length / 2);
  const frames = chunks ?? [
    `event: message_start\ndata: ${JSON.stringify({
      type: 'message_start',
      message: { usage: { input_tokens: USAGE.input_tokens, output_tokens: 1 } },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: text.slice(0, cut) },
    })}\n\n`,
    `event: content_block_delta\ndata: ${JSON.stringify({
      type: 'content_block_delta',
      delta: { type: 'text_delta', text: text.slice(cut) },
    })}\n\n`,
    `event: message_delta\ndata: ${JSON.stringify({
      type: 'message_delta',
      delta: { stop_reason: 'end_turn' },
      usage: { output_tokens: USAGE.output_tokens },
    })}\n\n`,
    `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
  ];
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

function captureFetch(response: () => Response) {
  const inits: RequestInit[] = [];
  const fetchImpl = ((_url: string | URL, init?: RequestInit) => {
    inits.push(init ?? {});
    return Promise.resolve(response());
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, inits };
}

describe('a streamed plan is the same plan, bounded by silence', () => {
  it('assembles the deltas into the plan the buffered call returns, usage included', async () => {
    const streamed = captureFetch(() => streamedResponse());
    const buffered = captureFetch(bufferedResponse);
    const fromStream = await new ClaudeAgentDecomposer({ fetch: streamed.fetchImpl }).decompose(
      args(),
    );
    // The buffered comparison runs through the SAME public entry point; its
    // upstream simply ignores `stream: true` and answers with JSON, which is the
    // downgrade path a client must survive anyway.
    const fromBuffer = await new ClaudeAgentDecomposer({ fetch: buffered.fetchImpl }).decompose(
      args(),
    );
    expect(fromStream).toEqual(fromBuffer);
    const plan: DecomposeResult = fromStream;
    expect(plan.kind).toBe('plan');
    if (plan.kind !== 'plan') throw new Error('narrow');
    expect(plan.intents).toHaveLength(2);
    // Usage accounting is unchanged: input from message_start, output from the
    // FINAL message_delta (not the placeholder on message_start).
    expect(plan.tokensConsumed).toBe(USAGE.input_tokens + USAGE.output_tokens);
    expect(plan.usage?.anthropicInputTokens).toBe(USAGE.input_tokens);
    expect(plan.usage?.anthropicOutputTokens).toBe(USAGE.output_tokens);
  });

  it('asks for the stream on the wire — both the body flag and the accept header', async () => {
    const { fetchImpl, inits } = captureFetch(() => streamedResponse());
    await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    expect(inits).toHaveLength(1);
    const init = inits[0];
    // The request body is the serialized string the client sent; read it as one.
    const sent = typeof init?.body === 'string' ? init.body : '';
    expect(JSON.parse(sent) as { stream?: unknown }).toMatchObject({ stream: true });
    expect((init?.headers as Record<string, string>).accept).toBe('text/event-stream');
    // The credential headers are untouched by the transport change.
    expect((init?.headers as Record<string, string>)['x-api-key']).toBe('sk-ant-test-fake-key');
  });

  it('aborts an attempt that goes SILENT, then retries and throws — a transient failure', async () => {
    // Headers arrive, one delta arrives, and then nothing ever again. Under the
    // old total timer this was indistinguishable from a long plan; under the
    // idle timer it is the only thing that trips.
    const encoder = new TextEncoder();
    let attempts = 0;
    const stalling = ((_url: string | URL, init?: RequestInit) => {
      attempts += 1;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: content_block_delta\ndata: ${JSON.stringify({
                type: 'content_block_delta',
                delta: { type: 'text_delta', text: '{"kind":"pl' },
              })}\n\n`,
            ),
          );
          // …and then silence. Only the abort can end this stream.
          init?.signal?.addEventListener('abort', () => {
            controller.error(
              Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
            );
          });
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }) as unknown as typeof globalThis.fetch;

    const dec = new ClaudeAgentDecomposer({
      fetch: stalling,
      retryBackoffMs: 0,
      streamIdleTimeoutMs: 5,
    });
    await expect(dec.decompose(args())).rejects.toThrow(/abort/i);
    // The existing single-retry policy is unchanged by the transport.
    expect(attempts).toBe(2);
  });

  it('does NOT abort a slow-but-talking stream, which is the case the total timer got wrong', async () => {
    const encoder = new TextEncoder();
    const text = JSON.stringify(PLAN);
    const trickling = (() => {
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(
            encoder.encode(
              `event: message_start\ndata: ${JSON.stringify({
                type: 'message_start',
                message: { usage: { input_tokens: USAGE.input_tokens, output_tokens: 1 } },
              })}\n\n`,
            ),
          );
          // Eight deltas, each arriving after a delay LONGER than a naive total
          // budget would allow in aggregate but well inside the idle bound.
          for (const piece of text.match(/[\s\S]{1,8}/g) ?? []) {
            await new Promise((resolve) => setTimeout(resolve, 4));
            controller.enqueue(
              encoder.encode(
                `event: content_block_delta\ndata: ${JSON.stringify({
                  type: 'content_block_delta',
                  delta: { type: 'text_delta', text: piece },
                })}\n\n`,
              ),
            );
          }
          controller.enqueue(
            encoder.encode(
              `event: message_delta\ndata: ${JSON.stringify({
                type: 'message_delta',
                delta: { stop_reason: 'end_turn' },
                usage: { output_tokens: USAGE.output_tokens },
              })}\n\n`,
            ),
          );
          controller.enqueue(
            encoder.encode(
              `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
            ),
          );
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }) as unknown as typeof globalThis.fetch;

    // The absolute cap is well under the aggregate trickle time would-be budget
    // only if the idle timer were cumulative; it is not, so this completes.
    const dec = new ClaudeAgentDecomposer({
      fetch: trickling,
      retryBackoffMs: 0,
      streamIdleTimeoutMs: 60,
    });
    const result = await dec.decompose(args());
    expect(result.kind).toBe('plan');
  });

  // ⛔ SILENCE BEFORE THE FIRST TEXT IS NOT SILENCE AFTER IT. On the models that
  // think by default the reasoning is not streamed, so a healthy call sends
  // `message_start` and then nothing until it has finished thinking. The short
  // idle bound would abort that, pay for the whole call again, abort that too
  // and fail the turn. Both halves are pinned: the quiet phase is allowed, and
  // it does not loosen the bound anywhere else.
  function phasedFetch(
    quietAfter: 'nothing' | 'ping' | 'message_start' | 'first_text',
    quietMs: number,
  ) {
    const encoder = new TextEncoder();
    const text = JSON.stringify(PLAN);
    const cut = Math.floor(text.length / 2);
    const frame = (payload: Record<string, unknown>): Uint8Array =>
      encoder.encode(`event: ${String(payload.type)}\ndata: ${JSON.stringify(payload)}\n\n`);
    let attempts = 0;
    const fetchImpl = ((_url: string | URL, init?: RequestInit) => {
      attempts += 1;
      let quiet: ReturnType<typeof setTimeout> | undefined;
      const body = new ReadableStream<Uint8Array>({
        async start(controller) {
          let aborted = false;
          init?.signal?.addEventListener('abort', () => {
            aborted = true;
            if (quiet !== undefined) clearTimeout(quiet);
            controller.error(
              Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }),
            );
          });
          const pause = (): Promise<void> =>
            new Promise((resolve) => {
              quiet = setTimeout(resolve, quietMs);
            });
          if (quietAfter === 'nothing') await pause();
          if (aborted) return;
          if (quietAfter === 'ping') {
            // Bytes, but not a message: the upstream has not started answering.
            controller.enqueue(frame({ type: 'ping' }));
            await pause();
          }
          if (aborted) return;
          controller.enqueue(
            frame({
              type: 'message_start',
              message: { usage: { input_tokens: USAGE.input_tokens, output_tokens: 1 } },
            }),
          );
          if (quietAfter === 'message_start') await pause();
          if (aborted) return;
          controller.enqueue(
            frame({
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: text.slice(0, cut) },
            }),
          );
          if (quietAfter === 'first_text') await pause();
          if (aborted) return;
          controller.enqueue(
            frame({
              type: 'content_block_delta',
              delta: { type: 'text_delta', text: text.slice(cut) },
            }),
          );
          controller.enqueue(
            frame({
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: USAGE.output_tokens },
            }),
          );
          controller.enqueue(frame({ type: 'message_stop' }));
          controller.close();
        },
      });
      return Promise.resolve(
        new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } }),
      );
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, attempts: () => attempts };
  }

  it('⛔ does NOT abort a call that is quiet between message_start and its first text — that is a model thinking, and aborting it pays twice', async () => {
    const { fetchImpl, attempts } = phasedFetch('message_start', 120);
    const dec = new ClaudeAgentDecomposer({
      fetch: fetchImpl,
      retryBackoffMs: 0,
      streamIdleTimeoutMs: 30,
      streamThinkingIdleTimeoutMs: 2_000,
    });
    const result = await dec.decompose(args());
    expect(result.kind).toBe('plan');
    // ONE request. A second one is the defect: the same call, paid for again.
    expect(attempts()).toBe(1);
  });

  it.each(['nothing', 'ping', 'first_text'] as const)(
    'still aborts on the SHORT bound when the quiet falls after %s — the thinking allowance is one phase, not a looser timer',
    async (quietAfter) => {
      const { fetchImpl, attempts } = phasedFetch(quietAfter, 120);
      const dec = new ClaudeAgentDecomposer({
        fetch: fetchImpl,
        retryBackoffMs: 0,
        streamIdleTimeoutMs: 30,
        streamThinkingIdleTimeoutMs: 2_000,
      });
      await expect(dec.decompose(args())).rejects.toThrow(/abort/i);
      expect(attempts()).toBe(2);
    },
  );

  it('a caller that only tightened the idle bound gets it in the thinking phase too', async () => {
    const { fetchImpl, attempts } = phasedFetch('message_start', 120);
    const dec = new ClaudeAgentDecomposer({
      fetch: fetchImpl,
      retryBackoffMs: 0,
      streamIdleTimeoutMs: 30,
    });
    await expect(dec.decompose(args())).rejects.toThrow(/abort/i);
    expect(attempts()).toBe(2);
  });

  it('the thinking allowance is itself a bound: a call that never starts writing is still aborted', async () => {
    const { fetchImpl, attempts } = phasedFetch('message_start', 400);
    const dec = new ClaudeAgentDecomposer({
      fetch: fetchImpl,
      retryBackoffMs: 0,
      streamIdleTimeoutMs: 30,
      streamThinkingIdleTimeoutMs: 60,
    });
    await expect(dec.decompose(args())).rejects.toThrow(/abort/i);
    expect(attempts()).toBe(2);
  });

  it('classifies a mid-stream provider error exactly as the buffered status would — including how many times it is sent', async () => {
    const encoder = new TextEncoder();
    const errorStream = (errorType: string) => {
      const calls = { n: 0 };
      const fetchImpl = (() => {
        calls.n += 1;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    `event: error\ndata: ${JSON.stringify({
                      type: 'error',
                      error: { type: errorType, message: 'upstream said no' },
                    })}\n\n`,
                  ),
                );
                controller.close();
              },
            }),
            { status: 200, headers: { 'content-type': 'text/event-stream' } },
          ),
        );
      }) as unknown as typeof globalThis.fetch;
      return { fetchImpl, calls };
    };

    // An overloaded provider must read as the 529 it is, so the runtime's
    // existing classifier degrades the turn to a retryable refuse rather than a
    // hard failure. Asserting the STATUS in the message is what keeps that
    // classification shared with the buffered path instead of forked.
    const overloaded = errorStream('overloaded_error');
    await expect(
      new ClaudeAgentDecomposer({ fetch: overloaded.fetchImpl, retryBackoffMs: 0 }).decompose(
        args(),
      ),
    ).rejects.toThrow(/Anthropic API 529/);
    // ⛔ The COUNT is the arm that matters, and the message alone cannot see it.
    // An error frame is thrown from inside the fetch/read try block, where the
    // network catch retries unconditionally — so a 4xx delivered as a frame was
    // re-sent once with a backoff, while the identical 4xx delivered as a status
    // escaped immediately. Retry policy is decided on the STATUS either way.
    expect(overloaded.calls.n, 'a 529 is retried once, like the buffered 5xx').toBe(2);

    const badKey = errorStream('authentication_error');
    await expect(
      new ClaudeAgentDecomposer({ fetch: badKey.fetchImpl, retryBackoffMs: 0 }).decompose(args()),
    ).rejects.toThrow(/Anthropic API 401/);
    expect(badKey.calls.n, 'a 401 is fatal — never paid for twice').toBe(1);
  });

  it('carries a plan far bigger than the SSE framing budget, because the ceiling measures the PLAN', async () => {
    // ⛔ The regression this pins: the 64 KiB response ceiling was sized for the
    // JSON envelope ("a few KiB"), and pointing it at the raw SSE counted the
    // `event:`/`data:`/JSON wrapper too — ~120 bytes per ~4-character delta, a
    // ~30x expansion. A perfectly ordinary plan then tripped a limit that is
    // exempt from retry and classified FATAL, so the long plans B3 exists to
    // rescue failed HARDER than before. Realistic delta sizes are the whole
    // point of the fixture: one big delta would not reproduce it.
    const bigPlan = {
      kind: 'plan',
      intents: [
        { kind: 'navigate', url: 'https://mail.example.com' },
        // One validator-legal typed-text intent. MAX_AGENT_TYPED_TEXT_CHARS is
        // 10,000, so this is well inside what the plan parser accepts.
        { kind: 'interact', action: 'type', selector: '#body', value: 'z'.repeat(6000) },
        { kind: 'capture', capture: 'screenshot' },
      ],
    };
    const text = JSON.stringify(bigPlan);
    const encoder = new TextEncoder();
    const frames = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: { usage: { input_tokens: USAGE.input_tokens, output_tokens: 1 } },
      })}\n\n`,
      ...(text.match(/[\s\S]{1,4}/g) ?? []).map(
        (piece) =>
          `event: content_block_delta\ndata: ${JSON.stringify({
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: piece },
          })}\n\n`,
      ),
      `event: message_delta\ndata: ${JSON.stringify({
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: USAGE.output_tokens },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    const rawBytes = frames.reduce((n, f) => n + encoder.encode(f).byteLength, 0);
    // The fixture is only evidence if it really is past the payload ceiling as
    // FRAMING while staying inside it as TEXT — assert both, or a later change
    // to the delta size could quietly make this arm prove nothing.
    expect(rawBytes).toBeGreaterThan(64 * 1024);
    expect(text.length).toBeLessThan(64 * 1024);

    const { fetchImpl } = captureFetch(() => streamedResponse(frames));
    const result = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    expect(result.kind).toBe('plan');
    if (result.kind !== 'plan') throw new Error('narrow');
    expect(result.intents).toHaveLength(3);
  });

  it('refuses a stream whose TEXT really is oversized, which is what the ceiling is for', async () => {
    // The other side of the same boundary: the limit still exists, it is simply
    // measured on the model's output rather than on the transport's framing.
    const huge = 'y'.repeat(70 * 1024);
    const frames = [
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: huge },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    const { fetchImpl, inits } = captureFetch(() => streamedResponse(frames));
    await expect(
      new ClaudeAgentDecomposer({ fetch: fetchImpl, retryBackoffMs: 0 }).decompose(args()),
    ).rejects.toThrow(/response body exceeded \d+ bytes/);
    // Deterministic protocol violation — never paid for a second time.
    expect(inits).toHaveLength(1);
  });

  it('throws on a stream that carried no usage, rather than billing the turn zero', async () => {
    // ⛔ A zero default would make every assembled envelope satisfy the usage
    // validator, so a provider revision that moved or dropped the usage frames
    // would bill a zero-cost row — and the bundled-LLM monthly soft-cap, whose
    // ONLY input is that row, would stop advancing with nothing to say so. The
    // buffered path throws here; so must this one.
    const text = JSON.stringify(PLAN);
    const frames = [
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        delta: { type: 'text_delta', text },
      })}\n\n`,
      `event: message_stop\ndata: ${JSON.stringify({ type: 'message_stop' })}\n\n`,
    ];
    const { fetchImpl } = captureFetch(() => streamedResponse(frames));
    await expect(
      new ClaudeAgentDecomposer({ fetch: fetchImpl, retryBackoffMs: 0 }).decompose(args()),
    ).rejects.toThrow(/usage was missing or invalid/i);
  });

  it('retries a stream that stops mid-plan instead of settling it as a broken response', async () => {
    // A body that closes cleanly but EARLY assembles into an envelope that looks
    // whole. Settling it would turn a transport failure — which the buffered
    // path retried — into a FATAL "not valid JSON" that is billed and never
    // retried. The terminal frame is what tells the two apart.
    const encoder = new TextEncoder();
    let attempts = 0;
    const truncating = (() => {
      attempts += 1;
      const half = JSON.stringify(PLAN).slice(0, 20);
      return Promise.resolve(
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `event: content_block_delta\ndata: ${JSON.stringify({
                    type: 'content_block_delta',
                    delta: { type: 'text_delta', text: half },
                  })}\n\n`,
                ),
              );
              controller.close(); // …no message_delta, no message_stop.
            },
          }),
          { status: 200, headers: { 'content-type': 'text/event-stream' } },
        ),
      );
    }) as unknown as typeof globalThis.fetch;

    await expect(
      new ClaudeAgentDecomposer({ fetch: truncating, retryBackoffMs: 0 }).decompose(args()),
    ).rejects.toThrow(/stream ended before the message completed/i);
    expect(attempts, 'a truncated body is a transport failure, and those are retried').toBe(2);
  });

  it('falls back to the buffered read when the upstream answers with JSON anyway', async () => {
    // An older gateway, a proxy that buffers, or a deployment that strips the
    // flag: the response is ordinary JSON on a 200. Reading that as an SSE would
    // assemble empty text and surface a bogus "not valid JSON" protocol error.
    const { fetchImpl } = captureFetch(bufferedResponse);
    const result = await new ClaudeAgentDecomposer({ fetch: fetchImpl }).decompose(args());
    expect(result.kind).toBe('plan');
  });

  it('reads a non-2xx body as the ordinary error envelope, not as a stream', async () => {
    const failing = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: 'bad key' } }), {
          status: 401,
          headers: { 'content-type': 'application/json' },
        }),
      )) as unknown as typeof globalThis.fetch;
    await expect(
      new ClaudeAgentDecomposer({ fetch: failing, retryBackoffMs: 0 }).decompose(args()),
    ).rejects.toThrow(/Anthropic API 401/);
  });
});
