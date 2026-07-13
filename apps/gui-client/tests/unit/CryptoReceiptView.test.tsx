// V-534.AB — unit tests for CryptoReceiptView.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { CryptoReceiptView } = await import('../../src/views/CryptoReceiptView');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.AB CryptoReceiptView', () => {
  it('renders the empty state when orderId is null', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoReceiptView orderId={null} />);
    expect(screen.getByText(/Pick an order/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows a loading message while the receipt is fetching', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            // never resolves
          }),
      ),
    );
    render(<CryptoReceiptView orderId="ord_x" />);
    expect(screen.getByText(/Loading receipt/i)).toBeTruthy();
  });

  it('renders receipt fields + copy button on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              order_id: 'ord_42',
              issued_at: '2026-05-11T10:00:00.000Z',
              status: 'paid',
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'EUR',
              payment_id: 'np_x',
              paid_at: '2026-05-11T09:55:00.000Z',
              created_at: '2026-05-11T09:00:00.000Z',
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoReceiptView orderId="ord_42" />);
    await waitFor(() => {
      expect(screen.getByText('ord_42')).toBeTruthy();
    });
    expect(screen.getByText('25.00 EUR')).toBeTruthy();
    expect(screen.getByText('np_x')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Copy to clipboard/i })).toBeTruthy();
  });

  it('clicking Copy invokes navigator.clipboard.writeText with the formatted receipt', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              order_id: 'ord_42',
              issued_at: '2026-05-11T10:00:00.000Z',
              status: 'paid',
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'EUR',
              payment_id: 'np_x',
              paid_at: '2026-05-11T09:55:00.000Z',
              created_at: '2026-05-11T09:00:00.000Z',
            }),
        } as unknown as Response),
      ),
    );
    const writeTextMock = vi.fn(() => Promise.resolve());
    vi.stubGlobal('navigator', { clipboard: { writeText: writeTextMock } });
    render(<CryptoReceiptView orderId="ord_42" />);
    const btn = await waitFor(() => screen.getByRole('button', { name: /Copy to clipboard/i }));
    fireEvent.click(btn);
    await waitFor(() => expect(writeTextMock).toHaveBeenCalled());
    const text = writeTextMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('Order: ord_42');
    expect(text).toContain('Amount: 25.00 EUR');
  });

  it('surfaces clipboard denial and turns the action into an explicit retry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              order_id: 'ord_42',
              issued_at: '2026-05-11T10:00:00.000Z',
              status: 'paid',
              product: 'solo_manual',
              price_cents: 2500,
              price_currency: 'EUR',
              payment_id: null,
              paid_at: '2026-05-11T09:55:00.000Z',
              created_at: '2026-05-11T09:00:00.000Z',
            }),
        } as unknown as Response),
      ),
    );
    vi.stubGlobal('navigator', {
      clipboard: { writeText: vi.fn(() => Promise.reject(new Error('denied'))) },
    });
    render(<CryptoReceiptView orderId="ord_42" />);
    fireEvent.click(await screen.findByRole('button', { name: /Copy to clipboard/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/clipboard permission/i);
    expect(screen.getByRole('button', { name: /Retry copy/i })).toBeInTheDocument();
  });

  it('renders the error banner on HTTP failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    render(<CryptoReceiptView orderId="ord_missing" />);
    await waitFor(() => {
      expect(screen.getByText(/requested item was not found/i)).toBeTruthy();
    });
  });
});
