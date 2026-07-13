// V-534.AO — unit tests for CryptoOrdersPendingAgeView.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { CryptoOrdersPendingAgeView } = await import('../../src/views/CryptoOrdersPendingAgeView');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_admin', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

function stubPendingAge(body: unknown, ok = true, status = 200): ReturnType<typeof vi.fn> {
  const f = vi.fn(() =>
    Promise.resolve({
      ok,
      status,
      json: () => Promise.resolve(body),
    } as unknown as Response),
  );
  vi.stubGlobal('fetch', f);
  return f;
}

describe('V-534.AO CryptoOrdersPendingAgeView', () => {
  it('renders all four age buckets with counts', async () => {
    stubPendingAge({
      buckets: { under_1h: 3, h1_to_6h: 2, h6_to_24h: 1, over_24h: 4 },
      pending_value_cents: { EUR: 14900 * 10 },
      total: 10,
      truncated: false,
      scanned: 10,
    });
    render(<CryptoOrdersPendingAgeView />);
    await waitFor(() => {
      expect(screen.getByTestId('bucket-under_1h').textContent).toContain('3');
      expect(screen.getByTestId('bucket-h1_to_6h').textContent).toContain('2');
      expect(screen.getByTestId('bucket-h6_to_24h').textContent).toContain('1');
      expect(screen.getByTestId('bucket-over_24h').textContent).toContain('4');
    });
  });

  it('renders pending value by currency', async () => {
    stubPendingAge({
      buckets: { under_1h: 1, h1_to_6h: 0, h6_to_24h: 0, over_24h: 1 },
      pending_value_cents: { EUR: 14900, USD: 5000 },
      total: 2,
      truncated: false,
      scanned: 2,
    });
    render(<CryptoOrdersPendingAgeView />);
    await waitFor(() => {
      expect(screen.getByTestId('pending-value-EUR').textContent).toContain('149.00 EUR');
      expect(screen.getByTestId('pending-value-USD').textContent).toContain('50.00 USD');
    });
  });

  it('shows "No pending value" when the value map is empty', async () => {
    stubPendingAge({
      buckets: { under_1h: 0, h1_to_6h: 0, h6_to_24h: 0, over_24h: 0 },
      pending_value_cents: {},
      total: 0,
      truncated: false,
      scanned: 0,
    });
    render(<CryptoOrdersPendingAgeView />);
    await waitFor(() => {
      expect(screen.getByText(/No pending value/i)).toBeTruthy();
    });
  });

  it('shows the truncated warning when the API reports truncated=true', async () => {
    stubPendingAge({
      buckets: { under_1h: 1, h1_to_6h: 0, h6_to_24h: 0, over_24h: 0 },
      pending_value_cents: { EUR: 100 },
      total: 1,
      truncated: true,
      scanned: 10000,
    });
    render(<CryptoOrdersPendingAgeView />);
    await waitFor(() => {
      expect(screen.getByText(/truncated/i)).toBeTruthy();
    });
  });

  it('renders error banner on HTTP failure', async () => {
    stubPendingAge({}, false, 403);
    render(<CryptoOrdersPendingAgeView />);
    await waitFor(() => {
      expect(screen.getByText(/do not have permission/i)).toBeTruthy();
    });
  });

  it('singularises the order count copy for total=1', async () => {
    stubPendingAge({
      buckets: { under_1h: 1, h1_to_6h: 0, h6_to_24h: 0, over_24h: 0 },
      pending_value_cents: { EUR: 100 },
      total: 1,
      truncated: false,
      scanned: 1,
    });
    const { container } = render(<CryptoOrdersPendingAgeView />);
    await waitFor(() => {
      const text = container.textContent ?? '';
      expect(text).toMatch(/1\s+pending order\s+in scope/);
      expect(text).not.toMatch(/pending orders/);
    });
  });
});
