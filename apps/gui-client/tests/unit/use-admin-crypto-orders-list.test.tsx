// V-534.AG — unit tests for useAdminCryptoOrdersList.
// V-534.AW — extended for V-666.AM cursor pagination + loadMore.
// V-534.BC — extended for V-666.AS payment_id filter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAdminCryptoOrdersList } = await import('../../src/lib/use-admin-crypto-orders-list');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_admin', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.AG useAdminCryptoOrdersList', () => {
  it('fetches /v1/admin/crypto-orders on mount + sets ready state', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => {
      expect(result.current.state.kind).toBe('ready');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/v1/admin/crypto-orders');
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('appends status + search + accountId + limit to the URL', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() =>
      useAdminCryptoOrdersList({
        status: 'paid',
        search: 'PO-9',
        accountId: 'acc_x',
        limit: 100,
      }),
    );
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('status=paid');
    expect(url).toContain('search=PO-9');
    expect(url).toContain('account_id=acc_x');
    expect(url).toContain('limit=100');
  });

  it('V-534.BC appends paymentId to the URL when supplied', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAdminCryptoOrdersList({ paymentId: 'np_abc' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('payment_id=np_abc');
  });

  it('V-534.BC omits paymentId when null / empty / whitespace', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAdminCryptoOrdersList({ paymentId: '   ' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('payment_id=');
  });

  it('trims and omits empty-string search / accountId', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAdminCryptoOrdersList({ search: '   ', accountId: '' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('search=');
    expect(url).not.toContain('account_id=');
  });

  it('maps HTTP error to error state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => {
      expect(result.current.state.kind).toBe('error');
    });
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('HTTP 403');
    }
  });

  it('refetch re-runs the request', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('fails with actionable copy after the shared 15 second refresh deadline', async () => {
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
    const { result } = renderHook(() => useAdminCryptoOrdersList({ manual: true }));

    await act(async () => {
      const pending = result.current.refetch();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
    });

    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Order list timed out. Check your connection and try again.',
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
    const { rerender } = renderHook(({ search }) => useAdminCryptoOrdersList({ search }), {
      initialProps: { search: 'first' },
    });
    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ search: 'second' });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});

describe('V-534.AW useAdminCryptoOrdersList — cursor pagination', () => {
  it('exposes next_cursor on the ready state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [{ order_id: 'a' }],
              next_cursor: 'CURSOR_TOKEN',
            }),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind !== 'ready') return;
    expect(result.current.state.data.nextCursor).toBe('CURSOR_TOKEN');
  });

  it('loadMore appends the next page + sends the cursor on the URL', async () => {
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('cursor=CURSOR_TOKEN')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [{ order_id: 'b' }, { order_id: 'c' }],
              next_cursor: null,
            }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [{ order_id: 'a' }],
            next_cursor: 'CURSOR_TOKEN',
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(result.current.state.kind).toBe('ready');
    if (result.current.state.kind !== 'ready') return;
    expect(result.current.state.data.orders.map((o) => o.order_id)).toEqual(['a', 'b', 'c']);
    expect(result.current.state.data.nextCursor).toBeNull();
  });

  it('loadMore is a no-op when next_cursor is null', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [{ order_id: 'a' }], next_cursor: null }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    await act(async () => {
      await result.current.loadMore();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('single-flights synchronous loadMore calls for the same cursor', async () => {
    let resolvePage: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.includes('cursor=CURSOR_TOKEN')) {
        return new Promise<Response>((resolve) => {
          resolvePage = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [{ order_id: 'a' }], next_cursor: 'CURSOR_TOKEN' }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCryptoOrdersList());
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
      json: () => Promise.resolve({ orders: [{ order_id: 'b' }], next_cursor: null }),
    } as unknown as Response);
    await act(async () => first);
    if (result.current.state.kind !== 'ready') return;
    expect(result.current.state.data.orders.map((order) => order.order_id)).toEqual(['a', 'b']);
  });

  it('bounds a stalled cursor page and surfaces actionable feedback', async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.includes('cursor=CURSOR_TOKEN')) {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('Aborted', 'AbortError'));
          });
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [{ order_id: 'a' }], next_cursor: 'CURSOR_TOKEN' }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCryptoOrdersList());
    await act(async () => Promise.resolve());
    expect(result.current.state.kind).toBe('ready');

    await act(async () => {
      const pending = result.current.loadMore();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
    });

    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'More orders timed out. Check your connection and try again.',
    });
  });
});
