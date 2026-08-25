// Deep-audit LOW: bulk-deleting a selection where some profiles can't be deleted
// (e.g. a RUNNING one the server 409s) used to swallow the per-row failures
// silently, leaving them in the list with no explanation — looked like delete was
// broken. handleBulkDelete now counts failures and surfaces a summary confirm
// (mirroring handleEmptyTrash). This drives the real ProfilesView through the
// ConfirmProvider with a delete that fails for one id.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const profilesDelete = vi.fn<(id: string) => Promise<unknown>>();

function profile(id: string, name: string) {
  return {
    id,
    name,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: null,
    last_used_at: null,
    size_bytes: 1024,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
  };
}
const PROF_A = profile('prof_a', 'Alpha');
const PROF_B = profile('prof_b', 'Bravo');

const stableClient = {
  profiles: {
    list: () => Promise.resolve({ data: [PROF_A, PROF_B] }),
    // eslint-disable-next-line @typescript-eslint/require-await
    iterate: async function* () {
      yield PROF_A;
      yield PROF_B;
    },
    delete: (id: string) => profilesDelete(id),
  },
  sessions: { list: () => Promise.resolve({ data: [] }) },
  agentSessions: { list: () => Promise.resolve({ data: [] }) },
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client: stableClient,
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 5,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_count: 2,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  }),
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
const deleteBinding = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => Promise.resolve([]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: () => deleteBinding(),
}));
vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () => Promise.resolve([]),
  addProxy: vi.fn(() => Promise.resolve({ id: 'p_new' })),
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

function renderView(): void {
  render(
    <ConfirmProvider>
      <ProfilesView onGoToSettings={vi.fn()} />
    </ConfirmProvider>,
  );
}

describe('ProfilesView bulk delete — failure summary', () => {
  beforeEach(() => {
    profilesDelete.mockReset();
    deleteBinding.mockClear();
  });

  it('reports how many could NOT be deleted instead of silently leaving them', async () => {
    // prof_a deletes; prof_b 409s (e.g. it's running).
    profilesDelete.mockImplementation((id: string) =>
      id === 'prof_b' ? Promise.reject(new Error('409 running')) : Promise.resolve({}),
    );
    renderView();

    // Select both cards (the card checkbox is labelled "Select <name>").
    fireEvent.click(await screen.findByLabelText('Select Alpha'));
    fireEvent.click(await screen.findByLabelText('Select Bravo'));

    // The bulk bar's Delete opens the confirm dialog; confirm INSIDE the dialog
    // (both the bulk bar and the dialog carry a "Delete" button).
    fireEvent.click(await screen.findByRole('button', { name: /^Delete$/ }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));

    // Both deletes attempted…
    await waitFor(() => expect(profilesDelete).toHaveBeenCalledWith('prof_a'));
    await waitFor(() => expect(profilesDelete).toHaveBeenCalledWith('prof_b'));

    // …and the failure is surfaced (not swallowed): a summary confirm names the count.
    expect(await screen.findByText(/1 profile couldn.t be deleted/i)).toBeTruthy();
  });
});
