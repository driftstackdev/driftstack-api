// #12 (GUI half) — the "Launch anyway" override must reach the server so the
// re-enabled server-side proxy gate skips its own pre-launch probe for THIS launch.
// Without it the server re-probes the same proxy the operator just overrode and
// hard-blocks with a 422, silently nullifying the override. The GUI signals the
// override by sending `skip_proxy_probe: true` on the agentSessions.create body.
//
// Harness: a profile bound to a default proxy whose LAST cached probe FAILED
// (reachable:false). On Launch, ProfilesView shows a "Launch anyway?" confirm; we
// auto-confirm it and assert the create body carries `skip_proxy_probe: true`. A
// control case with a HEALTHY cached probe (no confirm) must NOT send the field.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const agentCreate = vi.fn<(b: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'agt_1', livekit: LIVEKIT }),
);
const agentClose = vi.fn<(id: string) => Promise<unknown>>(() => Promise.resolve({}));

const LIVEKIT = {
  ws_url: 'ws://localhost:7880',
  room: 'agt_room',
  token: 'tok',
  participant_identity: 'customer-acc',
  expires_at: '2026-06-08T12:00:00Z',
};

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
      sessions: { list: () => Promise.resolve({ data: [] }), create: vi.fn() },
      agentSessions: {
        create: (b: unknown) => agentCreate(b),
        close: (id: string) => agentClose(id),
        livekitToken: () => Promise.resolve(LIVEKIT),
        list: () => Promise.resolve({ data: [] }),
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
    activeWorkspace: null,
    setActiveWorkspace: vi.fn(),
  };
  return { useSettings: () => stable };
});

// Bind the profile to the default proxy p1.
vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () =>
    Promise.resolve([
      { profileId: 'prof_1', defaultProxyId: 'p1', currentSessionId: null, lastLaunchedAt: null },
    ]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

// One local proxy p1 (already synced server-side, so ensureServerProxy returns its
// serverId without a network call) — proxyIdForLaunch is defined → the proxied
// create branch runs (where skip_proxy_probe is conditionally added).
const { testProxyMock } = vi.hoisted(() => ({
  // Hoisted so a single arm can override the live verdict. Defaults to healthy;
  // the down-proxy arm sets a non-routing result. vi.mock is hoisted above every
  // const, so the factory can only close over something vi.hoisted created.
  testProxyMock: vi.fn(() =>
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

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  listProxies: () =>
    Promise.resolve([
      {
        id: 'p1',
        label: 'P1',
        host: '127.0.0.1',
        port: 1080,
        username: null,
        password: null,
        createdAt: '2026-06-08T00:00:00Z',
        serverId: 'aprx_1',
      },
    ]),
  addProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  // The pre-launch gate now RE-TESTS rather than trusting the cache, so this mock
  // has to model a proxy that is genuinely down — otherwise the fresh probe
  // overrides the failed cached verdict this suite is about and no confirm fires.
  // That override is the intended behaviour (a stale failure must not block a proxy
  // that has since recovered); the suite's subject is the down-proxy path.
  // The pre-launch gate now RE-TESTS rather than trusting the cache, so this mock is
  // the verdict each arm acts on — the cached one only matters when a probe cannot
  // run. Defaults to healthy; the down-proxy arm overrides it per-test. That override
  // IS the intended behaviour: a stale failure must not block a proxy that recovered,
  // and a stale success must not launch one that has since stopped routing.
  testProxy: testProxyMock,
  __unusedTestProxyDefault: vi.fn(() =>
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
  probeProxyExit: vi.fn(() => Promise.resolve(null)),
}));

// updateAccountProxy (ensureServerProxy refresh for an already-synced proxy) just
// echoes the serverId; createAccountProxy is unused here.
vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  buildWireGuardProxyInput: vi.fn(),
  buildOpenVpnProxyInput: vi.fn(),
}));

// The cached probe result (loadProbeCache on mount) — configurable per test.
let cachedReachable = false;
vi.mock('../../src/lib/proxy-probe-cache', () => ({
  loadProbeCache: () =>
    Promise.resolve({
      p1: {
        result: {
          reachable: cachedReachable,
          auth_ok: cachedReachable,
          udp_associate: false,
          can_route: true,
          connect_reply: 0x00,
          latency_ms: 0,
          message: cachedReachable ? 'ok' : 'unreachable',
        },
        at: Date.now(),
      },
    }),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  clearProbeResult: vi.fn(() => Promise.resolve({})),
}));

// Auto-confirm the "Launch anyway?" dialog (the operator accepts the risk).
const confirmMock = vi.fn(() => Promise.resolve(true));
vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => confirmMock,
  ConfirmProvider: ({ children }: { children: React.ReactNode }) => children,
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

describe('ProfilesView — "Launch anyway" sends skip_proxy_probe', () => {
  beforeEach(() => {
    agentCreate.mockClear();
    confirmMock.mockClear();
    confirmMock.mockResolvedValue(true);
    // Restore the HEALTHY default. mockResolvedValue persists across tests, so the
    // down-proxy arm's override would otherwise leak into every arm after it — and
    // the leak is invisible: the next arm just sees an unexplained confirm.
    testProxyMock.mockReset();
    testProxyMock.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 12,
      message: 'Working — CONNECT succeeded.',
    });
    cachedReachable = false;
  });

  it('CRITICAL a HEALTHY cache does not excuse a proxy that is down NOW. The gate re-tests before every launch, so a cached success cannot carry a proxy whose plan lapsed or whose ruleset changed since. Without the live probe this arm passes on stale evidence — which is the whole reason the customer stopped trusting the Test button.', async () => {
    cachedReachable = true; // cache says fine…
    testProxyMock.mockResolvedValue({
      // …but the proxy authenticates and refuses to route, right now.
      reachable: true,
      auth_ok: true,
      udp_associate: false,
      can_route: false,
      connect_reply: 0x02,
      latency_ms: 12,
      message: 'Authenticates, but cannot route.',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    await waitFor(() =>
      expect(
        confirmMock,
        'a stale healthy cache launched a proxy that cannot route — the gate is not re-testing',
      ).toHaveBeenCalled(),
    );
    expect(
      String(confirmMock.mock.calls[0]?.[0] ?? ''),
      'the warning does not name the routing fault, so it reads as a credential problem',
    ).toContain('could not route');
  });

  it('a FAILED cached probe + "Launch anyway" → create body carries skip_proxy_probe:true', async () => {
    cachedReachable = false;
    // The gate re-tests before launching, so the LIVE verdict is what it acts on.
    // Model a proxy that is genuinely down, not merely remembered as down.
    testProxyMock.mockResolvedValue({
      reachable: true,
      auth_ok: true,
      udp_associate: false,
      can_route: false,
      connect_reply: 0x02,
      latency_ms: 12,
      message: 'Authenticates, but cannot route.',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    // The override confirm was shown and accepted.
    await waitFor(() => expect(confirmMock).toHaveBeenCalled());
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    const body = agentCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.proxy_id).toBe('aprx_1');
    expect(body.skip_proxy_probe).toBe(true);
  });

  it('a HEALTHY cached probe (no override) → no confirm, and skip_proxy_probe is OMITTED', async () => {
    cachedReachable = true;
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    expect(confirmMock).not.toHaveBeenCalled();
    const body = agentCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.proxy_id).toBe('aprx_1');
    expect('skip_proxy_probe' in body).toBe(false);
  });
});
