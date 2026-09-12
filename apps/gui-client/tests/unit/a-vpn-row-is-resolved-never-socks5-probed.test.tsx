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
import {
  ENDPOINT_MOVED_NO_VERDICT_NOTICE,
  NO_VERDICT_YET_NOTICE,
  SERVER_DID_NOT_ANSWER_NOTICE,
} from '../../src/lib/proxy-server-test';
import type { SweepDeps } from '../../src/lib/proxy-probe-sweeper';
import {
  __resetSweepLatchForTests,
  isProxyProbeInFlight,
  runSweep,
} from '../../src/lib/proxy-probe-sweeper';

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

/** (V4 follow-up) — the create modal's own call, so the post-create AUTO-probe
 *  (`#3 auto-test on create` → `probeIfUnprobed`) can be driven for real rather
 *  than asserted about. */
const profilesCreate = vi.fn<(b: unknown) => Promise<{ id: string }>>(() =>
  Promise.resolve({ id: 'prof_new' }),
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
        create: (b: unknown) => profilesCreate(b),
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
  // `vpnStored` — whether the VPN row carries a serverId (is stored on the
  // account); the (l) #1 card arms flip it.
  // `vpn1Scheme` — (m) M5: the same row (same id/host/port) edited to SOCKS5
  // and back, as a customer's scheme-only edit does; a Refresh re-lists it.
  // (n) N11/N20: it also selects WHICH VPN fixture `vpn1` is — 'openvpn' or
  // 'wireguard' — so the parametrised describes at the foot of this file drive
  // the same surfaces with a real WireGuard row.
  // `storeRefused` — (V2 2026-09-12) the card's Check VPN now STORES an unstored
  // row before asking the test Mac (it used to return with "launch a session
  // once", which is why a VPN row could never be measured at all). So an
  // unstored row only keeps a not-tested notice when the STORE is refused; this
  // makes the account's create answer the tier 403 a Free account gets.
  state: {
    boundProxyId: 'vpn1',
    vpnStored: true,
    vpn1Scheme: 'openvpn',
    storeRefused: false,
  },
}));

/** The control plane's answer to a VPN create on a tier without `vpnEgress`,
 *  in the shape `lib/account-proxies` throws (status + problem detail). */
function tierRefusal(): Error {
  return Object.assign(new Error('proxy create failed: 403'), {
    status: 403,
    detail:
      'The "vpnEgress" feature is not available on the "free" tier. Upgrade to a tier that includes this feature.',
  });
}

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

// (n) N11 / N20 — the WireGuard twin of VPN_PROXY: the SAME row id, so every
// cache seed, binding and notice map in this file addresses it unchanged, with
// WireGuard's own endpoint (the `Endpoint` line's host:port) and config block.
// Its display host/port differ on purpose — an arm that asserts the resolve
// target has to read the fixture's own address, which is what catches a code
// path that hardcodes the OpenVPN one.
const WG_PROXY: ProxyConfig = {
  id: 'vpn1',
  label: 'wg-london',
  host: 'wg.example.com',
  port: 51820,
  username: null,
  password: null,
  createdAt: '2026-06-08T00:00:00Z',
  scheme: 'wireguard',
  serverId: 'aprx_vpn',
  wireguard: {
    private_key: 'yAnz5TF+lXXJte14tji3zlMNq+hd2rYUIgJBgB3fBmk=',
    peer_public_key: 'xTIBA5rboUvnH4htodjb6e697QjLERt1NAB4mZqp8Dg=',
    endpoint: 'wg.example.com:51820',
    allowed_ips: '0.0.0.0/0',
    address: '10.7.0.2/32',
  },
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
  listProxies: () => {
    // (n) N11/N20 — 'socks5' means "the VPN row edited to SOCKS5" (M5), so the
    // BASE fixture for that case is still the OpenVPN one, as before.
    const base = state.vpn1Scheme === 'wireguard' ? WG_PROXY : VPN_PROXY;
    const { serverId: _stored, ...unstoredVpn } = base;
    const vpn1 = state.vpnStored ? base : unstoredVpn;
    const { openvpn: _cfg, wireguard: _wg, ...asSocks5 } = { ...vpn1, scheme: 'socks5' as const };
    return Promise.resolve([state.vpn1Scheme === 'socks5' ? asSocks5 : vpn1, SOCKS5_PROXY]);
  },
  addProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  testProxy: (input: unknown) => testProxy(input),
  resolveEndpoint: (host: string, port: number) => resolveEndpoint(host, port),
  probeProxyExit: (input: unknown) => probeProxyExit(input),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  createProxy: vi.fn(() =>
    state.storeRefused ? Promise.reject(tierRefusal()) : Promise.resolve({ id: 'aprx_new' }),
  ),
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

const { ProfilesView, proxyConfigRefusalMessage } = await import('../../src/views/ProfilesView');

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
  profilesCreate.mockClear();
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
  state.vpnStored = true;
  state.vpn1Scheme = 'openvpn';
  state.storeRefused = false;
});

// ⛔ (V4 follow-up 2026-09-12) — WHO ASKED FOR THE TUNNEL TO COME UP.
//
// V2 made a VPN row's check STORE the row on the account (upload the .ovpn /
// WireGuard private key) and then bring the tunnel up on a fleet Mac. Two of the
// three callers of `handleTestProxy` are AUTOMATIC — the post-create auto-test
// and `onProxyMinted` in Edit Profile — and nothing on that path gates on
// scheme, so creating a profile on a VPN proxy did both with nobody pressing
// anything. The rule the same change wrote down for the background sweep
// ("pressing Check / Test on a row is that act; a 20-minute timer is not — it
// would ship a customer's VPN keys to the control plane with no act at all")
// applies verbatim to a profile create, which is not an act on the proxy either.
//
// And a `void`-ed 90s fleet probe left running while the modal closes is the
// exact collision `handleLaunch` refuses to cause, in its own words: "most VPN
// accounts allow one connection — the probe could break the launch."
//
// These arms drive the REAL create modal, so they measure the call graph rather
// than asserting about it.
// MUTATION: delete the `if (!userInitiated) return null;` guard in
// runFleetTestForRow (i.e. restore the behaviour V2 shipped) → arm 1 reds on
// createProxy AND on testAccountProxy; arm 3 (the CONTROL) stays green either
// way, which is what makes arm 1 a guard and not a coincidence.
describe('(V4) an AUTOMATIC probe of a VPN row neither stores it nor asks the test Mac', () => {
  async function createAProfile(): Promise<void> {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'New profile' }));
    fireEvent.change(await screen.findByPlaceholderText('my-recurring-workflow'), {
      target: { value: 'Auto Probe Profile' },
    });
    fireEvent.click(screen.getByRole('button', { name: /^Create profile$/ }));
    await waitFor(() => expect(profilesCreate).toHaveBeenCalledTimes(1));
  }

  it('CRITICAL creating a profile on a VPN proxy does the DNS pre-flight and STOPS — no account store, no fleet tunnel', async () => {
    state.vpnStored = false; // the unstored row: a store here would be the upload
    seedCache({});
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.createProxy).mockClear();
    vi.mocked(AccountProxies.updateProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    await createAProfile();
    // The pre-flight DID run — this arm is about what comes AFTER it, so a
    // guard that simply stopped probing would not pass.
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194));
    // …and nothing left this Mac.
    expect(vi.mocked(AccountProxies.createProxy)).not.toHaveBeenCalled();
    expect(vi.mocked(AccountProxies.updateProxy)).not.toHaveBeenCalled();
    expect(vi.mocked(AccountProxies.testAccountProxy)).not.toHaveBeenCalled();
    expect(testProxy).not.toHaveBeenCalled();
    // A check nobody asked for writes no notice either (the sweep's rule).
    expect(cardNotice()).toBeNull();
  });

  it('CRITICAL an ALREADY-STORED VPN row is not re-pushed or re-tested by an automatic probe either', async () => {
    // The consent argument covers the upload; this covers the other half — a
    // 90s tunnel bring-up on a fleet Mac, moments before the customer's Launch.
    state.vpnStored = true;
    seedCache({});
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.updateProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    await createAProfile();
    await waitFor(() => expect(resolveEndpoint).toHaveBeenCalled());
    expect(vi.mocked(AccountProxies.updateProxy)).not.toHaveBeenCalled();
    expect(vi.mocked(AccountProxies.testAccountProxy)).not.toHaveBeenCalled();
  });

  it('CONTROL — the customer pressing Check VPN on the same row DOES store it and DOES ask the test Mac', async () => {
    // Without this the arms above are satisfied by never testing at all.
    state.vpnStored = false;
    seedCache({});
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.createProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: true,
      latency_ms: 42,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() => expect(vi.mocked(AccountProxies.createProxy)).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(vi.mocked(AccountProxies.testAccountProxy)).toHaveBeenCalledTimes(1),
    );
  });

  it('VACUITY CONTROL — a SOCKS5 proxy is unchanged: the automatic probe still runs its native handshake', async () => {
    // The gate is scoped to the VPN fleet step, not to auto-probing. A SOCKS5
    // row's auto-probe is a local handshake — no upload, no fleet Mac — and it
    // must still happen, or "auto-check after creating a profile" is broken for
    // the whole SOCKS5 population.
    state.vpn1Scheme = 'socks5';
    seedCache({});
    await createAProfile();
    await waitFor(() => expect(testProxy).toHaveBeenCalled());
  });
});

