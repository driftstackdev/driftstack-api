// V-534.V — unit tests for useCryptoQuote.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CryptoQuoteData } from '../../src/lib/use-crypto-quote';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCryptoQuote } = await import('../../src/lib/use-crypto-quote');

function sample(overrides: Partial<CryptoQuoteData> = {}): CryptoQuoteData {
  return {
    product: 'solo_manual',
    price_cents: 2500,
    price_currency: 'EUR',
    provider: 'stub',
    pay_currency: null,
    pay_min_amount: null,
    pay_max_amount: null,
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

describe('V-534.V useCryptoQuote — auto-fetch', () => {
  it('transitions loading → ready on mount', async () => {
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
    const { result } = renderHook(() => useCryptoQuote({ product: 'solo_manual' }));
    expect(result.current.state.kind).toBe('loading');
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.price_cents).toBe(2500);
    }
  });

  it('POSTs the product + priceCurrency body with bearer auth', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sample({ price_currency: 'USD' })),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    renderHook(() => useCryptoQuote({ product: 'team_manual', priceCurrency: 'USD' }));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://api.driftstack.dev/v1/billing/crypto-checkout/quote',
    );
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe('POST');
    expect(init?.signal).toBeTruthy();
    const headers = init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer sk_test');
    expect(JSON.parse(init?.body as string)).toEqual({
      product: 'team_manual',
      price_currency: 'USD',
    });
  });

  it('idle when product is null and does not fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoQuote({ product: null }));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('V-534.V useCryptoQuote — error paths', () => {
  it('bounds a stalled manual quote with an actionable error', async () => {
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
    const { result } = renderHook(() => useCryptoQuote({ product: 'solo_manual', manual: true }));
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.refetch();
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => pending);
    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Quote request timed out. Check your connection and try again.',
    });
  });

  it('errors when no API key configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.dev' },
    });
    const { result } = renderHook(() => useCryptoQuote({ product: 'solo_manual' }));
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
  });

  it('surfaces HTTP error status', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 400,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoQuote({ product: 'solo_manual' }));
    await waitFor(() => expect(result.current.state.kind).toBe('error'));
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe(
        'The request could not be completed. Check your input and try again.',
      );
    }
  });
});

describe('V-534.V useCryptoQuote — manual mode + refetch', () => {
  it('aborts an old product quote and keeps the newer selection', async () => {
    let oldSignal: AbortSignal | undefined;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            oldSignal = init?.signal ?? undefined;
            init?.signal?.addEventListener('abort', () => {
              reject(new DOMException('aborted', 'AbortError'));
            });
          }),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify(sample({ product: 'team_manual', price_cents: 9900 })), {
          status: 200,
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(({ product }) => useCryptoQuote({ product }), {
      initialProps: { product: 'solo_manual' },
    });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    rerender({ product: 'team_manual' });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(oldSignal?.aborted).toBe(true);
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.data.product).toBe('team_manual');
      expect(result.current.state.data.price_cents).toBe(9900);
    }
  });

  it('manual=true starts idle and does not auto-fetch', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoQuote({ product: 'solo_manual', manual: true }));
    expect(result.current.state.kind).toBe('idle');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refetch() advances from idle through to ready', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(sample()),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoQuote({ product: 'solo_manual', manual: true }));
    await result.current.refetch();
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
