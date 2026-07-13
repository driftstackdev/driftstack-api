import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AdminDailyData } from '../../src/lib/use-admin-crypto-daily';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}

const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAdminCryptoDaily } = await import('../../src/lib/use-admin-crypto-daily');

const SAMPLE: AdminDailyData = {
  days: 30,
  rows: [{ date: '2026-07-12', status: 'paid', count: 7 }],
  truncated: false,
};

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

describe('useAdminCryptoDaily', () => {
  it('auto-fetches the requested lookback with bearer auth', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAdminCryptoDaily({ days: 30 }));
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/admin/crypto-orders/daily?days=30',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk_admin');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('omits the days query when the server default is requested', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useAdminCryptoDaily());
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/admin/crypto-orders/daily',
    );
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
    const { result } = renderHook(() => useAdminCryptoDaily({ manual: true }));

    let first: Promise<void> | undefined;
    await act(async () => {
      first = result.current.refetch();
      await result.current.refetch();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolveFetch?.({
      ok: true,
      status: 200,
      json: () => Promise.resolve(SAMPLE),
    } as unknown as Response);
    await act(async () => first);
    expect(result.current.state).toEqual({ kind: 'ready', data: SAMPLE });
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
    const { result } = renderHook(() => useAdminCryptoDaily({ manual: true }));

    await act(async () => {
      const pending = result.current.refetch();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
    });

    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Daily trends timed out. Check your connection and try again.',
    });
  });

  it('aborts the active request when the lookback changes', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init?: RequestInit) => {
        if (init?.signal !== undefined) signals.push(init.signal);
        return new Promise<Response>(() => undefined);
      }),
    );
    const { rerender } = renderHook(({ days }) => useAdminCryptoDaily({ days }), {
      initialProps: { days: 7 },
    });
    await waitFor(() => expect(signals).toHaveLength(1));
    rerender({ days: 30 });
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[1]?.aborted).toBe(false);
  });
});
