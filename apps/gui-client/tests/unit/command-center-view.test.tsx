// Command Center home (G4/G4b) — the Automate-led launchpad + live session-health
// + recent-activity + "Jump back in" recent profiles. Asserts the hero CTAs route
// to ai/recipes, the KPI strip (from accountMe, "—" when null), the quick links,
// the pure summarizeSessions / formatAuditAction / sortRecentProfiles /
// profileMonogram helpers, the actionable Live-now KPI + Running tile (jump to
// sessions), the recent-profiles strip, and that every async strip (health /
// activity / recent profiles) loads and degrades gracefully. Controllable
// useSettings mock so it runs without the Tauri/SDK chain.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type { HomeNavTarget } from '../../src/views/CommandCenterView';

let accountMe: unknown = null;
let client: unknown = null;
let activeWorkspace: string | null = null;
let settingsApiKey: string | null = null;
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    settings: { apiKey: settingsApiKey },
    accountMe,
    client,
    activeWorkspace,
    refreshAccountMe: () => Promise.resolve(),
  }),
}));

const {
  CommandCenterView,
  summarizeSessions,
  formatAuditAction,
  computeCapAlerts,
  sortRecentProfiles,
  profileMonogram,
} = await import('../../src/views/CommandCenterView');

const ACC = {
  concurrent_session_active: 0,
  concurrent_session_cap: 10,
  profile_count: 0,
  profile_cap: 10,
};

function nav() {
  return vi.fn<(k: HomeNavTarget) => void>();
}