// ⛔ (V4 follow-up) — a REFUSED re-sync of an already-stored row was swallowed.
//
// `runFleetTestForRow` refreshes the account row first, so the tunnel the fleet
// brings up is the config THIS Mac holds. When that PUT threw and the row was
// already stored, nothing was said and the check went on to measure the
// PREVIOUSLY STORED config — and the comment justified the silence with "an
// unedited row already matches", which is false for exactly the population this
// item serves: `accountProxyInputFor` heals a legacy OpenVPN blob and
// `persistHealedOpenvpn` writes the healed copy LOCALLY before the wire.
// MUTATION: drop the `staleStoredConfig` branch → the notice arm reds while the
// measurement arm stays green, which is the whole point (the number is real; it
// describes a different config).
describe('(V4) a stored VPN row whose config could not be re-pushed says which config the result describes', () => {
  it('CRITICAL the PUT fails, the tunnel is still measured, and the card says the result is of the config stored earlier', async () => {
    state.vpnStored = true;
    seedCache({});
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.updateProxy).mockClear();
    vi.mocked(AccountProxies.updateProxy).mockRejectedValueOnce(
      Object.assign(new Error('proxy update failed: 503'), { status: 503 }),
    );
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: true,
      latency_ms: 77,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    // The measurement still happened — against the STORED row.
    await waitFor(() =>
      expect(vi.mocked(AccountProxies.testAccountProxy)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'aprx_vpn',
        { vantage: 'fleet' },
      ),
    );
    expect(await screen.findByText('77ms')).toBeTruthy();
    // …and the customer is told which configuration it describes.
    await waitFor(() => expect(cardNotice()).toBe(VPN_STALE_CONFIG_CHECK_NOTICE));
    // A notice, not the red banner: nothing failed.
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
  });

  it('VACUITY CONTROL — a re-push that SUCCEEDS leaves no notice', async () => {
    state.vpnStored = true;
    seedCache({});
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: true,
      latency_ms: 77,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    expect(await screen.findByText('77ms')).toBeTruthy();
    expect(cardNotice()).toBeNull();
  });

  // (q) 13(d) had no arm on THIS surface — making the refresh conditional
  // (`if (serverId === undefined) …`) reds nothing today. This is that arm.
  it('CRITICAL the account row is re-pushed BEFORE the test Mac is asked (the tunnel is this Mac’s config)', async () => {
    state.vpnStored = true;
    seedCache({});
    const order: string[] = [];
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.updateProxy).mockClear();
    vi.mocked(AccountProxies.updateProxy).mockImplementation((_b, _k, id) => {
      order.push('put');
      return Promise.resolve({ id } as never);
    });
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockImplementation(() => {
      order.push('test');
      return Promise.resolve({ ok: true, latency_ms: 5, measured_from: 'fleet' } as never);
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() => expect(order).toEqual(['put', 'test']));
  });
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
  it('CRITICAL Check VPN → resolveEndpoint, never proxy_test', async () => {
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/^Check VPN/));
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
  it('CRITICAL Check VPN → resolveEndpoint, then testAccountProxy(vantage fleet) for the stored row', async () => {
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/^Check VPN/));
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
    fireEvent.click(await screen.findByLabelText(/^Check VPN/));
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

// (h) VPN surfaces audit — findings 2, 5, 11, 16, 20, 27: the card carries the
// fleet's verdict, a stale VPN exit is not handed to the launch, and the UDP
// chip / menu row describe a tunnel.
const ENDPOINT_PLACEHOLDER = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'Resolved',
};
const FLEET_DOWN = 'The Mac that runs your profiles could not bring this tunnel up.';
const BUSY =
  'The Mac that runs your profiles is busy with another tunnel or test. Try again in a minute.';
/** A VPN entry the fleet measured `ageMs` ago: resolved pre-flight (same
 *  address the mock resolves to, so the carry-over applies) + fleet latency +
 *  an observed exit. */
function measuredVpnEntry(ageMs: number): Record<string, unknown> {
  const at = Date.now() - ageMs;
  return {
    result: ENDPOINT_PLACEHOLDER,
    at,
    endpoint: { resolved: true, ip: '203.0.113.9', message: 'Resolved' },
    serverLatencyMs: 42,
    measuredFrom: 'fleet',
    nodeId: 'mac-07',
    quicProbe: true,
    serverProbeAt: at,
    exitIp: '198.51.100.9',
    exitCountry: 'NL',
    exitTimezone: 'Europe/Amsterdam',
    exitAt: at,
  };
}
async function clickCheckVpn(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  fireEvent.click(await screen.findByLabelText(/^Check VPN/));
}

describe('(h) — the profile card carries the VPN fleet outcome', () => {
  it('CRITICAL a fleet FAILURE shows the VPN broken banner with the fleet’s sentence and drops the exit + latency it showed', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: false,
      reason: FLEET_DOWN,
      measured_from: 'fleet',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByTitle(/198\.51\.100\.9/)).toBeTruthy();
    expect(screen.getByText('42ms')).toBeTruthy();
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
    await clickCheckVpn();
    await waitFor(() =>
      expect(
        document.querySelector('[data-component="proxy-broken-banner"][data-vpn-failure="true"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText('VPN tunnel down')).toBeTruthy();
    expect(document.querySelector('[data-component="proxy-vpn-failure"]')?.textContent).toBe(
      FLEET_DOWN,
    );
    expect(screen.queryByTitle(/198\.51\.100\.9/)).toBeNull();
    expect(screen.queryByText('42ms')).toBeNull();
    // Written, and superseding the exit (the list adoption respects the stamp).
    await waitFor(() => expect(storedProbe('vpn1')?.exitSupersededAt).toEqual(expect.any(Number)));
    expect(storedProbe('vpn1')?.exitIp).toBeUndefined();
    expect(storedProbe('vpn1')?.serverLatencyMs).toBeUndefined();
    // The banner's action is the VPN check, not a SOCKS5 retest.
    expect(screen.getByText('Re-check')).toBeTruthy();
  });

  it('CRITICAL a NOT-RUN keeps the card’s exit and latency and shows the sentence as a muted notice, never the banner', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: false,
      reason: BUSY,
      measured_from: 'fleet',
      not_run: 'node_busy',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByTitle(/198\.51\.100\.9/)).toBeTruthy();
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(BUSY),
    );
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
    expect(screen.getByTitle(/198\.51\.100\.9/)).toBeTruthy();
    expect(screen.getByText('42ms')).toBeTruthy();
    expect(storedProbe('vpn1')?.serverLatencyMs).toBe(42);
    expect(storedProbe('vpn1')?.exitIp).toBe('198.51.100.9');
  });

  it('CONTROL — the next fleet ok clears both', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy)
      .mockResolvedValueOnce({ ok: false, reason: FLEET_DOWN, measured_from: 'fleet' })
      .mockResolvedValueOnce({
        ok: true,
        latency_ms: 31,
        measured_from: 'fleet',
        node_id: 'mac-07',
      });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-broken-banner"]')).not.toBeNull(),
    );
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull(),
    );
    expect(await screen.findByText('31ms')).toBeTruthy();
  });

  it('a VPN card renders NO UDP chip — "UDP via tunnel" and its sentence ride in the caps "+N" title (Phase B); an unprobed SOCKS5 card offers Test and no UDP chip at all', async () => {
    // Phase B (2026-09-11): the caps row is a fixed 20px line of MEASUREMENTS.
    // UDP on a tunnel is not a measurement, so it is a hint behind '+N', never
    // a chip; and 'UDP ?' (an unprobed SOCKS5 grant) no longer exists — that
    // row's caps region is the first-measurement 'Test' button.
    const first = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const overflow = await waitFor(() => {
      const el = document.querySelector('[data-component="caps-overflow"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(overflow.getAttribute('title')).toMatch(/UDP via tunnel/);
    expect(overflow.getAttribute('title')).toMatch(/not a probed grant/);
    expect(document.querySelector('[data-udp]')).toBeNull();
    expect(screen.queryByText('UDP ?')).toBeNull();
    first.unmount();
    state.boundProxyId = 'p1';
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByRole('button', { name: 'Test' })).toBeTruthy();
    expect(screen.queryByText('UDP ?')).toBeNull();
    expect(document.querySelector('[data-udp="tunnel"]')).toBeNull();
    // A SOCKS5 row's "+N" (the OS-not-measured hint) never carries the tunnel sentence.
    expect(
      document.querySelector('[data-component="caps-overflow"]')?.getAttribute('title') ?? '',
    ).not.toMatch(/UDP via tunnel/);
  });
});

