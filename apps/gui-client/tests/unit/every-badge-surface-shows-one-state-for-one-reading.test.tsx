// Owner item 9 (2026-09-24, verbatim): "The UDP, QUIC, Apple badges not always
// show currently still at auto proxy state detection. Has not been measured, but
// QUIC did, or the other way around, it's very confusing, they should all always
// show accurate stats. And if it's a Apple, it should be green status, which we
// don't always have, again all of this stuff needs another audit to work better."
//
// The surfaces half (the cache and the wire halves have their own files:
// an-automatic-reading-lands-in-the-same-badge-state-as-a-test.test.ts and
// a-proxy-test-in-the-servers-customer-words-lands-in-the-same-state.test.ts).
//
// ROOT CAUSES pinned here:
//   1. An OS reading of Apple was green only from two vantages. From the others —
//      a reading of the proxy's entry point, a multi-machine proxy, and every
//      reading stored before the vantage flags existed — it was a neutral "? OS"
//      / "? Apple"; past eight hours it lost its colour on every surface; and the
//      Simulator printed the raw wire value `OS: macos-or-ios · high`, neutral,
//      at any age. Now: Apple is green everywhere, fresh or aged; the red arm is
//      unchanged (a mismatch still needs the vantage that supports it).
//   2. A SOCKS5 proxy this Mac never tested, but Driftstack did, had its UDP and
//      QUIC readings drawn nowhere: the grid said "untested" and the card showed
//      only "Test ✓ Apple" beside them. Both now draw the same chips a tested row
//      draws, from Driftstack's readings.
//   3. While a Test runs on a row with nothing measured yet, the grid's network
//      chip said "untested" beside "… OS". It says the test is running now.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ProxyConfig, ProxyTestResult } from '../../src/lib/proxies';
import type * as ProxiesModule from '../../src/lib/proxies';
import type { AccountProxyTestResult } from '../../src/lib/account-proxies';
import type * as AccountProxiesModule from '../../src/lib/account-proxies';
import type { ProbeCacheMap } from '../../src/lib/proxy-probe-cache';
import type * as ProbeCacheModule from '../../src/lib/proxy-probe-cache';
import {
  agedOsFingerprintVerdict,
  osFingerprintVerdict,
  type OsFingerprint,
} from '../../src/lib/os-fingerprint-verdict';
import { ProxyCapabilityChips, ProxyOsChip } from '../../src/components/ProxyCapabilities';
import {
  ProfilePhoneCard,
  capsMode,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import { agedOsVerdictFor } from '../../src/components/ProfilesTable';
import { OsReadout } from '../../src/components/OsReadout';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const HOUR = 3_600_000;

/** Every vantage an Apple reading can arrive from. */
const APPLE_READINGS: ReadonlyArray<[string, OsFingerprint]> = [
  [
    'the web port (a website’s path)',
    {
      os: 'macos-or-ios',
      confidence: 'high',
      reason: 'r',
      observedVia: 'proxy_host',
      webPortVantage: true,
    },
  ],
  [
    'a single-host proxy',
    {
      os: 'macos-or-ios',
      confidence: 'high',
      reason: 'r',
      observedVia: 'exit_ip',
      singleHostVantage: true,
    },
  ],
  [
    'a multi-machine proxy (and every reading stored before the vantage flags)',
    { os: 'macos-or-ios', confidence: 'medium', reason: 'r', observedVia: 'exit_ip' },
  ],
  [
    'only the proxy’s entry point, on the observer port',
    { os: 'macos-or-ios', confidence: 'high', reason: 'r', observedVia: 'proxy_host' },
  ],
];

describe('owner item 9 — an Apple reading is green on every surface, at every age', () => {
  for (const [from, fp] of APPLE_READINGS) {
    it(`CRITICAL from ${from}: ✓ iOS/macOS, the match tone`, () => {
      const v = osFingerprintVerdict(fp);
      expect(v.tone).toBe('match');
      expect(v.glyph).toBe('✓');
      expect(v.label).toBe('iOS/macOS');
    });
  }

  it('what a weaker vantage cannot rule out is still SAID — in the hint, never by withholding the colour', () => {
    const v = osFingerprintVerdict(APPLE_READINGS[2]![1]);
    expect(v.hint).toMatch(/matches the iOS device/);
    expect(v.hint).toMatch(/some websites may reach a different one/);
  });

  it('VACUITY: the red arm is unchanged — a Windows reading a multi-machine proxy gave is still a neutral "?", never red', () => {
    const v = osFingerprintVerdict({
      os: 'windows',
      confidence: 'high',
      reason: 'r',
      observedVia: 'exit_ip',
    });
    expect(v.tone).toBe('unknown');
    expect(v.glyph).toBe('?');
    const red = osFingerprintVerdict({
      os: 'windows',
      confidence: 'high',
      reason: 'r',
      observedVia: 'exit_ip',
      singleHostVantage: true,
    });
    expect(red.tone).toBe('mismatch');
  });

  it('CRITICAL an AGED Apple reading keeps the green (dashed and dated); an aged Windows reading does not', () => {
    const fp = APPLE_READINGS[0]![1];
    const aged = agedOsFingerprintVerdict(fp, NOW - 9 * HOUR, NOW);
    expect(aged.aged).toBe(true);
    expect(aged.tone).toBe('match');
    expect(aged.hint).toMatch(/9 hours ago/);
    const win = agedOsFingerprintVerdict(
      {
        os: 'windows',
        confidence: 'high',
        reason: 'r',
        observedVia: 'exit_ip',
        singleHostVantage: true,
      },
      NOW - 9 * HOUR,
      NOW,
    );
    expect(win.tone).toBe('unknown');
    // the Proxies grid's chip
    const { container } = render(
      <ProxyOsChip
        fingerprint={undefined}
        aged={{ value: fp, atMs: NOW - 9 * HOUR }}
        nowMs={NOW}
      />,
    );
    const chip = container.querySelector('[data-component="proxy-os-fingerprint"]') as HTMLElement;
    expect(chip.getAttribute('data-os-tone')).toBe('match');
    expect(chip.className).toContain('text-status-ready');
    expect(chip.className).toContain('border-dashed');
    expect(chip.textContent).toMatch(/9 h ago/);
    cleanup();
    // the profiles list's aged cell (the card's verdict for the same reading)
    expect(agedOsVerdictFor({ value: fp, atMs: NOW - 9 * HOUR }, NOW, false, false).tone).toBe(
      'match',
    );
  });

  it('CRITICAL the Simulator names Apple in words and in green — never the raw `macos-or-ios`, never neutral', () => {
    const { container } = render(
      <OsReadout
        report={{
          manual_input_available: null,
          streaming_state: null,
          egress_state: null,
          os_fingerprint: { os: 'macos-or-ios', confidence: 'high' },
        }}
      />,
    );
    const el = container.querySelector('[data-component="sim-os-readout"]') as HTMLElement;
    expect(el.textContent).toBe('OS: ✓ iOS/macOS · high');
    expect(el.textContent).not.toContain('macos-or-ios');
    expect(el.className).toContain('text-status-ready');
    expect(el.getAttribute('data-os-tone')).toBe('match');
    cleanup();
  });
});

// ─── A SOCKS5 proxy only Driftstack has measured ────────────────────────────

function cardProps(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
  return {
    name: 'second mac',
    monogram: 'SM',
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
    exitIp: null,
    latencyMs: null,
    latencyFillPct: 0,
    latencyGood: false,
    // This Mac never tested it: no native verdict at all.
    probed: false,
    capabilities: null,
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

describe('owner item 9 — a reading Driftstack took shows on every badge it measured, whichever machine took it', () => {
  it('CRITICAL the card: UDP ✓ · QUIC ✓ · ✓ Apple for a proxy only Driftstack measured — never Apple alone, never behind a "+N"', () => {
    const p = cardProps({
      udpProbe: true,
      quicProbe: true,
      osFingerprint: APPLE_READINGS[0]![1],
    });
    expect(capsMode(p)).toBe('measured');
    const { container } = render(<ProfilePhoneCard {...p} />);
    const caps = container.querySelector('[data-region="caps"]') as HTMLElement;
    expect(caps.querySelector('[data-udp]')?.getAttribute('data-udp')).toBe('true');
    expect(caps.querySelector('[data-quic-inferred]')?.textContent).toBe('QUIC ✓');
    expect(
      caps.querySelector('[data-component="proxy-os-fingerprint"]')?.getAttribute('data-os-tone'),
    ).toBe('match');
    expect(caps.querySelector('[data-component="caps-overflow"]')).toBeNull();
    // …and the health pill beside them says what is true: untested HERE, not
    // "untested" beside three readings Driftstack took.
    const pill = container.querySelector('[data-component="health-pill"]') as HTMLElement;
    expect(pill.textContent).toBe('not tested here');
    expect(pill.getAttribute('title')).toMatch(/Driftstack has checked this proxy/);
    cleanup();
  });

  it('VACUITY: with only an OS reading the card keeps its Test button ("Test ✓ Apple") — the measured row needs a UDP or QUIC reading', () => {
    expect(capsMode(cardProps({ osFingerprint: APPLE_READINGS[0]![1] }))).toBe('first');
  });

  it('CRITICAL the grid’s chips for the same readings: ✓ UDP and ✓ QUIC — and "not measured" stated for a reading Driftstack did not take', () => {
    const { container } = render(
      <ProxyCapabilityChips result={undefined} udpProbe={true} quicProbe={true} nowMs={NOW} />,
    );
    const cap = (k: string): HTMLElement | null =>
      container.querySelector<HTMLElement>(`[data-capability="${k}"]`);
    expect(cap('webrtc')?.getAttribute('data-ok')).toBe('true');
    expect(cap('quic')?.getAttribute('data-ok')).toBe('true');
    // HTTP/2 is the native handshake's fact; nothing here took it.
    expect(cap('http2')).toBeNull();
    cleanup();
    const none = render(
      <ProxyCapabilityChips result={undefined} quicProbe={true} nowMs={NOW} />,
    ).container;
    expect(none.querySelector('[data-capability="webrtc"]')?.getAttribute('data-ok')).toBe(
      'unmeasured',
    );
    expect(none.querySelector('[data-capability="webrtc"]')?.textContent).toBe('—UDP');
    expect(none.querySelector('[data-capability="quic"]')?.getAttribute('data-ok')).toBe('true');
    cleanup();
  });
});

// ─── The Proxies grid, end to end over the cache ────────────────────────────

const testProxy = vi.fn<(input: unknown) => Promise<ProxyTestResult>>();
const listProxies = vi.fn<() => Promise<ProxyConfig[]>>();
const testAccountProxy =
  vi.fn<(baseUrl: string, apiKey: string, id: string) => Promise<AccountProxyTestResult>>();

vi.mock('../../src/lib/proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof ProxiesModule>()),
  listProxies: () => listProxies(),
  addProxy: vi.fn(() => Promise.resolve({})),
  removeProxy: vi.fn(() => Promise.resolve()),
  updateProxy: vi.fn(() => Promise.resolve({})),
  testProxy: (input: unknown) => testProxy(input),
  probeProxyExit: () => Promise.resolve(null),
}));
vi.mock('../../src/lib/account-proxies', async (importOriginal) => ({
  ...(await importOriginal<typeof AccountProxiesModule>()),
  testAccountProxy: (baseUrl: string, apiKey: string, id: string) =>
    testAccountProxy(baseUrl, apiKey, id),
}));
let cacheFixture: ProbeCacheMap = {};
vi.mock('../../src/lib/proxy-probe-cache', async (importOriginal) => ({
  ...(await importOriginal<typeof ProbeCacheModule>()),
  loadProbeCache: () => Promise.resolve(cacheFixture),
}));
const settingsStub = {
  settings: { apiKey: 'ds_test' as string | null, baseUrl: 'http://localhost:3000' },
  accountMe: null,
};
vi.mock('../../src/lib/SettingsContext', () => ({ useSettings: () => settingsStub }));

/** The row's NETWORK cell: the flex row that holds the capability chips and the
 *  OS chip (the health column beside it has its own "untested" pill, which is
 *  about reachability from this Mac and is not what these arms are about). */
function networkCell(container: HTMLElement): HTMLElement {
  const os = container.querySelector('[data-component="proxy-os-fingerprint"]');
  if (os?.parentElement == null) throw new Error('no OS chip rendered');
  return os.parentElement;
}

const savedProxy: ProxyConfig = {
  id: 'p1',
  label: 'second-mac-socks',
  host: 'proxy.example.com',
  port: 1080,
  username: 'u',
  password: 'p',
  createdAt: '2026-05-20T00:00:00.000Z',
  serverId: 'aprx_1',
};

describe('owner item 9 — the Proxies grid draws Driftstack’s readings of a proxy this Mac never tested', () => {
  beforeEach(() => {
    cleanup();
    listProxies.mockReset();
    listProxies.mockResolvedValue([savedProxy]);
    testProxy.mockReset();
    testAccountProxy.mockReset();
  });

  it('CRITICAL a seeded row reads ✓ WebRTC · ✓ QUIC · ✓ iOS/macOS — not "untested" beside a green Apple', async () => {
    const at = Date.now() - 10 * 60_000;
    const { SERVER_SEEDED_PLACEHOLDER_RESULT } = await import('../../src/lib/proxy-probe-cache');
    cacheFixture = {
      p1: {
        result: SERVER_SEEDED_PLACEHOLDER_RESULT,
        at,
        serverSeeded: true,
        osFingerprint: { ...APPLE_READINGS[0]![1], at },
        quicProbe: true,
        quicProbeAt: at,
        udpProbe: true,
        udpProbeAt: at,
      },
    };
    const { ProxiesView } = await import('../../src/views/ProxiesView');
    const { container } = render(<ProxiesView />);
    await screen.findByText('second-mac-socks');
    await vi.waitFor(() =>
      expect(container.querySelector('[data-capability="quic"]')).not.toBeNull(),
    );
    expect(container.querySelector('[data-capability="webrtc"]')?.getAttribute('data-ok')).toBe(
      'true',
    );
    expect(container.querySelector('[data-capability="quic"]')?.getAttribute('data-ok')).toBe(
      'true',
    );
    const os = container.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(os?.getAttribute('data-os-tone')).toBe('match');
    expect(networkCell(container).textContent).not.toContain('untested');
  });

  it('while a Test runs on a row with nothing measured yet, the network chip says so — never "untested" beside "… OS"', async () => {
    cacheFixture = {};
    let release: (r: ProxyTestResult) => void = () => undefined;
    testProxy.mockImplementation(
      () =>
        new Promise<ProxyTestResult>((resolve) => {
          release = resolve;
        }),
    );
    const { ProxiesView } = await import('../../src/views/ProxiesView');
    const { container } = render(<ProxiesView />);
    await screen.findByText('second-mac-socks');
    expect(networkCell(container).textContent).toContain('untested');
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await vi.waitFor(() => expect(networkCell(container).textContent).toContain('testing…'));
    expect(networkCell(container).textContent).not.toContain('untested');
    expect(networkCell(container).textContent).toContain('OS');
    release({
      reachable: false,
      auth_ok: false,
      udp_associate: false,
      can_route: false,
      connect_reply: 0xff,
      latency_ms: 0,
      message: 'down',
    });
  });
});
