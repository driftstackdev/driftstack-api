// V-534.AI — unit tests for CryptoOrdersStatsCard.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { CryptoOrdersStatsCard } = await import('../../src/views/CryptoOrdersStatsCard');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_admin', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function makeStats(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    total: 0,
    by_status: {
      pending: 0,
      confirming: 0,
      paid: 0,
      failed: 0,
      partial: 0,
      cancelled: 0,
    },
    paid_revenue_cents: {},
    avg_time_to_paid_ms: null,
    paid_sample: 0,
    truncated: false,
    scanned: 0,
    ...overrides,
  };
}

describe('V-534.AI CryptoOrdersStatsCard', () => {
  it('renders top-line counts + the "—" placeholder when no paid orders exist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeStats({
                total: 5,
                by_status: {
                  pending: 4,
                  confirming: 0,
                  paid: 0,
                  failed: 1,
                  partial: 0,
                  cancelled: 0,
                },
              }),
            ),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersStatsCard />);
    await waitFor(() => {
      expect(screen.getByText('Total orders')).toBeTruthy();
    });
    // Total = 5, Paid = 0, Pending = 4, avg = "—" since no paid orders.
    const card = screen.getByLabelText('Crypto orders stats');
    expect(card.textContent).toContain('5');
    expect(card.textContent).toContain('—');
    expect(screen.getByText('No paid orders in scope.')).toBeTruthy();
  });

  it('formats avg time-to-pay in seconds when under a minute', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeStats({
                total: 1,
                by_status: {
                  pending: 0,
                  confirming: 0,
                  paid: 1,
                  failed: 0,
                  partial: 0,
                  cancelled: 0,
                },
                paid_revenue_cents: { EUR: 2500 },
                avg_time_to_paid_ms: 42_000,
                paid_sample: 1,
              }),
            ),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersStatsCard />);
    await waitFor(() => {
      expect(screen.getByText(/42s/)).toBeTruthy();
    });
    expect(screen.getByText('25.00 EUR')).toBeTruthy();
  });

  it('formats avg time-to-pay in minutes when between 1 and 60 minutes', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeStats({
                avg_time_to_paid_ms: 5 * 60 * 1_000,
                paid_sample: 3,
              }),
            ),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersStatsCard />);
    await waitFor(() => {
      expect(screen.getByText(/5.0m/)).toBeTruthy();
    });
  });

  it('formats avg time-to-pay in hours beyond an hour', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeStats({
                avg_time_to_paid_ms: 2.5 * 60 * 60 * 1_000,
                paid_sample: 2,
              }),
            ),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersStatsCard />);
    await waitFor(() => {
      expect(screen.getByText(/2.5h/)).toBeTruthy();
    });
  });

  it('renders multiple paid-revenue currencies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve(
              makeStats({
                paid_revenue_cents: { EUR: 8000, USD: 5000 },
                avg_time_to_paid_ms: 30_000,
                paid_sample: 2,
              }),
            ),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersStatsCard />);
    await waitFor(() => {
      expect(screen.getByText('80.00 EUR')).toBeTruthy();
      expect(screen.getByText('50.00 USD')).toBeTruthy();
    });
  });

  it('renders the truncated warning when truncated=true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve(makeStats({ truncated: true, scanned: 10_000 })),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersStatsCard />);
    await waitFor(() => {
      expect(screen.getByText(/scan-window limit/i)).toBeTruthy();
    });
  });

  it('surfaces HTTP errors via the error banner', async () => {
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
    render(<CryptoOrdersStatsCard />);
    await waitFor(() => {
      expect(screen.getByText(/HTTP 403/)).toBeTruthy();
    });
  });
});
