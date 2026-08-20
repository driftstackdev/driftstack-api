// Feature 4 (2026-06-20) — Recycle bin (TrashPanel) upgrades: client-side
// search/filter + sort over the trashed list, plus bulk "Restore all" and
// "Empty trash" that loop the existing per-id endpoints SEQUENTIALLY and
// tolerate partial failures (a 409 on one restore must NOT abort the rest).
// There is no server bulk endpoint yet — these are pure-GUI loops.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';

// One live profile (so the rail + Trash toggle render) and three trashed ones
// with distinct names / devices / deleted-at so search + sort are observable.
function live() {
  return [
    {
      id: 'prof_live',
      name: 'Live One',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: null,
      created_at: '2026-06-01T00:00:00Z',
      updated_at: '2026-06-01T00:00:00Z',
      folder: '',
      tags: [],
      note: '',
    },
  ];
}

function trashedProfiles() {
  return [
    {
      id: 'prof_amsterdam',
      name: 'Amsterdam Shopper',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: null,
      created_at: '2026-06-02T00:00:00Z',
      updated_at: '2026-06-02T00:00:00Z',
      deleted_at: '2026-06-10T00:00:00Z',
    },
    {
      id: 'prof_berlin',
      name: 'Berlin Buyer',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: null,
      created_at: '2026-06-03T00:00:00Z',
      updated_at: '2026-06-03T00:00:00Z',
      deleted_at: '2026-06-12T00:00:00Z',
    },
    {
      id: 'prof_cairo',
      name: 'Cairo Crawler',
      archetype: 'iphone16pro_ios18_7_safari26_4',
      description: null,
      last_used_at: null,
      created_at: '2026-06-04T00:00:00Z',
      updated_at: '2026-06-04T00:00:00Z',
      deleted_at: '2026-06-11T00:00:00Z',
    },
  ];
}

// Mutable spies the SettingsContext mock closes over, reset per test.
const restoreSpy = vi.fn((_id: string) => Promise.resolve({}));
const purgeSpy = vi.fn((_id: string) => Promise.resolve({}));
const confirmSpy = vi.fn(() => Promise.resolve(true));
const listTrashSpy = vi.fn(() => Promise.resolve({ data: trashedProfiles() }));

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: live() }),
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          for (const p of live()) yield p;
        },
        update: vi.fn(() => Promise.resolve()),
        listTrash: () => listTrashSpy(),
        restore: (id: string) => restoreSpy(id),
        purge: (id: string) => purgeSpy(id),
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
    accountMe: { tier: 'solo_manual', profile_cap: 10, profile_active: 1 },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  };
  return { useSettings: () => stable };
});

// Auto-confirm so the Empty-trash confirm() resolves true.
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => confirmSpy,
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

async function openTrash(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  await waitFor(() => expect(screen.getByText('Live One')).toBeTruthy());
  fireEvent.click(screen.getByRole('button', { name: /Trash/ }));
  await waitFor(() => expect(screen.getByText('Amsterdam Shopper')).toBeTruthy());
}

function trashNameOrder(): string[] {
  const names = ['Amsterdam Shopper', 'Berlin Buyer', 'Cairo Crawler'];
  const text = document.body.textContent ?? '';
  return names
    .map((n) => ({ n, i: text.indexOf(n) }))
    .filter((x) => x.i >= 0)
    .sort((a, b) => a.i - b.i)
    .map((x) => x.n);
}

beforeEach(() => {
  restoreSpy.mockReset();
  restoreSpy.mockImplementation((_id: string) => Promise.resolve({}));
  purgeSpy.mockReset();
  purgeSpy.mockImplementation((_id: string) => Promise.resolve({}));
  confirmSpy.mockReset();
  confirmSpy.mockImplementation(() => Promise.resolve(true));
  listTrashSpy.mockReset();
  listTrashSpy.mockImplementation(() => Promise.resolve({ data: trashedProfiles() }));
});

