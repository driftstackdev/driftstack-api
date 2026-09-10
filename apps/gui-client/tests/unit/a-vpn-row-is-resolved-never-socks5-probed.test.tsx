// T-20 (GUI half, owner #6) — an OpenVPN/WireGuard profile "says proxy check
// unreachable" on every launch.
//
// MEASURED: the pre-launch gate ran the native SOCKS5 probe for every scheme,
// so a VPN row (host/port = the config's UDP endpoint) got a SOCKS5 greeting
// that can never succeed → `reachable:false` forever → "The proxy was
// unreachable on its last test … Launch anyway?" on every launch. The Proxies
// tab, the sweeper and the inline form already gated on scheme; the launch gate,
// the card's Test and the auto-probe did not.
//
// The honest client-side check for a VPN endpoint is a DNS resolve; the tunnel
// is verified at launch. So: a VPN launch resolves the endpoint and NEVER
// invokes the SOCKS5 probe, its only confirm names the unresolved endpoint, and
// a SOCKS5 launch is unchanged (the control). T-17 rides the same launch path:
// a stale exit identity is re-probed so the device clock gets the CURRENT zone.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';

const stores = new Map<string, Map<string, unknown>>();
vi.mock('@tauri-apps/plugin-store', () => ({
  LazyStore: class {
    private file: string;
    constructor(file: string) {
      this.file = file;
      if (!stores.has(file)) stores.set(file, new Map());
    }
    private map(): Map<string, unknown> {
      let m = stores.get(this.file);
      if (!m) {
        m = new Map();
        stores.set(this.file, m);
      }
      return m;
    }
    get(key: string): Promise<unknown> {
      return Promise.resolve(this.map().get(key));
    }
    set(key: string, value: unknown): Promise<void> {
      this.map().set(key, value);
      return Promise.resolve();
    }
    save(): Promise<void> {
      return Promise.resolve();
    }
  },
}));

const LIVEKIT = {
  ws_url: 'ws://localhost:7880',
  room: 'agt_room',
  token: 'tok',
  participant_identity: 'customer-acc',
  expires_at: '2026-06-08T12:00:00Z',
};

const agentCreate = vi.fn<(b: unknown) => Promise<unknown>>(() =>
  Promise.resolve({ id: 'agt_1', livekit: LIVEKIT }),
);

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
        close: vi.fn(() => Promise.resolve({})),
        livekitToken: () => Promise.resolve(LIVEKIT),
        list: () => Promise.resolve({ data: [] }),
      },
    },
    settings: {
      apiKey: 'ds_test_x',
      baseUrl: 'http://localhost:3000',
      startUrl: 'https://driftstack.io',
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

const { state } = vi.hoisted(() => ({
  state: { boundProxyId: 'vpn1' },
}));

vi.mock('../../src/lib/profile-bindings', () => ({
  listBindings: () =>
    Promise.resolve([
      {
        profileId: 'prof_1',
        defaultProxyId: state.boundProxyId,
        currentSessionId: null,
        lastLaunchedAt: null,
      },
    ]),
  getBinding: () => Promise.resolve(null),
  setDefaultProxy: vi.fn(() => Promise.resolve()),
  markLaunched: vi.fn(() => Promise.resolve()),
  clearSession: vi.fn(() => Promise.resolve()),
  deleteBinding: vi.fn(() => Promise.resolve()),
}));

const HEALTHY: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'Working — CONNECT succeeded.',
};

const VPN_PROXY: ProxyConfig = {
  id: 'vpn1',
  label: 'ResVPN',
  host: 'vpn.example.com',
  port: 1194,
  username: null,
  password: null,
  createdAt: '2026-06-08T00:00:00Z',
  scheme: 'openvpn',
  serverId: 'aprx_vpn',
  openvpn: { config_blob: 'client\nremote vpn.example.com 1194\n' },
};

