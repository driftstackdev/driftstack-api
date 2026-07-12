// Behavior coverage for the profile-ORGANIZATION management GUI features wired
// into ProfilesView (2026-06-19, founder GUI-improvement audit):
//   • Folder/tag DELETE + folder RE-ICON from the rail ⋯ menu — and CRITICALLY
//     that each removal/re-icon PUSHES the shrunk/edited taxonomy to the account
//     org (the known gap: only CREATE pushed before).
//   • Folder/tag RENAME re-assigns every profile carrying the old name.
//   • Post-create proxy REBIND in the Edit modal → setDefaultProxy.
//   • Bulk CLEAR-folder + bulk REMOVE-tag (the additive bulk bar was one-way).
//
// Mirrors profiles-lifecycle-actions.test.tsx's harness: a stable context so
// effects don't loop, plus spied stores/clients so we can assert the wiring.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const profilesUpdate = vi.fn<(id: string, body: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'prof_1' }),
);

function profile(over: Record<string, unknown> = {}) {
  return {
    id: 'prof_1',
    name: 'Demo',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: 'orig desc',
    last_used_at: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
    ...over,
  };
}
const PROF_B = profile({ id: 'prof_2', name: 'Second' });

const stableClient = {
  profiles: {
    list: () => Promise.resolve({ data: [profile(), PROF_B] }),
    // eslint-disable-next-line @typescript-eslint/require-await
    iterate: async function* () {
      yield profile();
      yield PROF_B;
    },
    update: (id: string, body: unknown) => profilesUpdate(id, body),
  },
  sessions: { list: () => Promise.resolve({ data: [] }) },
  agentSessions: { list: () => Promise.resolve({ data: [] }) },
};
const stableAccountMe = {
  tier: 'solo_manual',
  concurrent_session_cap: 5,
  concurrent_session_active: 0,
  profile_cap: 10,
  profile_count: 2,
};
const stableSettings = { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' };
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client: stableClient,
    settings: stableSettings,
    accountMe: stableAccountMe,
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  }),
}));

// prof_1 lives in folder "Work" with tag "aged"; prof_2 in "Work" too.
const META: Record<string, { folder: string; tags: string[]; note: string; icon: string }> = {
  prof_1: { folder: 'Work', tags: ['aged'], note: '', icon: '' },
  prof_2: { folder: 'Work', tags: [], note: '', icon: '' },
};
const loadProfilesMeta = vi.fn(() => Promise.resolve({ ...META }));
const saveProfilesMetaBulk = vi.fn(
  (ids: string[], meta: { folder?: string; tags?: string[] }, mode: string) => {
    for (const id of ids) {
      const cur = META[id] ?? { folder: '', tags: [], note: '', icon: '' };
      if (meta.folder !== undefined) cur.folder = meta.folder;
      if (meta.tags !== undefined) {
        if (mode === 'merge') cur.tags = [...new Set([...cur.tags, ...meta.tags])];
        else if (mode === 'remove') cur.tags = cur.tags.filter((t) => !meta.tags!.includes(t));
        else cur.tags = meta.tags;
      }
      META[id] = cur;
    }
    return Promise.resolve({ ...META });
  },
);
const saveProfileMeta = vi.fn(() => Promise.resolve({ ...META }));
vi.mock('../../src/lib/profiles-meta', () => ({
  loadProfilesMeta: () => loadProfilesMeta(),
  persistProfilesMeta: vi.fn(() => Promise.resolve()),
  saveProfileMeta: (...a: unknown[]) => saveProfileMeta(...(a as [])),
  saveProfilesMetaBulk: (...a: unknown[]) =>
    saveProfilesMetaBulk(...(a as Parameters<typeof saveProfilesMetaBulk>)),
  seedMetaFromServer: (local: unknown) => ({ map: local, changed: false }),
  folderList: () => ['Work'],
  aggregateTags: () => [{ tag: 'aged', count: 1 }],
}));

