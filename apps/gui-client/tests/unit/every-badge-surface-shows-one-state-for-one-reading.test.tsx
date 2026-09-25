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
  capabilityChips,
  capsMode,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import {
  ProfilesTable,
  agedOsVerdictFor,
  type ProfileTableRow,
  type ProfilesTableProps,
} from '../../src/components/ProfilesTable';
import { OsReadout } from '../../src/components/OsReadout';
import { QuicReadout } from '../../src/components/QuicReadout';
import { UdpReadout } from '../../src/components/UdpReadout';
import { VpnQuicChip, VpnUdpChip } from '../../src/views/ProxiesView';
import type { AgentSessionCapabilityReport } from '../../src/lib/agent-session-control';
import {
  CARD_TILE_STATES_MISSING_BY_ITS_ACTION,
  OS_WORD,
  READING_MARK,
  READING_WORD,
  badgeText,
  type Reading,
} from '../../src/lib/reading-badge-words';
import { proxyCapabilities } from '../../src/components/ProxyCapabilities';
import { listUdpVerdict } from '../../src/components/ProfilesTable';
import type { Session } from '../../src/lib/client';
import { SessionCard } from '../../src/views/SessionsView';
import { ProxyLimits } from '../../src/views/SessionsHistoryView';

const NOW = Date.parse('2026-09-24T12:00:00.000Z');
const M_NOT_MEASURED = READING_MARK.notMeasured;
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
    it(`CRITICAL from ${from}: ✓ Apple, the match tone`, () => {
      const v = osFingerprintVerdict(fp);
      expect(v.tone).toBe('match');
      expect(v.glyph).toBe('✓');
      expect(v.label).toBe('Apple');
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
    expect(el.textContent).toBe('✓ Apple · high confidence');
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
  it('CRITICAL the card: ✓ UDP · ✓ QUIC · ✓ Apple for a proxy only Driftstack measured — never Apple alone, never behind a "+N"', () => {
    const p = cardProps({
      udpProbe: true,
      quicProbe: true,
      osFingerprint: APPLE_READINGS[0]![1],
    });
    expect(capsMode(p)).toBe('measured');
    const { container } = render(<ProfilePhoneCard {...p} />);
    const caps = container.querySelector('[data-region="caps"]') as HTMLElement;
    expect(caps.querySelector('[data-udp]')?.getAttribute('data-udp')).toBe('true');
    expect(caps.querySelector('[data-quic-inferred]')?.textContent).toBe('✓ QUIC');
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

  it('CRITICAL the grid’s chips for the same readings: ✓ UDP and ✓ QUIC — and "— UDP" stated for a reading Driftstack did not take', () => {
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

  it('CRITICAL a seeded row reads ✓ UDP · ✓ QUIC · ✓ Apple — not "untested" beside a green Apple', async () => {
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

  it('while a Test runs on a row with nothing measured yet, the network chip says so — never "— UDP — QUIC" (not measured) beside "… OS"', async () => {
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
    // Before the Test: nothing measured, in the one vocabulary — "— UDP",
    // "— QUIC", "— OS" (it read "untested", one word for two readings).
    expect(badgeWords(networkCell(container).querySelector('[data-capability="webrtc"]'))).toBe(
      '— UDP',
    );
    expect(badgeWords(networkCell(container).querySelector('[data-capability="quic"]'))).toBe(
      '— QUIC',
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    await vi.waitFor(() => expect(networkCell(container).textContent).toContain('testing…'));
    expect(networkCell(container).querySelector('[data-ok="unmeasured"]')).toBeNull();
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

  it('CRITICAL a row that was DOWN on its last test reads "— UDP" "— QUIC" — never "not verified", one pill for two readings', async () => {
    cacheFixture = { p1: { result: DOWN_RESULT, at: Date.now() - 5 * 60_000 } };
    const { ProxiesView } = await import('../../src/views/ProxiesView');
    const { container } = render(<ProxiesView />);
    await screen.findByText('second-mac-socks');
    await vi.waitFor(() =>
      expect(networkCell(container).querySelector('[data-capability="webrtc"]')).not.toBeNull(),
    );
    const cell = networkCell(container);
    expect(badgeWords(cell.querySelector('[data-capability="webrtc"]'))).toBe('— UDP');
    expect(badgeWords(cell.querySelector('[data-capability="quic"]'))).toBe('— QUIC');
    expect(cell.textContent).not.toContain('not verified');
    expect(cell.querySelector('[data-capability="webrtc"]')?.getAttribute('title')).toMatch(
      /last test/,
    );
  });

  it('the add / edit form’s Test line says the UDP reading in the vocabulary — "✓ UDP", "⤵ UDP" (never a red ✗) for a proxy that does not relay it, "— UDP" for one that carried nothing', async () => {
    const { ProxyForm } = await import('../../src/views/ProxiesView');
    for (const [result, words] of [
      [OK_UDP_RESULT, '✓ UDP'],
      [NO_UDP_RESULT, '⤵ UDP'],
      // Reached and logged in, every CONNECT refused: the line is shown (it is
      // reachable) and no UDP reading was taken through it.
      [{ ...OK_UDP_RESULT, udp_associate: false, can_route: false, connect_reply: 0x02 }, '— UDP'],
    ] as const) {
      testProxy.mockResolvedValue(result);
      render(
        <ProxyForm
          initial={{
            label: 'eu-1',
            scheme: 'socks5',
            host: 'proxy.example.com',
            port: 1080,
            username: 'alice',
            password: 'p4ss',
          }}
          mode="add"
          onCancel={() => undefined}
          onSave={vi.fn()}
        />,
      );
      fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
      const line = await vi.waitFor(() => {
        const el = document.querySelector('[data-component="form-test-result"]');
        if (el === null) throw new Error('no test line yet');
        return el;
      });
      const text = (line.textContent ?? '').replace(/\s+/g, ' ');
      expect(text, text).toContain(` · ${words} · `);
      expect(text).not.toMatch(/UDP [✓✗]/);
      cleanup();
    }
  });
});

// ─── One vocabulary: the same WORD and MARK ORDER on all five surfaces ──────
//
// gui-v0.1.72's release check (owner item 9, "they should all always show
// accurate stats"): the arms above prove each surface lands a reading in the
// same STATE; they did not look at the words, and the words differed — "✓ Apple"
// on a compact card and "✓ iOS/macOS" everywhere else; "✓ UDP" on the Proxies
// tab and "UDP ✓" on the card and the list; "HTTP/3" in the Simulator where
// every other surface said "QUIC"; and a reading nobody took written as "— UDP",
// "UDP: not measured yet", "untested", "QUIC untested" or nothing at all.
//
// Here every state of every reading is rendered on the profile card, its
// details sheet, the profiles list, the Proxies tab, the Simulator — and, since
// the gui-v0.1.73 review, a session's card and its line in the session log,
// which said "SOCKS5 · UDP supported" / "Full" and "UDP not supported" /
// "HTTP/3 not available" about the same readings — and each
// badge must read EXACTLY the one vocabulary's words (lib/reading-badge-words):
// the mark first, then the word; a detail only after " · ". The card is the one
// compact surface: it may shorten the WORD to a prefix of itself ("✗ Win"),
// with the mark still first.

/** A badge's words as a reader sees them: every mark set apart, whitespace
 *  collapsed, anything after the " · " detail separator dropped — so a glyph
 *  span beside a word ("✓QUIC"), one string ("✓ QUIC") and a detailed line
 *  ("✓ QUIC · HTTP/3 live") all read "✓ QUIC", and "QUIC ✓" does not. */
function badgeWords(el: Element | null | undefined): string | null {
  if (el == null) return null;
  const spaced = (el.textContent ?? '')
    .replace(/([✓✗⤵~⇢—?…])/gu, ' $1 ')
    .replace(/\s+/g, ' ')
    .trim();
  return (spaced.split(' · ')[0] ?? '').trim();
}

type Surface = 'card' | 'sheet' | 'list' | 'proxies' | 'simulator' | 'session' | 'sessionLog';
/** What one surface drew for one reading: the badge element, or a stated reason
 *  the surface does not draw that state at all. */
type Drawn = Element | null | { notDrawn: string };

const OK_UDP_RESULT: ProxyTestResult = {
  reachable: true,
  auth_ok: true,
  udp_associate: true,
  can_route: true,
  connect_reply: 0x00,
  latency_ms: 40,
  message: 'ok',
};
const NO_UDP_RESULT: ProxyTestResult = { ...OK_UDP_RESULT, udp_associate: false };
/** A proxy that was DOWN on its last test: nothing got through it, so no UDP or
 *  QUIC reading was taken at all. */
const DOWN_RESULT: ProxyTestResult = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'connection refused',
};

const APPLE: OsFingerprint = APPLE_READINGS[0]![1];
const WINDOWS_RED: OsFingerprint = {
  os: 'windows',
  confidence: 'high',
  reason: 'r',
  observedVia: 'exit_ip',
  singleHostVantage: true,
};
const LINUX_WITHHELD: OsFingerprint = {
  os: 'linux',
  confidence: 'high',
  reason: 'r',
  observedVia: 'exit_ip',
};

function tableRow(over: Partial<ProfileTableRow> = {}): ProfileTableRow {
  return {
    id: 'p1',
    name: 'amsterdam shopper',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    proxyAddress: 'proxy.example.com:1080',
    locationLabel: 'Netherlands',
    probed: true,
    udp: 'unknown',
    latencyMs: 42,
    folder: '',
    tags: [],
    note: '',
    sizeLabel: '4.2 MiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
    lastUsedIso: null,
    selected: false,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    ...over,
  };
}
function tableProps(rows: ProfileTableRow[]): ProfilesTableProps {
  return {
    rows,
    sortKey: 'name',
    sortDir: 'asc',
    onSort: vi.fn(),
    allSelected: false,
    onToggleSelectAll: vi.fn(),
    onToggleSelect: vi.fn(),
    onPrimary: vi.fn(),
    onWatch: vi.fn(),
    onStop: vi.fn(),
    onTest: vi.fn(),
    onEdit: vi.fn(),
    onTrim: vi.fn(),
    onDelete: vi.fn(),
    onSaveNote: vi.fn(),
  };
}
const REPORT_BASE: AgentSessionCapabilityReport = {
  manual_input_available: null,
  streaming_state: null,
  egress_state: null,
};

/** The list row for the same proxy the card is handed — the parent computes the
 *  row's QUIC chip from the card's own `capabilityChips`, as ProfilesView does. */
function rowFor(p: ProfilePhoneCardProps, over: Partial<ProfileTableRow>): ProfileTableRow {
  const quic = capabilityChips(p).eligible.find((c) => c.key === 'quic');
  // The row's UDP verdict through ProfilesView's own derivation (`listUdpVerdict`
  // over the same capabilities the card is handed), never a hand-typed 'fail':
  // that is how a DOWN proxy read "⤵ UDP" in the list, a measured fall-back
  // nobody measured.
  const caps =
    p.capabilities !== null && p.vpn !== true
      ? proxyCapabilities(p.capabilities, p.quicMeasured, p.quicProbe)
      : null;
  return tableRow({
    udp: listUdpVerdict(caps, p.udpProbe),
    vpn: p.vpn === true,
    ...(p.osFingerprint !== undefined ? { osFingerprint: p.osFingerprint } : {}),
    ...(quic !== undefined
      ? {
          quicChip: {
            text: quic.text,
            className: quic.className,
            title: quic.title,
            attrs: quic.attrs,
          },
        }
      : {}),
    ...over,
  });
}

const SELECTOR = {
  card: {
    udp: '[data-udp]',
    quic: '[data-quic-inferred]',
    os: '[data-component="proxy-os-fingerprint"]',
  },
  list: {
    udp: '[data-udp]',
    quic: '[data-component="list-quic-chip"]',
    os: '[data-component="proxy-os-fingerprint"]',
  },
} as const;

function drawCard(p: ProfilePhoneCardProps, reading: Reading): Element | null {
  const { container } = render(<ProfilePhoneCard {...p} />);
  const caps = container.querySelector('[data-region="caps"]');
  return caps?.querySelector(SELECTOR.card[reading]) ?? null;
}
function drawSheet(p: ProfilePhoneCardProps, reading: Reading): Element | null {
  const { container } = render(<ProfilePhoneCard {...p} detailsInitiallyOpen />);
  const facts = container.querySelector(
    '[data-component="card-details-sheet"] [data-fact="capabilities"]',
  );
  if (facts === null) return null;
  if (reading === 'os') return facts.querySelector('[data-component="proxy-os-fingerprint"]');
  // A SOCKS5 sheet draws the Proxies tab's chips; a VPN sheet draws the card's.
  return (
    facts.querySelector(`[data-capability="${reading === 'udp' ? 'webrtc' : 'quic'}"]`) ??
    facts.querySelector(SELECTOR.card[reading])
  );
}
function drawList(row: ProfileTableRow, reading: Reading): Element | null {
  const { container } = render(<ProfilesTable {...tableProps([row])} />);
  const cell = container.querySelector('[data-component="list-network-cell"]');
  return cell?.querySelector(SELECTOR.list[reading]) ?? null;
}

interface StateCase {
  reading: Reading;
  state: string;
  /** The ONE vocabulary's words for this state. */
  words: string;
  card: ProfilePhoneCardProps;
  row: Partial<ProfileTableRow>;
  proxies: () => Drawn;
  simulator: () => Drawn;
  /** A running session's card (SessionsView) and its line in the session log
   *  (SessionsHistoryView), from the session's own egress report. Most states
   *  are not theirs to draw; those say why. */
  session?: () => Drawn;
  sessionLog?: () => Drawn;
  /** The card's TILE states this missing reading with its inline action, not a
   *  badge — the one exception the vocabulary names
   *  (CARD_TILE_STATES_MISSING_BY_ITS_ACTION). The tile must be in that row and
   *  draw that action, and draw NO chip for the reading; its details sheet still
   *  says the words. */
  tile?: { mode: (typeof CARD_TILE_STATES_MISSING_BY_ITS_ACTION)[number]; action: RegExp };
}

function proxiesChip(el: JSX.Element, selector: string): () => Element | null {
  return () => render(el).container.querySelector(selector);
}

/** A session whose SOCKS5 proxy reported `egress` (null: nothing reported yet). */
function sessionWith(egress: Session['egress_capabilities']): Session {
  return {
    id: 'ses_badges',
    account_id: 'acc_badges',
    api_key_id: 'key_badges',
    status: 'ready',
    archetype: 'iphone17_ios18_7_safari26_4',
    purpose: 'production_customer',
    label: 'Tokyo run',
    metadata: null,
    egress_capabilities: egress,
    egress_capability_report: null,
    created_at: '2026-09-24T11:48:00.000Z',
    updated_at: '2026-09-24T11:59:00.000Z',
    last_state_at: null,
    destroyed_at: null,
  };
}
const EGRESS_UDP = {
  udp_associate: true,
  quic_route: 'proxy',
  dns_remote_resolve: true,
  warnings: [],
} as const satisfies NonNullable<Session['egress_capabilities']>;
const EGRESS_TCP_ONLY = {
  udp_associate: false,
  quic_route: 'disabled',
  dns_remote_resolve: true,
  warnings: [],
} as const satisfies NonNullable<Session['egress_capabilities']>;
/** The session card's UDP badge. */
function sessionCardUdp(egress: Session['egress_capabilities']): () => Element | null {
  return () =>
    render(
      <SessionCard session={sessionWith(egress)} busy={false} onDestroy={() => undefined} />,
    ).container.querySelector('[data-component="session-egress-udp"]');
}
/** The session log's badge for one reading on an ended session's line. */
function sessionLogBadge(
  reading: 'udp' | 'quic',
  egress: Session['egress_capabilities'],
): () => Element | null {
  return () =>
    render(<ProxyLimits capabilities={egress} />).container.querySelector(
      `[data-egress-limit="${reading}"]`,
    );
}
/** Why a session surface draws no badge for a state. */
const NOT_A_SESSION_STATE = {
  session:
    'a session card states only its own proxy’s UDP answer — relayed or not; before the report arrives it says "proxy details pending" in words',
  sessionLog:
    'the session log lists only what a session’s proxy could NOT do; a reading that worked, or was never taken, is not a limit',
} as const;

function STATE_CASES(): StateCase[] {
  const M = READING_MARK;
  const socks = (over: Partial<ProfilePhoneCardProps>): ProfilePhoneCardProps =>
    cardProps({ probed: true, latencyMs: 40, latencyGood: true, ...over });
  const vpn = (over: Partial<ProfilePhoneCardProps>): ProfilePhoneCardProps =>
    cardProps({ vpn: true, latencyMs: 40, latencyGood: true, ...over });
  const udpChip = '[data-capability="webrtc"]';
  const quicChip = '[data-capability="quic"]';
  const osChip = '[data-component="proxy-os-fingerprint"]';
  return [
    // ── UDP ──
    {
      reading: 'udp',
      state: 'works',
      words: badgeText(M.works, READING_WORD.udp),
      card: socks({ capabilities: OK_UDP_RESULT }),
      row: {},
      proxies: proxiesChip(<ProxyCapabilityChips result={OK_UDP_RESULT} nowMs={NOW} />, udpChip),
      // G5 — the session's own measurement: an HTTP/3 connection completed, which
      // needs UDP both ways. The launch setting alone is not one.
      simulator: () =>
        render(
          <UdpReadout
            report={{
              ...REPORT_BASE,
              proxy_udp_supported: true,
              h3_connection_observed: true,
              h3_connection_count: 1,
            }}
          />,
        ).container.firstElementChild,
      session: sessionCardUdp(EGRESS_UDP),
    },
    {
      reading: 'udp',
      state: 'falls back',
      words: badgeText(M.fallsBack, READING_WORD.udp),
      card: socks({ capabilities: NO_UDP_RESULT }),
      row: {},
      proxies: proxiesChip(<ProxyCapabilityChips result={NO_UDP_RESULT} nowMs={NOW} />, udpChip),
      simulator: () => ({
        notDrawn:
          'the Simulator has no measured UDP negative: its report carries the launch setting, which is not a measurement (proxy-accuracy audit G5)',
      }),
      session: sessionCardUdp(EGRESS_TCP_ONLY),
      sessionLog: sessionLogBadge('udp', EGRESS_TCP_ONLY),
    },
    {
      reading: 'udp',
      state: 'not measured (Driftstack measured QUIC, not UDP)',
      words: badgeText(M.notMeasured, READING_WORD.udp),
      card: cardProps({ quicProbe: true, osFingerprint: APPLE }),
      row: {},
      proxies: proxiesChip(
        <ProxyCapabilityChips result={undefined} quicProbe={true} nowMs={NOW} />,
        udpChip,
      ),
      simulator: () => render(<UdpReadout report={REPORT_BASE} />).container.firstElementChild,
    },
    {
      reading: 'udp',
      state: 'carried inside a VPN tunnel, not measured',
      words: badgeText(M.inTunnel, READING_WORD.udp),
      card: vpn({}),
      row: {},
      proxies: () => {
        const el = render(<VpnUdpChip udpProbe={undefined} />).container.firstElementChild;
        return el;
      },
      simulator: () =>
        render(<UdpReadout report={{ ...REPORT_BASE, proxy_kind: 'wireguard' }} />).container
          .firstElementChild,
    },
    // ── QUIC ──
    {
      reading: 'quic',
      state: 'works',
      words: badgeText(M.works, READING_WORD.quic),
      card: socks({ capabilities: OK_UDP_RESULT, quicProbe: true }),
      row: { quic: 'ok' },
      proxies: proxiesChip(
        <ProxyCapabilityChips result={OK_UDP_RESULT} quicProbe={true} nowMs={NOW} />,
        quicChip,
      ),
      simulator: () =>
        render(<QuicReadout report={{ ...REPORT_BASE, h3_connection_observed: true }} />).container
          .firstElementChild,
    },
    {
      reading: 'quic',
      state: 'falls back',
      words: badgeText(M.fallsBack, READING_WORD.quic),
      card: socks({ capabilities: NO_UDP_RESULT, quicMeasured: 'h2-only' }),
      row: { quic: 'fail' },
      proxies: proxiesChip(
        <ProxyCapabilityChips result={NO_UDP_RESULT} quicMeasured="h2-only" nowMs={NOW} />,
        quicChip,
      ),
      // G5 — a session set to HTTP/2 only; the launch setting for UDP is no
      // longer read as "HTTP/3 cannot work here".
      simulator: () =>
        render(<QuicReadout report={{ ...REPORT_BASE, transport_mode_active: 'h2-only' }} />)
          .container.firstElementChild,
      // HTTP/3 switched off for the session: the measured NO the Simulator
      // writes as "⤵ QUIC · HTTP/2 only".
      sessionLog: sessionLogBadge('quic', EGRESS_TCP_ONLY),
    },
    {
      reading: 'quic',
      state: 'likely (inferred from UDP, not measured)',
      words: badgeText(M.likely, READING_WORD.quic),
      card: socks({ capabilities: OK_UDP_RESULT }),
      row: { quic: 'inferred' },
      proxies: proxiesChip(<ProxyCapabilityChips result={OK_UDP_RESULT} nowMs={NOW} />, quicChip),
      simulator: () => ({
        notDrawn:
          'the Simulator reports what THIS session observed — it infers nothing from a UDP grant',
      }),
    },
    {
      reading: 'quic',
      state: 'not measured',
      words: badgeText(M.notMeasured, READING_WORD.quic),
      card: vpn({}),
      row: {},
      proxies: () =>
        render(<VpnQuicChip quicMeasured={undefined} quicProbe={undefined} noFleetMac={false} />)
          .container.firstElementChild,
      simulator: () => render(<QuicReadout report={REPORT_BASE} />).container.firstElementChild,
    },
    // ── OS ──
    {
      reading: 'os',
      state: 'matches (Apple)',
      words: badgeText(M.works, OS_WORD['macos-or-ios']),
      card: socks({ capabilities: OK_UDP_RESULT, osFingerprint: APPLE }),
      row: {},
      proxies: proxiesChip(<ProxyOsChip fingerprint={APPLE} nowMs={NOW} />, osChip),
      simulator: () =>
        render(
          <OsReadout
            report={{
              ...REPORT_BASE,
              os_fingerprint: { os: 'macos-or-ios', confidence: 'high', web_port_vantage: true },
            }}
          />,
        ).container.firstElementChild,
    },
    {
      reading: 'os',
      state: 'does not match (Windows, from a vantage that supports it)',
      words: badgeText(M.mismatch, OS_WORD.windows),
      card: socks({ capabilities: OK_UDP_RESULT, osFingerprint: WINDOWS_RED }),
      row: {},
      proxies: proxiesChip(<ProxyOsChip fingerprint={WINDOWS_RED} nowMs={NOW} />, osChip),
      simulator: () =>
        render(
          <OsReadout
            report={{
              ...REPORT_BASE,
              os_fingerprint: {
                os: 'windows',
                confidence: 'high',
                observed_via: 'exit_ip',
                single_host_vantage: true,
              },
            }}
          />,
        ).container.firstElementChild,
    },
    {
      reading: 'os',
      state: 'read, but withheld (a multi-machine proxy)',
      words: badgeText(M.undetermined, OS_WORD.linux),
      card: socks({ capabilities: OK_UDP_RESULT, osFingerprint: LINUX_WITHHELD }),
      row: {},
      proxies: proxiesChip(<ProxyOsChip fingerprint={LINUX_WITHHELD} nowMs={NOW} />, osChip),
      simulator: () =>
        render(
          <OsReadout
            report={{
              ...REPORT_BASE,
              os_fingerprint: { os: 'linux', confidence: 'high', observed_via: 'exit_ip' },
            }}
          />,
        ).container.firstElementChild,
    },
    {
      reading: 'os',
      state: 'not measured',
      words: badgeText(M.notMeasured, READING_WORD.os),
      card: socks({ capabilities: OK_UDP_RESULT }),
      row: {},
      proxies: proxiesChip(<ProxyOsChip fingerprint={undefined} nowMs={NOW} />, osChip),
      simulator: () => render(<OsReadout report={REPORT_BASE} />).container.firstElementChild,
    },
    // ── Nothing measured, on the rows the tile states with its action ──
    // gui-v0.1.72 review: a proxy that was DOWN on its last test read "not
    // verified" on the Proxies tab (one pill for two readings) and "⤵ UDP"
    // "⤵ QUIC" in the list — the mark of a measured fall-back, for readings
    // nobody could take. And a proxy nothing has measured yet said nothing
    // about UDP or QUIC on the card's details sheet, while the tab and the list
    // said "— UDP" "— QUIC".
    ...(['udp', 'quic'] as const).flatMap((reading): StateCase[] => {
      const word = READING_WORD[reading];
      const chip = reading === 'udp' ? udpChip : quicChip;
      return [
        {
          reading,
          state: 'not measured — the proxy was down on its last test',
          words: badgeText(M.notMeasured, word),
          card: socks({ capabilities: DOWN_RESULT, latencyMs: null, latencyGood: false }),
          row: {},
          proxies: proxiesChip(<ProxyCapabilityChips result={DOWN_RESULT} nowMs={NOW} />, chip),
          simulator: () => ({
            notDrawn:
              'the Simulator reports what a RUNNING session observed; it has no last test to be down on',
          }),
          tile: { mode: 'repair', action: /^Re-test$/ },
        },
        {
          reading,
          state: 'not measured — a SOCKS5 proxy nothing has tested yet',
          words: badgeText(M.notMeasured, word),
          card: cardProps({}),
          row: {},
          proxies: proxiesChip(<ProxyCapabilityChips result={undefined} nowMs={NOW} />, chip),
          simulator: () =>
            render(
              reading === 'udp' ? (
                <UdpReadout report={REPORT_BASE} />
              ) : (
                <QuicReadout report={REPORT_BASE} />
              ),
            ).container.firstElementChild,
          tile: { mode: 'first', action: /^Test$/ },
        },
      ];
    }),
    {
      reading: 'quic',
      state: 'not measured — a VPN nothing has checked yet',
      words: badgeText(M.notMeasured, READING_WORD.quic),
      card: cardProps({ vpn: true }),
      row: {},
      proxies: () =>
        render(<VpnQuicChip quicMeasured={undefined} quicProbe={undefined} noFleetMac={false} />)
          .container.firstElementChild,
      simulator: () => render(<QuicReadout report={REPORT_BASE} />).container.firstElementChild,
      tile: { mode: 'first', action: /^Check( VPN)?$/ },
    },
  ];
}

/** Does `drawn` read `words` — the mark first, the word after it? On a compact
 *  surface the word may be a PREFIX of the vocabulary's ("✗ Win"), never another
 *  word and never another order. */
function readsAs(drawn: string | null, words: string, compact: boolean): boolean {
  if (drawn === null) return false;
  if (drawn === words) return true;
  if (!compact) return false;
  const [mark, word] = [words.split(' ')[0], words.split(' ').slice(1).join(' ')];
  const [dMark, dWord] = [drawn.split(' ')[0], drawn.split(' ').slice(1).join(' ')];
  return dMark === mark && dWord.length > 0 && word.startsWith(dWord);
}

describe('owner item 9 — ONE vocabulary: every surface badges one state in the same words, mark first', () => {
  for (const c of STATE_CASES()) {
    it(`CRITICAL ${c.reading.toUpperCase()} ${c.state}: "${c.words}" on the card, the sheet, the list, the Proxies tab, the Simulator and the session surfaces`, () => {
      let card: Drawn;
      if (c.tile !== undefined) {
        expect(CARD_TILE_STATES_MISSING_BY_ITS_ACTION).toContain(c.tile.mode);
        expect(capsMode(c.card)).toBe(c.tile.mode);
        const tile = render(<ProfilePhoneCard {...c.card} />).container.querySelector(
          '[data-region="caps"]',
        );
        expect(
          tile?.querySelector(SELECTOR.card[c.reading]) ?? null,
          `the ${c.tile.mode} tile states a missing ${c.reading} by its action, never a chip`,
        ).toBeNull();
        expect(tile?.querySelector('[data-action="retest-proxy"]')?.textContent ?? '').toMatch(
          c.tile.action,
        );
        cleanup();
        card = { notDrawn: `the ${c.tile.mode} tile's action states it` };
      } else {
        card = drawCard(c.card, c.reading);
      }
      const drawn: Record<Surface, Drawn> = {
        card,
        sheet: (cleanup(), drawSheet(c.card, c.reading)),
        list: (cleanup(), drawList(rowFor(c.card, c.row), c.reading)),
        proxies: (cleanup(), c.proxies()),
        simulator: (cleanup(), c.simulator()),
        session: (cleanup(), c.session?.() ?? { notDrawn: NOT_A_SESSION_STATE.session }),
        sessionLog: (cleanup(), c.sessionLog?.() ?? { notDrawn: NOT_A_SESSION_STATE.sessionLog }),
      };
      const read: Partial<Record<Surface, string | null>> = {};
      for (const [surface, el] of Object.entries(drawn) as Array<[Surface, Drawn]>) {
        if (el !== null && typeof el === 'object' && 'notDrawn' in el) continue;
        read[surface] = badgeWords(el);
      }
      for (const [surface, words] of Object.entries(read) as Array<[Surface, string | null]>) {
        expect(
          readsAs(words, c.words, surface === 'card'),
          `${surface} reads ${JSON.stringify(words)}, the vocabulary says ${JSON.stringify(c.words)}`,
        ).toBe(true);
      }
      cleanup();
    });
  }

  it('one state, one look: in a Proxies network cell "— UDP", "— QUIC", "⇢ UDP" and "— OS" wear the same chip', () => {
    // gui-v0.1.72 review: the UDP / QUIC chips of a reading nobody took moved
    // to one wash while "— OS" beside them kept another — plainly visible in
    // dark on every untested row.
    const wash = (el: Element | null): string =>
      (el?.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter((c) => /^(bg|text)-/.test(c) && !/^text-\[/.test(c))
        .sort()
        .join(' ');
    const caps = render(
      <ProxyCapabilityChips result={undefined} nowMs={NOW} size="xs" />,
    ).container;
    const os = render(<ProxyOsChip fingerprint={undefined} nowMs={NOW} size="xs" />).container;
    const udp = caps.querySelector('[data-capability="webrtc"]');
    const quic = caps.querySelector('[data-capability="quic"]');
    const noOs = os.querySelector('[data-component="proxy-os-fingerprint"]');
    expect(badgeWords(udp)).toBe('— UDP');
    expect(badgeWords(noOs)).toBe('— OS');
    expect(wash(udp)).not.toBe('');
    expect(wash(quic)).toBe(wash(udp));
    expect(wash(noOs)).toBe(wash(udp));
    // …and on a VPN row, where "⇢ UDP" and "— QUIC" had their own wash too.
    const vpnUdp = render(<VpnUdpChip udpProbe={undefined} />).container.firstElementChild;
    const vpnQuic = render(
      <VpnQuicChip quicMeasured={undefined} quicProbe={undefined} noFleetMac={false} />,
    ).container.firstElementChild;
    expect(badgeWords(vpnUdp)).toBe('⇢ UDP');
    expect(badgeWords(vpnQuic)).toBe('— QUIC');
    expect(wash(vpnUdp)).toBe(wash(noOs));
    expect(wash(vpnQuic)).toBe(wash(noOs));
    cleanup();
  });

  it('VACUITY: the session surfaces are really in the table above — three states draw on them, and a session that relays UDP has no "Proxy limits" line at all', () => {
    const drawnOnSessions = STATE_CASES().filter(
      (c) => c.session !== undefined || c.sessionLog !== undefined,
    );
    expect(drawnOnSessions.map((c) => `${c.reading} ${c.state}`)).toEqual([
      'udp works',
      'udp falls back',
      'quic falls back',
    ]);
    expect(render(<ProxyLimits capabilities={EGRESS_UDP} />).container.textContent).toBe('');
    cleanup();
  });

  it('gui-v0.1.73 review — the session card and the session log keep their sentences as sentences, and no sentence contradicts the badge beside it', () => {
    const tcpOnly = render(
      <SessionCard
        session={sessionWith(EGRESS_TCP_ONLY)}
        busy={false}
        onDestroy={() => undefined}
      />,
    ).container;
    const udpBadge = tcpOnly.querySelector('[data-component="session-egress-udp"]');
    expect(badgeWords(udpBadge)).toBe('⤵ UDP');
    // Its hover is prose, and prose may say more — never that UDP works.
    expect(udpBadge?.getAttribute('title') ?? '').not.toMatch(/supports UDP|UDP works/);
    // The row never names the reading a second way beside the badge.
    const row = udpBadge?.parentElement?.textContent ?? '';
    expect(row).not.toMatch(/UDP supported|TCP only|Full|Limited/);
    cleanup();
    const log = render(
      <ProxyLimits capabilities={{ ...EGRESS_TCP_ONLY, dns_remote_resolve: false }} />,
    ).container;
    const line =
      log.querySelector('[data-component="history-connection-limits"]')?.textContent ?? '';
    expect(line).toBe('Connection limits: ⤵ UDP · ⤵ QUIC · DNS resolved outside the proxy');
    expect(line).not.toMatch(/UDP not supported|HTTP\/3 not available/);
    cleanup();
  });

  it('gui-v0.1.73 review — a proxy that carried nothing: "— HTTP/2" beside "— UDP" "— QUIC", in the same chip and with a true hover — never the "⤵" of a measured fall-back', () => {
    const wash = (el: Element | null): string =>
      (el?.getAttribute('class') ?? '')
        .split(/\s+/)
        .filter((c) => /^(bg|text)-/.test(c) && !/^text-\[/.test(c))
        .sort()
        .join(' ');
    for (const [why, result] of [
      ['unreachable', DOWN_RESULT],
      ['login refused', { ...OK_UDP_RESULT, auth_ok: false, udp_associate: false }],
      // Reached and logged in, every CONNECT refused: "the login failed" would be false.
      [
        'every CONNECT refused',
        { ...OK_UDP_RESULT, udp_associate: false, can_route: false, connect_reply: 0x02 },
      ],
    ] as const) {
      const caps = render(<ProxyCapabilityChips result={result} nowMs={NOW} size="xs" />).container;
      const udp = caps.querySelector('[data-capability="webrtc"]');
      const quic = caps.querySelector('[data-capability="quic"]');
      const http2 = caps.querySelector('[data-capability="http2"]');
      expect(badgeWords(udp), why).toBe(badgeText(M_NOT_MEASURED, READING_WORD.udp));
      expect(badgeWords(quic), why).toBe(badgeText(M_NOT_MEASURED, READING_WORD.quic));
      expect(badgeWords(http2), why).toBe(badgeText(M_NOT_MEASURED, 'HTTP/2'));
      expect(http2?.getAttribute('data-ok'), why).toBe('unmeasured');
      expect(wash(http2), why).toBe(wash(udp));
      const hover = http2?.getAttribute('title') ?? '';
      expect(hover, why).toMatch(/^HTTP\/2 not measured/);
      expect(hover, why).not.toMatch(/login failed|could not be reached/);
      cleanup();
    }
    // VACUITY: a proxy that carries traffic still reads "✓ HTTP/2", green.
    const ok = render(<ProxyCapabilityChips result={OK_UDP_RESULT} nowMs={NOW} />).container;
    const http2 = ok.querySelector('[data-capability="http2"]');
    expect(badgeWords(http2)).toBe(badgeText(READING_MARK.works, 'HTTP/2'));
    expect(http2?.getAttribute('data-ok')).toBe('true');
    cleanup();
  });

  it('the vocabulary itself: one word per reading, the mark first, Apple for macOS-or-iOS', () => {
    expect(READING_WORD).toEqual({ udp: 'UDP', quic: 'QUIC', os: 'OS' });
    expect(badgeText(READING_MARK.works, 'QUIC')).toBe('✓ QUIC');
    expect(OS_WORD['macos-or-ios']).toBe('Apple');
    // The verdict every OS surface reads carries the same word.
    expect(osFingerprintVerdict(APPLE).label).toBe(OS_WORD['macos-or-ios']);
  });

  it('VACUITY: the normaliser tells the two orders apart — "QUIC ✓" is not "✓ QUIC"', () => {
    const span = document.createElement('span');
    span.textContent = 'QUIC ✓';
    expect(badgeWords(span)).toBe('QUIC ✓');
    expect(readsAs(badgeWords(span), '✓ QUIC', true)).toBe(false);
    span.innerHTML = '<span aria-hidden="true">✓</span>QUIC';
    expect(badgeWords(span)).toBe('✓ QUIC');
    span.textContent = '✓ QUIC · HTTP/3 live';
    expect(badgeWords(span)).toBe('✓ QUIC');
    expect(readsAs('✗ Win', '✗ Windows', true)).toBe(true);
    expect(readsAs('✗ Win', '✗ Windows', false)).toBe(false);
    expect(readsAs('✓ iOS/macOS', '✓ Apple', true)).toBe(false);
  });
});

// ─── The sentences beside the badges ────────────────────────────────────────
//
// gui-v0.1.73 re-review: the UDP chip's hover — on the card's tile, printed as
// visible text in the card's details sheet, and in the profiles list's UDP
// cell — said the QUIC reading its own way. For a proxy whose UDP works and
// whose QUIC fell back the sheet printed, one line under the other:
//   "✓ UDP — UDP works — WebRTC ✓; QUIC ✗ (HTTP/2 on last measure) through this exit."
//   "⤵ QUIC — No HTTP/3 — a live session fell back to HTTP/2 through this exit."
// The mark AFTER the word, and ✗ — the red OS-mismatch mark — for a fall-back
// the chip right above it draws as "⤵". And a proxy whose UDP handshake failed
// but whose QUIC Driftstack MEASURED working read "No UDP — … QUIC falls back to
// HTTP/2" under a "✓ QUIC". A sentence is prose: it says the reading in words,
// carries no badge mark, and never says the opposite of the badge beside it.

/** The badge marks that are never punctuation. The em dash and the question mark
 *  are prose too ("No UDP — WebRTC …"), so they are not in this set. */
const BADGE_MARK_IN_PROSE = /[✓✗⤵⇢~]/u;
/** A reading word with a badge mark after it: "WebRTC ✓", "QUIC ✗". */
const MARK_AFTER_A_READING_WORD = /(UDP|QUIC|WebRTC|HTTP\/[23])\s*[✓✗⤵⇢~]/u;

interface ProseCase {
  state: string;
  card: ProfilePhoneCardProps;
  /** The list row's QUIC state, as ProfilesView derives it for the same proxy. */
  row: Partial<ProfileTableRow>;
  /** What the UDP hover's QUIC half must say, and what it must never say. */
  says: RegExp;
  never: RegExp;
}

function PROSE_CASES(): ProseCase[] {
  const socks = (over: Partial<ProfilePhoneCardProps>): ProfilePhoneCardProps =>
    cardProps({ probed: true, latencyMs: 40, latencyGood: true, nowMs: NOW, ...over });
  const agedAtMs = NOW - 9 * HOUR;
  const agedHint = (p: ProfilePhoneCardProps): Partial<ProfileTableRow> => ({
    quic: 'aged',
    quicAgedHint: capabilityChips(p).eligible.find((c) => c.key === 'quic')?.title ?? '',
  });
  const agedFellBack = socks({
    capabilities: OK_UDP_RESULT,
    aged: { quicProbe: { value: false, atMs: agedAtMs } },
  });
  const agedWorked = socks({
    capabilities: OK_UDP_RESULT,
    aged: { quicProbe: { value: true, atMs: agedAtMs } },
  });
  return [
    {
      state: 'UDP works, QUIC works',
      card: socks({ capabilities: OK_UDP_RESULT, quicProbe: true }),
      row: { quic: 'ok' },
      says: /HTTP\/3 works/,
      never: /falls? back to HTTP\/2|fell back/,
    },
    {
      state: 'UDP works, QUIC falls back (a live session measured HTTP/2)',
      card: socks({ capabilities: OK_UDP_RESULT, quicMeasured: 'h2-only' }),
      row: { quic: 'fail' },
      says: /HTTP\/3 falls back to HTTP\/2/,
      never: /HTTP\/3 works/,
    },
    {
      state: 'UDP works, QUIC falls back (Driftstack’s relay check)',
      card: socks({ capabilities: OK_UDP_RESULT, quicProbe: false }),
      row: { quic: 'fail' },
      says: /HTTP\/3 falls back to HTTP\/2/,
      never: /HTTP\/3 works/,
    },
    {
      state: 'UDP works, QUIC likely (not measured)',
      card: socks({ capabilities: OK_UDP_RESULT }),
      row: { quic: 'inferred' },
      says: /HTTP\/3 is likely/,
      never: /HTTP\/3 works|falls? back/,
    },
    {
      state: 'UDP works, QUIC fell back when last checked',
      card: agedFellBack,
      row: agedHint(agedFellBack),
      says: /fell back to HTTP\/2/,
      never: /HTTP\/3 works|HTTP\/3 worked/,
    },
    {
      state: 'UDP works, QUIC worked when last checked',
      card: agedWorked,
      row: agedHint(agedWorked),
      says: /HTTP\/3 worked/,
      never: /falls? back|fell back/,
    },
    {
      state: 'UDP falls back, and QUIC measured working through the proxy',
      card: socks({ capabilities: NO_UDP_RESULT, quicProbe: true }),
      row: { quic: 'ok' },
      says: /HTTP\/3 works/,
      never: /(QUIC|HTTP\/3) falls? back|fell back to HTTP\/2/,
    },
  ];
}

/** The sentence of a "<chip> — <sentence>" line: everything after the chip. */
function proseOf(line: string): string {
  const at = line.indexOf(' — ');
  return at === -1 ? line : line.slice(at + ' — '.length);
}

describe('gui-v0.1.73 review — the sentence beside a UDP badge says QUIC in words: no badge mark in the prose, never the opposite of the badge', () => {
  for (const c of PROSE_CASES()) {
    it(`CRITICAL ${c.state}: the tile’s UDP hover, the sheet’s printed lines and the list’s UDP hover`, () => {
      // The card's tile: the UDP chip's hover.
      const tileUdp = drawCard(c.card, 'udp');
      const tileHover = tileUdp?.getAttribute('title') ?? '';
      expect(tileHover, 'the tile’s UDP chip has a hover').not.toBe('');
      cleanup();

      // The details sheet: every printed line, and the UDP line in particular.
      const sheet = render(<ProfilePhoneCard {...c.card} detailsInitiallyOpen />).container;
      const lines = [...sheet.querySelectorAll('[data-component="capability-hints"] li')].map(
        (li) => (li.textContent ?? '').trim(),
      );
      const udpLine = lines.find((l) => /^[✓⤵] UDP — /u.test(l));
      expect(udpLine, `the sheet prints a UDP line: ${JSON.stringify(lines)}`).toBeDefined();
      for (const line of lines) {
        expect(BADGE_MARK_IN_PROSE.test(proseOf(line)), `sheet line: ${line}`).toBe(false);
        expect(MARK_AFTER_A_READING_WORD.test(proseOf(line)), `sheet line: ${line}`).toBe(false);
      }
      cleanup();

      // The profiles list: the UDP cell's hover for the same proxy.
      const listUdp = drawList(rowFor(c.card, c.row), 'udp');
      const listHover = listUdp?.getAttribute('title') ?? '';
      expect(listHover, 'the list’s UDP chip has a hover').not.toBe('');
      cleanup();

      for (const [surface, text] of [
        ['tile', tileHover],
        ['sheet', proseOf(udpLine ?? '')],
        ['list', listHover],
      ] as const) {
        expect(BADGE_MARK_IN_PROSE.test(text), `${surface}: ${text}`).toBe(false);
        expect(MARK_AFTER_A_READING_WORD.test(text), `${surface}: ${text}`).toBe(false);
        expect(text, `${surface} says the QUIC reading`).toMatch(c.says);
        expect(text, `${surface} never says the opposite of the QUIC badge`).not.toMatch(c.never);
      }
    });
  }

  it('CRITICAL a VPN row in the list: the UDP hover names its QUIC reading in words, whatever the UDP state', () => {
    for (const udp of ['ok', 'fail', 'unknown'] as const) {
      for (const quic of ['ok', 'fail', 'inferred', 'unknown'] as const) {
        const el = drawList(tableRow({ vpn: true, udp, quic }), 'udp');
        const hover = el?.getAttribute('title') ?? '';
        expect(hover, `${udp}/${quic}`).not.toBe('');
        expect(BADGE_MARK_IN_PROSE.test(hover), `${udp}/${quic}: ${hover}`).toBe(false);
        expect(MARK_AFTER_A_READING_WORD.test(hover), `${udp}/${quic}: ${hover}`).toBe(false);
        cleanup();
      }
    }
  });

  it('VACUITY: the two patterns catch the sentences the review found, and pass the ones the chips already use', () => {
    for (const old of [
      'UDP works — WebRTC ✓; QUIC ✗ (HTTP/2 on last measure) through this exit.',
      'UDP works — WebRTC ✓; QUIC ✓',
      'UDP works — WebRTC ✓; QUIC likely (not yet measured) through this exit.',
      'UDP works — WebRTC ✓; QUIC ✓ when last checked through this exit.',
    ]) {
      expect(BADGE_MARK_IN_PROSE.test(old), old).toBe(true);
      expect(MARK_AFTER_A_READING_WORD.test(old), old).toBe(true);
    }
    for (const prose of [
      'No UDP — WebRTC falls back to a slower, more detectable path.',
      'No HTTP/3 — a live session fell back to HTTP/2 through this exit.',
      'UDP works — WebRTC calls and media stream through this exit.',
    ]) {
      expect(BADGE_MARK_IN_PROSE.test(prose), prose).toBe(false);
    }
    expect(proseOf('⤵ QUIC — No HTTP/3 — a live session fell back.')).toBe(
      'No HTTP/3 — a live session fell back.',
    );
  });
});
