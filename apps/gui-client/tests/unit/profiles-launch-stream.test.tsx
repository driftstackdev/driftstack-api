// Behavior coverage for ProfilesView.handleLaunch — the "Launch" button must
// create a STREAMING agent session (client.agentSessions.create) and, when the
// response carries a `livekit` block, hand the session to the floating Simulator
// window (the only live-session UI). When no livekit block comes back (e.g.
// LiveKit unconfigured on the deployment) there's no video channel to stream, so
// it must close the just-created session + clear the binding + surface a clear
// retry-able error — never open an in-app page (the legacy polling viewer was
// removed). Pins the create-profile → launch → simulator path + its failure mode.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { openSimulatorWindow } from '../../src/lib/open-simulator';

const agentCreate = vi.fn<(b: unknown, opts?: unknown) => Promise<unknown>>();
const agentClose = vi.fn<(id: string) => Promise<unknown>>(() => Promise.resolve({}));
const clearSession = vi.fn<(profileId: string) => Promise<void>>(() => Promise.resolve());
// Configurable per-test (default = empty) so the session-tracking self-heal can be
// exercised: a profile bound to an agt_ session reads "running" only if that session
// is in the live agentSessions list AND not closed.
const agentSessionsList = vi.fn<() => Promise<{ data: unknown[] }>>(() =>
  Promise.resolve({ data: [] }),
);
const listBindingsMock = vi.fn<() => Promise<unknown[]>>(() => Promise.resolve([]));

function profile() {
  return {
    id: 'prof_1',
    name: 'Demo',
    archetype: 'iphone16pro_ios18_7_safari26_4',
    description: null,
    last_used_at: null,
    created_at: '2026-06-08T00:00:00Z',
    updated_at: '2026-06-08T00:00:00Z',
  };
}

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: [profile()] }),
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          yield profile();
        },
      },
      sessions: {
        list: () => Promise.resolve({ data: [] }),
      },
      agentSessions: {
        create: (b: unknown, opts?: unknown) => agentCreate(b, opts),
        close: (id: string) => agentClose(id),
        // W624 — Live-view re-open path for an already-running agent session.
        livekitToken: () => Promise.resolve(LIVEKIT),
        // Worktimer + W624 staleness cross-check — the refresh loop lists agent
        // sessions (best-effort) for the running-row timer + the self-heal.
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
      concurrent_session_cap: 1,
      concurrent_session_active: 0,
      profile_cap: 10,
      profile_active: 1,
    },
    refreshAccountMe: vi.fn(() => Promise.resolve()),
    loading: false,
    update: vi.fn(() => Promise.resolve()),
    // Default workspace = Personal (mirrors the real context's null default;
    // Launch is gated when a team workspace is active).
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  };
  return { useSettings: () => stable };
});

vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () => listBindingsMock(),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: (profileId: string) => clearSession(profileId),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/proxies', () => ({
  listProxies: () =>
    Promise.resolve([{ id: 'p1', host: '127.0.0.1', port: 1080, username: null, password: null }]),
  addProxy: vi.fn(() => Promise.resolve({ id: 'p_new' })),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.resolve({ reachable: true })),
}));

// ensureServerProxy syncs the picked proxy to an account_proxies row before launch;
// mock it to SUCCEED so the launch proceeds. (Launch now FAILS CLOSED on a sync
// error to avoid egressing through the default IP — GUI founder-hit sweep — so an
// unmocked account-proxies fetch would abort the launch instead of falling back.)
vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
}));

// Stub the LiveKit-connecting panel (used by the separate simulator window).
vi.mock('../../src/components/AgentSessionPanel', () => ({
  AgentSessionPanel: () => <div data-testid="agent-session-panel" />,
}));

// Control transport — mintGuiControlKey (launch hand-off) is a harmless no-op
// here. W2679: boundSession no longer probes page-state; liveness comes from the
// server `liveness` field on the agent-session list entries (driven per-test).
vi.mock('../../src/lib/agent-session-control', () => ({
  mintGuiControlKey: vi.fn(() => Promise.resolve(null)),
}));