const removeFolder = vi.fn(() => Promise.resolve([]));
const renameFolder = vi.fn(() => Promise.resolve(['Retail']));
const setFolderIcon = vi.fn(() => Promise.resolve({ Work: '🛒' }));
const addFolder = vi.fn(() => Promise.resolve(['Work']));
vi.mock('../../src/lib/folders-store', () => ({
  loadFolders: () => Promise.resolve(['Work']),
  addFolder: (...a: unknown[]) => addFolder(...(a as [])),
  removeFolder: (...a: unknown[]) => removeFolder(...(a as [])),
  renameFolder: (...a: unknown[]) => renameFolder(...(a as [])),
  setFolderIcon: (...a: unknown[]) => setFolderIcon(...(a as [])),
  loadFolderIcons: () => Promise.resolve({}),
  replaceAllFolders: vi.fn(() => Promise.resolve()),
}));
const removeTag = vi.fn(() => Promise.resolve([]));
const renameTag = vi.fn(() => Promise.resolve(['warmup']));
vi.mock('../../src/lib/tags-store', () => ({
  loadTags: () => Promise.resolve(['aged']),
  addTag: vi.fn(() => Promise.resolve(['aged'])),
  removeTag: (...a: unknown[]) => removeTag(...(a as [])),
  renameTag: (...a: unknown[]) => renameTag(...(a as [])),
  replaceAllTags: vi.fn(() => Promise.resolve()),
}));

const saveOrganization = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/account-organization', () => ({
  // Reject the pull so the local cache (loaded above) is what the rail shows.
  fetchOrganization: () => Promise.reject(new Error('offline')),
  saveOrganization: (...a: unknown[]) => saveOrganization(...(a as [])),
}));
vi.mock('../../src/lib/proxy-probe-cache', () => ({
  loadProbeCache: () => Promise.resolve({}),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveExitResult: vi.fn(() => Promise.resolve({})),
}));

const setDefaultProxy = vi.fn(() => Promise.resolve());
const BINDINGS = [{ profileId: 'prof_1', defaultProxyId: null, currentSessionId: null }];
vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => Promise.resolve(BINDINGS),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: (...a: unknown[]) => setDefaultProxy(...(a as [])),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

