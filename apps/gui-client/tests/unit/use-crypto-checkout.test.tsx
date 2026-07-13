// V-534.J — unit tests for useCryptoCheckout.
// V-534.AY — appended tests for Idempotency-Key auto-send.
// V-534.AZ — appended tests for the Idempotent-Replayed header parsing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CryptoCheckoutResponse } from '../../src/lib/use-crypto-checkout';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCryptoCheckout } = await import('../../src/lib/use-crypto-checkout');

const SAMPLE: CryptoCheckoutResponse = {
  order_id: 'ord_abc123def456',
  product: 'trial_pack',
  price_cents: 299,
  price_currency: 'USD',
  status: 'pending',
  provider: 'stub',
  payment_address: null,
  pay_currency: null,
  created_at: '2026-05-11T00:00:00.000Z',
};

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.local' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  vi.useRealTimers();
});

describe('V-534.J useCryptoCheckout — initial state', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useCryptoCheckout());
    expect(result.current.state.kind).toBe('idle');
  });
});

describe('V-534.J useCryptoCheckout.start — happy path', () => {
  it('transitions idle → loading → ready', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () => Promise.resolve(SAMPLE),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.order.order_id).toBe('ord_abc123def456');
      expect(result.current.state.order.provider).toBe('stub');
      // V-534.AZ — no Idempotent-Replayed header was set, so replayed defaults to false.
      expect(result.current.state.replayed).toBe(false);
    }
  });

  it('serialises product + price + currency in the request body', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
      });
    });
    const callArgs = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(callArgs?.method).toBe('POST');
    expect(callArgs?.signal).toBeTruthy();
    const rawBody = typeof callArgs?.body === 'string' ? callArgs.body : '';
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toEqual({
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'USD',
    });
  });
});

describe('V-534.J useCryptoCheckout.start — error paths', () => {
  it('single-flights duplicate checkout dispatch while the first request is pending', () => {
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>(() => {
          // Intentionally pending until reset aborts the caller signal.
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    const args = { product: 'trial_pack', price_cents: 299, price_currency: 'USD' };
    act(() => {
      void result.current.start(args);
      void result.current.start(args);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    act(() => result.current.reset());
    expect(result.current.state.kind).toBe('idle');
  });

  it('bounds a stalled checkout and restores an actionable error', async () => {
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
    const { result } = renderHook(() => useCryptoCheckout());
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    await vi.advanceTimersByTimeAsync(15_000);
    await act(async () => pending);
    expect(result.current.state).toEqual({
      kind: 'error',
      message: 'Checkout timed out. Check your connection and try again.',
    });
  });

  it('error when no API key is configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.local' },
    });
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toMatch(/API key/);
    } else {
      throw new Error('expected error state');
    }
  });

  it('error when fetch returns a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 422,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toMatch(/422/);
    } else {
      throw new Error('expected error state');
    }
  });

  it('error when fetch rejects with a network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('network down'))),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    if (result.current.state.kind === 'error') {
      expect(result.current.state.message).toBe('network down');
    } else {
      throw new Error('expected error state');
    }
  });
});

describe('V-534.AY useCryptoCheckout — Idempotency-Key', () => {
  it('sends an Idempotency-Key header on start()', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit | undefined;
    const headers = init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeTruthy();
    expect(headers['idempotency-key'].length).toBeGreaterThanOrEqual(10);
  });

  it('reuses the same Idempotency-Key across retries without reset()', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    const headersA = fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const headersB = fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(headersA['idempotency-key']).toBe(headersB['idempotency-key']);
  });

  it('rotates the Idempotency-Key on reset()', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    act(() => {
      result.current.reset();
    });
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    const keyA = (fetchMock.mock.calls[0]?.[1]?.headers as Record<string, string>)[
      'idempotency-key'
    ];
    const keyB = (fetchMock.mock.calls[1]?.[1]?.headers as Record<string, string>)[
      'idempotency-key'
    ];
    expect(keyA).not.toBe(keyB);
  });
});

describe('V-534.AZ useCryptoCheckout — Idempotent-Replayed header', () => {
  it('sets replayed: true when the response header is "1"', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers({ 'idempotent-replayed': '1' }),
          json: () => Promise.resolve(SAMPLE),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.replayed).toBe(true);
    }
  });

  it('replayed defaults to false when the header is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () => Promise.resolve(SAMPLE),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    await waitFor(() => expect(result.current.state.kind).toBe('ready'));
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.replayed).toBe(false);
    }
  });
});

describe('V-534.J useCryptoCheckout.reset', () => {
  it('returns the hook to idle from any state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () => Promise.resolve(SAMPLE),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    expect(result.current.state.kind).toBe('ready');
    act(() => {
      result.current.reset();
    });
    expect(result.current.state.kind).toBe('idle');
  });
});
