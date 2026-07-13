// V-534.T — unit tests for useCryptoOrder.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CryptoOrderData } from '../../src/lib/use-crypto-order';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCryptoOrder } = await import('../../src/lib/use-crypto-order');

function sample(overrides: Partial<CryptoOrderData> = {}): CryptoOrderData {
  return {
    order_id: 'ord_abc',
    product: 'trial_pack',
    price_cents: 299,
    price_currency: 'USD',
    payment_id: null,
    status: 'pending',
    created_at: '2026-05-11T10:00:00.000Z',
    updated_at: '2026-05-11T10:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('V-534.T useCryptoOrder — initial fetch', () => {
  it('transitions loading → ready on first fetch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(sample()),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoOrder('ord_abc', { pollIntervalMs: 0 }));
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.order_id).toBe('ord_abc');
      expect(result.current.state.data.status).toBe('pending');
    }
  });

  it('hits /v1/billing/crypto-orders/:id with the bearer header', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sample()),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCryptoOrder('ord_abc', { pollIntervalMs: 0 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/billing/crypto-orders/ord_abc',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer sk_test');
    expect(init?.signal).toBeTruthy();
  });

  it('idle when orderId is null and does not fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrder(null, { pollIntervalMs: 0 }));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('V-534.T useCryptoOrder — error paths', () => {
  it('bounds a stalled manual order read with an actionable error', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      ),
    );
    const { result } = renderHook(() =>
      useCryptoOrder('ord_abc', { manual: true, pollIntervalMs: 0 }),
    );
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refetch();
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => pending);
    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Order status timed out. Check your connection and try again.',
    });
  });

  it('errors when no API key configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const { result } = renderHook(() => useCryptoOrder('ord_abc', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
  });

  it('surfaces HTTP error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoOrder('ord_abc', { pollIntervalMs: 0 }));
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('HTTP 404');
    }
  });
});

describe('V-534.T useCryptoOrder — polling', () => {
  it('keeps stalled polling single-flight and aborts it when the order changes', async () => {
    let firstSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            firstSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sample({ order_id: 'ord_new' })), { status: 200 }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ orderId }) => useCryptoOrder(orderId, { pollIntervalMs: 5 }),
      { initialProps: { orderId: 'ord_old' } },
    );
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ orderId: 'ord_new' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(firstSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.order_id).toBe('ord_new');
    }
  });

  it('polls until terminal status is reached', async () => {
    vi.useFakeTimers();
    const responses = [
      sample({ status: 'pending' }),
      sample({ status: 'confirming' }),
      sample({ status: 'paid' }),
      sample({ status: 'paid' }), // this one should never be requested
    ];
    let call = 0;
    const fetchMock = vi.fn(() => {
      const body = responses[Math.min(call, responses.length - 1)];
      call += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useCryptoOrder('ord_abc', { pollIntervalMs: 1_000 }));
    // initial fetch
    await vi.waitFor(() => {
      if (result.current.state.kind !== 'ready') throw new Error('not ready');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // Status is now 'paid' — further ticks should NOT fire.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('manual mode starts idle + does not auto-poll', () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useCryptoOrder('ord_abc', { manual: true, pollIntervalMs: 1_000 }),
    );
    expect(result.current.state.kind).toBe('idle');
    vi.advanceTimersByTime(10_000);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
