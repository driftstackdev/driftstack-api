// V-534.AJ — unit tests for CryptoOrdersAdminDashboardView.
// V-534.BA — extended for the inline idempotency-metrics strip.
//
// The dashboard composes three child views. We mock each one so the
// test asserts layout/composition only — the children's own behaviour
// is covered by their own test files (V-534.AG, V-534.AH, V-534.AI).

import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

vi.mock('../../src/views/CryptoOrdersStatsCard', () => ({
  CryptoOrdersStatsCard: () => <div data-testid="stats-card">stats card</div>,
}));
vi.mock('../../src/views/CryptoOrdersAdminView', () => ({
  CryptoOrdersAdminView: () => <div data-testid="admin-list">admin list</div>,
}));
vi.mock('../../src/views/CryptoOrdersDailyBreakdownView', () => ({
  CryptoOrdersDailyBreakdownView: () => <div data-testid="daily-breakdown">daily breakdown</div>,
}));
// V-534.BB — the dashboard test parametrises the mocked metrics so
// the colour-tone assertions can flex.
interface MockMetricsData {
  replays: number;
  first_writes: number;
  body_mismatches?: number;
}
const metricsMock: { data: MockMetricsData } = vi.hoisted(() => ({
  data: { replays: 4, first_writes: 16, body_mismatches: 0 },
}));
vi.mock('../../src/lib/use-admin-idempotency-metrics', () => ({
  useAdminIdempotencyMetrics: () => ({
    state: { kind: 'ready', data: metricsMock.data },
    refetch: () => Promise.resolve(),
  }),
}));

const { CryptoOrdersAdminDashboardView } =
  await import('../../src/views/CryptoOrdersAdminDashboardView');

describe('V-534.AJ CryptoOrdersAdminDashboardView', () => {
  it('renders the dashboard title + the three child views', () => {
    render(<CryptoOrdersAdminDashboardView />);
    expect(screen.getByRole('heading', { name: /Crypto orders — admin dashboard/i })).toBeTruthy();
    expect(screen.getByTestId('stats-card')).toBeTruthy();
    expect(screen.getByTestId('admin-list')).toBeTruthy();
    expect(screen.getByTestId('daily-breakdown')).toBeTruthy();
  });

  it('wraps the list + breakdown in aria-labelled section regions', () => {
    render(<CryptoOrdersAdminDashboardView />);
    expect(screen.getByLabelText('Orders list')).toBeTruthy();
    expect(screen.getByLabelText('Daily breakdown')).toBeTruthy();
  });

  it('renders the idempotency-metrics strip with numbers + replay share', () => {
    metricsMock.data = { replays: 4, first_writes: 16, body_mismatches: 0 };
    render(<CryptoOrdersAdminDashboardView />);
    const strip = screen.getByLabelText('Idempotency metrics');
    expect(strip).toBeTruthy();
    expect(strip.textContent).toContain('16');
    expect(strip.textContent).toContain('4');
    expect(strip.textContent).toContain('20%');
  });

  it('V-534.BB tags the warning tone when replay share is 5-20%', () => {
    metricsMock.data = { replays: 1, first_writes: 9, body_mismatches: 0 }; // 10%
    render(<CryptoOrdersAdminDashboardView />);
    const strip = screen.getByLabelText('Idempotency metrics');
    expect(strip.getAttribute('data-replay-tone')).toBe('warning');
  });

  it('V-534.BB tags the alert tone when replay share is >20%', () => {
    metricsMock.data = { replays: 5, first_writes: 5, body_mismatches: 0 }; // 50%
    render(<CryptoOrdersAdminDashboardView />);
    const strip = screen.getByLabelText('Idempotency metrics');
    expect(strip.getAttribute('data-replay-tone')).toBe('alert');
  });

  it('V-534.BB tags the neutral tone when replay share is <5%', () => {
    metricsMock.data = { replays: 1, first_writes: 99, body_mismatches: 0 }; // 1%
    render(<CryptoOrdersAdminDashboardView />);
    const strip = screen.getByLabelText('Idempotency metrics');
    expect(strip.getAttribute('data-replay-tone')).toBe('neutral');
  });

  it('V-534.BH includes a footer link to the API spec', () => {
    // W212 — link must point at the API host's /docs/, not the Tauri
    // app's own origin (tauri://localhost/docs is 404). When the
    // component renders without a <SettingsProvider> wrapper (as in
    // this test), it falls back to DEFAULT_SETTINGS.baseUrl.
    metricsMock.data = { replays: 0, first_writes: 0, body_mismatches: 0 };
    render(<CryptoOrdersAdminDashboardView />);
    const link = screen.getByRole('link', { name: /View API spec/i });
    // 2026-05-20 — DEFAULT_SETTINGS.baseUrl shifted 7780→3000 to align
    // with the SDK client default. CryptoOrdersAdminDashboardView's
    // API-spec link derives from the same fallback when rendered
    // without a SettingsProvider wrapper.
    expect(link.getAttribute('href')).toBe('http://localhost:3000/docs/');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('V-534.BB surfaces body-mismatch count', () => {
    metricsMock.data = { replays: 2, first_writes: 18, body_mismatches: 3 };
    render(<CryptoOrdersAdminDashboardView />);
    const strip = screen.getByLabelText('Idempotency metrics');
    expect(strip.textContent).toContain('Body mismatches');
    expect(strip.textContent).toContain('3');
  });
});
