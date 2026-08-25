import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}

const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAdminInternalNote } = await import('../../src/lib/use-admin-internal-note');

const ORDER = { order_id: 'ord/x', internal_note: 'Investigating' };

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

describe('useAdminInternalNote', () => {
  it('PATCHes the encoded order path with auth and the exact nullable JSON field', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(ORDER),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminInternalNote());

    await act(async () => result.current.save('ord/x', null));

    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/admin/crypto-orders/ord%2Fx/internal-note',
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.method).toBe('PATCH');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk_admin');
    expect(init?.body).toBe(JSON.stringify({ internal_note: null }));
    expect(result.current.state).toEqual({ kind: 'succeeded', orderId: 'ord/x', order: ORDER });
  });

  it('single-flights overlapping saves', async () => {
    let resolveFetch: ((value: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminInternalNote());

    let first: Promise<void> | undefined;
    await act(async () => {
      first = result.current.save('ord_1', 'First');
      await result.current.save('ord_1', 'Second');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.({
      ok: true,
      status: 200,
      json: () => Promise.resolve(ORDER),
    } as unknown as Response);
    await act(async () => first);
    expect(result.current.state.kind).toBe('succeeded');
  });

  it('preserves HTTP status with fixed API error copy', async () => {
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
    const { result } = renderHook(() => useAdminInternalNote());
    await act(async () => result.current.save('ord_1', 'No access'));
    expect(result.current.state).toEqual({
      kind: 'failed',
      orderId: 'ord_1',
      status: 403,
      message: 'You do not have permission to perform this action.',
    });
  });

  it('fails with actionable copy after the shared 15 second deadline', async () => {
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
    const { result } = renderHook(() => useAdminInternalNote());

    await act(async () => {
      const pending = result.current.save('ord_1', 'Investigating');
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
    });

    expect(result.current.state).toEqual({
      kind: 'failed',
      orderId: 'ord_1',
      status: 0,
      message: 'Saving the internal note timed out. Check your connection and try again.',
    });
  });

  it('reset aborts and invalidates an active save', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('late abort')));
        });
      }),
    );
    const { result } = renderHook(() => useAdminInternalNote());

    await act(async () => {
      void result.current.save('ord_1', 'Investigating');
      result.current.reset();
      await Promise.resolve();
    });

    expect(signal?.aborted).toBe(true);
    expect(result.current.state).toEqual({ kind: 'idle' });
  });
});
