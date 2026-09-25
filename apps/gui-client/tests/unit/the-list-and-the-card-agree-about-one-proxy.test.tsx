// 2026-09-17 — ONE PROXY, ONE ANSWER, on the two surfaces a customer reads side
// by side.
//
// The owner: "Still sometimes a proxy was green on quic, and later not green box
// … this needs an audit to make sure it completely shows 100% accurate all the
// time." Part of that was windows and part of it was a clock; this file is the
// third part — two surfaces that DISAGREED about the same cache entry:
//
//  (a) The profiles LIST said nothing about QUIC for a VPN row. A tunnel has no
//      SOCKS5 capabilities to derive chips from, so `caps` was null and the row's
//      QUIC state fell through to "not tested" — while the profile CARD and the
//      Proxies grid showed a measured green for the same proxy from the same
//      cache. The list reads the grid's own four-branch choice now
//      (`vpnQuicReading`, moved to lib/proxy-check-copy for exactly this).
//
//  (b) The list's UDP hover printed a claim ABOUT QUIC deduced from UDP — "UDP
//      not supported — WebRTC and QUIC fall back to slower connections" — in the
//      one branch that never printed the real QUIC clause. A proxy whose HTTP/3
//      was MEASURED working read as falling back, one column away from the card
//      saying it works.
//
//  (c) And the chip itself hid an aged POSITIVE whenever this Mac's own UDP
//      handshake failed, replacing a measured "HTTP/3 worked through this exit"
//      with a present-tense "No UDP — HTTP/3 cannot work here". The two checks
//      disagree; the honest rendering says so instead of picking the weaker one.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

const PROFILE = {
  id: 'prof_1',
  name: 'Demo',
  archetype: 'iphone16pro_ios18_7_safari26_4',
  description: null,
  last_used_at: null,
  created_at: '2026-06-08T00:00:00Z',
  updated_at: '2026-06-08T00:00:00Z',
};

vi.mock('../../src/lib/SettingsContext', () => {
  const stable = {
    client: {
      profiles: {
        list: () => Promise.resolve({ data: [PROFILE] }),
        // eslint-disable-next-line @typescript-eslint/require-await
        iterate: async function* () {
          yield PROFILE;
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
}));

/** Which kind of row `p1` is, per arm. */
const { rowRef } = vi.hoisted(() => ({
  rowRef: { vpn: false },
}));

function proxy(): ProxyConfig {
  return rowRef.vpn
    ? {
        id: 'p1',
        label: 'berlin-vpn',
        host: 'vpn.example.com',
        port: 1194,
        username: null,
        password: null,
        createdAt: '2026-05-20T00:00:00.000Z',
        scheme: 'openvpn',
        serverId: 'aprx_1',
        openvpn: { config_blob: 'client\nremote vpn.example.com 1194\n' },
      }
    : {
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
}

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => Promise.resolve([proxy()]),
  addProxy: vi.fn(),
  setProxyServerId: vi.fn(() => Promise.resolve()),
  testProxy: vi.fn(),
  probeProxyExit: () => Promise.resolve(null),
}));
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

const MIN = 60_000;
const HOUR = 60 * MIN;

/** This Mac's own handshake: healthy, but UDP-ASSOCIATE REFUSED. That refusal is
 *  what used to suppress the measured QUIC reading beside it. */
const NO_UDP: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: false,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};
/** The fail-closed placeholder a VPN row's cache entry carries. */
const PLACEHOLDER: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'endpoint check only',
};

function seed(entry: Record<string, unknown>): void {
  stores.set(
    'proxy-probe-cache.json',
    new Map<string, unknown>([
      ['probes_schema', 3],
      ['probes', { p1: entry }],
    ]),
  );
}

/** The list's UDP cell — the one whose hover carries the QUIC clause. */
async function listUdpTitle(): Promise<string> {
  fireEvent.click(await screen.findByRole('button', { name: /List/ }));
  let title: string | null = null;
  await waitFor(() => {
    title =
      document.querySelector('table td [title^="UDP works"]')?.getAttribute('title') ??
      document.querySelector('table td [title^="UDP not supported"]')?.getAttribute('title') ??
      document.querySelector('table td [title^="UDP relays"]')?.getAttribute('title') ??
      document
        .querySelector('table td [title^="No UDP through this tunnel"]')
        ?.getAttribute('title') ??
      // ⛔ (2026-09-17 review) THE BRANCH ALMOST EVERY REAL VPN ROW LANDS IN,
      // and it was not in this list — which is why every VPN arm below had to seed
      // a measured `udpProbe` to find anything at all. Today's Mac ASSERTS
      // `udp_associate: true` on a tunnel and the control plane drops the
      // assertion, so a tunnel's UDP is NOT MEASURED until one really probes it,
      // and the cell renders the "UDP via tunnel" pill instead of a verdict chip.
      document
        .querySelector('table td [title^="UDP through this tunnel has not been measured"]')
        ?.getAttribute('title') ??
      null;
    expect(title).not.toBeNull();
  });
  return title as unknown as string;
}

