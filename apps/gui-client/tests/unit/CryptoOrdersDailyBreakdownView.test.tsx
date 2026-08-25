// V-534.AH — unit tests for CryptoOrdersDailyBreakdownView.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

interface MockSettings {
  settings: { apiKey: string | null; baseUrl: string };
}
const useSettingsMock = vi.fn<() => MockSettings>();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => useSettingsMock(),
}));

const { CryptoOrdersDailyBreakdownView } =
  await import('../../src/views/CryptoOrdersDailyBreakdownView');

beforeEach(() => {
  useSettingsMock.mockReturnValue({
    settings: { apiKey: 'sk_admin', baseUrl: 'https://api.driftstack.dev' },
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('V-534.AH CryptoOrdersDailyBreakdownView', () => {
  it('pivots (date, status, count) rows into one row per date with status columns', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              days: 7,
              rows: [
                { date: '2026-05-09', status: 'pending', count: 2 },
                { date: '2026-05-09', status: 'paid', count: 1 },
                { date: '2026-05-10', status: 'paid', count: 4 },
              ],
              truncated: false,
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersDailyBreakdownView />);
    await waitFor(() => {
      expect(screen.getByText('2026-05-09')).toBeTruthy();
      expect(screen.getByText('2026-05-10')).toBeTruthy();
    });
    // 2026-05-09: pending=2 + paid=1 + total=3.
    const may9 = screen.getByText('2026-05-09').closest('tr');
    expect(may9?.textContent).toContain('2');
    expect(may9?.textContent).toContain('3');
  });

  it('renders dates newest-first', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              days: 7,
              rows: [
                { date: '2026-05-09', status: 'paid', count: 1 },
                { date: '2026-05-10', status: 'paid', count: 1 },
              ],
              truncated: false,
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersDailyBreakdownView />);
    await waitFor(() => {
      expect(screen.getByText('2026-05-10')).toBeTruthy();
    });
    const dates = screen.getAllByText(/2026-05-/).map((el) => el.textContent);
    expect(dates[0]).toBe('2026-05-10');
    expect(dates[1]).toBe('2026-05-09');
  });

  it('refetches with days= when the dropdown changes', async () => {
    const fetchMock = vi.fn((_url: string, _init?: RequestInit) =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ days: 7, rows: [], truncated: false }),
      } as unknown as Response),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<CryptoOrdersDailyBreakdownView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    fireEvent.change(screen.getByLabelText(/Days/i), { target: { value: '30' } });
    await waitFor(() => {
      expect(
        (fetchMock.mock.calls as Array<[string, RequestInit?]>).some(
          ([u]) => typeof u === 'string' && u.includes('days=30'),
        ),
      ).toBe(true);
    });
  });

  it('shows the truncated warning when the API reports truncated=true', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              days: 90,
              rows: [{ date: '2026-05-10', status: 'paid', count: 1 }],
              truncated: true,
            }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersDailyBreakdownView />);
    await waitFor(() => {
      expect(screen.getByText(/truncated/i)).toBeTruthy();
    });
  });

  it('shows the empty-state copy when the window has no orders', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ days: 7, rows: [], truncated: false }),
        } as unknown as Response),
      ),
    );
    render(<CryptoOrdersDailyBreakdownView />);
    await waitFor(() => {
      expect(screen.getByText(/No orders in the selected window/i)).toBeTruthy();
    });
  });

  it('renders error banner on HTTP failure', async () => {
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
    render(<CryptoOrdersDailyBreakdownView />);
    await waitFor(() => {
      expect(screen.getByText(/do not have permission/i)).toBeTruthy();
    });
  });
});
