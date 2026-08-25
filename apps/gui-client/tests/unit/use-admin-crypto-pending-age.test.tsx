import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { AdminPendingAgeData } from '../../src/lib/use-admin-crypto-pending-age';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}

const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAdminCryptoPendingAge } = await import('../../src/lib/use-admin-crypto-pending-age');

const SAMPLE: AdminPendingAgeData = {
  buckets: { under_1h: 3, h1_to_6h: 2, h6_to_24h: 1, over_24h: 4 },
  pending_value_cents: { EUR: 18_500 },
  total: 10,
  truncated: false,
  scanned: 10,
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

describe('useAdminCryptoPendingAge', () => {
  it('auto-fetches the pending-age endpoint with bearer auth', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);

    const { result } = renderHook(() => useAdminCryptoPendingAge());
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/admin/crypto-orders/pending-age',
    );
    const init = fetchMock.mock.calls[0]?.[1];
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk_admin');
    expect(init?.signal).toBeInstanceOf(AbortSignal);
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
    const { result } = renderHook(() => useAdminCryptoPendingAge({ manual: true }));

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
    const { result } = renderHook(() => useAdminCryptoPendingAge({ manual: true }));

    await act(async () => {
      const pending = result.current.refetch();
      await vi.advanceTimersByTimeAsync(15_000);
      await pending;
    });

    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Pending-age metrics timed out. Check your connection and try again.',
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
    const { unmount } = renderHook(() => useAdminCryptoPendingAge());
    expect(signal).toBeInstanceOf(AbortSignal);
    unmount();
    expect(signal?.aborted).toBe(true);
  });
});
