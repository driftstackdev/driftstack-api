// V-534.W — unit tests for useCryptoOrdersList.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CryptoOrdersListData } from '../../src/lib/use-crypto-orders-list';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCryptoOrdersList } = await import('../../src/lib/use-crypto-orders-list');

const SAMPLE: CryptoOrdersListData = {
  orders: [
    {
      order_id: 'ord_1',
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'EUR',
      payment_id: null,
      status: 'pending',
      created_at: '2026-05-11T10:00:00.000Z',
      updated_at: '2026-05-11T10:00:00.000Z',
    },
    {
      order_id: 'ord_2',
      product: 'team_manual',
      price_cents: 8000,
      price_currency: 'EUR',
      payment_id: 'np_42',
      status: 'paid',
      created_at: '2026-05-10T09:00:00.000Z',
      updated_at: '2026-05-10T10:00:00.000Z',
    },
  ],
};

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.W useCryptoOrdersList — auto-fetch', () => {
  it('transitions loading → ready with the orders array', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrdersList());
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.orders).toHaveLength(2);
      expect(result.current.state.data.orders[0]?.order_id).toBe('ord_1');
    }
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits ?limit when not specified', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCryptoOrdersList());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/billing/crypto-orders',
    );
  });

  it('passes ?limit when specified', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCryptoOrdersList({ limit: 10 }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/billing/crypto-orders?limit=10',
    );
  });
});

describe('V-534.W useCryptoOrdersList — error paths', () => {
  it('errors when no API key configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const { result } = renderHook(() => useCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
  });

  it('surfaces HTTP error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe(
        'The service is temporarily unavailable. Try again shortly.',
      );
    }
  });
});

describe('V-534.W useCryptoOrdersList — manual mode', () => {
  it('manual=true starts idle and does not auto-fetch', () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrdersList({ manual: true }));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetch() advances from idle → ready', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrdersList({ manual: true }));
    await result.current.refetch();
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps problem+json diagnostics to fixed input guidance on 400', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: false,
        status: 400,
        json: () =>
          Promise.resolve({
            title: 'Bad Request',
            detail: 'created_before must be strictly greater than created_after.',
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe(
        'The request could not be completed. Check your input and try again.',
      );
      expect(result.current.state.message).not.toContain('created_before');
    }
  });

  it('single-flights overlapping manual refreshes', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrdersList({ manual: true }));
    let first: Promise<void> | undefined;
    await act(async () => {
      first = result.current.refetch();
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    resolveFetch?.({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ orders: [], next_cursor: null }),
    } as unknown as Response);
    await act(async () => first);
  });

  it('bounds a stalled first page with actionable feedback', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }),
    );
    const { result } = renderHook(() => useCryptoOrdersList({ manual: true }));
    await act(async () => {
      const pending = result.current.refetch();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
    });
    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Order history timed out. Check your connection and try again.',
    });
  });

  it('aborts the old first page when filters change', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.signal !== undefined) signals.push(init.signal);
        return new Promise<Response>(() => undefined);
      }),
    );
    const { rerender } = renderHook(({ status }) => useCryptoOrdersList({ status }), {
      initialProps: { status: 'pending' as const },
    });
    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ status: 'paid' });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });

  it('single-flights synchronous loadMore calls for the same cursor', async () => {
    let resolvePage: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('cursor=NEXT')) {
        return new Promise<Response>((resolve) => {
          resolvePage = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: SAMPLE.orders.slice(0, 1), next_cursor: 'NEXT' }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    let first: Promise<void> | undefined;
    await act(async () => {
      first = result.current.loadMore();
      await result.current.loadMore();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    resolvePage?.({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ orders: SAMPLE.orders.slice(1), next_cursor: null }),
    } as unknown as Response);
    await act(async () => first);
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.orders.map((order) => order.order_id)).toEqual([
        'ord_1',
        'ord_2',
      ]);
    }
  });
});
