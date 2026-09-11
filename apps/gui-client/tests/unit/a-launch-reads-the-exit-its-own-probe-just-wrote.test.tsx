// (l) SOCKS5/chat audit — finding #13 (L5).
//
// The launch's TTL re-probe (`freshExitIdentity`) read the closure's
// render-time `probeCache`, not the entry the pre-launch native probe had JUST
// written (`setProbeCache(await saveProbeResult(...))` was never captured, and
// the `cacheOverride` parameter had no caller). So when the cache said
// "unusable" (a transient sweep failure, V-2168's mobile-carrier case) and the
// fresh probe said usable, the TTL check was skipped and an arbitrarily old
// exitTimezone / exitCountry was handed to the simulator — the device clock
// showed the stale zone and the Dock the stale flag until the capability
// report landed. And a never-tested proxy got no exit probe at all.
//
// Harness mirrors a-vpn-row-is-resolved-never-socks5-probed (store-backed
// cache, spied native calls, the simulator opener as the measurement point).

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

const HEALTHY: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'Working — CONNECT succeeded.',
};
const DOWN: ProxyTestResult = {
  ...HEALTHY,
  reachable: false,
  auth_ok: false,
  can_route: false,
  message: 'no answer',
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

const { testProxy, probeProxyExit } = vi.hoisted(() => ({
  testProxy: vi.fn<(input: unknown) => Promise<ProxyTestResult>>(),
  probeProxyExit: vi.fn<(input: unknown) => Promise<unknown>>(),
}));
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([SOCKS5_PROXY]),
  addProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  testProxy: (input: unknown) => testProxy(input),
  resolveEndpoint: vi.fn(() =>
    Promise.resolve({ resolved: true, ip: '203.0.113.9', message: 'Resolved' }),
  ),
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
const THIRTY_ONE_MIN = 31 * 60 * 1000;
const STALE_NL = (result: ProxyTestResult) => ({
  p1: {
    result,
    at: Date.now() - 60_000,
    exitIp: '198.51.100.2',
    exitCountry: 'NL',
    exitTimezone: 'Europe/Amsterdam',
    exitAt: Date.now() - THIRTY_ONE_MIN,
  },
});
const US_EXIT = {
  ip: '198.51.100.7',
  country: 'US',
  city: null,
  region: null,
  timezone: 'America/New_York',
};

async function launch(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Launch' }));
  await waitFor(() => expect(openSimulatorWindow).toHaveBeenCalledTimes(1));
}
const handed = (): Record<string, unknown> => openSimulatorWindow.mock.calls[0]?.[0] ?? {};

beforeEach(() => {
  stores.clear();
  agentCreate.mockClear();
  confirmMock.mockClear();
  confirmMock.mockResolvedValue(true);
  openSimulatorWindow.mockClear();
  testProxy.mockReset();
  testProxy.mockResolvedValue(HEALTHY);
  probeProxyExit.mockReset();
  probeProxyExit.mockResolvedValue(US_EXIT);
});

describe('#13 — the launch reads the entry its own pre-launch probe just wrote', () => {
  // MUTATION: drop `launchCache` from the freshExitIdentity call (back to the
  // closure's `probeCache`) → the stale entry says UNUSABLE → `fromCache` → the
  // 31-minute-old NL/Amsterdam reaches the simulator with no probe → red.
  it('CRITICAL cache says unusable + stale exit, fresh probe says usable: the exit is RE-PROBED and the current zone reaches the simulator', async () => {
    seedCache(STALE_NL(DOWN));
    await launch();
    expect(testProxy).toHaveBeenCalledTimes(1);
    expect(probeProxyExit).toHaveBeenCalledTimes(1);
    expect(handed()).toMatchObject({ countryCode: 'US', timezone: 'America/New_York' });
    // The pre-launch verdict was usable, so no "Launch anyway" confirm either.
    expect(confirmMock).not.toHaveBeenCalled();
  });

  // ⛔ NOT a guard on the `cached === undefined` early return (review of the
  // batch): a SINGLE launch runs the SOCKS5 pre-flight first, which WRITES the
  // entry (`launchCache = probed.next`) before freshExitIdentity reads it — so
  // `cached` is defined here (usable, no exitAt) and the usable/not-fresh
  // branch probes whichever way that line reads. This arm measures that the
  // launch reads its OWN write (drop `launchCache` from the call → the
  // closure's `{}` → the restored early return → red); the never-tested
  // branch itself is guarded by the BULK arm below.
  it('CRITICAL a never-tested proxy on a SINGLE launch: the pre-flight writes the entry and the exit is probed from it', async () => {
    seedCache({});
    await launch();
    expect(testProxy).toHaveBeenCalledTimes(1);
    expect(probeProxyExit).toHaveBeenCalledTimes(1);
    expect(handed()).toMatchObject({ countryCode: 'US', timezone: 'America/New_York' });
  });

  // The bulk launch runs NO pre-flight (skipProxyDownConfirm), so it is the
  // path where a never-tested proxy has NO entry at read time — the branch the
  // (l) #13 comment names ("the ordinary bulk launch").
  // MUTATION: restore `if (cached === undefined) return fromCache;` in the
  // SOCKS5 arm of freshExitIdentity → no probe, nothing handed → red HERE
  // (and green above, which is why this arm exists).
  it('CRITICAL a BULK launch of a never-tested proxy (no pre-flight, no entry) still gets the exit probe', async () => {
    seedCache({});
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Select Demo' }));
    fireEvent.click(await screen.findByTitle('Open a browser session for each selected profile'));
    await waitFor(() => expect(openSimulatorWindow).toHaveBeenCalledTimes(1));
    // The bulk path's only confirm is the up-front "Launch 1 session?"; no
    // native pre-flight ran, so the entry read is the on-disk `{}`.
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0]?.[0]).toMatch(/^Launch 1 session\?/);
    expect(testProxy).not.toHaveBeenCalled();
    expect(probeProxyExit).toHaveBeenCalledTimes(1);
    expect(handed()).toMatchObject({ countryCode: 'US', timezone: 'America/New_York' });
  });

  it('fresh probe ALSO unusable (Launch anyway): nothing is handed over and the exit is not probed through a dead proxy', async () => {
    seedCache(STALE_NL(DOWN));
    testProxy.mockResolvedValue(DOWN);
    await launch();
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(probeProxyExit).not.toHaveBeenCalled();
    expect(handed()).toMatchObject({ countryCode: null, timezone: null });
  });

  it('VACUITY CONTROL — a usable entry with a FRESH exit is handed over as cached, with no probe', async () => {
    seedCache({ p1: { ...STALE_NL(HEALTHY).p1, exitAt: Date.now() - 1000 } });
    await launch();
    expect(probeProxyExit).not.toHaveBeenCalled();
    expect(handed()).toMatchObject({ countryCode: 'NL', timezone: 'Europe/Amsterdam' });
  });

  it('a failed re-probe still hands over the cached identity rather than blocking the launch', async () => {
    seedCache(STALE_NL(HEALTHY));
    probeProxyExit.mockResolvedValue(null);
    await launch();
    expect(probeProxyExit).toHaveBeenCalledTimes(1);
    expect(handed()).toMatchObject({ countryCode: 'NL', timezone: 'Europe/Amsterdam' });
  });
});
