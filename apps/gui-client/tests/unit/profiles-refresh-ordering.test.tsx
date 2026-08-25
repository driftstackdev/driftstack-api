// ProfilesView same-scope refresh ownership. A slow older poll must never
// overwrite a newer profile snapshot, detached agent-session publication, or
// metadata seed; unmount invalidates all held work.

import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function profile(id: string, name: string) {
  return {
    id,
    name,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: null,
    last_used_at: null,
    created_at: '2026-07-01T00:00:00Z',
    updated_at: '2026-07-01T00:00:00Z',
    deleted_at: null,
  };
}

let profilePages: Array<Deferred<ReturnType<typeof profile>[]>> = [];
let profileIteration = 0;
let agentPages: Array<Deferred<{ data: Array<Record<string, unknown>> }>> = [];
let agentCall = 0;
let bindings: Array<{
  profileId: string;
  defaultProxyId: null;
  currentSessionId: string | null;
  lastLaunchedAt: null;
}> = [];

const agentSessionsList = vi.fn(() => {
  const gate = agentPages[agentCall++];
  return gate?.promise ?? Promise.resolve({ data: [] });
});

const stableClient = {
  profiles: {
    iterate: async function* () {
      const gate = profilePages[profileIteration++];
      const page = gate === undefined ? [] : await gate.promise;
      for (const item of page) yield item;
    },
    update: vi.fn(() => Promise.resolve({ id: 'prof_1' })),
  },
  sessions: { list: vi.fn(() => Promise.resolve({ data: [] })) },
  agentSessions: { list: () => agentSessionsList() },
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client: stableClient,
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      id: 'acc_personal',
      tier: 'solo_manual',
      concurrent_session_cap: 5,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_count: 1,
      teams: [],
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  }),
}));

const seedMetaFromServer = vi.fn((local: unknown) => ({ map: local, changed: false }));
const persistProfilesMeta = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/profiles-meta', () => ({
  loadProfilesMeta: () => Promise.resolve({}),
  persistProfilesMeta: (...a: unknown[]) => persistProfilesMeta(...(a as [])),
  saveProfileMeta: vi.fn(() => Promise.resolve({})),
  saveProfilesMetaBulk: vi.fn(() => Promise.resolve({})),
  seedMetaFromServer: (...a: unknown[]) => seedMetaFromServer(...(a as [])),
  folderList: () => [],
  aggregateTags: () => [],
}));

vi.mock('../../src/lib/folders-store', () => ({
  loadFolders: () => Promise.resolve([]),
  loadFolderIcons: () => Promise.resolve({}),
  addFolder: vi.fn(() => Promise.resolve([])),
  removeFolder: vi.fn(() => Promise.resolve([])),
  renameFolder: vi.fn(() => Promise.resolve([])),
  setFolderIcon: vi.fn(() => Promise.resolve({})),
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
  listBindings: () => Promise.resolve(bindings),
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

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('ProfilesView refresh latest-generation ownership', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    profilePages = [];
    profileIteration = 0;
    agentPages = [];
    agentCall = 0;
    bindings = [];
    agentSessionsList.mockClear();
    seedMetaFromServer.mockClear();
    persistProfilesMeta.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the newer profile snapshot when an older same-scope poll settles last', async () => {
    const oldPage = deferred<ReturnType<typeof profile>[]>();
    const newPage = deferred<ReturnType<typeof profile>[]>();
    profilePages.push(oldPage, newPage);
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await act(flush);
    expect(profileIteration).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      await flush();
    });
    expect(profileIteration).toBe(2);

    await act(async () => {
      newPage.resolve([profile('prof_new', 'Newer snapshot')]);
      await flush();
    });
    expect(screen.getByText('Newer snapshot')).toBeInTheDocument();

    await act(async () => {
      oldPage.resolve([profile('prof_old', 'Older snapshot')]);
      await flush();
    });
    expect(screen.getByText('Newer snapshot')).toBeInTheDocument();
    expect(screen.queryByText('Older snapshot')).toBeNull();
  });

  it('fences an older detached agent-list result behind the newer refresh generation', async () => {
    const firstCore = deferred<ReturnType<typeof profile>[]>();
    const secondCore = deferred<ReturnType<typeof profile>[]>();
    const oldAgents = deferred<{ data: Array<Record<string, unknown>> }>();
    const newAgents = deferred<{ data: Array<Record<string, unknown>> }>();
    profilePages.push(firstCore, secondCore);
    agentPages.push(oldAgents, newAgents);
    bindings = [
      {
        profileId: 'prof_1',
        defaultProxyId: null,
        currentSessionId: 'agt_live',
        lastLaunchedAt: null,
      },
    ];
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await act(async () => {
      firstCore.resolve([profile('prof_1', 'Stable')]);
      await flush();
    });
    expect(agentSessionsList).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
      secondCore.resolve([profile('prof_1', 'Stable')]);
      await flush();
    });
    expect(agentSessionsList).toHaveBeenCalledTimes(2);

    await act(async () => {
      newAgents.resolve({
        data: [{ id: 'agt_live', created_at: '2026-07-01T00:00:00Z', status: 'active' }],
      });
      await flush();
    });
    expect(screen.getByRole('button', { name: 'Open session' })).toBeInTheDocument();

    await act(async () => {
      oldAgents.resolve({ data: [] });
      await flush();
    });
    expect(screen.getByRole('button', { name: 'Open session' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Launch' })).toBeNull();
  });

  it('invalidates held core work on unmount before detached or metadata publication', async () => {
    const held = deferred<ReturnType<typeof profile>[]>();
    profilePages.push(held);
    const { unmount } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    await act(flush);
    expect(profileIteration).toBe(1);
    unmount();

    await act(async () => {
      held.resolve([profile('prof_late', 'Late')]);
      await flush();
    });
    expect(agentSessionsList).not.toHaveBeenCalled();
    expect(seedMetaFromServer).not.toHaveBeenCalled();
    expect(persistProfilesMeta).not.toHaveBeenCalled();
  });
});
