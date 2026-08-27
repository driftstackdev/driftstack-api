// Behavior coverage for the profile-lifecycle GUI actions wired into
// ProfilesView: Edit (PATCH a minimal diff), Clone (server duplicate, cap-
// gated), and Import (parse a single envelope OR a bulk array and import each).
// All three back onto already-shipped SDK methods; these pin the GUI wiring.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';

// Clone and Import are flag-gated in the view (founder 2026-06-20: clone deemed
// useless, import/export a profile-cheat abuse vector). The handlers were kept
// for reversibility, and these suites with them.
//
// They used to be `describe.skip`, with a comment asking whoever flips the flag
// to re-enable them. A comment is not a mechanism: flipping the flag would leave
// six tests silently skipped, and the skip guard could not see them either
// because it collected `.test.ts` and `.spec.ts` only, never `.test.tsx`.
//
// The condition is now READ FROM THE VIEW, so the flag and the coverage move
// together — flip it and these run on the next suite pass, with no one having to
// remember this file exists.
const VIEW = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'src',
  'views',
  'ProfilesView.tsx',
);

function viewFlag(name: string): boolean {
  const match = new RegExp(`const ${name} = (true|false);`).exec(readFileSync(VIEW, 'utf8'));
  if (match === null) {
    throw new Error(`${name} not found in ProfilesView.tsx — the gate this suite reads has moved`);
  }
  return match[1] === 'true';
}

const CLONE_ENABLED = viewFlag('CLONE_ENABLED');
const IMPORT_EXPORT_ENABLED = viewFlag('IMPORT_EXPORT_ENABLED');

const profilesUpdate = vi.fn<(id: string, body: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'prof_1' }),
);
const profilesClone = vi.fn<(id: string) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'prof_clone', name: 'Demo (copy)' }),
);
const profilesImport = vi.fn<(body: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'prof_imported', name: 'Imported' }),
);
// doc-150 §8 — POST /v1/profiles/:id/trim. Default to the `ok` shape so the
// success-notice path is exercised; individual tests override the resolution.
// W3120 — the double must forward EVERY argument. It used to take only `id`, so
// once trim gained a scope the mock silently dropped it and an assertion about
// which scope was sent could never fail. A double that cannot see an argument
// cannot test it.
const profilesTrim = vi.fn<(id: string, body?: { scope?: string }) => Promise<unknown>>(() =>
  Promise.resolve({ status: 'ok', size_bytes: 1024, bytes_reclaimed: 2_097_152 }),
);
const refreshAccountMe = vi.fn(() => Promise.resolve());

function profile() {
  return {
    id: 'prof_1',
    name: 'Demo',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: 'orig desc',
    last_used_at: null,
    // doc-150 item 5 — sealed-store size; ~3 MiB so the storage meter + the
    // per-row size both render a non-"—" value.
    size_bytes: 3_145_728,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
  };
}

// Cap state is per-test: a high cap leaves the affordances enabled; an at-cap
// account must disable Clone/Import + New.
let capState = { profile_cap: 10, profile_count: 1 };

// A STABLE context object (referential identity preserved across renders) —
// returning a fresh literal each call re-fires every effect that depends on
// client/settings/accountMe → an infinite render loop. accountMe is rebuilt
// per-render only when the cap changes (capState is a module-level let).
const stableClient = {
  profiles: {
    list: () => Promise.resolve({ data: [profile()] }),
    // eslint-disable-next-line @typescript-eslint/require-await
    iterate: async function* () {
      yield profile();
    },
    update: (id: string, body: unknown) => profilesUpdate(id, body),
    clone: (id: string) => profilesClone(id),
    import: (body: unknown) => profilesImport(body),
    trim: (id: string, body?: { scope?: string }) =>
      body === undefined ? profilesTrim(id) : profilesTrim(id, body),
  },
  sessions: { list: () => Promise.resolve({ data: [] }) },
  agentSessions: { list: () => Promise.resolve({ data: [] }) },
};
let stableAccountMe = makeAccountMe();
function makeAccountMe(): Record<string, unknown> {
  return {
    tier: 'solo_manual',
    concurrent_session_cap: 1,
    concurrent_session_active: 0,
    profile_cap: capState.profile_cap,
    profile_count: capState.profile_count,
  };
}
const stableSettings = { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' };
const setActiveWorkspace = vi.fn();
vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => ({
    client: stableClient,
    settings: stableSettings,
    accountMe: stableAccountMe,
    refreshAccountMe,
    loading: false,
    activeWorkspace: null,
    setActiveWorkspace,
  }),
}));

