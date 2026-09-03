// T-1: "Proxy measurements, latency, ping all this should be measured from the
// Mac that will run the profile, not from local." The customer must SEE where a
// number was measured. Two surfaces: the QUIC-relay chip and the latency label.
//
// MEASURED mechanism, chip half: proxyCapabilities(result, quicMeasured,
// quicProbe) appends a SEPARATE 'quic-relay' chip for the fleet Mac's standalone
// QUIC handshake — true → green "QUIC relayed", false → a measured negative
// (data-inferred="false", no '~'), undefined → no chip at all. The pre-existing
// QUIC chip reads quicMeasured (a live session's HTTP/3) and NOTHING else: its
// rendering is byte-for-byte identical whatever quicProbe says. Their
// disagreement is a finding (a proxy that relays QUIC while a session saw
// h2-only), and merging the two would erase it.
//
// MEASURED mechanism, label half: beside a server-measured latency the grid row
// (ProxiesView) and the profile card (ProfilePhoneCard) render vantageLabel():
// 'fleet' → "from a fleet Mac" with the node id in the hover text,
// 'control_plane' → "from the server" with why ("No fleet Mac was free") — the
// fallback is visible, never silent. The grid arm drives the real Test action:
// it must ask the server for the fleet vantage ({ vantage: 'fleet' }) and put
// the reply's label on the row.
//
// One property per assertion. VACUITY CONTROLS: undefined renders NO relay chip
// (so the "chip exists" arms are not passing on a chip that is always there),
// and a server number WITHOUT a vantage keeps today's plain "server" marker (so
// the label arms are not passing on a label that is always printed).

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ProxyCapabilityChips, proxyCapabilities } from '../../src/components/ProxyCapabilities';
import {
  ProfilePhoneCard,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type { AccountProxyTestResult } from '../../src/lib/account-proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';

// A fully usable, UDP-relaying exit: its QUIC chip is the INFERRED '~' until a
// session measures it — the exact state a relay verdict must NOT be allowed to
// promote.
const UDP_OK: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 12,
  message: 'ok',
};

function chips(
  quicMeasured: 'h3' | 'h2-only' | null | undefined,
  quicProbe: boolean | undefined,
): { quic: Element | null; relay: Element | null } {
  const { container } = render(
    <ProxyCapabilityChips result={UDP_OK} quicMeasured={quicMeasured} quicProbe={quicProbe} />,
  );
  return {
    quic: container.querySelector('[data-capability="quic"]'),
    relay: container.querySelector('[data-capability="quic-relay"]'),
  };
}

describe('the QUIC-relay chip is its own, measured chip', () => {
  it('quicProbe true renders a relay chip', () => {
    expect(chips(undefined, true).relay).not.toBeNull();
  });

  it('quicProbe true renders it GREEN (a measurement, not an inference)', () => {
    const relay = chips(undefined, true).relay;
    expect(relay?.className).toContain('status-ready');
    expect(relay?.getAttribute('data-inferred')).toBe('false');
  });

  it('quicProbe true reads "QUIC relayed"', () => {
    expect(chips(undefined, true).relay?.textContent).toContain('QUIC relayed');
  });

  it('quicProbe true says it was measured from a fleet Mac', () => {
    expect(chips(undefined, true).relay?.getAttribute('title')).toContain(
      'measured from a fleet Mac',
    );
  });

  it('quicProbe false renders a measured NEGATIVE — not-ok, not inferred, no "~"', () => {
    const relay = chips(undefined, false).relay;
    expect(relay).not.toBeNull();
    expect(relay?.getAttribute('data-ok')).toBe('false');
    expect(relay?.getAttribute('data-inferred')).toBe('false');
    expect(relay?.textContent).not.toContain('~');
  });

  it('quicProbe false reads "QUIC not relayed" and is not green', () => {
    const relay = chips(undefined, false).relay;
    expect(relay?.textContent).toContain('QUIC not relayed');
    expect(relay?.className).not.toContain('status-ready');
  });

  it('quicProbe false also says it was measured from a fleet Mac', () => {
    expect(chips(undefined, false).relay?.getAttribute('title')).toContain(
      'measured from a fleet Mac',
    );
  });

  it('VACUITY CONTROL — quicProbe undefined renders NO relay chip', () => {
    expect(chips(undefined, undefined).relay).toBeNull();
  });

  it('VACUITY CONTROL — undefined leaves exactly the three chips of today', () => {
    expect(proxyCapabilities(UDP_OK, undefined).map((c) => c.key)).toEqual([
      'webrtc',
      'quic',
      'http2',
    ]);
  });
});