const PROXIES = [
  { id: 'px_1', label: 'EU SOCKS', scheme: 'socks5', host: '1.2.3.4', port: 1080 },
  { id: 'px_2', label: 'US SOCKS', scheme: 'socks5', host: '5.6.7.8', port: 1080 },
];
vi.mock('../../src/lib/proxies', () => ({
  listProxies: () => Promise.resolve(PROXIES),
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
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

function reseedMeta(): void {
  META.prof_1 = { folder: 'Work', tags: ['aged'], note: '', icon: '' };
  META.prof_2 = { folder: 'Work', tags: [], note: '', icon: '' };
}

describe('ProfilesView organization management', () => {
  beforeEach(() => {
    profilesUpdate.mockClear();
    saveOrganization.mockClear();
    removeFolder.mockClear();
    renameFolder.mockClear();
    setFolderIcon.mockClear();
    addFolder.mockClear();
    removeTag.mockClear();
    renameTag.mockClear();
    setDefaultProxy.mockReset();
    setDefaultProxy.mockResolvedValue(undefined);
    saveProfileMeta.mockClear();
    saveProfilesMetaBulk.mockClear();
    reseedMeta();
    loadProfilesMeta.mockReset();
    loadProfilesMeta.mockResolvedValue({ ...META });
  });

  describe('folder/tag delete + re-icon (with org push)', () => {
    it('deletes a folder and PUSHES the shrunk taxonomy to the account org', async () => {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      // Open the folder row's ⋯ menu, then Delete.
      fireEvent.click(await screen.findByRole('button', { name: 'Manage folder Work' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      await waitFor(() => expect(removeFolder).toHaveBeenCalledWith('Work'));
      // The known gap: removal must sync to the account org (tags carried through).
      await waitFor(() => expect(saveOrganization).toHaveBeenCalled());
      const org = saveOrganization.mock.calls.at(-1)?.[2] as { folders: unknown[]; tags: string[] };
      expect(org.folders).toEqual([]); // shrunk
      expect(org.tags).toEqual(['aged']);
    });

    it('re-icons a folder (PROFILE_ICONS picker) and pushes the edited org', async () => {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Manage folder Work' }));
      const picker = await screen.findByRole('combobox', { name: 'Re-icon folder Work' });
      fireEvent.change(picker, { target: { value: '🛒' } });
      await waitFor(() => expect(setFolderIcon).toHaveBeenCalledWith('Work', '🛒'));
      await waitFor(() => expect(saveOrganization).toHaveBeenCalled());
      const org = saveOrganization.mock.calls.at(-1)?.[2] as {
        folders: { name: string; icon?: string }[];
      };
      expect(org.folders).toContainEqual({ name: 'Work', icon: '🛒' });
    });

    it('deletes a tag and PUSHES the shrunk taxonomy to the account org', async () => {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Manage tag aged' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      await waitFor(() => expect(removeTag).toHaveBeenCalledWith('aged'));
      await waitFor(() => expect(saveOrganization).toHaveBeenCalled());
      const org = saveOrganization.mock.calls.at(-1)?.[2] as { tags: string[] };
      expect(org.tags).toEqual([]); // shrunk
    });
  });

  describe('folder/tag rename (re-assigns affected profiles)', () => {
    it('renames a folder and re-assigns EVERY profile in it (bulk + per-profile PATCH)', async () => {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Manage folder Work' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
      const input = await screen.findByRole('textbox', { name: 'Rename folder Work' });
      fireEvent.change(input, { target: { value: 'Retail' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(renameFolder).toHaveBeenCalledWith('Work', 'Retail'));
      // Both profiles live in Work → both re-assigned in one bulk call + PATCHed.
      await waitFor(() =>
        expect(saveProfilesMetaBulk).toHaveBeenCalledWith(
          expect.arrayContaining(['prof_1', 'prof_2']),
          { folder: 'Retail' },
          'replace',
          expect.anything(),
        ),
      );
      await waitFor(() =>
        expect(profilesUpdate).toHaveBeenCalledWith('prof_1', { folder: 'Retail' }),
      );
      expect(profilesUpdate).toHaveBeenCalledWith('prof_2', { folder: 'Retail' });
      await waitFor(() => expect(saveOrganization).toHaveBeenCalled());
    });

    it('renames a tag and swaps it on every profile carrying it', async () => {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      fireEvent.click(await screen.findByRole('button', { name: 'Manage tag aged' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Rename' }));
      const input = await screen.findByRole('textbox', { name: 'Rename tag aged' });
      fireEvent.change(input, { target: { value: 'warmup' } });
      fireEvent.keyDown(input, { key: 'Enter' });
      await waitFor(() => expect(renameTag).toHaveBeenCalledWith('aged', 'warmup'));
      // Subtract the old tag then union the new one (two bulk passes).
      await waitFor(() =>
        expect(saveProfilesMetaBulk).toHaveBeenCalledWith(
          ['prof_1'],
          { tags: ['aged'] },
          'remove',
          expect.anything(),
        ),
      );
      expect(saveProfilesMetaBulk).toHaveBeenCalledWith(
        ['prof_1'],
        { tags: ['warmup'] },
        'merge',
        expect.anything(),
      );
      await waitFor(() =>
        expect(profilesUpdate).toHaveBeenCalledWith('prof_1', { tags: ['warmup'] }),
      );
    });
  });

  describe('post-create proxy rebind', () => {
    async function openEdit(withConfirm = false): Promise<void> {
      render(
        withConfirm ? (
          <ConfirmProvider>
            <ProfilesView onGoToSettings={vi.fn()} />
          </ConfirmProvider>
        ) : (
          <ProfilesView onGoToSettings={vi.fn()} />
        ),
      );
      fireEvent.click((await screen.findAllByRole('button', { name: 'More actions' }))[0]!);
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Demo' }));
      await screen.findByRole('heading', { name: 'Edit profile' });
    }

    it('rebinds the proxy via setDefaultProxy when the selection changes', async () => {
      await openEdit();
      // Default selection is "first-available" (binding defaultProxyId === null).
      const select = screen.getByRole('combobox', { name: 'Profile proxy' });
      fireEvent.change(select, { target: { value: 'px_2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(setDefaultProxy).toHaveBeenCalledWith('prof_1', 'px_2'));
    });

    it('does NOT rebind when the proxy selection is unchanged', async () => {
      await openEdit();
      // Change only the name; leave the proxy on first-available.
      fireEvent.change(screen.getByDisplayValue('Demo'), { target: { value: 'Renamed' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() =>
        expect(profilesUpdate).toHaveBeenCalledWith('prof_1', { name: 'Renamed' }),
      );
      expect(setDefaultProxy).not.toHaveBeenCalled();
    });

    // Audit (finding 4): a FAILED local proxy-rebind (a Tauri store IO error)
    // must NOT discard the just-saved org metadata. The server PATCH already
    // succeeded; onSaved → saveProfileMeta mirrors folder/tags/icon/note into the
    // local cache (the hub's source of truth — seedMetaFromServer never re-seeds a
    // profile that already has a local entry). Before the fix, the unguarded
    // setDefaultProxy await jumped to the catch and skipped onSaved, so the edit
    // looked silently reverted in the hub. setDefaultProxy is now best-effort, so
    // saveProfileMeta still runs even when the rebind throws.
    it('still mirrors org metadata (saveProfileMeta) when the proxy rebind throws', async () => {
      // The local rebind write fails on THIS save only.
      setDefaultProxy.mockRejectedValueOnce(new Error('store IO error'));
      await openEdit();
      // Edit the NOTE (an org-metadata field that flows through onSaved) AND
      // change the proxy so both code paths run on the same save. The Note
      // textarea starts empty (meta.note === ''); the Description textarea holds
      // 'orig desc' — pick the empty one so we target Note, not Description.
      const textareas = screen.getAllByRole('textbox').filter((el) => el.tagName === 'TEXTAREA');
      const noteField = textareas.find((el) => (el as HTMLTextAreaElement).value === '');
      expect(noteField).toBeTruthy();
      fireEvent.change(noteField!, { target: { value: 'keep this note' } });
      fireEvent.change(screen.getByRole('combobox', { name: 'Profile proxy' }), {
        target: { value: 'px_2' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      // The rebind was attempted (and rejected)…
      await waitFor(() => expect(setDefaultProxy).toHaveBeenCalledWith('prof_1', 'px_2'));
      // …but the org-metadata mirror STILL ran (onSaved was not skipped), so the
      // hub keeps the new values instead of silently reverting to the old ones.
      // The edited note rides through to the local cache write.
      await waitFor(() =>
        expect(saveProfileMeta).toHaveBeenCalledWith(
          'prof_1',
          expect.objectContaining({ note: 'keep this note' }),
          expect.anything(),
        ),
      );
      // The server PATCH of the edited note also went through (not aborted).
      expect(profilesUpdate).toHaveBeenCalledWith('prof_1', { note: 'keep this note' });
      // The modal closed on success (onSaved → setEditTarget(null)) — a rebind
      // failure no longer surfaces as a blocking form error.
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Edit profile' })).toBeNull(),
      );
    });

    it('Escape and Close share the dirty guard; Cancel preserves edits and Discard closes', async () => {
      await openEdit(true);
      fireEvent.change(screen.getByDisplayValue('Demo'), { target: { value: 'Keep renamed' } });

      fireEvent.keyDown(window, { key: 'Escape' });
      await screen.findByRole('dialog', {
        name: /Discard your unsaved profile changes/i,
      });
      // Escape again dismisses the branded confirmation. The underlying form's
      // Escape trap sees the same event, so this also pins the re-entrancy guard:
      // no replacement confirm may appear and the exact draft must remain.
      fireEvent.keyDown(window, { key: 'Escape' });
      await waitFor(() =>
        expect(
          screen.queryByRole('dialog', { name: /Discard your unsaved profile changes/i }),
        ).toBeNull(),
      );
      expect(screen.getByDisplayValue('Keep renamed')).toBeInTheDocument();

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      const closeConfirm = await screen.findByRole('dialog', {
        name: /Discard your unsaved profile changes/i,
      });
      fireEvent.click(within(closeConfirm).getByRole('button', { name: 'Discard changes' }));
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Edit profile' })).toBeNull(),
      );
      expect(profilesUpdate).not.toHaveBeenCalled();
    });

    it('keeps a pristine baseline when profile metadata finishes loading behind the open modal', async () => {
      let resolveMeta: ((value: typeof META) => void) | undefined;
      const delayedMeta = new Promise<typeof META>((resolve) => {
        resolveMeta = resolve;
      });
      loadProfilesMeta.mockReturnValueOnce(delayedMeta);

      await openEdit(true);
      // The modal opened before metadata arrived, so its snapshot is the blank
      // baseline visible at that moment. A background metadata refresh must not
      // silently rewrite that baseline and make the untouched form dirty.
      await act(async () => {
        resolveMeta?.({ ...META });
        await delayedMeta;
      });

      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await waitFor(() =>
        expect(screen.queryByRole('heading', { name: 'Edit profile' })).toBeNull(),
      );
      expect(screen.queryByText(/Discard your unsaved profile changes/i)).toBeNull();
    });
  });

  describe('bulk folder/tag remove', () => {
    async function selectBoth(): Promise<void> {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      // Grid cards are selectable buttons ("Select <name>"); click both so the
      // bulk bar appears.
      fireEvent.click(await screen.findByRole('button', { name: 'Select Demo' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Select Second' }));
      await screen.findByText(/selected/);
    }

    it('bulk Clear folder: replace folder→"" + PATCH folder:null per profile', async () => {
      await selectBoth();
      fireEvent.click(await screen.findByRole('button', { name: 'Clear folder' }));
      await waitFor(() =>
        expect(saveProfilesMetaBulk).toHaveBeenCalledWith(
          expect.arrayContaining(['prof_1', 'prof_2']),
          { folder: '' },
          'replace',
          expect.anything(),
        ),
      );
      await waitFor(() => expect(profilesUpdate).toHaveBeenCalledWith('prof_1', { folder: null }));
      expect(profilesUpdate).toHaveBeenCalledWith('prof_2', { folder: null });
    });

    it('bulk Remove tag: subtracts the typed tag + PATCHes the recomputed set', async () => {
      await selectBoth();
      fireEvent.change(screen.getByLabelText('Bulk tag'), { target: { value: 'aged' } });
      fireEvent.click(screen.getByRole('button', { name: 'Remove tag' }));
      await waitFor(() =>
        expect(saveProfilesMetaBulk).toHaveBeenCalledWith(
          expect.arrayContaining(['prof_1', 'prof_2']),
          { tags: ['aged'] },
          'remove',
          expect.anything(),
        ),
      );
      // prof_1 carried 'aged' → recomputed to [] and PATCHed.
      await waitFor(() => expect(profilesUpdate).toHaveBeenCalledWith('prof_1', { tags: [] }));
    });

    it('bulk Set icon CLEARS the selection afterwards (consistent with the other bulk actions)', async () => {
      await selectBoth();
      // Apply an icon via the "Set icon" select.
      fireEvent.change(screen.getByLabelText('Set icon'), { target: { value: '🛒' } });
      await waitFor(() =>
        expect(saveProfilesMetaBulk).toHaveBeenCalledWith(
          expect.arrayContaining(['prof_1', 'prof_2']),
          { icon: '🛒' },
          'merge',
          expect.anything(),
        ),
      );
      // The selection is dismissed — the bulk bar's "N selected" chip is gone,
      // matching Apply / Clear folder / Remove tag (it used to stay up).
      await waitFor(() => expect(screen.queryByText(/selected/)).toBeNull());
    });
  });
});
