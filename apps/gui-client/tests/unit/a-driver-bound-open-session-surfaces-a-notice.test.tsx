// Guard for audit LOW #10 — a RUNNING profile bound to a legacy DRIVER session
// has no live view (only agent sessions stream; driver sessions are no longer
// created). Its primary "Open session" control used to be a silent no-op: the
// click handler's inner `bound.kind === 'agent'` guard simply fell through and
// did nothing. It must now surface DRIVER_NO_LIVE_VIEW_NOTICE, per the view's
// no-silent-no-op contract.
//
// boundSession resolves a binding to kind 'driver' when its currentSessionId
// does NOT start with `agt_` and is present + non-terminal in sessions.list()
// (activeSessions). So we drive:
//   • listBindings() → one binding pointing at a non-agent session id
//   • client.sessions.list() → that id, status 'active' (a live driver session)
// The row then reads "running" with a DRIVER binding, and clicking its primary
// "Open session" button must render the notice rather than nothing.
//
// Mirrors the harness in profiles-bulk-launch-guards.test.tsx (same mocks +
// ConfirmProvider wiring).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { openSimulatorWindow } from '../../src/lib/open-simulator';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const agentSessionsList = vi.fn<() => Promise<{ data: unknown[] }>>(() =>
  Promise.resolve({ data: [] }),
);
const listBindingsMock = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));
// Driven per-test: the driver-session list (client.sessions.list) that populates
// activeSessions, from which boundSession reads a live driver binding.
const driverSessionsList = vi.fn<() => Promise<{ data: unknown[] }>>(() =>
  Promise.resolve({ data: [] }),
);

const PROF_DRIVER = {
  id: 'prof_driver',
  name: 'LegacyDriver',
  archetype: 'iphone16pro_ios18_7_safari26_4',
  description: null,
  last_used_at: null,
  created_at: '2026-06-08T00:00:00Z',
  updated_at: '2026-06-08T00:00:00Z',
};

// STABLE context object — useSettings must return the SAME reference every render
// (a fresh object each call churns ProfilesView's effects → infinite re-render).
const stableContext = {
  client: {
    profiles: {
      list: () => Promise.resolve({ data: [PROF_DRIVER] }),
      // eslint-disable-next-line @typescript-eslint/require-await
      iterate: async function* () {
        yield PROF_DRIVER;
      },
    },
    sessions: { list: () => driverSessionsList() },
    agentSessions: {
      create: vi.fn(() => Promise.resolve({ id: 'agt_new', livekit: LIVEKIT })),
      close: vi.fn(() => Promise.resolve({})),
      livekitToken: () => Promise.resolve(LIVEKIT),
      list: () => agentSessionsList(),
    },
  },
  settings: {
    apiKey: 'ds_test_x',
    baseUrl: 'http://localhost:3000',
    startUrl: 'https://driftstack.io',
  },
  accountMe: {
    tier: 'solo_manual',
    concurrent_session_cap: 5,
    concurrent_session_active: 0,
    profile_cap: 10,
    profile_active: 1,
    teams: [] as Array<{ membership_id: string; owner_account_id: string; role: string }>,
  },
  refreshAccountMe: vi.fn(() => Promise.resolve()),
  loading: false,
  update: vi.fn(() => Promise.resolve()),
  activeWorkspace: null as string | null,
  setActiveWorkspace: vi.fn(),
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => stableContext,
}));

