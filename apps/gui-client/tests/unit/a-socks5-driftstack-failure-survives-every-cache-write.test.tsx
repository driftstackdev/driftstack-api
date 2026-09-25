// Proxy-accuracy audit G2 (paths-04 + paths-13), T1 — a SOCKS5 proxy Driftstack
// could not use kept that verdict only in the grid's memory. MEASURED: one display
// tick turned "fails from Driftstack" into "slow from Driftstack · 180ms", "~QUIC"
// into "✓QUIC"; a cache write for a DIFFERENT row did the same with no tick; the
// next native Test erased it from the store; and the profile card never showed it.
//
// Now the failure is saved with the row (keeping this Mac's own verdict and exit),
// survives every later cache write — another row's, a native re-test of this one,
// a remount — shows on the grid AND the card, and only a later Driftstack answer
// lifts it. (The sixty-second display tick re-derives from the same cache these
// writes emit, through the same `deriveIntoState`.)
//
// Only the network edges are doubled; the probe cache is REAL, over an in-memory
// Tauri store.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { AccountProxyTestResult } from '../../src/lib/account-proxies';
import type { ProxyConfig, ProxyDraft, ProxyTestResult } from '../../src/lib/proxies';

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
  profilesUsingProxy: vi.fn(() => Promise.resolve([])),
}));

const USABLE: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  udp_relay: 'relays',
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

const OLD_PW = 'OLD_PASSWORD';
function row(): ProxyConfig {
  return {
    id: 'p1',
    label: 'london-socks',
    host: 'old.example.com',
    port: 1080,
    username: 'u',
    password: OLD_PW,
    createdAt: '2026-05-20T00:00:00.000Z',
    scheme: 'socks5',
    serverId: 'aprx_1',
  };
}
let stored: ProxyConfig[] = [];
const events: string[] = [];

const { testAccountProxy, updateAccountProxy, createAccountProxy, testProxy } = vi.hoisted(() => ({
  testAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        opts?: { vantage?: 'cp' | 'fleet' },
      ) => Promise<AccountProxyTestResult>
    >(),
  updateAccountProxy:
    vi.fn<
      (
        baseUrl: string,
        apiKey: string,
        id: string,
        patch: Record<string, unknown>,
      ) => Promise<unknown>
    >(),
  createAccountProxy: vi.fn<(...a: unknown[]) => Promise<{ id: string }>>(),
  testProxy: vi.fn<(input: unknown) => Promise<ProxyTestResult>>(),
}));

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve(stored),
  addProxy: vi.fn(),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn((id: string, patch: ProxyDraft) => {
    events.push('local-updateProxy');
    stored = stored.map((p) => (p.id === id ? { ...p, ...patch } : p));
    return Promise.resolve(stored.find((p) => p.id === id));
  }),
  setProxyServerId: vi.fn(() => Promise.resolve({})),
  validateDraft: () => ({ ok: true, errors: {} }),
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
  ) => {
    events.push(`fleet-test:${id}`);
    return testAccountProxy(baseUrl, apiKey, id, opts);
  },
  updateProxy: (baseUrl: string, apiKey: string, id: string, patch: Record<string, unknown>) => {
    events.push(`account-put:${id}`);
    return updateAccountProxy(baseUrl, apiKey, id, patch);
  },
  createProxy: (...a: unknown[]) => createAccountProxy(...a),
  listProxies: vi.fn(() => Promise.resolve([])),
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
const { saveProbeResult, __resetMaterialEditsForTests } =
  await import('../../src/lib/proxy-probe-cache');

const REASON = 'The proxy did not answer. Check the host and port, and that it is online.';
const FLEET_FAILED: AccountProxyTestResult = {
  ok: false,
  reason: REASON,
  measured_from: 'fleet',
};
const FLEET_OK: AccountProxyTestResult = {
  ok: true,
  latency_ms: 31,
  measured_from: 'fleet',
  node_id: 'mac-mini-07',
};

function storedProbe(id: string): Record<string, unknown> | undefined {
  const probes = stores.get('proxy-probe-cache.json')?.get('probes') as
    | Record<string, unknown>
    | undefined;
  return probes?.[id] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  cleanup();
  stores.clear();
  __resetMaterialEditsForTests();
  stored = [row()];
  events.length = 0;
  testProxy.mockReset();
  testProxy.mockResolvedValue(USABLE);
  testAccountProxy.mockReset();
  testAccountProxy.mockResolvedValue(FLEET_OK);
  updateAccountProxy.mockReset();
  updateAccountProxy.mockResolvedValue({ id: 'aprx_1' });
  createAccountProxy.mockReset();
  createAccountProxy.mockResolvedValue({ id: 'aprx_new' });
});

describe('G2 — a SOCKS5 row’s Driftstack failure survives every cache write, on the grid and the card', () => {
  it('CRITICAL (T1) fails from Driftstack stays through a write for another row, a native re-test, a remount and the card — and only a later Driftstack answer lifts it', async () => {
    // Driftstack measured the proxy fine first (the numbers the failure retires)…
    testAccountProxy.mockResolvedValueOnce({ ...FLEET_OK, latency_ms: 180, quic_probe: true });
    const grid = render(<ProxiesView />);
    // (the automatic check at mount takes the first answer)
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalled());
    await waitFor(() => expect(storedProbe('p1')?.serverLatencyMs).toBe(180));
    // …then the customer's Test finds it unusable from Driftstack.
    testAccountProxy.mockResolvedValue(FLEET_FAILED);
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    expect(await screen.findByText('fails from Driftstack')).toBeTruthy();
    await waitFor(() => expect(storedProbe('p1')?.fleetFailureReason).toBe(REASON));

    // 1. a cache write for a DIFFERENT row re-derives every row from the store
    await saveProbeResult('p2', USABLE, Date.now());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('fails from Driftstack')).toBeTruthy();
    expect(screen.queryByText(/180ms/)).toBeNull();

    // 2. a native re-test of THIS row (what the background sweep writes)
    await saveProbeResult('p1', { ...USABLE, latency_ms: 20 }, Date.now());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('fails from Driftstack')).toBeTruthy();

    // 3. a remount renders from the store alone
    grid.unmount();
    const again = render(<ProxiesView />);
    expect(await screen.findByText('fails from Driftstack')).toBeTruthy();
    again.unmount();

    // 4. the profile card reads the same row from the same store
    const card = render(<ProfilesView onGoToSettings={vi.fn()} />);
    expect(await screen.findByText('fails from Driftstack')).toBeTruthy();
    card.unmount();

    // 5. only a later Driftstack answer lifts it
    testAccountProxy.mockResolvedValue(FLEET_OK);
    render(<ProxiesView />);
    await screen.findByText('fails from Driftstack');
    // The row has a verdict now, so its button is the re-test action.
    fireEvent.click(await screen.findByRole('button', { name: 'Re-test' }));
    await waitFor(() => expect(screen.queryByText('fails from Driftstack')).toBeNull());
    expect(storedProbe('p1')?.fleetFailureReason).toBeUndefined();
  });
});
