// Regression coverage for the org-sync seed gate in ProfilesView (audit
// 2026-06-25). The folders.json / tags.json caches are a SINGLE GLOBAL store
// (NOT keyed by workspace), so the empty-server "seed from local" branch must:
//
//   (1) STILL fire on the FIRST run for an account/workspace — otherwise the
//       genuine #441 offline-then-online data-loss returns (an empty server
//       taxonomy wipes locally-created folders/tags via replaceAll*).
//   (2) NOT fire on a workspace SWITCH — the global cache then still holds the
//       PRIOR workspace's taxonomy, so seeding would PUSH one workspace's
//       folders/tags into another workspace's server record (durable
//       cross-account contamination).
//
// The sibling profiles-organization-management.test.tsx mocks fetchOrganization
// to REJECT (so the empty-server seed path is never exercised). This file mocks
// it to RESOLVE EMPTY so the seed gate itself is under test.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

// A mutable settings controller so a test can flip the active workspace and
// re-render to simulate a workspace switch (the org-sync effect keys on it).
const settingsCtl: { activeWorkspace: string | null } = { activeWorkspace: null };
const stableSettings = { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' };
const stableAccountMe = {
  id: 'acc_personal',
  tier: 'solo_manual',
  concurrent_session_cap: 5,
  concurrent_session_active: 0,
  profile_cap: 10,
  profile_count: 0,
  teams: [
    {
      owner_account_id: 'acct_team_b',
      owner_email: 'owner@example.test',
      owner_name: 'Team owner',
      role: 'admin',
      membership_id: 'mem_1',
    },
  ],
};
const profile = {
  id: 'prof_1',
  name: 'Visible profile',
  archetype: 'iphone16pro_ios18_7_safari26_4',
  description: null,
  created_at: '2026-06-08T00:00:00Z',
  updated_at: '2026-06-08T00:00:00Z',
  last_used_at: null,
  deleted_at: null,
};
const stableClient = {
  profiles: {
    list: () => Promise.resolve({ data: [profile] }),
    // eslint-disable-next-line @typescript-eslint/require-await
    iterate: async function* () {
      yield profile;
    },
    update: vi.fn(() => Promise.resolve({ id: 'prof_1' })),
  },
  sessions: { list: () => Promise.resolve({ data: [] }) },
  agentSessions: { list: () => Promise.resolve({ data: [] }) },
};
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client: stableClient,
    settings: stableSettings,
    accountMe: stableAccountMe,
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    activeWorkspace: settingsCtl.activeWorkspace,
    setActiveWorkspace: vi.fn(),
  }),
}));

// Profile metadata itself is empty: every taxonomy label in this test comes
// from the identity-bound folders/tags cache, never from a listed profile.
vi.mock('../../src/lib/profiles-meta', () => ({
  loadProfilesMeta: () => Promise.resolve({}),
  persistProfilesMeta: vi.fn(() => Promise.resolve()),
  saveProfileMeta: vi.fn(() => Promise.resolve({})),
  saveProfilesMetaBulk: vi.fn(() => Promise.resolve({})),
  seedMetaFromServer: (local: unknown) => ({ map: local, changed: false }),
  folderList: () => [],
  aggregateTags: () => [],
}));

const replaceAllFolders = vi.fn(() => Promise.resolve());
const replaceAllTags = vi.fn(() => Promise.resolve());
const loadFolders = vi.fn((scope: string) =>
  Promise.resolve(scope.includes('account:acc_personal') ? ['Work'] : []),
);
const loadFolderIcons = vi.fn(() => Promise.resolve({}));
const loadTags = vi.fn((scope: string) =>
  Promise.resolve(scope.includes('account:acc_personal') ? ['aged'] : []),
);
vi.mock('../../src/lib/folders-store', () => ({
  loadFolders: (...a: unknown[]) => loadFolders(...(a as [string])),
  loadFolderIcons: (...a: unknown[]) => loadFolderIcons(...(a as [string])),
  addFolder: vi.fn(() => Promise.resolve(['Work'])),
  removeFolder: vi.fn(() => Promise.resolve([])),
  renameFolder: vi.fn(() => Promise.resolve(['Work'])),
  setFolderIcon: vi.fn(() => Promise.resolve({})),
  replaceAllFolders: (...a: unknown[]) => replaceAllFolders(...(a as [])),
}));
vi.mock('../../src/lib/tags-store', () => ({
  loadTags: (...a: unknown[]) => loadTags(...(a as [string])),
  addTag: vi.fn(() => Promise.resolve(['aged'])),
  removeTag: vi.fn(() => Promise.resolve([])),
  renameTag: vi.fn(() => Promise.resolve(['aged'])),
  replaceAllTags: (...a: unknown[]) => replaceAllTags(...(a as [])),
}));

