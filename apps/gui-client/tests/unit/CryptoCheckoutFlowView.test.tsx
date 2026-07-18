// V-534.AC — unit tests for CryptoCheckoutFlowView.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
  accountMe: { id: string } | null;
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { resetCryptoCheckoutRecoveryForTesting } = await import('../../src/lib/use-crypto-checkout');
const { CryptoCheckoutFlowView } = await import('../../src/views/CryptoCheckoutFlowView');

beforeEach(() => {
  resetCryptoCheckoutRecoveryForTesting();
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
    accountMe: { id: 'acc_test' },
  });
});

afterEach(() => {
  resetCryptoCheckoutRecoveryForTesting();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function setupFetch(opts: {
  onQuote?: () => unknown;
  onCheckout?: () => unknown;
  onOrder?: () => unknown;
}): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn((url: string) => {
    if (typeof url === 'string' && url.endsWith('/quote')) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve(
            opts.onQuote?.() ?? {
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'USD',
              provider: 'stub',
              pay_currency: null,
              pay_min_amount: null,
              pay_max_amount: null,
            },
          ),
      } as unknown as Response);
    }
    if (typeof url === 'string' && url.endsWith('/v1/billing/crypto-checkout')) {
      return Promise.resolve({
        ok: true,
        status: 201,
        headers: new Headers(),
        json: () =>
          Promise.resolve(
            opts.onCheckout?.() ?? {
              order_id: 'ord_111111111111',
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'USD',
              status: 'pending',
              provider: 'stub',
              payment_address: null,
              pay_currency: null,
              pay_amount: null,
              created_at: '2026-05-11T10:00:00.000Z',
            },
          ),
      } as unknown as Response);
    }
    // crypto-orders/:id (status poll)
    return Promise.resolve({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve(
          opts.onOrder?.() ?? {
            order_id: 'ord_111111111111',
            product: 'solo_manual',
            price_cents: 2500,
            price_currency: 'USD',
            payment_id: null,
            status: 'pending',
            expires_at: '2099-05-11T11:00:00.000Z',
            created_at: '2026-05-11T10:00:00.000Z',
            updated_at: '2026-05-11T10:00:00.000Z',
          },
        ),
    } as unknown as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function parseJsonRequestBody(init: RequestInit | undefined): Record<string, unknown> {
  if (typeof init?.body !== 'string') throw new Error('expected a JSON request body');
  return JSON.parse(init.body) as Record<string, unknown>;
}

describe('V-534.AC CryptoCheckoutFlowView', () => {
  it('renders the quote price after mount', async () => {
    const fetchMock = setupFetch({});
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await waitFor(() => {
      expect(screen.getByText('25.00 USD')).toBeTruthy();
    });
    const quoteCall = fetchMock.mock.calls.find(
      ([url]) => typeof url === 'string' && url.endsWith('/quote'),
    );
    const quoteBody = (quoteCall?.[1] as RequestInit | undefined)?.body;
    if (typeof quoteBody !== 'string') throw new Error('expected a JSON quote body');
    expect(JSON.parse(quoteBody)).toEqual({
      product: 'solo_manual',
      price_currency: 'USD',
    });
  });

  it('disables the Start checkout button until the quote is ready', () => {
    setupFetch({
      onQuote: () => new Promise(() => undefined),
    });
    // Override to keep quote pending.
    const fetchMock = vi.fn(
      () =>
        new Promise(() => {
          // never resolves
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    const btn = screen.getByRole('button', { name: /Start checkout/i });
    expect((btn as HTMLButtonElement).disabled).toBe(true);
  });

  it('clicking Start checkout POSTs to /v1/billing/crypto-checkout + reveals the order id', async () => {
    const fetchMock = setupFetch({});
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await waitFor(() => {
      expect(screen.getByText('25.00 USD')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    await waitFor(() => {
      expect(screen.getByText('ord_111111111111')).toBeTruthy();
    });
    // The checkout POST was made.
    const checkoutPosts = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/v1/billing/crypto-checkout'),
    );
    expect(checkoutPosts.length).toBe(1);
  });

  it('shows the authoritative checkout amount and calls out a price change after the quote', async () => {
    setupFetch({
      onCheckout: () => ({
        order_id: 'ord_222222222222',
        product: 'solo_manual',
        price_cents: 3000,
        price_currency: 'USD',
        status: 'pending',
        provider: 'stub',
        payment_address: null,
        pay_currency: null,
        pay_amount: null,
        created_at: '2026-05-11T10:00:00.000Z',
      }),
    });
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByText('30.00 USD')).toBeInTheDocument();
    expect(screen.getByText(/Price updated before checkout/i)).toBeInTheDocument();
  });

  it('locks an unknown outcome to one exact same-checkout retry and restores the order', async () => {
    let checkoutCalls = 0;
    let resolveReplay: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith('/quote')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'USD',
            }),
        } as unknown as Response);
      }
      if (url.endsWith('/v1/billing/crypto-checkout')) {
        checkoutCalls += 1;
        if (checkoutCalls === 1) return Promise.reject(new Error('response lost'));
        return new Promise<Response>((resolve) => {
          resolveReplay = resolve;
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            order_id: 'ord_333333333333',
            product: 'solo_manual',
            price_cents: 2500,
            price_currency: 'USD',
            payment_id: null,
            status: 'pending',
            created_at: '2026-05-11T10:00:00.000Z',
            updated_at: '2026-05-11T10:00:00.000Z',
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));

    const retry = await screen.findByRole('button', { name: 'Retry same checkout' });
    expect(screen.getByRole('combobox').disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Start checkout/i })).toBeNull();
    fireEvent.click(retry);
    fireEvent.click(retry);
    expect(checkoutCalls).toBe(2);

    resolveReplay?.({
      ok: true,
      status: 201,
      headers: new Headers({ 'idempotent-replayed': '1' }),
      json: () =>
        Promise.resolve({
          order_id: 'ord_333333333333',
          product: 'solo_manual',
          price_cents: 2500,
          price_currency: 'USD',
          status: 'pending',
          provider: 'stub',
          payment_address: null,
          pay_currency: null,
          pay_amount: null,
          created_at: '2026-05-11T10:00:00.000Z',
        }),
    } as unknown as Response);
    expect(await screen.findByText('ord_333333333333')).toBeInTheDocument();
    expect(screen.getByText(/Restored from your earlier attempt/i)).toBeInTheDocument();
  });

  it('keeps the captured product visible and exact across unknown-outcome remount recovery', async () => {
    let checkoutCalls = 0;
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/quote')) {
        const request = parseJsonRequestBody(init);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              product: String(request.product),
              price_cents: request.product === 'team_manual' ? 5000 : 2500,
              price_currency: 'USD',
            }),
        } as unknown as Response);
      }
      if (url.endsWith('/v1/billing/crypto-checkout')) {
        checkoutCalls += 1;
        if (checkoutCalls === 1) return Promise.reject(new Error('response lost'));
        return Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers({ 'idempotent-replayed': '1' }),
          json: () =>
            Promise.resolve({
              order_id: 'ord_444444444444',
              product: 'team_manual',
              price_cents: 5000,
              price_currency: 'USD',
              status: 'pending',
              provider: 'stub',
              payment_address: null,
              pay_currency: null,
              pay_amount: null,
              created_at: '2026-05-11T10:00:00.000Z',
            }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            order_id: 'ord_444444444444',
            product: 'team_manual',
            price_cents: 5000,
            price_currency: 'USD',
            payment_id: null,
            status: 'pending',
            created_at: '2026-05-11T10:00:00.000Z',
            updated_at: '2026-05-11T10:00:00.000Z',
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    const first = render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'team_manual' } });
    await screen.findByText('50.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    await screen.findByRole('button', { name: 'Retry same checkout' });
    first.unmount();

    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    expect((await screen.findByRole<HTMLSelectElement>('combobox')).value).toBe('team_manual');
    await screen.findByText('50.00 USD');
    fireEvent.click(await screen.findByRole('button', { name: 'Retry same checkout' }));
    expect(await screen.findByText('ord_444444444444')).toBeInTheDocument();
    const checkoutBodies = fetchMock.mock.calls
      .filter(([url]) => url.endsWith('/v1/billing/crypto-checkout'))
      .map(([, request]) => parseJsonRequestBody(request));
    expect(checkoutBodies).toEqual([
      { product: 'team_manual', price_cents: 5000, price_currency: 'USD' },
      { product: 'team_manual', price_cents: 5000, price_currency: 'USD' },
    ]);
  });

  it('shows an actionable availability message without exposing provider internals', async () => {
    setupFetch({});
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await waitFor(() => {
      expect(screen.getByText('25.00 USD')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    await waitFor(() => {
      expect(screen.getByText(/Crypto checkout is unavailable on this server/i)).toBeTruthy();
      expect(screen.getByText(/billing@driftstack\.dev/i)).toBeTruthy();
    });
    expect(screen.queryByText(/stub mode/i)).toBeNull();
  });

  it.each([
    [
      'the write promise rejects',
      { clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) } },
    ],
    ['the Clipboard API is absent', {}],
    [
      'the WebView throws synchronously',
      {
        clipboard: {
          writeText: vi.fn(() => {
            throw new Error('synchronous denial');
          }),
        },
      },
    ],
  ])('surfaces payment-address failure and recovers when %s', async (_label, navigatorStub) => {
    setupFetch({
      onCheckout: () => ({
        order_id: 'ord_111111111111',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
        status: 'pending',
        provider: 'nowpayments',
        payment_address: '0x123456789',
        pay_currency: 'usdt',
        pay_amount: 25,
        created_at: '2026-05-11T10:00:00.000Z',
      }),
    });
    vi.stubGlobal('navigator', navigatorStub);
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByText('25 USDT')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: /Copy payment address/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/clipboard permission/i);
    const retry = screen.getByRole('button', { name: /Retry copy/i });
    expect(retry).toBeInTheDocument();
    expect((retry as HTMLButtonElement).disabled).toBe(false);
    expect(retry).toHaveAttribute('aria-busy', 'false');

    const recoveredWrite = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText: recoveredWrite } });
    fireEvent.click(retry);
    expect(await screen.findByText('Copied ✓')).toBeInTheDocument();
    expect(recoveredWrite).toHaveBeenCalledTimes(1);
    expect(recoveredWrite).toHaveBeenCalledWith('0x123456789');
  });

  it('fails closed when a real payment address lacks an exact crypto amount', async () => {
    setupFetch({
      onCheckout: () => ({
        order_id: 'ord_555555555555',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
        status: 'pending',
        provider: 'nowpayments',
        payment_address: '0x123456789',
        pay_currency: 'usdt',
        pay_amount: null,
        created_at: '2026-05-11T10:00:00.000Z',
      }),
    });
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/Do not send funds/i);
    expect(screen.queryByText('0x123456789')).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy payment address/i })).toBeNull();
  });

  it('fails closed when NowPayments has not returned payment instructions yet', async () => {
    setupFetch({
      onCheckout: () => ({
        order_id: 'ord_555555555555',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
        status: 'pending',
        provider: 'nowpayments',
        payment_address: null,
        pay_currency: null,
        pay_amount: null,
        created_at: '2026-05-11T10:00:00.000Z',
      }),
      onOrder: () => ({
        order_id: 'ord_555555555555',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
        payment_id: 'pay_waiting',
        status: 'pending',
        expires_at: '2099-05-11T11:00:00.000Z',
        created_at: '2026-05-11T10:00:00.000Z',
        updated_at: '2026-05-11T10:01:00.000Z',
      }),
    });
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByText(/instructions are not available yet/i)).toHaveTextContent(
      /review Orders or contact billing/i,
    );
    expect(screen.queryByText(/retry this checkout/i)).toBeNull();
    expect(screen.queryByRole('button', { name: /Start another checkout/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy payment address/i })).toBeNull();
  });

  it('hides payment instructions until an exact live poll and hides them again on poll error', async () => {
    let resolveInitialPoll: ((response: Response) => void) | undefined;
    const initialPoll = new Promise<Response>((resolve) => {
      resolveInitialPoll = resolve;
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/quote')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'USD',
            }),
        } as Response);
      }
      if (url.endsWith('/v1/billing/crypto-checkout')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              order_id: 'ord_bbbbbbbbbbbb',
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'USD',
              status: 'pending',
              provider: 'nowpayments',
              payment_address: '0xlive-only',
              pay_currency: 'usdt',
              pay_amount: 25,
              created_at: '2026-05-11T10:00:00.000Z',
            }),
        } as Response);
      }
      const authorization = (init?.headers as Record<string, string> | undefined)?.authorization;
      if (authorization === 'Bearer sk_changed') {
        return Promise.resolve({
          ok: false,
          status: 503,
          json: () => Promise.resolve({}),
        } as Response);
      }
      return initialPoll;
    });
    vi.stubGlobal('fetch', fetchMock);
    const view = render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByText(/latest order status is confirmed/i)).toBeInTheDocument();
    expect(screen.queryByText('0xlive-only')).toBeNull();
    resolveInitialPoll?.({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          order_id: 'ord_bbbbbbbbbbbb',
          product: 'solo_manual',
          price_cents: 2500,
          price_currency: 'USD',
          payment_id: 'pay_live',
          status: 'pending',
          expires_at: '2099-05-11T11:00:00.000Z',
          created_at: '2026-05-11T10:00:00.000Z',
          updated_at: '2026-05-11T10:01:00.000Z',
        }),
    } as Response);
    expect(await screen.findByText('0xlive-only')).toBeInTheDocument();

    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_changed', baseUrl: 'https://api.driftstack.dev' },
      accountMe: { id: 'acc_test' },
    });
    view.rerender(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText(/service is temporarily unavailable/i);
    expect(screen.queryByText('0xlive-only')).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy payment address/i })).toBeNull();
  });

  it('revokes payment instructions at expires_at without waiting for another poll', async () => {
    const deadline = Date.now() + 750;
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    setupFetch({
      onCheckout: () => ({
        order_id: 'ord_cccccccccccc',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
        status: 'pending',
        provider: 'nowpayments',
        payment_address: '0xexpires',
        pay_currency: 'usdt',
        pay_amount: 25,
        created_at: '2026-05-11T10:00:00.000Z',
      }),
      onOrder: () => ({
        order_id: 'ord_cccccccccccc',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
        payment_id: 'pay_expiring',
        status: 'pending',
        expires_at: new Date(deadline).toISOString(),
        created_at: '2026-05-11T10:00:00.000Z',
        updated_at: '2026-05-11T10:01:00.000Z',
      }),
    });
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByText('0xexpires')).toBeInTheDocument();
    const copy = screen.getByRole('button', { name: /Copy payment address/i });
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(deadline + 1);
    fireEvent.click(copy);
    expect(writeText).not.toHaveBeenCalled();
    nowSpy.mockRestore();
    expect(
      await screen.findByText(/payment window .* expired/i, {}, { timeout: 2_000 }),
    ).toBeInTheDocument();
    expect(screen.queryByText('0xexpires')).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy payment address/i })).toBeNull();
  });

  it.each(['confirming', 'partial', 'paid', 'failed', 'cancelled'] as const)(
    'revokes stale payment instructions when the live order becomes %s',
    async (status) => {
      setupFetch({
        onCheckout: () => ({
          order_id: 'ord_666666666666',
          product: 'solo_manual',
          price_cents: 2500,
          price_currency: 'USD',
          status: 'pending',
          provider: 'nowpayments',
          payment_address: '0xdo-not-pay-again',
          pay_currency: 'usdt',
          pay_amount: 25,
          created_at: '2026-05-11T10:00:00.000Z',
        }),
        onOrder: () => ({
          order_id: 'ord_666666666666',
          product: 'solo_manual',
          price_cents: 2500,
          price_currency: 'USD',
          payment_id: 'payment_terminal',
          status,
          created_at: '2026-05-11T10:00:00.000Z',
          updated_at: '2026-05-11T10:01:00.000Z',
        }),
      });
      render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
      await screen.findByText('25.00 USD');
      fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));

      expect(await screen.findByText(new RegExp(`order is ${status}`, 'i'))).toBeInTheDocument();
      expect(screen.queryByText('0xdo-not-pay-again')).toBeNull();
      expect(screen.queryByRole('button', { name: /Copy payment address/i })).toBeNull();
      expect(screen.getByText(/Do not send more funds/i)).toBeInTheDocument();
    },
  );

  it('never re-exposes funds controls when a later poll regresses confirming to pending', async () => {
    let pollCount = 0;
    setupFetch({
      onCheckout: () => ({
        order_id: 'ord_dddddddddddd',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
        status: 'pending',
        provider: 'nowpayments',
        payment_address: '0xnever-again',
        pay_currency: 'usdt',
        pay_amount: 25,
        created_at: '2026-05-11T10:00:00.000Z',
      }),
      onOrder: () => {
        pollCount += 1;
        return {
          order_id: 'ord_dddddddddddd',
          product: 'solo_manual',
          price_cents: 2500,
          price_currency: 'USD',
          payment_id: 'pay_monotonic',
          status: pollCount === 1 ? 'confirming' : 'pending',
          expires_at: '2099-05-11T11:00:00.000Z',
          created_at: '2026-05-11T10:00:00.000Z',
          updated_at: '2026-05-11T10:01:00.000Z',
        };
      },
    });
    const rendered = render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByText(/order is confirming/i)).toBeInTheDocument();

    useSettingsMock.mockReturnValue({
      settings: { apiKey: 'sk_changed', baseUrl: 'https://api.driftstack.dev' },
      accountMe: { id: 'acc_test' },
    });
    rendered.rerender(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await waitFor(() => expect(pollCount).toBeGreaterThanOrEqual(2));
    expect(screen.getByText(/order is confirming/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/Crypto order status: Confirming/i)).toBeInTheDocument();
    expect(screen.queryByText('0xnever-again')).toBeNull();
    expect(screen.queryByRole('button', { name: /Copy payment address/i })).toBeNull();
  });

  it.each(['confirming', 'paid', 'failed'] as const)(
    'does not mislabel a replayed %s stub posture as provider unavailability',
    async (status) => {
      setupFetch({
        onCheckout: () => ({
          order_id: 'ord_777777777777',
          product: 'solo_manual',
          price_cents: 2500,
          price_currency: 'USD',
          status,
          provider: 'stub',
          payment_address: null,
          pay_currency: null,
          pay_amount: null,
          created_at: '2026-05-11T10:00:00.000Z',
        }),
        onOrder: () => ({
          order_id: 'ord_777777777777',
          product: 'solo_manual',
          price_cents: 2500,
          price_currency: 'USD',
          payment_id: 'payment_nonpending',
          status,
          created_at: '2026-05-11T10:00:00.000Z',
          updated_at: '2026-05-11T10:01:00.000Z',
        }),
      });
      render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
      await screen.findByText('25.00 USD');
      fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
      expect(await screen.findByText(new RegExp(`order is ${status}`, 'i'))).toBeInTheDocument();
      expect(screen.queryByText(/Crypto checkout is unavailable/i)).toBeNull();
    },
  );

  it('does not apply a terminal poll snapshot from the previous order to a fresh checkout', async () => {
    let checkoutCount = 0;
    let resolveNewPoll!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        if (url.endsWith('/quote')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                product: 'solo_manual',
                price_cents: 2500,
                price_currency: 'USD',
              }),
          } as unknown as Response);
        }
        if (url.endsWith('/v1/billing/crypto-checkout')) {
          checkoutCount += 1;
          const suffix = checkoutCount === 1 ? 'old' : 'new';
          const checkoutOrderId = checkoutCount === 1 ? 'ord_888888888888' : 'ord_999999999999';
          return Promise.resolve({
            ok: true,
            status: 201,
            headers: new Headers(),
            json: () =>
              Promise.resolve({
                order_id: checkoutOrderId,
                product: 'solo_manual',
                price_cents: 2500,
                price_currency: 'USD',
                status: 'pending',
                provider: 'nowpayments',
                payment_address: `0x${suffix}`,
                pay_currency: 'usdt',
                pay_amount: 25,
                created_at: '2026-05-11T10:00:00.000Z',
              }),
          } as unknown as Response);
        }
        const old = url.endsWith('/ord_888888888888');
        if (!old) {
          return new Promise<Response>((resolve) => {
            resolveNewPoll = resolve;
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              order_id: 'ord_888888888888',
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'USD',
              payment_id: 'pay_old',
              status: 'paid',
              created_at: '2026-05-11T10:00:00.000Z',
              updated_at: '2026-05-11T10:01:00.000Z',
            }),
        } as unknown as Response);
      }),
    );
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByText(/order is paid/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Start another checkout/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Start checkout/i }));
    expect(await screen.findByText('ord_999999999999')).toBeInTheDocument();
    expect(screen.queryByText('0xnew')).toBeNull();
    expect(screen.queryByText(/order is paid/i)).toBeNull();
    expect(screen.queryByLabelText(/Crypto order status: Paid/i)).toBeNull();
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    resolveNewPoll({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          order_id: 'ord_999999999999',
          product: 'solo_manual',
          price_cents: 2500,
          price_currency: 'USD',
          payment_id: 'pay_new',
          status: 'pending',
          expires_at: '2099-05-11T11:00:00.000Z',
          created_at: '2026-05-11T10:00:00.000Z',
          updated_at: '2026-05-11T10:01:00.000Z',
        }),
    } as unknown as Response);
    expect(await screen.findByText('0xnew')).toBeInTheDocument();
  });

  it('ignores an old pending copy after unmount and resets copy state on remount', async () => {
    setupFetch({
      onCheckout: () => ({
        order_id: 'ord_111111111111',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'USD',
        status: 'pending',
        provider: 'nowpayments',
        payment_address: '0x123456789',
        pay_currency: 'usdt',
        pay_amount: 25,
        created_at: '2026-05-11T10:00:00.000Z',
      }),
    });
    let resolveWrite: (() => void) | undefined;
    const pendingWrite = new Promise<void>((resolvePromise) => {
      resolveWrite = resolvePromise;
    });
    const writeText = vi
      .fn<() => Promise<void>>()
      .mockImplementationOnce(() => pendingWrite)
      .mockResolvedValue(undefined);
    vi.stubGlobal('navigator', { clipboard: { writeText } });
    const first = render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Copy payment address/i }));
    expect(screen.getByText('Copying…')).toBeInTheDocument();

    first.unmount();
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    const nextCopy = await screen.findByRole('button', { name: /Copy payment address/i });
    resolveWrite?.();
    await Promise.resolve();
    expect(screen.queryByText('Copied ✓')).not.toBeInTheDocument();

    expect(nextCopy).toHaveTextContent('Copy');
    expect((nextCopy as HTMLButtonElement).disabled).toBe(false);
    expect(nextCopy).toHaveAttribute('aria-busy', 'false');
    fireEvent.click(nextCopy);
    expect(await screen.findByText('Copied ✓')).toBeInTheDocument();
    expect(writeText).toHaveBeenCalledTimes(2);
  });

  it('does not submit a new product with the previous product quote', async () => {
    let resolveTeamQuote: ((response: Response) => void) | undefined;
    const heldTeamQuote = new Promise<Response>((resolve) => {
      resolveTeamQuote = resolve;
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (url.endsWith('/quote')) {
        const body = parseJsonRequestBody(init);
        if (body.product === 'team_manual') return heldTeamQuote;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'USD',
            }),
        } as Response);
      }
      if (url.endsWith('/v1/billing/crypto-checkout')) {
        return Promise.resolve({
          ok: true,
          status: 201,
          headers: new Headers(),
          json: () =>
            Promise.resolve({
              order_id: 'ord_aaaaaaaaaaaa',
              product: 'team_manual',
              price_cents: 5000,
              price_currency: 'USD',
              status: 'pending',
              provider: 'stub',
              payment_address: null,
              pay_currency: null,
              pay_amount: null,
              created_at: '2026-05-11T10:00:00.000Z',
            }),
        } as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            order_id: 'ord_aaaaaaaaaaaa',
            product: 'team_manual',
            price_cents: 5000,
            price_currency: 'USD',
            payment_id: null,
            status: 'pending',
            created_at: '2026-05-11T10:00:00.000Z',
            updated_at: '2026-05-11T10:00:00.000Z',
          }),
      } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 USD');

    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'team_manual' } });
    const start = screen.getByRole('button', { name: /Start checkout/i });
    expect(start).toBeDisabled();
    fireEvent.click(start);
    expect(
      fetchMock.mock.calls.filter(([url]) => url.endsWith('/v1/billing/crypto-checkout')),
    ).toHaveLength(0);

    resolveTeamQuote?.({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          product: 'team_manual',
          price_cents: 5000,
          price_currency: 'USD',
        }),
    } as Response);
    await screen.findByText('50.00 USD');
    expect(start).not.toBeDisabled();
    fireEvent.click(start);

    await waitFor(() => {
      expect(
        fetchMock.mock.calls.filter(([url]) => url.endsWith('/v1/billing/crypto-checkout')),
      ).toHaveLength(1);
    });
    const checkoutCall = fetchMock.mock.calls.find(([url]) =>
      url.endsWith('/v1/billing/crypto-checkout'),
    );
    expect(parseJsonRequestBody(checkoutCall?.[1])).toEqual({
      product: 'team_manual',
      price_cents: 5000,
      price_currency: 'USD',
    });
  });
});
