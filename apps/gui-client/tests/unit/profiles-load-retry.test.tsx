// Profiles list failures are recoverable in place, while failures caused by a
// user action remain dismiss-only. This drives the real ProfilesView so a
// future refactor cannot accidentally route both error classes through the
// same banner state again.

import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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

const stableContext = {
  client: {
    profiles: {
      iterate: iterateProfiles,
      delete: (id: string) => deleteProfile(id),
    },
    sessions: { list: () => Promise.resolve({ data: [] }) },
    agentSessions: { list: () => Promise.resolve({ data: [] }) },
  },
  settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
  accountMe: {
    tier: 'solo_manual',
    concurrent_session_cap: 5,
    concurrent_session_active: 0,
    profile_cap: 10,
    profile_count: 1,
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
  addProxy: vi.fn(() => Promise.resolve({ id: 'px_new' })),
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
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('ProfilesView list-load retry', () => {
  beforeEach(() => {
    loadProfiles.mockReset();
    deleteProfile.mockReset();
    deleteProfile.mockResolvedValue(undefined);
    refreshAccountMe.mockClear();
  });

  it('recovers in place after a failed list fetch and exposes honest retry progress', async () => {
    const retry = deferred<ProfileFixture[]>();
    loadProfiles
      .mockRejectedValueOnce(new Error('Profiles are temporarily unavailable.'))
      .mockImplementationOnce(() => retry.promise);

    render(<ProfilesView onGoToSettings={vi.fn()} />);

    expect(await screen.findByText('Profiles are temporarily unavailable.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    const retrying = screen.getByRole('button', { name: 'Retrying…' });
    expect(retrying).toBeDisabled();
    expect(retrying).toHaveAttribute('aria-busy', 'true');

    await act(async () => {
      retry.resolve([demoProfile]);
      await retry.promise;
    });

    expect(await screen.findByText('Demo')).toBeInTheDocument();
    await waitFor(() => {
      expect(screen.queryByText('Profiles are temporarily unavailable.')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
    });
    expect(loadProfiles).toHaveBeenCalledTimes(2);
  });

  it('keeps a user-action error dismiss-only across a successful list refresh', async () => {
    loadProfiles.mockResolvedValue([demoProfile]);
    deleteProfile.mockRejectedValueOnce(new Error('Could not delete Demo.'));

    render(
      <ConfirmProvider>
        <ProfilesView onGoToSettings={vi.fn()} />
      </ConfirmProvider>,
    );

    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByRole('button', { name: 'Delete Demo' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete' }));

    expect(await screen.findByText('Could not delete Demo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    fireEvent.click(screen.getByTitle('Refresh now'));
    await waitFor(() => expect(loadProfiles).toHaveBeenCalledTimes(2));
    expect(screen.getByText('Could not delete Demo.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByText('Could not delete Demo.')).toBeNull();
  });
});
