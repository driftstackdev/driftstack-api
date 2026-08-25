// V-534.J — unit tests for useCryptoCheckout.
// V-534.AY — appended tests for Idempotency-Key auto-send.
// V-534.AZ — appended tests for the Idempotent-Replayed header parsing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { CryptoCheckoutResponse } from '../../src/lib/use-crypto-checkout';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
  accountMe: { id: string } | null;
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { useCryptoCheckout, resetCryptoCheckoutRecoveryForTesting } =
  await import('../../src/lib/use-crypto-checkout');

const SAMPLE: CryptoCheckoutResponse = {
  order_id: 'ord_abc123def456',
  product: 'trial_pack',
  price_cents: 299,
  price_currency: 'USD',
  status: 'pending',
  provider: 'stub',
  payment_address: null,
  pay_currency: null,
  pay_amount: null,
  created_at: '2026-05-11T00:00:00.000Z',
};

beforeEach(() => {
  resetCryptoCheckoutRecoveryForTesting();
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.local' },
    accountMe: { id: 'acc_test' },
  });
});

afterEach(() => {
  resetCryptoCheckoutRecoveryForTesting();
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
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
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
    const callArgs = fetchMock.mock.calls[0]?.[1];
    expect(callArgs?.method).toBe('POST');
    expect(callArgs?.redirect).toBe('error');
    expect(callArgs?.signal).toBeTruthy();
    const rawBody = typeof callArgs?.body === 'string' ? callArgs.body : '';
    const body = JSON.parse(rawBody) as Record<string, unknown>;
    expect(body).toEqual({
      product: 'solo_manual',
      price_cents: 2500,
      price_currency: 'USD',
    });
  });

  it('accepts the server-authoritative USD amount when the submitted quote was stale or EUR', async () => {
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
        price_cents: 123,
        price_currency: 'EUR',
      });
    });
    expect(result.current.state.kind).toBe('ready');
    if (result.current.state.kind === 'ready') {
      expect(result.current.state.order.price_cents).toBe(299);
      expect(result.current.state.order.price_currency).toBe('USD');
    }
  });

  it('accepts a pending NowPayments replay whose optional payment instructions are not available yet', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers({ 'idempotent-replayed': '1' }),
          json: () =>
            Promise.resolve({
              ...SAMPLE,
              provider: 'nowpayments',
              payment_address: null,
              pay_currency: null,
              pay_amount: null,
            }),
        } as unknown as Response),
      ),
    );
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () =>
      result.current.start({
        product: SAMPLE.product,
        price_cents: SAMPLE.price_cents,
        price_currency: SAMPLE.price_currency,
      }),
    );
    expect(result.current.state.kind).toBe('ready');
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
    const { result, unmount } = renderHook(() => useCryptoCheckout());
    const args = { product: 'trial_pack', price_cents: 299, price_currency: 'USD' };
    act(() => {
      void result.current.start(args);
      void result.current.start(args);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('bounds a stalled checkout without pretending the order was not committed', async () => {
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
      kind: 'outcome_unknown',
      retryable: true,
      message:
        "We couldn't confirm whether this checkout was created. Retry the same checkout to restore its result safely.",
    });
  });

  it('error when no API key is configured', async () => {
    useSettingsMock.mockReturnValue({
      settings: { apiKey: null, baseUrl: 'https://api.driftstack.local' },
      accountMe: null,
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
      expect(result.current.state.message).toBe(
        'The request could not be completed. Check your input and try again.',
      );
    } else {
      throw new Error('expected error state');
    }
  });

  it('treats a rejected fetch as outcome-unknown instead of authoritatively failed', async () => {
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
    if (result.current.state.kind === 'outcome_unknown') {
      expect(result.current.state.message).toMatch(/confirm whether this checkout was created/i);
    } else {
      throw new Error('expected outcome_unknown state');
    }
  });

  it.each([0, 302, 408, 429, 500, 503])(
    'treats HTTP %i as outcome-unknown because the server may have committed',
    async (status) => {
      vi.stubGlobal(
        'fetch',
        vi.fn(() =>
          Promise.resolve({
            ok: false,
            status,
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
      expect(result.current.state.kind).toBe('outcome_unknown');
    },
  );

  it('treats a malformed accepted response as outcome-unknown', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () => Promise.resolve({ ...SAMPLE, order_id: '' }),
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
    expect(result.current.state.kind).toBe('outcome_unknown');
  });

  it.each<[string, Record<string, unknown>]>([
    ['an unknown status', { status: 'mystery' }],
    ['a whitespace order id', { order_id: '   ' }],
    ['a padded order id', { order_id: ' ord_abc123def456 ' }],
    ['a traversal-shaped order id', { order_id: '../crypto-orders/victim' }],
    ['a query-shaped order id', { order_id: 'ord_abc123def456?admin=1' }],
    ['missing pay_amount', { pay_amount: undefined }],
    ['a non-numeric pay_amount', { pay_amount: '1.25' }],
    ['a non-positive pay_amount', { provider: 'nowpayments', pay_amount: 0 }],
    ['a pay_amount that renders as zero', { provider: 'nowpayments', pay_amount: 1e-21 }],
    ['a fractional fiat-cent amount', { price_cents: 299.5 }],
    ['a non-ISO currency', { price_currency: 'usd' }],
    ['an invalid timestamp', { created_at: 'not-a-date' }],
    ['a non-string payment address', { payment_address: 123 }],
    [
      'an empty NowPayments address',
      { provider: 'nowpayments', payment_address: '', pay_currency: 'usdt', pay_amount: 1 },
    ],
    [
      'a whitespace NowPayments address',
      { provider: 'nowpayments', payment_address: '   ', pay_currency: 'usdt', pay_amount: 1 },
    ],
    [
      'a padded NowPayments address',
      { provider: 'nowpayments', payment_address: ' 0xabc ', pay_currency: 'usdt', pay_amount: 1 },
    ],
    [
      'an overlong NowPayments address',
      {
        provider: 'nowpayments',
        payment_address: 'a'.repeat(513),
        pay_currency: 'usdt',
        pay_amount: 1,
      },
    ],
    [
      'a control-bearing NowPayments address',
      {
        provider: 'nowpayments',
        payment_address: '0xabc\nmalicious',
        pay_currency: 'usdt',
        pay_amount: 1,
      },
    ],
    [
      'a bidi-bearing NowPayments address',
      {
        provider: 'nowpayments',
        payment_address: '0xabc\u202evictim',
        pay_currency: 'usdt',
        pay_amount: 1,
      },
    ],
    [
      'an empty NowPayments currency',
      { provider: 'nowpayments', payment_address: '0xabc', pay_currency: '', pay_amount: 1 },
    ],
    [
      'a whitespace NowPayments currency',
      { provider: 'nowpayments', payment_address: '0xabc', pay_currency: '   ', pay_amount: 1 },
    ],
    [
      'a padded NowPayments currency',
      { provider: 'nowpayments', payment_address: '0xabc', pay_currency: ' usdt ', pay_amount: 1 },
    ],
    [
      'an overlong NowPayments currency',
      {
        provider: 'nowpayments',
        payment_address: '0xabc',
        pay_currency: 'a'.repeat(33),
        pay_amount: 1,
      },
    ],
    [
      'an illegal NowPayments currency token',
      {
        provider: 'nowpayments',
        payment_address: '0xabc',
        pay_currency: 'usdt/erc20',
        pay_amount: 1,
      },
    ],
    ['a parseable non-canonical timestamp', { created_at: '2026-01-01T00:00:00Z' }],
    ['payment metadata on the stub rail', { payment_address: '0xabc' }],
  ])('keeps the key locked when accepted JSON has %s', async (_label, patch) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () => Promise.resolve({ ...SAMPLE, ...patch }),
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
    expect(result.current.state.kind).toBe('outcome_unknown');
  });
});

describe('V-534.AY useCryptoCheckout — Idempotency-Key', () => {
  it('sends an Idempotency-Key header on start()', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
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
    const init = fetchMock.mock.calls[0]?.[1];
    const headers = init?.headers as Record<string, string>;
    expect(headers['idempotency-key']).toBeTruthy();
    expect(headers['idempotency-key'].length).toBeGreaterThanOrEqual(10);
  });

  it('replays exact key/body/endpoint/auth after a lost response and single-flights rapid retry', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new DOMException('response lost after commit', 'AbortError'))
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'idempotent-replayed': '1' }),
        json: () => Promise.resolve(SAMPLE),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(() => useCryptoCheckout());
    await act(async () => {
      await result.current.start({
        product: 'trial_pack',
        price_cents: 299,
        price_currency: 'USD',
      });
    });
    expect(result.current.state.kind).toBe('outcome_unknown');

    // reset/new start must stay unavailable while delivery is ambiguous.
    act(() => result.current.reset());
    expect(result.current.state.kind).toBe('outcome_unknown');

    // Even if current Settings change, the only safe operation is the exact
    // original account/endpoint replay.
    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_other', baseUrl: 'https://api.driftstack.local' },
      accountMe: { id: 'acc_test' },
    });
    rerender();
    await act(async () => {
      await Promise.all([result.current.retry(), result.current.retry()]);
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [urlA, initA] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [urlB, initB] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(urlB).toBe(urlA);
    expect(initB.body).toBe(initA.body);
    const headersA = initA.headers as Record<string, string>;
    const headersB = initB.headers as Record<string, string>;
    expect(headersA['idempotency-key']).toBe(headersB['idempotency-key']);
    expect(headersB.authorization).toBe(headersA.authorization);
    expect(result.current.state.kind).toBe('ready');
    if (result.current.state.kind === 'ready') expect(result.current.state.replayed).toBe(true);
  });

  it('keeps the same key after malformed success and permits only exact retry', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve({ ...SAMPLE, provider: 'unexpected' }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'idempotent-replayed': '1' }),
        json: () => Promise.resolve(SAMPLE),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    const args = { product: 'trial_pack', price_cents: 299, price_currency: 'USD' };
    await act(async () => result.current.start(args));
    expect(result.current.state.kind).toBe('outcome_unknown');
    await act(async () => result.current.retry());
    const initA = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const initB = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(initB.body).toBe(initA.body);
    expect((initB.headers as Record<string, string>)['idempotency-key']).toBe(
      (initA.headers as Record<string, string>)['idempotency-key'],
    );
    expect(result.current.state.kind).toBe('ready');
  });

  it('never clears an ambiguous attempt when a later replay gets an ordinary 4xx', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        json: () => Promise.resolve({}),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    const args = { product: 'trial_pack', price_cents: 299, price_currency: 'USD' };

    await act(async () => result.current.start(args));
    expect(result.current.state.kind).toBe('outcome_unknown');
    await act(async () => result.current.retry());
    expect(result.current.state.kind).toBe('outcome_unknown');

    act(() => result.current.reset());
    await act(async () => result.current.start(args));
    expect(result.current.state.kind).toBe('outcome_unknown');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('allows an authoritative 422 to reset and mint a genuinely fresh key', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce({
        ok: false,
        status: 422,
        json: () => Promise.resolve({}),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve(SAMPLE),
      });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useCryptoCheckout());
    const args = { product: 'trial_pack', price_cents: 299, price_currency: 'USD' };
    await act(async () => result.current.start(args));
    expect(result.current.state.kind).toBe('error');
    act(() => result.current.reset());
    expect(result.current.state.kind).toBe('idle');
    await act(async () => result.current.start(args));
    const [, initA] = fetchMock.mock.calls[0] as [string, RequestInit];
    const [, initB] = fetchMock.mock.calls[1] as [string, RequestInit];
    const keyA = (initA.headers as Record<string, string>)['idempotency-key'];
    const keyB = (initB.headers as Record<string, string>)['idempotency-key'];
    expect(keyB).not.toBe(keyA);
  });

  it('rotates the Idempotency-Key on reset()', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
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

describe('V-534.AY useCryptoCheckout — navigation-safe recovery owner', () => {
  const args = { product: 'trial_pack', price_cents: 299, price_currency: 'USD' };

  it('recovers the exact uncertain request after unmount/remount without minting K2', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('response lost after commit'))
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'idempotent-replayed': '1' }),
        json: () => Promise.resolve(SAMPLE),
      });
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useCryptoCheckout());
    await act(async () => first.result.current.start(args));
    expect(first.result.current.state.kind).toBe('outcome_unknown');
    const [, firstInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    first.unmount();

    const second = renderHook(() => useCryptoCheckout());
    expect(second.result.current.state.kind).toBe('outcome_unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => second.result.current.retry());
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const [, retryInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(retryInit.body).toBe(firstInit.body);
    expect((retryInit.headers as Record<string, string>)['idempotency-key']).toBe(
      (firstInit.headers as Record<string, string>)['idempotency-key'],
    );
    expect((retryInit.headers as Record<string, string>).authorization).toBe(
      (firstInit.headers as Record<string, string>).authorization,
    );
    expect(second.result.current.state.kind).toBe('ready');

    second.unmount();
    const third = renderHook(() => useCryptoCheckout());
    expect(third.result.current.state.kind).toBe('ready');
    act(() => third.result.current.reset());
    expect(third.result.current.state.kind).toBe('idle');
  });

  it('lets only one hook reserve a scope before the first POST settles', () => {
    const fetchMock = vi.fn(
      (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('aborted', 'AbortError'));
          });
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useCryptoCheckout());
    const second = renderHook(() => useCryptoCheckout());
    act(() => {
      void first.result.current.start(args);
      void second.result.current.start(args);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.result.current.state.kind).toBe('loading');
    first.unmount();
    second.unmount();
  });

  it('publishes a late owner success to the remounted observer without a second POST', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const first = renderHook(() => useCryptoCheckout());
    act(() => void first.result.current.start(args));
    expect(first.result.current.state.kind).toBe('loading');
    first.unmount();

    const second = renderHook(() => useCryptoCheckout());
    expect(second.result.current.state.kind).toBe('outcome_unknown');
    act(() => {
      resolveFetch({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response);
    });
    await waitFor(() => expect(second.result.current.state.kind).toBe('ready'));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not let a non-owner observer unmount turn the owner’s definitive 422 ambiguous', async () => {
    let resolveFetch!: (response: Response) => void;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const owner = renderHook(() => useCryptoCheckout());
    const observer = renderHook(() => useCryptoCheckout());
    let pending!: Promise<void>;
    act(() => {
      pending = owner.result.current.start(args);
    });
    expect(observer.result.current.state.kind).toBe('loading');
    observer.unmount();
    await act(async () => {
      resolveFetch({
        ok: false,
        status: 422,
        json: () => Promise.resolve({}),
      } as unknown as Response);
      await pending;
    });
    expect(owner.result.current.state.kind).toBe('error');
  });

  it('keeps a received definitive 422 authoritative when unmount aborts its held diagnostic body', async () => {
    let resolveBody!: (body: Record<string, never>) => void;
    const json = vi.fn(
      () =>
        new Promise<Record<string, never>>((resolve) => {
          resolveBody = resolve;
        }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 422,
          json,
        } as unknown as Response),
      ),
    );
    const owner = renderHook(() => useCryptoCheckout());
    let pending!: Promise<void>;
    act(() => {
      pending = owner.result.current.start(args);
    });
    await waitFor(() => expect(json).toHaveBeenCalledTimes(1));
    owner.unmount();
    const observer = renderHook(() => useCryptoCheckout());
    expect(observer.result.current.state.kind).toBe('outcome_unknown');
    await act(async () => {
      resolveBody({});
      await pending;
    });
    expect(observer.result.current.state.kind).toBe('error');
  });

  it('queues an explicit same-key retry behind the still-settling original owner', async () => {
    let rejectFirst!: (reason: Error) => void;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectFirst = reject;
          }),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers({ 'idempotent-replayed': '1' }),
        json: () => Promise.resolve(SAMPLE),
      });
    vi.stubGlobal('fetch', fetchMock);
    const owner = renderHook(() => useCryptoCheckout());
    act(() => void owner.result.current.start(args));
    owner.unmount();
    const observer = renderHook(() => useCryptoCheckout());
    expect(observer.result.current.state.kind).toBe('outcome_unknown');

    let retry!: Promise<void>;
    act(() => {
      retry = observer.result.current.retry();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => {
      rejectFirst(new Error('original response lost'));
      await retry;
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const firstInit = fetchMock.mock.calls[0]?.[1] as RequestInit;
    const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
    expect(secondInit.body).toBe(firstInit.body);
    expect((secondInit.headers as Record<string, string>)['idempotency-key']).toBe(
      (firstInit.headers as Record<string, string>)['idempotency-key'],
    );
    expect(observer.result.current.state.kind).toBe('ready');
  });

  it('shares one whole retry transaction across mounted observers after another ambiguous result', async () => {
    let rejectReplay!: (reason: Error) => void;
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('original response lost'))
      .mockImplementationOnce(
        () =>
          new Promise<Response>((_resolve, reject) => {
            rejectReplay = reject;
          }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useCryptoCheckout());
    await act(async () => first.result.current.start(args));
    const second = renderHook(() => useCryptoCheckout());
    expect(first.result.current.state.kind).toBe('outcome_unknown');
    expect(second.result.current.state.kind).toBe('outcome_unknown');

    let firstRetry!: Promise<void>;
    let secondRetry!: Promise<void>;
    act(() => {
      firstRetry = first.result.current.retry();
      secondRetry = second.result.current.retry();
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await act(async () => {
      rejectReplay(new Error('replay response also lost'));
      await Promise.all([firstRetry, secondRetry]);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(first.result.current.state.kind).toBe('outcome_unknown');
    expect(second.result.current.state.kind).toBe('outcome_unknown');
  });

  it('isolates unresolved attempts by account and restores A after B completes', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('A response lost'))
      .mockResolvedValueOnce({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve(SAMPLE),
      });
    vi.stubGlobal('fetch', fetchMock);

    const a = renderHook(() => useCryptoCheckout());
    await act(async () => a.result.current.start(args));
    expect(a.result.current.state.kind).toBe('outcome_unknown');
    a.unmount();

    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_b', baseUrl: 'https://api.driftstack.local' },
      accountMe: { id: 'acc_b' },
    });
    const b = renderHook(() => useCryptoCheckout());
    expect(b.result.current.state.kind).toBe('idle');
    await act(async () => b.result.current.start(args));
    expect(b.result.current.state.kind).toBe('ready');
    b.unmount();

    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.local' },
      accountMe: { id: 'acc_test' },
    });
    const restoredA = renderHook(() => useCryptoCheckout());
    expect(restoredA.result.current.state.kind).toBe('outcome_unknown');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('never exposes a previous account or base-url result during a same-instance scope switch', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () => Promise.resolve(SAMPLE),
        } as Response),
      ),
    );
    const snapshots: Array<{
      lockedProduct: string | null;
      orderId: string | null;
      stateKind: string;
    }> = [];
    const hook = renderHook(() => {
      const value = useCryptoCheckout();
      snapshots.push({
        lockedProduct: value.lockedArgs?.product ?? null,
        orderId: value.state.kind === 'ready' ? value.state.order.order_id : null,
        stateKind: value.state.kind,
      });
      return value;
    });
    await act(async () => hook.result.current.start(args));
    expect(hook.result.current.state.kind).toBe('ready');

    const switchSnapshotStart = snapshots.length;
    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_b', baseUrl: 'https://api-b.driftstack.local/' },
      accountMe: { id: 'acc_b' },
    });
    hook.rerender();

    expect(snapshots.slice(switchSnapshotStart)).not.toContainEqual(
      expect.objectContaining({ orderId: SAMPLE.order_id }),
    );
    expect(snapshots.slice(switchSnapshotStart)).not.toContainEqual(
      expect.objectContaining({ lockedProduct: SAMPLE.product }),
    );
    expect(hook.result.current.state.kind).toBe('idle');
    expect(hook.result.current.lockedArgs).toBeNull();
  });

  it('expires the credential without user interaction before the 24-hour server window and retains a fail-closed tombstone', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-05-11T00:00:00.000Z'));
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.reject(new Error('response lost')),
    );
    vi.stubGlobal('fetch', fetchMock);
    const first = renderHook(() => useCryptoCheckout());
    await act(async () => first.result.current.start(args));
    expect(first.result.current.state.kind).toBe('outcome_unknown');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 1);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(first.result.current.state).toEqual({
      kind: 'outcome_unknown',
      retryable: false,
      message:
        "This checkout still can't be confirmed, and its safe replay window has expired. Review Orders or contact billing@driftstack.dev before trying another checkout.",
    });
    act(() => first.result.current.reset());
    await act(async () => first.result.current.start(args));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(['network rejection', 'HTTP 503'])(
    'does not downgrade an expired tombstone after a late %s',
    async (lateOutcome) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-05-11T00:00:00.000Z'));
      let resolveFetch!: (response: Response) => void;
      let rejectFetch!: (reason: Error) => void;
      vi.stubGlobal(
        'fetch',
        vi.fn(
          () =>
            new Promise<Response>((resolve, reject) => {
              resolveFetch = resolve;
              rejectFetch = reject;
            }),
        ),
      );
      const hook = renderHook(() => useCryptoCheckout());
      let pending!: Promise<void>;
      act(() => {
        pending = hook.result.current.start(args);
      });
      await act(async () => {
        await vi.advanceTimersByTimeAsync(23 * 60 * 60 * 1000 + 1);
      });
      expect(hook.result.current.state).toMatchObject({
        kind: 'outcome_unknown',
        retryable: false,
      });
      await act(async () => {
        if (lateOutcome === 'HTTP 503') {
          resolveFetch({
            ok: false,
            status: 503,
            json: () => Promise.resolve({}),
          } as unknown as Response);
        } else {
          rejectFetch(new Error('late network failure'));
        }
        await pending;
      });
      expect(hook.result.current.state).toMatchObject({
        kind: 'outcome_unknown',
        retryable: false,
      });
    },
  );

  it('evicts credential-free ready history before refusing a ninth scope', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () => Promise.resolve(SAMPLE),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    for (let index = 0; index < 9; index += 1) {
      useSettingsMock.mockReturnValue({
        settings: { apiKey: `sk_${index}`, baseUrl: 'https://api.driftstack.local' },
        accountMe: { id: `acc_${index}` },
      });
      const hook = renderHook(() => useCryptoCheckout());
      await act(async () => hook.result.current.start(args));
      expect(hook.result.current.state.kind).toBe('ready');
      hook.unmount();
    }
    expect(fetchMock).toHaveBeenCalledTimes(9);
  });

  it('refuses a ninth unresolved scope without evicting the first', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.reject(new Error('response lost')),
    );
    vi.stubGlobal('fetch', fetchMock);
    for (let index = 0; index < 8; index += 1) {
      useSettingsMock.mockReturnValue({
        settings: { apiKey: `sk_${index}`, baseUrl: 'https://api.driftstack.local' },
        accountMe: { id: `acc_${index}` },
      });
      const hook = renderHook(() => useCryptoCheckout());
      await act(async () => hook.result.current.start(args));
      expect(hook.result.current.state.kind).toBe('outcome_unknown');
      hook.unmount();
    }

    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_ninth', baseUrl: 'https://api.driftstack.local' },
      accountMe: { id: 'acc_ninth' },
    });
    const ninth = renderHook(() => useCryptoCheckout());
    await act(async () => ninth.result.current.start(args));
    expect(fetchMock).toHaveBeenCalledTimes(8);
    expect(ninth.result.current.state).toEqual({
      kind: 'error',
      message:
        'Too many checkouts are awaiting confirmation. Resolve an existing checkout before starting another.',
    });

    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_0', baseUrl: 'https://api.driftstack.local' },
      accountMe: { id: 'acc_0' },
    });
    const first = renderHook(() => useCryptoCheckout());
    expect(first.result.current.state.kind).toBe('outcome_unknown');
  });

  it('dispatches nothing until account identity is available', async () => {
    const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
    vi.stubGlobal('fetch', fetchMock);
    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.local' },
      accountMe: null,
    });
    const { result } = renderHook(() => useCryptoCheckout());
    await act(async () => result.current.start(args));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result.current.state.kind).toBe('error');
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
