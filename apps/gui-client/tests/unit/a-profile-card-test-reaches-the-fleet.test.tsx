// T-27 (drops 1 and 5, at the two surfaces) — the profile card's Test asks the
// control plane for the FLEET vantage exactly as the Proxies grid does, and
// both stamp the measured-QUIC verdict with the SERVER's `quic_measured_at`.
//
// MEASURED: `handleTestProxy` in ProfilesView ran the native probe plus the
// exit probe and stopped — no `testAccountProxy(…, { vantage: 'fleet' })`, no
// `saveServerProbeResult` — so a card Test could never populate `quicMeasured`
// / `quicProbe`, and the chip stayed `~` however often it was pressed. And the
// grid stamped `Date.now()` at reply time while the server's own timestamp was
// parsed and never read, so a verdict from a session weeks ago looked freshly
// measured after every Test.
//
// The proxy without a server id is the vacuity control: the fleet call is
// gated on the row being stored on the account, and it must NOT fire there.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { AccountProxyTestResult } from '../../src/lib/account-proxies';
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
        close: vi.fn(() => Promise.resolve({})),
        livekitToken: vi.fn(),
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

const { state } = vi.hoisted(() => ({ state: { boundProxyId: 'p1' } }));

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

const UDP_OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

const STORED: ProxyConfig = {
  id: 'p1',
  label: 'london-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  scheme: 'socks5',
  serverId: 'aprx_1',
};
const LOCAL_ONLY: ProxyConfig = {
  ...STORED,
  id: 'p_local',
  label: 'local-only',
  serverId: undefined,
};

const { testAccountProxy, testProxy } = vi.hoisted(() => ({
  testAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        opts?: { vantage?: 'cp' | 'fleet' },
      ) => Promise<AccountProxyTestResult>
    >(),
  testProxy: vi.fn<(input: unknown) => Promise<ProxyTestResult>>(),
}));

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([STORED, LOCAL_ONLY]),
  addProxy: vi.fn(),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
}));

vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
}));

vi.mock('../../src/components/ConfirmProvider', () => ({
  useConfirm: () => vi.fn(() => Promise.resolve(true)),
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
const { ProxiesView } = await import('../../src/views/ProxiesView');

const SERVER_TS = '2026-09-07T08:00:00.000Z';
const SERVER_MS = Date.parse(SERVER_TS);
const FLEET_H3: AccountProxyTestResult = {
  ok: true,
  latency_ms: 31,
  measured_from: 'fleet',
  node_id: 'mac-mini-07',
  quic_measured: 'h3',
  quic_measured_at: SERVER_TS,
  quic_probe: true,
};

function storedProbe(id: string): Record<string, unknown> | undefined {
  const probes = stores.get('proxy-probe-cache.json')?.get('probes') as
    | Record<string, unknown>
    | undefined;
  return probes?.[id] as Record<string, unknown> | undefined;
}

async function testFromTheCard(): Promise<void> {
  render(<ProfilesView onGoToSettings={vi.fn()} />);
  fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
  fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
}

beforeEach(() => {
  stores.clear();
  state.boundProxyId = 'p1';
  testProxy.mockReset();
  testProxy.mockResolvedValue(UDP_OK);
  testAccountProxy.mockReset();
  testAccountProxy.mockResolvedValue(FLEET_H3);
});

describe("the profile card's Test reaches the fleet", () => {
  it("CRITICAL asks the server for the FLEET vantage with the row's server id", async () => {
    await testFromTheCard();
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(testAccountProxy.mock.calls[0]).toEqual([
      'http://localhost:3000',
      'ds_test_x',
      'aprx_1',
      { vantage: 'fleet' },
    ]);
  });

  it("CRITICAL the measured 'h3' lands in the cache under the SERVER's stamp, with the relay verdict beside it", async () => {
    await testFromTheCard();
    await waitFor(() => expect(storedProbe('p1')?.quicMeasured).toBe('h3'));
    expect(storedProbe('p1')?.quicMeasuredAt).toBe(SERVER_MS);
    expect(storedProbe('p1')).toMatchObject({
      quicProbe: true,
      serverLatencyMs: 31,
      measuredFrom: 'fleet',
      nodeId: 'mac-mini-07',
    });
  });

  it('VACUITY CONTROL — a proxy not stored on the account never asks the server (nothing to test there)', async () => {
    state.boundProxyId = 'p_local';
    await testFromTheCard();
    await waitFor(() => expect(testProxy).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(storedProbe('p_local')).toBeDefined());
    expect(testAccountProxy).not.toHaveBeenCalled();
  });

  it('CONTROL — a native verdict that is not usable stops before the fleet call, as the grid does', async () => {
    testProxy.mockResolvedValue({ ...UDP_OK, can_route: false, connect_reply: 0x02 });
    await testFromTheCard();
    await waitFor(() => expect(storedProbe('p1')).toBeDefined());
    expect(testAccountProxy).not.toHaveBeenCalled();
  });
});

describe("the Proxies grid stamps the verdict with the SERVER's clock too (one shared step)", () => {
  it("CRITICAL quicMeasuredAt is `quic_measured_at`, not this Mac's reply time", async () => {
    const before = Date.now();
    render(<ProxiesView />);
    // Two rows are listed (the stored one first); the grid's Test is per row.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Test' }))[0] as HTMLElement);
    await waitFor(() => expect(storedProbe('p1')?.quicMeasured).toBe('h3'));
    const stamped = storedProbe('p1')?.quicMeasuredAt;
    expect(stamped).toBe(SERVER_MS);
    expect(stamped as number).toBeLessThan(before);
  });

  it('VACUITY CONTROL — a server that measured but sent no time is stamped at reply time', async () => {
    testAccountProxy.mockResolvedValue({ ...FLEET_H3, quic_measured_at: null });
    const before = Date.now();
    render(<ProxiesView />);
    // Two rows are listed (the stored one first); the grid's Test is per row.
    fireEvent.click((await screen.findAllByRole('button', { name: 'Test' }))[0] as HTMLElement);
    await waitFor(() => expect(storedProbe('p1')?.quicMeasured).toBe('h3'));
    expect(storedProbe('p1')?.quicMeasuredAt as number).toBeGreaterThanOrEqual(before);
  });
});