describe('(o) — the card and the list say what the Proxies grid says for the same cache entry', () => {
  it('CRITICAL an endpoint that does NOT resolve is a red "unresolved" pill (the resolver’s message as title) with Re-check + Change — never "not measured" + a Check VPN that cannot bring the tunnel up', async () => {
    // Call site ProfilesView.tsx `endpoint={… probeView.endpointResults[px.id] …}`:
    // dropping that prop makes the card fall to pill arm 7 ('not measured',
    // title "No exit measured yet. Run Check VPN…") and caps mode C ('Check
    // VPN') for this exact cache write → reds every arm below.
    seedCache({ vpn1: measuredVpnEntry(5000) });
    resolveEndpoint.mockResolvedValue({ resolved: false, ip: '', message: 'DNS lookup failed' });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByTitle(/198\.51\.100\.9/)).toBeTruthy();
    expect(screen.getByText('42ms')).toBeTruthy();
    await clickCheckVpn();
    const pill = await waitFor(() => {
      const el = document.querySelector('[data-component="health-pill"][data-health="broken"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(pill.textContent).toBe('unresolved');
    expect(pill.getAttribute('title')).toBe('DNS lookup failed');
    expect(document.body.textContent).not.toMatch(/not measured/);
    expect(document.body.textContent).not.toMatch(/untested/);
    // The exit and number the pre-flight dropped are gone from the tile too.
    expect(screen.queryByTitle(/198\.51\.100\.9/)).toBeNull();
    expect(screen.queryByText('42ms')).toBeNull();
    // Repair, not first measurement: Re-check + Change; no 'Check VPN' button.
    const banner = document.querySelector('[data-component="proxy-broken-banner"]');
    expect(banner?.getAttribute('data-vpn-failure')).toBe('false');
    expect(banner?.querySelector('[data-action="retest-proxy"]')?.textContent).toBe('Re-check');
    expect(banner?.querySelector('[data-action="change-proxy"]')?.textContent).toBe('Change');
    expect(screen.queryByRole('button', { name: 'Check VPN' })).toBeNull();
    // The exit line does not promise that Check VPN will bring a tunnel up.
    const exit = document.querySelector('[data-region="exit"]') as HTMLElement;
    expect(exit.textContent).toContain('no exit measured yet');
    expect(exit.querySelector('[title]')?.getAttribute('title')).toMatch(/did not resolve/);
    expect(exit.querySelector('[title*="bring the tunnel up"]')).toBeNull();
    // The write the tile reads.
    expect(storedProbe('vpn1')?.endpoint).toEqual({
      resolved: false,
      ip: '',
      message: 'DNS lookup failed',
    });
  });

  it('CRITICAL a tunnel the test Mac brought up with an exit but NO number reads "tunnel up" (the grid’s green pill), caps mode A — not "not measured" over a Check VPN button', async () => {
    // healthPill arm 6b + capsMode's `tunnelUpNoLatency` clause, through the
    // real derivation (serverVantage is set only for a usable endpoint row):
    // deleting either reds this.
    const { serverLatencyMs: _none, ...noNumber } = measuredVpnEntry(5000);
    seedCache({ vpn1: noNumber });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByTitle(/198\.51\.100\.9/)).toBeTruthy();
    const pill = document.querySelector('[data-component="health-pill"]') as HTMLElement;
    expect(pill.textContent).toBe('tunnel up');
    expect(pill.getAttribute('data-health')).toBe('ok');
    expect(pill.getAttribute('data-latency-vantage')).toBe('fleet');
    expect(pill.getAttribute('title')).toBe(
      'The test Mac brought this tunnel up and measured through it, but reported no latency.',
    );
    expect(document.body.textContent).not.toMatch(/not measured/);
    expect(document.querySelector('[data-region="caps"]')?.getAttribute('data-caps-mode')).toBe(
      'measured',
    );
    expect(screen.queryByRole('button', { name: 'Check VPN' })).toBeNull();
    // What that reply measured is on the row: the relay probe's QUIC chip.
    expect(
      document.querySelector('[data-region="caps"] [data-quic-inferred="false"]')?.textContent,
    ).toBe('QUIC ✓');
  });

  it('the LIST row’s exit cell reads "unresolved" (message as title) for the same entry, not "no exit measured yet — run Check VPN"; the grid card on mount reads the cached pre-flight too', async () => {
    // ProfilesView list mapping `endpointUnresolved:` + ProfilesTable's
    // `profile-row-endpoint-unresolved` span: dropping either restores the
    // VPN_NO_EXIT_YET cell → reds the list arm. The grid arm reds when the
    // call site's `endpoint=` prop is dropped (mount path, no click).
    seedCache({
      vpn1: {
        result: ENDPOINT_PLACEHOLDER,
        at: Date.now() - 5000,
        endpoint: { resolved: false, ip: '', message: 'DNS lookup failed' },
      },
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const pill = await waitFor(() => {
      const el = document.querySelector('[data-component="health-pill"]');
      expect(el?.textContent).toBe('unresolved');
      return el as HTMLElement;
    });
    expect(pill.getAttribute('title')).toBe('DNS lookup failed');
    fireEvent.click(await screen.findByRole('button', { name: '☰ List' }));
    await screen.findByRole('table');
    const cell = await waitFor(() => {
      const el = document.querySelector('[data-component="profile-row-endpoint-unresolved"]');
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    expect(cell.textContent).toBe('unresolved');
    expect(cell.getAttribute('title')).toBe('DNS lookup failed');
    expect(document.body.textContent).not.toMatch(/no exit measured yet/);
    expect(document.body.textContent).not.toMatch(/no exit IP/);
  });
});

describe('(h) — a VPN launch never hands a STALE cached exit to the simulator', () => {
  const THIRTY_ONE_MIN = 31 * 60 * 1000;

  // MUTATION: drop the VPN branch of freshExitIdentity (back to `return
  // fromCache`) → the 31-minute-old NL/Amsterdam reaches the simulator → red.
  it('CRITICAL an exit older than the SOCKS5 TTL is not handed over as timezone/country (the session reports its own)', async () => {
    seedCache({ vpn1: measuredVpnEntry(THIRTY_ONE_MIN) });
    await launch();
    await waitFor(() => expect(openSimulatorWindow).toHaveBeenCalledTimes(1));
    expect(openSimulatorWindow.mock.calls[0]?.[0]).toMatchObject({
      countryCode: null,
      timezone: null,
    });
    // …and it is NOT re-probed either: the exit probe is a SOCKS5 request.
    expect(probeProxyExit).not.toHaveBeenCalled();
  });

  it('VACUITY CONTROL — a fresh VPN exit is handed over as cached', async () => {
    seedCache({ vpn1: measuredVpnEntry(1000) });
    await launch();
    await waitFor(() => expect(openSimulatorWindow).toHaveBeenCalledTimes(1));
    expect(openSimulatorWindow.mock.calls[0]?.[0]).toMatchObject({
      countryCode: 'NL',
      timezone: 'Europe/Amsterdam',
    });
    expect(probeProxyExit).not.toHaveBeenCalled();
  });
});

// (h) findings 3 / 4 / 5 — the card's "fleet down" state was carried only by
// the view that ran the check (a grid Check that failed left this card with no
// banner, "no exit IP" and a pre-flight "checked"); a stale outcome outlived
// the next card Test when that Test returned early; and the "checked" stamp
// the parent computed from the fleet result was a prop the card never
// rendered.
// Phase B: the "checked" stamp is `data-checked-at` on the checked span, or on
// the VPN failure/notice line when that line takes the whole "when" row.
const checkedAt = (): string | null =>
  document.querySelector('[data-checked-at]')?.getAttribute('data-checked-at') ?? null;

describe('(h) findings 3/4/5 — the card reads the failure from the cache, clears a stale notice, and dates "checked"', () => {
  // MUTATION: drop `fleetFailureReasons` from the card's props (back to the
  // in-memory vpnOutcomes) → no banner for a failure this card did not run → red.
  it('CRITICAL a failure the Proxies GRID wrote (the stamp + sentence, no exit) renders the banner HERE with the sentence, no exit, and "checked" dated at the failure', async () => {
    const failedAt = Date.now() - 90_000;
    seedCache({
      vpn1: {
        result: ENDPOINT_PLACEHOLDER,
        at: failedAt - 5,
        endpoint: { resolved: true, ip: '203.0.113.9', message: 'Resolved' },
        exitSupersededAt: failedAt,
        fleetFailureReason: FLEET_DOWN,
      },
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() =>
      expect(
        document.querySelector('[data-component="proxy-broken-banner"][data-vpn-failure="true"]'),
      ).not.toBeNull(),
    );
    expect(screen.getByText('VPN tunnel down')).toBeTruthy();
    expect(document.querySelector('[data-component="proxy-vpn-failure"]')?.textContent).toBe(
      FLEET_DOWN,
    );
    expect(screen.queryByTitle(/198\.51\.100\.9/)).toBeNull();
    // (l) #3 — a VPN card with no exit says why and names the check, never the
    // dead-end "no exit IP". Phase B: the card's fixed 18px exit line shows the
    // SHORT clause and carries the grid's full sentence as its title.
    expect(screen.getByText('no exit measured yet').getAttribute('title')).toBe(
      VPN_NO_EXIT_YET_TITLE,
    );
    expect(checkedAt()).toBe(new Date(failedAt).toISOString());
  });

  it('CRITICAL after a fleet failure, a card Test whose DNS pre-flight FAILS clears the banner — it is not carried beside an unresolved endpoint', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: false,
      reason: FLEET_DOWN,
      measured_from: 'fleet',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByTitle(/198\.51\.100\.9/)).toBeTruthy();
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-broken-banner"]')).not.toBeNull(),
    );
    resolveEndpoint.mockResolvedValue({
      resolved: false,
      ip: '',
      message: 'The endpoint host could not be resolved.',
    });
    // The mock is module-level (not reset per test), so count the delta.
    const fleetCalls = vi.mocked(AccountProxies.testAccountProxy).mock.calls.length;
    await clickCheckVpn();
    // (o) — the TUNNEL-DOWN banner goes; what stays in the repair row is the
    // unresolved endpoint's own (data-vpn-failure="false", pill 'unresolved'),
    // never the fleet's sentence.
    await waitFor(() =>
      expect(
        document.querySelector('[data-component="proxy-broken-banner"][data-vpn-failure="true"]'),
      ).toBeNull(),
    );
    expect(document.querySelector('[data-component="proxy-vpn-failure"]')).toBeNull();
    expect(screen.queryByText('VPN tunnel down')).toBeNull();
    expect(document.querySelector('[data-component="health-pill"]')?.textContent).toBe(
      'unresolved',
    );
    expect(storedProbe('vpn1')?.fleetFailureReason).toBeUndefined();
    expect(storedProbe('vpn1')?.exitSupersededAt).toBeUndefined();
    // The fleet was never asked the second time: the pre-flight answered.
    expect(vi.mocked(AccountProxies.testAccountProxy).mock.calls.length).toBe(fleetCalls);
  });

  // MUTATION: drop the setVpnNotices clear at the top of handleTestProxy's VPN
  // path → the previous notice is still rendered after the unresolved Test → red.
  it('CRITICAL a stale NOT-RUN notice goes the moment the next Test starts, even when the fleet is never asked again', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: false,
      reason: BUSY,
      measured_from: 'fleet',
      not_run: 'node_busy',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(BUSY),
    );
    resolveEndpoint.mockResolvedValue({
      resolved: false,
      ip: '',
      message: 'The endpoint host could not be resolved.',
    });
    const fleetCalls = vi.mocked(AccountProxies.testAccountProxy).mock.calls.length;
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')).toBeNull(),
    );
    expect(vi.mocked(AccountProxies.testAccountProxy).mock.calls.length).toBe(fleetCalls);
  });

  // MUTATION: revert the parent's checkedAtIso to `probe?.at` → the fresh
  // pre-flight's time renders instead of the hour-old fleet stamp → red.
  it('CRITICAL "checked" dates the fleet result, not the pre-flight: an hour-old fleet number beside a fresh pre-flight reads an hour old', async () => {
    const now = Date.now();
    const fleetAt = now - 3_600_000;
    seedCache({
      vpn1: {
        ...measuredVpnEntry(0),
        at: now, // the pre-flight, re-stamped seconds ago
        serverProbeAt: fleetAt, // the fleet's answer, an hour ago
        exitAt: fleetAt,
      },
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByText('42ms')).toBeTruthy();
    expect(checkedAt()).toBe(new Date(fleetAt).toISOString());
    expect(checkedAt()).not.toBe(new Date(now).toISOString());
  });

  it('VACUITY CONTROL — a SOCKS5 card’s "checked" is the probe’s own stamp', async () => {
    state.boundProxyId = 'p1';
    const at = Date.now() - 120_000;
    seedCache({ p1: { result: HEALTHY, at } });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(checkedAt()).toBe(new Date(at).toISOString()));
  });
});

