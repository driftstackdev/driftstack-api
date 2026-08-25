// V-534.Y — unit tests for useCancelOrder.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCancelOrder } = await import('../../src/lib/use-cancel-order');

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

describe('V-534.Y useCancelOrder — starting state', () => {
  it('starts idle and does not fetch on mount', () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCancelOrder());
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('V-534.Y useCancelOrder — happy path', () => {
  it('transitions submitting → succeeded with the returned order', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            order_id: 'ord_x',
            product: 'solo_manual',
            price_cents: 2500,
            price_currency: 'EUR',
            payment_id: null,
            status: 'cancelled',
            created_at: '2026-05-11T10:00:00.000Z',
            updated_at: '2026-05-11T10:05:00.000Z',
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCancelOrder());
    await act(async () => {
      await result.current.cancel('ord_x');
    });
    await waitFor(() => expect(result.current.state.kind).toBe('succeeded'));
    if (result.current.state.kind === 'succeeded') {
      expect(result.current.state.order.order_id).toBe('ord_x');
      expect(result.current.state.order.status).toBe('cancelled');
    }
  });

  it('POSTs to /v1/billing/crypto-orders/:id/cancel with bearer auth', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ order_id: 'ord_x', status: 'cancelled' }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCancelOrder());
    await act(async () => {
      await result.current.cancel('ord_x');
    });
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/billing/crypto-orders/ord_x/cancel',
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk_test');
    expect(init?.signal).toBeTruthy();
  });
});

describe('V-534.Y useCancelOrder — error paths', () => {
  it('single-flights duplicate cancellation and resets cleanly after a stalled request', () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Intentionally pending until reset aborts the caller signal.
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCancelOrder());
    act(() => {
      void result.current.cancel('ord_x');
      void result.current.cancel('ord_x');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => result.current.reset());
    expect(result.current.state.kind).toBe('idle');
  });

  it('bounds a stalled cancellation and restores an actionable failure', async () => {
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
    const { result } = renderHook(() => useCancelOrder());
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.cancel('ord_x');
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => pending);
    expect(result.current.state).toEqual({
      kind: 'failed',
      orderId: 'ord_x',
      status: 0,
      message: 'Cancellation timed out. Check your connection and try again.',
    });
  });

  it('failed with status=0 when no API key is configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const { result } = renderHook(() => useCancelOrder());
    await act(async () => {
      await result.current.cancel('ord_x');
    });
    expect(result.current.state.kind).toBe('failed');
    if (result.current.state.kind === 'failed') {
      expect(result.current.state.status).toBe(0);
    }
  });

  it('maps a 409 to fixed conflict guidance without reflecting server detail', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 409,
          json: () =>
            Promise.resolve({
              detail: 'Order is in state "confirming" and can no longer be cancelled.',
            }),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCancelOrder());
    await act(async () => {
      await result.current.cancel('ord_x');
    });
    if (result.current.state.kind === 'failed') {
      expect(result.current.state.status).toBe(409);
      expect(result.current.state.message).toBe(
        'The item changed or is busy. Refresh and try again.',
      );
    }
  });

  it('maps a non-JSON server failure to fixed service guidance', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.reject(new Error('not json')),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCancelOrder());
    await act(async () => {
      await result.current.cancel('ord_x');
    });
    if (result.current.state.kind === 'failed') {
      expect(result.current.state.status).toBe(500);
      expect(result.current.state.message).toBe(
        'The service is temporarily unavailable. Try again shortly.',
      );
    }
  });
});

describe('V-534.Y useCancelOrder — reset', () => {
  it('returns the hook to idle after a succeeded run', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ order_id: 'ord_x', status: 'cancelled' }),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCancelOrder());
    await act(async () => {
      await result.current.cancel('ord_x');
    });
    expect(result.current.state.kind).toBe('succeeded');
    act(() => {
      result.current.reset();
    });
    expect(result.current.state.kind).toBe('idle');
  });
});
