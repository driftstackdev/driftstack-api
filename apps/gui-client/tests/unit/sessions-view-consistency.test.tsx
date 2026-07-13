// Consistency #5 + #11 — SessionsView surfaces profile-launched AGENT sessions
// and confirms the bare "New session" path.
//
// #5: a profile launch creates an `agt_` AGENT session with no driver row, so
// the driver-only `client.sessions.list()` never returns it. SessionsView now
// also lists the active agent sessions (visible + stoppable) and folds their
// count into the header "X / Y" + cap gate.
//
// #11: the "New session" button used to silently create a profile-less,
// archetype-less driver session through the first saved proxy. It now confirms
// first, with copy that explains the trade-off + points at profile launch.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';

const sessionsList = vi.fn<() => Promise<{ data: unknown[] }>>(() => Promise.resolve({ data: [] }));
const agentSessionsList = vi.fn<() => Promise<{ data: unknown[] }>>(() =>
  Promise.resolve({ data: [], has_more: false, next_cursor: null }),
);
const sessionsCreate = vi.fn<(b: unknown) => Promise<unknown>>(() => Promise.resolve({}));
const agentClose = vi.fn<(id: string) => Promise<void>>(() => Promise.resolve());
const refreshAccountMe = vi.fn(() => Promise.resolve());

// Confirm — driven per-test (default resolves true so the create proceeds).
const confirmFn = vi.fn<(msg: string, opts?: unknown) => Promise<boolean>>(() =>
  Promise.resolve(true),
);
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => confirmFn,
}));

vi.mock('../../src/lib/toasts', () => ({
  useToasts: () => ({ push: vi.fn() }),
}));

vi.mock('../../src/lib/proxies', () => ({
  listProxies: () =>
    Promise.resolve([
      { id: 'p1', label: 'EU exit', host: '127.0.0.1', port: 1080, username: null, password: null },
    ]),
}));

const ctx = {
  client: {
    sessions: { list: () => sessionsList(), create: (b: unknown) => sessionsCreate(b) },
    agentSessions: { list: () => agentSessionsList(), close: (id: string) => agentClose(id) },
  },
  settings: { apiKey: 'ds_test', baseUrl: 'http://localhost:3000' },
  accountMe: {
    tier: 'solo_manual',
    concurrent_session_cap: 2,
    concurrent_session_active: 0,
  },
  refreshAccountMe,
};
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ctx,
}));

const { SessionsView } = await import('../../src/views/SessionsView');

const ACTIVE_AGENT = {
  id: 'agt_running',
  status: 'active',
  created_at: '2026-06-25T00:00:00Z',
  mode: 'manual',
};

beforeEach(() => {
  sessionsList.mockReset();
  sessionsList.mockResolvedValue({ data: [] });
  agentSessionsList.mockReset();
  agentSessionsList.mockResolvedValue({ data: [], has_more: false, next_cursor: null });
  sessionsCreate.mockReset();
  sessionsCreate.mockResolvedValue({});
  agentClose.mockReset();
  agentClose.mockResolvedValue();
  refreshAccountMe.mockClear();
  confirmFn.mockReset();
  confirmFn.mockResolvedValue(true);
  ctx.accountMe = { tier: 'solo_manual', concurrent_session_cap: 2, concurrent_session_active: 0 };
});

afterEach(() => cleanup());

describe('SessionsView consistency #5 — profile-launched agent sessions are visible + actionable', () => {
  it('renders an active agent session as a card even when there are NO driver sessions', async () => {
    agentSessionsList.mockResolvedValue({
      data: [ACTIVE_AGENT],
      has_more: false,
      next_cursor: null,
    });
    render(<SessionsView onGoToSettings={vi.fn()} />);
    // The launched profile's session shows up (not the "No active sessions yet"
    // empty state) with its id + a Stop action.
    expect(await screen.findByText('Profile session')).toBeTruthy();
    expect(screen.getByText('agt_running')).toBeTruthy();
    expect(screen.queryByText('No active sessions yet')).toBeNull();
  });

  it('Stop on an agent-session card calls agentSessions.close', async () => {
    agentSessionsList.mockResolvedValue({
      data: [ACTIVE_AGENT],
      has_more: false,
      next_cursor: null,
    });
    render(<SessionsView onGoToSettings={vi.fn()} />);
    const card = (await screen.findByText('Profile session')).closest('article');
    expect(card).not.toBeNull();
    fireEvent.click(within(card as HTMLElement).getByRole('button', { name: 'Stop' }));
    await waitFor(() => expect(agentClose).toHaveBeenCalledWith('agt_running'));
  });

  it('folds the active agent session into the "X / Y" header count and the cap gate', async () => {
    // cap=2, driver active=0 (server), but TWO active agent sessions run → at cap.
    ctx.accountMe = {
      tier: 'solo_manual',
      concurrent_session_cap: 2,
      concurrent_session_active: 0,
    };
    agentSessionsList.mockResolvedValue({
      data: [ACTIVE_AGENT, { ...ACTIVE_AGENT, id: 'agt_running2' }],
      has_more: false,
      next_cursor: null,
    });
    render(<SessionsView onGoToSettings={vi.fn()} />);
    // Header shows 2 / 2 (driver 0 + 2 agent), and New session is cap-disabled.
    await waitFor(() => expect(screen.getByText('2 / 2')).toBeTruthy());
    const newBtn = screen.getByRole('button', { name: /New session/ });
    expect(newBtn).toBeDisabled();
  });
});

describe('SessionsView consistency #11 — New session confirms the bare path', () => {
  it('confirms before creating a profile-less session and only creates when accepted', async () => {
    render(<SessionsView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /New session/ }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    // The confirm copy names the trade-off + the proxy it would use.
    const msg = confirmFn.mock.calls[0]?.[0] ?? '';
    expect(msg).toMatch(/NO saved profile/i);
    expect(msg).toMatch(/EU exit/);
    await waitFor(() => expect(sessionsCreate).toHaveBeenCalledTimes(1));
  });

  it('does NOT create when the confirm is declined', async () => {
    confirmFn.mockResolvedValue(false);
    render(<SessionsView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /New session/ }));
    await waitFor(() => expect(confirmFn).toHaveBeenCalledTimes(1));
    expect(sessionsCreate).not.toHaveBeenCalled();
  });
});

describe('SessionsView customer-safe error copy', () => {
  it('does not render an unknown session-list exception', async () => {
    sessionsList.mockRejectedValueOnce(
      new Error('SQLite failed /Users/customer token=secret private-control.internal'),
    );

    render(<SessionsView onGoToSettings={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't complete the session request. Try again.");
    expect(alert).not.toHaveTextContent(/SQLite|\/Users|token=secret|private-control/i);
  });
});
