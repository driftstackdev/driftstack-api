// Behavior coverage for ProfilesView's BULK "Launch" guards (audit) — the bulk
// bar's Launch button drives handleBulkLaunch, which (unlike the per-row Launch)
// historically bypassed the running-session and read-only-team gates the UI
// applied per row. Three regressions are pinned here:
//
//   1. Double-billing — bulk Launch over a selection that includes ALREADY-LIVE
//      profiles created a SECOND billed agent session + a duplicate fleet browser
//      for each one already running. The per-row Launch routes a running profile
//      to "Open session" (never a second create); bulk Launch must skip running
//      profiles too (boundSession(id) !== null).
//
//   2. Read-only team gate — the per-row Launch is disabled for a non-admin team
//      member (teamLaunchBlocked), but the bulk Launch wasn't gated, so a member
//      could fire N create() calls that each 403 server-side. handleBulkLaunch now
//      surfaces the clean "ask a team admin" reason up front and creates nothing.
//
//   3. Best-effort markLaunched — handleLaunch records the local binding via
//      markLaunched AFTER the billed create. A store-write failure there used to
//      abort into the catch WITHOUT opening the simulator, stranding a billed,
//      unstoppable session. markLaunched is now best-effort: the launch proceeds
//      to open the simulator (the controllable surface) even when the write fails.
//
// Mirrors profiles-launch-stream.test.tsx's harness + the ConfirmProvider wiring
// used by profiles-bulk-delete-summary.test.tsx (the bulk confirm dialog).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { openSimulatorWindow } from '../../src/lib/open-simulator';

const agentCreate = vi.fn<(b: unknown, opts?: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'agt_new', livekit: LIVEKIT }),
);
const agentClose = vi.fn<(id: string) => Promise<unknown>>(() => Promise.resolve({}));
const markLaunched = vi.fn<(profileId: string, sessionId: string) => Promise<void>>(() =>
  Promise.resolve(),
);
const clearSession = vi.fn<(profileId: string) => Promise<void>>(() => Promise.resolve());
// Driven per-test: the live agent-session list the running self-heal reads.
const agentSessionsList = vi.fn<() => Promise<{ data: unknown[] }>>(() =>
  Promise.resolve({ data: [] }),
);
// Driven per-test: local profile→session bindings (a non-null currentSessionId
// that is present+fresh in agentSessionsList reads as "running").
const listBindingsMock = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));

function profile(id: string, name: string) {
  return {
    id,
    name,
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: null,
    last_used_at: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
  };
}
const PROF_IDLE = profile('prof_idle', 'Idle');
const PROF_RUNNING = profile('prof_running', 'Running');

// STABLE context object — useSettings must return the SAME reference every render
// (a fresh object each call churns ProfilesView's effects → infinite re-render).
// The read-only-team gate is driven per-test by mutating this object's
// activeWorkspace + accountMe.teams in place (see beforeEach), so identity stays
// stable while the values change.
const stableContext = {
  client: {
    profiles: {
      list: () => Promise.resolve({ data: [PROF_IDLE, PROF_RUNNING] }),
      // eslint-disable-next-line @typescript-eslint/require-await
      iterate: async function* () {
        yield PROF_IDLE;
        yield PROF_RUNNING;
      },
    },
    sessions: { list: () => Promise.resolve({ data: [] }) },
    agentSessions: {
      create: (b: unknown, opts?: unknown) => agentCreate(b, opts),
      close: (id: string) => agentClose(id),
      livekitToken: () => Promise.resolve(LIVEKIT),
      list: () => agentSessionsList(),
    },
  },
  settings: {
    apiKey: 'ds_test_x',
    baseUrl: 'http://localhost:3000',
    startUrl: 'https://driftstack.dev',
  },
  accountMe: {
    tier: 'solo_manual',
    concurrent_session_cap: 5,
    concurrent_session_active: 0,
    profile_cap: 10,
    profile_active: 2,
    teams: [] as Array<{ membership_id: string; owner_account_id: string; role: string }>,
  },
  refreshAccountMe: vi.fn(() => Promise.resolve()),
  loading: false,
  update: vi.fn(() => Promise.resolve()),
  activeWorkspace: null as string | null,
  setActiveWorkspace: vi.fn(),
};

vi.mock('../../src/lib/SettingsContext', () => ({
  useSettings: () => stableContext,
}));

// The folder/tag/org stores ProfilesView loads on mount — stubbed so the effects
// settle (no real Tauri/network) and don't churn re-renders. Mirrors the harness
// in profiles-organization-management.test.tsx.
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
  listBindings: () => listBindingsMock(),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: (profileId: string, sessionId: string) => markLaunched(profileId, sessionId),
  clearSession: (profileId: string) => clearSession(profileId),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () =>
    Promise.resolve([{ id: 'p1', host: '127.0.0.1', port: 1080, username: null, password: null }]),
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
}));

