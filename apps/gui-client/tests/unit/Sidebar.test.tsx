/* eslint-disable @typescript-eslint/require-await */
// 2026-05-21 — Sidebar count-badge + section render guards.
//
// Locks the visible-text contract for the 2026-05-21 sidebar rebuild
// so the next visual tweak (further icons / workspace dividers /
// account header) doesn't silently drop a customer-facing counter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AccountSelfProfile } from '@driftstack/sdk';
import { Sidebar } from '../../src/components/Sidebar';

// Same Tauri-stack mocks shape as app-shell-sign-out.test.tsx — Sidebar
// reaches through SettingsContext + RecordingsContext + listProxies which
// all touch the Tauri plugins under the hood.
const tauriStore = new Map<string, unknown>();
vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(async () => null),
}));
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    async get<T>(k: string): Promise<T | null> {
      return (tauriStore.get(k) as T) ?? null;
    }
    async set(k: string, v: unknown): Promise<void> {
      tauriStore.set(k, v);
    }
    async save(): Promise<void> {}
  },
}));
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
}));

// SettingsContext + RecordingsProvider are heavy; stub them with thin
// passthrough providers so the test drives accountMe / recordings
// shape directly.
let mockAccountMe: AccountSelfProfile | null = null;
let mockApiKey: string | null = 'ds_live_test';
let mockBaseUrl = 'https://api.driftstack.dev';
let mockRecordings = new Map<string, unknown>();
let mockActiveWorkspace: string | null = null;
const mockSetActiveWorkspace = vi.fn();

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    settings: {
      apiKey: mockApiKey,
      baseUrl: mockBaseUrl,
      telemetryOptIn: null,
    },
    accountMe: mockAccountMe,
    client: null,
    refreshAccountMe: vi.fn(),
    update: vi.fn(),
    loading: false,
    activeWorkspace: mockActiveWorkspace,
    setActiveWorkspace: mockSetActiveWorkspace,
  }),
}));

vi.mock('../../src/lib/recordings', () => ({
  useRecordings: () => ({ recordings: mockRecordings, activeIds: new Set<string>() }),
}));

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: vi.fn(async () => [
    { id: 'a', label: 'A', host: 'h', port: 1080, username: null, password: null, createdAt: '' },
    { id: 'b', label: 'B', host: 'h', port: 1080, username: null, password: null, createdAt: '' },
    { id: 'c', label: 'C', host: 'h', port: 1080, username: null, password: null, createdAt: '' },
  ]),
}));

function buildAccountMe(overrides: Partial<AccountSelfProfile> = {}): AccountSelfProfile {
  return {
    id: 'acct_1',
    email: 'op@driftstack.test',
    name: null,
    tier: 'builder',
    status: 'active',
    timezone: null,
    slug: null,
    region: null,
    avatar_url: null,
    mfa_enrolled: false,
    concurrent_session_cap: 4,
    concurrent_session_active: 2,
    profile_cap: 50,
    profile_count: 12,
    teams: [],
    ...overrides,
  };
}

beforeEach(() => {
  tauriStore.clear();
  mockAccountMe = null;
  mockApiKey = 'ds_live_test';
  mockBaseUrl = 'https://api.driftstack.dev';
  mockRecordings = new Map();
  mockActiveWorkspace = null;
  mockSetActiveWorkspace.mockClear();
});

afterEach(() => {
  cleanup();
});

