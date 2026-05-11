// V-534.AG — unit tests for CryptoOrdersAdminView.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { CryptoOrdersAdminView } = await import('../../src/views/CryptoOrdersAdminView');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_admin', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeOrder(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: 'ord_one',
    account_id: 'acc_buyer',
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

describe('V-534.AG CryptoOrdersAdminView', () => {
  it('renders rows + shows the account_id column', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                makeOrder({ order_id: 'ord_a', account_id: 'acc_a' }),
                makeOrder({ order_id: 'ord_b', account_id: null }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    await waitFor(() => {
      expect(screen.getByText('ord_a')).toBeTruthy();
      expect(screen.getByText('ord_b')).toBeTruthy();
    });
    expect(screen.getByText('acc_a')).toBeTruthy();
    // Null account_id renders as "—".
    expect(screen.getByText('—')).toBeTruthy();
  });

  it('refetches with status= when the status filter changes', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersAdminView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Status/i), { target: { value: 'paid' } });
    await waitFor(() => {
      expect(
        (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
          ([u]) => typeof u === 'string' && u.includes('status=paid'),
        ),
      ).toBe(true);
    });
  });

  it('refetches with search= when the search box changes', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ orders: [] }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersAdminView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Search/i), { target: { value: 'PO-99' } });
    await waitFor(() => {
      expect(
        (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
          ([u]) => typeof u === 'string' && u.includes('search=PO-99'),
        ),
      ).toBe(true);
    });
  });

  it('surfaces a 403 as an error banner (non-admin caller)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 403,
          json: () => Promise.resolve({}),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    await waitFor(() => {
      expect(screen.getByText(/HTTP 403/)).toBeTruthy();
    });
  });

  it('renders the empty-state message when no orders match the filters', async () => {
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
    render(<CryptoOrdersAdminView />);
    await waitFor(() => {
      expect(screen.getByText(/No orders match/i)).toBeTruthy();
    });
  });
});