describe('the QUIC-relay chip NEVER alters the measured-QUIC chip', () => {
  // The whole never-merge rule, across every combination: the QUIC chip's DOM
  // is identical with and without a relay verdict. A merge in either direction
  // (relay true → green session chip; relay false → measured negative) reds one
  // of these cells.
  for (const measured of [undefined, null, 'h3', 'h2-only'] as const) {
    for (const probe of [true, false] as const) {
      it(`quicMeasured=${String(measured)} renders the same QUIC chip with quicProbe=${String(probe)}`, () => {
        const without = chips(measured, undefined).quic?.outerHTML;
        const withProbe = chips(measured, probe).quic?.outerHTML;
        expect(without).toBeDefined();
        expect(withProbe).toBe(without);
      });
    }
  }

  it('an UNMEASURED session chip stays inferred "~" even when the fleet Mac relayed QUIC', () => {
    // The sharpest cell: the mutation "quic_ok → quicMeasured='h3'" would turn
    // this chip green from a probe that never ran a session.
    const quic = chips(undefined, true).quic;
    expect(quic?.getAttribute('data-inferred')).toBe('true');
    expect(quic?.className).not.toContain('status-ready');
    expect(quic?.textContent).toContain('~');
  });

  it('the two chips may disagree, and both verdicts are kept', () => {
    const caps = proxyCapabilities(UDP_OK, 'h2-only', true);
    expect(caps.find((c) => c.key === 'quic')?.ok).toBe(false); // the session saw no HTTP/3
    expect(caps.find((c) => c.key === 'quic-relay')?.ok).toBe(true); // …yet the proxy relays QUIC
  });
});

// ── The latency label on the profile card ─────────────────────────────────

function cardProps(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
  return {
    name: 'amsterdam shopper',
    monogram: 'AS',
    hue: 200,
    deviceLabel: 'iPhone 17',
    running: false,
    selected: false,
    lastUsedIso: null,
    folder: '',
    tags: [],
    hasProxy: true,
    proxyExplicit: true,
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    latencyMs: 42,
    latencyFillPct: 30,
    latencyGood: true,
    probed: true,
    capabilities: UDP_OK,
    checkedAtIso: null,
    busy: false,
    launching: false,
    anyBusy: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    onToggleSelect: vi.fn(),
    onPrimary: vi.fn(),
    onWatch: vi.fn(),
    onTest: vi.fn(),
    ...over,
  };
}

describe('the profile card labels a server latency with where it was measured', () => {
  it('\'fleet\' reads "from a fleet Mac"', () => {
    render(
      <ProfilePhoneCard
        {...cardProps({
          latencyFromServer: true,
          latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-07' },
        })}
      />,
    );
    expect(screen.getByText('from a fleet Mac')).toBeInTheDocument();
  });

  it("'fleet' names the node in the hover text on the number", () => {
    const { container } = render(
      <ProfilePhoneCard
        {...cardProps({
          latencyFromServer: true,
          latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-07' },
        })}
      />,
    );
    const el = container.querySelector('[data-latency-vantage="fleet"]');
    expect(el?.getAttribute('title')).toContain('mac-mini-07');
  });

  it('\'control_plane\' reads "from the server" and says why', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...cardProps({
          latencyFromServer: true,
          latencyVantage: { measuredFrom: 'control_plane' },
        })}
      />,
    );
    expect(screen.getByText('from the server')).toBeInTheDocument();
    const el = container.querySelector('[data-latency-vantage="control_plane"]');
    expect(el?.getAttribute('title')).toContain('No fleet Mac was free');
  });

  it('VACUITY CONTROL — a server number with no vantage keeps today\'s plain "server" marker', () => {
    render(<ProfilePhoneCard {...cardProps({ latencyFromServer: true })} />);
    expect(screen.getByText('server')).toBeInTheDocument();
    expect(screen.queryByText('from a fleet Mac')).toBeNull();
    expect(screen.queryByText('from the server')).toBeNull();
  });

  it('a native number carries no vantage marker at all', () => {
    const { container } = render(<ProfilePhoneCard {...cardProps()} />);
    expect(container.querySelector('[data-latency-vantage="this_mac"]')).not.toBeNull();
    expect(screen.queryByText('server')).toBeNull();
    expect(screen.queryByText('from a fleet Mac')).toBeNull();
  });
});

