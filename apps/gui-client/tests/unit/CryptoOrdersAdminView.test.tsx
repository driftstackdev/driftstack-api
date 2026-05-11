// V-534.AG — unit tests for CryptoOrdersAdminView.
// V-534.AK — extended for refund-request action button + confirmation modal.
// V-534.AL — extended for internal-note editor.
// V-534.AM — extended for row-click → detail-drawer wiring.

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

describe('V-534.AK CryptoOrdersAdminView — refund-request action', () => {
  it('shows the "Request refund" button only for paid orders without an outstanding refund', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                makeOrder({ order_id: 'ord_paid', status: 'paid' }),
                makeOrder({ order_id: 'ord_pending', status: 'pending' }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    await waitFor(() => {
      expect(screen.getByText('ord_paid')).toBeTruthy();
    });
    const buttons = screen.getAllByRole('button', { name: /Request refund/i });
    expect(buttons).toHaveLength(1);
  });

  it('shows the "Refund pending" pill + Clear button when refund_requested_at is set', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                makeOrder({
                  order_id: 'ord_refunding',
                  status: 'paid',
                  refund_requested_at: '2026-05-11T10:00:00.000Z',
                  refund_reason: 'duplicate payment',
                }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    await waitFor(() => {
      expect(screen.getByText(/Refund pending/i)).toBeTruthy();
    });
    expect(
      screen.getByRole('button', { name: /Cancel refund request for ord_refunding/i }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Request refund/i })).toBeNull();
  });

  it('clicking "Request refund" opens the confirmation modal with the order_id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [makeOrder({ order_id: 'ord_paid', status: 'paid' })],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    const btn = await waitFor(() => screen.getByRole('button', { name: /Request refund/i }));
    fireEvent.click(btn);
    const dialog = screen.getByRole('dialog', { name: /Confirm refund request/i });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toContain('ord_paid');
  });

  it('Confirm refund button is disabled until a reason is entered', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [makeOrder({ order_id: 'ord_paid', status: 'paid' })],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    const btn = await waitFor(() => screen.getByRole('button', { name: /Request refund/i }));
    fireEvent.click(btn);
    const confirm = screen.getByRole('button', { name: /Confirm refund/i });
    expect((confirm as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: 'Customer charged in error' },
    });
    expect((confirm as HTMLButtonElement).disabled).toBe(false);
  });

  it('Cancel button closes the modal without firing a request', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [makeOrder({ order_id: 'ord_paid', status: 'paid' })],
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersAdminView />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Request refund/i })));
    const cancelBtn = screen.getByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelBtn);
    expect(screen.queryByRole('dialog')).toBeNull();
    const postCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(postCalls).toHaveLength(0);
  });

  it('Confirm refund POSTs to /request-refund with the reason', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/request-refund')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeOrder({
                order_id: 'ord_paid',
                status: 'paid',
                refund_requested_at: '2026-05-11T10:00:00.000Z',
                refund_reason: 'Duplicate payment',
              }),
            ),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [makeOrder({ order_id: 'ord_paid', status: 'paid' })],
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersAdminView />);
    fireEvent.click(await waitFor(() => screen.getByRole('button', { name: /Request refund/i })));
    fireEvent.change(screen.getByLabelText(/Reason/i), {
      target: { value: 'Duplicate payment' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Confirm refund/i }));
    await waitFor(() => {
      const refundCalls = fetchMock.mock.calls.filter(
        ([u, init]) =>
          typeof u === 'string' && u.endsWith('/request-refund') && init?.method === 'POST',
      );
      expect(refundCalls.length).toBeGreaterThan(0);
      const body = JSON.parse((refundCalls[0]?.[1] as RequestInit).body as string) as {
        reason: string;
      };
      expect(body.reason).toBe('Duplicate payment');
    });
  });

  it('Clear refund fires POST /cancel-refund-request', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'POST' && url.endsWith('/cancel-refund-request')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeOrder({ order_id: 'ord_r', status: 'paid' })),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [
              makeOrder({
                order_id: 'ord_r',
                status: 'paid',
                refund_requested_at: '2026-05-11T10:00:00.000Z',
                refund_reason: 'something',
              }),
            ],
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersAdminView />);
    const btn = await waitFor(() =>
      screen.getByRole('button', { name: /Cancel refund request for ord_r/i }),
    );
    fireEvent.click(btn);
    await waitFor(() => {
      expect(
        fetchMock.mock.calls.some(
          ([u, init]) =>
            typeof u === 'string' &&
            u.endsWith('/cancel-refund-request') &&
            init?.method === 'POST',
        ),
      ).toBe(true);
    });
  });
});

