// Deep-audit LOW: in the create-profile modal's inline "Add new proxy" flow, a
// FAILED profile create (after the proxy was already minted) used to let the
// user retry — and re-run addProxy, minting a SECOND identical proxy. Now the
// minted proxy id is cached for the modal session so a retry REUSES it. This
// drives the real modal: a create that rejects once then succeeds must call
// addProxy exactly once across both attempts.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

const addProxy = vi.fn<(d: unknown) => Promise<{ id: string }>>(() =>
  Promise.resolve({ id: 'p_minted' }),
);
const profilesCreate = vi.fn<(b: unknown) => Promise<{ id: string }>>();
const setDefaultProxy = vi.fn(() => Promise.resolve());

// STABLE context object (referential identity preserved across renders) — a
// fresh literal each call re-fires every client/accountMe effect → render loop.
const stableContext = {
  client: {
    profiles: {
      list: () => Promise.resolve({ data: [] }),
      iterate: function* () {
        /* empty */
      },
      create: (b: unknown) => profilesCreate(b),
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
    profile_count: 0,
  },
  refreshAccountMe: vi.fn(() => Promise.resolve()),
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
  setDefaultProxy: (...a: unknown[]) => setDefaultProxy(...(a as [])),
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
  addProxy: (d: unknown) => addProxy(d),
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

async function openModalAndFill(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Create your first profile' }));
  // Name (Identity tab is default).
  const nameInput = await screen.findByPlaceholderText('my-recurring-workflow');
  fireEvent.change(nameInput, { target: { value: 'Retry Profile' } });
  // Proxy tab → inline create-new SOCKS5 (the default when no saved proxies).
  fireEvent.click(await screen.findByRole('tab', { name: '🌍 Proxy' }));
  fireEvent.change(await screen.findByPlaceholderText(/Label \(e\.g\./i), {
    target: { value: 'inline-eu' },
  });
  fireEvent.change(await screen.findByPlaceholderText(/Host \(e\.g\. proxy\.example\.com\)/), {
    target: { value: 'proxy.example.com' },
  });
}

describe('create-profile modal — inline proxy is not duplicated on a failed-then-retried create', () => {
  beforeEach(() => {
    addProxy.mockClear();
    addProxy.mockResolvedValue({ id: 'p_minted' });
    profilesCreate.mockReset();
    setDefaultProxy.mockClear();
  });

  it('mints the proxy ONCE across a failed attempt and a successful retry', async () => {
    // First create fails (e.g. dup name); second succeeds.
    profilesCreate
      .mockRejectedValueOnce(new Error('name already exists'))
      .mockResolvedValueOnce({ id: 'prof_ok' });

    await openModalAndFill();

    // Attempt 1 — the create rejects; the error surfaces and the modal stays open.
    fireEvent.click(screen.getByRole('button', { name: /^Create profile$/ }));
    await waitFor(() => expect(profilesCreate).toHaveBeenCalledTimes(1));
    // The proxy was minted on this first attempt.
    await waitFor(() => expect(addProxy).toHaveBeenCalledTimes(1));

    // Attempt 2 — retry; the create succeeds this time.
    fireEvent.click(screen.getByRole('button', { name: /^Create profile$/ }));
    await waitFor(() => expect(profilesCreate).toHaveBeenCalledTimes(2));

    // The proxy must NOT have been minted a second time (no duplicate).
    expect(addProxy).toHaveBeenCalledTimes(1);
    // And the profile was bound to the SAME minted proxy id.
    await waitFor(() => expect(setDefaultProxy).toHaveBeenCalledWith('prof_ok', 'p_minted'));
  });

  it('a follow-up-step failure is best-effort — the create still completes (no retry loop → no re-bill)', async () => {
    // Profile create SUCCEEDS; the follow-up bind (setDefaultProxy) throws. The
    // follow-ups are best-effort, so the submit still completes (onCreated →
    // modal closes) instead of surfacing an error and stranding the user in a
    // retry that would re-run profiles.create and mint a SECOND billed profile.
    profilesCreate.mockResolvedValue({ id: 'prof_once' });
    setDefaultProxy.mockRejectedValueOnce(new Error('binding store offline'));

    await openModalAndFill();
    fireEvent.click(screen.getByRole('button', { name: /^Create profile$/ }));
    await waitFor(() => expect(profilesCreate).toHaveBeenCalledTimes(1));

    // The modal closed on success (the Create-profile button is gone) — the
    // follow-up failure did NOT keep it open for a re-bill retry.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: /^Create profile$/ })).toBeNull(),
    );
    // And the profile was created exactly once.
    expect(profilesCreate).toHaveBeenCalledTimes(1);
  });
});

describe('create-profile modal — client-side name validation (specific message, not opaque 422)', () => {
  beforeEach(() => {
    addProxy.mockClear();
    profilesCreate.mockReset();
    setDefaultProxy.mockClear();
  });

  it('blocks an invalid name client-side (server create is never called) and shows a specific message', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Create your first profile' }));
    const nameInput = await screen.findByPlaceholderText('my-recurring-workflow');
    // A name that violates ProfileNameSchema (trailing punctuation).
    fireEvent.change(nameInput, { target: { value: 'bad-name.' } });
    fireEvent.click(screen.getByRole('button', { name: /^Create profile$/ }));

    // Specific, actionable message — NOT the opaque server "Validation Failed".
    expect(await screen.findByText(/start and end with a letter or digit/i)).toBeInTheDocument();
    // The server create was never attempted (pure client-side pre-flight).
    expect(profilesCreate).not.toHaveBeenCalled();
  });
});

describe('create-profile modal — unsaved draft close guard', () => {
  function renderWithConfirm(): void {
    render(
      <ConfirmProvider>
        <ProfilesView onGoToSettings={vi.fn()} />
      </ConfirmProvider>,
    );
  }

  async function openCreate(): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: 'Create your first profile' }));
    return screen.findByPlaceholderText('my-recurring-workflow');
  }

  it('a pristine form closes on backdrop without a false dirty prompt after proxy hydration', async () => {
    renderWithConfirm();
    await openCreate();
    fireEvent.click(await screen.findByRole('tab', { name: '🌍 Proxy' }));
    // Zero saved proxies auto-selects the inline create-new path. Waiting for
    // its controls proves hydration completed before we test the dirty baseline.
    await screen.findByPlaceholderText(/Label \(e\.g\./i);
    const formDialog = screen.getByRole('dialog', { name: 'New profile' });
    fireEvent.click(formDialog);
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New profile' })).toBeNull());
    expect(screen.queryByText(/Discard your unsaved profile changes/i)).toBeNull();
  });

  it('backdrop asks before discarding and Cancel preserves the exact typed draft', async () => {
    renderWithConfirm();
    const name = await openCreate();
    fireEvent.change(name, { target: { value: 'Keep this draft' } });

    fireEvent.click(screen.getByRole('dialog', { name: 'New profile' }));
    const confirmDialog = await screen.findByRole('dialog', {
      name: /Discard your unsaved profile changes/i,
    });
    expect(screen.getByDisplayValue('Keep this draft')).toBeInTheDocument();

    fireEvent.click(within(confirmDialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: /Discard your unsaved profile changes/i }),
      ).toBeNull(),
    );
    expect(screen.getByDisplayValue('Keep this draft')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('dialog', { name: 'New profile' }));
    const secondConfirm = await screen.findByRole('dialog', {
      name: /Discard your unsaved profile changes/i,
    });
    fireEvent.click(within(secondConfirm).getByRole('button', { name: 'Discard changes' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'New profile' })).toBeNull());
  });
});
