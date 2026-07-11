// Behavior coverage for ProfilesView search — the search box must match a
// profile by the ORG METADATA the product syncs (folder name, tags, note), not
// just its server name/description/archetype. A customer who filed a profile
// under a folder, tagged it, or left a note should be able to find it by how
// THEY organised it. The folder/tags/note are seeded down from the server
// profile row (seedMetaFromServer), so we set them on the mocked list response.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

// Two profiles with distinct org metadata. `alpha` lives in the "Shopping"
// folder, is tagged "aged", and has a note "warm cookies". `beta` carries none
// of those tokens, so each metadata query should isolate `alpha`.
function profiles() {
  return [
    {
      id: 'prof_alpha',
      name: 'Alpha',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: null,
      created_at: '2026-06-08T00:00:00Z',
      updated_at: '2026-06-08T00:00:00Z',
      folder: 'Shopping',
      tags: ['aged'],
      note: 'warm cookies',
    },
    {
      id: 'prof_beta',
      name: 'Beta',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: null,
      created_at: '2026-06-08T00:00:00Z',
      updated_at: '2026-06-08T00:00:00Z',
      folder: '',
      tags: [],
      note: '',
    },
  ];
}

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: profiles() }),
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          for (const p of profiles()) yield p;
        },
        update: vi.fn(() => Promise.resolve()),
      },
      sessions: {
        list: () => Promise.resolve({ data: [] }),
        create: vi.fn(() => Promise.resolve({ id: 'ses_x' })),
      },
      agentSessions: {
        create: vi.fn(() => Promise.resolve({ id: 'agt_x' })),
        close: vi.fn(() => Promise.resolve({})),
        livekitToken: vi.fn(() => Promise.resolve({})),
        list: () => Promise.resolve({ data: [] }),
      },
    },
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: {
      tier: 'solo_manual',
      concurrent_session_cap: 1,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 2,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  };
  return { useSettings: () => stable };
});

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
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.resolve({ reachable: true })),
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

const { ProfilesView } = await import('../../src/views/ProfilesView');

async function renderAndWaitForProfiles(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  // Both cards render once the list + the seeded org metadata land.
  await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
  await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
}

function search(term: string): void {
  fireEvent.change(screen.getByLabelText('Search profiles'), { target: { value: term } });
}

describe('ProfilesView search matches synced org metadata', () => {
  it('matches by FOLDER name', async () => {
    await renderAndWaitForProfiles();
    search('shopping');
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByText('Beta')).toBeNull();
    cleanup();
  });

  it('matches by TAG', async () => {
    await renderAndWaitForProfiles();
    search('aged');
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByText('Beta')).toBeNull();
    cleanup();
  });

  it('matches by NOTE', async () => {
    await renderAndWaitForProfiles();
    search('cookies');
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByText('Beta')).toBeNull();
    cleanup();
  });

  it('still matches by name (no regression)', async () => {
    await renderAndWaitForProfiles();
    search('beta');
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
    expect(screen.queryByText('Alpha')).toBeNull();
    cleanup();
  });
});

describe('ProfilesView search is GLOBAL — it bypasses the folder rail scoping', () => {
  // Founder 2026-07-11: "the search ain't even working to find anything". Root cause:
  // the search results were INTERSECTED with the active folder/tag rail selection, so
  // browsing into a folder and later searching for a profile that lives elsewhere
  // returned 0 results with no hint why. A typed query is an explicit "find it
  // wherever it is" (the Finder/Gmail convention) — it must search ALL profiles.
  it('finds a profile in ANOTHER folder while a rail folder is selected', async () => {
    await renderAndWaitForProfiles();
    // Browse into the Shopping folder — only Alpha (its member) stays visible.
    const rail = screen.getByLabelText('Folders and tags');
    fireEvent.click(within(rail).getByText('Shopping'));
    await waitFor(() => expect(screen.queryByText('Beta')).toBeNull());
    expect(screen.getByText('Alpha')).toBeTruthy();
    // Search for the UNFILED profile: before the fix this was 0 results (Beta is
    // outside Shopping); now the query searches everywhere.
    search('beta');
    await waitFor(() => expect(screen.getByText('Beta')).toBeTruthy());
    expect(screen.queryByText('Alpha')).toBeNull();
    // Clearing the search returns to the folder-scoped browse view unchanged.
    search('');
    await waitFor(() => expect(screen.getByText('Alpha')).toBeTruthy());
    expect(screen.queryByText('Beta')).toBeNull();
    cleanup();
  });
});