vi.mock('../../src/lib/profiles-meta', () => ({
  loadProfilesMeta: () => Promise.resolve({}),
  persistProfilesMeta: vi.fn(() => Promise.resolve()),
  saveProfileMeta: vi.fn(() => Promise.resolve({})),
  saveProfilesMetaBulk: vi.fn(() => Promise.resolve({})),
  seedMetaFromServer: (local: unknown) => ({ map: local, changed: false }),
  folderList: () => [],
  aggregateTags: () => [],
}));
vi.mock('../../src/lib/folders-store', () => ({
  loadFolders: () => Promise.resolve([]),
  addFolder: vi.fn(() => Promise.resolve([])),
  removeFolder: vi.fn(() => Promise.resolve([])),
  renameFolder: vi.fn(() => Promise.resolve([])),
  setFolderIcon: vi.fn(() => Promise.resolve({})),
  loadFolderIcons: () => Promise.resolve({}),
  replaceAllFolders: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/tags-store', () => ({
  loadTags: () => Promise.resolve([]),
  addTag: vi.fn(() => Promise.resolve([])),
  removeTag: vi.fn(() => Promise.resolve([])),
  renameTag: vi.fn(() => Promise.resolve([])),
  replaceAllTags: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/account-organization', () => ({
  fetchOrganization: () => Promise.reject(new Error('offline')),
  saveOrganization: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  loadProbeCache: () => Promise.resolve({}),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveExitResult: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => listBindingsMock(),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve({ id: 'p_new' })),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.resolve({ reachable: true, auth_ok: true, can_route: true })),
}));
vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
}));
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));
vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/open-simulator', () => ({
  openSimulatorWindow: vi.fn(() => Promise.resolve({ opened: true })),
}));

const { ProfilesView, DRIVER_NO_LIVE_VIEW_NOTICE } = await import('../../src/views/ProfilesView');
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

const LIVEKIT = {
  ws_url: 'ws://localhost:7880',
  room: 'agt_demo_room',
  token: 'tok',
  participant_identity: 'customer-acc',
  expires_at: '2026-06-08T12:00:00Z',
};

// A NON-agent (driver) session id, present + non-terminal in the driver-session
// list → boundSession resolves the binding to kind 'driver', running === true.
const DRIVER_BINDING = {
  profileId: 'prof_driver',
  defaultProxyId: null,
  currentSessionId: 'drv_legacy_1',
  lastLaunchedAt: '2026-06-25T00:00:00Z',
};
const LIVE_DRIVER = {
  data: [{ id: 'drv_legacy_1', status: 'active', created_at: '2026-06-25T00:00:00Z' }],
};

function renderView(): void {
  render(
    <ConfirmProvider>
      <ProfilesView onGoToSettings={vi.fn()} />
    </ConfirmProvider>,
  );
}

describe('ProfilesView driver-bound "Open session" no-silent-no-op', () => {
  beforeEach(() => {
    vi.mocked(openSimulatorWindow).mockClear();
    vi.mocked(openSimulatorWindow).mockResolvedValue({ opened: true });
    listBindingsMock.mockReset();
    listBindingsMock.mockResolvedValue([DRIVER_BINDING]);
    driverSessionsList.mockReset();
    driverSessionsList.mockResolvedValue(LIVE_DRIVER);
    agentSessionsList.mockReset();
    agentSessionsList.mockResolvedValue({ data: [] });
  });

  it('surfaces the explanatory notice (not a silent no-op) when the primary control is clicked on a driver binding', async () => {
    // Sanity: the notice is a non-empty explanatory string, so findByText below
    // cannot pass vacuously against an empty banner.
    expect(DRIVER_NO_LIVE_VIEW_NOTICE.length).toBeGreaterThan(0);

    renderView();

    // The driver-bound profile reads "running", so its primary control is the
    // "Open session" button (idle profiles show "Launch").
    const openSession = await screen.findByRole('button', { name: 'Open session' });

    fireEvent.click(openSession);

    // The click now produces the explanatory notice. Before the fix this was a
    // silent no-op — the notice banner never appeared, so this findByText timed
    // out and the test failed. (Revert-detecting assertion.)
    expect(await screen.findByText(DRIVER_NO_LIVE_VIEW_NOTICE)).toBeTruthy();

    // …and it did NOT try to open a live stream: a driver binding has no live
    // view, so the simulator window must not open.
    await waitFor(() => {
      expect(vi.mocked(openSimulatorWindow)).not.toHaveBeenCalled();
    });
  });
});