// (j) J2 — the card's `unavailable` branch (I5). A card Test whose fleet request
// the server does not answer (the transport threw: network, auth, a malformed
// body) measured nothing: the shared step wrote nothing, so the latency, exit
// and any failure banner the card holds STAND, and the card says why THIS check
// measured nothing — as a notice in muted ink, transient like every other. The
// branch was unguarded: the grid's arm (a-refused-vpn-probe…) exercised
// ProxiesView only, and this card has its own copy of the decision.
describe('(j) J2 — a card Test the server does not answer leaves the I5 notice beside the standing measurement', () => {
  // MUTATION: drop the `unavailable` arm in runFleetTestForRow (or route it to
  // the not_run arm) → no notice / the wrong one → red.
  it('CRITICAL testAccountProxy rejects → SERVER_DID_NOT_ANSWER_NOTICE on the card in muted ink; latency + exit stand, no banner, the cache keeps the fleet fields', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockRejectedValueOnce(new Error('offline'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByText('42ms')).toBeTruthy();
    expect(document.querySelector('[data-component="proxy-vpn-notice"]')).toBeNull();
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(
        SERVER_DID_NOT_ANSWER_NOTICE,
      ),
    );
    const notice = document.querySelector('[data-component="proxy-vpn-notice"]');
    expect(notice?.className).toContain('text-ink-muted');
    expect(notice?.className).not.toContain('text-status-error');
    // Nothing was learned, so nothing moved: the measurement the card showed
    // before the check is the measurement it shows after it.
    expect(screen.getByText('42ms')).toBeTruthy();
    expect(screen.getByTitle(/198\.51\.100\.9/)).toBeTruthy();
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
    expect(document.querySelector('[data-component="proxy-vpn-failure"]')).toBeNull();
    expect(storedProbe('vpn1')?.serverLatencyMs).toBe(42);
    expect(storedProbe('vpn1')?.exitIp).toBe('198.51.100.9');
    expect(storedProbe('vpn1')?.fleetFailureReason).toBeUndefined();
    expect(storedProbe('vpn1')?.exitSupersededAt).toBeUndefined();
  });

  // (j) J3 on the card — the arm above resolves the SAME address the seed
  // holds (203.0.113.9), so the pre-flight write carried the fleet fields over
  // and "the last verdict stands" was true. When the pre-flight resolves a
  // DIFFERENT address, `saveEndpointResult` drops serverLatencyMs / exit (the
  // old address's measurement says nothing about the new one) BEFORE the
  // fleet is asked — so an unanswered check has no verdict to stand, and the
  // card must say what the grid says for the same cache state.
  // MUTATION: drop `endpointMoved` from the card's notice pick → the
  // standing-verdict sentence renders beside a card whose 42ms and exit just
  // vanished → red.
  it('CRITICAL after the endpoint MOVES, an unanswered card check says "Endpoint moved; no verdict yet" — never that the last verdict stands (it is gone)', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) }); // endpoint 203.0.113.9, fleet 42ms, exit 198.51.100.9
    resolveEndpoint.mockResolvedValueOnce({
      resolved: true,
      ip: '203.0.113.10',
      message: 'Resolved',
    });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockRejectedValueOnce(new Error('offline'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByText('42ms')).toBeTruthy();
    expect(screen.getByTitle(/198\.51\.100\.9/)).toBeTruthy();
    await clickCheckVpn();
    // Pinned as the literal the grid's arm pins (a-refused-vpn-probe…), so the
    // two surfaces cannot drift apart behind one renamed constant.
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(
        'The server did not answer, so the tunnel was not tested. Endpoint moved; no result yet — try again.',
      ),
    );
    expect(ENDPOINT_MOVED_NO_VERDICT_NOTICE).toBe(
      'The server did not answer, so the tunnel was not tested. Endpoint moved; no result yet — try again.',
    );
    const notice = document.querySelector('[data-component="proxy-vpn-notice"]');
    expect(notice?.className).toContain('text-ink-muted');
    expect(notice?.className).not.toContain('text-status-error');
    expect(screen.queryByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeNull();
    // The verdict really is gone — the notice describes the card it sits on.
    expect(screen.queryByText('42ms')).toBeNull();
    expect(screen.queryByTitle(/198\.51\.100\.9/)).toBeNull();
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
    expect(document.querySelector('[data-component="proxy-vpn-failure"]')).toBeNull();
    expect(storedProbe('vpn1')?.endpoint).toEqual({
      resolved: true,
      ip: '203.0.113.10',
      message: 'Resolved',
    });
    expect(storedProbe('vpn1')?.serverLatencyMs).toBeUndefined();
    expect(storedProbe('vpn1')?.exitIp).toBeUndefined();
    // The fleet WAS asked (the pre-flight resolved); it just did not answer.
    expect(vi.mocked(AccountProxies.testAccountProxy)).toHaveBeenCalled();
  });

  // The same-address arm above is this arm's CONTROL: SERVER_DID_NOT_ANSWER_NOTICE
  // with 42ms + exit standing — the pick is on the address, not on the check.
  // MUTATION: make the card read `endpointMoved` from the UNRESOLVED branch
  // too (`priorEndpoint.ip !== res.ip` without `res.resolved`) → the seeded
  // entry below has no prior address to move FROM, so nothing changes here;
  // the arm above is what catches a pick that ignores `resolved`.
  // (k) K2 — this card's prior pre-flight did NOT resolve, so its write carried
  // nothing over: there is no verdict to stand, and the notice must not say
  // one does (that sentence was FALSE here until K2). Still "nothing moved":
  // a first-ever address is not a moved one.
  it('CONTROL — a first-ever pre-flight (prior UNRESOLVED) that the server then does not answer says "no verdict yet" — not "moved" (nothing moved), not that the last verdict stands (there is none)', async () => {
    seedCache({
      vpn1: {
        result: ENDPOINT_PLACEHOLDER,
        at: Date.now() - 5000,
        endpoint: { resolved: false, ip: '', message: 'The endpoint host could not be resolved.' },
      },
    });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockRejectedValueOnce(new Error('offline'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(
        NO_VERDICT_YET_NOTICE,
      ),
    );
    expect(NO_VERDICT_YET_NOTICE).toBe('The server did not answer; no result yet — try again.');
    const notice = document.querySelector('[data-component="proxy-vpn-notice"]');
    expect(notice?.className).toContain('text-ink-muted');
    expect(screen.queryByText(/Endpoint moved/)).toBeNull();
    expect(screen.queryByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeNull();
    expect(storedProbe('vpn1')?.endpoint).toEqual({
      resolved: true,
      ip: '203.0.113.9',
      message: 'Resolved',
    });
  });

  // (k) K2 on the card — the same pick from the same prior, for a card with NO
  // entry at all (first check on this Mac). MUTATION: make the card pass the
  // (j) two-way pick to runFleetTestForRow → "the last verdict stands" renders
  // on a card that never held one → red.
  it('CRITICAL a card with NO cache entry (first check on this Mac) the server does not answer says "no verdict yet"', async () => {
    seedCache({});
    expect(storedProbe('vpn1')).toBeUndefined();
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockRejectedValueOnce(new Error('offline'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(
        NO_VERDICT_YET_NOTICE,
      ),
    );
    expect(screen.queryByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeNull();
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
    expect(document.querySelector('[data-component="proxy-vpn-failure"]')).toBeNull();
    expect(storedProbe('vpn1')?.endpoint).toEqual({
      resolved: true,
      ip: '203.0.113.9',
      message: 'Resolved',
    });
    expect(storedProbe('vpn1')?.serverLatencyMs).toBeUndefined();
    expect(vi.mocked(AccountProxies.testAccountProxy)).toHaveBeenCalled();
  });

  it('CONTROL — the card holding a fleet measurement keeps "the last verdict stands" (the K2 pick is on the prior, not on the check)', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockRejectedValueOnce(new Error('offline'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByText('42ms')).toBeTruthy();
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(
        SERVER_DID_NOT_ANSWER_NOTICE,
      ),
    );
    expect(screen.queryByText(NO_VERDICT_YET_NOTICE)).toBeNull();
    expect(screen.getByText('42ms')).toBeTruthy();
  });

  it('CONTROL — the notice is transient: the next check that answers (a not_run) replaces it with the fleet’s own sentence', async () => {
    seedCache({ vpn1: measuredVpnEntry(5000) });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockRejectedValueOnce(new Error('offline'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(
        SERVER_DID_NOT_ANSWER_NOTICE,
      ),
    );
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: false,
      reason: BUSY,
      measured_from: 'fleet',
      not_run: 'node_busy',
    });
    await clickCheckVpn();
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(BUSY),
    );
    expect(screen.queryByText(SERVER_DID_NOT_ANSWER_NOTICE)).toBeNull();
  });

  it('VACUITY CONTROL — a standing FAILURE banner survives the unanswered check too (the notice sits beside it, the sentence stays red)', async () => {
    const failedAt = Date.now() - 90_000;
    seedCache({
      vpn1: {
        result: ENDPOINT_PLACEHOLDER,
        at: failedAt - 5,
        endpoint: { resolved: true, ip: '203.0.113.9', message: 'Resolved' },
        exitSupersededAt: failedAt,
        fleetFailureReason: FLEET_DOWN,
      },
    });
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockRejectedValueOnce(new Error('offline'));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() =>
      expect(document.querySelector('[data-component="proxy-broken-banner"]')).not.toBeNull(),
    );
    await clickCheckVpn();
    // Phase B: the card's ONE "when" line shows the standing failure; the
    // notice about THIS check rides in that line's title (and the pill's).
    await waitFor(() =>
      expect(
        document.querySelector('[data-component="proxy-vpn-failure"]')?.getAttribute('title'),
      ).toContain(SERVER_DID_NOT_ANSWER_NOTICE),
    );
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).not.toBeNull();
    expect(document.querySelector('[data-component="proxy-vpn-failure"]')?.textContent).toBe(
      FLEET_DOWN,
    );
    expect(document.querySelector('[data-component="health-pill"]')?.getAttribute('title')).toBe(
      `${FLEET_DOWN} — ${SERVER_DID_NOT_ANSWER_NOTICE}`,
    );
    expect(storedProbe('vpn1')?.fleetFailureReason).toBe(FLEET_DOWN);
    expect(storedProbe('vpn1')?.exitSupersededAt).toBe(failedAt);
  });
});

