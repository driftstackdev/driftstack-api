// B2 — the customer pressed Stop while a Claude call was in flight.
//
// The authority fence stops the NEXT attempt; only the signal stops THIS one.
// What must hold: the call returns within a small bound of the abort whatever
// the transport does with its own signal; it comes back as the typed
// cancellation, never as a provider error and never retried; and it reports the
// spend Anthropic had already stated in `message_start` (the input side), since
// a cut-short request still consumed what the provider counted.

import { describe, expect, it } from 'vitest';
import { ClaudeAgentDecomposer } from '../../src/services/agent-decomposer-claude.js';
import type { DecomposeArgs } from '../../src/services/agent-decomposer.js';
import { AgentDecomposerCancelledError } from '../../src/services/agent-planner-contract.js';

const BOUND_MS = 100;

function args(signal: AbortSignal): DecomposeArgs {
  return {
    task: 'open https://example.com',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    history: [],
    budgetTokensRemaining: 100_000,
    byokAnthropicApiKey: 'sk-ant-test-fake-key',
    signal,
  };
}

/** A fetch that never answers and ignores its signal entirely. */
function hangingFetch(calls: RequestInit[]): typeof globalThis.fetch {
  return (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    return new Promise<Response>(() => undefined);
  };
}

/** A stream that sends `message_start` (with usage) and one text delta, then
 *  goes silent forever. Its pending read never settles on its own; `released`
 *  records whether the reader cancelled the body (released the connection). */
function stalledStreamFetch(
  calls: RequestInit[],
  released: { cancelled: boolean } = { cancelled: false },
): typeof globalThis.fetch {
  return (_url: unknown, init?: RequestInit) => {
    calls.push(init ?? {});
    const encoder = new TextEncoder();
    const frames = [
      `event: message_start\ndata: ${JSON.stringify({
        type: 'message_start',
        message: {
          usage: {
            input_tokens: 400,
            output_tokens: 1,
            cache_read_input_tokens: 2000,
            cache_creation_input_tokens: 0,
          },
        },
      })}\n\n`,
      `event: content_block_delta\ndata: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '{"kind":"pl' },
      })}\n\n`,
    ];
    return Promise.resolve(
      new Response(
        new ReadableStream<Uint8Array>({
          cancel() {
            released.cancelled = true;
          },
          pull(controller) {
            const next = frames.shift();
            if (next !== undefined) {
              controller.enqueue(encoder.encode(next));
              return;
            }
            return new Promise<void>(() => undefined);
          },
        }),
        { status: 200, headers: { 'content-type': 'text/event-stream' } },
      ),
    );
  };
}

async function abortAfter<T>(
  controller: AbortController,
  pending: Promise<T>,
): Promise<{
  err: unknown;
  ms: number;
}> {
  await new Promise((r) => setTimeout(r, 20));
  const at = performance.now();
  controller.abort();
  const err = await pending.then(
    () => null,
    (e: unknown) => e,
  );
  return { err, ms: performance.now() - at };
}

