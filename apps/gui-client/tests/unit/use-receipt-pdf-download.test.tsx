// V-534.BM — unit tests for useReceiptPdfDownload.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useReceiptPdfDownload } = await import('../../src/lib/use-receipt-pdf-download');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
  HTMLAnchorElement.prototype.click = vi.fn();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function pdfResponse(): Response {
  return {
    ok: true,
    status: 200,
    blob: () => Promise.resolve(new Blob(['%PDF-1.7'], { type: 'application/pdf' })),
  } as unknown as Response;
}

describe('V-534.BM useReceiptPdfDownload', () => {
  it('single-flights overlapping receipt downloads', () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Intentionally pending until reset aborts the caller signal.
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useReceiptPdfDownload());
    act(() => {
      void result.current.download('ord_x');
      void result.current.download('ord_x', 'txt');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => result.current.reset());
  });

  it('bounds a stalled download with actionable recovery', async () => {
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
    const { result } = renderHook(() => useReceiptPdfDownload());
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.download('ord_x');
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => pending);
    expect(result.current.state).toEqual({
      kind: 'failed',
      format: 'pdf',
      message: 'Receipt download timed out. Check your connection and try again.',
    });
  });

  it('always removes the anchor and revokes the object URL when click throws', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(pdfResponse())),
    );
    URL.createObjectURL = vi.fn(() => 'blob:cleanup');
    const revokeObjectUrl = vi.fn();
    URL.revokeObjectURL = revokeObjectUrl;
    HTMLAnchorElement.prototype.click = vi.fn(() => {
      throw new Error('click blocked');
    });
    const { result } = renderHook(() => useReceiptPdfDownload());
    await act(async () => result.current.download('ord_x'));
    expect(document.querySelector('a[href="blob:cleanup"]')).toBeNull();
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:cleanup');
    expect(result.current.state.kind).toBe('failed');
  });

  it('starts idle and does not fetch on mount', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useReceiptPdfDownload());
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('hits /receipt.pdf with Bearer auth + accept: application/pdf', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(pdfResponse()));
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useReceiptPdfDownload());
    await act(async () => {
      await result.current.download('ord_abc');
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/billing/crypto-orders/ord_abc/receipt.pdf');
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk_test');
    expect((init.headers as Record<string, string>).accept).toBe('application/pdf');
    expect(init.signal).toBeTruthy();
    expect(result.current.state.kind).toBe('idle');
  });

  it('hits /receipt.txt with accept: text/plain when format=txt', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(pdfResponse()));
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useReceiptPdfDownload());
    await act(async () => {
      await result.current.download('ord_abc', 'txt');
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/v1/billing/crypto-orders/ord_abc/receipt.txt');
    expect((init.headers as Record<string, string>).accept).toBe('text/plain');
  });

  it('encodes special characters in the order id', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(pdfResponse()));
    vi.stubGlobal('fetch', fetchMock);
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useReceiptPdfDownload());
    await act(async () => {
      await result.current.download('ord/weird?id');
    });
    const url = fetchMock.mock.calls[0]?.[0] as string;
    expect(url).toContain('ord%2Fweird%3Fid');
  });

  it('reports HTTP errors via state.kind = failed', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          blob: () => Promise.resolve(new Blob()),
        } as unknown as Response),
      ),
    );
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useReceiptPdfDownload());
    await act(async () => {
      await result.current.download('ord_x', 'txt');
    });
    expect(result.current.state.kind).toBe('failed');
    expect(result.current.state).toMatchObject({ format: 'txt' });
  });

  it('names the active format while a download is in flight', async () => {
    let resolveFetch: ((response: Response) => void) | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            resolveFetch = resolve;
          }),
      ),
    );
    URL.createObjectURL = vi.fn(() => 'blob:mock');
    URL.revokeObjectURL = vi.fn();
    const { result } = renderHook(() => useReceiptPdfDownload());
    let pending: Promise<void> | undefined;
    act(() => {
      pending = result.current.download('ord_x', 'txt');
    });
    expect(result.current.state).toEqual({ kind: 'downloading', format: 'txt' });
    resolveFetch?.(pdfResponse());
    await act(async () => pending);
  });

  it('reset() returns state to idle after a failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('net'))),
    );
    const { result } = renderHook(() => useReceiptPdfDownload());
    await act(async () => {
      await result.current.download('ord_x');
    });
    expect(result.current.state.kind).toBe('failed');
    act(() => {
      result.current.reset();
    });
    await waitFor(() => expect(result.current.state.kind).toBe('idle'));
  });

  it('refuses to download when no API key is configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useReceiptPdfDownload());
    await act(async () => {
      await result.current.download('ord_x');
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('failed');
  });
});
