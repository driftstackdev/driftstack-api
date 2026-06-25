// Behavior coverage for ProfilesView.handleLaunch — the "Launch" button must
// create a STREAMING agent session (client.agentSessions.create) and, when the
// response carries a `livekit` block, render the live-watch overlay. When no
// livekit block comes back (e.g. LiveKit unconfigured on the deployment) it must
// surface a clear error instead of a black screen. Pins the demo's
// create-profile → launch → watch path + its prod-safe fallback.

import { describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { openSimulatorWindow } from '../../src/lib/open-simulator';
import { DriftstackError } from '@driftstack/sdk';

/** The server's egress-required 400 (driver CreateSessionRequest has no proxy
 *  field, so the polling fallback / Quick Session can't satisfy it). */
function proxyRequiredError(): DriftstackError {
  return new DriftstackError({
    kind: 'bad_request',
    status: 400,
    type: 'https://driftstack.dev/problems/bad-request',
    title: 'Bad Request',
    detail:
      'A proxy configuration is required to create a session on this deployment. ' +
      'Supply `proxy` in the create-session body.',
  });
}

const agentCreate = vi.fn<(b: unknown) => Promise<unknown>>();
const agentClose = vi.fn<(id: string) => Promise<unknown>>(() => Promise.resolve({}));
const sessionCreate = vi.fn<(b: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'ses_fallback' }),
);
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
        create: (b: unknown) => sessionCreate(b),
      },
      agentSessions: {
        create: (b: unknown) => agentCreate(b),
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
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

vi.mock('../../src/lib/proxies', () => ({
  listProxies: () =>
    Promise.resolve([{ id: 'p1', host: '127.0.0.1', port: 1080, username: null, password: null }]),
  addProxy: vi.fn(() => Promise.resolve({ id: 'p_new' })),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
  testProxy: vi.fn(() => Promise.resolve({ reachable: true })),
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
    expect(agentCreate).toHaveBeenCalledWith({
      profile_id: 'prof_1',
      mode: 'manual',
      initial_url: 'https://driftstack.dev/',
    });
    // The simulator is ONLY the separate window now (founder 2026-06-18: the
    // scaled in-app overlay was removed). Launch hands the session + livekit
    // join info to the opener; no in-app overlay renders.
    await waitFor(() => expect(vi.mocked(openSimulatorWindow)).toHaveBeenCalled());
    expect(vi.mocked(openSimulatorWindow).mock.calls[0]?.[0]).toMatchObject({
      sessionId: 'agt_1',
      info: LIVEKIT,
    });
    expect(screen.queryByText('agt_demo_room')).toBeNull();
  });

  it('W611/W613: no livekit block → closes the unused agent session, creates a PLAIN driver session with the same profile, and opens THAT in the polling viewer (agt_ ids 400 on /v1/sessions routes — founder-hit)', async () => {
    agentCreate.mockResolvedValueOnce({ id: 'agt_2' });
    const onOpenSession = vi.fn();
    render(<ProfilesView onGoToSettings={vi.fn()} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(onOpenSession).toHaveBeenCalledWith('ses_fallback'));
    // The agent session is closed (concurrency slot + token budget freed)
    // and the driver session carries the profile binding.
    expect(agentClose).toHaveBeenCalledWith('agt_2');
    expect(sessionCreate).toHaveBeenCalledWith({ profile_id: 'prof_1' });
    // The old dead-end message is gone — the launch opens a working viewer.
    expect(screen.queryByText(/no live stream was returned/i)).toBeNull();
  });

  it('polling fallback on an egress-required deployment surfaces a SPECIFIC message (not the raw "proxy configuration is required" 400)', async () => {
    // No livekit → polling fallback; the driver sessions.create 400s because
    // egress is required but the driver schema can't carry the picked proxy.
    agentCreate.mockResolvedValueOnce({ id: 'agt_3' });
    sessionCreate.mockRejectedValueOnce(proxyRequiredError());
    const onOpenSession = vi.fn();
    render(<ProfilesView onGoToSettings={vi.fn()} onOpenSession={onOpenSession} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    // The specific direct-viewer message renders — NOT the raw API detail.
    await waitFor(() =>
      expect(screen.getByText(/direct-viewer fallback needs a proxy/i)).toBeTruthy(),
    );
    expect(screen.queryByText(/Supply `proxy` in the create-session body/i)).toBeNull();
    // The fallback never opens a (broken) viewer session.
    expect(onOpenSession).not.toHaveBeenCalled();
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
