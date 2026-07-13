import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fetchWithDeadline } from '../../src/lib/fetch-with-deadline';

function responseThatStallsUntilAbort(signal: AbortSignal): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        const fail = (): void => controller.error(signal.reason);
        if (signal.aborted) fail();
        else signal.addEventListener('abort', fail, { once: true });
      },
    }),
  );
}

describe('fetchWithDeadline', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('keeps the deadline active after headers and aborts a stalled body', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
      Promise.resolve(responseThatStallsUntilAbort(init?.signal as AbortSignal)),
    );

    const response = await fetchWithDeadline('https://api.example.test/data', {}, 1_000);
    const body = response.text();
    const bodyAssertion = expect(body).rejects.toMatchObject({ name: 'AbortError' });

    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(1_000);

    await bodyAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('forwards caller aborts that happen after headers', async () => {
    const caller = new AbortController();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
      Promise.resolve(responseThatStallsUntilAbort(init?.signal as AbortSignal)),
    );

    const response = await fetchWithDeadline(
      'https://api.example.test/data',
      { signal: caller.signal },
      1_000,
    );
    const body = response.text();
    const bodyAssertion = expect(body).rejects.toMatchObject({ name: 'AbortError' });
    caller.abort();

    await bodyAssertion;
    expect(vi.getTimerCount()).toBe(0);
  });

  it('cleans the deadline when fetch fails before headers', async () => {
    const failure = new TypeError('network failure');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(failure);

    await expect(fetchWithDeadline('https://api.example.test/data', {}, 1_000)).rejects.toBe(
      failure,
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps the timer armed after a successful headers-only resolution', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));

    await expect(
      fetchWithDeadline('https://api.example.test/data', {}, 1_000),
    ).resolves.toBeInstanceOf(Response);
    expect(vi.getTimerCount()).toBe(1);

    await vi.advanceTimersByTimeAsync(1_000);
    expect(vi.getTimerCount()).toBe(0);
  });
});