// (l) SOCKS5/chat audit — findings #1 / #9 on the CARD (review of the batch).
//
// The grid's Check VPN leaves a notice when the test Mac cannot be asked (not
// stored on the account / no API key); the card's Check VPN ran the same gate
// in runFleetTestForRow and returned SILENTLY — so for one proxy in one state
// the grid said why and the card showed "checked just now" + "no exit measured
// yet — run Check VPN", sending the customer round the loop the audit named.
// The notices are the grid's own constants (lib/proxy-check-copy).
import {
  VPN_NO_API_KEY_CHECK_NOTICE,
  VPN_NO_EXIT_YET_TITLE,
  VPN_NOT_STORED_CHECK_NOTICE,
  VPN_PLAN_EXCLUDED_CHECK_NOTICE,
  VPN_STALE_CONFIG_CHECK_NOTICE,
} from '../../src/lib/proxy-check-copy';

// Polish (2026-09-11): the notice ROW shows the next-step clause ('not stored
// yet — launch once') and carries the full sentence as its title, followed by
// the facts it displaced (' · Last used … · Checked …'). The sentence — what
// this suite pins against the grid's constants — is the title's first part.
const cardNotice = (): string | null => {
  const el = document.querySelector('[data-component="proxy-vpn-notice"]');
  if (el === null) return null;
  return (el.getAttribute('title') ?? '').split(' · ')[0] ?? null;
};

