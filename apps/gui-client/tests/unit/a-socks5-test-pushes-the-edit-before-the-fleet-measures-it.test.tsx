// Proxy-accuracy audit G3 (paths-05) — after a SOCKS5 edit, the Test's fleet leg
// measured the OLD endpoint.
//
// MEASURED: `handleTest` pushed local changes to the account only when the row had
// never been stored (`serverId === undefined`), then asked the server to test the
// STORED row. After an edit and Save, `updateAccountProxy` was called 0 times: the
// cache then held the new endpoint's native result beside the OLD row's fleet
// latency, h3 and QUIC, and the ledger still said `materialUnsynced`. The card's
// Test did the same. Worst case: a customer fixes a rotated password, the native
// check turns green, and the grid shows the old password's fleet failure beside it.
//
// The rule now, on the grid and on the card (one shared step,
// `testSocks5RowOnServer`): push this Mac's row BEFORE the fleet leg; if the push
// fails for a row edited here, skip the fleet leg; and drop a reply if the row was
// edited while the fleet was measuring.
//
// Only the network edges are doubled: the local registry, the native probe, and
// the account calls under measurement. The probe cache and the capability ledger
// are REAL, over an in-memory Tauri store.

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
const NEW_PW = 'NEW_PASSWORD';
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
const { invalidateProbe, saveProbeResult, __resetMaterialEditsForTests } =
  await import('../../src/lib/proxy-probe-cache');

/** What the fleet answers: latency 31, a relay verdict. */
const FLEET_REPLY: AccountProxyTestResult = {
  ok: true,
  latency_ms: 31,
  measured_from: 'fleet',
  node_id: 'mac-mini-07',
  quic_probe: true,
};

function storedProbe(id: string): Record<string, unknown> | undefined {
  const probes = stores.get('proxy-probe-cache.json')?.get('probes') as
    | Record<string, unknown>
    | undefined;
  return probes?.[id] as Record<string, unknown> | undefined;
}

/** The first call's order stamp, across two spies. */
const firstOrder = (fn: { mock: { invocationCallOrder: number[] } }): number =>
  fn.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY;

/** The account calls made AFTER the local edit was saved. The automatic
 *  capability check tests the stored row once at mount, before any edit — that
 *  one is about the material the account really holds, and is not the Test. */
const afterTheEdit = (): string[] => {
  const at = events.indexOf('local-updateProxy');
  return at < 0 ? [] : events.slice(at + 1);
};

beforeEach(() => {
  cleanup();
  stores.clear();
  __resetMaterialEditsForTests();
  stored = [row()];
  events.length = 0;
  testProxy.mockReset();
  testProxy.mockResolvedValue(USABLE);
  testAccountProxy.mockReset();
  testAccountProxy.mockResolvedValue(FLEET_REPLY);
  updateAccountProxy.mockReset();
  updateAccountProxy.mockResolvedValue({ id: 'aprx_1' });
  createAccountProxy.mockReset();
  createAccountProxy.mockResolvedValue({ id: 'aprx_new' });
});

async function editAndSaveOnTheGrid(): Promise<void> {
  render(<ProxiesView />);
  fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
  await screen.findByRole('button', { name: 'Save changes' });
  fireEvent.change(screen.getByDisplayValue(OLD_PW), { target: { value: NEW_PW } });
  fireEvent.change(screen.getByDisplayValue('old.example.com'), {
    target: { value: 'new.example.com' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
}

describe('G3 — a SOCKS5 Test pushes this Mac’s row before the fleet measures it', () => {
  it('CRITICAL (T3, grid) Save of a host + password edit, then the Test: the account row is PUT with the NEW material BEFORE the fleet test is asked for (invocationCallOrder)', async () => {
    await editAndSaveOnTheGrid();
    await waitFor(() => expect(afterTheEdit()).toContain('fleet-test:aprx_1'));
    expect(testProxy).toHaveBeenCalledWith({
      host: 'new.example.com',
      port: 1080,
      username: 'u',
      password: NEW_PW,
    });
    expect(updateAccountProxy, 'the edit reached the account').toHaveBeenCalled();
    const put = updateAccountProxy.mock.calls[0];
    expect(put?.[2]).toBe('aprx_1');
    expect(put?.[3]).toMatchObject({ host: 'new.example.com', password: NEW_PW });
    // invocationCallOrder: the PUT precedes the fleet test that follows the edit.
    const fleetAfterEdit = testAccountProxy.mock.invocationCallOrder.at(-1) ?? 0;
    expect(firstOrder(updateAccountProxy)).toBeLessThan(fleetAfterEdit);
    expect(afterTheEdit()).toEqual(['account-put:aprx_1', 'fleet-test:aprx_1']);
    await waitFor(() => expect(storedProbe('p1')?.serverLatencyMs).toBe(31));
  });

  it('CRITICAL (T3, card) the profile card’s Test PUTs the row before the fleet test too', async () => {
    stored = [{ ...row(), host: 'new.example.com', password: NEW_PW }];
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(updateAccountProxy).toHaveBeenCalled();
    expect(updateAccountProxy.mock.calls[0]?.[3]).toMatchObject({
      host: 'new.example.com',
      password: NEW_PW,
    });
    expect(firstOrder(updateAccountProxy)).toBeLessThan(firstOrder(testAccountProxy));
  });

  it('CRITICAL an edit saved WHILE the fleet was measuring drops that reply — it describes the endpoint before the edit (card: the grid’s epoch already drops it)', async () => {
    stored = [{ ...row(), host: 'new.example.com', password: NEW_PW }];
    testAccountProxy.mockImplementation(async () => {
      // The customer saves another edit of this row while the fleet measures, and
      // the re-test of the NEW endpoint from this Mac lands first — so the old
      // reply would have an entry to land on.
      await invalidateProbe('p1');
      await saveProbeResult('p1', USABLE, Date.now());
      return FLEET_REPLY;
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    // Give the (dropped) write every chance to land.
    await new Promise((r) => setTimeout(r, 50));
    expect(storedProbe('p1'), 'the post-edit entry exists').toBeDefined();
    expect(storedProbe('p1')?.serverLatencyMs, 'the pre-edit reply is not written').toBeUndefined();
    expect(storedProbe('p1')?.quicProbe).toBeUndefined();
  });

  it('CRITICAL when the PUT of an edited row fails, the fleet leg does not run — it would measure the old endpoint — and the row says why', async () => {
    updateAccountProxy.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    await editAndSaveOnTheGrid();
    await waitFor(() => expect(updateAccountProxy).toHaveBeenCalled());
    await waitFor(() => expect(testProxy).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 50));
    expect(
      afterTheEdit().filter((e) => e.startsWith('fleet-test')),
      'no fleet test of the stale account row',
    ).toEqual([]);
    expect(await screen.findByText(/Couldn.t store this proxy on your account/)).toBeTruthy();
  });

  it('CONTROL an unedited stored row whose PUT fails transiently still gets its fleet leg — the account holds exactly this material', async () => {
    updateAccountProxy.mockRejectedValue(Object.assign(new Error('boom'), { status: 500 }));
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByLabelText(/Test proxy from this Mac/));
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(testAccountProxy.mock.calls[0]?.[2]).toBe('aprx_1');
  });
});
