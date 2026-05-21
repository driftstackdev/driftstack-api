/* eslint-disable @typescript-eslint/require-await */
// 2026-05-21 — Sidebar count-badge + section render guards.
//
// Locks the visible-text contract for the BlackBird-inspired sidebar
// rebuild so the next visual tweak (workspaces / tags / further icons)
// doesn't silently drop a customer-facing counter.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
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
  }),
}));

vi.mock('../../src/lib/recordings', () => ({
  useRecordings: () => ({ recordings: mockRecordings, activeIds: new Set<string>() }),
}));

vi.mock('../../src/lib/proxies', () => ({
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
});

afterEach(() => {
  cleanup();
});

describe('Sidebar — count badges + section gates', () => {
  it('renders Profiles X/Y from accountMe.profile_count + profile_cap', () => {
    mockAccountMe = buildAccountMe({ profile_count: 12, profile_cap: 50 });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.getByText('Profiles')).toBeInTheDocument();
    expect(screen.getByText('12/50')).toBeInTheDocument();
  });

  it('renders Profiles X (no cap) when profile_cap is null (enterprise)', () => {
    mockAccountMe = buildAccountMe({ profile_count: 7, profile_cap: null });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.getByText('7')).toBeInTheDocument();
  });

  it('renders Raw sessions ratio from accountMe.concurrent_session_*', () => {
    mockAccountMe = buildAccountMe({
      concurrent_session_active: 3,
      concurrent_session_cap: 4,
    });
    render(<Sidebar current="profiles" onNavigate={() => {}} onSignOut={() => {}} />);
    expect(screen.getByText('Raw sessions')).toBeInTheDocument();
    expect(screen.getByText('3/4')).toBeInTheDocument();
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
});