// Real LazyStore throws in jsdom — mock the organization store so clone's
// meta-seed + edit's meta-mirror resolve, and seed prof_1 with known metadata
// the Edit modal can prefill.
const META = {
  prof_1: { folder: 'Work', tags: ['a', 'b'], note: 'a note', icon: '🦊' },
};
vi.mock('../../src/lib/profiles-meta', () => ({
  loadProfilesMeta: () => Promise.resolve(META),
  persistProfilesMeta: vi.fn(() => Promise.resolve()),
  saveProfileMeta: vi.fn(() => Promise.resolve(META)),
  saveProfilesMetaBulk: vi.fn(() => Promise.resolve(META)),
  seedMetaFromServer: (local: unknown) => ({ map: local, changed: false }),
  folderList: () => ['Work'],
  aggregateTags: () => [
    { tag: 'a', count: 1 },
    { tag: 'b', count: 1 },
  ],
}));

vi.mock('../../src/lib/folders-store', () => ({
  loadFolders: () => Promise.resolve(['Work']),
  addFolder: vi.fn(() => Promise.resolve(['Work'])),
  loadFolderIcons: () => Promise.resolve({}),
  replaceAllFolders: vi.fn(() => Promise.resolve()),
}));
vi.mock('../../src/lib/tags-store', () => ({
  loadTags: () => Promise.resolve(['a', 'b']),
  addTag: vi.fn(() => Promise.resolve(['a', 'b'])),
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
  addProxy: vi.fn(() => Promise.resolve({ id: 'p_new' })),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
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
}));

vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

/**
 * The four "Clear …" rows now sit behind a disclosure in the card menu, because
 * inline they buried the daily actions under variants of a rare one. Tests that
 * reach a Clear row must open that group first — the rows are not rendered until
 * it is expanded, so without this they fail on a missing element rather than on
 * the behaviour they assert.
 */
async function openClearGroup(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: /^Clearing options for / }));
}

async function openCardMenu(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  // Wait for the card to render then open its ⋯ menu (the Edit/Duplicate rows
  // live behind it).
  fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
}