// Founder 2026-06-18: the in-app full-page overlay was removed — launch now ONLY
// opens the SEPARATE simulator window. Mock the opener so we can assert the
// hand-off (jsdom isn't Tauri, so the real opener would no-op as opened:false).
vi.mock('../../src/lib/open-simulator', () => ({
  openSimulatorWindow: vi.fn(() => Promise.resolve({ opened: true })),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

const LIVEKIT = {
  ws_url: 'ws://localhost:7880',
  room: 'agt_demo_room',
  token: 'tok',
  participant_identity: 'customer-acc',
  expires_at: '2026-06-08T12:00:00Z',
};

describe('ProfilesView launch → stream', () => {
  beforeEach(() => {
    agentCreate.mockClear();
    agentClose.mockClear();
    clearSession.mockClear();
    agentSessionsList.mockClear();
    listBindingsMock.mockClear();
    vi.mocked(openSimulatorWindow).mockClear();
  });

  it('keeps the clicked row visibly busy throughout the slow proxy-probe create', async () => {
    let resolveCreate: ((value: unknown) => void) | undefined;
    agentCreate.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveCreate = resolve;
        }),
    );
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));

    await waitFor(() => expect(agentCreate).toHaveBeenCalled());
    const starting = screen.getByRole('button', { name: 'Starting…' });
    expect(starting).toBeDisabled();
    expect(starting).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[data-component="launch-spinner"]')).not.toBeNull();
    expect(
      screen.getByText(/this can take about 10 seconds while we check your proxy/i),
    ).toBeInTheDocument();

    resolveCreate?.({ id: 'agt_slow', livekit: LIVEKIT });
    await waitFor(() => expect(screen.getByRole('button', { name: 'Launch' })).toBeEnabled());
    expect(screen.queryByText(/this can take about 10 seconds/i)).toBeNull();
  });

  it('Launch creates an agent session and hands the session to the SEPARATE simulator window when livekit is returned', async () => {
    agentCreate.mockResolvedValueOnce({ id: 'agt_1', livekit: LIVEKIT });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    // Launch attaches THIS profile (file 57) — the canonical prof_<uuid> id is
    // passed as-is (the API normalizes it server-side, W335/W336) — and starts in
    // manual mode (a GUI launch opens the simulator for the user to drive).
    // initial_url = the normalized Start URL setting (normalizeNavigateUrl runs the
    // value through new URL().toString(), which adds the root trailing slash).
    expect(agentCreate).toHaveBeenCalledWith(
      {
        profile_id: 'prof_1',
        // The profile's bound proxy (p1) is synced to an account_proxies row
        // (aprx_1) and passed as proxy_id so the session egresses through it — launch
        // now FAILS CLOSED rather than omitting proxy_id on a sync error (sweep).
        proxy_id: 'aprx_1',
        mode: 'manual',
        initial_url: 'https://driftstack.dev/',
      },
      // A client-generated Idempotency-Key rides on create so a founder retry after a
      // perceived hang (the ~12s proxy probe) replays the cached 201 instead of creating
      // a SECOND billed session.
      { idempotencyKey: expect.any(String) as string },
    );
    // The simulator is ONLY the separate window now (founder 2026-06-18: the
    // scaled in-app overlay was removed). Launch hands the session + livekit
    // join info to the opener; no in-app overlay renders.
    await waitFor(() => expect(vi.mocked(openSimulatorWindow)).toHaveBeenCalled());
    expect(vi.mocked(openSimulatorWindow).mock.calls.at(-1)?.[0]).toMatchObject({
      sessionId: 'agt_1',
      info: LIVEKIT,
    });
    expect(screen.queryByText('agt_demo_room')).toBeNull();
  });

  it('no livekit block → closes the unused agent session, clears the binding, and surfaces a retry-able error WITHOUT opening any in-app view (the polling viewer was removed)', async () => {
    agentCreate.mockResolvedValueOnce({ id: 'agt_2' });
    // Snapshot this test's call count so the assertion remains local even if a
    // future setup step legitimately opens another window first.
    const openCallsBefore = vi.mocked(openSimulatorWindow).mock.calls.length;
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    // No video channel → the channel-less session is closed (slot + token budget
    // freed) and its binding cleared so it never strands a billed session.
    await waitFor(() => expect(agentClose).toHaveBeenCalledWith('agt_2'));
    await waitFor(() => expect(clearSession).toHaveBeenCalledWith('prof_1'));
    // The user-facing error is shown — and the floating Simulator window is NEVER
    // opened for a channel-less session.
    await waitFor(() =>
      expect(screen.getByText(/didn't get a video channel\. Try again/i)).toBeTruthy(),
    );
    expect(vi.mocked(openSimulatorWindow).mock.calls.length).toBe(openCallsBefore);
  });

  it('a FAILED simulator-window open closes the just-created session (no leaked billed session) and clears the binding', async () => {
    agentCreate.mockResolvedValueOnce({ id: 'agt_leak', livekit: LIVEKIT });
    // The floating-iPhone window fails to open (Tauri error / non-collision failure).
    vi.mocked(openSimulatorWindow).mockResolvedValueOnce({ opened: false, reason: 'boom' });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    // The created session is closed so it isn't left running with no UI to stop it.
    await waitFor(() => expect(agentClose).toHaveBeenCalledWith('agt_leak'));
    // The binding is cleared, and the error no longer tells the founder to "close it" —
    // nothing opened, and the session was stopped.
    await waitFor(() => expect(clearSession).toHaveBeenCalledWith('prof_1'));
    await waitFor(() =>
      expect(screen.getByText(/The session was stopped — try launching again/i)).toBeTruthy(),
    );
  });

  // Session-tracking self-heal (founder 2026-06-18: "always says open session even
  // on long-expired/failed sessions"). boundSession reads a bound agent session as
  // running ONLY if it's in the live list AND not closed.
  const STALE_BINDING = {
    profileId: 'prof_1',
    defaultProxyId: null,
    currentSessionId: 'agt_bound',
    lastLaunchedAt: '2026-06-18T00:00:00Z',
  };

  it('self-heals a CLOSED agent binding to idle: the profile shows Launch, not Open session', async () => {
    listBindingsMock.mockResolvedValueOnce([STALE_BINDING]);
    agentSessionsList.mockResolvedValueOnce({
      data: [{ id: 'agt_bound', created_at: '2026-06-18T00:00:00Z', status: 'closed' }],
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Launch' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull());
  });

  it('shows Open session for an ACTIVE agent binding present in the live list', async () => {
    listBindingsMock.mockResolvedValueOnce([STALE_BINDING]);
    agentSessionsList.mockResolvedValueOnce({
      data: [{ id: 'agt_bound', created_at: '2026-06-18T00:00:00Z', status: 'active' }],
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Open session' })).toBeTruthy();
  });

  // Liveness re-base (W2679, founder 2026-06-18: "always says open session even
  // on a dead/orphaned session"). An `active` session whose worker crashed /
  // never came up stays `active` for up to the 12h reaper cap, so the live-list
  // status check isn't enough. The SERVER now re-bases the worker's liveness onto
  // the fleet heartbeat and reports it inline on each list entry; boundSession
  // reads that `liveness` field directly (no client-side page-state probe):
  //   • liveness PRESENT && fresh === true → RUNNING (any state).
  //   • liveness PRESENT && fresh === false → stale beat → IDLE (Launch).
  //   • liveness ABSENT → unknown → trust the binding (RUNNING).

  it('demotes an agent binding with a STALE liveness beat (fresh: false) to idle: shows Launch, not Open session', async () => {
    listBindingsMock.mockResolvedValueOnce([STALE_BINDING]);
    // active + present in the list, but the owning node's beat is stale (worker
    // silent) → fresh: false → dead.
    agentSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: 'agt_bound',
          created_at: '2026-06-18T00:00:00Z',
          status: 'active',
          liveness: { state: 'active', fresh: false },
        },
      ],
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Launch' })).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Open session' })).toBeNull());
  });

  it('keeps an agent binding with a FRESH liveness beat (fresh: true) reading running: shows Open session', async () => {
    listBindingsMock.mockResolvedValueOnce([STALE_BINDING]);
    // A recent beat trusts the worker state (any state) → running.
    agentSessionsList.mockResolvedValueOnce({
      data: [
        {
          id: 'agt_bound',
          created_at: '2026-06-18T00:00:00Z',
          status: 'active',
          liveness: { state: 'active', fresh: true },
        },
      ],
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Open session' })).toBeTruthy();
  });

  it('trusts the binding when liveness is ABSENT (no fleet CP / no beat yet): shows Open session — never treats absent as dead', async () => {
    listBindingsMock.mockResolvedValueOnce([STALE_BINDING]);
    // No `liveness` field at all (older deployment / no beat reported the
    // session) → unknown → trust the binding → running.
    agentSessionsList.mockResolvedValueOnce({
      data: [{ id: 'agt_bound', created_at: '2026-06-18T00:00:00Z', status: 'active' }],
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Open session' })).toBeTruthy();
  });

  // Proxy-reroute privacy hazard (deep-audit HIGH): a profile EXPLICITLY bound to
  // a proxy that has since been DELETED must NOT silently reroute its egress to a
  // different proxy. Launch refuses with a "configured proxy was deleted" message
  // (distinct from the "no proxies saved at all" message) and never creates a
  // session through the wrong exit.
  it('refuses to launch a profile whose explicitly-bound proxy was deleted (no silent reroute)', async () => {
    // Bound to px_deleted, which is NOT in the proxies list (only p1 exists).
    // Persistent (not Once) — the refresh loop reads bindings repeatedly, and the
    // dangling binding must still be in effect when Launch is clicked.
    listBindingsMock.mockResolvedValue([
      {
        profileId: 'prof_1',
        defaultProxyId: 'px_deleted',
        currentSessionId: null,
        lastLaunchedAt: null,
      },
    ]);
    // agentCreate isn't reset between tests in this file; snapshot the count so
    // we can assert THIS launch added no call (rather than a global zero).
    const createCallsBefore = agentCreate.mock.calls.length;
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    // The deleted-proxy message renders…
    await waitFor(() => expect(screen.getByText(/configured proxy was deleted/i)).toBeTruthy());
    // …and it's NOT the generic "no saved proxies" copy (a proxy DOES exist; the
    // bound one was just deleted).
    expect(screen.queryByText(/No saved proxies/i)).toBeNull();
    // Critically: no session was created through proxies[0]'s exit.
    expect(agentCreate.mock.calls.length).toBe(createCallsBefore);
    // Restore the default (no bindings) so this persistent mock doesn't bleed
    // into later tests (no shared beforeEach reset in this file).
    listBindingsMock.mockImplementation(() => Promise.resolve([]));
  });

  // Stop (founder Track A) — a running grid card exposes a Stop affordance in the
  // ⋯ menu that closes the bound agent session (the SAME end path window-close
  // uses: agentSessions.close(agt_)), then the card flips back to Launch.
  it('the running grid card Stop closes the bound agent session via agentSessions.close', async () => {
    listBindingsMock.mockResolvedValueOnce([STALE_BINDING]);
    // First refresh: running (fresh beat) so the Stop affordance is present.
    // After Stop closes the session, the post-stop refresh returns it CLOSED so
    // the card self-heals back to Launch.
    agentSessionsList
      .mockResolvedValueOnce({
        data: [
          {
            id: 'agt_bound',
            created_at: '2026-06-18T00:00:00Z',
            status: 'active',
            liveness: { state: 'active', fresh: true },
          },
        ],
      })
      .mockResolvedValue({
        data: [{ id: 'agt_bound', created_at: '2026-06-18T00:00:00Z', status: 'closed' }],
      });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    // Wait until the card reads running.
    await screen.findByRole('button', { name: 'Open session' });
    // Open the ⋯ menu, then click the always-in-DOM Stop row (labelled).
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(screen.getByLabelText(/Stop .* running session/));
    await waitFor(() => expect(agentClose).toHaveBeenCalledWith('agt_bound'));
  });
});
