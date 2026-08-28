// SessionsHistoryView had ZERO coverage — 15 functions, none executed — while
// being a live lazily-routed view (App.tsx renders it) AND the reference other
// views cite: RecipesView says it "mirrors the SessionsHistoryView state-machine
// shape", SessionsView says it "mirrors SessionsHistoryView's success path".
// The pattern two siblings copy was the one nothing exercised.
//
// Found by measuring gui-client coverage for the first time. Worth recording that
// the first measurement was WRONG — run from inside apps/gui-client it collects
// only the 176 `.test.tsx` files and misses the 82 `.test.ts` ones, reporting a
// long list of "never executed" files whose tests simply had not run. This view
// is one of only three genuinely at 0% once measured correctly, and the other two
// are artifacts (the Tauri entry point and a visual harness).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const sessionsList = vi.fn<() => Promise<{ data: unknown[] }>>(() => Promise.resolve({ data: [] }));
let ctx: { client: { sessions: { list: typeof sessionsList } } | null } = {
  client: { sessions: { list: sessionsList } },
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ctx,
}));

const { SessionsHistoryView } = await import('../../src/views/SessionsHistoryView');

function session(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: 'ses_x',
    status: 'destroyed',
    created_at: '2026-01-01T00:00:00Z',
    destroyed_at: null,
    last_state_at: null,
    ...over,
  };
}

beforeEach(() => {
  ctx = { client: { sessions: { list: sessionsList } } };
  sessionsList.mockReset();
  sessionsList.mockResolvedValue({ data: [] });
});
afterEach(cleanup);

describe('SessionsHistoryView', () => {
  it('without a configured client it asks for an API key instead of calling the API', () => {
    ctx = { client: null };
    render(<SessionsHistoryView />);
    expect(screen.getByText(/Set up your API key in Settings/i)).toBeTruthy();
    expect(sessionsList).not.toHaveBeenCalled();
  });

  it('lists ONLY terminated sessions — an active one is not history', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({ id: 'ses_live', status: 'active' }),
        session({ id: 'ses_gone', status: 'destroyed', destroyed_at: '2026-06-01T00:00:00Z' }),
        session({ id: 'ses_bad', status: 'errored', last_state_at: '2026-06-02T00:00:00Z' }),
      ],
    });
    render(<SessionsHistoryView />);
    await waitFor(() => expect(screen.getByText('ses_gone')).toBeTruthy());
    expect(screen.getByText('ses_bad')).toBeTruthy();
    expect(screen.queryByText('ses_live')).toBeNull();
  });

  // ⭐ The documented behaviour, and the one a naive "sort by destroyed_at" would
  // break. An errored session often has NO destroyed_at because the box never ran
  // a clean teardown; keying on that alone sends every such session to time 0 and
  // dumps the reasonless errors at the bottom, which is the opposite of useful for
  // a post-mortem view. The fallback chain interleaves them by when they ENDED.
  it('orders newest-first by when a session ended, falling back past a missing destroyed_at', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({ id: 'ses_oldest', status: 'destroyed', destroyed_at: '2026-06-01T00:00:00Z' }),
        // No destroyed_at — must sort by last_state_at, ABOVE the older destroyed one.
        session({
          id: 'ses_newest_errored',
          status: 'errored',
          last_state_at: '2026-06-03T00:00:00Z',
        }),
        session({ id: 'ses_middle', status: 'destroyed', destroyed_at: '2026-06-02T00:00:00Z' }),
      ],
    });
    const { container } = render(<SessionsHistoryView />);
    await waitFor(() => expect(screen.getByText('ses_newest_errored')).toBeTruthy());
    const text = container.textContent ?? '';
    const order = ['ses_newest_errored', 'ses_middle', 'ses_oldest'].map((id) => text.indexOf(id));
    expect(
      order.every((i) => i >= 0),
      'all three rendered',
    ).toBe(true);
    expect(order, 'newest-first, errored interleaved rather than sunk to the bottom').toEqual(
      [...order].sort((a, b) => a - b),
    );
  });

  it('an unparseable timestamp sorts last instead of throwing', async () => {
    sessionsList.mockResolvedValue({
      data: [
        session({ id: 'ses_nan', status: 'errored', last_state_at: 'not-a-date' }),
        session({ id: 'ses_ok', status: 'destroyed', destroyed_at: '2026-06-01T00:00:00Z' }),
      ],
    });
    const { container } = render(<SessionsHistoryView />);
    await waitFor(() => expect(screen.getByText('ses_ok')).toBeTruthy());
    const text = container.textContent ?? '';
    expect(text.indexOf('ses_ok')).toBeLessThan(text.indexOf('ses_nan'));
  });

  it('a failed load shows humanised copy, never the raw exception', async () => {
    sessionsList.mockRejectedValue(new Error('getaddrinfo ENOTFOUND api.driftstack.dev'));
    render(<SessionsHistoryView />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    const alert = screen.getByRole('alert').textContent ?? '';
    expect(alert).not.toContain('ENOTFOUND');
    expect(alert.length).toBeGreaterThan(0);
  });

  it('no terminated sessions renders the empty state, not a blank panel', async () => {
    sessionsList.mockResolvedValue({ data: [session({ id: 'ses_live', status: 'active' })] });
    const { container } = render(<SessionsHistoryView />);
    await waitFor(() => expect(sessionsList).toHaveBeenCalled());
    await waitFor(() => expect((container.textContent ?? '').length).toBeGreaterThan(20));
    expect(screen.queryByText('ses_live')).toBeNull();
  });
});