// Launch now FAILS CLOSED on a proxy account-sync error (GUI founder-hit sweep) —
// mock the sync to SUCCEED so the guard tests exercise the launch path, not the abort.
vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
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
const { ConfirmProvider } = await import('../../src/components/ConfirmProvider');

const LIVEKIT = {
  ws_url: 'ws://localhost:7880',
  room: 'agt_demo_room',
  token: 'tok',
  participant_identity: 'customer-acc',
  expires_at: '2026-06-08T12:00:00Z',
};

// prof_running is bound to a live (present + fresh) agent session, so its row
// reads "running" via boundSession.
const RUNNING_BINDING = {
  profileId: 'prof_running',
  defaultProxyId: null,
  currentSessionId: 'agt_running',
  lastLaunchedAt: '2026-06-25T00:00:00Z',
};
const LIVE_RUNNING = {
  data: [
    {
      id: 'agt_running',
      created_at: '2026-06-25T00:00:00Z',
      status: 'active',
      liveness: { state: 'active', fresh: true },
    },
  ],
};

function renderView(): void {
  render(
    <ConfirmProvider>
      <ProfilesView onGoToSettings={vi.fn()} />
    </ConfirmProvider>,
  );
}

// The bulk-bar Launch button collides with the per-row "Launch" by text, so find
// it by its title (only the bulk-bar button carries it).
function bulkLaunchButton(): HTMLElement {
  return screen.getByTitle('Open a browser session for each selected profile');
}

