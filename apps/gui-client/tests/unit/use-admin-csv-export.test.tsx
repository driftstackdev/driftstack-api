// V-534.AX — unit tests for useAdminCsvExport.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useAdminCsvExport } = await import('../../src/lib/use-admin-csv-export');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_admin', baseUrl: 'https://api.driftstack.dev' },
  });
  // jsdom tries to navigate when an anchor with a blob: href is clicked;
  // silence that by default. Tests that assert on the click override this.
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function csvResponse(body: string): Response {
  return {
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob([body], { type: 'text/csv' })),
  } as unknown as Response;
}

describe('V-534.AX useAdminCsvExport', () => {
  it('starts in idle state and does not fetch on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCsvExport());
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sends Bearer auth + accept: text/csv to the .csv endpoint on download()', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(csvResponse('order_id\n')));
    vi.stubGlobal('fetch', fetchMock);
    // jsdom provides URL.createObjectURL/revokeObjectURL as undefined; stub them
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useAdminCsvExport());
    await act(async () => {
      await result.current.download();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/admin/crypto-orders.csv');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_admin');
    expect((init.headers as Record<string, string>).accept).toBe('text/csv');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(result.current.state.kind).toBe('idle');
  });

  it('appends status + search + accountId to the URL', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(csvResponse('order_id\n')));
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() =>
      useAdminCsvExport({ status: 'paid', search: ' PO-9 ', accountId: 'acc_x' }),
    );
    await act(async () => {
      await result.current.download();
    });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('status=paid');
    expect(url).toContain('search=PO-9');
    expect(url).toContain('account_id=acc_x');
  });

  it('does not append status when null + omits empty search', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(csvResponse('order_id\n')));
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() =>
      useAdminCsvExport({ status: null, search: '   ', accountId: null }),
    );
    await act(async () => {
      await result.current.download();
    });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).not.toContain('status=');
    expect(url).not.toContain('search=');
    expect(url).not.toContain('account_id=');
  });

  it('mints a blob URL, clicks a synthesized anchor with a .csv filename, then revokes', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(csvResponse('order_id\nord_1\n')));
    vi.stubGlobal('fetch', fetchMock);
    const createObjectUrl = vi.fn(() => 'blob:mock-object-url');
    const revokeObjectUrl = vi.fn();
    URL.createObjectURL = createObjectUrl;
    URL.revokeObjectURL = revokeObjectUrl;

    const anchorClick = vi.fn();
    const origCreateElement = document.createElement.bind(document);
    vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
      const el = origCreateElement(tag);
      if (tag === 'a') {
        el.click = anchorClick;
      }
      return el;
    });

    const { result } = renderHook(() => useAdminCsvExport());
    await act(async () => {
      await result.current.download();
    });

    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(anchorClick).toHaveBeenCalledTimes(1);
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:mock-object-url');
  });

  it('single-flights overlapping exports', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>(() => {
            // Intentionally pending until reset aborts the caller signal.
          }),
      ),
    );
    const { result } = renderHook(() => useAdminCsvExport());
    act(() => {
      void result.current.download();
      void result.current.download();
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    act(() => result.current.reset());
  });

  it('bounds a stalled export with actionable recovery', async () => {
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
    const { result } = renderHook(() => useAdminCsvExport());
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.download();
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => pending);
    expect(result.current.state).toEqual({
      kind: 'failed',
      message: 'CSV export timed out. Check your connection and try again.',
    });
  });

  it('always removes the anchor and revokes the object URL when click throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(csvResponse('order_id\n'))),
    );
    URL.createObjectURL = vi.fn(() => 'blob:cleanup');
    const revokeObjectUrl = vi.fn();
    URL.revokeObjectURL = revokeObjectUrl;
    HTMLAnchorElement.prototype.click = vi.fn(() => {
      throw new Error('click blocked');
    });
    const { result } = renderHook(() => useAdminCsvExport());
    await act(async () => result.current.download());
    expect(document.querySelector('a[href="blob:cleanup"]')).toBeNull();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:cleanup');
    expect(result.current.state).toEqual({
      kind: 'failed',
      message: "Couldn't export the CSV. Try again.",
    });
  });

  it('reset aborts and invalidates an active export', () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn((_input: RequestInfo | URL, init?: RequestInit) => {
        signal = init?.signal ?? undefined;
        return new Promise<Response>(() => undefined);
      }),
    );
    const { result } = renderHook(() => useAdminCsvExport());
    act(() => void result.current.download());
    expect(signal?.aborted).toBe(false);
    act(() => result.current.reset());
    expect(signal?.aborted).toBe(true);
    expect(result.current.state).toEqual({ kind: 'idle' });
  });

  it('reports HTTP errors via state.kind = failed', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: false,
        status: 403,
        blob: () => Promise.resolve(new Blob()),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useAdminCsvExport());
    await act(async () => {
      await result.current.download();
    });
    expect(result.current.state.kind).toBe('failed');
    if (result.current.state.kind === 'failed') {
      expect(result.current.state.message).toBe(
        'You do not have permission to perform this action.',
      );
    }
  });

  it('reports network errors via state.kind = failed', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('boom')));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCsvExport());
    await act(async () => {
      await result.current.download();
    });
    expect(result.current.state.kind).toBe('failed');
    if (result.current.state.kind === 'failed') {
      expect(result.current.state.message).toBe("Couldn't export the CSV. Try again.");
    }
  });

  it('reports an honest failure when the response cannot be saved', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(csvResponse('order_id\n'))),
    );
    (URL as unknown as { createObjectURL?: unknown }).createObjectURL = undefined;
    const { result } = renderHook(() => useAdminCsvExport());
    await act(async () => result.current.download());
    expect(result.current.state).toEqual({
      kind: 'failed',
      message: 'The CSV export could not be saved. Check Downloads access and try again.',
    });
  });

  it('refuses to download when no API key is configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCsvExport());
    await act(async () => {
      await result.current.download();
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('failed');
  });

  it('reset() returns state to idle after a failure', async () => {
    const fetchMock = vi.fn(() => Promise.reject(new Error('net')));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useAdminCsvExport());
    await act(async () => {
      await result.current.download();
    });
    expect(result.current.state.kind).toBe('failed');
    act(() => {
      result.current.reset();
    });
    await waitFor(() => {
      expect(result.current.state.kind).toBe('idle');
    });
  });
});
