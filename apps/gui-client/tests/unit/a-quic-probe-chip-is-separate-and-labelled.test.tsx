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
// 'fleet' → "from the test Mac" with the node id in the hover text,
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

// 2026-09-09: the design changed. There is no longer a SEPARATE "QUIC relayed"
// chip beside the QUIC chip — operators read the two as contradictory badges. QUIC
// is now ONE verdict fed by the strongest evidence available: a live h3 > a live
// h2-only > the fleet relay probe > the UDP inference. These arms pin that model
// and, by asserting a single chip, guard against a regression to two badges.
describe('QUIC is ONE verdict, strongest evidence first (no separate relay chip)', () => {
  it('the capability keys are exactly webrtc, quic, http2 — never a quic-relay chip', () => {
    for (const probe of [true, false, undefined] as const) {
      expect(proxyCapabilities(UDP_OK, undefined, probe).map((c) => c.key)).toEqual([
        'webrtc',
        'quic',
        'http2',
      ]);
    }
  });

  it('quicProbe true → the single QUIC chip is GREEN and measured (not inferred), no relay chip', () => {
    const { quic, relay } = chips(undefined, true);
    expect(relay).toBeNull();
    expect(quic?.className).toContain('status-ready');
    expect(quic?.getAttribute('data-inferred')).toBe('false');
    expect(quic?.textContent).not.toContain('~');
  });

  it('quicProbe true names the fleet-Mac relay measurement in the hint', () => {
    expect(chips(undefined, true).quic?.getAttribute('title')).toContain('test Mac');
  });

  it('quicProbe false → the single QUIC chip is a measured NEGATIVE (not green, not inferred, no "~")', () => {
    const { quic } = chips(undefined, false);
    expect(quic?.getAttribute('data-ok')).toBe('false');
    expect(quic?.getAttribute('data-inferred')).toBe('false');
    expect(quic?.className).not.toContain('status-ready');
    expect(quic?.textContent).not.toContain('~');
  });

  it('a live h3 measurement OUTRANKS the relay probe — green either way', () => {
    expect(chips('h3', false).quic?.className).toContain('status-ready');
    expect(chips('h3', true).quic?.getAttribute('data-inferred')).toBe('false');
  });

  it('a live h2-only measurement OUTRANKS a relay-true — measured negative, not green', () => {
    const { quic } = chips('h2-only', true);
    expect(quic?.getAttribute('data-ok')).toBe('false');
    expect(quic?.getAttribute('data-inferred')).toBe('false');
    expect(quic?.className).not.toContain('status-ready');
  });

  it('VACUITY CONTROL — nothing measured on a UDP-relaying exit stays INFERRED "~", never green', () => {
    const { quic } = chips(undefined, undefined);
    expect(quic?.getAttribute('data-inferred')).toBe('true');
    expect(quic?.className).not.toContain('status-ready');
    expect(quic?.textContent).toContain('~');
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

// Phase B (2026-09-11): the card's latency is its ONE health pill
// (`[data-component="health-pill"]`, a fixed 20px status row). The words that
// said WHERE the number was measured were a visible label + a 26px bar in a row
// that no longer exists (D2); they are the pill's title now, and the pill keeps
// `data-latency-vantage` so the provenance is still machine-readable.
describe('the profile card labels a server latency with where it was measured', () => {
  const pillOf = (container: HTMLElement): HTMLElement => {
    const el = container.querySelector('[data-component="health-pill"]');
    if (el === null) throw new Error('no health pill');
    return el as HTMLElement;
  };

  it("'fleet' says it was measured from the Mac that runs your profiles", () => {
    const { container } = render(
      <ProfilePhoneCard
        {...cardProps({
          latencyFromServer: true,
          latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-07' },
        })}
      />,
    );
    expect(pillOf(container).textContent).toBe('42ms');
    expect(pillOf(container).getAttribute('title')).toContain(
      'Measured from the Mac that runs your profiles',
    );
    expect(pillOf(container).getAttribute('title')).not.toMatch(/not your computer\.$/);
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
    expect(el).toBe(pillOf(container));
    expect(el?.getAttribute('title')).toContain('mac-mini-07');
  });

  it("'control_plane' says it came from the server and why", () => {
    const { container } = render(
      <ProfilePhoneCard
        {...cardProps({
          latencyFromServer: true,
          latencyVantage: { measuredFrom: 'control_plane' },
        })}
      />,
    );
    const el = container.querySelector('[data-latency-vantage="control_plane"]');
    expect(el).toBe(pillOf(container));
    expect(el?.getAttribute('title')).toContain('No test Mac was free');
  });

  it("VACUITY CONTROL — a server number with no vantage keeps today's plain server sentence", () => {
    const { container } = render(<ProfilePhoneCard {...cardProps({ latencyFromServer: true })} />);
    const el = container.querySelector('[data-latency-vantage="server"]');
    expect(el).toBe(pillOf(container));
    expect(el?.getAttribute('title')).toContain('Measured from Driftstack, not your computer.');
    expect(el?.getAttribute('title')).not.toMatch(/test Mac|No test Mac was free/);
  });

  it('a native number carries the this-Mac marker and no server words', () => {
    const { container } = render(<ProfilePhoneCard {...cardProps()} />);
    const el = container.querySelector('[data-latency-vantage="this_mac"]');
    expect(el).toBe(pillOf(container));
    expect(el?.getAttribute('title')).toContain('Measured from your computer');
    expect(el?.getAttribute('title')).not.toMatch(/Driftstack|test Mac/);
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

  it('CRITICAL a FAILED server test clears the numbers a previous one left behind', async () => {
    // ⛔ The native probe from this Mac can call a proxy usable while the server —
    // which is what actually runs the profile — cannot use it at all. Until the
    // fleet vantage learned to report that honestly, a fleet result was never
    // `ok:false` and this path could not be reached; now a proxy that answers
    // nothing produces one. Without the clear, the row keeps the fleet latency,
    // its "from the test Mac" label and the relay chip from the LAST successful
    // test, sitting next to a row the customer has just re-tested.
    testAccountProxy.mockResolvedValueOnce({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    });
    render(<ProxiesView />);
    await testTheRow();
    expect(await screen.findByText('from the test Mac')).toBeInTheDocument();

    // Second test: the server now refuses it.
    testAccountProxy.mockResolvedValueOnce({
      ok: false,
      reason: 'The proxy did not answer. Check the host and port, and that it is online.',
      measured_from: 'fleet',
    });
    // The action reads "Test" only until a result exists; after one it is
    // "Re-test" (and "Testing…" while in flight). Waiting for that exact label is
    // also the signal that the first probe has fully settled.
    const retest = await screen.findByRole('button', { name: 'Re-test' });
    fireEvent.click(retest);
    await waitFor(() => expect(testAccountProxy).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.queryByText('from the test Mac')).not.toBeInTheDocument();
    });
  });

  it('a fleet reply labels the latency "from the test Mac"', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    });
    render(<ProxiesView />);
    await testTheRow();
    expect(await screen.findByText('from the test Mac')).toBeInTheDocument();
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
    await screen.findByText('from the test Mac');
    const cell = container.querySelector('[data-latency-vantage="fleet"]');
    expect(cell?.getAttribute('title')).toContain('mac-mini-07');
    expect(cell?.textContent).toContain('31ms');
  });

  it('a fleet reply with quic_probe:true turns the SINGLE QUIC chip green (no separate relay chip)', async () => {
    testAccountProxy.mockResolvedValue({
      ok: true,
      latency_ms: 31,
      measured_from: 'fleet',
      node_id: 'mac-mini-07',
      quic_probe: true,
    });
    const { container } = render(<ProxiesView />);
    await testTheRow();
    await screen.findByText('from the test Mac');
    expect(container.querySelector('[data-capability="quic-relay"]')).toBeNull();
    const quic = container.querySelector('[data-capability="quic"]');
    expect(quic?.getAttribute('data-inferred')).toBe('false');
    expect(quic?.className).toContain('status-ready');
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
    expect(cell?.getAttribute('title')).toContain('No test Mac was free');
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
    expect(screen.queryByText('from the test Mac')).toBeNull();
    expect(screen.queryByText('from the server')).toBeNull();
  });
});