describe('ProfilesView profile-lifecycle actions', () => {
  beforeEach(() => {
    capState = { profile_cap: 10, profile_count: 1 };
    stableAccountMe = makeAccountMe();
    profilesUpdate.mockClear();
    profilesClone.mockClear();
    profilesImport.mockClear();
    profilesTrim.mockClear();
    refreshAccountMe.mockClear();
  });

  // doc-150 items 5/6 + §8 — storage parity with the customer dashboard:
  // per-profile size, an account-wide storage meter, and a per-profile Trim
  // (the "Clear cache" / W3120 scoped-clear) action.
  describe('Storage + Trim', () => {
    it('CRITICAL hides the storage meter below the soft-warn line — 3 MiB of 5 GiB is not worth a row above the grid', async () => {
      // ⛔ This arm INVERTED. It used to assert the meter always renders. It is now
      // gated on `nearCap || overCap` (STORAGE_SOFT_WARN_FRACTION = 0.8), because
      // below that line it is a number nobody acts on while costing vertical space
      // above the grid on every visit — and on a small window that is the difference
      // between seeing profile cards and scrolling to them. Owner-reported.
      //
      // The rendered-content coverage this arm carried did NOT disappear: it moved to
      // the-grid-can-be-seen-without-scrolling, whose fixture now sits at 86% and so
      // exercises the visible meter and its collapse.
      const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
      // Anchor on something that renders regardless, so this cannot pass by
      // asserting absence before the view has hydrated at all.
      await screen.findByRole('button', { name: 'New profile' });
      expect(container.querySelector('[data-component="storage-meter"]')).toBeNull();
    });

    it('CRITICAL hides the workspace strip when there is nowhere to switch to', async () => {
      // With no team memberships the strip is the label "Workspaces" plus a single
      // "Personal" chip — a switcher whose only option is where you already are —
      // costing a row above the grid on every visit. This fixture has no teams, which
      // is what makes it the right file for the negative; the positive case lives in
      // the-grid-can-be-seen-without-scrolling, whose fixture has a membership so its
      // collapse arms exercise a strip that actually renders.
      const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
      await screen.findByRole('button', { name: 'New profile' });
      expect(container.querySelector('[data-component="workspace-strip"]')).toBeNull();
    });

    it('surfaces the per-profile size on the grid card', async () => {
      const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
      // ⛔ Hydration anchor was the storage meter's copy, an INCIDENTAL dependency:
      // this arm is about the per-card size and never needed the meter. When the
      // meter became conditional the arm hung on an element that no longer renders.
      // Anchored on the subject itself now, so it cannot be broken by unrelated
      // chrome appearing or disappearing above the grid.
      await screen.findByTitle(/Stored profile size/);
      // The card footer shows the formatted sealed-store size (3 MiB) with an
      // explanatory title — distinct from the meter's account total.
      const sized = within(container).getByTitle(/Stored profile size/);
      expect(sized.textContent).toBe('3.0 MiB');
    });

    it('exposes a Clear cache action in the card menu, saying what it keeps', async () => {
      await openCardMenu();
      await openClearGroup();
      const trim = await screen.findByRole('button', { name: 'Clear cache for Demo' });
      expect(trim.getAttribute('title')).toBe(
        'Free re-fetchable files. Logins, site data and tabs are kept',
      );
    });

    it('on confirm, calls profiles.trim and shows the freed-bytes notice (status ok)', async () => {
      // 2 MiB reclaimed → "freed 2.0 MiB". Branch is on `status`, not HTTP code.
      profilesTrim.mockResolvedValueOnce({
        status: 'ok',
        size_bytes: 1024,
        bytes_reclaimed: 2_097_152,
      });
      render(
        <ConfirmProvider>
          <ProfilesView onGoToSettings={vi.fn()} />
        </ConfirmProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      await openClearGroup();
      fireEvent.click(await screen.findByRole('button', { name: 'Clear cache for Demo' }));
      // The confirm dialog's primary action is "Clear cache".
      fireEvent.click(await screen.findByRole('button', { name: 'Clear cache' }));
      await waitFor(() => expect(profilesTrim).toHaveBeenCalledWith('prof_1'));
      expect(await screen.findByText(/freed 2\.0 MiB/)).toBeTruthy();
    });

    it('CRITICAL clearing cookies sends the cookies scope and warns that it signs the profile out', async () => {
      profilesTrim.mockResolvedValueOnce({ status: 'ok', size_bytes: 1024, bytes_reclaimed: 0 });
      render(
        <ConfirmProvider>
          <ProfilesView onGoToSettings={vi.fn()} />
        </ConfirmProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      await openClearGroup();
      fireEvent.click(await screen.findByRole('button', { name: 'Clear cookies for Demo' }));
      // The confirmation must say what is actually lost BEFORE it happens.
      expect(await screen.findByText(/SIGNS THE PROFILE OUT everywhere/)).toBeTruthy();
      fireEvent.click(await screen.findByRole('button', { name: 'Clear cookies' }));
      await waitFor(() =>
        expect(profilesTrim).toHaveBeenCalledWith('prof_1', { scope: 'cookies' }),
      );
    });

    it('CRITICAL a cookies clear reporting 0 bytes does NOT say "freed 0 B" — it freed identity, not disk', async () => {
      profilesTrim.mockResolvedValueOnce({ status: 'ok', size_bytes: 1024, bytes_reclaimed: 0 });
      render(
        <ConfirmProvider>
          <ProfilesView onGoToSettings={vi.fn()} />
        </ConfirmProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      await openClearGroup();
      fireEvent.click(await screen.findByRole('button', { name: 'Clear cookies for Demo' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear cookies' }));
      const notice = await screen.findByText(/Cleared cookies and site data/);
      expect(notice.textContent).not.toMatch(/freed/);
    });

    it('the history action is honest that a profile keeps no browsing history, only remembered tabs', async () => {
      render(
        <ConfirmProvider>
          <ProfilesView onGoToSettings={vi.fn()} />
        </ConfirmProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      await openClearGroup();
      fireEvent.click(await screen.findByRole('button', { name: 'Clear history for Demo' }));
      const body = await screen.findByText(
        /only record of visited pages held in the profile itself/,
      );
      // ⛔ Two retracted claims, both of which shipped. First "nothing else
      // stores a history" (false — agent_sessions.transcript holds full URLs
      // keyed by profile). Then "page URLs … for up to 90 days" (also false —
      // session_events is minimized to ORIGINS, and the 90-day bound governs
      // only that table, not the transcript or recipes).
      expect(body.textContent).not.toMatch(/nothing else stores a history/i);
      expect(body.textContent).not.toMatch(/90 days/i);
      // ⭐ The durable shape: the claim is bounded to what the BUTTON does and
      // names no store and no window, so it cannot rot as retention changes.
      expect(body.textContent).toMatch(/does NOT clear the server-side record/i);
    });

    it('every clear scope is reachable from the card menu, one disclosure deep', async () => {
      await openCardMenu();
      // ⛔ The four scopes are behind a disclosure now. Assert the rows are NOT
      // reachable before it opens: without this the arm would still pass if the
      // grouping were reverted, and its whole subject is that they live one level
      // in rather than inline.
      expect(screen.queryByRole('button', { name: 'Clear cache for Demo' })).toBeNull();
      await openClearGroup();
      for (const name of [
        'Clear cache for Demo',
        'Clear cookies for Demo',
        'Clear history for Demo',
        'Clear all browsing data for Demo',
      ]) {
        expect(await screen.findByRole('button', { name }), name).toBeTruthy();
      }
    });

    it('surfaces an informative (non-error) notice when there is nothing to trim (status unavailable)', async () => {
      profilesTrim.mockResolvedValueOnce({
        status: 'unavailable',
        reason: 'no saved state to trim yet',
      });
      render(
        <ConfirmProvider>
          <ProfilesView onGoToSettings={vi.fn()} />
        </ConfirmProvider>,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
      await openClearGroup();
      fireEvent.click(await screen.findByRole('button', { name: 'Clear cache for Demo' }));
      fireEvent.click(await screen.findByRole('button', { name: 'Clear cache' }));
      await waitFor(() => expect(profilesTrim).toHaveBeenCalledWith('prof_1'));
      expect(await screen.findByText(/no saved state to trim yet/)).toBeTruthy();
    });
  });

  // Runs automatically if CLONE_ENABLED flips in the view — see the note above.
  describe.skipIf(!CLONE_ENABLED)('Clone', () => {
    it('calls profiles.clone + refreshes the cap counter, and shows a duplicated notice', async () => {
      await openCardMenu();
      fireEvent.click(await screen.findByRole('button', { name: 'Duplicate Demo' }));
      await waitFor(() => expect(profilesClone).toHaveBeenCalledWith('prof_1'));
      // Clone consumes a cap slot, so the gate must be refreshed.
      await waitFor(() => expect(refreshAccountMe).toHaveBeenCalled());
      expect(await screen.findByText('Duplicated as "Demo (copy)".')).toBeTruthy();
    });

    it('respects the cap: the header Duplicate path is gated (New + Import disabled at cap)', async () => {
      capState = { profile_cap: 1, profile_count: 1 };
      stableAccountMe = makeAccountMe();
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      // The header New + Import buttons are the cap-gated affordances.
      expect(await screen.findByRole('button', { name: /New profile/ })).toBeDisabled();
      expect(screen.getByRole('button', { name: /Import/ })).toBeDisabled();
    });
  });

  describe('Edit', () => {
    it('builds a minimal PATCH diff of ONLY the changed fields', async () => {
      await openCardMenu();
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Demo' }));
      // Modal prefilled from the profile + meta; change only the name.
      const nameInput = await screen.findByDisplayValue('Demo');
      fireEvent.change(nameInput, { target: { value: 'Renamed' } });
      fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
      await waitFor(() => expect(profilesUpdate).toHaveBeenCalledTimes(1));
      // Only `name` changed → the diff carries name and nothing else.
      expect(profilesUpdate).toHaveBeenCalledWith('prof_1', { name: 'Renamed' });
    });

    it('does not offer an archetype field (archetype is immutable post-create)', async () => {
      await openCardMenu();
      fireEvent.click(await screen.findByRole('button', { name: 'Edit Demo' }));
      await screen.findByRole('heading', { name: 'Edit profile' });
      // The device is shown read-only; there is no editable archetype control.
      const device = screen.getByDisplayValue('iPhone 16 Pro');
      expect((device as HTMLInputElement).readOnly).toBe(true);
    });
  });

  // Runs automatically if IMPORT_EXPORT_ENABLED flips in the view.
  describe.skipIf(!IMPORT_EXPORT_ENABLED)('Import', () => {
    const ENVELOPE = {
      version: 1,
      exported_at: '2026-06-08T00:00:00Z',
      source_profile_id: 'prof_src',
      source_account_id: 'acc_src',
      profile: { name: 'Imported', archetype: 'iphone16pro_ios18_7_safari26_4', description: null },
    };

    async function openImport(): Promise<HTMLElement> {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      // Header "Import" button opens the modal; scope subsequent queries to the
      // dialog so the modal's submit "Import" button isn't confused with it.
      fireEvent.click(await screen.findByRole('button', { name: /^Import$/ }));
      return screen.findByRole('dialog', { name: 'Import profiles' });
    }

    it('imports a SINGLE envelope object (one import call)', async () => {
      const dialog = await openImport();
      fireEvent.change(within(dialog).getByLabelText('Profile JSON'), {
        target: { value: JSON.stringify(ENVELOPE) },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
      await waitFor(() => expect(profilesImport).toHaveBeenCalledTimes(1));
      expect(profilesImport).toHaveBeenCalledWith({ envelope: ENVELOPE });
      expect(await screen.findByText('Imported 1 profile.')).toBeTruthy();
    });

    it('imports a BULK array (one import call per envelope)', async () => {
      const dialog = await openImport();
      const second = { ...ENVELOPE, profile: { ...ENVELOPE.profile, name: 'Two' } };
      fireEvent.change(within(dialog).getByLabelText('Profile JSON'), {
        target: { value: JSON.stringify([ENVELOPE, second]) },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
      await waitFor(() => expect(profilesImport).toHaveBeenCalledTimes(2));
      expect(profilesImport).toHaveBeenNthCalledWith(1, { envelope: ENVELOPE });
      expect(profilesImport).toHaveBeenNthCalledWith(2, { envelope: second });
      expect(await screen.findByText('Imported 2 profiles.')).toBeTruthy();
    });

    it('applies a name override only for a single import', async () => {
      const dialog = await openImport();
      fireEvent.change(within(dialog).getByLabelText('Profile JSON'), {
        target: { value: JSON.stringify(ENVELOPE) },
      });
      fireEvent.change(within(dialog).getByLabelText(/Rename on import/), {
        target: { value: 'My Name' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
      await waitFor(() => expect(profilesImport).toHaveBeenCalledTimes(1));
      expect(profilesImport).toHaveBeenCalledWith({
        envelope: ENVELOPE,
        name_override: 'My Name',
      });
    });

    it('surfaces a clear error on invalid JSON (no import call)', async () => {
      const dialog = await openImport();
      fireEvent.change(within(dialog).getByLabelText('Profile JSON'), {
        target: { value: '{ not json' },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Import' }));
      expect(await screen.findByText('That file is not valid JSON.')).toBeTruthy();
      expect(profilesImport).not.toHaveBeenCalled();
    });
  });
});