describe('V-534.AL CryptoOrdersAdminView — internal note editor', () => {
  it('shows "Add note" when no internal_note is set + "Edit note" when one exists', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                makeOrder({ order_id: 'ord_blank', status: 'pending' }),
                makeOrder({
                  order_id: 'ord_noted',
                  status: 'pending',
                  internal_note: 'watch this',
                }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    await waitFor(() => {
      expect(screen.getByText('ord_blank')).toBeTruthy();
    });
    expect(
      screen.getByRole('button', { name: /Edit internal note for ord_blank/i }).textContent,
    ).toContain('Add note');
    expect(
      screen.getByRole('button', { name: /Edit internal note for ord_noted/i }).textContent,
    ).toContain('Edit note');
  });

  it('clicking the button opens the editor pre-filled with the current value', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [
                makeOrder({
                  order_id: 'ord_n',
                  status: 'pending',
                  internal_note: 'existing context',
                }),
              ],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /Edit internal note for ord_n/i })),
    );
    const dialog = screen.getByRole('dialog', { name: /Edit internal note/i });
    expect(dialog).toBeTruthy();
    const textarea = dialog.querySelector('textarea');
    expect(textarea?.value).toBe('existing context');
  });

  it('Save sends PATCH /internal-note with the entered text', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' && url.endsWith('/internal-note')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeOrder({
                order_id: 'ord_n',
                status: 'pending',
                internal_note: 'support runbook applied',
              }),
            ),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [makeOrder({ order_id: 'ord_n', status: 'pending' })],
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersAdminView />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /Edit internal note for ord_n/i })),
    );
    const dialog = screen.getByRole('dialog', { name: /Edit internal note/i });
    const textarea = dialog.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: 'support runbook applied' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([u, init]) =>
          typeof u === 'string' && u.endsWith('/internal-note') && init?.method === 'PATCH',
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse((patchCalls[0]?.[1] as RequestInit).body as string) as {
        internal_note: string | null;
      };
      expect(body.internal_note).toBe('support runbook applied');
    });
  });

  it('Save with empty textarea sends internal_note=null (clear)', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'PATCH' && url.endsWith('/internal-note')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeOrder({ order_id: 'ord_n', status: 'pending', internal_note: null }),
            ),
        } as unknown as Response);
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [
              makeOrder({
                order_id: 'ord_n',
                status: 'pending',
                internal_note: 'to be cleared',
              }),
            ],
          }),
      } as unknown as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersAdminView />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /Edit internal note for ord_n/i })),
    );
    const dialog = screen.getByRole('dialog', { name: /Edit internal note/i });
    const textarea = dialog.querySelector('textarea') as HTMLTextAreaElement;
    fireEvent.change(textarea, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: /Save/i }));
    await waitFor(() => {
      const patchCalls = fetchMock.mock.calls.filter(
        ([u, init]) =>
          typeof u === 'string' && u.endsWith('/internal-note') && init?.method === 'PATCH',
      );
      expect(patchCalls.length).toBeGreaterThan(0);
      const body = JSON.parse((patchCalls[0]?.[1] as RequestInit).body as string) as {
        internal_note: string | null;
      };
      expect(body.internal_note).toBeNull();
    });
  });

  it('Cancel closes the modal without firing a PATCH', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () =>
          Promise.resolve({
            orders: [makeOrder({ order_id: 'ord_n', status: 'pending' })],
          }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersAdminView />);
    fireEvent.click(
      await waitFor(() => screen.getByRole('button', { name: /Edit internal note for ord_n/i })),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: /Edit internal note/i })).toBeNull();
    const patchCalls = fetchMock.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(patchCalls).toHaveLength(0);
  });
});

describe('V-534.AM CryptoOrdersAdminView — row click opens detail drawer', () => {
  it('clicking a row opens the detail drawer for that order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [makeOrder({ order_id: 'ord_open', status: 'paid' })],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    const cell = await waitFor(() => screen.getByText('ord_open'));
    const row = cell.closest('tr');
    expect(row).not.toBeNull();
    fireEvent.click(row!);
    expect(screen.getByLabelText('Order detail for ord_open')).toBeTruthy();
    expect(row?.getAttribute('aria-selected')).toBe('true');
  });

  it('clicking an action button does NOT open the drawer (stopPropagation)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [makeOrder({ order_id: 'ord_no_drawer', status: 'pending' })],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    await waitFor(() => {
      expect(screen.getByText('ord_no_drawer')).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /Edit internal note for ord_no_drawer/i }));
    expect(screen.queryByLabelText('Order detail for ord_no_drawer')).toBeNull();
  });

  it('Close button on the drawer dismisses it', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              orders: [makeOrder({ order_id: 'ord_close', status: 'paid' })],
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersAdminView />);
    const cell = await waitFor(() => screen.getByText('ord_close'));
    fireEvent.click(cell.closest('tr')!);
    expect(screen.getByLabelText('Order detail for ord_close')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Close order detail/i }));
    expect(screen.queryByLabelText('Order detail for ord_close')).toBeNull();
  });
});
