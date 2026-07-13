// V-534.X — unit tests for CryptoOrdersHistoryView.
// V-534.Z — extended for per-row cancel button.
// V-534.AE — extended for row-selection → detail-view side panel.
// V-534.BG — extended for "Expires soon" pill on pending rows near
//            their pay-window deadline.

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

  it('V-534.BT — Load more button appears when next_cursor is non-null and appends rows', async () => {
    const { fireEvent } = await import('@testing-library/react');
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        call++;
        if (call === 1) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({
                orders: [
                  {
                    order_id: 'ord_p1',
                    product: 'solo_manual',
                    price_cents: 1499,
                    price_currency: 'USD',
                    payment_id: null,
                    status: 'paid',
                    created_at: '2026-05-11T00:00:00Z',
                    updated_at: '2026-05-11T00:00:00Z',
                  },
                ],
                next_cursor: 'cur_x',
              }),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                {
                  order_id: 'ord_p2',
                  product: 'solo_manual',
                  price_cents: 1499,
                  price_currency: 'USD',
                  payment_id: null,
                  status: 'paid',
                  created_at: '2026-05-10T00:00:00Z',
                  updated_at: '2026-05-10T00:00:00Z',
                },
              ],
              next_cursor: null,
            }),
        } as unknown as Response);
      }),
    );
    render(<CryptoOrdersHistoryView />);
    await waitFor(() => {
      expect(screen.getByText('ord_p1')).toBeTruthy();
    });
    const btn = screen.getByText('Load more');
    fireEvent.click(btn);
    await waitFor(() => {
      expect(screen.getByText('ord_p2')).toBeTruthy();
    });
    // First page still present (we appended, not replaced).
    expect(screen.getByText('ord_p1')).toBeTruthy();
    // Button gone now that next_cursor is null.
    expect(screen.queryByText('Load more')).toBeNull();
  });

  it('V-534.BS — auto-refreshes while any visible order is pending', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [
              {
                order_id: 'ord_pending_auto',
                product: 'solo_manual',
                price_cents: 1499,
                price_currency: 'USD',
                payment_id: null,
                status: 'pending',
                created_at: '2026-05-12T12:00:00Z',
                updated_at: '2026-05-12T12:00:00Z',
              },
            ],
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersHistoryView pendingRefreshMs={50} />);
    await waitFor(() => {
      expect(screen.getByText('ord_pending_auto')).toBeTruthy();
    });
    const before = fetchMock.mock.calls.length;
    await waitFor(
      () => {
        expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
      },
      { timeout: 500 },
    );
  });

  it('V-534.BR — empty state names the filter + offers Clear filter when status filter is active', async () => {
    const { fireEvent } = await import('@testing-library/react');
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
    const select = screen.getByLabelText('Filter by status');
    fireEvent.change(select, { target: { value: 'paid' } });
    await waitFor(() => {
      expect(screen.getByText(/No orders with status/)).toBeTruthy();
    });
    expect(screen.getByText('Clear filter')).toBeTruthy();
    fireEvent.click(screen.getByText('Clear filter'));
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
    // The status-badge label for paid is "Paid" — scope to the
    // table so we don't accidentally match the V-534.BQ status
    // filter dropdown option.
    const table = screen.getByRole('table');
    expect(table.textContent).toContain('Paid');
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
    // V-534.BJ — confirm modal opens; cancel fires only after explicit confirm.
    const confirmBtn = await waitFor(() => screen.getByRole('button', { name: /Confirm cancel/i }));
    fireEvent.click(confirmBtn);
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

  it('disables every cancel affordance while one order cancellation is pending', async () => {
    let releaseCancel: (response: Response) => void = () => {};
    const pendingCancel = new Promise<Response>((resolve) => {
      releaseCancel = resolve;
    });
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      if (typeof url === 'string' && url.endsWith('/cancel') && init?.method === 'POST') {
        return pendingCancel;
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [
              sample({ order_id: 'ord_first', status: 'pending' }),
              sample({ order_id: 'ord_second', status: 'pending' }),
            ],
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersHistoryView />);
    const first = await waitFor(() =>
      screen.getByRole('button', { name: /Cancel order ord_first/i }),
    );
    const second = screen.getByRole('button', { name: /Cancel order ord_second/i });

    fireEvent.click(first);
    fireEvent.click(await screen.findByRole('button', { name: /Confirm cancel/i }));
    await waitFor(() => expect(first).toBeDisabled());
    expect(first).toHaveTextContent('Cancelling…');
    expect(second).toBeDisabled();
    expect(second).toHaveTextContent('Cancel');
    expect(second).toHaveAttribute('title', 'Wait for the active order cancellation to finish.');

    fireEvent.click(second);
    expect(screen.queryByRole('dialog', { name: /Confirm order cancellation/i })).toBeNull();
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) =>
          typeof url === 'string' && url.endsWith('/cancel') && init?.method === 'POST',
      ),
    ).toHaveLength(1);

    releaseCancel({
      ok: true,
      status: 200,
      json: () => Promise.resolve(sample({ order_id: 'ord_first', status: 'cancelled' })),
    } as unknown as Response);
    await waitFor(() => expect(second).not.toBeDisabled());
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
    // aria-pressed reflects the picked row (the row is a role="button" toggle;
    // aria-selected isn't valid on a non-grid <tr> — see the view's a11y note).
    expect(row?.getAttribute('aria-pressed')).toBe('true');
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
    // V-534.BJ — the modal also contains the order_id text, so scope to <table>.
    const tableRow = screen.getByRole('table').querySelector('tr[aria-pressed]');
    expect(tableRow?.getAttribute('aria-pressed')).toBe('false');
  });
});

