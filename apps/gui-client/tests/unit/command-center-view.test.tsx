// Command Center home (G4) — the overview that leads with Automate. Asserts the
// Automate hero CTAs route to ai / recipes, the KPI strip renders from a mocked
// accountMe (and degrades to "—" when null), the quick links navigate, the pure
// session-health rollup, and that the live session-health strip loads + degrades
// gracefully. Controllable useSettings mock so it runs without the Tauri/SDK chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { HomeNavTarget } from '../../src/views/CommandCenterView';

let accountMe: unknown = null;
let client: unknown = null;
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ accountMe, client }),
}));

const { CommandCenterView, summarizeSessions } = await import('../../src/views/CommandCenterView');

function nav() {
  return vi.fn<(k: HomeNavTarget) => void>();
}

describe('summarizeSessions', () => {
  it('rolls statuses into running (ready+busy) / creating / errored / destroyed / total', () => {
    expect(
      summarizeSessions([
        { status: 'ready' },
        { status: 'busy' },
        { status: 'creating' },
        { status: 'errored' },
        { status: 'destroyed' },
        { status: 'ready' },
      ]),
    ).toEqual({ total: 6, running: 3, creating: 1, errored: 1, destroyed: 1 });
  });

  it('empty → all zero', () => {
    expect(summarizeSessions([])).toEqual({
      total: 0,
      running: 0,
      creating: 0,
      errored: 0,
      destroyed: 0,
    });
  });
});

describe('CommandCenterView', () => {
  beforeEach(() => {
    cleanup();
    accountMe = null;
    client = null;
  });

  it('leads with Automate: the hero CTAs route to ai and recipes', () => {
    const onNavigate = nav();
    render(<CommandCenterView onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Ask Driftstack AI' }));
    expect(onNavigate).toHaveBeenCalledWith('ai');
    fireEvent.click(screen.getByRole('button', { name: 'Browse recipes' }));
    expect(onNavigate).toHaveBeenCalledWith('recipes');
  });

  it('renders the KPI strip from accountMe', () => {
    accountMe = {
      tier: 'builder',
      concurrent_session_active: 2,
      concurrent_session_cap: 4,
      profile_count: 7,
      profile_cap: 25,
    };
    render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.getByText('Builder')).toBeTruthy();
    expect(screen.getByText('2 / 4')).toBeTruthy();
    expect(screen.getByText('7 / 25')).toBeTruthy();
  });

  it('degrades gracefully to "—" when accountMe is null (loading/unauth)', () => {
    accountMe = null;
    render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.getAllByText('—').length).toBeGreaterThanOrEqual(3);
  });

  it('quick links navigate to profiles / proxies / sessions', () => {
    const onNavigate = nav();
    render(<CommandCenterView onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: /Profiles/ }));
    fireEvent.click(screen.getByRole('button', { name: /Proxies/ }));
    fireEvent.click(screen.getByRole('button', { name: /^Sessions/ }));
    expect(onNavigate).toHaveBeenCalledWith('profiles');
    expect(onNavigate).toHaveBeenCalledWith('proxies');
    expect(onNavigate).toHaveBeenCalledWith('sessions');
  });

  it('without a client, the health strip prompts to connect', () => {
    client = null;
    render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.getByText(/Connect your API key to see live session health/)).toBeTruthy();
  });

  it('loads + renders the session-health rollup from client.sessions.list', async () => {
    client = {
      sessions: {
        list: vi.fn(() =>
          Promise.resolve({
            data: [{ status: 'ready' }, { status: 'busy' }, { status: 'errored' }],
            has_more: false,
            next_cursor: null,
          }),
        ),
      },
    };
    render(<CommandCenterView onNavigate={nav()} />);
    // Running = ready + busy = 2; Errored = 1.
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy());
    expect(screen.getByText('2')).toBeTruthy(); // running
    const errored = screen.getByText('Errored').parentElement;
    expect(errored?.textContent).toContain('1');
  });

  it('degrades to a quiet message when the sessions fetch fails', async () => {
    client = { sessions: { list: vi.fn(() => Promise.reject(new Error('boom'))) } };
    render(<CommandCenterView onNavigate={nav()} />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load sessions/)).toBeTruthy());
  });
});