// ── The latency column on the Proxies grid, through the real Test action ──

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const listProxies = vi.fn<() => Promise<ProxyConfig[]>>();
const testAccountProxy =
  vi.fn<
    (
      baseUrl: string,
      apiKey: string,
      id: string,
      opts?: { vantage?: 'cp' | 'fleet' },
    ) => Promise<AccountProxyTestResult>
  >();

const savedProxy: ProxyConfig = {
  id: 'p1',
  label: 'london-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  // Stored on the account, so the row's Test also runs the server-side test.
  serverId: 'aprx_1',
};

// Partial mock: the pure predicates (isProxyUsable, proxyVerdict) stay REAL so
// this suite cannot disagree with the app about what "usable" means; only the
// native calls are replaced.
vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => listProxies(),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
}));

// Partial mock: every real export stays (proxy-probe-cache imports
// cleanMeasuredQuic from here), only the network call is replaced.
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (
    baseUrl: string,
    apiKey: string,
    id: string,
    opts?: { vantage?: 'cp' | 'fleet' },
  ) => testAccountProxy(baseUrl, apiKey, id, opts),
}));

const settingsStub = { settings: { apiKey: 'ds_test', baseUrl: 'http://localhost:3000' } };
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

const { ProxiesView } = await import('../../src/views/ProxiesView');

async function testTheRow(): Promise<void> {
  fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
}

describe('the Proxies grid labels the server latency with where it was measured', () => {
  beforeEach(() => {
    listProxies.mockReset();
    listProxies.mockResolvedValue([savedProxy]);
    testProxy.mockReset();
    testProxy.mockResolvedValue({ ...UDP_OK, latency_ms: 42 });
    testAccountProxy.mockReset();
  });

  it("the Test action asks the server for the FLEET vantage ({ vantage: 'fleet' })", async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    });
    render(<ProxiesView />);
    await testTheRow();
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(1));
    expect(testAccountProxy.mock.calls[0]?.[3]).toEqual({ vantage: 'fleet' });
  });

  it('a fleet reply labels the latency "from a fleet Mac"', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    });
    render(<ProxiesView />);
    await testTheRow();
    expect(await screen.findByText('from a fleet Mac')).toBeInTheDocument();
  });

  it('a fleet reply shows the fleet number and names the node in the hover text', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('from a fleet Mac');
    const cell = container.querySelector('[data-latency-vantage="fleet"]');
    expect(cell?.getAttribute('title')).toContain('mac-mini-07');
    expect(cell?.textContent).toContain('31ms');
  });

  it('a fleet reply puts the relay chip on the row, and leaves the session QUIC chip inferred', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('from a fleet Mac');
    expect(container.querySelector('[data-capability="quic-relay"]')).not.toBeNull();
    expect(container.querySelector('[data-capability="quic"]')?.getAttribute('data-inferred')).toBe(
      'true',
    );
  });

  it('a control-plane fallback labels the latency "from the server" — visibly, never silently', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 88,
      measured_from: 'control_plane',
    });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    expect(await screen.findByText('from the server')).toBeInTheDocument();
    const cell = container.querySelector('[data-latency-vantage="control_plane"]');
    expect(cell?.getAttribute('title')).toContain('No fleet Mac was free');
  });

  it('a control-plane fallback renders no relay chip', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 88,
      measured_from: 'control_plane',
    });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('from the server');
    expect(container.querySelector('[data-capability="quic-relay"]')).toBeNull();
  });

  it('VACUITY CONTROL — a reply with no vantage keeps today\'s plain "server" marker', async () => {
    testAccountProxy.mockResolvedValue({ ok: true, latency_ms: 88 });
    render(<ProxiesView />);
    await testTheRow();
    expect(await screen.findByText('server')).toBeInTheDocument();
    expect(screen.queryByText('from a fleet Mac')).toBeNull();
    expect(screen.queryByText('from the server')).toBeNull();
  });
});
