// T-27 (drops 3 and 4) — the profile hub reads the DERIVED probe view, so the
// W-30 QUIC expiry runs there too, and the fleet relay verdict reaches the card.
//
// MEASURED: ProfilesView read `probeCache[px.id].quicMeasured` directly (the
// raw entry), so the TTL that `deriveProbeViewState` applies never ran on the
// hub — a verdict aged out of the Proxies grid stayed green on the card. And
// ProfilePhoneCard called `proxyCapabilities(result, quicMeasured)` with two
// arguments, so the `quic-relay` chip could not exist on a card at all.
//
// The fresh-verdict arm is the vacuity control for the ageing arm: the same
// entry a few minutes younger must render green, or the ageing arm would pass
// on a card that never goes green for any reason.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import type * as ProxiesModule from '../../src/lib/proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import { QUIC_VERDICT_TTL_MS } from '../../src/lib/proxy-probe-cache';

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

// T-27 (drop 2) — what the hub's agent-session list poll sees, per arm.
const { live } = vi.hoisted(() => ({
  live: {
    sessions: [] as Array<{
      id: string;
      created_at: string;
      status: string;
      capability_report?: Record<string, unknown>;
    }>,
    currentSessionId: null as string | null,
  },
}));

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
        list: () => Promise.resolve({ data: live.sessions }),
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
      {
        profileId: 'prof_1',
        defaultProxyId: 'p1',
        currentSessionId: live.currentSessionId,
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

const PROXY: ProxyConfig = {
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

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([PROXY]),
  addProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(() => Promise.resolve(UDP_OK)),
  probeProxyExit: () => Promise.resolve(null),
}));

// Partial mock: the cache imports `cleanMeasuredQuic` from here, and a
// hand-listed factory would make every stored verdict unreadable (the load
// swallows the missing-export throw and returns an empty cache — measured on
// the first run of this file, where all seven arms failed on "no chip").
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  createProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
  updateProxy: vi.fn(() => Promise.resolve({ id: 'aprx_1' })),
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

function seed(quicMeasuredAt: number, extra: Record<string, unknown> = {}): void {
  stores.set(
    'proxy-probe-cache.json',
    new Map<string, unknown>([
      ['probes_schema', 2],
      [
        'probes',
        {
          p1: {
            result: UDP_OK,
            at: Date.now(),
            exitIp: '198.51.100.2',
            exitCountry: 'GB',
            quicMeasured: 'h3',
            quicMeasuredAt,
            quicProbe: true,
            serverLatencyMs: 20,
            measuredFrom: 'fleet',
            nodeId: 'mac-mini-07',
            ...extra,
          },
        },
      ],
    ]),
  );
}

async function quicChip(container: HTMLElement): Promise<HTMLElement> {
  let el: HTMLElement | null = null;
  await waitFor(() => {
    el = container.querySelector('[data-quic-inferred]');
    expect(el).not.toBeNull();
  });
  return el as unknown as HTMLElement;
}

function storedProbe(id: string): Record<string, unknown> | undefined {
  const probes = stores.get('proxy-probe-cache.json')?.get('probes') as
    | Record<string, unknown>
    | undefined;
  return probes?.[id] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  stores.clear();
  live.sessions = [];
  live.currentSessionId = null;
});

describe('T-27 (drop 2) — the hub poll writes a live h3 observation onto the launched proxy', () => {
  const TS = '2026-09-07T09:01:58.747Z';

  it("CRITICAL a live session that observed HTTP/3 stamps the bound proxy 'h3' at the report time", async () => {
    seed(0, { quicMeasured: undefined, quicMeasuredAt: undefined, quicProbe: undefined });
    live.currentSessionId = 'agt_live';
    live.sessions = [
      {
        id: 'agt_live',
        created_at: '2026-09-07T09:00:00Z',
        status: 'active',
        capability_report: { h3_connection_observed: true, timestamp: TS },
      },
    ];
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    await waitFor(() => expect(storedProbe('p1')?.quicMeasured).toBe('h3'));
    expect(storedProbe('p1')?.quicMeasuredAt).toBe(Date.parse(TS));
  });

  it('VACUITY CONTROL — a live session with no h3 signal writes nothing', async () => {
    seed(0, { quicMeasured: undefined, quicMeasuredAt: undefined, quicProbe: undefined });
    live.currentSessionId = 'agt_quiet';
    live.sessions = [
      {
        id: 'agt_quiet',
        created_at: '2026-09-07T09:00:00Z',
        status: 'active',
        capability_report: { streaming_state: 'live', timestamp: TS },
      },
    ];
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    await quicChip(container); // the hub has loaded and polled
    await new Promise((r) => setTimeout(r, 30));
    expect(storedProbe('p1')?.quicMeasured).toBeUndefined();
  });
});