describe('(l) #1 / #9 — the card’s Check VPN says why the tunnel was not tested', () => {
  // (V2 2026-09-12, owner: "openvpn … nothing of IP, quic, udp, nothing
  // showing … and session not starting still") — THE ROW IS STORED HERE NOW.
  //
  // ⛔ This arm used to pin the opposite ("the fleet is never asked"), and that
  // was the defect: NOTHING on a VPN path ever set `serverId`
  // (`ensureAccountProxyRow` has one create call site in the app, reached only
  // by the two launches and the SOCKS5 Test arms), so the only thing that could
  // store a VPN row was a launch — and the launch is the half of the owner's
  // report that fails. The card told the customer to launch a session to get a
  // measurement, and the measurement was the only way to explain why the launch
  // would not run. The SOCKS5 arms 40 lines away in the same file have stored
  // the row since (q) 12-memory (A); the VPN arms were left behind.
  //
  // MUTATION: restore `if (px.serverId === undefined) { …notice; return null; }`
  // in runFleetTestForRow → createProxy is never called, testAccountProxy is
  // never called → red on both expectations below.
  it('CRITICAL not stored on the account: the card STORES the row, then asks the test Mac — no dead-end notice', async () => {
    state.vpnStored = false;
    seedCache({});
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    vi.mocked(AccountProxies.createProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: true,
      latency_ms: 42,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    expect(resolveEndpoint).toHaveBeenCalledWith('vpn.example.com', 1194);
    await waitFor(() => expect(vi.mocked(AccountProxies.createProxy)).toHaveBeenCalledTimes(1));
    // …and the tunnel is tested through the row it just created.
    await waitFor(() =>
      expect(vi.mocked(AccountProxies.testAccountProxy)).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        'aprx_new',
        { vantage: 'fleet' },
      ),
    );
    expect(testProxy).not.toHaveBeenCalled(); // never the SOCKS5 handshake (T-20)
    expect(await screen.findByText('42ms')).toBeTruthy();
    expect(cardNotice()).toBeNull();
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
  });

  // MUTATION: return the generic `VPN_NOT_STORED_CHECK_NOTICE` on a refused
  // store ("launch a session once") → red: that instruction is the loop, and a
  // launch on this tier is refused by the same 403.
  it('CRITICAL the store REFUSED (tier 403): the card names the plan, and the test Mac is never asked', async () => {
    state.vpnStored = false;
    state.storeRefused = true;
    seedCache({});
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() => expect(cardNotice()).toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE));
    expect(vi.mocked(AccountProxies.testAccountProxy)).not.toHaveBeenCalled();
    expect(testProxy).not.toHaveBeenCalled();
    // The server's own sentence names an internal flag (`vpnEgress`) and is
    // never reflected; ours says what the customer can do about it.
    expect(cardNotice()).not.toContain('vpnEgress');
    // A notice, never the red banner: nothing was tested, so nothing failed.
    expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.className).toContain(
      'text-ink-muted',
    );
    expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
    // The exit cell still names the check — beside the reason it did not run.
    // (Phase B: the SHORT clause on the line, the full sentence in its title.)
    expect(screen.getByText('no exit measured yet').getAttribute('title')).toBe(
      VPN_NO_EXIT_YET_TITLE,
    );
  });

  // MUTATION: restore the silent `return null` for a missing key → red.
  it('CRITICAL no API key: the card carries the ONE Settings next step, and the fleet is never asked', async () => {
    seedCache({});
    const Settings = await import('../../src/lib/SettingsContext');
    const live = Settings.useSettings().settings as { apiKey: string | null };
    live.apiKey = null;
    try {
      const AccountProxies = await import('../../src/lib/account-proxies');
      vi.mocked(AccountProxies.testAccountProxy).mockClear();
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      await clickCheckVpn();
      await waitFor(() => expect(cardNotice()).toBe(VPN_NO_API_KEY_CHECK_NOTICE));
      expect(vi.mocked(AccountProxies.testAccountProxy)).not.toHaveBeenCalled();
    } finally {
      live.apiKey = 'ds_test_x';
    }
  });

  // MUTATION: swap the two gates (not-stored first) → a keyless customer is
  // told to store the proxy, which a launch without a key never does → red.
  it('CRITICAL no API key AND not stored: the KEY is the blocker named, on the card as on the grid', async () => {
    state.vpnStored = false;
    seedCache({});
    const Settings = await import('../../src/lib/SettingsContext');
    const live = Settings.useSettings().settings as { apiKey: string | null };
    live.apiKey = null;
    try {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      await clickCheckVpn();
      await waitFor(() => expect(cardNotice()).toBe(VPN_NO_API_KEY_CHECK_NOTICE));
      expect(cardNotice()).not.toBe(VPN_NOT_STORED_CHECK_NOTICE);
      expect(document.querySelector(`[title^="${VPN_NOT_STORED_CHECK_NOTICE}"]`)).toBeNull();
    } finally {
      live.apiKey = 'ds_test_x';
    }
  });

  it('the notice belongs to THAT check: the next Check VPN drops it the moment it starts', async () => {
    state.vpnStored = false;
    state.storeRefused = true; // (V2) — an unstored row only KEEPS a notice when the store is refused
    seedCache({});
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() => expect(cardNotice()).toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE));
    let release: (r: { resolved: boolean; ip: string; message: string }) => void = () => undefined;
    resolveEndpoint.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await clickCheckVpn();
    await waitFor(() => expect(cardNotice()).toBeNull());
    release({ resolved: true, ip: '203.0.113.9', message: 'Resolved' });
    // The same reason comes back once this check lands: re-derived per check.
    await waitFor(() => expect(cardNotice()).toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE));
  });

  it('VACUITY CONTROL — a stored row with a key reaches the fleet and gets NO not-tested notice', async () => {
    seedCache({});
    const AccountProxies = await import('../../src/lib/account-proxies');
    vi.mocked(AccountProxies.testAccountProxy).mockClear();
    vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
      ok: true,
      latency_ms: 42,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() =>
      expect(vi.mocked(AccountProxies.testAccountProxy)).toHaveBeenCalledTimes(1),
    );
    expect(await screen.findByText('42ms')).toBeTruthy();
    expect(cardNotice()).toBeNull();
  });
});

// (m) M4 — the #15 claim at the two ProfilesView call sites. The sweeper test
// pins `withProxyProbe` itself; nothing pinned that the card's Test and the
// launch pre-flight run their handshake INSIDE it. A real sweep is driven
// against the same module state while the user probe is held open: it must
// skip the row (skippedBusy) and never hand its own handshake to `testProxy`.
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}
const sweepDeps = (probedBySweep: string[]): SweepDeps => ({
  loadCache: () => Promise.resolve({ p1: { result: HEALTHY, at: 0 } }), // stale → planned
  listProxies: () => Promise.resolve([SOCKS5_PROXY]),
  testProxy: (p) => {
    probedBySweep.push(p.id);
    return Promise.resolve(HEALTHY);
  },
  saveResult: () => Promise.resolve({}),
  now: () => Date.now(),
  sleep: () => Promise.resolve(),
});