const SOCKS5_PROXY: ProxyConfig = {
  id: 'p1',
  label: 'P1',
  host: '127.0.0.1',
  port: 1080,
  username: null,
  password: null,
  createdAt: '2026-06-08T00:00:00Z',
  scheme: 'socks5',
  serverId: 'aprx_1',
};

const { testProxy, resolveEndpoint, probeProxyExit } = vi.hoisted(() => ({
  testProxy: vi.fn<(input: unknown) => Promise<ProxyTestResult>>(),
  resolveEndpoint:
    vi.fn<
      (host: string, port: number) => Promise<{ resolved: boolean; ip: string; message: string }>
    >(),
  probeProxyExit: vi.fn<(input: unknown) => Promise<unknown>>(),
}));

// Partial mock: the pure predicates stay REAL; only the native calls are spies.
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([VPN_PROXY, SOCKS5_PROXY]),
  addProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  testProxy: (input: unknown) => testProxy(input),
  resolveEndpoint: (host: string, port: number) => resolveEndpoint(host, port),
  probeProxyExit: (input: unknown) => probeProxyExit(input),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_new' })),
  updateProxy: vi.fn((_b: string, _k: string, id: string) => Promise.resolve({ id })),
  testAccountProxy: vi.fn(() => Promise.reject(new Error('not under test here'))),
}));

const confirmMock = vi.fn<(msg: string, opts?: unknown) => Promise<boolean>>(() =>
  Promise.resolve(true),
);
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
const openSimulatorWindow = vi.fn<(args: Record<string, unknown>) => Promise<unknown>>(() =>
  Promise.resolve({ opened: true }),
);
vi.mock('../../src/lib/open-simulator', () => ({
  openSimulatorWindow: (args: Record<string, unknown>) => openSimulatorWindow(args),
}));

const { ProfilesView } = await import('../../src/views/ProfilesView');

const STORE = 'proxy-probe-cache.json';
function seedCache(probes: Record<string, unknown>): void {
  stores.set(STORE, new Map<string, unknown>([['probes', probes]]));
}
function storedProbe(id: string): Record<string, unknown> | undefined {
  const probes = stores.get(STORE)?.get('probes') as Record<string, unknown> | undefined;
  return probes?.[id] as Record<string, unknown> | undefined;
}

async function launch(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
}

beforeEach(() => {
  stores.clear();
  agentCreate.mockClear();
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
  openSimulatorWindow.mockClear();
  testProxy.mockReset();
  testProxy.mockResolvedValue(HEALTHY);
  resolveEndpoint.mockReset();
  resolveEndpoint.mockResolvedValue({ resolved: true, ip: '203.0.113.9', message: 'Resolved' });
  probeProxyExit.mockReset();
  probeProxyExit.mockResolvedValue(null);
  state.boundProxyId = 'vpn1';
});