describe('ProfilesView bulk launch guards', () => {
  beforeEach(() => {
    agentCreate.mockClear();
    agentClose.mockClear();
    markLaunched.mockReset();
    markLaunched.mockResolvedValue(undefined);
    clearSession.mockClear();
    vi.mocked(openSimulatorWindow).mockClear();
    vi.mocked(openSimulatorWindow).mockResolvedValue({ opened: true });
    listBindingsMock.mockReset();
    listBindingsMock.mockResolvedValue([]);
    agentSessionsList.mockReset();
    agentSessionsList.mockResolvedValue({ data: [] });
    // Reset the per-test team-gate fields IN PLACE (keep the object identity
    // stable so useSettings keeps returning the same reference).
    stableContext.activeWorkspace = null;
    stableContext.accountMe.teams = [];
  });

  // Finding 1 (high): double-billing.
  it('skips ALREADY-RUNNING profiles — bulk Launch creates a session ONLY for the idle one', async () => {
    listBindingsMock.mockResolvedValue([RUNNING_BINDING]);
    agentSessionsList.mockResolvedValue(LIVE_RUNNING);
    agentCreate.mockResolvedValue({ id: 'agt_for_idle', livekit: LIVEKIT });
    renderView();

    // Wait until prof_running's card reads running (its self-heal resolved), so
    // boundSession('prof_running') !== null at click time.
    await screen.findByRole('button', { name: 'Open session' });

    // Select BOTH (Idle + Running) and open the bulk bar.
    fireEvent.click(await screen.findByLabelText('Select Idle'));
    fireEvent.click(await screen.findByLabelText('Select Running'));
    await screen.findByText(/2 selected/);

    fireEvent.click(bulkLaunchButton());
    // The confirm counts only the LAUNCHABLE (idle) targets — "1 session", not 2.
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/Launch 1 session\b/)).toBeTruthy();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));

    // Exactly ONE create fires, for the idle profile — the running one is NOT
    // re-launched (no double-bill, no duplicate fleet browser).
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    expect(agentCreate).toHaveBeenCalledWith(
      expect.objectContaining({ profile_id: 'prof_idle', mode: 'manual' }),
      { idempotencyKey: expect.any(String) as string },
    );
  });

  it('creates NOTHING (and shows no confirm) when EVERY selected profile is already running', async () => {
    listBindingsMock.mockResolvedValue([RUNNING_BINDING]);
    agentSessionsList.mockResolvedValue(LIVE_RUNNING);
    renderView();
    await screen.findByRole('button', { name: 'Open session' });

    fireEvent.click(await screen.findByLabelText('Select Running'));
    await screen.findByText(/1 selected/);

    fireEvent.click(bulkLaunchButton());
    // No confirm dialog opens (zero launchable targets → early return)…
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    // …and no session is created.
    expect(agentCreate).not.toHaveBeenCalled();
  });

  // Finding 2 (low): read-only team gate.
  it('blocks a read-only team member with the clean reason and creates nothing', async () => {
    stableContext.activeWorkspace = 'acct_team';
    stableContext.accountMe.teams = [
      { membership_id: 'mem_team_member', owner_account_id: 'acct_team', role: 'member' },
    ];
    renderView();

    fireEvent.click(await screen.findByLabelText('Select Idle'));
    fireEvent.click(await screen.findByLabelText('Select Running'));
    await screen.findByText(/2 selected/);

    fireEvent.click(bulkLaunchButton());
    // The same clean "ask a team admin" copy the per-row tooltip shows — no wall
    // of opaque per-profile 403s.
    expect(await screen.findByText(/ask a team admin to launch it/i)).toBeTruthy();
    // No confirm opens and no create() fires.
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(agentCreate).not.toHaveBeenCalled();
  });

  it('still allows bulk Launch for a team ADMIN', async () => {
    stableContext.activeWorkspace = 'acct_team';
    stableContext.accountMe.teams = [
      { membership_id: 'mem_team_admin', owner_account_id: 'acct_team', role: 'admin' },
    ];
    agentCreate.mockResolvedValue({ id: 'agt_admin', livekit: LIVEKIT });
    renderView();

    fireEvent.click(await screen.findByLabelText('Select Idle'));
    await screen.findByText(/1 selected/);

    fireEvent.click(bulkLaunchButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
  });

  // Consistency #9: Launch is gated at the CONCURRENT-SESSION cap, including the
  // active AGENT sessions the server's driver-only count omits. Here cap=5 and 5
  // active agent sessions run, so the account is AT the cap (0 driver + 5 agent).
  it('blocks bulk Launch at the concurrent cap (counting active agent sessions) — clean message, no create', async () => {
    agentSessionsList.mockResolvedValue({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: `agt_other_${i.toString()}`,
        created_at: '2026-06-25T00:00:00Z',
        status: 'active',
        liveness: { state: 'active', fresh: true },
      })),
    });
    renderView();

    fireEvent.click(await screen.findByLabelText('Select Idle'));
    await screen.findByText(/1 selected/);

    fireEvent.click(bulkLaunchButton());
    // The cap message surfaces up front; no confirm opens and no create fires.
    expect(await screen.findByText(/Concurrent session cap reached/i)).toBeTruthy();
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(agentCreate).not.toHaveBeenCalled();
  });

  it('disables the per-row Launch at the concurrent cap (idle profile, cap reached via agent sessions)', async () => {
    agentSessionsList.mockResolvedValue({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: `agt_other_${i.toString()}`,
        created_at: '2026-06-25T00:00:00Z',
        status: 'active',
        liveness: { state: 'active', fresh: true },
      })),
    });
    renderView();
    // Neither profile is bound to a session here, so both rows show Launch — and
    // at the cap every per-row Launch is disabled with the cap-reached title.
    await waitFor(() => {
      const launches = screen.getAllByRole('button', { name: 'Launch' });
      expect(launches.length).toBeGreaterThan(0);
      for (const btn of launches) {
        expect(btn).toBeDisabled();
        expect(btn.getAttribute('title')).toMatch(/Concurrent session cap reached/i);
      }
    });
  });

  // Finding 3 (high): markLaunched is best-effort — a binding-write failure after
  // a successful create must NOT abort the launch (which would strand a billed,
  // unstoppable session). The launch proceeds to open the controllable simulator.
  it('a FAILED markLaunched after create still opens the simulator (no stranded session, no close)', async () => {
    agentCreate.mockResolvedValue({ id: 'agt_idle', livekit: LIVEKIT });
    markLaunched.mockRejectedValueOnce(new Error('settings.json write failed'));
    renderView();

    fireEvent.click(await screen.findByLabelText('Select Idle'));
    await screen.findByText(/1 selected/);

    fireEvent.click(bulkLaunchButton());
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Launch' }));

    // The create happened, the binding-write rejected…
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(markLaunched).toHaveBeenCalledWith('prof_idle', 'agt_idle'));
    // …but the launch still handed the session to the simulator (the controllable
    // surface) — the write failure did NOT abort into the catch.
    await waitFor(() => expect(vi.mocked(openSimulatorWindow)).toHaveBeenCalled());
    expect(vi.mocked(openSimulatorWindow).mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'agt_idle',
    });
    // The just-created session is NOT closed (it isn't a leak — the simulator can
    // stop it), and the binding isn't cleared as if the launch failed.
    expect(agentClose).not.toHaveBeenCalled();
    expect(clearSession).not.toHaveBeenCalled();
  });
});
