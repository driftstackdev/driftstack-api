// Command Center home (G4/G4b) — the Automate-led overview + live session-health
// + recent-activity. Asserts the hero CTAs route to ai/recipes, the KPI strip
// (from accountMe, "—" when null), the quick links, the pure summarizeSessions /
// formatAuditAction helpers, and that both async strips (health + activity) load
// and degrade gracefully. Controllable useSettings mock so it runs without the
// Tauri/SDK chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { HomeNavTarget } from '../../src/views/CommandCenterView';

let accountMe: unknown = null;
let client: unknown = null;
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({ accountMe, client }),
}));

const { CommandCenterView, summarizeSessions, formatAuditAction, computeCapAlerts } =
  await import('../../src/views/CommandCenterView');

const ACC = {
  concurrent_session_active: 0,
  concurrent_session_cap: 10,
  profile_count: 0,
  profile_cap: 10,
};

function nav() {
  return vi.fn<(k: HomeNavTarget) => void>();
}

// A client whose two strips resolve to empty unless overridden — so a test
// exercising one strip doesn't crash on the other's effect.
function makeClient(over?: {
  sessions?: () => Promise<unknown>;
  auditLog?: () => Promise<unknown>;
}) {
  return {
    sessions: {
      list:
        over?.sessions ?? (() => Promise.resolve({ data: [], has_more: false, next_cursor: null })),
    },
    auditLog: {
      list:
        over?.auditLog ?? (() => Promise.resolve({ data: [], has_more: false, next_cursor: null })),
    },
  };
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

describe('formatAuditAction', () => {
  it('humanises dotted/underscored action keys', () => {
    expect(formatAuditAction('profile.created')).toBe('Profile created');
    expect(formatAuditAction('api_key.rotated')).toBe('Api key rotated');
    expect(formatAuditAction('session.errored')).toBe('Session errored');
  });
  it('degrades to "Activity" for an empty key', () => {
    expect(formatAuditAction('')).toBe('Activity');
  });
});

describe('computeCapAlerts', () => {
  it('no alerts when null or well under caps', () => {
    expect(computeCapAlerts(null)).toEqual([]);
    expect(computeCapAlerts({ ...ACC, concurrent_session_active: 1, profile_count: 1 })).toEqual(
      [],
    );
  });
  it('warns at ≥80% and errors at/over a cap (sessions)', () => {
    const near = computeCapAlerts({ ...ACC, concurrent_session_active: 8 });
    expect(near).toHaveLength(1);
    expect(near[0]?.tone).toBe('warn');
    const at = computeCapAlerts({ ...ACC, concurrent_session_active: 10 });
    expect(at[0]?.tone).toBe('error');
    expect(at[0]?.target).toBe('sessions');
  });
  it('warns/errors on the profile cap; null profile_cap (unlimited) → no alert', () => {
    expect(computeCapAlerts({ ...ACC, profile_count: 10 })[0]?.tone).toBe('error');
    expect(computeCapAlerts({ ...ACC, profile_count: 999, profile_cap: null })).toEqual([]);
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
    fireEvent.click(screen.getByRole('button', { name: /Ask Driftstack AI/ }));
    expect(onNavigate).toHaveBeenCalledWith('ai');
    fireEvent.click(screen.getByRole('button', { name: /Saved tasks/ }));
    expect(onNavigate).toHaveBeenCalledWith('recipes');
  });

  it('renders the KPI strip from accountMe (Plan + Profiles ratio)', () => {
    accountMe = {
      tier: 'builder',
      concurrent_session_active: 2,
      concurrent_session_cap: 4,
      profile_count: 7,
      profile_cap: 25,
    };
    render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.getByText('Builder')).toBeTruthy();
    expect(screen.getByText('7 / 25')).toBeTruthy(); // Profiles KPI
  });

  it('shows a cap alert when at the session limit, and Manage navigates', () => {
    accountMe = {
      tier: 'starter',
      concurrent_session_active: 4,
      concurrent_session_cap: 4,
      profile_count: 1,
      profile_cap: 25,
    };
    const onNavigate = nav();
    render(<CommandCenterView onNavigate={onNavigate} />);
    expect(screen.getByText('At your session limit')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Manage' }));
    expect(onNavigate).toHaveBeenCalledWith('sessions');
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

  it('without a client, both strips prompt to connect', () => {
    client = null;
    render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.getByText(/Connect your API key to see live session health/)).toBeTruthy();
    expect(screen.getByText(/Connect your API key to see recent account activity/)).toBeTruthy();
  });

  it('loads + renders the session-health rollup from client.sessions.list', async () => {
    client = makeClient({
      sessions: () =>
        Promise.resolve({
          data: [{ status: 'ready' }, { status: 'busy' }, { status: 'errored' }],
          has_more: false,
          next_cursor: null,
        }),
    });
    render(<CommandCenterView onNavigate={nav()} />);
    await waitFor(() => expect(screen.getByText('Running')).toBeTruthy());
    // running=2 (scope to the tile — "Live now" KPI also shows 2 once health loads)
    const running = screen.getByText('Running').parentElement;
    expect(running?.textContent).toContain('2');
    const errored = screen.getByText('Errored').parentElement;
    expect(errored?.textContent).toContain('1');
  });

  it('loads + renders the recent-activity feed from client.auditLog.list', async () => {
    client = makeClient({
      auditLog: () =>
        Promise.resolve({
          data: [
            {
              id: 'a1',
              action: 'profile.created',
              actor_type: 'customer',
              timestamp: '2026-06-14T00:00:00Z',
            },
            {
              id: 'a2',
              action: 'api_key.rotated',
              actor_type: 'system',
              timestamp: '2026-06-14T00:01:00Z',
            },
          ],
          has_more: false,
          next_cursor: null,
        }),
    });
    render(<CommandCenterView onNavigate={nav()} />);
    await waitFor(() => expect(screen.getByText('Profile created')).toBeTruthy());
    expect(screen.getByText('Api key rotated')).toBeTruthy();
  });

  it('degrades to quiet messages when the fetches fail', async () => {
    client = makeClient({
      sessions: () => Promise.reject(new Error('boom')),
      auditLog: () => Promise.reject(new Error('boom')),
    });
    render(<CommandCenterView onNavigate={nav()} />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load sessions/)).toBeTruthy());
    expect(screen.getByText(/Couldn.t load recent activity/)).toBeTruthy();
  });
});
