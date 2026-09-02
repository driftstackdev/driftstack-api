// The Profiles onboarding checklist must not make claims about an account it has
// not loaded.
//
// Home gates its checklist on `accountMe !== null`; Profiles did not, so during
// the first render every step was derived from `?? 0` over data that had not
// arrived — a returning user with profiles and live sessions was shown a
// first-run "Get set up" card telling them they had neither. The launch step had
// the same defect one level down: `activeAgentCount` is the length of a list that
// starts empty, so 0 meant "not loaded" just as often as "none running".
//
// Drives the real ProfilesView, because the defect is in the render gate rather
// than in any extractable helper.

// Profiles list failures are recoverable in place, while failures caused by a
// user action remain dismiss-only. This drives the real ProfilesView so a
// future refactor cannot accidentally route both error classes through the
// same banner state again.

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

interface ProfileFixture {
  id: string;
  name: string;
  archetype: string;
  description: string | null;
  last_used_at: string | null;
  size_bytes: number | null;
  created_at: string;
  updated_at: string;
  deleted_at: null;
}

const demoProfile: ProfileFixture = {
  id: 'prof_demo',
  name: 'Demo',
  archetype: 'iphone16pro_ios18_7_safari26_4',
  description: null,
  last_used_at: null,
  size_bytes: null,
  created_at: '2026-07-01T00:00:00Z',
  updated_at: '2026-07-01T00:00:00Z',
  deleted_at: null,
};

const loadProfiles = vi.fn<() => Promise<ProfileFixture[]>>();
const deleteProfile = vi.fn<(id: string) => Promise<void>>();
const refreshAccountMe = vi.fn(() => Promise.resolve());

function iterateProfiles(): AsyncGenerator<ProfileFixture, void, undefined> {
  return (async function* () {
    const profiles = await loadProfiles();
    for (const profile of profiles) yield profile;
  })();
}

let accountMe: unknown = {
  tier: 'solo_manual',
  concurrent_session_cap: 5,
  concurrent_session_active: 0,
  profile_cap: 10,
  profile_count: 1,
};
let agentSessionsList: () => Promise<unknown> = () => Promise.resolve({ data: [] });

const stableContext = {
  client: {
    profiles: {
      iterate: iterateProfiles,
      delete: (id: string) => deleteProfile(id),
    },
    sessions: { list: () => Promise.resolve({ data: [] }) },
    agentSessions: { list: () => agentSessionsList() },
  },
  settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
  get accountMe() {
    return accountMe;
  },
  refreshAccountMe,
  loading: false,
  activeWorkspace: null,
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
  // Spread the REAL module: this double overrides only the I/O. Stubbing
  // the pure derivation instead would make the arms that depend on it pass
  // vacuously, and a hand-listed factory silently omits every export added
  // later — which is exactly how P-8 broke 18 files at once.
  ...(await importOriginal<typeof ProbeCacheModule>()),
  loadProbeCache: () => Promise.resolve({}),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveExitResult: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => Promise.resolve([]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve({ id: 'px_new' })),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() =>
    // A launch-path stub must model a proxy that ROUTES, not merely one that
    // answers. The pre-launch gate re-tests and refuses anything unusable, so a
    // bare { reachable: true } now blocks every launch these suites assert.
    Promise.resolve({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 12,
      message: 'Working — CONNECT succeeded.',
    }),
  ),
  probeProxyExit: vi.fn(() => Promise.resolve({})),
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

function mount() {
  return render(
    <ConfirmProvider>
      <ProfilesView onGoToSettings={vi.fn()} />
    </ConfirmProvider>,
  );
}

describe('Profiles onboarding checklist is gated on loaded account data', () => {
  beforeEach(() => {
    loadProfiles.mockReset();
    loadProfiles.mockResolvedValue([demoProfile]);
    deleteProfile.mockReset();
    deleteProfile.mockResolvedValue(undefined);
    refreshAccountMe.mockClear();
    agentSessionsList = () => Promise.resolve({ data: [] });
    accountMe = {
      tier: 'solo_manual',
      concurrent_session_cap: 5,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_count: 1,
    };
  });
  afterEach(() => {
    cleanup();
  });

  it('renders no checklist at all while accountMe is absent', async () => {
    accountMe = null;
    mount();
    // The profile list still loads — this asserts the checklist is withheld, not
    // that the view failed to render.
    expect(await screen.findByText('Demo')).toBeInTheDocument();
    expect(document.querySelector('[data-component="onboarding-checklist"]')).toBeNull();
  });

  it('renders the checklist once accountMe has arrived', async () => {
    // Vacuity control for the arm above: with the same fixtures and a loaded
    // account the card DOES appear, so the assertion is about the gate rather
    // than about a checklist that never renders in this harness.
    mount();
    expect(await screen.findByText('Demo')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector('[data-component="onboarding-checklist"]')).not.toBeNull();
    });
  });

  it('leaves the launch step unclaimed until the agent-session list has loaded', async () => {
    // A never-settling list is exactly the state the old code read as "no agent
    // sessions": the array is empty because nothing arrived, not because nothing
    // is running.
    agentSessionsList = () => new Promise(() => undefined);
    mount();
    expect(await screen.findByText('Demo')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.getByText('Launch a session')).toBeTruthy();
    });
    expect(screen.getByText('checking…')).toBeTruthy();
  });
});
