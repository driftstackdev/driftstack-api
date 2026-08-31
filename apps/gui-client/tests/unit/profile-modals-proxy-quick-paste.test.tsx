// V-2168 (owner 2026-08-30) — the Proxies-page "Quick paste" autofill now
// exists wherever a proxy can be ENTERED: the create-profile modal's inline
// "+ Add new proxy…" form, and the edit-profile modal (which previously had no
// way to add a proxy at all — only a select over saved ones).
//
// These arms drive the REAL parseProxyString (pure module, deliberately not
// mocked) through the real modals: a pasted vendor line fills all four fields,
// and in the edit modal the minted proxy is created + bound on Save.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

function profileFixture() {
  return {
    id: 'prof_1',
    name: 'Warm profile',
    archetype: 'iphone17_ios18_7_safari26_4',
    description: '',
    last_used_at: null,
    size_bytes: 3_145_728,
    created_at: '2026-08-01T00:00:00Z',
    updated_at: '2026-08-01T00:00:00Z',
  };
}

const addProxy = vi.fn((..._args: unknown[]) => Promise.resolve({ id: 'p_minted' }));
const setDefaultProxy = vi.fn((..._args: unknown[]) => Promise.resolve());
const updateProfile = vi.fn((..._args: unknown[]) => Promise.resolve({}));

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: [profileFixture()] }),
        // The view loads via iterate — an empty generator here renders an empty
        // hub and every card-based arm silently tests nothing.
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          yield profileFixture();
        },
        create: vi.fn(() => Promise.resolve({ id: 'prof_new' })),
        update: (...args: unknown[]) => updateProfile(...args),
      },
      sessions: { list: () => Promise.resolve({ data: [] }) },
      agentSessions: { list: () => Promise.resolve({ data: [] }) },
    },
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 1,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 1,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
  };
  return { useSettings: () => stable };
});

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
  loadFolderIcons: () => Promise.resolve({}),
  replaceAllFolders: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/tags-store', () => ({
  loadTags: () => Promise.resolve([]),
  addTag: vi.fn(() => Promise.resolve([])),
  replaceAllTags: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/account-organization', () => ({
  fetchOrganization: () => Promise.reject(new Error('offline')),
  saveOrganization: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  loadProbeCache: () => Promise.resolve({}),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveExitResult: vi.fn(() => Promise.resolve({})),
}));
vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));
vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => Promise.resolve([]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: (...args: unknown[]) => setDefaultProxy(...args),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/proxies', () => ({
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  proxyVerdict: (): { ok: boolean; label: string } => ({ ok: true, label: 'Reachable · 12 ms' }),
  listProxies: () => Promise.resolve([]),
  addProxy: (...args: unknown[]) => addProxy(...args),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.resolve({})),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

// One vendor-form line (colon-delimited, hyphenated user blob) — the exact
// shape the Proxies page was built for.
const VENDOR_LINE = 'gate.nodemaven.com:1080:user-country-us-sid-42:s3cret';

beforeEach(() => {
  addProxy.mockClear();
  setDefaultProxy.mockClear();
  updateProfile.mockClear();
});

describe('create-profile modal — proxy quick paste', () => {
  it('⛔ a pasted vendor line fills host, port, username and password', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: /New profile/ }));
    fireEvent.click(await screen.findByRole('tab', { name: '🌍 Proxy' }));
    // With no saved proxies the selector defaults to the inline create-new form.
    const paste = await screen.findByPlaceholderText(/Quick paste/);
    fireEvent.change(paste, { target: { value: VENDOR_LINE } });

    expect((await screen.findByPlaceholderText<HTMLInputElement>(/Host \(e\.g\./)).value).toBe(
      'gate.nodemaven.com',
    );
    expect(screen.getByPlaceholderText<HTMLInputElement>('Port').value).toBe('1080');
    expect(screen.getByPlaceholderText<HTMLInputElement>(/Username/).value).toBe(
      'user-country-us-sid-42',
    );
    expect(screen.getByPlaceholderText<HTMLInputElement>(/Password/).value).toBe('s3cret');
    // The paste field clears itself so the credential doesn't linger twice.
    expect((paste as HTMLInputElement).value).toBe('');
  });
});

describe('edit-profile modal — inline "+ Add new proxy…"', () => {
  async function openEditModal(): Promise<void> {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const menu = await screen.findByRole('button', { name: 'More actions' });
    fireEvent.click(menu);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit Warm profile' }));
  }

  it('⛔ paste + Save mints the proxy and binds it to the profile', async () => {
    await openEditModal();
    const select = await screen.findByLabelText('Profile proxy');
    fireEvent.change(select, { target: { value: 'create-new' } });

    fireEvent.change(screen.getByPlaceholderText(/Label \(e\.g\./), {
      target: { value: 'pasted-proxy' },
    });
    fireEvent.change(screen.getByPlaceholderText(/Quick paste/), {
      target: { value: VENDOR_LINE },
    });
    expect(screen.getByPlaceholderText<HTMLInputElement>(/Host \(e\.g\./).value).toBe(
      'gate.nodemaven.com',
    );

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    await waitFor(() => {
      expect(addProxy).toHaveBeenCalledWith(
        expect.objectContaining({
          label: 'pasted-proxy',
          scheme: 'socks5',
          host: 'gate.nodemaven.com',
          port: 1080,
          username: 'user-country-us-sid-42',
          password: 's3cret',
        }),
      );
    });
    await waitFor(() => {
      expect(setDefaultProxy).toHaveBeenCalledWith('prof_1', 'p_minted');
    });
  });

  it('an empty label blocks the save BEFORE any request leaves', async () => {
    await openEditModal();
    const select = await screen.findByLabelText('Profile proxy');
    fireEvent.change(select, { target: { value: 'create-new' } });
    fireEvent.change(screen.getByPlaceholderText(/Quick paste/), {
      target: { value: VENDOR_LINE },
    });

    fireEvent.click(screen.getByRole('button', { name: /Save/ }));

    expect(await screen.findByText('Proxy label is required.')).toBeInTheDocument();
    // The PATCH must not have gone out with the proxy half broken.
    expect(updateProfile).not.toHaveBeenCalled();
    expect(addProxy).not.toHaveBeenCalled();
  });
});