describe('a VPN profile launches through the endpoint resolve, never the SOCKS5 probe', () => {
  it('CRITICAL an OpenVPN launch resolves the endpoint and NEVER invokes the SOCKS5 probe', async () => {
    await launch();
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194);
    expect(
      testProxy,
      'a SOCKS5 greeting sent to an OpenVPN remote can only ever answer "unreachable"',
    ).not.toHaveBeenCalled();
    expect(confirmMock, 'a resolved endpoint is not a reason to confirm').not.toHaveBeenCalled();
  });

  it('CRITICAL the old false SOCKS5 "unreachable" already in the cache never reaches the confirm (the owner\'s exact symptom)', async () => {
    seedCache({
      vpn1: {
        result: {
          ...HEALTHY,
          reachable: false,
          auth_ok: false,
          can_route: false,
          message: 'TCP connect failed',
        },
        at: Date.now(),
      },
    });
    await launch();
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    expect(confirmMock).not.toHaveBeenCalled();
    expect(testProxy).not.toHaveBeenCalled();
  });

  it("CRITICAL an endpoint that does not resolve confirms with the VPN sentence ONLY — never 'unreachable', 'credentials' or 'route'", async () => {
    resolveEndpoint.mockResolvedValue({ resolved: false, ip: '', message: 'DNS lookup failed' });
    await launch();
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    const text = confirmMock.mock.calls[0]?.[0] ?? '';
    expect(text).toBe(
      "The VPN endpoint vpn.example.com could not be resolved. Check the config's remote line. Launch anyway?",
    );
    expect(text).not.toMatch(/unreachable|credentials|route traffic/i);
    // Accepting the risk tells the server to skip its own pre-launch probe, as
    // the SOCKS5 override does.
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    const body = agentCreate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(body.skip_proxy_probe).toBe(true);
  });

  it('declining the VPN confirm does not launch', async () => {
    resolveEndpoint.mockResolvedValue({ resolved: false, ip: '', message: 'DNS lookup failed' });
    confirmMock.mockResolvedValue(false);
    await launch();
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    await new Promise((r) => setTimeout(r, 30));
    expect(agentCreate).not.toHaveBeenCalled();
  });

  it('the resolve verdict lands in the cache as an endpoint verdict, not a SOCKS5 one', async () => {
    await launch();
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(storedProbe('vpn1')?.endpoint).toEqual({
        resolved: true,
        ip: '203.0.113.9',
        message: 'Resolved',
      }),
    );
    expect((storedProbe('vpn1')?.result as { reachable: boolean }).reachable).toBe(false);
  });

  it('VACUITY CONTROL — a SOCKS5 launch is unchanged: the native probe runs, the resolve does not, and a healthy verdict needs no confirm', async () => {
    state.boundProxyId = 'p1';
    await launch();
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
    expect(testProxy).toHaveBeenCalledTimes(1);
    expect(resolveEndpoint).not.toHaveBeenCalled();
    expect(confirmMock).not.toHaveBeenCalled();
  });

  it('CONTROL — a SOCKS5 proxy that cannot route still gets the SOCKS5 ladder (the ladder was not removed, only scoped)', async () => {
    state.boundProxyId = 'p1';
    testProxy.mockResolvedValue({ ...HEALTHY, can_route: false, connect_reply: 0x02 });
    await launch();
    await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
    expect(confirmMock.mock.calls[0]?.[0]).toContain('could not route');
  });
});

describe("the card's Test on a VPN row runs the resolve, not the SOCKS5 probe", () => {
  it('CRITICAL Test proxy → resolveEndpoint, never proxy_test', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194));
    expect(testProxy).not.toHaveBeenCalled();
    await waitFor(() => expect(storedProbe('vpn1')?.endpoint).toBeDefined());
  });

  it('VACUITY CONTROL — Test proxy on a SOCKS5 row still runs the native probe', async () => {
    state.boundProxyId = 'p1';
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    expect(resolveEndpoint).not.toHaveBeenCalled();
  });
});