describe('V-534.BJ CryptoOrdersHistoryView — cancel confirmation modal', () => {
  it('V-534.BK pressing Escape closes the modal', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [sample({ order_id: 'ord_esc', status: 'pending' })],
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersHistoryView />);
    const btn = await waitFor(() => screen.getByRole('button', { name: /Cancel order ord_esc/i }));
    fireEvent.click(btn);
    expect(screen.getByRole('dialog', { name: /Confirm order cancellation/i })).toBeTruthy();
    fireEvent.keyDown(window, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: /Confirm order cancellation/i })).toBeNull();
  });

  it('V-534.BK traps focus on the safe action and restores the Cancel opener', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [sample({ order_id: 'ord_focus', status: 'pending' })],
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersHistoryView />);
    const btn = await waitFor(() =>
      screen.getByRole('button', { name: /Cancel order ord_focus/i }),
    );
    btn.focus();
    fireEvent.click(btn);
    const keepBtn = await waitFor(() => screen.getByRole('button', { name: /Keep order/i }));
    const confirmBtn = screen.getByRole('button', { name: /Confirm cancel/i });
    expect(document.activeElement).toBe(keepBtn);
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirmBtn);
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(document.activeElement).toBe(keepBtn);
    fireEvent.click(keepBtn);
    await waitFor(() => expect(document.activeElement).toBe(btn));
  });

  it('clicking Cancel opens a confirm modal; clicking Keep order closes it without firing', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [sample({ order_id: 'ord_confirm', status: 'pending' })],
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersHistoryView />);
    const btn = await waitFor(() =>
      screen.getByRole('button', { name: /Cancel order ord_confirm/i }),
    );
    fireEvent.click(btn);
    const dialog = screen.getByRole('dialog', { name: /Confirm order cancellation/i });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('non-refundable');
    fireEvent.click(screen.getByRole('button', { name: /Keep order/i }));
    expect(screen.queryByRole('dialog', { name: /Confirm order cancellation/i })).toBeNull();
    // No POST issued.
    const cancelCalls = fetchMock.mock.calls.filter((call) => {
      const url = call[0] as string;
      const init = call[1] as RequestInit | undefined;
      return typeof url === 'string' && url.endsWith('/cancel') && init?.method === 'POST';
    });
    expect(cancelCalls.length).toBe(0);
  });
});

describe('V-534.BG CryptoOrdersHistoryView — Expires soon pill', () => {
  it('renders the pill when a pending order has < 15 minutes left', async () => {
    const nowMs = new Date('2026-05-11T10:00:00.000Z').getTime();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                sample({
                  order_id: 'ord_close',
                  status: 'pending',
                  expires_at: '2026-05-11T10:10:00.000Z', // 10m to go
                }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView nowFn={() => nowMs} />);
    await waitFor(() => screen.getByText('ord_close'));
    expect(screen.getByLabelText('Expires soon')).toBeTruthy();
  });

  it('does NOT render the pill when more than 15 minutes remain', async () => {
    const nowMs = new Date('2026-05-11T10:00:00.000Z').getTime();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                sample({
                  order_id: 'ord_far',
                  status: 'pending',
                  expires_at: '2026-05-11T10:45:00.000Z', // 45m to go
                }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView nowFn={() => nowMs} />);
    await waitFor(() => screen.getByText('ord_far'));
    expect(screen.queryByLabelText('Expires soon')).toBeNull();
  });

  it('does NOT render the pill when status is not pending', async () => {
    const nowMs = new Date('2026-05-11T10:00:00.000Z').getTime();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                sample({
                  order_id: 'ord_paid',
                  status: 'paid',
                  expires_at: null,
                }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView nowFn={() => nowMs} />);
    await waitFor(() => screen.getByText('ord_paid'));
    expect(screen.queryByLabelText('Expires soon')).toBeNull();
  });

  it('does NOT render the pill when expires_at is already in the past (treated as elapsed)', async () => {
    const nowMs = new Date('2026-05-11T10:00:00.000Z').getTime();
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                sample({
                  order_id: 'ord_gone',
                  status: 'pending',
                  expires_at: '2026-05-11T09:30:00.000Z',
                }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersHistoryView nowFn={() => nowMs} />);
    await waitFor(() => screen.getByText('ord_gone'));
    expect(screen.queryByLabelText('Expires soon')).toBeNull();
  });
});