describe('a Stop ends the Claude call promptly and says what it cost', () => {
  it('⛔ a fetch that hangs AND ignores its signal returns within the bound after abort, as a typed cancellation, and is NOT retried', async () => {
    const calls: RequestInit[] = [];
    const dec = new ClaudeAgentDecomposer({ fetch: hangingFetch(calls), retryBackoffMs: 0 });
    const controller = new AbortController();
    const { err, ms } = await abortAfter(controller, dec.decompose(args(controller.signal)));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(err).toBeInstanceOf(AgentDecomposerCancelledError);
    expect(calls).toHaveLength(1);
    // Nothing had been reported, so nothing is claimed — absent, not zero.
    expect((err as AgentDecomposerCancelledError).observed).toBeUndefined();
    expect((err as AgentDecomposerCancelledError).usage).toBeUndefined();
    expect((err as AgentDecomposerCancelledError).tokensConsumed).toBeUndefined();
    // The transport was told as well: the attempt's own signal is aborted.
    expect(calls[0]?.signal?.aborted).toBe(true);
  });

  it('an abort mid-stream ends the call promptly and reports the input side message_start had already stated', async () => {
    const calls: RequestInit[] = [];
    const dec = new ClaudeAgentDecomposer({ fetch: stalledStreamFetch(calls), retryBackoffMs: 0 });
    const controller = new AbortController();
    const { err, ms } = await abortAfter(controller, dec.decompose(args(controller.signal)));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(err).toBeInstanceOf(AgentDecomposerCancelledError);
    expect(calls).toHaveLength(1);
    const observed = (err as AgentDecomposerCancelledError).observed;
    expect(observed?.usage).toMatchObject({
      decomposerKind: 'claude',
      anthropicInputTokens: 400,
      anthropicCacheReadInputTokens: 2000,
      anthropicPromptTokens: 2400,
      model: 'claude-sonnet-5',
    });
    // 400 uncached + 1 output (a floor) + ceil(2000 × 0.1 read multiplier).
    expect(observed?.tokensConsumed).toBe(601);
    // And at the top level too, where the runtime's stop accounting reads a
    // thrown call's spend (the shape AgentDecomposerSettledError carries).
    const cancelled = err as AgentDecomposerCancelledError;
    expect(cancelled.usage).toBe(observed?.usage);
    expect(cancelled.tokensConsumed).toBe(601);
  });

  it('⛔ P3 "aborts the stream reader": a Stop mid-stream releases the response body, so the connection is not held open behind a finished turn', async () => {
    const calls: RequestInit[] = [];
    const released = { cancelled: false };
    const dec = new ClaudeAgentDecomposer({
      fetch: stalledStreamFetch(calls, released),
      retryBackoffMs: 0,
    });
    const controller = new AbortController();
    const { err } = await abortAfter(controller, dec.decompose(args(controller.signal)));
    expect(err).toBeInstanceOf(AgentDecomposerCancelledError);
    await new Promise((r) => setTimeout(r, 0));
    expect(released.cancelled).toBe(true);
  });

  it('⛔ a Stop that lands WHILE the authority fence is awaited sends no request — the fence is the last await before the fetch, and the listener is attached only after it', async () => {
    const calls: RequestInit[] = [];
    const dec = new ClaudeAgentDecomposer({ fetch: hangingFetch(calls), retryBackoffMs: 0 });
    const controller = new AbortController();
    const err = await dec
      .decompose({
        ...args(controller.signal),
        shouldContinue: async () => {
          controller.abort();
          await new Promise((r) => setTimeout(r, 5));
          return true;
        },
      })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentDecomposerCancelledError);
    expect(calls).toHaveLength(0);
  });

  it('the read-back is cancelled the same way', async () => {
    const calls: RequestInit[] = [];
    const dec = new ClaudeAgentDecomposer({ fetch: stalledStreamFetch(calls), retryBackoffMs: 0 });
    const controller = new AbortController();
    const { err, ms } = await abortAfter(
      controller,
      dec.answerFromObservation({
        task: 'what is on the page?',
        observation: 'hello',
        budgetTokensRemaining: 1000,
        byokAnthropicApiKey: 'sk-ant-test-fake-key',
        signal: controller.signal,
      }),
    );
    expect(ms).toBeLessThan(BOUND_MS);
    expect(err).toBeInstanceOf(AgentDecomposerCancelledError);
  });

  it('an already-aborted signal makes no request at all', async () => {
    const calls: RequestInit[] = [];
    const dec = new ClaudeAgentDecomposer({ fetch: hangingFetch(calls) });
    const controller = new AbortController();
    controller.abort();
    await expect(dec.decompose(args(controller.signal))).rejects.toBeInstanceOf(
      AgentDecomposerCancelledError,
    );
    expect(calls).toHaveLength(0);
  });

  it('a Stop during the retry backoff ends the call without the second attempt', async () => {
    const calls: RequestInit[] = [];
    let n = 0;
    const fetch = ((_u: unknown, init?: RequestInit) => {
      calls.push(init ?? {});
      n += 1;
      return Promise.resolve(new Response('overloaded', { status: n === 1 ? 529 : 200 }));
    }) as typeof globalThis.fetch;
    const dec = new ClaudeAgentDecomposer({ fetch, retryBackoffMs: 10_000 });
    const controller = new AbortController();
    const { err, ms } = await abortAfter(controller, dec.decompose(args(controller.signal)));
    expect(ms).toBeLessThan(BOUND_MS);
    expect(err).toBeInstanceOf(AgentDecomposerCancelledError);
    expect(calls).toHaveLength(1);
  });
});