// A client whose strips resolve to empty unless overridden — so a test
// exercising one strip doesn't crash on another's effect.
function makeClient(over?: {
  sessions?: () => Promise<unknown>;
  auditLog?: () => Promise<unknown>;
  profiles?: () => Promise<unknown>;
  // Consistency #5 — profile-launched AGENT sessions folded into the active
  // surfaces. Defaults to an empty list.
  agentSessions?: () => Promise<unknown>;
}) {
  const emptyPage = () => Promise.resolve({ data: [], has_more: false, next_cursor: null });
  return {
    sessions: { list: over?.sessions ?? emptyPage },
    auditLog: { list: over?.auditLog ?? emptyPage },
    profiles: { list: over?.profiles ?? emptyPage },
    agentSessions: { list: over?.agentSessions ?? emptyPage },
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

describe('sortRecentProfiles', () => {
  it('orders by last_used_at desc, nulls (never used) last, and caps at the limit', () => {
    const out = sortRecentProfiles(
      [
        { id: 'never', name: 'Never', last_used_at: null },
        { id: 'old', name: 'Old', last_used_at: '2026-01-01T00:00:00Z' },
        { id: 'new', name: 'New', last_used_at: '2026-06-01T00:00:00Z' },
        { id: 'mid', name: 'Mid', last_used_at: '2026-03-01T00:00:00Z' },
      ],
      3,
    );
    expect(out.map((p) => p.id)).toEqual(['new', 'mid', 'old']);
  });

  it('keeps incoming order for ties / both-never-used (stable)', () => {
    const out = sortRecentProfiles(
      [
        { id: 'a', name: 'A', last_used_at: null },
        { id: 'b', name: 'B', last_used_at: null },
        { id: 'c', name: 'C', last_used_at: '2026-06-01T00:00:00Z' },
        { id: 'd', name: 'D', last_used_at: '2026-06-01T00:00:00Z' },
      ],
      10,
    );
    expect(out.map((p) => p.id)).toEqual(['c', 'd', 'a', 'b']);
  });

  it('empty input → empty; a non-positive limit → empty; never mutates the input', () => {
    const input = [{ id: 'x', name: 'X', last_used_at: '2026-06-01T00:00:00Z' }];
    expect(sortRecentProfiles([], 5)).toEqual([]);
    expect(sortRecentProfiles(input, 0)).toEqual([]);
    expect(input).toHaveLength(1); // input untouched
  });
});

describe('profileMonogram', () => {
  it('uppercases the first non-space character; blank → "?"', () => {
    expect(profileMonogram('shopify scout')).toBe('S');
    expect(profileMonogram('  ada')).toBe('A');
    expect(profileMonogram('')).toBe('?');
    expect(profileMonogram('   ')).toBe('?');
  });
});

describe('CommandCenterView', () => {
  beforeEach(() => {
    cleanup();
    accountMe = null;
    client = null;
    activeWorkspace = null;
    settingsApiKey = null;
  });

  it('shows the onboarding checklist on home and routes its steps (H2)', () => {
    // Not dismissed in this env (localStorage stub returns no flag), so the
    // checklist renders; a fresh account leaves all three steps open.
    accountMe = { ...ACC }; // fresh account: no profile, no live session
    settingsApiKey = null; // not connected → all three steps open
    const onNavigate = nav();
    render(<CommandCenterView onNavigate={onNavigate} />);
    fireEvent.click(screen.getByRole('button', { name: 'Connect your account' }));
    expect(onNavigate).toHaveBeenCalledWith('settings');
    fireEvent.click(screen.getByRole('button', { name: 'Create a profile' }));
    expect(onNavigate).toHaveBeenCalledWith('profiles');
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

  it('labels the account KPI strip "Your account" only in a team workspace', () => {
    accountMe = { ...ACC, tier: 'builder' };
    // Personal scope (no active workspace) → the account caps ARE the only
    // numbers, so no disambiguating label.
    activeWorkspace = null;
    const { unmount } = render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.queryByText('Your account')).toBeNull();
    unmount();

    // Team workspace → the personal-scoped caps must read as "Your account" so
    // they don't masquerade as this team's counts (the workspace-scoped strips
    // below show the team's numbers).
    activeWorkspace = 'acct_team_owner_1';
    render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.getByText('Your account')).toBeTruthy();
  });

  it('clarifies the Profiles cap is per-account when in a team workspace', () => {
    accountMe = { ...ACC, tier: 'builder', profile_count: 2, profile_cap: 50 };
    activeWorkspace = 'acct_team_owner_1';
    render(<CommandCenterView onNavigate={nav()} />);
    const profilesTile = screen.getByText('2 / 50').closest('[title]');
    expect(profilesTile?.getAttribute('title')).toMatch(/per your account/i);
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

  it('without a client, every strip prompts to connect', () => {
    client = null;
    render(<CommandCenterView onNavigate={nav()} />);
    expect(screen.getByText(/Connect your API key to see live session health/)).toBeTruthy();
    expect(screen.getByText(/Connect your API key to see recent account activity/)).toBeTruthy();
    expect(screen.getByText(/Connect your API key to jump back into a profile/)).toBeTruthy();
  });

  it('"Jump back in": loads recent profiles (mru first) and a card navigates to profiles', async () => {
    const onNavigate = nav();
    client = makeClient({
      profiles: () =>
        Promise.resolve({
          data: [
            { id: 'p1', name: 'Old Scout', last_used_at: '2026-01-01T00:00:00Z' },
            { id: 'p2', name: 'Fresh Lead', last_used_at: '2026-06-10T00:00:00Z' },
          ],
          has_more: false,
          next_cursor: null,
        }),
    });
    render(<CommandCenterView onNavigate={onNavigate} />);
    await waitFor(() => expect(screen.getByText('Fresh Lead')).toBeTruthy());
    expect(screen.getByText('Old Scout')).toBeTruthy();
    // Cards are buttons titled by name; clicking jumps into the launch surface.
    fireEvent.click(screen.getByRole('button', { name: /Fresh Lead/ }));
    expect(onNavigate).toHaveBeenCalledWith('profiles');
  });

  it('"Jump back in": empty state when there are no profiles, and it navigates to profiles', async () => {
    const onNavigate = nav();
    client = makeClient(); // empty profiles
    render(<CommandCenterView onNavigate={onNavigate} />);
    const empty = await screen.findByText(/No profiles yet — create one to get started/);
    fireEvent.click(empty);
    expect(onNavigate).toHaveBeenCalledWith('profiles');
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
    // running=2 (scope to the tile — the "Active" KPI also shows 2 once health
    // loads). The Running tile is a button when running>0, so walk to the tile.
    const running = screen.getByText('Running').closest('button, div');
    expect(running?.textContent).toContain('2');
    const errored = screen.getByText('Errored').closest('button, div');
    expect(errored?.textContent).toContain('1');
  });

  it('the running side is actionable: clicking the Running tile jumps to sessions', async () => {
    const onNavigate = nav();
    client = makeClient({
      sessions: () =>
        Promise.resolve({
          data: [{ status: 'ready' }, { status: 'busy' }],
          has_more: false,
          next_cursor: null,
        }),
    });
    render(<CommandCenterView onNavigate={onNavigate} />);
    const running = await screen.findByRole('button', { name: /Running/ });
    fireEvent.click(running);
    expect(onNavigate).toHaveBeenCalledWith('sessions');
  });

  it('the "Active" KPI is clickable only when there are running sessions', async () => {
    const onNavigate = nav();
    client = makeClient({
      sessions: () =>
        Promise.resolve({ data: [{ status: 'ready' }], has_more: false, next_cursor: null }),
    });
    render(<CommandCenterView onNavigate={onNavigate} />);
    const live = await screen.findByRole('button', { name: /Active/ });
    fireEvent.click(live);
    expect(onNavigate).toHaveBeenCalledWith('sessions');
  });

  it('with zero running sessions the "Active" KPI + Running tile are passive (no button)', async () => {
    client = makeClient({
      // a destroyed session → the health strip renders tiles (total>0) with
      // running 0, so we can assert neither the KPI nor the tile is a button.
      sessions: () =>
        Promise.resolve({ data: [{ status: 'destroyed' }], has_more: false, next_cursor: null }),
    });
    render(<CommandCenterView onNavigate={nav()} />);
    await screen.findByText('Running'); // health loaded → liveNow resolved to 0
    expect(screen.queryByRole('button', { name: /Active/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Running/ })).toBeNull();
  });

  it('consistency #5: folds active AGENT sessions into the Active KPI, Running tile, and cap alert', async () => {
    // The server's concurrent_session_active is DRIVER-only (0 here), but the
    // user launched a profile → an active `agt_` session. cap=1, so adding it
    // hits the cap. Every surface must reflect 1 running, not 0.
    accountMe = { ...ACC, concurrent_session_active: 0, concurrent_session_cap: 1 };
    const onNavigate = nav();
    client = makeClient({
      // No driver sessions — without the fold, Session health would say "No
      // sessions yet" and the Active KPI would read 0.
      sessions: () => Promise.resolve({ data: [], has_more: false, next_cursor: null }),
      agentSessions: () =>
        Promise.resolve({
          data: [{ status: 'active' }, { status: 'closed' }],
          has_more: false,
          next_cursor: null,
        }),
    });
    render(<CommandCenterView onNavigate={onNavigate} />);
    // Active KPI is now clickable (1 running) and jumps to sessions.
    const live = await screen.findByRole('button', { name: /Active/ });
    expect(live.textContent).toContain('1');
    fireEvent.click(live);
    expect(onNavigate).toHaveBeenCalledWith('sessions');
    // Session health renders tiles (not the empty placeholder) with Running 1.
    const running = await screen.findByText('Running');
    expect(running.closest('button, div')?.textContent).toContain('1');
    // Cap alert fires against the REAL count (1/1) — the proactive "at limit".
    expect(screen.getByText('At your session limit')).toBeTruthy();
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
      profiles: () => Promise.reject(new Error('boom')),
    });
    render(<CommandCenterView onNavigate={nav()} />);
    await waitFor(() => expect(screen.getByText(/Couldn.t load sessions/)).toBeTruthy());
    expect(screen.getByText(/Couldn.t load recent activity/)).toBeTruthy();
    expect(screen.getByText(/Couldn.t load your profiles/)).toBeTruthy();
  });
});