async function cardQuicChip(): Promise<Element> {
  let el: Element | null = null;
  await waitFor(() => {
    el = document.querySelector('[data-region="caps"] [data-quic-inferred]');
    expect(el).not.toBeNull();
  });
  return el as unknown as Element;
}

beforeEach(() => {
  stores.clear();
  rowRef.vpn = false;
  window.localStorage.clear();
});
afterEach(cleanup);

describe('a SOCKS5 row whose two checks DISAGREE says so, identically on both surfaces', () => {
  it('CRITICAL an AGED POSITIVE QUIC reading survives a failed native UDP handshake — on the card, as the aged chip, and in the list’s hover, as the same sentence. MUTATION: restore `nothingCurrent && udp && agedQuic !== undefined` in proxyCapabilities and BOTH halves red', async () => {
    seed({
      result: NO_UDP,
      at: Date.now() - MIN,
      quicProbe: true,
      quicProbeAt: Date.now() - 9 * HOUR,
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);

    const chip = await cardQuicChip();
    await waitFor(() => expect(chip.getAttribute('data-ok')).toBe('aged'));
    expect(chip.getAttribute('data-aged-value')).toBe('true');
    const cardHint = chip.getAttribute('title') ?? '';
    expect(cardHint).toContain('Last checked 9 hours ago.');
    expect(cardHint).toContain('HTTP/3 worked through this exit then');
    // ⛔ The words it must NOT use: a present-tense verdict about a measurement
    // this Mac never made.
    expect(cardHint).not.toContain('HTTP/3 cannot work here');
    // …and it says WHY the two readings look contradictory, rather than hiding one.
    expect(cardHint).toContain('the two checks disagree');

    const listHint = await listUdpTitle();
    expect(listHint).toContain('UDP not supported');
    expect(listHint, 'the list prints the card’s own sentence').toContain(
      'HTTP/3 worked through this exit then',
    );
    expect(listHint).not.toContain('WebRTC and QUIC fall back to slower connections');
  });

  it('CONTROL — an aged NEGATIVE is NOT promoted over the present-tense one: both say no HTTP/3, and the current one says it in the present tense', async () => {
    seed({
      result: NO_UDP,
      at: Date.now() - MIN,
      quicProbe: false,
      quicProbeAt: Date.now() - 9 * HOUR,
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await cardQuicChip();
    await waitFor(() => expect(chip.getAttribute('data-quic-inferred')).toBe('false'));
    expect(chip.getAttribute('data-ok')).not.toBe('aged');
    expect(chip.getAttribute('title')).toBe(
      'No UDP — HTTP/3 cannot work here; it falls back to HTTP/2.',
    );
  });

  it('CONTROL — with UDP WORKING, a measured green reaches both surfaces in the present tense and neither mentions a disagreement', async () => {
    seed({
      result: { ...NO_UDP, udp_associate: true },
      at: Date.now() - MIN,
      quicProbe: true,
      quicProbeAt: Date.now() - MIN,
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const chip = await cardQuicChip();
    await waitFor(() => expect(chip.textContent).toBe('✓ QUIC'));
    expect(chip.getAttribute('title')).toBe(
      'This proxy carries QUIC — HTTP/3 works through this exit.',
    );
    const listHint = await listUdpTitle();
    expect(listHint).toBe(
      'UDP works — WebRTC calls and media stream through this exit. HTTP/3 works.',
    );
    expect(listHint).not.toContain('disagree');
  });
});

describe('a VPN row’s QUIC reading reaches the profiles LIST at all', () => {
  it('CRITICAL a tunnel with a MEASURED relay verdict reads "✓ QUIC" in the list, not "QUIC not tested" — the list had no way to derive a tunnel’s QUIC state and said "not tested" about every one of them, beside a card showing the green. MUTATION: drop the `vpnQuic` branch in ProfilesView’s row derivation and this reds', async () => {
    rowRef.vpn = true;
    seed({
      result: PLACEHOLDER,
      at: Date.now() - MIN,
      endpoint: { resolved: true, ip: '198.51.100.7', message: 'ok' },
      measuredFrom: 'fleet',
      nodeId: 'mac-mini-07',
      serverLatencyMs: 61,
      serverProbeAt: Date.now() - MIN,
      quicProbe: true,
      quicProbeAt: Date.now() - MIN,
      udpProbe: true,
      udpProbeAt: Date.now() - MIN,
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const listHint = await listUdpTitle();
    expect(listHint).toContain('UDP relays through this tunnel');
    // In words (gui-v0.1.73 review: it read "QUIC ✓", the mark after the word).
    expect(listHint).toContain('HTTP/3 works.');
    expect(listHint).not.toMatch(/QUIC not tested|HTTP\/3 has not been measured/);
  });

  it('CRITICAL a tunnel with an AGED relay verdict gets the aged SENTENCE in the list, in the past tense — not a green tick and not "not tested"', async () => {
    rowRef.vpn = true;
    seed({
      result: PLACEHOLDER,
      at: Date.now() - MIN,
      endpoint: { resolved: true, ip: '198.51.100.7', message: 'ok' },
      measuredFrom: 'fleet',
      serverLatencyMs: 61,
      serverProbeAt: Date.now() - MIN,
      quicProbe: true,
      quicProbeAt: Date.now() - 9 * HOUR,
      udpProbe: true,
      udpProbeAt: Date.now() - MIN,
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const listHint = await listUdpTitle();
    expect(listHint).toContain('Last checked 9 hours ago.');
    expect(listHint).toContain('QUIC worked through this VPN then.');
    expect(listHint).not.toMatch(/✓ QUIC/);
  });

  it("CRITICAL a tunnel whose UDP was NEVER MEASURED still prints its measured QUIC verdict, and never a UDP negative — the normal state of every VPN row, and the one no other arm here covers. MUTATION: revert `udpCellTitle` to the two-way `r.udp === 'ok' ? OK : NONE` and point the pill back at the bare VPN_UDP_NOT_MEASURED_TITLE, and this reds", async () => {
    // ⛔ WHY THIS FIXTURE HAS NO `udpProbe`. Every other VPN arm in this file
    // seeds one, so `r.udp` is always 'ok' and the cell always reaches the verdict
    // chip. In production it is the other way round: the control plane refuses to
    // forward the Mac's asserted `udp_associate`, so a tunnel is 'unknown' until
    // something measures it, and the cell renders the "UDP via tunnel" pill. The
    // QUIC clause added for this item therefore reached almost NO tunnel — a
    // customer with a measured green on the card read nothing about QUIC in the
    // list, which is the disagreement this file exists to close.
    rowRef.vpn = true;
    seed({
      result: PLACEHOLDER,
      at: Date.now() - MIN,
      endpoint: { resolved: true, ip: '198.51.100.7', message: 'ok' },
      measuredFrom: 'fleet',
      serverLatencyMs: 61,
      serverProbeAt: Date.now() - MIN,
      quicProbe: true,
      quicProbeAt: Date.now() - MIN,
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const listHint = await listUdpTitle();
    // The measurement reaches the list… (in words — it read "QUIC ✓")
    expect(listHint).toContain('HTTP/3 works.');
    // …beside an honest ABSENCE, never a fabricated negative. A customer must not
    // be told their tunnel lacks UDP because nobody looked (the rule written on
    // VPN_UDP_MEASURED_NONE_TITLE itself), and least of all in the same breath as
    // a green QUIC tick, which would make the one tooltip contradict itself.
    expect(listHint).toContain('has not been measured yet');
    expect(listHint).not.toContain('No UDP through this tunnel');
    expect(listHint).not.toMatch(/(QUIC|HTTP\/3) falls back to HTTP\/2/);
  });

  it('VACUITY CONTROL — a tunnel nothing has measured still says so: the arm above is not "the list always claims QUIC"', async () => {
    rowRef.vpn = true;
    seed({
      result: PLACEHOLDER,
      at: Date.now() - MIN,
      endpoint: { resolved: true, ip: '198.51.100.7', message: 'ok' },
      measuredFrom: 'fleet',
      serverLatencyMs: 61,
      serverProbeAt: Date.now() - MIN,
      udpProbe: true,
      udpProbeAt: Date.now() - MIN,
    });
    render(<ProfilesView onGoToSettings={vi.fn()} />);
    const listHint = await listUdpTitle();
    expect(listHint).toContain('UDP relays through this tunnel');
    expect(listHint).not.toMatch(/✓ QUIC/);
    expect(listHint).not.toContain('worked through this VPN then');
  });
});