describe('the profile card ages the measured QUIC verdict', () => {
  it('CRITICAL a verdict older than the TTL renders as INFERRED (~), never green', async () => {
    // No relay verdict here so this isolates the LIVE-h3 ageing: with quicProbe:true
    // present the single chip would (correctly) go green from the fresher relay signal.
    seed(Date.now() - QUIC_VERDICT_TTL_MS - 60_000, { quicProbe: undefined });
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await quicChip(container);
    expect(chip.getAttribute('data-quic-inferred')).toBe('true');
    expect(chip.className).not.toContain('status-ready');
    expect(chip.textContent).toContain('~');
  });

  it('VACUITY CONTROL — the same verdict a few minutes old renders GREEN', async () => {
    seed(Date.now() - 5 * 60_000);
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await quicChip(container);
    expect(chip.getAttribute('data-quic-inferred')).toBe('false');
    expect(chip.className).toContain('status-ready');
    expect(chip.textContent).toContain('✓');
  });

  it('CRITICAL a verdict with NO stamp (written after the one-time backfill) is not fresh', async () => {
    // Same isolation: no relay verdict, so an unstamped h3 falls to the inference.
    seed(0, { quicMeasuredAt: undefined, quicProbe: undefined });
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await quicChip(container);
    expect(chip.getAttribute('data-quic-inferred')).toBe('true');
  });
});

describe('the fleet relay verdict reaches the card', () => {
  it('CRITICAL a measured relay verdict (quicProbe true, no live h3) turns the SINGLE QUIC chip green', async () => {
    // 2026-09-09 — no separate "QUIC relayed" chip any more; the relay verdict feeds
    // the one QUIC chip. Seed relay-only (no live h3) so the green comes from it.
    seed(Date.now() - 5 * 60_000, { quicMeasured: undefined, quicMeasuredAt: undefined });
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await quicChip(container);
    expect(container.querySelector('[data-capability="quic-relay"]')).toBeNull();
    expect(chip.getAttribute('data-quic-inferred')).toBe('false');
    expect(chip.className).toContain('status-ready');
  });

  it('a measured NEGATIVE relay (quicProbe false, no live h3) → the single QUIC chip is not green', async () => {
    seed(Date.now() - 5 * 60_000, {
      quicMeasured: undefined,
      quicMeasuredAt: undefined,
      quicProbe: false,
    });
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await quicChip(container);
    expect(container.querySelector('[data-capability="quic-relay"]')).toBeNull();
    expect(chip.getAttribute('data-quic-inferred')).toBe('false');
    expect(chip.className).not.toContain('status-ready');
  });

  it('VACUITY CONTROL — with no relay verdict there is no relay chip', async () => {
    seed(Date.now() - 5 * 60_000, { quicProbe: undefined });
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    await quicChip(container);
    expect(container.querySelector('[data-capability="quic-relay"]')).toBeNull();
  });

  it('the relay chip, like every server value, is gated on the proxy being usable', async () => {
    seed(Date.now() - 5 * 60_000, {
      result: { ...UDP_OK, reachable: false, can_route: false },
    });
    const { container } = render(<ProfilesView onGoToSettings={vi.fn()} />);
    // Phase B: a proxy that is not usable shows the verdict in its health pill
    // and the repair row — no capability chip at all, relay or otherwise.
    await waitFor(() => {
      expect(
        container.querySelector('[data-component="health-pill"][data-health="broken"]'),
      ).not.toBeNull();
    });
    expect(container.querySelector('[data-quic-inferred]')).toBeNull();
    expect(container.querySelector('[data-capability="quic-relay"]')).toBeNull();
  });
});