describe('TrashPanel load truth', () => {
  it('renders a retryable failure rather than false empty on a load error', async () => {
    listTrashSpy.mockRejectedValueOnce(new TypeError('network down'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Live One')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));

    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.queryByText('Trash is empty.')).toBeNull();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy();
    cleanup();
  });

  it('recovers from a failed load through Retry', async () => {
    listTrashSpy.mockRejectedValueOnce(new TypeError('network down'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Live One')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));
    const retry = await screen.findByRole('button', { name: 'Retry' });

    fireEvent.click(retry);
    await waitFor(() => expect(screen.getByText('Amsterdam Shopper')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
  });

  it('lets the newest overlapping load own the recycle-bin snapshot', async () => {
    const first = deferred<{ data: ReturnType<typeof trashedProfiles> }>();
    listTrashSpy
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce({ data: [trashedProfiles()[1]!] });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Live One')).toBeTruthy());
    const trash = screen.getByRole('button', { name: /Trash/ });

    fireEvent.click(trash);
    fireEvent.click(trash);
    fireEvent.click(trash);
    await waitFor(() => expect(screen.getByText('Berlin Buyer')).toBeTruthy());
    first.resolve({ data: trashedProfiles() });
    await act(async () => Promise.resolve());

    expect(screen.queryByText('Amsterdam Shopper')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
  });

  it('renders empty only after an authoritative empty response', async () => {
    listTrashSpy.mockResolvedValueOnce({ data: [] });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(screen.getByText('Live One')).toBeTruthy());
    fireEvent.click(screen.getByRole('button', { name: /Trash/ }));

    await waitFor(() => expect(screen.getByText('Trash is empty.')).toBeTruthy());
    expect(screen.queryByRole('alert')).toBeNull();
    cleanup();
  });
});

describe('TrashPanel search / sort', () => {
  it('filters the trash list by name or device', async () => {
    await openTrash();
    fireEvent.change(screen.getByLabelText('Search trash'), { target: { value: 'berlin' } });
    await waitFor(() => expect(trashNameOrder()).toEqual(['Berlin Buyer']));
    expect(screen.queryByText('Amsterdam Shopper')).toBeNull();
    cleanup();
  });

  it('sorts by name, and the direction toggle reverses it', async () => {
    await openTrash();
    // Default direction is descending; selecting the name key keeps it, so the
    // toggle is what produces ascending A→Z.
    fireEvent.change(screen.getByLabelText('Sort trash'), { target: { value: 'name' } });
    await waitFor(() =>
      expect(trashNameOrder()).toEqual(['Cairo Crawler', 'Berlin Buyer', 'Amsterdam Shopper']),
    );
    fireEvent.click(screen.getByLabelText(/Trash sort direction/));
    await waitFor(() =>
      expect(trashNameOrder()).toEqual(['Amsterdam Shopper', 'Berlin Buyer', 'Cairo Crawler']),
    );
    cleanup();
  });
});

describe('TrashPanel bulk actions', () => {
  it('synchronously excludes duplicate and cross-action recycle-bin mutations', async () => {
    const gate = deferred<object>();
    restoreSpy.mockImplementation(() => gate.promise);
    await openTrash();
    const rowRestore = screen.getAllByRole('button', { name: 'Restore' })[0]!;
    const restoreAll = screen.getByRole('button', { name: /Restore all/ });
    const emptyTrash = screen.getByRole('button', { name: 'Empty trash' });

    act(() => {
      rowRestore.click();
      rowRestore.click();
      restoreAll.click();
      emptyTrash.click();
    });

    expect(restoreSpy).toHaveBeenCalledTimes(1);
    expect(purgeSpy).not.toHaveBeenCalled();
    expect(screen.getByText('Restoring…')).toBeTruthy();
    expect(screen.getByText('Recycle bin').closest('[aria-busy="true"]')).toHaveAttribute('inert');

    gate.resolve({});
    await waitFor(() =>
      expect(screen.getByText('Recycle bin').closest('[aria-busy="false"]')).toBeTruthy(),
    );
    cleanup();
  });

  it('releases the destructive-operation owner after a cancelled confirmation', async () => {
    confirmSpy.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    await openTrash();
    const deleteButton = screen.getAllByRole('button', { name: 'Delete permanently' })[0]!;

    fireEvent.click(deleteButton);
    await waitFor(() => expect(confirmSpy).toHaveBeenCalledTimes(1));
    expect(purgeSpy).not.toHaveBeenCalled();

    fireEvent.click(deleteButton);
    await waitFor(() => expect(purgeSpy).toHaveBeenCalledTimes(1));
    cleanup();
  });

  it('Restore all restores every shown profile sequentially', async () => {
    await openTrash();
    fireEvent.click(screen.getByRole('button', { name: /Restore all/ }));
    await waitFor(() => expect(restoreSpy).toHaveBeenCalledTimes(3));
    const ids = restoreSpy.mock.calls.map((c) => c[0]);
    expect(new Set(ids)).toEqual(new Set(['prof_amsterdam', 'prof_berlin', 'prof_cairo']));
    cleanup();
  });

  it('Restore all tolerates a partial failure (a 409 on one row does NOT abort the rest)', async () => {
    restoreSpy.mockImplementation((id: string) => {
      if (id === 'prof_berlin')
        return Promise.reject(Object.assign(new Error('taken'), { status: 409 }));
      return Promise.resolve({});
    });
    await openTrash();
    fireEvent.click(screen.getByRole('button', { name: /Restore all/ }));
    // All three are STILL attempted even though the middle one rejects.
    await waitFor(() => expect(restoreSpy).toHaveBeenCalledTimes(3));
    cleanup();
  });

  it('Empty trash purges every shown profile sequentially (after confirm)', async () => {
    await openTrash();
    fireEvent.click(screen.getByRole('button', { name: /Empty trash/ }));
    await waitFor(() => expect(purgeSpy).toHaveBeenCalledTimes(3));
    cleanup();
  });

  it('bulk actions respect the search filter (only the matching subset is acted on)', async () => {
    await openTrash();
    fireEvent.change(screen.getByLabelText('Search trash'), { target: { value: 'cairo' } });
    await waitFor(() => expect(trashNameOrder()).toEqual(['Cairo Crawler']));
    fireEvent.click(screen.getByRole('button', { name: /Restore all/ }));
    await waitFor(() => expect(restoreSpy).toHaveBeenCalledTimes(1));
    expect(restoreSpy).toHaveBeenCalledWith('prof_cairo');
    cleanup();
  });

  it('Empty trash tolerates a partial purge failure', async () => {
    purgeSpy.mockImplementation((id: string) => {
      if (id === 'prof_amsterdam') return Promise.reject(new Error('boom'));
      return Promise.resolve({});
    });
    await openTrash();
    fireEvent.click(screen.getByRole('button', { name: /Empty trash/ }));
    await waitFor(() => expect(purgeSpy).toHaveBeenCalledTimes(3));
    cleanup();
  });
});