describe('T-17 — a stale exit identity is re-probed at launch', () => {
  const THIRTY_ONE_MIN = 31 * 60 * 1000;
  const cachedHealthy = (exitAt: number) => ({
    p1: {
      result: HEALTHY,
      at: Date.now(),
      exitIp: '198.51.100.2',
      exitCountry: 'NL',
      exitTimezone: 'Europe/Amsterdam',
      exitAt,
    },
  });

  it('CRITICAL an exit identity older than the TTL is re-probed and the CURRENT zone reaches the simulator', async () => {
    state.boundProxyId = 'p1';
    seedCache(cachedHealthy(Date.now() - THIRTY_ONE_MIN));
    probeProxyExit.mockResolvedValue({
      ip: '198.51.100.7',
      country: 'US',
      city: null,
      region: null,
      timezone: 'America/New_York',
    });
    await launch();
    await waitFor(() => expect(openSimulatorWindow).toHaveBeenCalledTimes(1));
    expect(probeProxyExit).toHaveBeenCalledTimes(1);
    expect(openSimulatorWindow.mock.calls[0]?.[0]).toMatchObject({
      countryCode: 'US',
      timezone: 'America/New_York',
    });
  });

  it('VACUITY CONTROL — a fresh exit identity is handed over as cached, with no probe', async () => {
    state.boundProxyId = 'p1';
    seedCache(cachedHealthy(Date.now() - 1000));
    await launch();
    await waitFor(() => expect(openSimulatorWindow).toHaveBeenCalledTimes(1));
    expect(probeProxyExit).not.toHaveBeenCalled();
    expect(openSimulatorWindow.mock.calls[0]?.[0]).toMatchObject({
      countryCode: 'NL',
      timezone: 'Europe/Amsterdam',
    });
  });

  it('a failed re-probe hands over what was cached rather than blocking the launch', async () => {
    state.boundProxyId = 'p1';
    seedCache(cachedHealthy(Date.now() - THIRTY_ONE_MIN));
    probeProxyExit.mockResolvedValue(null);
    await launch();
    await waitFor(() => expect(openSimulatorWindow).toHaveBeenCalledTimes(1));
    expect(openSimulatorWindow.mock.calls[0]?.[0]).toMatchObject({ timezone: 'Europe/Amsterdam' });
  });
});

describe('(b) — Test proxy on a VPN row asks the FLEET after the resolve', () => {
  // The profile card's Test is the user-initiated place a VPN tunnel gets brought
  // up on a fleet Mac and its real exit measured. Mutating runFleetTestForRow to
  // `if (true || …) return null;` makes this red.
  it('CRITICAL Test proxy → resolveEndpoint, then testAccountProxy(vantage fleet) for the stored row', async () => {
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194));
    await waitFor(() =>
      expect(AccountProxies.testAccountProxy).toHaveBeenCalledWith(
        'http://localhost:3000',
        'ds_test_x',
        'aprx_vpn',
        { vantage: 'fleet' },
      ),
    );
    expect(testProxy).not.toHaveBeenCalled();
  });

  // (g) — pins `{ adoptExit: true }` on the card's persistServerProbe call: the
  // shared step writes a VPN row's observed exit ONLY when the caller asks (a
  // SOCKS5 caller must not), so dropping the flag in runFleetTestForRow makes
  // this red — the fleet number lands, the exit never does.
  it('CRITICAL a card Test whose fleet reply carries exit_observed writes exitIp into the cache (adoptExit)', async () => {
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-07',
      exit_observed: {
        ip: '203.0.113.9',
        country: 'NL',
        timezone: 'Europe/Amsterdam',
        region: null,
        city: null,
      },
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(AccountProxies.testAccountProxy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(storedProbe('vpn1')?.serverLatencyMs).toBe(31));
    await waitFor(() => expect(storedProbe('vpn1')?.exitIp).toBe('203.0.113.9'));
    expect(storedProbe('vpn1')?.exitCountry).toBe('NL');
    expect(storedProbe('vpn1')?.exitTimezone).toBe('Europe/Amsterdam');
    expect(storedProbe('vpn1')?.endpoint).toEqual({
      resolved: true,
      ip: '203.0.113.9',
      message: 'Resolved',
    });
  });
});

describe('(b) — a VPN LAUNCH never runs the fleet test', () => {
  // A fleet probe brings the tunnel up on a node while the launching session brings
  // up its own; most VPN accounts allow one connection, so the probe could break the
  // launch — and it would add 30–45s before every VPN launch. Reverting the launch
  // gate to "run the fleet test first" makes this red.
  it('CRITICAL launching an OpenVPN profile resolves the endpoint and never calls testAccountProxy', async () => {
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    await launch();
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194));
    await new Promise((r) => setTimeout(r, 30));
    expect(AccountProxies.testAccountProxy).not.toHaveBeenCalled();
  });
});