describe('(m) M4 — the card’s Test and the launch pre-flight run their probe inside withProxyProbe', () => {
  // MUTATION: unwrap the `withProxyProbe(px.id, …)` in handleTestProxy (call
  // testProxy directly) → no claim → the concurrent sweep probes p1 underneath
  // the customer's Test → red.
  it('CRITICAL card Test: while its handshake is open, a concurrent sweep skips that row', async () => {
    __resetSweepLatchForTests();
    state.boundProxyId = 'p1';
    seedCache({ p1: { result: HEALTHY, at: Date.now() } });
    const held = deferred<ProxyTestResult>();
    testProxy.mockImplementationOnce(() => held.promise);
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    expect(isProxyProbeInFlight('p1')).toBe(true);
    const probedBySweep: string[] = [];
    const report = await runSweep(sweepDeps(probedBySweep));
    expect(report.skippedBusy).toEqual(['p1']);
    expect(probedBySweep).toEqual([]);
    held.resolve(HEALTHY);
    await waitFor(() => expect(isProxyProbeInFlight('p1')).toBe(false));
  });

  // MUTATION: unwrap the `withProxyProbe(proxy.id, …)` in handleLaunch's
  // SOCKS5 pre-flight → same double probe → red.
  it('CRITICAL launch pre-flight: while its handshake is open, a concurrent sweep skips that row', async () => {
    __resetSweepLatchForTests();
    state.boundProxyId = 'p1';
    seedCache({ p1: { result: HEALTHY, at: Date.now() } });
    const held = deferred<ProxyTestResult>();
    testProxy.mockImplementationOnce(() => held.promise);
    await launch();
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    expect(isProxyProbeInFlight('p1')).toBe(true);
    const probedBySweep: string[] = [];
    const report = await runSweep(sweepDeps(probedBySweep));
    expect(report.skippedBusy).toEqual(['p1']);
    expect(probedBySweep).toEqual([]);
    held.resolve(HEALTHY);
    await waitFor(() => expect(isProxyProbeInFlight('p1')).toBe(false));
    // The launch it was holding proceeds on the released verdict.
    await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
  });

  it('VACUITY CONTROL — with no user probe in flight the same sweep probes the row', async () => {
    __resetSweepLatchForTests();
    const probedBySweep: string[] = [];
    const report = await runSweep(sweepDeps(probedBySweep));
    expect(report.skippedBusy).toEqual([]);
    expect(probedBySweep).toEqual(['p1']);
  });
});

// (m) M5 — the #16 hoist: handleTestProxy drops the row's previous VPN notice
// for EVERY scheme, before the SOCKS5/VPN fork. The card hides `vpnNotice` on a
// non-VPN row, so on the SOCKS5 row itself the stale state is invisible; what
// makes it observable is the edit BACK — the notice map is keyed by id and
// outlives a re-list, so a notice a SOCKS5 Test failed to clear resurfaces the
// moment the row is a VPN again (the control below proves that path is live).
describe('(m) M5 — a SOCKS5 Test clears a stale VPN notice on the card', () => {
  const refresh = (): void => {
    fireEvent.click(screen.getByTitle('Refresh now'));
  };
  async function openMenu(): Promise<void> {
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  }

  // MUTATION: move the setVpnNotices clear back inside handleTestProxy's VPN
  // branch → the SOCKS5 Test leaves the map entry → the notice is back on the
  // card once the row is a VPN again → red.
  it('CRITICAL vpn→socks5, Test proxy, →vpn again: the previous not-tested notice does not come back', async () => {
    state.vpnStored = false;
    state.storeRefused = true; // (V2) — the notice this arm tracks now needs a refused store
    seedCache({});
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() => expect(cardNotice()).toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE));
    state.vpn1Scheme = 'socks5';
    // The refusal was the VPN row's; the SOCKS5 Test that follows must be able
    // to store its own row, or it would leave a notice of its OWN (the (q)
    // 12-memory (A) one) and "did not come back" could not be read.
    state.storeRefused = false;
    refresh();
    await openMenu();
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    expect(resolveEndpoint).toHaveBeenCalledTimes(1); // the Check VPN's only
    state.vpn1Scheme = 'openvpn';
    refresh();
    await openMenu();
    await screen.findByLabelText(/^Check VPN/); // the row is a VPN again
    expect(cardNotice()).toBeNull();
  });

  // The discriminator's own control: the SAME flip with NO Test in between
  // brings the notice back. Without this, "cleared" and "never rendered on
  // the way back" read identically. Pins the fixture path, not a product
  // wish: if a re-list ever drops per-row notices, this arm and the CRITICAL
  // above need a new observable together.
  it('INSTRUMENT CONTROL — the same flip with no Test between brings the notice back', async () => {
    state.vpnStored = false;
    state.storeRefused = true; // (V2) — as above
    seedCache({});
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await clickCheckVpn();
    await waitFor(() => expect(cardNotice()).toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE));
    state.vpn1Scheme = 'socks5';
    refresh();
    await openMenu();
    await screen.findByLabelText(/Test proxy from this Mac/); // re-listed as SOCKS5; hidden
    expect(cardNotice()).toBeNull();
    state.vpn1Scheme = 'openvpn';
    refresh();
    await openMenu();
    await screen.findByLabelText(/^Check VPN/);
    expect(cardNotice()).toBe(VPN_PLAN_EXCLUDED_CHECK_NOTICE);
    expect(testProxy).not.toHaveBeenCalled();
  });
});

// (n) N11 + N20 — every VPN arm above runs on an `openvpn` fixture; `wireguard`
// appeared in this file exactly once, in the header comment. The code those arms
// cover routes on `isVpnScheme` (proxy-scheme.ts:32-34) TODAY, so a later edit
// that narrows any one of those sites to `scheme === 'openvpn'` — the exact
// pattern the L4 review found — sends a WireGuard row back down the SOCKS5
// handshake, "unreachable" on every launch, with this suite fully green.
//
// So the five load-bearing surfaces are re-run here under `describe.each` over
// BOTH tunnel schemes: the launch pre-flight, the card's Check VPN, the fleet
// leg after the resolve, the card's fleet FAILURE banner and its not-run notice,
// plus the UDP chip and — N20 — the unresolved-endpoint confirm, whose WireGuard
// sentence was pinned only as a pure-function call (a-vpn-verdict-is-not-a-
// socks5-verdict.test.ts:110-111) and never through the ProfilesView confirm.
//
// The 'openvpn' leg is the INSTRUMENT CONTROL: these arms are known-green for
// the scheme the file already covered, so a red on the 'wireguard' leg alone is
// a statement about the scheme, not about the harness.
const VPN_SCHEME_CASES = [
  {
    scheme: 'openvpn' as const,
    host: 'vpn.example.com',
    port: 1194,
    // proxy-scheme.ts:50-53 — each scheme names the line in ITS OWN file.
    confirmLine: 'remote',
  },
  {
    scheme: 'wireguard' as const,
    host: 'wg.example.com',
    port: 51820,
    confirmLine: 'Endpoint',
  },
];