describe('Sidebar — count badges + section gates', () => {
  it('renders Profiles X/Y from accountMe.profile_count + profile_cap', () => {
    mockAccountMe = buildAccountMe({ profile_count: 12, profile_cap: 50 });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    // "Profiles" now appears twice (nav item + the account-footer usage row).
    expect(screen.getAllByText('Profiles').length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText('12/50')).toBeInTheDocument(); // the nav badge (footer uses "12 / 50")
  });

  it('renders Profiles X (no cap) when profile_cap is null (enterprise)', () => {
    mockAccountMe = buildAccountMe({ profile_count: 7, profile_cap: null });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('no longer shows the Raw sessions nav item (removed 2026-06-15)', () => {
    mockAccountMe = buildAccountMe();
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.queryByText('Raw sessions')).not.toBeInTheDocument();
    expect(screen.queryByText('Connectivity test')).not.toBeInTheDocument();
  });

  it('hides Team item when accountMe.teams is empty', () => {
    mockAccountMe = buildAccountMe({ teams: [] });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.queryByText('Team')).not.toBeInTheDocument();
  });

  it('shows Team item with team count when teams.length > 0', () => {
    mockAccountMe = buildAccountMe({
      teams: [
        { owner_account_id: 'a1', role: 'admin', membership_id: 'm1' },
        { owner_account_id: 'a2', role: 'member', membership_id: 'm2' },
      ],
    });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.getByText('Team')).toBeInTheDocument();
    expect(screen.getByText('2')).toBeInTheDocument();
  });

  it('hides the workspace switcher for a solo account (no teams)', () => {
    mockAccountMe = buildAccountMe({ teams: [] });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.queryByLabelText('Active workspace')).not.toBeInTheDocument();
  });

  it('shows the workspace switcher for a team member + switches effectiveAccount on change', () => {
    mockAccountMe = buildAccountMe({
      teams: [{ owner_account_id: 'acc_team1', role: 'admin', membership_id: 'm1' }],
    });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    const sel = screen.getByLabelText('Active workspace');
    expect(sel).toBeInTheDocument();
    // Switching to the team passes the owner account id…
    fireEvent.change(sel, { target: { value: 'acc_team1' } });
    expect(mockSetActiveWorkspace).toHaveBeenCalledWith('acc_team1');
    // …and switching back to Personal passes null.
    fireEvent.change(sel, { target: { value: '' } });
    expect(mockSetActiveWorkspace).toHaveBeenCalledWith(null);
  });

  it('hides Cluster section on cloud baseUrl', () => {
    mockBaseUrl = 'https://api.driftstack.dev';
    mockAccountMe = buildAccountMe();
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.queryByText('Cluster')).not.toBeInTheDocument();
    expect(screen.queryByText('Mac mini fleet')).not.toBeInTheDocument();
  });

  it('shows Cluster section on self-hosted baseUrl', () => {
    mockBaseUrl = 'https://api.acme.example';
    mockAccountMe = buildAccountMe();
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.getByText('Cluster')).toBeInTheDocument();
    expect(screen.getByText('Mac mini fleet')).toBeInTheDocument();
  });

  it('does not render a Recordings badge when count is 0', () => {
    mockAccountMe = buildAccountMe();
    mockRecordings = new Map();
    const { container } = render(
      <Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />,
    );
    expect(screen.getByText('Recordings')).toBeInTheDocument();
    // No badge sibling next to "Recordings".
    const rec = screen.getByText('Recordings').closest('button');
    expect(rec?.textContent).toBe('Recordings');
    // sanity: container actually rendered
    expect(container.querySelector('aside')).not.toBeNull();
  });

  it('renders Recordings count badge when >= 1', () => {
    mockAccountMe = buildAccountMe();
    mockRecordings = new Map([
      ['r1', {}],
      ['r2', {}],
      ['r3', {}],
    ]);
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    const rec = screen.getByText('Recordings').closest('button');
    expect(rec?.textContent).toContain('3');
  });

  it('omits sign-out block when apiKey is null (signed-out shell)', () => {
    mockApiKey = null;
    mockAccountMe = null;
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.queryByRole('button', { name: /Sign out/ })).not.toBeInTheDocument();
  });

  it('wraps the primary nav in a <nav> landmark and marks the active item aria-current="page"', () => {
    mockAccountMe = buildAccountMe();
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    const nav = screen.getByRole('navigation', { name: /primary/i });
    expect(nav).toBeInTheDocument();
    // The active item (Profiles nav button) carries aria-current; inactive don't.
    // Scope to the <nav> so the footer "Profiles" usage row isn't matched.
    const active = within(nav).getByText('Profiles').closest('button');
    expect(active?.getAttribute('aria-current')).toBe('page');
    const inactive = within(nav).getByText('Settings').closest('button');
    expect(inactive?.getAttribute('aria-current')).toBeNull();
  });
});
