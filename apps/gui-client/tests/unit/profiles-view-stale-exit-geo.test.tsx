// Regression coverage for the SAME stale-exit-geo bug as ProxiesView, on the
// Profiles hub. saveProbeResult (proxy-probe-cache) deliberately preserves a
// proxy's prior exit IP / country across a FAILED capability re-test (capability
// and exit probes run separately). ProfilesView re-hydrated and rendered that
// exit IP / country / flag for a DOWN proxy with NO health gate, so a proxy that
// was healthy (exit US 203.0.113.7 cached) then went down would still show a
// misleading "exits from US 203.0.113.7" — same hazard as the now-fixed
// ProxiesView. The data-source fix gates the exit-geo passes on the last
// capability probe being healthy (reachable && auth_ok).

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

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
        create: vi.fn(),
        close: vi.fn(),
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

vi.mock('../../src/lib/proxies', () => ({
  // Pure predicate — use the real one. A stub here would let a suite
  // disagree with the app about what "usable" means, which is the very
  // drift this predicate was introduced to remove.
  isProxyUsable: (r: { reachable: boolean; auth_ok: boolean; can_route: boolean }): boolean =>
    r.reachable && r.auth_ok && r.can_route,
  // Same reasoning as isProxyUsable above: the WORDS for a verdict are as
  // drift-prone as the verdict. Kept in step with lib/proxies.proxyVerdict.
  proxyVerdict: (r: {
    reachable: boolean;
    auth_ok: boolean;
    can_route: boolean;
    latency_ms: number;
  }): { ok: boolean; label: string } =>
    !r.reachable
      ? { ok: false, label: 'Not reachable' }
      : !r.auth_ok
        ? { ok: false, label: 'Auth failed' }
        : !r.can_route
          ? { ok: false, label: 'Cannot route' }
          : { ok: true, label: `Reachable · ${r.latency_ms} ms` },
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
  probeProxyExit: vi.fn(() => Promise.resolve(null)),
}));

vi.mock('../../src/lib/account-proxies', () => ({
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  buildWireGuardProxyInput: vi.fn(),
  buildOpenVpnProxyInput: vi.fn(),
}));

// The cached probe (loadProbeCache on mount). A prior healthy probe recorded an
// exit IP/country; the LAST probe's reachability is configurable per test.
let lastReachable = false;
vi.mock('../../src/lib/proxy-probe-cache', () => ({
  loadProbeCache: () =>
    Promise.resolve({
      p1: {
        result: {
          reachable: lastReachable,
          auth_ok: lastReachable,
          udp_associate: false,
          can_route: true,
          connect_reply: 0x00,
          latency_ms: lastReachable ? 42 : 0,
          message: lastReachable ? 'ok' : 'TCP connect failed: timed out',
        },
        at: Date.now(),
        // Preserved across the failed re-test by saveProbeResult.
        exitIp: '203.0.113.7',
        exitCountry: 'US',
      },
    }),
  saveProbeResult: vi.fn(() => Promise.resolve({})),
  saveExitResult: vi.fn(() => Promise.resolve({})),
  invalidateProbe: vi.fn(() => Promise.resolve({})),
}));

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

describe('ProfilesView — exit-geo is gated on capability health', () => {
  beforeEach(() => {
    lastReachable = false;
  });

  it('hides the stale exit IP / country on the grid card when the last probe was unreachable', async () => {
    lastReachable = false;
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    // The profile card mounts (Launch button proves the row rendered).
    await screen.findByRole('button', { name: 'Launch' });
    // The stale exit IP + country must NOT show for a down proxy — the card
    // falls back to the honest "no exit IP" prompt.
    expect(screen.queryByText('203.0.113.7')).toBeNull();
    expect(screen.queryByText('US')).toBeNull();
    expect(screen.getByText('no exit IP')).toBeTruthy();
  });

  it('shows the exit IP / country when the last probe was healthy', async () => {
    lastReachable = true;
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await screen.findByRole('button', { name: 'Launch' });
    // A healthy proxy still surfaces its hydrated exit IP + country.
    expect(screen.getByText('203.0.113.7')).toBeTruthy();
    expect(screen.getByText('US')).toBeTruthy();
  });
});
