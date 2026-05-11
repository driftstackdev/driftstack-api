// V-534.AJ — unit tests for CryptoOrdersAdminDashboardView.
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
});
