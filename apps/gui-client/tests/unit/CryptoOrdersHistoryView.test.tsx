// V-534.X — unit tests for CryptoOrdersHistoryView.
// V-534.Z — extended for per-row cancel button.
// V-534.AE — extended for row-selection → detail-view side panel.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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

describe('V-534.Z CryptoOrdersHistoryView — cancel button', () => {
  it('shows a Cancel button only for pending rows', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                sample({ order_id: 'ord_pending', status: 'pending' }),
                sample({ order_id: 'ord_paid', status: 'paid' }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView />);
    await waitFor(() => {
      expect(screen.getByText('ord_pending')).toBeTruthy();
    });
    expect(screen.getByRole('button', { name: /Cancel order ord_pending/i })).toBeTruthy();
    // Paid row should NOT have a Cancel button.
    expect(screen.queryByRole('button', { name: /Cancel order ord_paid/i })).toBeNull();
  });

  it('clicking Cancel POSTs to the cancel endpoint + refreshes on success', async () => {
    let listResponse = {
      orders: [sample({ order_id: 'ord_clickme', status: 'pending' as const })],
    };
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (typeof url === 'string' && url.endsWith('/cancel') && method === 'POST') {
        listResponse = {
          orders: [sample({ order_id: 'ord_clickme', status: 'cancelled' as const })],
        };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              order_id: 'ord_clickme',
              status: 'cancelled',
            }),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(listResponse),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersHistoryView />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Cancel order ord_clickme/i })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Cancel order ord_clickme/i }));
    // After cancel resolves + refetch fires, the badge should flip.
    await waitFor(() => {
      expect(screen.getByText(/Cancelled/i)).toBeTruthy();
    });
    // Cancel POST was issued.
    const cancelCalls = fetchMock.mock.calls.filter(
      ([url, init]) =>
        typeof url === 'string' && url.endsWith('/cancel') && init?.method === 'POST',
    );
    expect(cancelCalls.length).toBe(1);
  });
});

describe('V-534.AE CryptoOrdersHistoryView — row selection opens detail', () => {
  it('shows the detail-view empty state until a row is clicked', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [sample({ order_id: 'ord_one', status: 'pending' })],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView />);
    await waitFor(() => {
      expect(screen.getByText('ord_one')).toBeTruthy();
    });
    // Empty-state copy from CryptoOrderDetailView.
    expect(screen.getByText(/Pick an order to view its details/i)).toBeTruthy();
  });

  it('clicking a row fetches that order_id and marks the row as selected', async () => {
    const detailCalls: string[] = [];
    const fetchMock = vi.fn((url: string) => {
      if (typeof url === 'string' && url.includes('/v1/billing/crypto-orders/ord_pick')) {
        detailCalls.push(url);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              sample({
                order_id: 'ord_pick',
                status: 'pending',
                payment_id: null,
              }),
            ),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [
              sample({ order_id: 'ord_skip', status: 'pending' }),
              sample({ order_id: 'ord_pick', status: 'pending' }),
            ],
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersHistoryView />);
    const cell = await waitFor(() => screen.getByText('ord_pick'));
    const row = cell.closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    await waitFor(() => {
      expect(detailCalls.length).toBeGreaterThan(0);
    });
    // aria-selected reflects the picked row.
    expect(row?.getAttribute('aria-selected')).toBe('true');
  });

  it('clicking the Cancel button does NOT change the selected row', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (typeof url === 'string' && url.endsWith('/cancel') && method === 'POST') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(sample({ order_id: 'ord_cancel', status: 'cancelled' })),
        } as unknown as Response);
      }
      if (typeof url === 'string' && url.includes('/v1/billing/crypto-orders/ord_')) {
        // detail GET — return whichever id was asked for
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(sample({ order_id: 'ord_other', status: 'pending' })),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [sample({ order_id: 'ord_cancel', status: 'pending' })],
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersHistoryView />);
    const btn = await waitFor(() =>
      screen.getByRole('button', { name: /Cancel order ord_cancel/i }),
    );
    fireEvent.click(btn);
    // Row stays unselected (we stopped propagation on the cancel click).
    const row = screen.getByText('ord_cancel').closest('tr');
    expect(row?.getAttribute('aria-selected')).toBe('false');
  });
});