// fetchOrganization RESOLVES EMPTY (the seed path under test); saveOrganization
// is a spy so we can assert when the local taxonomy is (or isn't) pushed.
const fetchOrganization = vi.fn(() => Promise.resolve({ folders: [], tags: [] }));
const saveOrganization = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/account-organization', () => ({
  fetchOrganization: (...a: unknown[]) => fetchOrganization(...(a as [])),
  saveOrganization: (...a: unknown[]) => saveOrganization(...(a as [])),
}));

vi.mock('../../src/lib/proxy-probe-cache', () => ({
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
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve({ id: 'p_new' })),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.resolve({ reachable: true })),
  probeProxyExit: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

describe('ProfilesView org-sync seed gate (workspace scope)', () => {
  beforeEach(() => {
    settingsCtl.activeWorkspace = null;
    fetchOrganization.mockClear();
    saveOrganization.mockClear();
    replaceAllFolders.mockClear();
    replaceAllTags.mockClear();
    loadFolders.mockClear();
    loadFolderIcons.mockClear();
    loadTags.mockClear();
  });

  function WorkspaceBoundProfiles(): JSX.Element {
    const workspace = settingsCtl.activeWorkspace;
    return <ProfilesView key={workspace ?? 'personal'} onGoToSettings={vi.fn()} />;
  }

  // (1) #441: on the FIRST run (prevScope === null), an empty server taxonomy +
  // a non-empty local cache must SEED the server from local, not wipe local.
  it('SEEDS the server from the local cache on the first run (empty server, #441)', async () => {
    render(<WorkspaceBoundProfiles />);
    await waitFor(() => expect(fetchOrganization).toHaveBeenCalled());
    await waitFor(() => expect(saveOrganization).toHaveBeenCalled());
    const org = saveOrganization.mock.calls.at(-1)?.[2] as {
      folders: { name: string }[];
      tags: string[];
    };
    expect(org.folders.map((f) => f.name)).toEqual(['Work']);
    expect(org.tags).toEqual(['aged']);
    // The seed branch returns BEFORE the replaceAll* clobber, so local survives.
    expect(replaceAllFolders).not.toHaveBeenCalled();
    expect(replaceAllTags).not.toHaveBeenCalled();
    expect(await screen.findByText('Work')).toBeInTheDocument();
    expect(await screen.findByText('#aged')).toBeInTheDocument();
    const scope = loadFolders.mock.calls[0]?.[0];
    expect(scope).toContain('account:acc_personal');
    expect(scope).not.toContain(stableSettings.apiKey);
  });

  // (2) On a workspace SWITCH (scope change) the global cache still holds the
  // prior workspace's taxonomy. Seeding it into the switched-to (empty)
  // workspace would leak it — so saveOrganization must NOT be called, and the
  // empty server taxonomy is reconciled into the local cache via replaceAll*.
  it('does NOT push the prior taxonomy when switching to an empty workspace (no leak)', async () => {
    const { rerender } = render(<WorkspaceBoundProfiles />);
    // First run seeds (covered above) — wait for it then clear the spies.
    await waitFor(() => expect(saveOrganization).toHaveBeenCalled());
    saveOrganization.mockClear();
    fetchOrganization.mockClear();
    replaceAllFolders.mockClear();
    replaceAllTags.mockClear();

    // Switch into a team workspace whose server taxonomy is empty.
    settingsCtl.activeWorkspace = 'acct_team_b';
    rerender(<WorkspaceBoundProfiles />);

    // The effect re-runs for the new scope and fetches the (empty) team org.
    await waitFor(() =>
      expect(fetchOrganization).toHaveBeenCalledWith(
        stableSettings.baseUrl,
        stableSettings.apiKey,
        'acct_team_b',
      ),
    );
    // Reconcile the global cache DOWN to the empty server taxonomy…
    const teamScope = 'http://localhost:3000|account:acct_team_b';
    await waitFor(() => expect(replaceAllFolders).toHaveBeenCalledWith([], {}, teamScope));
    await waitFor(() => expect(replaceAllTags).toHaveBeenCalledWith([], teamScope));
    // …and CRUCIALLY: the prior workspace's "Work"/"aged" was NOT pushed into
    // the new workspace's server record.
    expect(saveOrganization).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByText('Work')).toBeNull());
    expect(screen.queryByText('#aged')).toBeNull();
    expect(loadFolders).toHaveBeenLastCalledWith(teamScope);
  });

  it('fails closed when a persisted workspace is not validated by account membership', async () => {
    settingsCtl.activeWorkspace = 'acct_revoked';
    render(<WorkspaceBoundProfiles />);
    await screen.findByText('Visible profile');

    expect(loadFolders).not.toHaveBeenCalled();
    expect(loadTags).not.toHaveBeenCalled();
    expect(fetchOrganization).not.toHaveBeenCalled();
    expect(saveOrganization).not.toHaveBeenCalled();
    expect(screen.queryByText('Work')).toBeNull();
    expect(screen.queryByText('#aged')).toBeNull();
  });
});