describe.each(VPN_SCHEME_CASES)(
  '(n) N11/N20 — the VPN surfaces on a $scheme row',
  ({ scheme, host, port, confirmLine }) => {
    beforeEach(() => {
      state.vpn1Scheme = scheme;
    });

    // MUTATION: narrow the launch gate from `isVpnScheme(proxy.scheme)` to
    // `proxy.scheme === 'openvpn'` → the WireGuard leg takes the SOCKS5
    // pre-flight, `testProxy` is called and `resolveEndpoint` is not → red on
    // the wireguard leg, green on the openvpn one.
    it('CRITICAL a launch resolves the endpoint and NEVER invokes the SOCKS5 probe', async () => {
      await launch();
      await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
      expect(resolveEndpoint).toHaveBeenCalledWith(host, port);
      expect(
        testProxy,
        'a SOCKS5 greeting sent to a tunnel endpoint can only ever answer "unreachable"',
      ).not.toHaveBeenCalled();
      expect(confirmMock).not.toHaveBeenCalled();
    });

    // N20 — the confirm sentence, through the view rather than through the pure
    // helper. MUTATION: drop the scheme argument at ProfilesView.tsx:2969
    // (`endpointUnresolvedCopy('openvpn', …)` or the bare host form) → the
    // WireGuard row is told to check a `remote` line its file does not have → red.
    it("CRITICAL an endpoint that does not resolve confirms with THIS scheme's config line, and none of the SOCKS5 ladder", async () => {
      resolveEndpoint.mockResolvedValue({ resolved: false, ip: '', message: 'DNS lookup failed' });
      await launch();
      await waitFor(() => expect(confirmMock).toHaveBeenCalledTimes(1));
      const text = confirmMock.mock.calls[0]?.[0] ?? '';
      expect(text).toBe(
        `The VPN endpoint ${host} could not be resolved. Check the config's ${confirmLine} line. Launch anyway?`,
      );
      expect(text).not.toMatch(/unreachable|credentials|route traffic/i);
      await waitFor(() => expect(agentCreate).toHaveBeenCalledTimes(1));
      expect((agentCreate.mock.calls[0]?.[0] as Record<string, unknown>).skip_proxy_probe).toBe(
        true,
      );
    });

    // MUTATION: narrow handleTestProxy's fork to `=== 'openvpn'` → the card's
    // Check VPN on a WireGuard row runs `testProxy` → red.
    it('CRITICAL the card’s Check VPN resolves the endpoint and never runs proxy_test', async () => {
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      await clickCheckVpn();
      await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith(host, port));
      expect(testProxy).not.toHaveBeenCalled();
      await waitFor(() => expect(storedProbe('vpn1')?.endpoint).toBeDefined());
    });

    // MUTATION: narrow runFleetTestForRow's scheme gate → the WireGuard row's
    // tunnel is never brought up on a fleet Mac → red.
    it('CRITICAL the card’s Check VPN asks the FLEET after the resolve (vantage: fleet, the stored row)', async () => {
      const AccountProxies = await import('../../src/lib/account-proxies');
      vi.mocked(AccountProxies.testAccountProxy).mockClear();
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      await clickCheckVpn();
      await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith(host, port));
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

    // MUTATION: revert the launch gate to "run the fleet test first" → red for
    // both legs; kept per-scheme because the gate is the same `isVpnScheme`.
    it('CRITICAL a LAUNCH never calls testAccountProxy (one tunnel, one connection)', async () => {
      const AccountProxies = await import('../../src/lib/account-proxies');
      vi.mocked(AccountProxies.testAccountProxy).mockClear();
      await launch();
      await waitFor(() => expect(resolveEndpoint).toHaveBeenCalledWith(host, port));
      await new Promise((r) => setTimeout(r, 30));
      expect(AccountProxies.testAccountProxy).not.toHaveBeenCalled();
    });

    // MUTATION: gate the card's banner on `scheme === 'openvpn'` instead of the
    // `vpn` prop the parent derives from isVpnScheme → the WireGuard tunnel that
    // the fleet could not bring up renders as an untested row → red.
    it('CRITICAL a fleet FAILURE shows the VPN broken banner with the fleet’s sentence and drops the exit it showed', async () => {
      seedCache({ vpn1: measuredVpnEntry(5000) });
      const AccountProxies = await import('../../src/lib/account-proxies');
      vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
        ok: false,
        reason: FLEET_DOWN,
        measured_from: 'fleet',
      });
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      expect(await screen.findByTitle(/198\.51\.100\.9/)).toBeTruthy();
      await clickCheckVpn();
      await waitFor(() =>
        expect(
          document.querySelector('[data-component="proxy-broken-banner"][data-vpn-failure="true"]'),
        ).not.toBeNull(),
      );
      expect(screen.getByText('VPN tunnel down')).toBeTruthy();
      expect(document.querySelector('[data-component="proxy-vpn-failure"]')?.textContent).toBe(
        FLEET_DOWN,
      );
      expect(screen.queryByTitle(/198\.51\.100\.9/)).toBeNull();
    });

    // MUTATION: route the `not_run` reply to the failure branch → a busy test Mac
    // reads as a down tunnel and the row loses its standing exit → red.
    it('CRITICAL a NOT-RUN keeps the exit and latency and shows the sentence as a muted notice, never the banner', async () => {
      seedCache({ vpn1: measuredVpnEntry(5000) });
      const AccountProxies = await import('../../src/lib/account-proxies');
      vi.mocked(AccountProxies.testAccountProxy).mockResolvedValueOnce({
        ok: false,
        reason: BUSY,
        measured_from: 'fleet',
        not_run: 'node_busy',
      });
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      expect(await screen.findByTitle(/198\.51\.100\.9/)).toBeTruthy();
      await clickCheckVpn();
      await waitFor(() =>
        expect(document.querySelector('[data-component="proxy-vpn-notice"]')?.textContent).toBe(
          BUSY,
        ),
      );
      expect(document.querySelector('[data-component="proxy-broken-banner"]')).toBeNull();
      expect(screen.getByTitle(/198\.51\.100\.9/)).toBeTruthy();
      expect(screen.getByText('42ms')).toBeTruthy();
    });

    // MUTATION: gate the chip on `scheme === 'openvpn'` → a WireGuard card shows
    // "UDP ?" (an unprobed SOCKS5 grant) for a tunnel that carries UDP → red.
    it('the caps row carries "UDP via tunnel" in its "+N" title and never the SOCKS5 "UDP ?"', async () => {
      // Phase B: no UDP chip on a tunnel (not a measurement); the sentence is
      // the '+N' pill's title. Gating the hint on `scheme === 'openvpn'` would
      // leave a WireGuard card with no tunnel sentence at all → red.
      render(<ProfilesView onGoToSettings={vi.fn()} />);
      const overflow = await waitFor(() => {
        const el = document.querySelector('[data-component="caps-overflow"]');
        expect(el).not.toBeNull();
        return el as HTMLElement;
      });
      expect(overflow.getAttribute('title')).toMatch(/UDP via tunnel/);
      expect(document.querySelector('[data-udp]')).toBeNull();
      expect(screen.queryByText('UDP ?')).toBeNull();
    });
  },
);

// ⛔ (V4 follow-up 2026-09-12, owner: "session not starting still") — THE CAUSE
// HAS TO REACH THE SCREEN, or the whole V3 server-side change is invisible to
// the one person it was written for.
//
// MEASURED before this landed: the pre-launch gate's 422 carries a `detail`
// quoting the offending line of the customer's own .ovpn, and the client chain
// (`friendlyError` → `humanizeError` → `fixedApiErrorMessage`) classifies on
// `kind`/`status` and passes `reason` as `undefined`, so all ten causes arrived
// as one sentence — "The proxy could not be verified. Check its details and try
// again." — pointing at a host and port that were never the problem. The
// server-side guard for V3 pins a SERVER proposition and reads green while the
// customer-visible one is unchanged; this is the arm for the half that matters.
//
// MUTATIONS: (a) delete the `proxyConfigRefusalMessage` call in `friendlyError`
// → the e2e arm reds with the generic "could not be verified" sentence; (b) make
// the helper ignore `reason` (match on status 422 alone) → the discrimination
// arm reds.
describe('(V4) the launch refusal names the stored-config cause the server sent', () => {
  const LINE_DETAIL =
    'Line 3: "script-security 2" — Driftstack does not run scripts from VPN configurations. Remove the line and save it again.';

  it('CRITICAL a 422 config_unresolvable shows OUR headline plus the server’s named line — never "check the host and port"', async () => {
    agentCreate.mockClear();
    agentCreate.mockRejectedValueOnce(
      Object.assign(new Error('proxy validation failed'), {
        kind: 'proxy_validation_failed',
        status: 422,
        reason: 'config_unresolvable',
        detail: LINE_DETAIL,
      }),
    );
    await launch();
    expect(await screen.findByText(/script-security 2/)).toBeTruthy();
    // The three sentences that were shown instead, each of which sent the owner
    // to the wrong place.
    expect(document.body.textContent).not.toContain('The proxy could not be verified');
    expect(document.body.textContent).not.toContain('did not answer');
    expect(document.body.textContent).toContain('nothing was dialled');
  });

  it('a probe verdict (reason: unreachable) is UNCHANGED — it keeps the fixed copy, because a dial really did happen', () => {
    // The discrimination is on the contractual reason, not the status: the
    // probe's own verdict must not be re-labelled as a config problem.
    expect(
      proxyConfigRefusalMessage({ status: 422, reason: 'unreachable', detail: 'x' }),
    ).toBeNull();
  });

  it('a detail that is absent, empty or absurdly long falls back to fixed copy of ours', () => {
    const bare = proxyConfigRefusalMessage({ status: 422, reason: 'config_unresolvable' });
    expect(bare).toContain('re-paste the configuration');
    expect(
      proxyConfigRefusalMessage({ status: 422, reason: 'config_unresolvable', detail: '   ' }),
    ).toBe(bare);
    expect(
      proxyConfigRefusalMessage({
        status: 422,
        reason: 'config_unresolvable',
        detail: 'x'.repeat(401),
      }),
    ).toBe(bare);
    // …and a 401-character body never becomes the page.
    expect(bare).not.toContain('xxxx');
  });

  it('VACUITY CONTROL — a non-422 and a non-object are not this refusal', () => {
    expect(proxyConfigRefusalMessage({ status: 403, reason: 'config_unresolvable' })).toBeNull();
    expect(proxyConfigRefusalMessage(null)).toBeNull();
    expect(proxyConfigRefusalMessage('config_unresolvable')).toBeNull();
  });
});
