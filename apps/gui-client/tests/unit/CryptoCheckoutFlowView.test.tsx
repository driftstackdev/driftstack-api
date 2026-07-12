// V-534.AC — unit tests for CryptoCheckoutFlowView.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { CryptoCheckoutFlowView } = await import('../../src/views/CryptoCheckoutFlowView');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
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
              price_currency: 'EUR',
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
              order_id: 'ord_new',
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'EUR',
              status: 'pending',
              provider: 'stub',
              payment_address: null,
              pay_currency: null,
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
            order_id: 'ord_new',
            product: 'solo_manual',
            price_cents: 2500,
            price_currency: 'EUR',
            payment_id: null,
            status: 'pending',
            created_at: '2026-05-11T10:00:00.000Z',
            updated_at: '2026-05-11T10:00:00.000Z',
          },
        ),
    } as unknown as Response);
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('V-534.AC CryptoCheckoutFlowView', () => {
  it('renders the quote price after mount', async () => {
    setupFetch({});
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await waitFor(() => {
      expect(screen.getByText('25.00 EUR')).toBeTruthy();
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
      expect(screen.getByText('25.00 EUR')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    await waitFor(() => {
      expect(screen.getByText('ord_new')).toBeTruthy();
    });
    // The checkout POST was made.
    const checkoutPosts = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/v1/billing/crypto-checkout'),
    );
    expect(checkoutPosts.length).toBe(1);
  });

  it('shows the "stub provider" support hint when provider=stub', async () => {
    setupFetch({});
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await waitFor(() => {
      expect(screen.getByText('25.00 EUR')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    await waitFor(() => {
      expect(screen.getByText(/stub mode/i)).toBeTruthy();
    });
  });

  it('surfaces payment-address clipboard denial and offers an explicit retry', async () => {
    setupFetch({
      onCheckout: () => ({
        order_id: 'ord_new',
        product: 'solo_manual',
        price_cents: 2500,
        price_currency: 'EUR',
        status: 'pending',
        provider: 'nowpayments',
        payment_address: '0x123456789',
        pay_currency: 'usdt',
        created_at: '2026-05-11T10:00:00.000Z',
      }),
    });
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await screen.findByText('25.00 EUR');
    fireEvent.click(screen.getByRole('button', { name: /Start checkout/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Copy payment address/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/clipboard permission/i);
    expect(screen.getByRole('button', { name: /Retry copy/i })).toBeInTheDocument();
  });

  it('refetches the quote when the product selector changes', async () => {
    const fetchMock = setupFetch({});
    render(<CryptoCheckoutFlowView defaultProduct="solo_manual" />);
    await waitFor(() => {
      expect(screen.getByText('25.00 EUR')).toBeTruthy();
    });
    const initialQuoteCalls = fetchMock.mock.calls.filter(
      ([url]) => typeof url === 'string' && url.endsWith('/quote'),
    ).length;
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'team_manual' } });
    await waitFor(() => {
      const after = fetchMock.mock.calls.filter(
        ([url]) => typeof url === 'string' && url.endsWith('/quote'),
      ).length;
      expect(after).toBeGreaterThan(initialQuoteCalls);
    });
  });
});
