// V-534.X — unit tests for CryptoOrdersHistoryView.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import type { CryptoOrderData } from '../../src/lib/use-crypto-order';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { CryptoOrdersHistoryView } = await import('../../src/views/CryptoOrdersHistoryView');

function sample(overrides: Partial<CryptoOrderData> = {}): CryptoOrderData {
  return {
    order_id: 'ord_abc123',
    product: 'solo_manual',
    price_cents: 2500,
    price_currency: 'EUR',
    payment_id: null,
    status: 'pending',
    created_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    updated_at: new Date().toISOString(),
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
});

describe('V-534.X CryptoOrdersHistoryView', () => {
  it('renders the empty state when the order list is empty', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ orders: [] }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView />);
    await waitFor(() => {
      expect(screen.getByText(/No crypto orders yet/i)).toBeTruthy();
    });
  });

  it('renders one row per order with status badges + formatted price', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                sample({ order_id: 'ord_p1', status: 'pending', price_cents: 2500 }),
                sample({
                  order_id: 'ord_p2',
                  status: 'paid',
                  price_cents: 8000,
                  price_currency: 'EUR',
                }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView />);
    await waitFor(() => {
      expect(screen.getByText('ord_p1')).toBeTruthy();
      expect(screen.getByText('ord_p2')).toBeTruthy();
    });
    expect(screen.getByText('25.00 EUR')).toBeTruthy();
    expect(screen.getByText('80.00 EUR')).toBeTruthy();
    // The status-badge label for paid is "Paid".
    expect(screen.getByText('Paid')).toBeTruthy();
    expect(screen.getByText('Awaiting payment')).toBeTruthy();
  });

  it('shows an error banner when the fetch fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView />);
    await waitFor(() => {
      // ErrorBanner renders the message text somewhere visible.
      expect(screen.getByText(/HTTP 500/)).toBeTruthy();
    });
  });

  it('disables the Refresh button while loading', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise(() => {
            // never resolves — keep the hook in loading state
          }),
      ),
    );
    render(<CryptoOrdersHistoryView />);
    const button = screen.getByRole('button', { name: /loading/i });
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });
});
