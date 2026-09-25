/* eslint-disable @typescript-eslint/require-await */
// Item 10, 2026-09-24 — the owner's left navigation (redesign round 1,
// 2026-09-21: profiles-command-list / profiles-fleet-stage mockups). Its narrow
// tier: in a window 1060px wide or less the sidebar is a 56px icon rail. The
// rail must keep every behaviour the full sidebar has: each destination still
// navigates and keeps its name, the counts are still there, ⌘K search, sign-out
// and the workspace switcher are still reachable.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import '@testing-library/jest-dom/vitest';
import type { AccountSelfProfile } from '@driftstack/sdk';
import { Sidebar, SIDEBAR_RAIL_MAX_PX, sidebarIsRail } from '../../src/components/Sidebar';

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
    tier: 'api_builder',
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
    onboarding_completed_at: null,
    ...overrides,
  } as AccountSelfProfile;
}

/** The sidebar's row width, as the ResizeObserver stub reports it. */
let rowWidth = 0;
class ImmediateResizeObserver {
  constructor(private readonly cb: ResizeObserverCallback) {}
  observe(): void {
    this.cb([], this);
  }
  unobserve(): void {}
  disconnect(): void {}
}

beforeEach(() => {
  tauriStore.clear();
  mockAccountMe = buildAccountMe();
  mockApiKey = 'ds_live_test';
  mockBaseUrl = 'https://api.driftstack.dev';
  mockRecordings = new Map([
    ['r1', {}],
    ['r2', {}],
    ['r3', {}],
  ]);
  mockActiveWorkspace = null;
  mockSetActiveWorkspace.mockClear();
  vi.stubGlobal('ResizeObserver', ImmediateResizeObserver);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockImplementation(function (
    this: HTMLElement,
  ) {
    return this.dataset.row === 'true' ? rowWidth : 0;
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderInRow(width: number, current: 'profiles' | 'settings' = 'profiles') {
  rowWidth = width;
  const onNavigate = vi.fn();
  const onSignOut = vi.fn();
  const onOpenPalette = vi.fn();
  render(
    <div data-row="true" style={{ display: 'flex' }}>
      <Sidebar
        current={current}
        onNavigate={onNavigate}
        onSignOut={onSignOut}
        onOpenPalette={onOpenPalette}
      />
    </div>,
  );
  const aside = document.querySelector('aside');
  if (aside === null) throw new Error('no sidebar');
  return { aside, onNavigate, onSignOut, onOpenPalette };
}

describe('the sidebar folds to an icon rail in a narrow window', () => {
  it("the boundary is the mockup's 1060px, and an unmeasured row (0) is never a rail", () => {
    expect(SIDEBAR_RAIL_MAX_PX).toBe(1060);
    expect(sidebarIsRail(0)).toBe(false);
    expect(sidebarIsRail(960)).toBe(true);
    expect(sidebarIsRail(1060)).toBe(true);
    expect(sidebarIsRail(1061)).toBe(false);
  });

  it('CRITICAL at 960 wide it is the rail, and every destination still navigates under its own name', () => {
    const { aside, onNavigate } = renderInRow(960);
    expect(aside.dataset.sidebarTier).toBe('rail');
    for (const [name, kind] of [
      ['Command center', 'home'],
      ['AI Browser Automation', 'ai'],
      ['Saved tasks', 'recipes'],
      ['Session log', 'sessions-history'],
      ['Billing', 'billing'],
      ['Settings', 'settings'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name }));
      expect(onNavigate).toHaveBeenLastCalledWith(kind);
    }
    // Counted destinations carry the whole count in their name…
    const profiles = screen.getByRole('button', { name: 'Profiles 12/50' });
    expect(profiles).toHaveAttribute('aria-current', 'page');
    expect(profiles).toHaveAttribute('title', 'Profiles (12/50)');
    expect(screen.getByRole('button', { name: 'Recordings 3' })).toBeInTheDocument();
    // …and show the count on the icon's corner.
    expect(profiles.textContent).toContain('12');
  });

  it('CRITICAL search, sign-out and the workspace switcher stay reachable in the rail', () => {
    mockAccountMe = buildAccountMe({
      teams: [
        {
          owner_account_id: 'acc_team1',
          owner_email: 'owner@example.com',
          owner_name: null,
          role: 'admin',
          membership_id: 'm1',
        },
      ],
    });
    const { onSignOut, onOpenPalette } = renderInRow(960);
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));
    expect(onOpenPalette).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(onSignOut).toHaveBeenCalledTimes(1);
    const sel = screen.getByLabelText('Active workspace');
    fireEvent.change(sel, { target: { value: 'acc_team1' } });
    expect(mockSetActiveWorkspace).toHaveBeenCalledWith('acc_team1');
  });

  it('at 1280 wide it is the full sidebar, labels and account footer visible', () => {
    const { aside } = renderInRow(1280);
    expect(aside.dataset.sidebarTier).toBe('full');
    const label = within(screen.getByRole('navigation')).getByText('Profiles');
    expect(label).not.toHaveClass('sr-only');
    expect(screen.getByText('12/50')).toBeInTheDocument();
    expect(screen.getByText('op@driftstack.test')).toBeInTheDocument();
    expect(screen.getByText('Browse')).toBeInTheDocument();
  });
});
