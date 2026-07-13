// V-534.AD — unit tests for CryptoOrderDetailView.
// V-534.BE — appended tests for the inline events timeline.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

import { formatTimestamp } from '../../src/lib/crypto-format';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { CryptoOrderDetailView } = await import('../../src/views/CryptoOrderDetailView');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_test', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function orderPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    order_id: 'ord_42',
    product: 'solo_manual',
    price_cents: 2500,
    price_currency: 'EUR',
    payment_id: null,
    status: 'pending',
    created_at: '2026-05-11T09:00:00.000Z',
    updated_at: '2026-05-11T09:00:00.000Z',
    ...overrides,
  };
}

describe('V-534.AD CryptoOrderDetailView', () => {
  it('renders the empty state when orderId is null', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrderDetailView orderId={null} />);
    expect(screen.getByText(/Pick an order/i)).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('renders the loading state while fetching', () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => new Promise(() => undefined)),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    expect(screen.getByText(/Loading order/i)).toBeTruthy();
  });

  it('renders order details + offers Cancel for pending orders', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(orderPayload()),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    await waitFor(() => {
      expect(screen.getByText('ord_42')).toBeTruthy();
    });
    expect(screen.getByText('25.00 EUR')).toBeTruthy();
    expect(screen.getByRole('button', { name: /Cancel order/i })).toBeTruthy();
  });

  it('does not show Cancel once the order is confirming on-chain', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(orderPayload({ status: 'confirming' })),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    await waitFor(() => {
      expect(screen.getByText('ord_42')).toBeTruthy();
    });
    expect(screen.queryByRole('button', { name: /Cancel order/i })).toBeNull();
    expect(screen.getByText(/contact support/i)).toBeTruthy();
  });

  it('shows neither Cancel nor the payment-activity note for a cancelled order', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(orderPayload({ status: 'cancelled' })),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    await waitFor(() => {
      expect(screen.getByText('ord_42')).toBeTruthy();
    });
    // 'cancelled' is terminal with no payment received, so neither the
    // Cancel action nor the "payment activity detected" note applies.
    expect(screen.queryByRole('button', { name: /Cancel order/i })).toBeNull();
    expect(screen.queryByText(/Payment activity has been detected/i)).toBeNull();
  });

  it('shows the receipt inline when status is paid', async () => {
    let call = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string) => {
        call += 1;
        if (url.endsWith('/receipt')) {
          return Promise.resolve({
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
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              orderPayload({
                status: 'paid',
                payment_id: 'np_x',
              }),
            ),
        } as unknown as Response);
      }),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /Copy to clipboard/i })).toBeTruthy();
    });
    expect(call).toBeGreaterThan(1);
  });

  it('clicking Cancel fires POST /cancel and refetches the order', async () => {
    const calls: Array<{ url: string; method: string }> = [];
    let currentStatus = 'pending';
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init?: RequestInit) => {
        const method = init?.method ?? 'GET';
        calls.push({ url, method });
        if (method === 'POST' && url.endsWith('/cancel')) {
          currentStatus = 'pending'; // service returns the cancelled order; UI doesn't render that path here
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve(orderPayload({ status: 'failed' })),
          } as unknown as Response);
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(orderPayload({ status: currentStatus })),
        } as unknown as Response);
      }),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    const cancelBtn = await waitFor(() => screen.getByRole('button', { name: /Cancel order/i }));
    fireEvent.click(cancelBtn);
    const confirmBtn = await waitFor(() => screen.getByRole('button', { name: /Confirm cancel/i }));
    fireEvent.click(confirmBtn);
    await waitFor(() => {
      expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/cancel'))).toBe(true);
    });
    // Two GETs minimum: initial mount + refetch after cancel.
    await waitFor(() => {
      const gets = calls.filter((c) => c.method === 'GET');
      expect(gets.length).toBeGreaterThanOrEqual(2);
    });
  });

  it('traps cancellation focus and restores it to the opener when kept', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(orderPayload()),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    const opener = await waitFor(() => screen.getByRole('button', { name: /Cancel order/i }));
    opener.focus();
    fireEvent.click(opener);
    const keep = await waitFor(() => screen.getByRole('button', { name: /Keep order/i }));
    const confirm = screen.getByRole('button', { name: /Confirm cancel/i });
    expect(keep).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab', shiftKey: true });
    expect(confirm).toHaveFocus();
    fireEvent.keyDown(window, { key: 'Tab' });
    expect(keep).toHaveFocus();
    fireEvent.click(keep);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it('V-534.BE renders the events timeline when the envelope carries events', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              orderPayload({
                events: [
                  { status: 'pending', at: '2026-05-11T09:00:00.000Z', source: 'create' },
                  { status: 'confirming', at: '2026-05-11T09:05:00.000Z', source: 'ipn' },
                ],
              }),
            ),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    const timeline = await waitFor(() => screen.getByLabelText('Order events timeline'));
    expect(timeline.textContent).toContain('via create');
    expect(timeline.textContent).toContain('via ipn');
    // Timestamps render via formatTimestamp (locale absolute time), not raw ISO.
    expect(timeline.textContent).toContain(formatTimestamp('2026-05-11T09:00:00.000Z'));
  });

  it('V-534.BE hides the timeline section when events is absent on the wire', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(orderPayload()), // no events field
        } as unknown as Response),
      ),
    );
    render(<CryptoOrderDetailView orderId="ord_42" />);
    await waitFor(() => screen.getByText('ord_42'));
    expect(screen.queryByLabelText('Order events timeline')).toBeNull();
  });

  it('surfaces the error banner on HTTP failure', async () => {
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
    render(<CryptoOrderDetailView orderId="ord_missing" />);
    await waitFor(() => {
      expect(screen.getByText(/requested item was not found/i)).toBeTruthy();
    });
  });
});
