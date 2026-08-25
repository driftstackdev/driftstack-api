// V-534.BA — unit tests for useAdminIdempotencyMetrics.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAdminIdempotencyMetrics } = await import('../../src/lib/use-admin-idempotency-metrics');

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

describe('V-534.BA useAdminIdempotencyMetrics', () => {
  it('fetches the metrics endpoint on mount and reports ready', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ replays: 4, first_writes: 12 }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminIdempotencyMetrics());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data).toEqual({ replays: 4, first_writes: 12 });
    }
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('/v1/admin/crypto-orders/idempotency-metrics');
    const init = fetchMock.mock.calls[0]?.[1];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('reports HTTP errors via state.kind = error', async () => {
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
    const { result } = renderHook(() => useAdminIdempotencyMetrics());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe(
        'You do not have permission to perform this action.',
      );
    }
  });

  it('refetch() re-fires the request', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ replays: 0, first_writes: 0 }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminIdempotencyMetrics());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not fetch when manual:true; refetch triggers it', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ replays: 0, first_writes: 0 }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminIdempotencyMetrics({ manual: true }));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports a missing API key as error', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    vi.stubGlobal('fetch', vi.fn());
    const { result } = renderHook(() => useAdminIdempotencyMetrics());
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
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
    const { result } = renderHook(() => useAdminIdempotencyMetrics({ manual: true }));

    let first: Promise<void> | undefined;
    await act(async () => {
      first = result.current.refetch();
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ replays: 1, first_writes: 2, body_mismatches: 0 }),
    } as unknown as Response);
    await act(async () => first);
    expect(result.current.state.kind).toBe('ready');
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
    const { result } = renderHook(() => useAdminIdempotencyMetrics({ manual: true }));

    await act(async () => {
      const pending = result.current.refetch();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
    });

    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Idempotency metrics timed out. Check your connection and try again.',
    });
  });

  it('aborts the active request on unmount', () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const { unmount } = renderHook(() => useAdminIdempotencyMetrics());
    expect(signal).toBeInstanceOf(AbortSignal);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
