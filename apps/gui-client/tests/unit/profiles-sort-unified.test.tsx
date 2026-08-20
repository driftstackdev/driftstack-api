// Feature 2 (2026-06-20) — the Profiles sort is UNIFIED: the action-bar
// dropdown + direction toggle are the single source of truth shared with the
// list-view (table) column headers. Previously the table kept its own
// sortKey/sortDir and re-sorted, so toggling grid↔list silently changed the
// order. These tests prove the chosen sort + direction SURVIVE a grid↔list
// switch (the regression that motivated the unification).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react';

// Three profiles whose name order (Alpha < Mango < Zeta) is the REVERSE of
// their last-used order (Zeta newest), so a sort change is observable and the
// two orderings can't be confused.
function profiles() {
  return [
    {
      id: 'prof_zeta',
      name: 'Zeta',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: '2026-06-19T00:00:00Z', // most recent
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-19T00:00:00Z',
      folder: '',
      tags: [],
      note: '',
    },
    {
      id: 'prof_mango',
      name: 'Mango',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: '2026-06-18T00:00:00Z',
      created_at: '2026-06-02T00:00:00Z',
      updated_at: '2026-06-18T00:00:00Z',
      folder: '',
      tags: [],
      note: '',
    },
    {
      id: 'prof_alpha',
      name: 'Alpha',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: '2026-06-17T00:00:00Z', // least recent
      created_at: '2026-06-03T00:00:00Z',
      updated_at: '2026-06-17T00:00:00Z',
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
        listTrash: () => Promise.resolve({ data: [] }),
      },
      sessions: { list: () => Promise.resolve({ data: [] }), create: vi.fn() },
      agentSessions: {
        create: vi.fn(),
        close: vi.fn(),
        livekitToken: vi.fn(),
        list: () => Promise.resolve({ data: [] }),
      },
    },
    settings: { apiKey: 'ds_test_x', baseUrl: 'http://localhost:3000' },
    accountMe: { tier: 'solo_manual', profile_cap: 10, profile_active: 3 },
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
const VIEW_MODE_KEY = 'ds-profiles-view-mode';
const storageValues = new Map<string, string>();
const testStorage: Storage = {
  get length() {
    return storageValues.size;
  },
  clear() {
    storageValues.clear();
  },
  getItem(key) {
    return storageValues.get(key) ?? null;
  },
  key(index) {
    return [...storageValues.keys()][index] ?? null;
  },
  removeItem(key) {
    storageValues.delete(key);
  },
  setItem(key, value) {
    storageValues.set(key, value);
  },
};

// Read the DOM order of the three profile names from whatever view is rendered
// (grid card or table row — both render the bare name as text).
function nameOrder(): string[] {
  const names = ['Alpha', 'Mango', 'Zeta'];
  const text = document.body.textContent ?? '';
  return names
    .map((n) => ({ n, i: text.indexOf(n) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.n);
}

describe('ProfilesView unified sort persists across grid↔list', () => {
  beforeEach(() => {
    // Node 22 exposes an incomplete experimental global localStorage when no
    // --localstorage-file is configured; install a real Storage-shaped test
    // double on the jsdom window so this browser behavior is deterministic.
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: testStorage,
    });
    window.localStorage.removeItem(VIEW_MODE_KEY);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    window.localStorage.removeItem(VIEW_MODE_KEY);
  });

  it('a name sort chosen in the grid still applies after switching to the list', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Zeta')).toBeTruthy());

    // Default is last-used desc → Zeta, Mango, Alpha.
    expect(nameOrder()).toEqual(['Zeta', 'Mango', 'Alpha']);

    // Sort by name (ascending is name's natural default) → Alpha, Mango, Zeta.
    fireEvent.change(screen.getByLabelText('Sort profiles'), { target: { value: 'name' } });
    await waitFor(() => expect(nameOrder()).toEqual(['Alpha', 'Mango', 'Zeta']));

    // Switch to the list view — the SAME order must hold (the bug was the table
    // re-sorting to its own default here).
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(nameOrder()).toEqual(['Alpha', 'Mango', 'Zeta']);
    cleanup();
  });

  it('a table header sort propagates back to the grid (single source of truth)', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Zeta')).toBeTruthy());

    // Go to the list and click the Profile (name) header → name asc. Scope to
    // the table so the "New profile" button can't match.
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    fireEvent.click(within(screen.getByRole('table')).getByRole('button', { name: /Profile/i }));
    await waitFor(() => expect(nameOrder()).toEqual(['Alpha', 'Mango', 'Zeta']));

    // The shared dropdown now reflects "name", and switching back to the grid
    // keeps the order.
    expect(screen.getByLabelText<HTMLSelectElement>('Sort profiles').value).toBe('name');
    fireEvent.click(screen.getByRole('button', { name: /Grid/ }));
    await waitFor(() => expect(nameOrder()).toEqual(['Alpha', 'Mango', 'Zeta']));
    cleanup();
  });

  it('the direction toggle flips the order and survives a view switch', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Zeta')).toBeTruthy());

    fireEvent.change(screen.getByLabelText('Sort profiles'), { target: { value: 'name' } });
    await waitFor(() => expect(nameOrder()).toEqual(['Alpha', 'Mango', 'Zeta']));

    // Flip to descending via the action-bar direction toggle.
    fireEvent.click(screen.getByLabelText(/Sort direction/));
    await waitFor(() => expect(nameOrder()).toEqual(['Zeta', 'Mango', 'Alpha']));

    // Descending name order holds in the list view too.
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(nameOrder()).toEqual(['Zeta', 'Mango', 'Alpha']);
    cleanup();
  });

  it('restores an explicitly chosen list view across an unmount/relaunch', async () => {
    const first = render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Zeta')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(window.localStorage.getItem(VIEW_MODE_KEY)).toBe('list');

    first.unmount();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    expect(screen.getByRole('button', { name: /List/ })).toHaveAttribute('aria-pressed', 'true');
    cleanup();
  });

  it('ignores a malformed saved mode and falls back to grid', async () => {
    window.localStorage.setItem(VIEW_MODE_KEY, 'sideways');
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Zeta')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Grid/ })).toHaveAttribute('aria-pressed', 'true');
    cleanup();
  });

  it('keeps working when WebView storage throws on read or write', async () => {
    const readSpy = vi.spyOn(window.localStorage, 'getItem').mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Zeta')).toBeTruthy());
    expect(screen.getByRole('button', { name: /Grid/ })).toHaveAttribute('aria-pressed', 'true');
    readSpy.mockRestore();

    const writeSpy = vi.spyOn(window.localStorage, 'setItem').mockImplementationOnce(() => {
      throw new Error('storage unavailable');
    });
    fireEvent.click(screen.getByRole('button', { name: /List/ }));
    await waitFor(() => expect(screen.getByRole('table')).toBeTruthy());
    writeSpy.mockRestore();
    cleanup();
  });
});
