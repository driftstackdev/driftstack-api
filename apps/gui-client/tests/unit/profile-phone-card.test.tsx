// GX ProfilePhoneCard — the phone-framed grid card. Asserts the core data shows
// (name, device, exit place / untested pill), status (Live/Idle), folder/tag
// pills, and that the dock actions + selection fire their handlers.
//
// Phase B (2026-09-11) — the "simulator tile": a fixed 234px card of eight
// single-line fixed-height regions. jsdom has no layout, so the arms below pin
// the RULES (the health-pill precedence, the JS chip/meta caps, the region
// classes and order, the copy) and scripts/gui-visual-check.mjs proves the
// geometry at 178/240/260px. Every arm names its production line; reverting
// that line is the mutation each was reasoned against.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type * as TauriCore from '@tauri-apps/api/core';
import type * as TauriStore from '@tauri-apps/plugin-store';
import type * as TauriFs from '@tauri-apps/plugin-fs';

// The Tauri plugin modules, mocked exactly as marketing-scenes.test.tsx does —
// needed ONLY by the last describe block ("every harness scene …"), which
// mounts the scenes' real Sidebar + TitleBar chrome through the real
// SettingsContext; its mount effects touch the store / invoke. The card arms
// above import nothing from these packages, so the mocks change nothing for
// them.
//
// ROUTED, not inert (2026-09-12 review): an audit scene installs a
// window-level Tauri stub — `window.__TAURI_INTERNALS__.invoke` — and the
// three plugin mocks below hand their calls to the REAL plugin-store /
// plugin-fs code over that stub when it is installed, exactly the path the
// browser gate exercises. With the earlier inert answers (LazyStore.get →
// null, exists → false, readDir → []) FleetView / RecordingsView /
// AgentChatView loaded NOTHING here, the stage arm measured their EMPTY
// states (chrome + empty-state copy cleared both floors) and a fixture that
// never reached the DOM was invisible to it. Without a stub (the marketing
// scenes, the card arms) the mocks keep the inert answers.
/* eslint-disable @typescript-eslint/require-await -- mirrors marketing-scenes.test.tsx */
const { tauriStub } = vi.hoisted(() => ({
  tauriStub: (): { invoke: (cmd: string, args?: unknown) => Promise<unknown> } | undefined => {
    const w = window as Window & {
      __TAURI_INTERNALS__?: { invoke: (cmd: string, args?: unknown) => Promise<unknown> };
    };
    return w.__TAURI_INTERNALS__;
  },
}));
vi.mock('@tauri-apps/api/core', async (importOriginal) => ({
  ...(await importOriginal<typeof TauriCore>()),
  invoke: vi.fn(async (cmd: string, args?: unknown) => {
    const stub = tauriStub();
    return stub === undefined ? null : stub.invoke(cmd, args);
  }),
}));
vi.mock('@tauri-apps/plugin-store', async (importOriginal) => {
  const real = await importOriginal<typeof TauriStore>();
  class LazyStore {
    private readonly inner: InstanceType<typeof real.LazyStore>;
    constructor(path: string) {
      this.inner = new real.LazyStore(path);
    }
    async get<T>(key: string): Promise<T | null | undefined> {
      return tauriStub() === undefined ? null : this.inner.get<T>(key);
    }
    async set(key: string, value: unknown): Promise<void> {
      if (tauriStub() !== undefined) await this.inner.set(key, value);
    }
    async save(): Promise<void> {
      if (tauriStub() !== undefined) await this.inner.save();
    }
  }
  return { LazyStore };
});
vi.mock('@tauri-apps/plugin-fs', async (importOriginal) => {
  const real = await importOriginal<typeof TauriFs>();
  const routed =
    <A extends unknown[], R>(fn: (...a: A) => Promise<R>, inert: R) =>
    async (...a: A): Promise<R> =>
      tauriStub() === undefined ? inert : fn(...a);
  return {
    readTextFile: vi.fn(routed(real.readTextFile, '')),
    writeTextFile: vi.fn(routed(real.writeTextFile, undefined)),
    exists: vi.fn(routed(real.exists, false)),
    mkdir: vi.fn(routed(real.mkdir, undefined)),
    remove: vi.fn(routed(real.remove, undefined)),
    readDir: vi.fn(routed(real.readDir, [])),
    BaseDirectory: real.BaseDirectory,
  };
});
vi.mock('@tauri-apps/plugin-deep-link', () => ({
  onOpenUrl: vi.fn(async () => () => undefined),
}));
vi.mock('@tauri-apps/plugin-shell', () => ({
  open: vi.fn(async () => undefined),
}));
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: vi.fn(async () => null),
}));
vi.mock('@sentry/browser', () => ({
  init: vi.fn(),
  captureException: vi.fn(),
  addBreadcrumb: vi.fn(),
  withScope: vi.fn(),
}));
/* eslint-enable @typescript-eslint/require-await */
import {
  ProfilePhoneCard,
  healthPill,
  capsMode,
  firstAction,
  visibleChips,
  visibleMeta,
  terseAgo,
  thumbUsesDarkInk,
  thumbRecipe,
  wcagContrast,
  THUMB_DARK_INK_CLASS,
  THUMB_DARK_INK_HEX,
  vpnFailureClause,
  vpnNoticeClause,
  DEFAULT_CONTENT_WIDTH,
  PROBE_ORIGIN_TITLE,
  SERVER_LATENCY_TITLE,
  type ProfilePhoneCardProps,
} from '../../src/components/ProfilePhoneCard';
import {
  ALL_SCENES,
  Gallery,
  MARKETING_SCENES,
  STATES,
  freezeHarnessClock,
  isAuditScene,
} from '../../src/visual-harness/gallery';
import { auditLoadedMarkers } from '../../src/visual-harness/audit-scenes';
import { RelativeTime, formatRelativeNarrow } from '../../src/components/RelativeTime';
import {
  CHECK_VPN_ACTION,
  CHECK_VPN_TITLE,
  ENDPOINT_OK_PILL,
  ENDPOINT_OK_TITLE,
  ENDPOINT_UNRESOLVED,
  ENDPOINT_UNRESOLVED_EXIT_TITLE,
  EXIT_GEO_UNAVAILABLE,
  EXIT_GEO_UNAVAILABLE_SHORT,
  EXIT_GEO_UNAVAILABLE_TITLE,
  RECHECK_ACTION,
  RETEST_ACTION,
  VPN_LATENCY_NOT_MEASURED,
  VPN_NO_API_KEY_CHECK_NOTICE,
  VPN_NO_EXIT_YET,
  VPN_NO_EXIT_YET_SHORT,
  VPN_NO_EXIT_YET_TITLE,
  VPN_NO_LATENCY_YET_TITLE,
  VPN_NOT_STORED_CHECK_NOTICE,
  VPN_TUNNEL_UP_NO_LATENCY_TITLE,
} from '../../src/lib/proxy-check-copy';

function props(over: Partial<ProfilePhoneCardProps> = {}): ProfilePhoneCardProps {
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
    capabilities: {
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      can_route: true,
      connect_reply: 0x00,
      latency_ms: 42,
      message: 'ok',
    },
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

const classes = (el: Element | null | undefined): string[] =>
  (el?.getAttribute('class') ?? '').split(/\s+/).filter((c) => c.length > 0);
const byComponent = (root: ParentNode, name: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-component="${name}"]`);
const byRegion = (root: ParentNode, name: string): HTMLElement | null =>
  root.querySelector<HTMLElement>(`[data-region="${name}"]`);
const pill = (root: ParentNode): HTMLElement => {
  const all = root.querySelectorAll('[data-component="health-pill"]');
  expect(all.length, 'exactly one health pill').toBe(1);
  return all[0] as HTMLElement;
};

const CANNOT_ROUTE = {
  reachable: true,
  auth_ok: true,
  udp_associate: false,
  can_route: false,
  connect_reply: 0x05,
  latency_ms: 0,
  message: 'CONNECT refused',
} as const;
const NOT_REACHABLE = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'The proxy did not answer.',
} as const;
/** ⛔ (V-219, 2026-09-14) THE VANTAGE IS PART OF EVERY ASSERTING FIXTURE NOW.
 *  os-fingerprint-verdict.ts mints a match or a mismatch only where
 *  `singleHostVantage === true`: the host we dialled, the host that emitted the
 *  SYN and the address the destination sees are ONE machine, so nothing in
 *  between can route a website's 443 differently from our observer's port. That
 *  is the ordinary datacentre SOCKS5 row, and it is the row the arms below were
 *  written against — these four fixtures exist to produce a chip that ASSERTS
 *  ('✓ Apple', '✗ Win'), because what they measure is the width table, the
 *  compact label, the drop order and the chrome, never the verdict's meaning.
 *  Left un-vantaged they would every one render '? …' and those arms would be
 *  measuring a state they were never about. The withheld direction is not
 *  dropped: it is pinned on purpose, in its own arms, from the fixtures below.
 *  ⛔ `observedVia` is 'exit_ip' and never 'proxy_host': single-host means the
 *  address we dialled IS the exit, so the control plane labels it 'exit_ip'.
 *  The pair ('proxy_host', true) is a state the producer cannot emit, and a
 *  fixture carrying it would pin a row that does not exist. */
const REAL_OS = {
  os: 'macos-or-ios',
  confidence: 'high',
  reason: 'TTL 64, MSS 1460',
  observedVia: 'exit_ip',
  singleHostVantage: true,
} as const;
/** C1/C3 — the MISMATCH fixtures. '✗ Windows' (63) is the single measured
 *  defect and the hardest chip to fit; 'Linux' (45) and 'BSD' (39) already fit
 *  144 in full, which is what makes them the control for the compact label. */
const WINDOWS_OS = {
  os: 'windows',
  confidence: 'high',
  reason: 'TTL 128, MSS 1460',
  observedVia: 'exit_ip',
  singleHostVantage: true,
} as const;
const LINUX_OS = {
  os: 'linux',
  confidence: 'medium',
  reason: 'TTL 64, window 29200',
  observedVia: 'exit_ip',
  singleHostVantage: true,
} as const;
const BSD_OS = {
  os: 'bsd',
  confidence: 'low',
  reason: 'TTL 64, window 65535',
  observedVia: 'exit_ip',
  singleHostVantage: true,
} as const;
/** ⛔ (V-219) THE WITHHELD VANTAGE — the SAME two readings, taken where the
 *  reading describes the proxy's own infrastructure rather than the path a
 *  website gets. MEASURED by the owner 2026-09-14: browserleaks.com/ip loaded
 *  THROUGH their residential proxy reads the arriving stack on 443 — a
 *  website's port — and reports Mac/iOS, while our observer reads the same
 *  proxy on 7791 and reports Linux at high confidence. The provider routes web
 *  traffic through the residential device and odd ports through its own
 *  infrastructure, so a reading taken at our vantage can describe a path no
 *  website ever touches.
 *
 *  Two shapes, because ABSENT MEANS FALSE and both must withhold identically:
 *  `*_MULTI_HOP` is the server SAYING false, and `*_LEGACY` is the same reading
 *  off a cached record written before the field existed — which is the shape
 *  most stored rows in the wild still have, and the one that would default into
 *  a confident claim if the gate tested anything looser than `!== true`.
 *  Derived from the fixtures above field by field, so a changed reading cannot
 *  leave the withheld copies describing a different proxy. */
const REAL_OS_MULTI_HOP = { ...REAL_OS, singleHostVantage: false } as const;
const WINDOWS_OS_MULTI_HOP = { ...WINDOWS_OS, singleHostVantage: false } as const;
const REAL_OS_LEGACY = {
  os: REAL_OS.os,
  confidence: REAL_OS.confidence,
  reason: REAL_OS.reason,
} as const;
const WINDOWS_OS_LEGACY = {
  os: WINDOWS_OS.os,
  confidence: WINDOWS_OS.confidence,
  reason: WINDOWS_OS.reason,
} as const;
/** C1/C2 — the '?' verdict: the classifier RAN and could not decide, with a real
 *  reason. Copied from apps/server/src/lib/tcp-os-fingerprint.ts's own TTL-64
 *  fallback. ⛔ No `unavailable` field — that is what makes it a completed
 *  measurement rather than the '—' placeholder (os-fingerprint-verdict.ts
 *  discriminates on `unavailable`, never on `os === 'unknown'`). */
const UNDETERMINED_OS = {
  os: 'unknown',
  confidence: 'none',
  reason:
    'initial TTL 64 (a unix family) but the option layout does not separate Darwin from Linux',
} as const;
/** The '—' placeholder for a cause the server REPORTED: a hint, not a chip. */
const VPN_UNAVAILABLE_OS = {
  os: 'unknown',
  confidence: 'none',
  reason: 'the OS check is not available for VPN connections',
  unavailable: 'vpn_tunnel',
} as const;

describe('ProfilePhoneCard', () => {
  it('keeps the note editor mounted and single-flight until persistence succeeds', async () => {
    let resolve!: (value: string | null) => void;
    const pending = new Promise<string | null>((done) => {
      resolve = done;
    });
    const onSaveNote = vi.fn(() => pending);
    render(<ProfilePhoneCard {...props({ note: '', onSaveNote })} />);
    fireEvent.click(screen.getByLabelText('Edit note for amsterdam shopper'));
    const input = screen.getByLabelText('Note for amsterdam shopper');
    fireEvent.change(input, { target: { value: '  priority  ' } });
    const save = screen.getByRole('button', { name: 'Save' });

    act(() => {
      save.click();
      save.click();
    });
    expect(onSaveNote).toHaveBeenCalledTimes(1);
    expect(onSaveNote).toHaveBeenCalledWith('priority');
    expect(screen.getByRole('button', { name: 'Saving…' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByLabelText('Note for amsterdam shopper')).toBeDisabled();

    resolve(null);
    await waitFor(() => expect(screen.queryByLabelText('Note for amsterdam shopper')).toBeNull());
    cleanup();
  });

  it('keeps a failed note draft open and allows a clean retry', async () => {
    const onSaveNote = vi
      .fn<() => Promise<string | null>>()
      .mockResolvedValueOnce('Saved locally, but account sync failed.')
      .mockResolvedValueOnce(null);
    render(<ProfilePhoneCard {...props({ note: '', onSaveNote })} />);
    fireEvent.click(screen.getByLabelText('Edit note for amsterdam shopper'));
    fireEvent.change(screen.getByLabelText('Note for amsterdam shopper'), {
      target: { value: 'retry me' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('account sync failed');
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.queryByLabelText('Note for amsterdam shopper')).toBeNull());
    expect(onSaveNote).toHaveBeenCalledTimes(2);
    cleanup();
  });

  it('shows identity + device + flag + exit place (IP in the title) + UDP chip; Launch fires onPrimary', () => {
    // Phase B (B10 :109) — the CC chip is gone and the exit IP rides in the exit
    // line's title; the line reads the place, here the country code because no
    // location label was passed.
    const onPrimary = vi.fn();
    const { container } = render(<ProfilePhoneCard {...props({ onPrimary })} />);
    expect(screen.getByText('amsterdam shopper')).toBeTruthy();
    expect(screen.getByText('AS')).toBeTruthy();
    expect(screen.getByText('iPhone 17')).toBeTruthy();
    const exit = byRegion(container, 'exit') as HTMLElement;
    expect(exit.textContent).toContain('🇳🇱');
    expect(screen.getByText('NL').getAttribute('title')).toBe('NL · 82.14.220.9');
    expect(screen.queryByText('82.14.220.9')).toBeNull();
    const udp = container.querySelector('[data-udp="true"]') as HTMLElement;
    expect(udp.textContent).toBe('UDP ✓');
    expect(udp.getAttribute('title')).toMatch(/WebRTC ✓/); // the hover detail moved into the title
    expect(screen.getByText('Idle')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('running → Live status + an "Open session" primary action', () => {
    render(<ProfilePhoneCard {...props({ running: true })} />);
    expect(screen.getByText('Live')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Open session' })).toBeTruthy();
    cleanup();
  });

  it('shows an inline, accessible launch spinner only for the launch action', () => {
    // B9 — the launching word is the LIST's ('Launching…', ProfilesTable), not
    // 'Starting…': one action, one name on both views.
    const { container, rerender } = render(
      <ProfilePhoneCard {...props({ busy: true, launching: true })} />,
    );
    const starting = screen.getByRole('button', { name: 'Launching…' });
    expect(starting).toBeDisabled();
    expect(starting).toHaveAttribute('aria-busy', 'true');
    expect(container.querySelector('[data-component="launch-spinner"]')).not.toBeNull();
    expect(screen.queryByText(/Starting…/)).toBeNull();

    // `busy` also covers trim/delete/clone/reopen. Those actions must not make
    // the primary button falsely claim that a launch is underway.
    rerender(<ProfilePhoneCard {...props({ busy: true, launching: false })} />);
    expect(screen.getByRole('button', { name: 'Launch' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Launch' })).toHaveAttribute('aria-busy', 'false');
    expect(container.querySelector('[data-component="launch-spinner"]')).toBeNull();
    cleanup();
  });

  it('running + onStop → a Stop affordance in the ⋯ menu that fires onStop', () => {
    const onStop = vi.fn();
    render(<ProfilePhoneCard {...props({ running: true, onStop })} />);
    // The Stop row is the labelled "Stop <name>'s running session" menu row.
    fireEvent.click(screen.getByLabelText(/Stop .* running session/));
    expect(onStop).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('idle cards never show Stop, even when onStop is provided', () => {
    render(<ProfilePhoneCard {...props({ running: false, onStop: vi.fn() })} />);
    expect(screen.queryByLabelText(/Stop .* running session/)).toBeNull();
    cleanup();
  });

  it('running but no onStop → no Stop affordance', () => {
    render(<ProfilePhoneCard {...props({ running: true, onStop: undefined })} />);
    expect(screen.queryByLabelText(/Stop .* running session/)).toBeNull();
    cleanup();
  });

  it('Stop is disabled while busy (double-close guard)', () => {
    const onStop = vi.fn();
    render(<ProfilePhoneCard {...props({ running: true, busy: true, onStop })} />);
    const stop = screen.getByLabelText(/Stop .* running session/);
    expect((stop as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(stop);
    expect(onStop).not.toHaveBeenCalled();
    cleanup();
  });

  it('Delete/Trim/Duplicate are disabled (with a hint) while ANOTHER profile is busy', () => {
    // The mutate handlers early-return on a global busyId; surface that as a
    // disabled button + tooltip so a click on an idle card isn't a silent no-op.
    render(
      <ProfilePhoneCard
        {...props({
          busy: false,
          anyBusy: true,
          onClone: vi.fn(),
          onTrim: vi.fn(),
          onDelete: vi.fn(),
        })}
      />,
    );
    fireEvent.click(screen.getByLabelText('More actions'));
    const del = screen.getByLabelText(/^Delete /);
    // W3120 renamed the action: "Trim" was jargon, "Clear cache" is what a
    // customer looks for. The disabled-while-busy property is unchanged.
    //
    // The clear scopes moved behind a disclosure (four variants of a rare action
    // were burying the daily ones in a thirteen-item menu), so the row has to be
    // revealed before its disabled state can be read. The property under test is
    // untouched — only how deep the row sits.
    fireEvent.click(screen.getByLabelText(/^Clearing options for /));
    const trim = screen.getByLabelText(/^Clear cache for /);
    const dup = screen.getByLabelText(/^Duplicate /);
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect((trim as HTMLButtonElement).disabled).toBe(true);
    expect((dup as HTMLButtonElement).disabled).toBe(true);
    expect(del.getAttribute('title')).toMatch(/Another profile is busy/i);
    cleanup();
  });

  it('CRITICAL a profile that INHERITS the only saved proxy is marked as such, and one bound deliberately is not. Reported: adding a single proxy made every profile look linked to it. Nothing was written — with no explicit binding a profile resolves to the first saved proxy, and the egress widget then showed its country and exit IP exactly as though it had been chosen. Without this marker, adding a SECOND proxy silently moves every unbound profile.', () => {
    const { unmount, container } = render(
      <ProfilePhoneCard {...props({ proxyExplicit: false })} />,
    );
    const badge = document.querySelector('[data-component="proxy-inherited-badge"]');
    expect(badge, 'an inherited proxy is presented as a deliberate binding').not.toBeNull();
    // B10 (:211/:219) — Phase B moved the badge from the exit row to the via row (N5).
    expect(byRegion(container, 'via')?.contains(badge)).toBe(true);
    unmount();

    render(<ProfilePhoneCard {...props({ proxyExplicit: true })} />);
    expect(
      document.querySelector('[data-component="proxy-inherited-badge"]'),
      'a deliberately bound proxy was labelled as an inherited default',
    ).toBeNull();
  });

  it('never-probed → "untested" pill + "untested" exit line (the LIST\'s cell word) titled with what a Test does; probed-no-IP → "no exit IP" titled with what fills it (a failed SOCKS5: its message); no proxy → "no proxy bound"', () => {
    // B10 (:226) — 'run Test' is gone from the exit line: the check word lives
    // in the pill (arm 5) and the Test button in the caps row (mode C).
    // Polish — the null-exit arm is SPLIT: never probed reads 'untested'
    // (ProfilesTable's `r.probed ? 'no exit IP' : 'untested'`), and no title
    // restates its text. Reverting the split (one 'no exit IP' arm titled
    // 'no exit IP') reds all three title arms.
    const { container: a } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, countryCode: null, probed: false, capabilities: null })}
      />,
    );
    expect(pill(a).textContent).toBe('untested');
    const exitA = byRegion(a, 'exit') as HTMLElement;
    expect(exitA.textContent).toBe('untested');
    expect(within(exitA).getByText('untested').getAttribute('title')).toBe(
      'Test proxy from this Mac — connection, response time, exit IP',
    );
    expect(screen.queryByText('no exit IP')).toBeNull();
    expect(screen.queryByText('run Test')).toBeNull();
    expect(source('components/ProfilesTable.tsx')).toContain(
      "r.probed ? 'no exit IP' : 'untested'",
    );
    cleanup();
    render(<ProfilePhoneCard {...props({ exitIp: null, countryCode: null, probed: true })} />);
    expect(screen.getByText('no exit IP').getAttribute('title')).toBe(
      'No exit was measured by the last test — run Test proxy again',
    );
    cleanup();
    render(
      <ProfilePhoneCard
        {...props({
          exitIp: null,
          countryCode: null,
          latencyMs: null,
          capabilities: NOT_REACHABLE,
        })}
      />,
    );
    expect(screen.getByText('no exit IP').getAttribute('title')).toBe('The proxy did not answer.');
    cleanup();
    const { container: none } = render(<ProfilePhoneCard {...props({ hasProxy: false })} />);
    expect(screen.getByText('no proxy bound').getAttribute('title')).toBe('Choose a proxy in Edit');
    // The 🚫 emoji is gone: one dashed placeholder ring for every glyph-less exit.
    expect(none.textContent).not.toContain('🚫');
    expect(byComponent(byRegion(none, 'exit') as HTMLElement, 'exit-placeholder')).not.toBeNull();
    cleanup();
  });

  it('F1c: the Assist button fires onAssist when provided, absent otherwise', () => {
    const onAssist = vi.fn();
    render(<ProfilePhoneCard {...props({ onAssist })} />);
    fireEvent.click(screen.getByLabelText(/Ask the AI assistant about/));
    expect(onAssist).toHaveBeenCalledTimes(1);
    cleanup();
    render(<ProfilePhoneCard {...props({ onAssist: undefined })} />);
    expect(screen.queryByLabelText(/Ask the AI assistant about/)).toBeNull();
    cleanup();
  });

  it('the ⋯ menu opens on toggle and dismisses on an outside pointer-down (and Escape)', () => {
    render(<ProfilePhoneCard {...props()} />);
    // Phase C: the menu is PORTALED to document.body — queried on the document.
    const menu = document.querySelector('[data-component="card-actions-menu"]');
    const toggle = screen.getByRole('button', { name: 'More actions' });
    // classList membership (not substring) — the static class also carries a
    // `group-hover:opacity-100` token that a substring check would match.
    expect(menu?.classList.contains('opacity-0')).toBe(true);
    fireEvent.click(toggle);
    expect(menu?.classList.contains('opacity-100')).toBe(true);
    // A pointer-down anywhere outside the card footer closes it.
    fireEvent.pointerDown(document.body);
    expect(menu?.classList.contains('opacity-0')).toBe(true);
    // Re-open, then Escape closes it.
    fireEvent.click(toggle);
    expect(menu?.classList.contains('opacity-100')).toBe(true);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu?.classList.contains('opacity-0')).toBe(true);
    // Phase B: the menu is a sibling of the screen (so it can open downward
    // past the screen's overflow-hidden); a pointer-down INSIDE it must not
    // count as outside, or every row click would close it before it fired.
    // Phase C: the menu is a PORTAL node (no descendant of the card at all) —
    // `menuRef.contains` is what makes it "inside"; a DOM-ancestry test would
    // close it on every row click.
    fireEvent.click(toggle);
    fireEvent.pointerDown(menu as Element);
    expect(menu?.classList.contains('opacity-100')).toBe(true);
    cleanup();
  });

  it('Delete is enabled (and fires onDelete) when idle', () => {
    const onDelete = vi.fn();
    render(<ProfilePhoneCard {...props({ running: false, onDelete })} />);
    const del = screen.getByLabelText('Delete amsterdam shopper');
    expect((del as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(del);
    expect(onDelete).toHaveBeenCalledTimes(1);
    cleanup();
  });

  it('Delete is disabled with a "stop the session first" tooltip while running (server rejects deleting a running profile)', () => {
    const onDelete = vi.fn();
    render(<ProfilePhoneCard {...props({ running: true, onDelete })} />);
    const del = screen.getByLabelText('Delete amsterdam shopper');
    expect((del as HTMLButtonElement).disabled).toBe(true);
    expect(del.getAttribute('title')).toMatch(/stop the session first/i);
    fireEvent.click(del);
    expect(onDelete).not.toHaveBeenCalled();
    cleanup();
  });

  it('renders folder + tag pills', () => {
    render(<ProfilePhoneCard {...props({ folder: 'Shopping', tags: ['aged'] })} />);
    expect(screen.getByText('📁 Shopping')).toBeTruthy();
    expect(screen.getByText('aged')).toBeTruthy();
    cleanup();
  });

  it('tells an idle saved profile that its tabs reopen without inventing a count — as a ↻ on Launch whose title carries the sentence (N11)', () => {
    // B10 (:299-304) — the "Saved tabs reopen" pill became the ↻ glyph inside
    // the Launch button; the sentence is the button's title.
    const { rerender } = render(
      <ProfilePhoneCard {...props({ savedTabsReopen: true, running: false })} />,
    );
    const launch = screen.getByRole('button', { name: 'Launch' });
    const glyph = document.querySelector('[data-component="saved-tabs-reopen"]');
    expect(glyph).not.toBeNull();
    expect(launch.contains(glyph)).toBe(true);
    expect(launch.getAttribute('title')).toMatch(/launch it/i);
    expect(screen.queryByText('Saved tabs reopen')).toBeNull();

    // Once live, the tabs are already open; the pre-launch promise should disappear.
    rerender(<ProfilePhoneCard {...props({ savedTabsReopen: true, running: true })} />);
    expect(document.querySelector('[data-component="saved-tabs-reopen"]')).toBeNull();
    expect(screen.getByRole('button', { name: 'Open session' }).getAttribute('title')).not.toMatch(
      /launch it/i,
    );
    cleanup();
  });

  it('clicking the card toggles selection; Launch + Test do NOT select (stopPropagation)', () => {
    const onToggleSelect = vi.fn();
    const onTest = vi.fn();
    const onPrimary = vi.fn();
    render(<ProfilePhoneCard {...props({ onToggleSelect, onTest, onPrimary })} />);
    // whole-card click selects (no more tiny checkbox)
    fireEvent.click(screen.getByLabelText(/Select amsterdam shopper/));
    expect(onToggleSelect).toHaveBeenCalledTimes(1);
    // action buttons act without bubbling to a select toggle
    fireEvent.click(screen.getByTitle(/Test proxy/));
    expect(onTest).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).toHaveBeenCalledTimes(1); // still 1 — buttons don't select
    cleanup();
  });
});

describe('the Clear group expands on CLICK, never on hover (V-2149)', () => {
  it('⛔ pointing at "Clear…" does not reveal the destructive rows', () => {
    // The group only exists when a trim handler does.
    render(<ProfilePhoneCard {...props({ onTrim: vi.fn() })} />);
    fireEvent.click(screen.getByLabelText('More actions'));
    const group = screen.getByLabelText(/^Clearing options for /);

    // Hovering the group must not expand it: the rows below DESTROY state the
    // customer cannot get back, and expanding on hover slides one of them under
    // a cursor that was only passing through.
    fireEvent.mouseEnter(group);
    expect(screen.queryByLabelText(/^Clear history for /)).toBeNull();
    expect(group.getAttribute('aria-expanded')).toBe('false');

    // Nor does merely focusing it (keyboard traversal is not a choice to look).
    fireEvent.focus(group);
    expect(screen.queryByLabelText(/^Clear history for /)).toBeNull();

    // A click — the thing a disclosure button promises — opens it.
    fireEvent.click(group);
    expect(group.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByLabelText(/^Clear history for /)).not.toBeNull();

    // And toggles shut again.
    fireEvent.click(group);
    expect(screen.queryByLabelText(/^Clear history for /)).toBeNull();
    cleanup();
  });

  it('(V-2166) ⛔ hovering a card does not unfurl its actions — only the ⋯ toggle opens them', () => {
    // The menu carried `group-hover:opacity-100 group-hover:pointer-events-auto`, so
    // dragging the pointer across the grid opened every card's actions in turn,
    // including Delete and the Clear group, over whatever card the cursor reached
    // (owner 2026-08-30). Same correction as V-2149's Clear group, one level up.
    const { container } = render(<ProfilePhoneCard {...props({ onTrim: vi.fn() })} />);
    const menu = document.querySelector('[data-component="card-actions-menu"]') as HTMLElement;
    expect(
      menu,
      'the menu is always in the DOM (opacity-toggled, portaled to body) so labels stay queryable',
    ).not.toBeNull();

    // Closed: no hover class may make it interactive, and it must not be reachable.
    expect(menu.className).not.toMatch(/group-hover:opacity-100/);
    expect(menu.className).not.toMatch(/group-hover:pointer-events-auto/);
    expect(menu.className).toMatch(/pointer-events-none/);
    expect(menu.className).toMatch(/opacity-0/);

    // Hovering the CARD changes nothing.
    const card = container.querySelector('[role="button"]') as HTMLElement;
    fireEvent.mouseEnter(card);
    expect(menu.className).toMatch(/pointer-events-none/);

    // The ⋯ toggle is the only opener.
    fireEvent.click(screen.getByLabelText('More actions'));
    const opened = document.querySelector('[data-component="card-actions-menu"]') as HTMLElement;
    expect(opened.className).toMatch(/pointer-events-auto/);
    expect(opened.className).toMatch(/opacity-100/);
    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Phase B (2026-09-11) — the simulator tile. The rules below are what the
// Playwright gate proved sufficient for 0 escapes / 0 scroll / 234px at every
// width; jsdom pins them so the geometry cannot silently regress between runs
// of the gate.
// ─────────────────────────────────────────────────────────────────────────────
const SRC = resolve(__dirname, '../../src');
const source = (rel: string): string => readFileSync(resolve(SRC, rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// Contrast (2026-09-12) — the colour arms below measure the WCAG 2.1 ratio the
// gate (scripts/gui-text-quality.mjs) measures, from the tokens in
// styles/index.css, so a mode-flipping token is measured in EACH mode.
type Rgb = readonly [number, number, number];
// Comments stripped first: the token layer's prose mentions `data-mode`, and a
// comment ABOVE a block is part of that block's selector text to the parser.
const INDEX_CSS = source('styles/index.css').replace(/\/\*[\s\S]*?\*\//g, '');
/** A custom property's value for a mode: a block whose selector names that
 *  data-mode wins; a block with no data-mode (the accent block) is the fallback.
 *  THROWS when the property is absent — a missing token must red the arm, never
 *  read as "no colour" (which is what the browser renders for an undefined
 *  Tailwind class). */
function modeVar(name: string, mode: 'light' | 'dark'): string {
  let fallback: string | null = null;
  for (const [, selector, body] of INDEX_CSS.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const m = new RegExp(`--${name}:\\s*([^;]+);`).exec(body ?? '');
    if (m === null) continue;
    const value = (m[1] ?? '').replace(/\/\*.*?\*\//g, '').trim();
    if (new RegExp(`data-mode=['"]${mode}['"]`).test(selector ?? '')) return value;
    if (!/data-mode/.test(selector ?? '')) fallback = value;
  }
  if (fallback === null)
    throw new Error(`--${name} is not defined for ${mode} in styles/index.css`);
  return fallback;
}
const modeRgb = (name: string, mode: 'light' | 'dark'): Rgb => {
  const parts = modeVar(`${name}-rgb`, mode).split(/\s+/).map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n))) {
    throw new Error(`--${name}-rgb for ${mode} is not "R G B": ${modeVar(`${name}-rgb`, mode)}`);
  }
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0];
};
const hexRgb = (hex: string): Rgb =>
  [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as unknown as Rgb;
/** CSS `hsl(H S% L%)` → sRGB, CSS Color 4's algorithm (what the browser resolves). */
function hslRgb(css: string): Rgb {
  const m = /^hsl\((\d+) (\d+)% (\d+)%\)$/.exec(css);
  if (m === null) throw new Error(`not an hsl() stop: ${css}`);
  const [h, s, l] = [Number(m[1]), Number(m[2]) / 100, Number(m[3]) / 100];
  const a = s * Math.min(l, 1 - l);
  const f = (n: number): number => {
    const k = (n + h / 30) % 12;
    return Math.round((l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))) * 255);
  };
  return [f(0), f(8), f(4)];
}
/** `fg` at `alpha` composited over an opaque `bg`. */
const over = (fg: Rgb, alpha: number, bg: Rgb): Rgb =>
  [0, 1, 2].map((i) =>
    Math.round((fg[i] ?? 0) * alpha + (bg[i] ?? 0) * (1 - alpha)),
  ) as unknown as Rgb;
/** What a Tailwind text class resolves to in a mode: a literal, white, or an
 *  ink token from index.css. Anything else throws (the arm must not guess). */
function inkOf(cls: string, mode: 'light' | 'dark'): Rgb {
  if (cls === 'text-white') return [255, 255, 255];
  const literal = /^text-\[#([0-9a-f]{6})\]$/i.exec(cls);
  if (literal !== null) return hexRgb(`#${literal[1] ?? ''}`);
  const token = /^text-(ink-\w+|accent-text)$/.exec(cls);
  if (token !== null) return modeRgb(token[1] ?? '', mode);
  throw new Error(`inkOf cannot resolve ${cls}`);
}
/** The accent-subtle wash the VPN tag sits on: the accent at the mode's alpha
 *  over the raised surface (the tile's screen is `bg-surface-raised`). */
const accentSubtleWash = (mode: 'light' | 'dark'): Rgb =>
  over(
    modeRgb('accent-subtle', mode),
    Number(modeVar('accent-subtle-alpha', mode)),
    modeRgb('surface-raised', mode),
  );
// ─────────────────────────────────────────────────────────────────────────────

const VPN_DOWN = 'The test Mac could not bring the tunnel up: handshake timed out after 20 s.';
const VPN_NOTICE = 'Tunnel test not run this time — a live session holds the tunnel.';

describe('B1 — the health pill: ONE element, seven arms, strict precedence (healthPill)', () => {
  // ProfilePhoneCard.tsx `healthPill`: each arm below is one `if` in order.
  // Swapping arms 2 and 7 (or deleting arm 2) makes a failed SOCKS5 read
  // 'not measured' → the CRITICAL arm reds; deleting the running+broken
  // independence (the session pill is a separate element) reds arm 2b.
  it('arm 1 — no proxy → "no proxy" · none · muted', () => {
    const { container } = render(<ProfilePhoneCard {...props({ hasProxy: false })} />);
    const el = pill(container);
    expect(el.textContent).toBe('no proxy');
    expect(el.getAttribute('data-health')).toBe('none');
    // Polish — muted is the comp's translucent slate + ink2, never the
    // near-black inset (the quietest states were the darkest object on the tile).
    expect(classes(el)).toEqual(expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']));
    expect(classes(el)).not.toContain('bg-surface-inset');
    expect(classes(el)).not.toContain('text-ink-muted');
    expect(healthPill(props({ hasProxy: false }))).toMatchObject({
      text: 'no proxy',
      state: 'none',
      tone: 'muted',
    });
    cleanup();
  });

  it('CRITICAL arm 2 — a failed SOCKS5 → the shared verdict label (error tint, message as title); "stale" and "not measured" appear NOWHERE; running + broken shows both "Live" and the label', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, latencyMs: null, capabilities: NOT_REACHABLE })}
      />,
    );
    const el = pill(container);
    expect(el.textContent).toBe('Not reachable');
    expect(el.getAttribute('data-health')).toBe('broken');
    // Polish — the error ink is the soft error-as-text token on the red tint
    // (the red-400 token measured 3.3–3.8:1 there at 10px); the tint is
    // unchanged. 2026-09-24: it was the dark-only literal red-300 (#fca5a5),
    // unreadable on the light theme's card.
    expect(classes(el)).toEqual(
      expect.arrayContaining(['bg-status-error/15', 'text-status-error-text']),
    );
    expect(classes(el)).not.toContain('text-status-error');
    expect(el.getAttribute('title')).toBe('The proxy did not answer.');
    expect(container.textContent).not.toMatch(/stale/);
    expect(container.textContent).not.toMatch(/not measured/);
    // The other two verdict words come from the same function.
    expect(healthPill(props({ capabilities: { ...NOT_REACHABLE, reachable: true } })).text).toBe(
      'Auth failed',
    );
    expect(healthPill(props({ capabilities: CANNOT_ROUTE })).text).toBe('Cannot route');
    // Arm 2 outranks a test in flight (4), a number (6) and 'not measured' (7).
    expect(healthPill(props({ capabilities: NOT_REACHABLE, testing: true })).text).toBe(
      'Not reachable',
    );
    expect(healthPill(props({ capabilities: NOT_REACHABLE, latencyMs: 12 })).text).toBe(
      'Not reachable',
    );
    cleanup();

    const { container: live } = render(
      <ProfilePhoneCard {...props({ running: true, capabilities: NOT_REACHABLE })} />,
    );
    expect(screen.getByText('Live')).toBeTruthy();
    expect(pill(live).textContent).toBe('Not reachable');
    cleanup();
  });

  it('arm 3 — a VPN whose tunnel test failed → "VPN tunnel down" · broken · error; title = failure (+ " — " + notice when both, G6)', () => {
    const base = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      vpnFailure: VPN_DOWN,
    };
    const { container } = render(<ProfilePhoneCard {...props(base)} />);
    const el = pill(container);
    expect(el.textContent).toBe('VPN tunnel down');
    expect(el.getAttribute('data-health')).toBe('broken');
    expect(el.getAttribute('title')).toBe(VPN_DOWN);
    cleanup();
    expect(healthPill(props({ ...base, vpnNotice: VPN_NOTICE })).title).toBe(
      `${VPN_DOWN} — ${VPN_NOTICE}`,
    );
    // Outranks a test in flight and a standing fleet number.
    expect(healthPill(props({ ...base, testing: true })).text).toBe('VPN tunnel down');
    expect(healthPill(props({ ...base, latencyMs: 61 })).text).toBe('VPN tunnel down');
    // Gated on `vpn` (l #16): a socks5 row keeps no tunnel banner from a stale cache entry.
    expect(healthPill(props({ ...base, vpn: false })).text).not.toBe('VPN tunnel down');
  });

  it('arm 4 — a test in flight → "Testing…" | "Checking…" (VPN) · checking · muted, with a pulsing dot; outranks the number and "untested"', () => {
    const { container } = render(<ProfilePhoneCard {...props({ testing: true })} />);
    const el = pill(container);
    expect(el.textContent).toBe('Testing…');
    expect(el.getAttribute('data-health')).toBe('checking');
    expect(el.querySelector('.animate-pulse')).not.toBeNull();
    cleanup();
    expect(healthPill(props({ testing: true, vpn: true })).text).toBe('Checking…');
    expect(healthPill(props({ testing: true, probed: false, capabilities: null })).text).toBe(
      'Testing…',
    );
    // Polish — a LAUNCH runs the proxy check, so the pill says so instead of
    // keeping the stale number; its title names the launch, not the Test.
    const launching = healthPill(props({ launching: true, busy: true }));
    expect(launching).toMatchObject({ text: 'Testing…', state: 'checking', tone: 'muted' });
    expect(launching.title).toBe('Checking the proxy before the session starts');
    expect(healthPill(props({ launching: true, busy: true, vpn: true })).text).toBe('Checking…');
    const { container: launch } = render(
      <ProfilePhoneCard {...props({ launching: true, busy: true })} />,
    );
    expect(pill(launch).getAttribute('data-health')).toBe('checking');
    expect(launch.textContent).not.toContain('42ms');
    cleanup();
  });

  it('arm 5 — never probed, nothing measured → "untested" · untested · muted, titled with what a Test does', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ probed: false, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const el = pill(container);
    expect(el.textContent).toBe('untested');
    expect(el.getAttribute('data-health')).toBe('untested');
    expect(el.getAttribute('title')).toBe(
      'Test proxy from this Mac — connection, response time, exit IP',
    );
    cleanup();
    expect(
      healthPill(props({ probed: false, capabilities: null, latencyMs: null, vpn: true })).title,
    ).toBe(CHECK_VPN_TITLE);
  });

  it('arm 6 — a number → `${n}ms`, ready when latencyGood else busy; the title says WHERE it was measured and NOTHING else (polish: it appended the SOCKS5 label\'s own "· 42 ms" — a second number beside the pill\'s)', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const el = pill(container);
    expect(el.textContent).toBe('42ms');
    expect(el.getAttribute('data-health')).toBe('ok');
    expect(classes(el)).toEqual(
      expect.arrayContaining(['bg-status-ready/10', 'text-status-ready']),
    );
    expect(el.getAttribute('title')).toBe(PROBE_ORIGIN_TITLE);
    expect(el.getAttribute('title')).not.toMatch(/Reachable|\d+ ms/);
    expect(el.getAttribute('data-latency-vantage')).toBe('this_mac');
    cleanup();
    // A fleet number of 88 beside a native 42: the title must not carry the 42.
    expect(
      healthPill(
        props({
          latencyMs: 88,
          latencyFromServer: true,
          latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-07' },
        }),
      ).title,
    ).not.toMatch(/42/);

    const slow = healthPill(props({ latencyMs: 210, latencyGood: false }));
    expect(slow).toMatchObject({ text: '210ms', state: 'slow', tone: 'busy' });
    // T-1 — a server number names the machine that measured it (D2 — the words
    // that were a visible label + a 26px bar now live here).
    const fleet = healthPill(
      props({
        latencyFromServer: true,
        latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-07' },
      }),
    );
    expect(fleet.title).toContain('Measured by Driftstack, from the network your profiles run on.');
    const cp = healthPill(
      props({ latencyFromServer: true, latencyVantage: { measuredFrom: 'control_plane' } }),
    );
    expect(cp.title).toContain('Measured by Driftstack’s server');
    // VACUITY CONTROL — a server number with no vantage keeps the plain server sentence.
    expect(healthPill(props({ latencyFromServer: true })).title).toBe(SERVER_LATENCY_TITLE);
    // A VPN fleet number has no SOCKS5 verdict to append.
    expect(
      healthPill(props({ vpn: true, capabilities: null, latencyMs: 61, latencyFromServer: true }))
        .title,
    ).toBe(SERVER_LATENCY_TITLE);
  });

  it('arm 7 — probed, no number, no failure → "not measured" · unmeasured · muted (VPN title = notice ?? the no-exit sentence); "stale" is deleted (G9)', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ vpn: true, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const el = pill(container);
    expect(el.textContent).toBe(VPN_LATENCY_NOT_MEASURED);
    expect(el.getAttribute('data-health')).toBe('unmeasured');
    expect(el.getAttribute('title')).toBe(VPN_NO_EXIT_YET_TITLE);
    cleanup();
    expect(
      healthPill(props({ vpn: true, capabilities: null, latencyMs: null, vpnNotice: VPN_NOTICE }))
        .title,
    ).toBe(VPN_NOTICE);
    // A probed SOCKS5 row with no number is the same arm — never 'stale'.
    const { container: socks } = render(
      <ProfilePhoneCard
        {...props({ capabilities: null, latencyMs: null, exitIp: null, probed: true })}
      />,
    );
    expect(pill(socks).textContent).toBe('not measured');
    expect(socks.textContent).not.toMatch(/stale/);
    cleanup();
  });

  it('(o) arm 7 beside an EXIT — a VPN whose exit row shows a place (session-reported, no fleet number) is titled VPN_NO_LATENCY_YET_TITLE, never "No exit measured yet"', () => {
    // healthPill's final return: `vpnUnmeasuredTitle` picks VPN_NO_LATENCY_YET_TITLE
    // when exitIp is set. Reverting it to the bare VPN_NO_EXIT_YET_TITLE puts
    // "No exit measured yet" two rows above '🇨🇭 Zürich, Zurich' → reds here.
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          latencyFromServer: false,
          exitIp: '185.22.1.9',
          countryCode: 'CH',
          flag: '🇨🇭',
          locationLabel: 'Zürich, Zurich',
        })}
      />,
    );
    const el = pill(container);
    expect(el.textContent).toBe(VPN_LATENCY_NOT_MEASURED);
    expect(el.getAttribute('title')).toBe(VPN_NO_LATENCY_YET_TITLE);
    expect(el.getAttribute('title')).not.toMatch(/No exit measured yet/);
    // The exit row shows the exit the title must not deny.
    expect((byRegion(container, 'exit') as HTMLElement).textContent).toContain('Zürich, Zurich');
    // A notice still outranks the derived title; with no exit the sentence is unchanged.
    expect(
      healthPill(
        props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: '1.2.3.4',
          vpnNotice: VPN_NOTICE,
        }),
      ).title,
    ).toBe(VPN_NOTICE);
    expect(
      healthPill(props({ vpn: true, capabilities: null, latencyMs: null, exitIp: null })).title,
    ).toBe(VPN_NO_EXIT_YET_TITLE);
    // Still mode C: nothing fleet-measured, so Check VPN is the honest next step.
    expect(
      capsMode(props({ vpn: true, capabilities: null, latencyMs: null, exitIp: '1.2.3.4' })),
    ).toBe('first');
    cleanup();
  });

  it('(o) arm 6b — a VPN the test Mac brought UP with no number → "tunnel up" · ok · ready, the grid’s shared title, data-latency-vantage="fleet"; the caps row is mode A (what that reply measured)', () => {
    // `tunnelUpNoLatency` (vpn && latencyMs === null && vantage fleet) feeds a
    // pill arm above arm 7 AND capsMode's measured arm. Deleting the pill arm
    // reds the text; deleting the capsMode clause reds the mode (it falls to
    // 'first' and offers Check VPN under a green pill).
    const up = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      latencyFromServer: false,
      latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-02' } as const,
      quicProbe: true,
      exitIp: '185.22.1.10',
      countryCode: 'AT',
      flag: '🇦🇹',
      locationLabel: 'Vienna, Vienna',
    };
    const { container } = render(<ProfilePhoneCard {...props(up)} />);
    const el = pill(container);
    expect(el.textContent).toBe('tunnel up');
    expect(el.getAttribute('data-health')).toBe('ok');
    expect(classes(el)).toContain('text-status-ready');
    expect(el.getAttribute('title')).toBe(VPN_TUNNEL_UP_NO_LATENCY_TITLE);
    expect(el.getAttribute('data-latency-vantage')).toBe('fleet');
    expect(container.textContent).not.toMatch(/not measured/);
    expect(screen.queryByRole('button', { name: CHECK_VPN_ACTION })).toBeNull();
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.getAttribute('data-caps-mode')).toBe('measured');
    expect(caps.querySelector('[data-quic-inferred="false"]')?.textContent).toBe('QUIC ✓');
    cleanup();
    expect(healthPill(props({ ...up, vpnNotice: VPN_NOTICE })).title).toBe(
      `${VPN_TUNNEL_UP_NO_LATENCY_TITLE} — ${VPN_NOTICE}`,
    );
    // Precedence: a number (6), a test in flight (4) and a failure (3) all outrank it.
    expect(healthPill(props({ ...up, latencyMs: 61, latencyFromServer: true })).text).toBe('61ms');
    expect(healthPill(props({ ...up, testing: true })).text).toBe('Checking…');
    expect(healthPill(props({ ...up, vpnFailure: VPN_DOWN })).text).toBe('VPN tunnel down');
    // VACUITY CONTROLS — the vantage alone is not "up": a control-plane vantage
    // or a SOCKS5 row with a fleet vantage and no number stays arm 7.
    expect(
      healthPill(props({ ...up, latencyVantage: { measuredFrom: 'control_plane' } })).text,
    ).toBe('not measured');
    expect(healthPill(props({ ...up, vpn: false, probed: true })).text).toBe('not measured');
    expect(capsMode(props({ ...up, latencyVantage: { measuredFrom: 'control_plane' } }))).toBe(
      'first',
    );
    // The grid renders the same sentence for the same cache entry — it now
    // imports the constant from lib/proxy-check-copy (the grid follow-up landed),
    // so the pin is that ProxiesView USES that constant, never a retyped literal.
    expect(source('views/ProxiesView.tsx')).toMatch(/\bVPN_TUNNEL_UP_NO_LATENCY_TITLE\b/);
    expect(source('views/ProxiesView.tsx')).toContain('tunnel up · no latency');
  });

  it('(polish) arm 6c — a VPN whose endpoint RESOLVED and whose tunnel was never brought up → "endpoint ok" · unmeasured · muted, the Proxies grid\'s word + title (+ the notice); never on a SOCKS5 row, an unresolved one, or over the arms above it', () => {
    // healthPill arm 6c (`p.vpn === true && p.endpoint?.resolved === true`):
    // deleting it drops the row to arm 7 → 'not measured', a word the grid never
    // shows for this cache entry (ProxiesView's EndpointHealthPill: 'address ok').
    const ok = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      countryCode: null,
      flag: '🌍',
      endpoint: { resolved: true, message: 'Resolved' },
    };
    const { container } = render(<ProfilePhoneCard {...props(ok)} />);
    const el = pill(container);
    expect(el.textContent).toBe(ENDPOINT_OK_PILL);
    expect(el.textContent).toBe('address ok');
    expect(ENDPOINT_OK_PILL.length).toBeLessThanOrEqual(15);
    expect(el.getAttribute('data-health')).toBe('unmeasured');
    expect(classes(el)).toContain('text-ink-secondary');
    expect(el.getAttribute('title')).toBe(ENDPOINT_OK_TITLE);
    expect(container.textContent).not.toMatch(/not measured/);
    // Still mode C: the tunnel was never brought up, Check VPN is the next step.
    expect((byRegion(container, 'caps') as HTMLElement).getAttribute('data-caps-mode')).toBe(
      'first',
    );
    expect(screen.getByRole('button', { name: CHECK_VPN_ACTION })).toBeTruthy();
    cleanup();
    expect(healthPill(props({ ...ok, vpnNotice: VPN_NOTICE })).title).toBe(
      `${ENDPOINT_OK_TITLE} — ${VPN_NOTICE}`,
    );
    // Precedence: 6b, 6, 4, 3 and 3b all outrank it.
    expect(healthPill(props({ ...ok, latencyVantage: { measuredFrom: 'fleet' } })).text).toBe(
      'tunnel up',
    );
    expect(healthPill(props({ ...ok, latencyMs: 61, latencyFromServer: true })).text).toBe('61ms');
    expect(healthPill(props({ ...ok, testing: true })).text).toBe('Checking…');
    expect(healthPill(props({ ...ok, vpnFailure: VPN_DOWN })).text).toBe('VPN tunnel down');
    expect(
      healthPill(props({ ...ok, endpoint: { resolved: false, message: 'no such host' } })).text,
    ).toBe('address unknown');
    // VACUITY CONTROLS — a SOCKS5 row with a resolved pre-flight, and a VPN
    // row with no pre-flight at all, both stay arm 7.
    expect(healthPill(props({ ...ok, vpn: false, probed: true })).text).toBe('not measured');
    expect(healthPill(props({ ...ok, endpoint: null })).text).toBe('not measured');
    expect(healthPill(props({ ...ok, endpoint: undefined })).text).toBe('not measured');
    // (p) D1 — the words are the grid's EndpointHealthPill: both surfaces read
    // the SAME constants from lib/proxy-check-copy (the grid once carried the
    // literals; a retyped sentence there would drift unseen).
    expect(ENDPOINT_OK_PILL).toBe('address ok');
    expect(source('views/ProxiesView.tsx')).toContain('{ENDPOINT_OK_PILL}');
    expect(source('views/ProxiesView.tsx')).toContain('title={ENDPOINT_OK_TITLE}');
    expect(source('views/ProxiesView.tsx')).not.toContain(ENDPOINT_OK_TITLE);
  });

  it('(o) arm 3b — an endpoint pre-flight that did NOT resolve → "unresolved" · broken · error · title = the resolver’s message; outranks testing, untested, the number and arm 7', () => {
    // healthPill arm 3b (`endpointUnresolved(p)`): deleting it lets the row fall
    // to arm 7 → 'not measured' + a "no exit yet — run Check VPN" title → reds.
    const unresolved = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      countryCode: null,
      flag: '🌍',
      endpoint: { resolved: false, message: 'DNS lookup of wg.example.com failed: no such host.' },
    };
    const { container } = render(<ProfilePhoneCard {...props(unresolved)} />);
    const el = pill(container);
    expect(el.textContent).toBe(ENDPOINT_UNRESOLVED);
    expect(el.textContent).toBe('address unknown');
    expect(el.getAttribute('data-health')).toBe('broken');
    expect(classes(el)).toContain('text-status-error-text');
    expect(el.getAttribute('title')).toBe('DNS lookup of wg.example.com failed: no such host.');
    expect(container.textContent).not.toMatch(/not measured/);
    expect(container.textContent).not.toMatch(/untested/);
    cleanup();
    expect(healthPill(props({ ...unresolved, testing: true })).text).toBe('address unknown');
    expect(healthPill(props({ ...unresolved, probed: false })).text).toBe('address unknown');
    expect(healthPill(props({ ...unresolved, latencyMs: 12 })).text).toBe('address unknown');
    // An HTTP row (not vpn) with the same pre-flight reads the same word.
    expect(healthPill(props({ ...unresolved, vpn: false })).text).toBe('address unknown');
    // An empty resolver message still yields a title (the exit sentence).
    expect(
      healthPill(props({ ...unresolved, endpoint: { resolved: false, message: '' } })).title,
    ).toBe(ENDPOINT_UNRESOLVED_EXIT_TITLE);
    // Arms 2 and 3 outrank it (a failed SOCKS5 / a tunnel the test Mac could not bring up).
    expect(healthPill(props({ ...unresolved, vpnFailure: VPN_DOWN })).text).toBe('VPN tunnel down');
    expect(healthPill(props({ ...unresolved, vpn: false, capabilities: NOT_REACHABLE })).text).toBe(
      'Not reachable',
    );
    // VACUITY CONTROLS — a RESOLVED pre-flight is not this arm (polish: it is
    // arm 6c, 'address ok'); neither is an absent one.
    expect(
      healthPill(props({ ...unresolved, endpoint: { resolved: true, message: 'Resolved' } })).text,
    ).toBe('address ok');
    expect(healthPill(props({ ...unresolved, endpoint: null })).text).toBe('not measured');
    expect(healthPill(props({ ...unresolved, endpoint: undefined })).text).toBe('not measured');
  });
});

describe('B2 — pill vocabulary pin: every reachable string ≤ 15 chars and verbatim in its source of truth', () => {
  // A parity pin: it asserts each VALUE and where it comes from, never that
  // 15 chars is enough (the gate measures that). Rewording a pill without its
  // source (or vice versa) reds here.
  const arms: Array<{ p: Partial<ProfilePhoneCardProps>; text: string; source: string }> = [
    { p: { hasProxy: false }, text: 'no proxy', source: 'components/ProfilesTable.tsx' },
    { p: { capabilities: NOT_REACHABLE }, text: 'Not reachable', source: 'lib/proxies.ts' },
    {
      p: { capabilities: { ...NOT_REACHABLE, reachable: true } },
      text: 'Auth failed',
      source: 'lib/proxies.ts',
    },
    { p: { capabilities: CANNOT_ROUTE }, text: 'Cannot route', source: 'lib/proxies.ts' },
    {
      p: { vpn: true, capabilities: null, vpnFailure: 'x' },
      text: 'VPN tunnel down',
      source: 'components/ProfilesTable.tsx',
    },
    { p: { testing: true }, text: 'Testing…', source: 'views/ProxiesView.tsx' },
    { p: { testing: true, vpn: true }, text: 'Checking…', source: 'views/ProxiesView.tsx' },
    {
      p: { probed: false, capabilities: null },
      text: 'untested',
      source: 'components/ProfilesTable.tsx',
    },
    { p: { latencyMs: 4242 }, text: '4242ms', source: 'components/ProfilesTable.tsx' },
    {
      p: { vpn: true, capabilities: null, latencyMs: null },
      text: 'not measured',
      source: 'lib/proxy-check-copy.ts',
    },
    // (o) — the two grid-only states: their words are the Proxies grid's EndpointHealthPill.
    {
      p: {
        vpn: true,
        capabilities: null,
        latencyMs: null,
        endpoint: { resolved: false, message: 'x' },
      },
      text: 'address unknown',
      source: 'lib/proxy-check-copy.ts',
    },
    {
      p: {
        vpn: true,
        capabilities: null,
        latencyMs: null,
        latencyVantage: { measuredFrom: 'fleet' },
      },
      text: 'tunnel up',
      source: 'views/ProxiesView.tsx',
    },
    {
      p: {
        vpn: true,
        capabilities: null,
        latencyMs: null,
        endpoint: { resolved: true, message: 'Resolved' },
      },
      text: 'address ok',
      source: 'lib/proxy-check-copy.ts',
    },
  ];
  for (const arm of arms) {
    it(`"${arm.text}" (≤ 15 chars) is the card's word and appears verbatim in ${arm.source}`, () => {
      expect(healthPill(props(arm.p)).text).toBe(arm.text);
      expect(arm.text.length).toBeLessThanOrEqual(15);
      // `${n}ms` is a template in both files; pin the shape, not a number.
      const needle = arm.text === '4242ms' ? '}ms' : arm.text;
      expect(source(arm.source)).toContain(needle);
    });
  }
  it('the session words are the list’s', () => {
    expect(source('components/ProfilesTable.tsx')).toContain("{r.running ? 'Live' : 'Idle'}");
    expect(source('components/ProfilesTable.tsx')).toContain('Launching…');
  });
});

describe('B3 — the caps row: ≤ 3 measured chips + "+N", cut by the static width table (visibleChips)', () => {
  const MAX = props({
    folder: 'Shopping / Netherlands',
    tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
    locationLabel: 'Amsterdam, North Holland, Netherlands',
    osFingerprint: REAL_OS,
  });

  /** The card measures its OWN row (`useContentWidth`) and jsdom reports 0, so
   *  the arms that need a real column width stub `clientWidth` on the status row
   *  — the row `useContentWidth` reads — for the duration of one render, and
   *  restore the descriptor byte-exactly afterwards. */
  const atContentWidth = (px: number, body: () => void): void => {
    const proto = Element.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return this.getAttribute('data-region') === 'status' ? px : 0;
      },
    });
    try {
      body();
    } finally {
      if (original !== undefined) Object.defineProperty(proto, 'clientWidth', original);
      else Reflect.deleteProperty(proto, 'clientWidth');
    }
  };

  it('visibleChips C1 — every MEASURED chip is visible at every card width: the compact OS label at 144 / 152, the FULL label from content 167 (QUIC ~) / 169 (QUIC ✓) up', () => {
    // ProfilePhoneCard.tsx `visibleChips` — three levels in order: full labels,
    // compact labels (OS_LABEL_COMPACT), then whole chips by C3 priority.
    // ⛔ Every literal below is MEASURED, 2026-09-12, in the live harness with
    // CHIP_BASE at px-1 (Chromium/Playwright @2x, after document.fonts.ready):
    // UDP ✓ 40.22, QUIC ~ 42.03, QUIC ✓ 44.30, ✓ iOS/macOS 73.38, ✓ Apple 47.16
    // — and C4 (2026-09-12) put those MEASUREMENTS in CHIP_WIDTH instead of their
    // ceilings. The ceil was a second, unnamed slack floor stacked on
    // CAPS_MIN_SLACK, and the pair of them refused the widest green trio at the
    // 178px column (145 reserved against 144, for a row that renders 139.68),
    // which is exactly the '+1' the owner asked about. (The font that rendered them
    // is the -apple-system FALLBACK: 'Geist Sans' heads the `font-sans` stack but
    // nothing ships it — `document.fonts.size === 0` in the harness. See the
    // table's own comment; it is named in the re-measure trigger there.) The old
    // geometry was 45 + 47 + 78 + 8 = 178 against 144 — 34px over, which is why
    // the OS chip was ALWAYS the one in the '+1' from a 178px card to a 211px one.
    // Lowering any literal below its rendered width re-opens the mid-glyph cut;
    // inflating one by 20px reds the 144 arm (the C4 mutation, run 2026-09-12).
    const at144 = visibleChips(MAX, 144);
    expect(at144.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ~', '✓ Apple']);
    expect(at144.chips.map((c) => c.width)).toEqual([40.22, 42.03, 47.16]);
    expect(at144.hiddenHints).toEqual([]);
    // 152 — the 186px column of the 1440 viewport, the width that used to cut
    // the OS chip mid-glyph.
    const at152 = visibleChips(MAX, 152);
    expect(at152.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ~', '✓ Apple']);
    expect(at152.hiddenHints).toEqual([]);
    // The compact trio itself: 40.22 + 42.03 + 47.16 + 8 = 137.41 for MAX's
    // inferred QUIC, plus the CAPS_MIN_SLACK floor of 3 that every reservation
    // carries since the Linux geometry run = 140.41. That floor exists because
    // the one row that clipped on a wider font stack was the one that fit by a
    // single pixel; see rowWidth. ⛔ It is now the ONLY floor (C4) — the
    // thresholds here are 3px above the MEASURED sum, not 3px above a ceil'd one.
    expect(visibleChips(MAX, 143).chips).toHaveLength(3);
    expect(visibleChips(MAX, 141).chips).toHaveLength(3);
    // ⛔ (V-219, 2026-09-14) BELOW THE COMPACT TRIO THE EVICTION ORDER FLIPPED,
    // DELIBERATELY. This read ['UDP ✓', 'QUIC ~'] until today — the GREEN OS chip
    // was the one that went. `keep` was `os.tone === 'mismatch'` and is now
    // `fingerprint !== undefined && !unavailable && measuring !== true`, so EVERY
    // measured reading is pinned to the row whatever its tone and the QUIC chip
    // rides the '+1' instead. The trade is the owner's own ruling, twice over:
    // the OS reading is the fact they said they could not see in the profile grid
    // at all, and a measured fact behind an opaque '+N' is the thing they
    // objected to. A future reader can tell this from a regression by the
    // mutation: reverting `keep` to the tone test restores the old pair here.
    expect(visibleChips(MAX, 140).chips.map((c) => c.text)).toEqual(['UDP ✓', '✓ Apple']);
    expect(visibleChips(MAX, 140).hiddenHints[0]).toMatch(/^QUIC ~ — /);
    // 166.63 = 40.22 + 42.03 + 73.38 + 8 + 3, MAX's full-label threshold: the
    // sweep flips from '✓ Apple' to '✓ iOS/macOS' at content 167 / a 201px card.
    expect(visibleChips(MAX, 166).chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ~', '✓ Apple']);
    expect(visibleChips(MAX, 167).chips.map((c) => c.text)).toEqual([
      'UDP ✓',
      'QUIC ~',
      '✓ iOS/macOS',
    ]);
    // ⛔ C4 — THE OWNER'S OWN ROW, AT THE OWNER'S OWN WIDTH.
    // MAX carries the INFERRED 'QUIC ~' (42.03). The row's worst case is the
    // MEASURED 'QUIC ✓' (44.3) — an ordinary healthy proxy whose live session
    // reported h3 — so every threshold is 2.27px higher there: the compact trio
    // reserves 40.22 + 44.3 + 47.16 + 8 + 3 = 142.68 and the full one 168.9.
    // 144 IS THE 178px COLUMN, the narrowest the grid can produce
    // (`minmax(178px,1fr)`, content = card − 34). This arm asserted the OPPOSITE
    // until C4 — `toEqual(['UDP ✓', 'QUIC ✓'])`, i.e. the measured OS match behind
    // a '+1' — inside a test whose own title promises "every MEASURED chip is
    // visible at every card width". It was green the whole time, because the pin
    // was written from the arithmetic instead of from the owner's sentence.
    // Rendered before the fix, both themes, real card, 178px: 'UDP ✓  QUIC ✓  +1'.
    const GREEN_WORST = props({ osFingerprint: REAL_OS, quicMeasured: 'h3' });
    expect(visibleChips(GREEN_WORST, 144).chips.map((c) => c.text)).toEqual([
      'UDP ✓',
      'QUIC ✓',
      '✓ Apple',
    ]);
    expect(visibleChips(GREEN_WORST, 144).hiddenHints).toEqual([]);
    // …and the floor is still a floor: 142.68 needs 143, so 142 still drops one.
    // ⛔ (V-219) WHICH one it drops changed, and only that: the measured
    // '✓ Apple' now outranks the measured 'QUIC ✓' for the same reason as the
    // 140 arm above. What this pair measures is the FLOOR — that 142.68 needs
    // 143 — and the floor has not moved a pixel.
    expect(visibleChips(GREEN_WORST, 143).chips).toHaveLength(3);
    expect(visibleChips(GREEN_WORST, 142).chips.map((c) => c.text)).toEqual(['UDP ✓', '✓ Apple']);
    expect(visibleChips(GREEN_WORST, 168).chips.map((c) => c.text)).toEqual([
      'UDP ✓',
      'QUIC ✓',
      '✓ Apple',
    ]);
    expect(visibleChips(GREEN_WORST, 169).chips.map((c) => c.text)).toEqual([
      'UDP ✓',
      'QUIC ✓',
      '✓ iOS/macOS',
    ]);
    const at206 = visibleChips(MAX, 206);
    expect(at206.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ~', '✓ iOS/macOS']);
    expect(at206.chips.map((c) => c.width)).toEqual([40.22, 42.03, 73.38]);
    expect(at206.hiddenHints).toEqual([]);
    expect(visibleChips(MAX, 226).chips).toHaveLength(3);
    // Below the compact trio (140.41 here, 142.68 at 'QUIC ✓', slack floor
    // included) a whole chip goes — and the '+N' hint then carries the FULL
    // label, never the compact one.
    // ⛔ (V-219) …and the chip that goes is the QUIC one now, not the OS one —
    // see the 140 arm. The FULL-label property of the hint is UNCHANGED and is
    // still pinned below, at the only widths where a MEASURED OS chip can be
    // hidden at all.
    const at128 = visibleChips(MAX, 128);
    expect(at128.chips.map((c) => c.text)).toEqual(['UDP ✓', '✓ Apple']);
    expect(at128.hiddenHints).toHaveLength(1);
    expect(at128.hiddenHints[0]).toMatch(/^QUIC ~ — /);
    // The '+1' tail reserves 27px (dashed border + 9.5px). The surviving pair is
    // 'UDP ✓' + the pinned '✓ Apple' now: 40.22 + 47.16 + 4 + 4 + 27 = 122.38,
    // +3 slack floor = 125.38 — so 126 keeps two and 125 keeps one. (It was
    // 40.22 + 42.03 + … = 120.25 while the pair was 'UDP ✓' + 'QUIC ~'; the
    // arithmetic is the same, the operands moved.)
    expect(visibleChips(MAX, 126).chips).toHaveLength(2);
    expect(visibleChips(MAX, 125).chips).toHaveLength(1);
    // The LAST chip standing is the measured reading — 47.16 + 4 + 27 + 3 =
    // 81.16 — which is the privilege the red mismatch has always had (C3), now
    // extended to every measured tone rather than to the one that alarms.
    expect(visibleChips(MAX, 82).chips.map((c) => c.text)).toEqual(['✓ Apple']);
    const tiny = visibleChips(MAX, 81);
    expect(tiny.chips).toEqual([]);
    // Below that even the pinned chip goes, and THERE the hint still carries the
    // FULL label, never the compact one: the '+N' pill is where the long form
    // belongs (C2). Asserted both ways so a compact label cannot leak in.
    expect(tiny.hiddenHints).toHaveLength(3);
    expect(tiny.hiddenHints[2]).toMatch(/^✓ iOS\/macOS — Your proxy presents as iOS\/macOS/);
    expect(tiny.hiddenHints.some((h) => h.startsWith('✓ Apple'))).toBe(false);
    // Every other measured chip, pinned to its px-1 render as well.
    const widths = (over: Partial<ProfilePhoneCardProps>) =>
      Object.fromEntries(visibleChips(props(over), 400).chips.map((c) => [c.text, c.width]));
    expect(widths({ quicMeasured: 'h3' })).toMatchObject({ 'QUIC ✓': 44.3 });
    expect(widths({ quicMeasured: 'h2-only' })).toMatchObject({ '⤵ QUIC': 43.55 });
    expect(
      widths({ capabilities: { ...props().capabilities!, udp_associate: false } }),
    ).toMatchObject({
      '⤵ UDP': 39.47,
    });
    expect(widths({ testing: true })).toMatchObject({ '… OS': 33.41 });
    // Fixed order is UDP → QUIC → OS whatever fits.
    expect(visibleChips(MAX, 40).chips.map((c) => c.text)).toEqual([]);
    expect(visibleChips(MAX, 40).hiddenHints).toHaveLength(3);
    // The table is measured FROM this exact chrome string; px-1.5 makes every
    // entry 4px short of the render.
    expect(source('components/ProfilePhoneCard.tsx')).toContain(
      "'inline-flex shrink-0 cursor-help items-center gap-0.5 whitespace-nowrap rounded-md px-1 py-px text-[9.5px] font-semibold leading-4'",
    );
  });

  it('C4 — every CHIP_WIDTH entry is the MEASURED width, never its ceiling: the table may not carry a second, unnamed slack floor', () => {
    // ProfilePhoneCard.tsx CHIP_WIDTH + rowWidth. The entries were ceil'd until
    // 2026-09-12, so every row carried 0–1px a chip of slack ON TOP of
    // CAPS_MIN_SLACK — invisible in the arithmetic, absent from every comment,
    // and worth exactly the one pixel that put a MEASURED OS match behind a '+1'
    // at the 178px column (145 reserved against 144, for a row rendering 139.68).
    // The per-entry remainders are not uniform either — 0.84px on '✓ Apple' but
    // 0.03px on '✗ Win' — so the credit cannot be modelled as "a pixel a chip"
    // and the rounding simply has to go.
    // This is a SHAPE invariant, deliberately in its own test: the width arms
    // elsewhere pin the cells that have callers, and this one catches a NEW cell
    // added as an integer, which no behaviour arm would see.
    // Mutation run 2026-09-12: `'✗ BSD': 38.89 → 39` → red here.
    const table = source('components/ProfilePhoneCard.tsx')
      .split('const CHIP_WIDTH')[1]!
      .split('};')[0]!;
    const entries = [...table.matchAll(/'([^']+)': (\d+(?:\.\d+)?)/g)].map((m) => [
      m[1]!,
      Number(m[2]),
    ]);
    // 15 -> 21 on 2026-09-14 (V-219): the '?' glyph now pairs with a NAMED OS,
    // not only the bare 'OS' label, so all six `? × (OS_LABEL |
    // OS_LABEL_COMPACT)` pairs became reachable at once. They were measured into
    // the table the same day, by the same method, with '? OS' and '✓ Apple' as
    // controls reproducing their existing entries — see CHIP_WIDTH's note.
    //
    // ⛔ This count is the POINT of the arm, not incidental to it: a new label
    // that renders without being measured falls to the `ceil(len * 6 + 14)`
    // estimate, and that estimate over-reserves. '? Apple' estimated 56 against
    // a real 43.80 and put a measured OS chip behind a '+1' at the 178px column.
    // Update it only alongside a real measurement.
    // 21 -> 22 on 2026-09-24 (owner item 9): 'UDP — not on plan' (96.5), a VPN
    // row on a plan without VPN, measured the same way with '? OS' 29.97 and
    // '✓ Apple' 47.16 reproduced as controls in the same run.
    expect(entries).toHaveLength(22);
    expect(entries.filter(([, n]) => Number.isInteger(n)).map(([t]) => t)).toEqual([]);
    // …and the floor it is the only companion of is still named and still 3.
    expect(source('components/ProfilePhoneCard.tsx')).toContain('const CAPS_MIN_SLACK = 3;');
  });

  it('visibleChips C3 — a MISMATCH fits 144 as "✗ Win", and where even the compact row does not fit the RED chip keeps its place and a GREEN one goes into the "+N"', () => {
    // ProfilePhoneCard.tsx: the `keep` flag and the materialised drop order in
    // `visibleChips` level 3. ⛔ (V-219, 2026-09-14) That flag is no longer
    // `os.tone === 'mismatch'` — it is `fingerprint !== undefined &&
    // !unavailable && measuring !== true`, so the red row below is now ONE
    // INSTANCE of a general rule ("a measured reading keeps its place") rather
    // than the exception it used to be. The red geometry is unchanged, which is
    // why this arm still reads as it did. Dropping `keep` makes
    // the 128 arm below render ['UDP ✓', 'QUIC ✓'] with the red chip hidden →
    // red (mutation run 2026-09-12). MEASURED at px-1: ✗ Windows 62.14, ✗ Win
    // 36.97, so the full red trio is 40.22 + 44.3 + 62.14 + 8 = 154.66 and the
    // compact one 129.49, each +3 for the CAPS_MIN_SLACK floor (rowWidth) →
    // 157.66 and 132.49 against 144. (C4: the entries are the MEASUREMENTS now,
    // not their ceilings — see CHIP_WIDTH.)
    // ⛔ (V-219) WINDOWS_OS carries `singleHostVantage: true` since 2026-09-14,
    // and it has to: the verdict withholds the red tone as hard as the green one
    // unless the reading is about a website's path, and what THIS arm measures is
    // the drop order a red chip gets — not whether the tone is minted. The
    // withheld direction is pinned in its own arm below ('V-219 — the vantage
    // gate is SYMMETRIC'), where the lost `keep` is asserted too.
    const RED = props({ osFingerprint: WINDOWS_OS, quicMeasured: 'h3' });
    const at144 = visibleChips(RED, 144);
    expect(at144.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ✓', '✗ Win']);
    expect(at144.chips.map((c) => c.width)).toEqual([40.22, 44.3, 36.97]);
    expect(at144.hiddenHints).toEqual([]);
    const os = at144.chips.find((c) => c.key === 'os');
    expect(os?.attrs['data-os-tone']).toBe('mismatch');
    expect(os?.title).toMatch(/^(Your proxy presents as|This proxy looks like) Windows/);
    // 157.66 is where the full label takes over: content 158, a 192px card.
    expect(visibleChips(RED, 157).chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ✓', '✗ Win']);
    expect(visibleChips(RED, 158).chips.map((c) => c.text)).toEqual([
      'UDP ✓',
      'QUIC ✓',
      '✗ Windows',
    ]);
    // C3 — narrower than the compact trio (132.49): the GREEN QUIC chip is what
    // moves into the '+1'; the one measured defect stays visible. No real column
    // is this narrow (minmax(178px,1fr) ⇒ 144), so this never fires in the app.
    const at128 = visibleChips(RED, 128);
    expect(at128.chips.map((c) => c.text)).toEqual(['UDP ✓', '✗ Win']);
    expect(at128.hiddenHints).toHaveLength(1);
    expect(at128.hiddenHints[0]).toMatch(/^QUIC ✓ — /);
    // …and at the narrowest the mismatch is the last chip standing
    // (36.97 + 4 + 27 + 3 slack = 70.97).
    expect(visibleChips(RED, 71).chips.map((c) => c.text)).toEqual(['✗ Win']);
    expect(visibleChips(RED, 70).chips).toHaveLength(0);
    // ⛔ (V-219, 2026-09-14) A GREEN OS CHIP HAS THE SAME PRIVILEGE NOW.
    // This line read "A green OS chip has no such privilege: it goes first, as
    // it always did" and asserted ['UDP ✓', 'QUIC ~']. Retention is keyed on
    // HAVING MEASURED, not on the tone, so the green reading is pinned here
    // exactly as the red one is and the QUIC chip is what moves into the '+1'.
    // Nothing in the drop order is mismatch-specific any more.
    expect(visibleChips(MAX, 128).chips.map((c) => c.text)).toEqual(['UDP ✓', '✓ Apple']);
    expect(visibleChips(MAX, 128).hiddenHints[0]).toMatch(/^QUIC ~ — /);
    // 'Linux' (45) and 'BSD' (39) are already short enough to fit 144 in FULL,
    // so they compact to themselves and the label never changes.
    // ⛔ The WIDTH is asserted, not just the presence. Asserting only "the chip is
    // there at 144" is one-sided: a TOO-SMALL table entry keeps it there, so
    // `'✗ Linux': 44.53 → 25` and `'✗ BSD': 38.89 → 19` both read GREEN against that
    // (both mutations were run on 2026-09-12 and both passed 110/110 — these were
    // the only two cells in the table with no guard). And the geometry gate cannot
    // cover for them: visual-harness/gallery.tsx has exactly two `osFingerprint`
    // states and BOTH are 'macos-or-ios', so no mismatch chip is ever rendered
    // under scripts/gui-visual-check.mjs. A stale cell here reaches production
    // unseen, and the failure is the one the table's comment exists to prevent —
    // three chips whose real sum exceeds 144, the last cut mid-glyph.
    for (const [fp, text, width] of [
      [LINUX_OS, '✗ Linux', 44.53],
      [BSD_OS, '✗ BSD', 38.89],
    ] as const) {
      const v = visibleChips(props({ osFingerprint: fp, quicMeasured: 'h3' }), 144);
      expect(v.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ✓', text]);
      expect(v.chips.map((c) => c.width)).toEqual([40.22, 44.3, width]);
      expect(v.chips.find((c) => c.key === 'os')?.compact).toBeUndefined();
      expect(v.hiddenHints).toEqual([]);
    }
    // The flag behind all of the above, pinned LAST on purpose: removing it must
    // be caught by the 128px behaviour arm, not by this restatement of it.
    expect(os?.keep).toBe(true);
    expect(MAX.osFingerprint?.os).toBe('macos-or-ios');
    // ⛔ (V-219) …and the GREEN reading carries the flag too. This asserted
    // `toBeUndefined()` until 2026-09-14, correctly, while `keep` was the
    // mismatch tone. The half of the rule that still DROPS a chip is the one
    // holding no measurement at all, and it has its own arm below ("a chip
    // carrying NO measurement is still droppable") — without which this pair
    // would no longer bound the flag in both directions.
    expect(visibleChips(MAX, 144).chips.find((c) => c.key === 'os')?.keep).toBe(true);
  });

  it('V-219 — the vantage gate is SYMMETRIC: with no singleHostVantage neither the green match nor the red mismatch is minted — and the withheld reading KEEPS its place in the row, because withholding a verdict is not failing to measure', () => {
    // ⛔ ADDED 2026-09-14. This is a DELIBERATE INVERSION of the two C1/C3 arms
    // above, not a regression: os-fingerprint-verdict.ts now gates BOTH arms on
    // whether the reading is about the path a WEBSITE gets. MEASURED by the
    // owner with a third-party instrument — browserleaks.com/ip loaded THROUGH
    // their residential proxy reads the arriving stack on 443 and reports
    // Mac/iOS; our observer reads the same proxy on 7791 and reports Linux at
    // high confidence. The provider routes web traffic through the residential
    // device and odd ports through its own infrastructure, so the chip was
    // painting a verdict about a path no website ever touches.
    //
    // ⛔⛔ BOTH DIRECTIONS ARE ASSERTED HERE AND THE SYMMETRY IS THE POINT.
    // Withholding only the red arm — the one that produced the complaint —
    // would have been a complaint-to-evidence fix: the green is minted from the
    // identical SYN over the identical path, and a vantage that cannot support
    // "detectable mismatch" cannot support "matches the iOS device it fronts"
    // either. Of the two errors the false green is far worse. A red chip is an
    // irritant somebody eventually reports; a green chip on a proxy that is
    // actually detectable costs a customer their account, and nobody ever files
    // a bug about a reassuring badge. An arm that pinned only the red half
    // would leave the product able to falsely reassure and unable to falsely
    // alarm, with no instrument left that could contradict a wrong green.
    //
    // ABSENT MEANS FALSE, so the legacy shape is pinned beside the explicit one:
    // a cached record written before the field existed, an older server and a
    // tampered response all read `undefined`, and every one of them has to fail
    // to assert rather than default into a confident claim.
    // ⛔ OWNER 2026-09-24 (item 9), verbatim: "if it's a Apple, it should be green
    // status, which we don't always have". The GREEN half of this symmetry was
    // overruled: an Apple reading reads '✓' from these vantages too (pinned just
    // after this loop, with the caveat now in its title). The RED half stands and
    // is what this loop pins.
    for (const [label, fp, os] of [
      ['red, server said false', WINDOWS_OS_MULTI_HOP, 'Windows'],
      ['red, legacy record with no vantage field at all', WINDOWS_OS_LEGACY, 'Windows'],
    ] as const) {
      // Width 400 on purpose: every chip fits, so this arm measures the VERDICT
      // and the geometry cannot decide it. See the note below.
      const chip = visibleChips(props({ osFingerprint: fp, quicMeasured: 'h3' }), 400).chips.find(
        (c) => c.key === 'os',
      );
      expect(chip?.text, label).toBe(`? ${os}`);
      expect(chip?.attrs['data-os-tone'], label).toBe('unknown');
      // ⛔ RETENTION SURVIVES THE WITHHELD VERDICT — AND IT BRIEFLY DID NOT.
      // For a few hours on 2026-09-14 this line asserted `toBeUndefined()`, and
      // was a true description of the code: C3's flag was keyed on the MISMATCH
      // tone (`keep: os.tone === 'mismatch'`), so withholding the tone ALSO
      // un-pinned the chip and dropped it behind a '+1' at the grid's narrowest
      // column. That is the owner's original complaint reintroduced by the fix
      // for a different one — "this +1 next to profile … its unclear what its
      // about, better to show everything", plus "i dont see OS currently at
      // profile grid". So the production rule was changed rather than this
      // consequence documented: `keep` now asks "did we MEASURE something" (a
      // fingerprint that is present, not `unavailable`, not `measuring`) instead
      // of "did we DECIDE something". A withheld reading IS a reading — we
      // declined to draw a conclusion from it, we did not fail to take it — so
      // it keeps its place whatever its tone. The geometry consequence is
      // re-measured at the foot of this arm.
      expect(chip?.keep, label).toBe(true);
      expect(chip?.title, label).toMatch(
        /^This proxy looks like .+ \((high|medium|low) confidence\), but it forwards through more than one machine/,
      );
      expect(chip?.title, label).toMatch(
        /a website may reach a different one\. Not a conclusion either way\./,
      );
      // …and it is never worded as either verdict, at any width.
      expect(chip?.title, label).not.toMatch(/can be detected|matches the iOS device behind it/);
    }
    // OWNER 2026-09-24 — the green half: the same two vantages, an Apple reading,
    // a '✓' match that SAYS what the vantage cannot rule out.
    for (const [label, fp] of [
      ['green, server said false', REAL_OS_MULTI_HOP],
      ['green, legacy record with no vantage field at all', REAL_OS_LEGACY],
    ] as const) {
      const chip = visibleChips(props({ osFingerprint: fp, quicMeasured: 'h3' }), 400).chips.find(
        (c) => c.key === 'os',
      );
      expect(chip?.text, label).toBe('✓ iOS/macOS');
      expect(chip?.attrs['data-os-tone'], label).toBe('match');
      expect(chip?.keep, label).toBe(true);
      expect(chip?.title, label).toMatch(/matches the iOS device behind it/);
      expect(chip?.title, label).toMatch(/some websites may reach a different one/);
    }
    // ⛔ VACUITY CONTROL — the IDENTICAL readings WITH the vantage still assert,
    // in both tones. Without this the loop above would pass just as happily if
    // the fixtures had stopped being readings at all, or if the chip had stopped
    // being produced: "no verdict" is the easiest thing in the world to get for
    // the wrong reason.
    // ⛔ `keep` is TRUE on all four rows now (the two here and the two above),
    // so it is NOT what this control discriminates on any more — the TEXT and
    // the TONE are, and they are the two columns that still differ. Read the
    // keep column as a pin on the new rule's uniformity, not as evidence that
    // the fixtures still assert.
    for (const [label, fp, text, tone, keep] of [
      ['green', REAL_OS, '✓ iOS/macOS', 'match', true],
      ['red', WINDOWS_OS, '✗ Windows', 'mismatch', true],
    ] as const) {
      const chip = visibleChips(props({ osFingerprint: fp, quicMeasured: 'h3' }), 400).chips.find(
        (c) => c.key === 'os',
      );
      expect(chip?.text, label).toBe(text);
      expect(chip?.attrs['data-os-tone'], label).toBe(tone);
      expect(chip?.keep, label).toBe(keep);
    }
    // ⛔ ONE CONSEQUENCE THIS ARM DELIBERATELY DOES NOT PIN, because it is the
    // owner's call and not this file's — recorded here so the next reader does
    // not have to re-derive it.
    //
    // The withheld tone mints labels that are NEW reachable strings: '?' is no
    // longer paired only with 'OS'. '? iOS/macOS', '? Apple', '? Windows',
    // '? Win', '? Linux' and '? BSD' are all reachable now, and CHIP_WIDTH holds
    // none of them — its own comment still says the '?' glyph appears "only with
    // the 'OS' label", a sentence V-219 made false. They fall back to
    // `ceil(len * 6 + 14)`, which OVER-reserves: '? Apple' reserves 56 where a
    // '✓ Apple' of the same shape renders 47.16.
    //
    // ⛔ RE-MEASURED 2026-09-14 AFTER THE RETENTION RULE CHANGED. The note here
    // used to record TWO compounding causes; ONE OF THEM IS FIXED and the entry
    // is rewritten rather than appended to, because a stale measurement beside a
    // current one is indistinguishable from a current one.
    //
    // `visibleChips` at the four real column widths, withheld green (default
    // inferred QUIC) and withheld red (measured QUIC):
    //   content 144 (the 178px column, the grid's floor)
    //     green → ['UDP ✓','? Apple'] and a '+1' holding the QUIC chip
    //     red   → ['UDP ✓','QUIC ✓','? Win'] — the whole row fits
    //   content 152 → ['UDP ✓','QUIC ~','? Apple']   (nothing hidden)
    //   content 172 → ['UDP ✓','QUIC ~','? Apple']
    //   content 206 → ['UDP ✓','QUIC ~','? iOS/macOS']
    // So the withheld READING is on the row at every real column now — that was
    // the cause worth fixing, and `keep` fixed it. What remains is a '+1' at the
    // narrowest column ONLY, holding the QUIC chip, and it has a single cause
    // left: the un-measured label over-reserves. '?' is no longer paired only
    // with 'OS', none of the six new strings is in CHIP_WIDTH, and the fallback
    // gives '? Apple' 56 where the same-shaped '✓ Apple' renders 47.16 — nine
    // pixels of arithmetic that measures nothing, the same defect C4 removed
    // from the rest of the table.
    //
    // Whether the answer is to measure the six labels into CHIP_WIDTH or to
    // accept the pill there is still a PRODUCT decision, so this arm continues to
    // assert the verdict at a width the width table cannot reach and leaves the
    // geometry to the owner. Widening a fixture until the eviction disappears
    // would paper over it.
    expect(visibleChips(props({ osFingerprint: REAL_OS_LEGACY }), 400).chips).toHaveLength(3);
  });

  it('visibleChips C2 — the OS row is ALWAYS a chip, measured or not; the "+N" holds only what is not a measurement at all', () => {
    // ⛔ This arm asserted the opposite until 2026-09-12, and the owner is why:
    // an unmeasured OS rode the '+1', which on their own build (a control-plane
    // projection gap, so no reading at all) left exactly the opaque pill they
    // asked about. '— OS' states the absence; its title says which absence.
    const unmeasured = visibleChips(props(), 144);
    expect(unmeasured.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ~', '— OS']);
    expect(unmeasured.chips[2]?.title).toMatch(/^OS not measured yet\. Run Test/);
    expect(unmeasured.hiddenHints).toEqual([]);
    // The VPN row is the vacuity control for the '+N' itself: something CAN
    // still be hidden, so the loop below is not passing because nothing ever is.
    const vpn = visibleChips(
      props({ vpn: true, capabilities: null, latencyMs: 61, quicProbe: true }),
      144,
    );
    // ⛔ The VPN row's THIRD chip. "UDP travels inside the tunnel" was the last
    // hint riding a '+N' here — the owner's "+1 on an OpenVPN" (2026-09-14) —
    // and it is a chip now with its own glyph. Nothing is hidden on this row.
    expect(vpn.chips.map((c) => c.text)).toEqual(['⇢ UDP', 'QUIC ✓', '— OS']);
    expect(vpn.chips[0]?.title).toMatch(/UDP travels inside the VPN\./);
    expect(vpn.chips[2]?.title).toMatch(
      /^OS not measured: the OS check is not available for VPN connections/,
    );
    expect(vpn.hiddenHints).toEqual([]);
    // A MEASUREMENT is never in the pill at any real column width — including
    // the '?' verdict, which is a COMPLETED classification and not a placeholder.
    // ⛔ (V-219) The four OS fixtures carry the single-host vantage, so the OS
    // chip here is the asserting one this arm was written for. A reading whose
    // vantage is withheld is STILL a measurement and still eligible — but its
    // label is one CHIP_WIDTH has never been measured for, and at content 144 it
    // is evicted. That is recorded, and deliberately not pinned, in the symmetry
    // arm above.
    for (const over of [
      { osFingerprint: REAL_OS },
      { osFingerprint: WINDOWS_OS },
      { osFingerprint: LINUX_OS },
      { osFingerprint: BSD_OS },
      { osFingerprint: UNDETERMINED_OS },
      { testing: true },
      {},
    ] as Partial<ProfilePhoneCardProps>[]) {
      for (const width of [144, 152, 172, 206, 226]) {
        const v = visibleChips(props(over), width);
        expect(v.chips).toHaveLength(3);
        expect(v.hiddenHints).toEqual([]);
      }
    }
  });

  it('the rendered row has ≤ 3 chip children plus an optional caps-overflow whose title lists every hidden hint', () => {
    const { container } = render(<ProfilePhoneCard {...MAX} />);
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.getAttribute('data-caps-mode')).toBe('measured');
    const overflow = byComponent(caps, 'caps-overflow');
    const chipEls = Array.from(caps.children).filter((c) => c !== overflow);
    expect(chipEls.length).toBeLessThanOrEqual(3);
    // jsdom measures 0px, so the card keeps DEFAULT_CONTENT_WIDTH (206): all three fit.
    expect(DEFAULT_CONTENT_WIDTH).toBe(206);
    expect(chipEls).toHaveLength(3);
    expect(overflow).toBeNull();
    cleanup();
  });

  it('the row reads its OWN width: at a measured 144px MAX renders ALL THREE chips with the compact OS label and NO "+1" — C1, the owner’s "i dont see OS currently at profile grid"', () => {
    // ProfilePhoneCard.tsx `useContentWidth` + `visibleChips` level 2:
    //   • replacing the measured `el.clientWidth` with DEFAULT_CONTENT_WIDTH
    //     renders the FULL '✓ iOS/macOS' here instead (206 ≥ 166) → red;
    //   • inflating any CHIP_WIDTH entry by 20px brings the '+1' back → red;
    //   • dropping level 2 (the compact label) restores the old 2-chip row → red.
    atContentWidth(144, () => {
      const { container } = render(<ProfilePhoneCard {...MAX} />);
      const caps = byRegion(container, 'caps') as HTMLElement;
      expect(byComponent(caps, 'caps-overflow')).toBeNull();
      const os = byComponent(caps, 'proxy-os-fingerprint') as HTMLElement;
      expect(os).not.toBeNull();
      expect(os.textContent).toBe('✓ Apple');
      expect(os.getAttribute('data-os-tone')).toBe('match');
      // The full claim is not lost: it is the chip's own title — and 'Apple' is
      // the family BOTH members of 'macos-or-ios' share, so the compact form
      // shortens the claim without deciding it.
      expect(os.getAttribute('title')).toMatch(
        /^(Your proxy presents as|This proxy looks like) iOS\/macOS/,
      );
      expect(Array.from(caps.children).map((c) => c.textContent)).toEqual([
        'UDP ✓',
        'QUIC ~',
        '✓ Apple',
      ]);
      cleanup();
    });
  });

  it('C3 rendered — a MISMATCH at a measured 144px renders the red chip itself ("✗ Win", soft red ink), never a "+1"', () => {
    // ProfilePhoneCard.tsx OS_LABEL_COMPACT['windows']: reverting it to 'Windows'
    // puts the trio at 157 > 144 and the red chip back into the '+1' → red arm.
    // ⛔ (V-219) The fixture's `singleHostVantage: true` is what still makes this
    // a mismatch at all; this arm is about the compact label and the red chrome.
    // Its inversion — the same reading with the vantage withheld — is the arm
    // 'V-219 rendered' below, which asserts the red chrome is gone.
    atContentWidth(144, () => {
      const { container } = render(
        <ProfilePhoneCard {...props({ osFingerprint: WINDOWS_OS, quicMeasured: 'h3' })} />,
      );
      const caps = byRegion(container, 'caps') as HTMLElement;
      expect(byComponent(caps, 'caps-overflow')).toBeNull();
      const os = byComponent(caps, 'proxy-os-fingerprint') as HTMLElement;
      expect(os.textContent).toBe('✗ Win');
      expect(os.getAttribute('data-os-tone')).toBe('mismatch');
      expect(classes(os)).toEqual(
        expect.arrayContaining(['bg-status-error/15', 'text-status-error-text', 'px-1']),
      );
      expect(os.getAttribute('title')).toMatch(
        /^(Your proxy presents as|This proxy looks like) Windows/,
      );
      expect(Array.from(caps.children).map((c) => c.textContent)).toEqual([
        'UDP ✓',
        'QUIC ✓',
        '✗ Win',
      ]);
      cleanup();
    });
  });

  it('V-219 rendered — the SAME mismatch from a multi-hop vantage wears the neutral chrome, never the red; and the green half (Apple) is a match: owner 2026-09-24', () => {
    // ⛔ ADDED 2026-09-14 — the DOM counterpart of the symmetry arm above, and a
    // deliberate inversion of 'C3 rendered' directly before it. The fixture is
    // WINDOWS_OS minus the vantage and nothing else, so what this arm isolates
    // is the gate: the ink and the fill go with the claim they carried.
    //
    // Rendered at the card's own DEFAULT_CONTENT_WIDTH (206 — what jsdom's 0px
    // measurement falls back to) rather than under the 144px stub the C1/C3 arms
    // use, so the chip is on the row for reasons that have nothing to do with the
    // width table. See the eviction note in the symmetry arm: at content 144 the
    // withheld GREEN row does lose its chip, and that is the owner's decision to
    // make, not a thing to encode here.
    const { container } = render(
      <ProfilePhoneCard {...props({ osFingerprint: WINDOWS_OS_MULTI_HOP, quicMeasured: 'h3' })} />,
    );
    const caps = byRegion(container, 'caps') as HTMLElement;
    const os = byComponent(caps, 'proxy-os-fingerprint') as HTMLElement;
    expect(os).not.toBeNull();
    expect(os.textContent).toBe('? Windows');
    expect(os.getAttribute('data-os-tone')).toBe('unknown');
    // The exact two classes 'C3 rendered' asserts, now absent — a red chip is a
    // claim of a detectable defect, and this vantage cannot support one.
    expect(classes(os)).not.toContain('bg-status-error/15');
    expect(classes(os)).not.toContain('text-status-error-text');
    // …and it did not fall the OTHER way either: withholding a mismatch must not
    // mint the reassurance. This is the false green the gate exists to prevent.
    expect(classes(os)).not.toContain('text-status-ready');
    expect(classes(os)).toEqual(expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']));
    expect(os.getAttribute('title')).toMatch(
      /^This proxy looks like Windows \(high confidence\), but/,
    );
    expect(os.getAttribute('title')).toMatch(/a website may reach a different one/);
    expect(os.getAttribute('title')).not.toMatch(/detectable mismatch/);
    expect(byComponent(caps, 'caps-overflow')).toBeNull();
    cleanup();
    // The green half, from the shape MOST stored rows are actually in: a cached
    // record written before the field existed. ⛔ OWNER 2026-09-24 (item 9) — it
    // renders the green '✓ iOS/macOS' again (V-219 had made it '? iOS/macOS'),
    // with the vantage's caveat in its title.
    const { container: green } = render(
      <ProfilePhoneCard {...props({ osFingerprint: REAL_OS_LEGACY })} />,
    );
    const g = byComponent(
      byRegion(green, 'caps') as HTMLElement,
      'proxy-os-fingerprint',
    ) as HTMLElement;
    expect(g.textContent).toBe('✓ iOS/macOS');
    expect(g.getAttribute('data-os-tone')).toBe('match');
    expect(classes(g)).toContain('text-status-ready');
    expect(g.getAttribute('title')).toMatch(/matches the iOS device behind it/);
    expect(g.getAttribute('title')).toMatch(/some websites may reach a different one/);
    cleanup();
  });

  it('C1 — a compact label may only SHORTEN the claim, never decide it: "✓ Apple", never a bare "✓ iOS"', () => {
    // ProfilePhoneCard.tsx OS_LABEL_COMPACT['macos-or-ios']. 'macos-or-ios' is ONE
    // member of FingerprintedOs because `fingerprintOs` cannot separate Darwin
    // from iOS (its own TTL-64 fallback says the option layout "does not separate
    // Darwin from Linux"), so a bare 'iOS' asserts half of a disjunction the probe
    // never resolved — and on a residential-proxy row, the implausible half. It is
    // also the row where the card already prints the PROFILE's 'iPhone 17', so
    // 'iOS' reads as that device rather than as a verdict about the proxy.
    // Mutation: OS_LABEL_COMPACT['macos-or-ios'] → 'iOS' reds every arm below.
    for (const width of [128, 140, 144, 152, 165, 166, 206, 226, 400]) {
      const texts = visibleChips(MAX, width).chips.map((c) => c.text);
      expect(texts).not.toContain('✓ iOS');
      for (const t of texts) expect(t).not.toMatch(/^✓ (iOS|macOS|Darwin)$/);
    }
    const os = visibleChips(MAX, 144).chips.find((c) => c.key === 'os');
    expect(os?.text).toBe('✓ Apple');
    expect(os?.width).toBe(47.16);
    // The full disjunction is never lost: it is the chip's title and the hint line.
    expect(os?.title).toMatch(/^Your proxy presents as iOS\/macOS to websites \(high confidence\)/);
    // ⛔ (V-219, 2026-09-14) THE HINT IS READ AT CONTENT 81, NOT 128. A measured
    // reading carries `keep` now, so at 128 the OS chip is ON the row and the
    // QUIC chip is the one in the '+1'; the OS hint is only reachable below
    // 81.16 — the width at which even the pinned chip plus its '+2' stops
    // fitting. The property this line pins is untouched: wherever the OS row
    // does end up in the pill, the HINT says 'iOS/macOS' and never the compact
    // 'Apple'. Pinned both ways so a compact label cannot leak into a hint.
    const hintsAt81 = visibleChips(MAX, 81).hiddenHints;
    expect(hintsAt81[2]).toMatch(/^✓ iOS\/macOS — /);
    expect(hintsAt81.some((h) => h.startsWith('✓ Apple'))).toBe(false);
    // …and the SOURCE, so a compact form can never be re-pointed at one member
    // without this arm being read first.
    expect(source('components/ProfilePhoneCard.tsx')).toContain("'macos-or-ios': 'Apple',");
    expect(source('components/ProfilePhoneCard.tsx')).not.toContain("'macos-or-ios': 'iOS',");
    // The invariant `compacted()` relies on, over EVERY member of the union: a
    // compact form is STRICTLY narrower, or it is absent. If one were ever wider,
    // level 2 would exceed level 1, both would fail, and level 3 would drop a whole
    // chip while rendering the LONGER text — a C1 regression from a word change.
    // Mutation: OS_LABEL_COMPACT['windows'] → 'Windows Server' reds this.
    for (const fp of [REAL_OS, WINDOWS_OS, LINUX_OS, BSD_OS, UNDETERMINED_OS] as const) {
      for (const chip of visibleChips(props({ osFingerprint: fp }), 400).chips) {
        if (chip.compact !== undefined) {
          expect(chip.compact.width, `${chip.text} → ${chip.compact.text}`).toBeLessThan(
            chip.width,
          );
          expect(chip.compact.text.length).toBeLessThan(chip.text.length);
        }
      }
    }
  });

  it("C2 — the '?' verdict is a COMPLETED classification, and the two '—' states are chips too", () => {
    // ProfilePhoneCard.tsx `capabilityChips` eligibility. os-fingerprint-verdict.ts
    // discriminates on `unavailable`, NOT on `os === 'unknown'`, precisely because
    // "we looked and could not tell" is a different statement from "there was
    // nothing here to look at" — its own comment. The '?' arm carries a real
    // reason from tcp-os-fingerprint.ts:84/:139 and narrows the answer, so it is a
    // measurement and C1 applies to it; '? OS' measures 29.97, trio 125.49/144.
    // Mutation: drop `os.glyph === '?'` from the eligibility test → red.
    const undet = visibleChips(props({ osFingerprint: UNDETERMINED_OS, quicMeasured: 'h3' }), 144);
    expect(undet.chips.map((c) => c.text)).toEqual(['UDP ✓', 'QUIC ✓', '? OS']);
    expect(undet.chips.map((c) => c.width)).toEqual([40.22, 44.3, 29.97]);
    expect(undet.hiddenHints).toEqual([]);
    const chip = undet.chips.find((c) => c.key === 'os');
    expect(chip?.attrs['data-os-tone']).toBe('unknown');
    expect(chip?.compact).toBeUndefined();
    // ⛔ (V-219, 2026-09-14) `keep` is TRUE here, and that is this arm's own
    // thesis rather than a surprise: '?' is a COMPLETED classification, so it
    // passes the new retention test — `fingerprint !== undefined &&
    // !unavailable && measuring !== true` — exactly as a '✓' or a '✗' does. It
    // asserted `toBeUndefined()` while retention was the mismatch TONE, i.e.
    // while a measurement that decided nothing was as droppable as no
    // measurement at all — the very distinction this arm exists to deny.
    expect(chip?.keep).toBe(true);
    expect(chip?.title).toMatch(/^OS could not be determined/);
    // ⛔ The two '—' states — never measured, and a cause the control plane
    // REPORTED — were hints here until 2026-09-12. They are chips now, for the
    // owner's reason recorded in capabilityChips: a '+1' that means "no OS
    // reading" is the opaque pill they asked about, and it was the state their
    // own build was in. The distinction '?' vs '—' survives where it is real —
    // in the GLYPH and the title, not in whether the row is shown at all.
    for (const [label, over, hint] of [
      ['never measured', {}, /^OS not measured yet\. Run Test/],
      [
        'reported unavailable',
        { osFingerprint: VPN_UNAVAILABLE_OS },
        /^OS not measured: the OS check is not available for VPN connections/,
      ],
    ] as const) {
      const v = visibleChips(props({ ...over, quicMeasured: 'h3' }), 144);
      expect(
        v.chips.map((c) => c.text),
        label,
      ).toEqual(['UDP ✓', 'QUIC ✓', '— OS']);
      expect(v.chips[2]?.width, label).toBe(33.33);
      expect(v.chips[2]?.title, label).toMatch(hint);
      expect(v.chips[2]?.attrs['data-os-tone'], label).toBe('unknown');
      // ⛔ (V-219) …and NEITHER carries `keep`: being a chip at every real width
      // is not the same privilege as being pinned when the row runs out. That is
      // the whole difference between '?' above and '—' here — one narrowed the
      // answer, the other has no answer to narrow — and the arm below turns it
      // into a behavioural contrast at a single width.
      expect(v.chips[2]?.keep, label).toBeUndefined();
      expect(v.hiddenHints, label).toEqual([]);
    }
  });

  it('C3/V-219 — the OTHER half of the retention rule: a chip carrying NO measurement is still droppable, and at ONE width the two halves separate', () => {
    // ProfilePhoneCard.tsx `capabilityChips`:
    //   keep: fingerprint !== undefined && fingerprint.unavailable === undefined
    //         && fingerprint.measuring !== true ? true : undefined
    //
    // ⛔ ADDED 2026-09-14 WITH THE RULE ITSELF. The clause that pins a measured
    // reading to the row is asserted all over this block; the three clauses that
    // let a NON-reading go had no arm of their own, and without one the rule
    // could be widened to a bare `true` — pinning '— OS' and '… OS', chips that
    // say only that there is nothing to say about this proxy's stack — with
    // every other arm in the file still green. That is the load-bearing half:
    // "the OS row always gets a chip" (C2) is a statement about WIDTH, and
    // "a measured reading keeps its place" is a statement about EVIDENCE; only
    // this arm stops the second from swallowing the first.
    // Mutation: `keep: true` unconditionally → the three non-reading rows below
    // render ['UDP ✓', <the OS chip>] and red here. ⚠️ DERIVED, NOT RUN — src/ was
    // out of scope for the session that added this arm, so the claim rests on the
    // 123px arithmetic below (a kept '— OS' reserves 40.22 + 33.33 + 4 + 4 + 27 +
    // 3 = 111.55, inside 123) plus its MEASURED neighbour: '? OS', a keep-flagged
    // OS chip 3.36px narrower, does render exactly that two-chip row at this
    // width. Run it before trusting the sentence.
    //
    // ONE WIDTH separates the halves, which is what makes this a contrast rather
    // than two unrelated pins. Content 123, measured at the runner 2026-09-14:
    //   • '? OS' (29.97) — a COMPLETED classification, so a reading — wants
    //     40.22 + 42.03 + 29.97 + 8 + 3 = 123.22 for the full trio, 0.22px more
    //     than it has. Level 3 fires and `keep` decides: the QUIC chip goes and
    //     the OS chip stays;
    //   • '— OS' (33.33 — never measured, or a cause the control plane REPORTED)
    //     and '… OS' (33.41 — the in-flight sentinel) want 126.58 / 126.66, miss
    //     by more, and carry no `keep` — so the OS chip is the one that goes,
    //     exactly as it did before V-219.
    // Same width, same shortfall, opposite outcome, decided by nothing but
    // whether a measurement exists.
    const measured = visibleChips(props({ osFingerprint: UNDETERMINED_OS }), 123);
    expect(measured.chips.map((c) => c.text)).toEqual(['UDP ✓', '? OS']);
    expect(measured.chips.find((c) => c.key === 'os')?.keep).toBe(true);
    expect(measured.hiddenHints).toHaveLength(1);
    expect(measured.hiddenHints[0]).toMatch(/^QUIC ~ — /);
    for (const [label, over, text] of [
      ['never measured — no fingerprint at all', {}, '— OS'],
      [
        'an `unavailable` cause the control plane reported',
        { osFingerprint: VPN_UNAVAILABLE_OS },
        '— OS',
      ],
      ['the in-flight `measuring` sentinel', { testing: true }, '… OS'],
    ] as const) {
      // It IS a chip at a real column width — C2, and the owner's "i dont see OS
      // currently at profile grid" is still answered for these rows…
      const wide = visibleChips(props({ ...over }), 206).chips.find((c) => c.key === 'os');
      expect(wide?.text, label).toBe(text);
      // …it simply is not PINNED, so it is the first thing a short row loses.
      expect(wide?.keep, label).toBeUndefined();
      const narrow = visibleChips(props({ ...over }), 123);
      expect(
        narrow.chips.map((c) => c.text),
        label,
      ).toEqual(['UDP ✓', 'QUIC ~']);
      expect(narrow.hiddenHints, label).toHaveLength(1);
      expect(narrow.hiddenHints[0], label).toMatch(new RegExp(`^${text} — `));
    }
  });

  it("capsMode 'first' puts its MEASURED chips ON the row — C1/C2 held in the mode that used to pass width 0", () => {
    // ProfilePhoneCard.tsx: `firstChips` used to be `visibleChips(p, 0).hiddenHints`
    // — width 0 means "hide everything", so EVERY eligible chip in mode 'first'
    // became a '+N' hint at every card width, the '✗ Windows' C3 calls the one
    // that matters most included. Reachable: `capabilities` is null for every VPN
    // row and for any row whose cached verdict does not match its scheme, while
    // the fingerprint / QUIC caches are not scheme-gated.
    // Mutation: restore `visibleChips(p, 0)` → red.
    const FIRST_MISMATCH = props({
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      probed: false,
      osFingerprint: WINDOWS_OS,
    });
    expect(capsMode(FIRST_MISMATCH)).toBe('first');
    atContentWidth(144, () => {
      const { container } = render(<ProfilePhoneCard {...FIRST_MISMATCH} />);
      const caps = byRegion(container, 'caps') as HTMLElement;
      expect(caps.getAttribute('data-caps-mode')).toBe('first');
      const os = byComponent(caps, 'proxy-os-fingerprint') as HTMLElement;
      expect(os).not.toBeNull();
      // 'Test' reserves 40 of the 144, leaving 100 — so the FULL label fits.
      expect(os.textContent).toBe('✗ Windows');
      expect(os.getAttribute('data-os-tone')).toBe('mismatch');
      expect(byComponent(caps, 'caps-overflow')).toBeNull();
      expect(caps.textContent).toBe('Test✗ Windows');
      cleanup();
    });
    // The control: a 'first' row with NOTHING measured shows the button and the
    // '— OS' chip that states the absence. It showed the button and a bare '+1'
    // until 2026-09-12 — see capabilityChips for the owner's reason.
    atContentWidth(144, () => {
      const { container } = render(
        <ProfilePhoneCard
          {...props({ capabilities: null, latencyMs: null, exitIp: null, probed: false })}
        />,
      );
      const caps = byRegion(container, 'caps') as HTMLElement;
      const os = caps.querySelector('[data-component="proxy-os-fingerprint"]');
      expect(os).not.toBeNull();
      expect(os?.textContent).toBe('— OS');
      expect(os?.getAttribute('data-os-tone')).toBe('unknown');
      expect(byComponent(caps, 'caps-overflow')).toBeNull();
      cleanup();
    });
    // ⛔ C4 (2026-09-12) — THE SECOND MECHANISM BEHIND THE OWNER'S '+1', and the
    // one that survived C1/C2/C3 untouched. capsMode 'first' is the ONLY mode
    // whose chips are not cut against the whole row: they get
    // `contentWidth − action − CHIP_GAP`, i.e. 90 of the 144px column. A VPN row
    // also carries one non-measurement hint ("UDP via tunnel"), and reserving
    // 27 + 4 = 31px of that 90 for its pill cost the OS chip its place at EVERY
    // column the grid can produce. Rendered on the real card off the running
    // harness before the fix, dark AND light, at 178 and 186: 'Check  QUIC ✓ +2',
    // the '+2' holding '— OS'. The exact input ships today — a stored VPN whose
    // endpoint resolved, launched once, so the hub's session poll wrote an h3
    // observation (recordLiveH3Observations → saveObservedQuic, no scheme gate;
    // deriveProbeViewWithEndpointRows surfaces it while `capabilities` stays
    // null, which is what makes the mode 'first').
    // The pill YIELDS now (visibleChips level 2b): it holds nothing that was
    // measured, so it is never worth a chip that was.
    const FIRST_VPN_QUIC = props({
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      quicMeasured: 'h3',
    });
    expect(capsMode(FIRST_VPN_QUIC)).toBe('first');
    // The arithmetic, all four numbers measured: 'QUIC ✓' 44.3 + gap 4 + '— OS'
    // 33.33 + the 3px floor = 84.63 of the 90 the compact 'Check' (50) leaves at
    // content 144. With the pill reserved it is 115.63, which is why the row
    // needs content 193 before the tunnel chip itself fits beside both. It never
    // comes back as a '+1': a dropped `dropFirst` chip does not mint a pill.
    for (const [contentWidth, label, texts, hints] of [
      // 144 = the 178px column, 152 = the 186px one: the grid's floor, both
      // themes, and the two widths this row was broken at.
      [144, 'Check', ['QUIC ✓', '— OS'], 0],
      [152, 'Check', ['QUIC ✓', '— OS'], 0],
      [169, 'Check', ['QUIC ✓', '— OS'], 0],
      // From 170 the whole row fits WITH the pill, so the tunnel hint is back on
      // the row beside both chips — never instead of one.
      [170, 'Check', ['QUIC ✓', '— OS'], 0],
      // From 193 the tunnel chip fits beside both, so all three are on the row.
      [193, 'Check', ['⇢ UDP', 'QUIC ✓', '— OS'], 0],
      // The full button label returns once the row fits beside it: 115.63 needs
      // content 194 next to a 74px button (a 228px card).
      [194, 'Check', ['⇢ UDP', 'QUIC ✓', '— OS'], 0],
      // The full button label returns at 210: the three-chip row (128.41) needs
      // content 210 beside a 74px button (a 244px card).
      [210, 'Check VPN', ['⇢ UDP', 'QUIC ✓', '— OS'], 0],
    ] as const) {
      const act = firstAction(FIRST_VPN_QUIC, contentWidth);
      expect(act.label, `content ${String(contentWidth)}`).toBe(label);
      const v = visibleChips(FIRST_VPN_QUIC, contentWidth - act.width - 4);
      expect(
        v.chips.map((c) => c.text),
        `content ${String(contentWidth)}`,
      ).toEqual(texts);
      expect(v.hiddenHints, `content ${String(contentWidth)}`).toHaveLength(hints);
    }
    // The same at the other reachable 'first' states: the fleet relay probe's
    // QUIC verdict, the negative one, and the measured OS DEFECT — a mismatch on
    // a 'first' row was behind the pill too (44.3 + 4 + '✗ Win' 36.97 + 3 =
    // 88.27 of 90).
    for (const [over, texts] of [
      [{ quicProbe: true }, ['QUIC ✓', '— OS']],
      [{ quicMeasured: 'h2-only' }, ['⤵ QUIC', '— OS']],
      [{ quicProbe: false }, ['⤵ QUIC', '— OS']],
      [{ quicMeasured: 'h3', osFingerprint: WINDOWS_OS }, ['QUIC ✓', '✗ Win']],
    ] as const) {
      const q = props({ vpn: true, capabilities: null, latencyMs: null, exitIp: null, ...over });
      expect(capsMode(q)).toBe('first');
      for (const contentWidth of [144, 152]) {
        const act = firstAction(q, contentWidth);
        const v = visibleChips(q, contentWidth - act.width - 4);
        expect(
          v.chips.map((c) => c.text),
          `${JSON.stringify(over)} @${String(contentWidth)}`,
        ).toEqual(texts);
        expect(v.hiddenHints).toHaveLength(0);
      }
    }
    // ⛔ VACUITY CONTROL — the pill still exists and still holds the tunnel hint
    // Vacuity guard: this row's chips are asserted by NAME, so "hiddenHints is
    // empty" cannot pass by the chips having silently stopped being produced.
    const FIRST_VPN_BARE = props({
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
    });
    const bare = visibleChips(FIRST_VPN_BARE, 144 - firstAction(FIRST_VPN_BARE, 144).width - 4);
    // Both facts a never-checked tunnel has, on the row, with no pill: the
    // tunnel-UDP chip and the OS row (2026-09-14).
    expect(bare.chips.map((c) => c.text)).toEqual(['⇢ UDP', '— OS']);
    expect(bare.chips[0]?.title).toMatch(/UDP travels inside the VPN\./);
    expect(bare.hiddenHints).toEqual([]);
  });

  it("C4 rendered — a VPN row that MEASURED QUIC shows its OS row at the 178px column, not a '+2'", () => {
    // The DOM, not the arithmetic: ProfilePhoneCard mode 'first' renders
    // `firstChips`, and this is the row the owner was looking at.
    // Mutations run 2026-09-12, each byte-exactly restored:
    //   • delete visibleChips level 2b → '+2' returns, no proxy-os-fingerprint → red;
    //   • rowWidth's `hiddenCount > 0` branch made unconditional → red.
    atContentWidth(144, () => {
      const { container } = render(
        <ProfilePhoneCard
          {...props({
            vpn: true,
            capabilities: null,
            latencyMs: null,
            exitIp: null,
            quicMeasured: 'h3',
          })}
        />,
      );
      const caps = byRegion(container, 'caps') as HTMLElement;
      expect(caps.getAttribute('data-caps-mode')).toBe('first');
      expect(byComponent(caps, 'caps-overflow')).toBeNull();
      const os = byComponent(caps, 'proxy-os-fingerprint') as HTMLElement;
      expect(os).not.toBeNull();
      expect(os.textContent).toBe('— OS');
      expect(os.getAttribute('title')).toMatch(
        /^OS not measured: the OS check is not available for VPN connections/,
      );
      expect(Array.from(caps.children).map((c) => c.textContent)).toEqual([
        'Check',
        'QUIC ✓',
        '— OS',
      ]);
      cleanup();
    });
  });

  it("visibleMeta — the '+N' reservation is DIGIT-AWARE: the meta row's N counts user tags and is not bounded by 9", () => {
    // ProfilePhoneCard.tsx `overflowPillWidth`. MEASURED 2026-09-12 in the live
    // harness with the meta tail's own class read out of the source: '+1'…'+9' are
    // 24.19–25.80 but '+10' is 30.02 — past the 27 a single constant reserved, in
    // a row that is `h-4 overflow-hidden`, which clips the trailing ⓘ. The caps
    // row can never reach 10 (eligible 3 + hidden 2); the meta row can, because
    // its N counts user TAGS (≤ 12 per packages/api-types/src/profiles.ts, plus
    // the folder = 13 pills). No gallery state shows it — the widest meta pill
    // there is '+5' — so the geometry gate cannot cover for this.
    // Mutation: make `overflowPillWidth` return 27 unconditionally → red (the
    // flat reserve fits a second 45px pill at 147 that the real pill does not).
    const tags = Array.from({ length: 12 }, (_, i) => `tag${String(i).padStart(3, '0')}`);
    expect(tags[0]).toHaveLength(6); // → metaPillWidth 45, so the arithmetic below holds
    const m = visibleMeta({ folder: '', tags }, 147, 1);
    expect(m.pills.map((x) => x.text)).toEqual(['tag000']);
    expect(m.hidden).toHaveLength(11);
    // The single-digit side is unchanged — 27 still covers '+4' (25.80).
    const few = visibleMeta({ folder: '', tags: tags.slice(0, 5) }, 147, 1);
    expect(few.pills).toHaveLength(2);
    expect(few.hidden).toHaveLength(3);
  });

  it('a measured UDP fall-back is muted, never red (C4): no [data-udp="false"] carries text-status-error', () => {
    // `capabilityChips` UDP className: restoring `bg-status-error/20 text-status-error`
    // for `!udpOk` reds this.
    const { container } = render(
      <ProfilePhoneCard
        {...props({ capabilities: { ...props().capabilities!, udp_associate: false } })}
      />,
    );
    const udp = container.querySelector('[data-udp="false"]') as HTMLElement;
    expect(udp).not.toBeNull();
    expect(udp.textContent).toBe('⤵ UDP');
    expect(classes(udp)).not.toContain('text-status-error');
    // Polish — one fill + one ink for every non-green chip (the comp's
    // translucent slate + ink2; the near-black inset is gone), and the
    // inferred 'QUIC ~' beside it wears exactly the same pair — a guess must
    // not read brighter than a measured negative.
    expect(classes(udp)).toEqual(expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']));
    expect(classes(udp)).not.toContain('bg-surface-inset');
    // (No UDP relay → the QUIC chip is the measured negative '⤵ QUIC' here;
    // the inferred '~' chip is pinned to the same pair in the QUIC arm below.)
    const quic = container.querySelector('[data-quic-inferred]') as HTMLElement;
    expect(quic.textContent).toBe('⤵ QUIC');
    expect(classes(quic).filter((c) => /^(bg|text)-/.test(c))).toEqual(
      classes(udp).filter((c) => /^(bg|text)-/.test(c)),
    );
    // And the healthy pill beside it stays green — no red anywhere on a working proxy.
    expect(container.querySelector('.text-status-error')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('*')).some((el) =>
        classes(el).includes('text-status-error-text'),
      ),
    ).toBe(false);
    cleanup();
  });

  it('a VPN row renders its tunnel-UDP chip with the sentence as its title, never the SOCKS5 verdict glyphs; a measured relay verdict is its QUIC chip', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({ vpn: true, capabilities: null, latencyMs: 61, quicProbe: true })}
      />,
    );
    const tunnelUdp = container.querySelector('[data-udp="tunnel"]');
    expect(tunnelUdp, 'the tunnel-UDP fact is a chip, not a pill').not.toBeNull();
    expect(tunnelUdp?.textContent).toBe('⇢ UDP');
    // …and never the two SOCKS5 verdicts, which would claim a probe that never ran.
    expect(container.querySelector('[data-udp="true"], [data-udp="false"]')).toBeNull();
    const caps = byRegion(container, 'caps') as HTMLElement;
    const quic = caps.querySelector('[data-quic-inferred]') as HTMLElement;
    expect(quic.textContent).toBe('QUIC ✓');
    expect(quic.getAttribute('data-quic-inferred')).toBe('false');
    // Nothing is behind a pill on this row any more.
    expect(byComponent(caps, 'caps-overflow')).toBeNull();
    expect(tunnelUdp?.getAttribute('title')).toMatch(/UDP travels inside the VPN\./);
    cleanup();
    // No relay measurement → no QUIC chip either (eligibility = a measurement).
    const { container: none } = render(
      <ProfilePhoneCard {...props({ vpn: true, capabilities: null, latencyMs: 61 })} />,
    );
    expect(none.querySelector('[data-quic-inferred]')).toBeNull();
    cleanup();
  });

  it('an unmeasured OS renders a "— OS" chip that says so on hover, never an opaque "+N"', () => {
    // `capabilityChips` OS eligibility. ⛔ This arm asserted the opposite until
    // 2026-09-12: an unmeasured OS was hidden and its hint rode the pill, which
    // is exactly the "+1" the owner could not read — and, on a proxy the control
    // plane returns no fingerprint for, the only thing they ever saw.
    // Mutation: restore the `else { hidden.push(...) }` branch → red here.
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const caps = byRegion(container, 'caps') as HTMLElement;
    const absent = byComponent(caps, 'proxy-os-fingerprint');
    expect(absent).not.toBeNull();
    expect(absent?.textContent).toBe('— OS');
    expect(absent?.getAttribute('title')).toMatch(/^OS not measured/);
    expect(byComponent(caps, 'caps-overflow')).toBeNull();
    cleanup();
    const { container: real } = render(<ProfilePhoneCard {...props({ osFingerprint: REAL_OS })} />);
    const chip = byComponent(
      byRegion(real, 'caps') as HTMLElement,
      'proxy-os-fingerprint',
    ) as HTMLElement;
    expect(chip.getAttribute('data-os-tone')).toBe('match');
    cleanup();
  });

  it('the QUIC chip keeps [data-quic-inferred]: "~" inferred (muted), "✓" measured (green), "⤵" measured negative (muted, never red)', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const inferred = container.querySelector('[data-quic-inferred="true"]') as HTMLElement;
    expect(inferred.textContent).toBe('QUIC ~');
    expect(classes(inferred)).not.toContain('text-status-ready');
    // Polish — a guess wears the SAME fill + ink as a measured negative.
    expect(classes(inferred)).toEqual(
      expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']),
    );
    cleanup();
    const { container: h3 } = render(<ProfilePhoneCard {...props({ quicMeasured: 'h3' })} />);
    const green = h3.querySelector('[data-quic-inferred="false"]') as HTMLElement;
    expect(green.textContent).toBe('QUIC ✓');
    expect(classes(green)).toContain('text-status-ready');
    cleanup();
    const { container: h2 } = render(<ProfilePhoneCard {...props({ quicMeasured: 'h2-only' })} />);
    const neg = h2.querySelector('[data-quic-inferred="false"]') as HTMLElement;
    expect(neg.textContent).toBe('⤵ QUIC');
    expect(classes(neg)).not.toContain('text-status-error');
    cleanup();
  });
});

describe('B4 — row budgets: fixed heights, no aspect ratio, no scrolling body, regions in order, dock outside', () => {
  const BUDGET_CLASS: Readonly<Record<string, string>> = {
    identity: 'h-[38px]',
    status: 'h-5',
    exit: 'h-[18px]',
    via: 'h-4',
    caps: 'h-5',
    when: 'h-[14px]',
    meta: 'h-4',
  };
  const ORDER = ['identity', 'status', 'exit', 'via', 'caps', 'when', 'meta'];

  it('every [data-region] carries its h-* class, shrink-0 and overflow-hidden; the DOM order is identity, status, exit, via, caps, when, meta', () => {
    // Each region div in ProfilePhoneCard.tsx: dropping any of the three tokens
    // (or reordering two regions) reds this — and reds the Playwright budget.
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const regions = Array.from(container.querySelectorAll('[data-region]'));
    expect(regions.map((r) => r.getAttribute('data-region'))).toEqual(ORDER);
    for (const r of regions) {
      const name = r.getAttribute('data-region') as string;
      expect(classes(r), name).toEqual(
        expect.arrayContaining([BUDGET_CLASS[name], 'shrink-0', 'overflow-hidden', 'flex']),
      );
    }
    cleanup();
  });

  it('the screen is a fixed 220px with NO aspect-* class; the body is overflow-hidden and never overflow-y-auto', () => {
    // Screen div: `h-[220px]` back to `aspect-[9/18.5]` reds arm 1 (the Phase B
    // root cause). Body div: `overflow-y-auto` back reds arm 2.
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const screenEl = byComponent(container, 'phone-screen');
    expect(classes(screenEl).some((c) => /^aspect-/.test(c))).toBe(false);
    expect(classes(screenEl)).toEqual(
      expect.arrayContaining(['h-[220px]', 'overflow-hidden', 'flex-col']),
    );
    const body = byComponent(container, 'card-body');
    expect(classes(body)).toContain('overflow-hidden');
    expect(classes(body)).not.toContain('overflow-y-auto');
    expect(classes(body)).not.toContain('overflow-auto');
    cleanup();
  });

  it('the dock and the Launch button are outside the body; every region is inside it', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    const body = byComponent(container, 'card-body') as HTMLElement;
    const dock = byComponent(container, 'card-dock') as HTMLElement;
    expect(dock).not.toBeNull();
    expect(body.contains(dock)).toBe(false);
    expect(body.contains(screen.getByRole('button', { name: 'Launch' }))).toBe(false);
    for (const r of container.querySelectorAll('[data-region]'))
      expect(body.contains(r)).toBe(true);
    // The old phone furniture is gone: no island, no home indicator, no 44px avatar.
    expect(container.querySelector('.h-11.w-11')).toBeNull();
    expect(container.querySelector('.w-\\[42px\\]')).toBeNull();
    cleanup();
  });
});

describe('B5 — failure states: the repair row is two buttons and nothing else; the pill carries the words', () => {
  it('a failed SOCKS5 renders proxy-broken-banner INSIDE [data-region="caps"] with Retest + Change and no text besides the buttons', () => {
    // R5 mode B in ProfilePhoneCard.tsx: re-adding the label span inside the
    // banner (the Phase A shape) reds the no-text arm; moving the banner out of
    // the caps region reds the containment arm.
    const { container } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, latencyMs: null, capabilities: CANNOT_ROUTE, onEdit: vi.fn() })}
      />,
    );
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.getAttribute('data-caps-mode')).toBe('repair');
    const banner = byComponent(container, 'proxy-broken-banner') as HTMLElement;
    expect(caps.contains(banner)).toBe(true);
    expect(banner.querySelector('[data-action="retest-proxy"]')).not.toBeNull();
    expect(banner.querySelector('[data-action="change-proxy"]')).not.toBeNull();
    for (const node of Array.from(banner.childNodes)) {
      expect(node.nodeType).toBe(Node.ELEMENT_NODE);
      expect((node as Element).tagName).toBe('BUTTON');
    }
    expect(banner.getAttribute('data-vpn-failure')).toBe('false');
    // The verdict word is the pill's, exactly once on the card.
    expect(screen.getAllByText('Cannot route')).toHaveLength(1);
    expect(screen.getByText('Cannot route').getAttribute('data-component')).toBe('health-pill');
    for (const b of banner.querySelectorAll('button')) {
      expect(classes(b)).toEqual(expect.arrayContaining(['shrink-0', 'whitespace-nowrap']));
    }
    cleanup();
  });

  it('a VPN failure: the Retest button reads RECHECK_ACTION, "Checking…" while in flight; data-vpn-failure="true"', () => {
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnFailure: VPN_DOWN,
          onEdit: vi.fn(),
        })}
      />,
    );
    const banner = byComponent(container, 'proxy-broken-banner') as HTMLElement;
    expect(banner.getAttribute('data-vpn-failure')).toBe('true');
    expect(screen.getByRole('button', { name: RECHECK_ACTION })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnFailure: VPN_DOWN,
          onEdit: vi.fn(),
          testing: true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: 'Checking…' })).toBeDisabled();
    cleanup();
  });

  it('(o) an UNRESOLVED endpoint is a repair row (Re-check + Change, data-vpn-failure="false"), never the first-measurement "Check VPN"; the exit line says why with no "run Check VPN" promise', () => {
    // capsMode's `endpointUnresolved(p)` clause: deleting it drops the row to
    // mode C — a 'Check VPN' button under a red 'address unknown' pill → reds. The
    // exit derivation's unresolved branch: deleting it restores the
    // VPN_NO_EXIT_YET_TITLE ("Run Check VPN to bring the tunnel up") → reds.
    const unresolved = {
      vpn: true,
      capabilities: null,
      latencyMs: null,
      exitIp: null,
      countryCode: null,
      flag: '🌍',
      endpoint: { resolved: false, message: 'DNS lookup failed' },
      onEdit: vi.fn(),
    };
    expect(capsMode(props(unresolved))).toBe('repair');
    const { container } = render(<ProfilePhoneCard {...props(unresolved)} />);
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.getAttribute('data-caps-mode')).toBe('repair');
    const banner = byComponent(container, 'proxy-broken-banner') as HTMLElement;
    expect(caps.contains(banner)).toBe(true);
    expect(banner.getAttribute('data-vpn-failure')).toBe('false');
    expect(screen.getByRole('button', { name: RECHECK_ACTION })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Change' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: CHECK_VPN_ACTION })).toBeNull();
    expect(container.textContent).not.toContain('🌍');
    const exitText = screen.getByText(VPN_NO_EXIT_YET_SHORT);
    expect(exitText.getAttribute('title')).toBe(ENDPOINT_UNRESOLVED_EXIT_TITLE);
    expect(exitText.getAttribute('title')).not.toBe(VPN_NO_EXIT_YET_TITLE);
    expect(container.querySelector('[title*="bring the tunnel up on the test Mac"]')).toBeNull();
    cleanup();
    // An HTTP row with the same pre-flight: 'no exit IP' with the same title, and Re-check (a pre-flight re-runs).
    render(<ProfilePhoneCard {...props({ ...unresolved, vpn: false, onEdit: undefined })} />);
    expect(screen.getByText('no exit IP').getAttribute('title')).toBe(
      ENDPOINT_UNRESOLVED_EXIT_TITLE,
    );
    expect(screen.getByRole('button', { name: RECHECK_ACTION })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Retest' })).toBeNull();
    cleanup();
    // VACUITY CONTROL — a resolved pre-flight on a VPN row with nothing measured is still mode C.
    expect(
      capsMode(props({ ...unresolved, endpoint: { resolved: true, message: 'Resolved' } })),
    ).toBe('first');
  });
});

describe('B6 — the exit line', () => {
  it('no "🌍" anywhere when exitIp and countryCode are null (G12): a 13px dashed placeholder ring and the SHORT clause instead', () => {
    // R3: rendering `p.flag` unconditionally (the v3 shape) reds this — the
    // parent passes '🌍' for "no exit" and the glyph asserted one. Polish: the
    // placeholder is the comp's dashed ring of the flag's width (the ◌ glyph
    // rendered as a 6px speck).
    const { container } = render(
      <ProfilePhoneCard
        {...props({ flag: '🌍', exitIp: null, countryCode: null, probed: true })}
      />,
    );
    expect(container.textContent).not.toContain('🌍');
    const exit = byRegion(container, 'exit') as HTMLElement;
    expect(exit.textContent).not.toContain('◌');
    const ring = byComponent(exit, 'exit-placeholder') as HTMLElement;
    expect(ring).not.toBeNull();
    expect(classes(ring)).toEqual(
      expect.arrayContaining(['h-[13px]', 'w-[13px]', 'rounded-full', 'border-dashed', 'shrink-0']),
    );
    expect(screen.getByText('no exit IP').getAttribute('title')).toBe(
      'No exit was measured by the last test — run Test proxy again',
    );
    cleanup();
    // A known exit renders the flag and no placeholder.
    const { container: known } = render(<ProfilePhoneCard {...props()} />);
    expect(byComponent(byRegion(known, 'exit') as HTMLElement, 'exit-placeholder')).toBeNull();
    cleanup();
  });

  it('the exit text carries `place · ip` as its title and reads the place; the flag renders when an exit is known', () => {
    const { container } = render(
      <ProfilePhoneCard {...props({ locationLabel: 'Amsterdam, North Holland' })} />,
    );
    const text = screen.getByText('Amsterdam, North Holland');
    expect(text.getAttribute('title')).toBe('Amsterdam, North Holland · 82.14.220.9');
    expect(classes(text)).toEqual(expect.arrayContaining(['truncate', 'min-w-0', 'flex-1']));
    expect((byRegion(container, 'exit') as HTMLElement).textContent).toContain('🇳🇱');
    expect(container.querySelector('[data-region="exit"] .mono')).toBeNull();
    cleanup();
  });

  it('a VPN with no exit reads VPN_NO_EXIT_YET_SHORT with VPN_NO_EXIT_YET_TITLE; a failed exit probe reads EXIT_GEO_UNAVAILABLE_SHORT with its title; the long forms are byte-identical to today', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          countryCode: null,
        })}
      />,
    );
    const vpnText = screen.getByText(VPN_NO_EXIT_YET_SHORT);
    expect(vpnText.getAttribute('title')).toBe(VPN_NO_EXIT_YET_TITLE);
    expect(classes(vpnText)).toContain('italic');
    expect(container.textContent).not.toContain('no exit IP');
    cleanup();
    render(
      <ProfilePhoneCard {...props({ exitIp: null, countryCode: null, exitProbeFailed: true })} />,
    );
    expect(screen.getByText(EXIT_GEO_UNAVAILABLE_SHORT).getAttribute('title')).toBe(
      EXIT_GEO_UNAVAILABLE_TITLE,
    );
    cleanup();
    // G8 — the copy pins: the grid's full sentences derive from the SHORT halves.
    expect(VPN_NO_EXIT_YET).toBe('no exit measured yet — run Check VPN');
    expect(VPN_NO_EXIT_YET).toBe(`${VPN_NO_EXIT_YET_SHORT} — run ${CHECK_VPN_ACTION}`);
    expect(EXIT_GEO_UNAVAILABLE).toBe('exit location unknown — the check did not complete');
    expect(EXIT_GEO_UNAVAILABLE).toBe(`${EXIT_GEO_UNAVAILABLE_SHORT} — the check did not complete`);
    expect(EXIT_GEO_UNAVAILABLE_TITLE).toBe(
      'The proxy accepted the connection and login, but no traffic made it through. Try the test again.',
    );
    // The grid renders the full sentence from the SAME constants (it imports
    // them from lib/proxy-check-copy — the grid follow-up landed): pin the use,
    // never a retyped literal.
    expect(source('views/ProxiesView.tsx')).toMatch(/\{EXIT_GEO_UNAVAILABLE\}/);
    expect(source('views/ProxiesView.tsx')).toMatch(/\bEXIT_GEO_UNAVAILABLE_TITLE\b/);
  });
});

describe('B7 — mode C, the first measurement is one click on the card (list parity)', () => {
  it('an untested SOCKS5 renders a "Test" button (data-action=retest-proxy) that calls onTest and does not select', () => {
    // R5 mode C: dropping the button (Phase A had no inline Test on untested
    // rows) reds this; dropping its stopPropagation reds the select arm.
    const onTest = vi.fn();
    const onToggleSelect = vi.fn();
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          probed: false,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          onTest,
          onToggleSelect,
        })}
      />,
    );
    expect(capsMode(props({ probed: false, capabilities: null, latencyMs: null }))).toBe('first');
    const btn = screen.getByRole('button', { name: 'Test' });
    expect(btn.getAttribute('data-action')).toBe('retest-proxy');
    expect((byRegion(container, 'caps') as HTMLElement).contains(btn)).toBe(true);
    expect(btn.getAttribute('title')).toBe(
      'Test proxy from this Mac — connection, response time, exit IP',
    );
    // No UDP/QUIC chip before a measurement, and the OS row states its absence
    // on the row itself rather than inside a '+1' (2026-09-12).
    expect(container.querySelector('[data-udp], [data-quic-inferred]')).toBeNull();
    expect(byComponent(container, 'proxy-os-fingerprint')?.textContent).toBe('— OS');
    expect(byComponent(container, 'proxy-os-fingerprint')?.getAttribute('title')).toMatch(
      /^OS not measured/,
    );
    expect(byComponent(container, 'caps-overflow')).toBeNull();
    fireEvent.click(btn);
    expect(onTest).toHaveBeenCalledTimes(1);
    expect(onToggleSelect).not.toHaveBeenCalled();
    cleanup();
  });

  it('a VPN with no verdict renders CHECK_VPN_ACTION; while testing the button keeps its word, disabled (the pill says Checking…)', () => {
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          probed: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnNotice: VPN_NOTICE,
        })}
      />,
    );
    const btn = screen.getByRole('button', { name: CHECK_VPN_ACTION });
    expect(btn.getAttribute('title')).toBe(CHECK_VPN_TITLE);
    expect((byRegion(container, 'caps') as HTMLElement).contains(btn)).toBe(true);
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          probed: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnNotice: VPN_NOTICE,
          testing: true,
        })}
      />,
    );
    expect(screen.getByRole('button', { name: CHECK_VPN_ACTION })).toBeDisabled();
    expect(pill(container).textContent).toBe('Checking…');
    // The list's '…' while testing is NOT used here: the caps row is the word,
    // then the '— OS' chip, then the '+1' that still holds the ONE fact that is
    // not a measurement at all (a tunnel cannot be UDP-probed).
    const caps = byRegion(container, 'caps') as HTMLElement;
    // Three facts on the row and nothing behind a pill (2026-09-14).
    expect(caps.textContent).toMatch(/^Check VPN⇢ UDP— OS$/);
    expect(byComponent(caps, 'proxy-os-fingerprint')?.getAttribute('title')).toMatch(
      /VPN connections/,
    );
    expect(byComponent(caps, 'caps-overflow')).toBeNull();
    expect(caps.querySelector('[data-udp="tunnel"]')?.getAttribute('title')).toMatch(
      /UDP travels inside the VPN\./,
    );
    cleanup();
  });

  it('no proxy renders neither button, EMPTY via + caps rows that keep their height (polish: two stacked "—" read as broken data), and the menu has no Test row', () => {
    const { container } = render(<ProfilePhoneCard {...props({ hasProxy: false })} />);
    expect(container.querySelector('[data-action="retest-proxy"]')).toBeNull();
    const caps = byRegion(container, 'caps') as HTMLElement;
    expect(caps.textContent).toBe('');
    expect(classes(caps)).toContain('h-5');
    const via = byRegion(container, 'via') as HTMLElement;
    expect(via.textContent).toBe('');
    expect(classes(via)).toContain('h-4');
    expect(screen.queryByLabelText(/Test proxy from this Mac/)).toBeNull();
    expect(screen.queryByLabelText(CHECK_VPN_TITLE)).toBeNull();
    cleanup();
  });
});

describe('B8 — every truncating text is titled', () => {
  it('name, device, exit text, proxy label, VPN failure, VPN notice, meta pills and the note glyph all carry a non-empty title', () => {
    const name = 'amsterdam shopper with a long descriptive profile name';
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          name,
          proxyName: 'Oxylabs residential NL rotating #3',
          proxyAddress: '10.0.0.5:1080',
          locationLabel: 'Amsterdam, North Holland, Netherlands',
          folder: 'Shopping / Netherlands',
          tags: ['retail', 'a-very-long-tag-name-x'],
          note: 'Warm before 09:00 CET',
          onSaveNote: vi.fn(),
        })}
      />,
    );
    expect(screen.getByText(name).getAttribute('title')).toBe(name);
    expect(screen.getByText('iPhone 17').getAttribute('title')).toBe('iPhone 17');
    expect(screen.getByText('Amsterdam, North Holland, Netherlands').getAttribute('title')).toBe(
      'Amsterdam, North Holland, Netherlands · 82.14.220.9',
    );
    // N8/C7 — the via row's title is `name — host:port`.
    const via = byComponent(container, 'profile-card-proxy-name') as HTMLElement;
    expect(byRegion(container, 'via')).toBe(via);
    expect(screen.getByText('Oxylabs residential NL rotating #3').getAttribute('title')).toBe(
      'Oxylabs residential NL rotating #3 — 10.0.0.5:1080',
    );
    expect(screen.getByText('📁 Shopping / Netherlands').getAttribute('title')).toBe(
      'Shopping / Netherlands',
    );
    const note = byComponent(container, 'profile-note') as HTMLElement;
    expect(note.getAttribute('title')).toBe('Warm before 09:00 CET — Click to edit note');
    for (const el of container.querySelectorAll('.truncate')) {
      expect(el.closest('[title]'), `untitled truncate: ${el.textContent ?? ''}`).not.toBeNull();
    }
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnFailure: VPN_DOWN,
        })}
      />,
    );
    // The override line's title opens with the full sentence and carries the
    // last-used / checked facts it displaced (polish: the never-launched fact
    // is its title sentence, and the LINE shows the cause, not the preamble).
    expect(byComponent(container, 'proxy-vpn-failure')?.getAttribute('title')).toBe(
      `${VPN_DOWN} · This profile has never been launched`,
    );
    expect(byComponent(container, 'proxy-vpn-failure')?.textContent).toBe(
      'handshake timed out after 20 s.',
    );
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnNotice: VPN_NOTICE,
          checkedAtIso: '2026-06-15T06:30:00.000Z',
        })}
      />,
    );
    const notice = byComponent(container, 'proxy-vpn-notice') as HTMLElement;
    expect(
      notice
        .getAttribute('title')
        ?.startsWith(`${VPN_NOTICE} · This profile has never been launched · Checked: `),
    ).toBe(true);
    expect(notice.getAttribute('data-checked-at')).toBe('2026-06-15T06:30:00.000Z');
    expect(byComponent(container, 'proxy-checked-at')).toBeNull();
    cleanup();
  });

  it('the via row falls back to host:port (mono) when the proxy has no label, and the 🗒 glyph opens the note editor', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          proxyName: null,
          proxyAddress: '10.0.0.5:1080',
          note: 'vip',
          onSaveNote: vi.fn(),
        })}
      />,
    );
    const addr = screen.getByText('10.0.0.5:1080');
    expect(classes(addr)).toContain('mono');
    expect(byComponent(container, 'profile-card-proxy-name')).not.toBeNull();
    fireEvent.click(byComponent(container, 'profile-note') as HTMLElement);
    expect(screen.getByLabelText('Note for amsterdam shopper')).toBeTruthy();
    cleanup();
  });
});

describe('B9 — dock + menu', () => {
  it('launching → the button is named "Launching…" with aria-busy; the Launch button truncates with nowrap', () => {
    render(<ProfilePhoneCard {...props({ busy: true, launching: true })} />);
    const btn = screen.getByRole('button', { name: 'Launching…' });
    expect(btn).toHaveAttribute('aria-busy', 'true');
    expect(classes(btn)).toEqual(
      expect.arrayContaining(['min-w-0', 'truncate', 'whitespace-nowrap', 'flex-1']),
    );
    cleanup();
  });

  it('the menu has no row captioned "Watch" or "View live" (D8) and no w-44; the other rows are unchanged', () => {
    // Menu in ProfilePhoneCard.tsx: re-adding the `p.onWatch` MenuRow reds the
    // first arm; `w-44` back reds the second.
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          running: true,
          onStop: vi.fn(),
          onAssist: vi.fn(),
          onEdit: vi.fn(),
          onSaveNote: vi.fn(),
          onClone: vi.fn(),
          onActivity: vi.fn(),
          onExport: vi.fn(),
          onTrim: vi.fn(),
          onDelete: vi.fn(),
        })}
      />,
    );
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    const captions = Array.from(menu.querySelectorAll('button')).map(
      (b) => b.textContent?.trim() ?? '',
    );
    expect(captions.some((c) => /Watch|View live/.test(c))).toBe(false);
    expect(screen.queryByLabelText(/Launch and watch live|Open the live view/)).toBeNull();
    expect(classes(menu)).not.toContain('w-44');
    expect(classes(menu).some((c) => /^w-(\d|\[)/.test(c) && c !== 'w-auto')).toBe(false);
    expect(classes(menu)).toEqual(
      expect.arrayContaining([
        // Phase C: a fixed box in the viewport (portaled) — never `absolute`
        // inside the card, where the grid's scroller could clip it.
        'fixed',
        'z-50',
        // Polish: 350 — the 13-row real-app maximum (344px) has no fold; at
        // 260 'Clear everything' and 'Delete' sat under an invisible scrollbar.
        'max-h-[350px]',
        'overflow-y-auto',
      ]),
    );
    expect(classes(menu)).not.toContain('absolute');
    const labels = Array.from(menu.querySelectorAll('button')).map((b) =>
      b.getAttribute('aria-label'),
    );
    // Polish (WCAG 2.5.3): a row's accessible name opens with its visible caption.
    // Phase C: the Details row is FIRST (the sheet is the card's depth).
    expect(labels).toEqual([
      'Details — every fact about amsterdam shopper, in full',
      'Ask the AI assistant about amsterdam shopper',
      "Stop session — end amsterdam shopper's running session",
      'Test proxy from this Mac — connection, response time, exit IP',
      'Edit amsterdam shopper',
      'Edit note for amsterdam shopper',
      'Duplicate amsterdam shopper',
      'Activity — recent pages opened with amsterdam shopper',
      'Export amsterdam shopper as a portable JSON copy',
      'Clearing options for amsterdam shopper',
      'Delete amsterdam shopper',
    ]);
    // Phase C: the menu is a PORTAL — no descendant of the article at all (it
    // used to be a sibling of the screen, which escaped the screen's clip but
    // not the grid's), a direct child of document.body.
    expect(byComponent(container, 'phone-screen')?.contains(menu)).toBe(false);
    expect(container.querySelector('article')?.contains(menu)).toBe(false);
    expect(menu.parentElement).toBe(document.body);
    cleanup();
  });

  it('the menu opens DOWNWARD when fewer than 360px (polish: was 320, the menu grew to 350) of room lie above the dock, UPWARD otherwise (data-placement)', () => {
    // `toggleMenu` in ProfilePhoneCard.tsx: dropping the `roomAbove(...) < MENU_FLIP_ROOM_PX`
    // computation pins one placement for both arms → one of them reds.
    // eslint-disable-next-line @typescript-eslint/unbound-method -- restored verbatim in `finally`
    const original = HTMLElement.prototype.getBoundingClientRect;
    const rectAt = (top: number): DOMRect => ({
      top,
      bottom: top + 47,
      left: 0,
      right: 178,
      width: 178,
      height: 47,
      x: 0,
      y: top,
      toJSON: () => ({}),
    });
    try {
      HTMLElement.prototype.getBoundingClientRect = () => rectAt(120);
      const { unmount } = render(<ProfilePhoneCard {...props()} />);
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const below = byComponent(document, 'card-actions-menu') as HTMLElement;
      expect(below.getAttribute('data-placement')).toBe('below');
      // Phase C (`menuBoxFor`): a FIXED box from the card's rect — 6px below
      // the card's bottom edge, inset 6px from both card edges (Phase A's
      // "anchored to both edges", now in viewport coordinates); no `bottom`.
      // Polish: those 6px are from the PADDING box; jsdom lays out no border
      // (clientLeft/offsetWidth 0), so here the padding box is the rect — the
      // 1px case is pinned in the sheet file's `menuBoxFor` arms.
      expect(below.style.top).toBe('173px'); // rect bottom 167 + 6
      expect(below.style.bottom).toBe('');
      expect(below.style.left).toBe('6px');
      expect(below.style.width).toBe('166px'); // 178 − 2 × 6
      expect(classes(below)).not.toContain('top-full');
      expect(classes(below)).not.toContain('bottom-[59px]');
      unmount();

      HTMLElement.prototype.getBoundingClientRect = () => rectAt(600);
      render(<ProfilePhoneCard {...props()} />);
      fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
      const above = byComponent(document, 'card-actions-menu') as HTMLElement;
      expect(above.getAttribute('data-placement')).toBe('above');
      // Above: the menu's bottom sits 6px above the dock's top (rect top 600).
      expect(above.style.bottom).toBe(`${String(window.innerHeight - (600 - 6))}px`);
      expect(above.style.top).toBe('');
      expect(classes(above)).not.toContain('bottom-[59px]');
      cleanup();
    } finally {
      HTMLElement.prototype.getBoundingClientRect = original;
    }
  });

  it('the "when" row: running + runningSinceIso → "running <elapsed>" titled "Running since …"; else last-used ⟷ "checked"', () => {
    const since = new Date(Date.now() - 12 * 60_000).toISOString();
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          running: true,
          runningSinceIso: since,
          checkedAtIso: '2026-06-15T06:30:00.000Z',
        })}
      />,
    );
    const when = byRegion(container, 'when') as HTMLElement;
    expect(when.textContent).toMatch(/^running 12m/);
    expect(when.querySelector('.truncate')?.getAttribute('title')).toMatch(/^Running since /);
    const checked = byComponent(when, 'proxy-checked-at') as HTMLElement;
    expect(checked.getAttribute('data-checked-at')).toBe('2026-06-15T06:30:00.000Z');
    expect(checked.textContent).toMatch(/^checked/);
    rerender(<ProfilePhoneCard {...props({ lastUsedIso: null })} />);
    expect(screen.getByText('never launched')).toBeTruthy();
    expect(byComponent(container, 'proxy-checked-at')).toBeNull();
    cleanup();
  });

  it('the meta row caps pills in JS: folder + "+N" at a narrow width, more at a wide one; the "+N" title names what was hidden', () => {
    // `visibleMeta`: dropping the `+ OVERFLOW_PILL_WIDTH` reservation lets a
    // pill that does not fit through and the count mismatch reds.
    const meta = {
      folder: 'Shopping / Netherlands',
      tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
    };
    const narrow = visibleMeta(meta, 144, 1);
    expect(narrow.pills.map((x) => x.kind)).toEqual(['folder']);
    expect(narrow.hidden).toEqual(['retail', 'nl', 'daily', 'warm', 'checkout']);
    const wide = visibleMeta(meta, 226, 0);
    expect(wide.pills.length).toBeGreaterThan(narrow.pills.length);
    expect(wide.pills.length + wide.hidden.length).toBe(6);
    const { container } = render(<ProfilePhoneCard {...props(meta)} />);
    const overflow = byComponent(
      byRegion(container, 'meta') as HTMLElement,
      'tags-overflow',
    ) as HTMLElement;
    expect(overflow).not.toBeNull();
    expect(overflow.textContent).toMatch(/^\+\d+$/);
    for (const hidden of overflow.getAttribute('title')?.split(' · ') ?? []) {
      expect(within(byRegion(container, 'meta') as HTMLElement).queryByText(hidden)).toBeNull();
    }
    cleanup();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Polish (2026-09-11) — the tile judged against the owner's comp and the app's
// tokens. Every arm names the class or word the render now carries; the
// Playwright quality gate (scratchpad/visual-quality.mjs) measures the contrast
// and the geometry these classes produce.
// ─────────────────────────────────────────────────────────────────────────────
describe('P1 — the when row: compact relative forms, the left fact has priority, one case', () => {
  const NOW = Date.parse('2026-09-11T12:00:00.000Z');
  it('formatRelativeNarrow (RelativeTime’s narrow style, once the card’s compactAgo): just now · N min ago · N h ago · yesterday · N d ago · N mo ago · N yr ago; a bad or future stamp degrades', () => {
    expect(formatRelativeNarrow('2026-09-11T11:59:30.000Z', NOW)).toBe('just now');
    expect(formatRelativeNarrow('2026-09-11T11:55:00.000Z', NOW)).toBe('5 min ago');
    expect(formatRelativeNarrow('2026-09-11T10:00:00.000Z', NOW)).toBe('2 h ago');
    expect(formatRelativeNarrow('2026-09-10T12:00:00.000Z', NOW)).toBe('yesterday');
    expect(formatRelativeNarrow('2026-09-09T12:00:00.000Z', NOW)).toBe('2 d ago');
    expect(formatRelativeNarrow('2026-06-15T06:30:00.000Z', NOW)).toBe('3 mo ago');
    expect(formatRelativeNarrow('2025-08-01T00:00:00.000Z', NOW)).toBe('1 yr ago');
    expect(formatRelativeNarrow('2026-09-11T12:05:00.000Z', NOW)).toBe('just now');
    expect(formatRelativeNarrow('not a date', NOW)).toBe('—');
    // Every form is short enough to share a 144px row with a compact stamp.
    for (const s of ['59 min ago', '23 h ago', '29 d ago', '11 mo ago', '12 yr ago'])
      expect(s.length).toBeLessThanOrEqual(10);
    // The checked stamp's terse form: no 'ago' (the verb dates it), no 'yesterday'.
    expect(terseAgo('2026-09-11T11:59:30.000Z', NOW)).toBe('<1 min');
    expect(terseAgo('2026-09-11T11:01:00.000Z', NOW)).toBe('59 min');
    expect(terseAgo('2026-09-11T10:00:00.000Z', NOW)).toBe('2 h');
    expect(terseAgo('2026-09-10T12:00:00.000Z', NOW)).toBe('1 d');
    expect(terseAgo('2026-06-15T06:30:00.000Z', NOW)).toBe('3 mo');
    expect(terseAgo('2025-08-01T00:00:00.000Z', NOW)).toBe('1 yr');
    expect(terseAgo('not a date', NOW)).toBe('—');
  });

  // (p) D3 — the card's row and RelativeTime's narrow style are ONE function.
  // Rendered for the same instant, the card's "when" row and
  // `<RelativeTime style="narrow">` print the same words. Mutation: give the
  // card back a local formatter that prints '5 mins ago' (or drop the narrow
  // branch in RelativeTime so it falls to Intl's '5 minutes ago') → red.
  it('the card’s "when" row prints exactly what <RelativeTime style="narrow"> prints for the same instant, and the terse checked form is the same words without "ago"', () => {
    const now = Date.now();
    const stamp = new Date(now - 5 * 60_000).toISOString();
    const { container } = render(
      <ProfilePhoneCard {...props({ lastUsedIso: stamp, checkedAtIso: stamp })} />,
    );
    const when = byRegion(container, 'when') as HTMLElement;
    const cardWords = (when.children[0] as HTMLElement).textContent;
    const reference = render(<RelativeTime iso={stamp} nowMs={now} style="narrow" />);
    const referenceWords = reference.container.querySelector('time')?.textContent;
    expect(cardWords).toBe('5 min ago');
    expect(cardWords).toBe(referenceWords);
    expect(cardWords).toBe(formatRelativeNarrow(stamp, now));
    // The default style is untouched — the list still reads Intl's long form.
    const long = render(<RelativeTime iso={stamp} nowMs={now} />);
    expect(long.container.querySelector('time')?.textContent).toBe('5 minutes ago');
    // The checked half's terse words are the narrow style's minus 'ago'.
    const checked = byComponent(when, 'proxy-checked-at') as HTMLElement;
    expect(checked.querySelector('time')?.textContent).toBe('5 min');
    expect(`${String(checked.querySelector('time')?.textContent)} ago`).toBe(referenceWords);
    cleanup();
  });

  it('renders "3 mo ago" (never "3 months ago") and a terse "checked 3 mo"; the left is shrink-0 max-w-[60%], the checked half is min-w-0 truncate tracking-tight in ONE case with the absolute stamp as its title; the row gap is 4px', () => {
    // The when row in ProfilePhoneCard.tsx: restoring <RelativeTime> on either
    // half reds the /months/ arm; restoring `shrink-0` on the checked half (or
    // `min-w-0` on the left) reds the priority arm; putting `uppercase` back on
    // the checked half (the comp's 'CHECKED 3 MO AGO' measured 108px against
    // the 100px the 178px column leaves beside '3 mo ago') reds the case arm.
    const stamp = new Date(Date.now() - 88 * 86_400_000).toISOString();
    const { container, rerender } = render(
      <ProfilePhoneCard {...props({ lastUsedIso: stamp, checkedAtIso: stamp })} />,
    );
    const when = byRegion(container, 'when') as HTMLElement;
    expect(when.textContent).toBe('3 mo agochecked 3 mo');
    expect(when.textContent).not.toMatch(/months/);
    expect(classes(when)).toContain('gap-1');
    const left = when.children[0] as HTMLElement;
    expect(classes(left)).toEqual(expect.arrayContaining(['truncate', 'max-w-[60%]', 'shrink-0']));
    expect(classes(left)).not.toContain('min-w-0');
    expect(left.getAttribute('title')).toMatch(/^Last used: /);
    expect(left.querySelector('time')?.getAttribute('dateTime')).toBe(stamp);
    const checked = byComponent(when, 'proxy-checked-at') as HTMLElement;
    expect(classes(checked)).toEqual(
      expect.arrayContaining(['min-w-0', 'truncate', 'text-[9px]', 'tracking-tight']),
    );
    expect(classes(checked)).not.toContain('shrink-0');
    expect(classes(checked)).not.toContain('uppercase');
    expect(checked.getAttribute('title')).toMatch(/^Checked: /);
    expect(checked.querySelector('time')?.getAttribute('dateTime')).toBe(stamp);
    // With no checked stamp the left fact takes the row (min-w-0, no 60% cap).
    rerender(<ProfilePhoneCard {...props({ lastUsedIso: stamp, checkedAtIso: null })} />);
    const alone = (byRegion(container, 'when') as HTMLElement).children[0] as HTMLElement;
    expect(classes(alone)).toContain('min-w-0');
    expect(classes(alone)).not.toContain('max-w-[60%]');
    // 'never launched' carries a title that adds to the word.
    rerender(<ProfilePhoneCard {...props({ lastUsedIso: null })} />);
    expect(screen.getByText('never launched').getAttribute('title')).toBe(
      'This profile has never been launched',
    );
    cleanup();
  });

  it('a VPN failure line shows the CAUSE after the fleet preamble; a notice line shows the NEXT STEP (≤ 30 chars for the two server notices), both keep the full sentence in the title, the notice stays muted (never busy amber)', () => {
    expect(
      vpnFailureClause(
        'The test Mac could not bring the tunnel up: handshake timed out after 20 s (no reply from 193.32.127.66:51820).',
      ),
    ).toBe('handshake timed out after 20 s (no reply from 193.32.127.66:51820).');
    expect(vpnFailureClause('The test Mac could not bring the tunnel up.')).toBe(
      'The test Mac could not bring the tunnel up.',
    );
    expect(vpnFailureClause('Tunnel refused by the server')).toBe('Tunnel refused by the server');
    // Today's server sentences (account-me.ts classifyVpnProbeFailure): the
    // generic first clause restates the pill, so the row shows what follows it…
    expect(
      vpnFailureClause(
        'The WireGuard connection could not be established. Check the keys and the server address, and make sure the server accepts this configuration.',
      ),
    ).toBe(
      'Check the keys and the server address, and make sure the server accepts this configuration.',
    );
    expect(
      vpnFailureClause(
        'Your OpenVPN connection started, but your traffic did not go through it, so we stopped it. This configuration is not safe to browse with.',
      ),
    ).toBe(
      'your traffic did not go through it, so we stopped it. This configuration is not safe to browse with.',
    );
    // …and a sentence whose first clause IS the cause shows whole.
    const didNotAnswer =
      'The OpenVPN server did not answer in time, so the connection did not start. The server may be down, blocked, or not accepting this configuration — we cannot tell which.';
    expect(vpnFailureClause(didNotAnswer)).toBe(didNotAnswer);
    expect(
      vpnFailureClause('The Mac that runs your profiles could not bring this tunnel up.'),
    ).toBe('The Mac that runs your profiles could not bring this tunnel up.');
    // ⛔ PIN UPDATED 2026-09-17 — "launch once" was a step nobody needs any more:
    // both the Proxies tab's check and the card's store the row themselves.
    expect(vpnNoticeClause(VPN_NOT_STORED_CHECK_NOTICE)).toBe('not saved — check again');
    expect(vpnNoticeClause(VPN_NO_API_KEY_CHECK_NOTICE)).toBe('needs an API key — Settings');
    expect(vpnNoticeClause(VPN_NOT_STORED_CHECK_NOTICE).length).toBeLessThanOrEqual(30);
    expect(vpnNoticeClause(VPN_NO_API_KEY_CHECK_NOTICE).length).toBeLessThanOrEqual(30);
    expect(vpnNoticeClause('Endpoint resolves. Something else.')).toBe('Something else.');
    expect(vpnNoticeClause('Address found. Something else.')).toBe('Something else.');
    expect(vpnNoticeClause(VPN_NOTICE)).toBe(VPN_NOTICE);
    const failure = 'The test Mac could not bring the tunnel up: handshake timed out after 20 s.';
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnFailure: failure,
        })}
      />,
    );
    const line = byComponent(container, 'proxy-vpn-failure') as HTMLElement;
    expect(line.textContent).toBe('handshake timed out after 20 s.');
    expect(line.textContent?.startsWith('The test Mac')).toBe(false);
    expect(line.getAttribute('title')?.startsWith(failure)).toBe(true);
    rerender(
      <ProfilePhoneCard
        {...props({
          vpn: true,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          vpnNotice: VPN_NOT_STORED_CHECK_NOTICE,
          endpoint: { resolved: true, message: 'Resolved' },
        })}
      />,
    );
    const notice = byComponent(container, 'proxy-vpn-notice') as HTMLElement;
    expect(notice.textContent).toBe('not saved — check again');
    expect(notice.getAttribute('title')?.startsWith(VPN_NOT_STORED_CHECK_NOTICE)).toBe(true);
    expect(classes(notice)).toContain('text-ink-muted');
    expect(classes(notice)).not.toContain('text-status-busy');
    // …and beside it the pill is the grid's 'address ok', not a contradiction.
    expect(pill(container).textContent).toBe('address ok');
    cleanup();
  });
});

describe("P2 — frame, screen, thumbnail, status, dock: the comp's chrome on the app's tokens", () => {
  // 2026-09-24 (owner item 1) — the hover lift moved from a black-and-white
  // literal utility into `.pf-card:hover` (index.css), on the mode tokens
  // `--pf-lift-hover`: in the light theme the literal laid a 45% near-black
  // shadow under a white tile. It still writes Tailwind's shadow SLOT, so the
  // selected ring composes over it.
  const HOVER_SHADOW_RULE = '.pf-card:hover {';
  const FOCUS_RING = [
    'focus-visible:outline-none',
    'focus-visible:ring-2',
    'focus-visible:ring-accent-hover',
    'focus-visible:ring-offset-2',
  ];

  it('the article: an ink/8% hairline over a 180° gradient on the mode tokens, a hover shadow that DEEPENS, a solid focus ring; running = a mint frame; selected = accent2 border + a 2px 35% RING (survives every shadow change)', () => {
    // Article className in ProfilePhoneCard.tsx: `hover:shadow-xl` back reds the
    // hover arm (it rewrote --tw-shadow and erased the selected box-shadow ring);
    // the selected ring back into `shadow-[0_0_0_1.5px…]` reds the ring arm.
    const { container, rerender } = render(<ProfilePhoneCard {...props()} />);
    const article = (): HTMLElement => container.querySelector('article') as HTMLElement;
    expect(classes(article())).toEqual(
      expect.arrayContaining([
        'border-ink-primary/[0.08]',
        'hover:-translate-y-0.5',
        ...FOCUS_RING,
        'focus-visible:ring-offset-surface-base',
      ]),
    );
    expect(classes(article())).not.toContain('hover:shadow-xl');
    expect(classes(article())).not.toContain('border-[#0a0d12]');
    expect(classes(article())).not.toContain('transition-all');
    // Round 2 — the slate gradient moved from an inline style into `.pf-card`
    // (index.css), where the card's state light lives beside it; the article
    // carries the class and no inline background. The gradient itself is
    // pinned from the stylesheet so the frame cannot quietly go flat.
    expect(article().getAttribute('style')).toBeNull();
    expect(classes(article())).toContain('pf-card');
    expect(article().getAttribute('data-card-light')).toBe('idle');
    const css = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');
    const pfCard = css.slice(css.indexOf('.pf-card {'), css.indexOf('.pf-card[data-card-light='));
    expect(pfCard).toContain('linear-gradient(');
    expect(pfCard).toContain('180deg');
    expect(pfCard).toContain('--tw-shadow:');
    expect(pfCard).not.toMatch(/^\s*box-shadow:/m);
    // The hover deepens the lift in the same slot (never box-shadow), and the
    // deeper lift is the mode's own token.
    const hover = css.slice(
      css.indexOf(HOVER_SHADOW_RULE),
      css.indexOf('}', css.indexOf(HOVER_SHADOW_RULE)),
    );
    expect(hover).toContain('--tw-shadow:');
    expect(hover).toContain('var(--pf-lift-hover)');
    expect(hover).not.toMatch(/^\s*box-shadow:/m);
    expect(classes(article()).some((c) => c.startsWith('hover:shadow-'))).toBe(false);
    rerender(<ProfilePhoneCard {...props({ running: true })} />);
    expect(classes(article())).toContain('border-status-ready/35');
    expect(article().getAttribute('data-card-light')).toBe('live');
    rerender(<ProfilePhoneCard {...props({ selected: true })} />);
    expect(classes(article())).toEqual(
      expect.arrayContaining(['border-accent-hover', 'ring-2', 'ring-accent-hover/35']),
    );
    expect(classes(article()).some((c) => c.startsWith('shadow-[0_0_0_1.5px'))).toBe(false);
    cleanup();
  });

  it('the screen carries ONE radial hue wash (no full-screen tint, no blurred disc, no inset vignette) plus the gloss; the select indicator is a hollow ink/35 ring at z-[15], BELOW the menu (z-20)', () => {
    const { container } = render(<ProfilePhoneCard {...props({ hue: 150 })} />);
    const screenEl = byComponent(container, 'phone-screen') as HTMLElement;
    const washes = screenEl.querySelectorAll('[data-component="screen-wash"]');
    expect(washes).toHaveLength(1);
    expect(washes[0]?.getAttribute('style')).toMatch(/radial-gradient\(120% 55% at 50% -10%/);
    expect(washes[0]?.getAttribute('style')).toContain('hsl(150 60% 55% / 0.28)');
    expect(screenEl.querySelector('.blur-2xl')).toBeNull();
    expect(screenEl.querySelector('.opacity-\\[0\\.16\\]')).toBeNull();
    expect(
      Array.from(screenEl.querySelectorAll('*')).some((el) =>
        classes(el).some((c) => c.startsWith('shadow-[inset_0_0_28px')),
      ),
    ).toBe(false);
    const indicator = byComponent(container, 'select-indicator') as HTMLElement;
    expect(classes(indicator)).toEqual(
      expect.arrayContaining(['z-[15]', 'border-ink-primary/35', 'bg-transparent']),
    );
    expect(classes(indicator)).not.toContain('bg-black/35');
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    const z = (el: HTMLElement): number =>
      Number(
        classes(el)
          .find((c) => /^z-/.test(c))
          ?.replace(/^z-\[?(\d+)\]?$/, '$1'),
      );
    expect(z(indicator)).toBeLessThan(z(menu));
    cleanup();
  });

  it('the thumbnail is TWO recipes keyed by hue — light gradient (L58→L52) + inverted ink on 4–175, dark gradient (L32→L24) + white on 176–3 — with the worst-case stop as its background-color; the device line and the Idle word are ink-secondary; the health pill is flush right; exactly ONE dot pulses on a live tile', () => {
    // `thumbUsesDarkInk` + the identity-thumb style in ProfilePhoneCard.tsx:
    // one gradient for every hue reds this (the orange and cyan troughs fail
    // 4.5 with BOTH inks — computed over the hue wheel at both stops).
    expect([4, 28, 60, 120, 150, 175].every(thumbUsesDarkInk)).toBe(true);
    expect([0, 3, 176, 190, 210, 260, 300, 341, 359].some(thumbUsesDarkInk)).toBe(false);
    expect(thumbUsesDarkInk(-300)).toBe(true);
    expect(thumbUsesDarkInk(570)).toBe(false);
    const { container, rerender } = render(<ProfilePhoneCard {...props({ hue: 150 })} />);
    const thumb = (): HTMLElement => byComponent(container, 'identity-thumb') as HTMLElement;
    // Contrast (2026-09-12): the dark ink is the slate-900 LITERAL, never the
    // inverted token (white in light mode).
    expect(classes(thumb())).toContain(THUMB_DARK_INK_CLASS);
    expect(classes(thumb())).not.toContain('text-ink-inverted');
    expect(thumb().getAttribute('data-ink')).toBe('dark');
    expect(thumb().getAttribute('style')).toContain('hsl(150 58% 58%)');
    expect(thumb().getAttribute('style')).toContain('hsl(184 52% 52%)');
    // jsdom serialises a colour as rgb(); compare through its own conversion.
    const rgb = (hsl: string): string => {
      const probe = document.createElement('div');
      probe.style.backgroundColor = hsl;
      return probe.style.backgroundColor;
    };
    expect(thumb().style.backgroundColor).toBe(rgb('hsl(184 52% 52%)'));
    rerender(<ProfilePhoneCard {...props({ hue: 210 })} />);
    expect(classes(thumb())).toContain('text-white');
    expect(thumb().getAttribute('data-ink')).toBe('white');
    expect(thumb().getAttribute('style')).toContain('hsl(210 58% 32%)');
    expect(thumb().getAttribute('style')).toContain('hsl(244 52% 24%)');
    expect(thumb().style.backgroundColor).toBe(rgb('hsl(210 58% 32%)'));
    rerender(<ProfilePhoneCard {...props({ hue: 175 })} />);
    expect(classes(thumb())).toContain(THUMB_DARK_INK_CLASS);
    rerender(<ProfilePhoneCard {...props({ hue: 176 })} />);
    expect(classes(thumb())).toContain('text-white');
    expect(classes(thumb())).not.toContain('text-ink-inverted');
    expect(classes(screen.getByText('iPhone 17'))).toContain('text-ink-secondary');
    expect(classes(screen.getByText('Idle'))).toContain('text-ink-secondary');
    expect(classes(pill(container))).toContain('ml-auto');
    expect(container.querySelectorAll('.animate-pulse')).toHaveLength(0);
    rerender(<ProfilePhoneCard {...props({ running: true })} />);
    const pulsing = container.querySelectorAll('.animate-pulse');
    expect(pulsing).toHaveLength(1);
    expect(pulsing[0]?.getAttribute('data-component')).toBe('thumb-live-dot');
    expect(classes(pulsing[0] as HTMLElement)).toEqual(
      expect.arrayContaining([
        'h-1.5',
        'w-1.5',
        'ring-2',
        'ring-surface-raised',
        '[animation-duration:1.6s]',
      ]),
    );
    cleanup();
  });

  it('C1 — the monogram reaches ≥ 4.5:1 on its hue background for EVERY hue 0..359 in BOTH modes: the ink is a literal, so the mode cannot flip it (text-ink-inverted measured 1.60 in light at hue 60); the explicit background-color is the stop that measures WORSE, so the gate reads the honest floor', () => {
    // Mutations reasoned:
    //  · THUMB_DARK_INK_CLASS = 'text-ink-inverted' (the polish's class) →
    //    inkOf resolves it through --ink-inverted-rgb, 255 255 255 in the
    //    light block → hue 60 measures 1.60 at both stops → red in light.
    //  · the JSX hardcoding a class instead of thumb.inkClass → the render
    //    pins above (THUMB_DARK_INK_CLASS present, inverted absent) red.
    //  · `floor: stops[1]` for the light recipe (the polish's assumption) →
    //    hue 4's floorRatio 6.63 ≠ min(4.66, 6.63) → the floor arm reds.
    let worst = { ratio: Number.POSITIVE_INFINITY, hue: -1, mode: 'light', stop: '' };
    let floorMismatches = 0;
    for (const mode of ['light', 'dark'] as const) {
      for (let hue = 0; hue < 360; hue += 1) {
        const r = thumbRecipe(hue);
        const ink = inkOf(r.inkClass, mode);
        // the class and the hex the recipe declares agree in THIS mode
        expect(ink).toEqual(hexRgb(r.inkHex));
        const ratios = r.stops.map((stop) => wcagContrast(ink, hslRgb(stop)));
        ratios.forEach((ratio, k) => {
          if (ratio < worst.ratio) worst = { ratio, hue, mode, stop: r.stops[k] ?? '' };
        });
        const floorRatio = wcagContrast(ink, hslRgb(r.floor));
        if (Math.abs(floorRatio - Math.min(...ratios)) > 1e-9) floorMismatches += 1;
        expect(r.floorRatio).toBeCloseTo(Math.min(...ratios), 9);
        expect(r.stops).toContain(r.floor);
      }
    }
    expect(floorMismatches).toBe(0);
    // worst over 360 hues × 2 modes × 2 stops: white on hsl(180 58% 32%) = 4.64
    expect(worst.ratio).toBeGreaterThanOrEqual(4.5);
    expect(worst).toMatchObject({ hue: 180, stop: 'hsl(180 58% 32%)' });
    expect(worst.ratio).toBeCloseTo(4.64, 1);
    // Positive control — the arm fails in the direction the real failure went:
    // the inverted token IS white in light mode, and white on the light
    // recipe's hue-60 stops measures 1.60 (< 4.5). In dark mode the same token
    // is slate-900, which is why the finding was light-only.
    // Tailwind's scanner needs the class VERBATIM in the source: a template
    // literal built from the hex (`text-[${HEX}]`) passes every jsdom pin and
    // renders no colour. The class must equal the hex it claims, and appear
    // as that exact string in ProfilePhoneCard.tsx.
    expect(THUMB_DARK_INK_CLASS).toBe(`text-[${THUMB_DARK_INK_HEX}]`);
    expect(source('components/ProfilePhoneCard.tsx')).toContain(`'${THUMB_DARK_INK_CLASS}'`);
    expect(inkOf('text-ink-inverted', 'light')).toEqual([255, 255, 255]);
    expect(inkOf('text-ink-inverted', 'dark')).toEqual(hexRgb(THUMB_DARK_INK_HEX));
    const white = inkOf('text-ink-inverted', 'light');
    const worstWhite = Math.min(
      ...thumbRecipe(60).stops.map((stop) => wcagContrast(white, hslRgb(stop))),
    );
    expect(worstWhite).toBeLessThan(4.5);
    expect(worstWhite).toBeCloseTo(1.6, 1);
    // The rendered thumb wears exactly the recipe (class, data-ink, both stops,
    // the floor) — for a hue whose floor is NOT the polish's darker stop (4:
    // 4.66 on the first stop vs 6.63 on the second).
    const { container } = render(<ProfilePhoneCard {...props({ hue: 4 })} />);
    const thumb = byComponent(container, 'identity-thumb') as HTMLElement;
    const recipe = thumbRecipe(4);
    expect(recipe.floor).toBe(recipe.stops[0]);
    expect(recipe.floor).toBe('hsl(4 58% 58%)');
    expect(classes(thumb)).toContain(recipe.inkClass);
    expect(thumb.getAttribute('data-ink')).toBe(recipe.ink);
    expect(thumb.getAttribute('style')).toContain(
      `linear-gradient(145deg, ${recipe.stops[0]}, ${recipe.stops[1]})`,
    );
    const probe = document.createElement('div');
    probe.style.backgroundColor = recipe.floor;
    expect(thumb.style.backgroundColor).toBe(probe.style.backgroundColor);
    cleanup();
  });
  it('the dock: an ink/6% hairline; Launch is a 30px 12px block titled with a sentence; live → solid ready, launching → the neutral busy button at FULL opacity (only launchDisabled dims); ⋯ is a borderless ink/6% fill; both wear the solid focus ring', () => {
    const { container, rerender } = render(<ProfilePhoneCard {...props()} />);
    const dock = byComponent(container, 'card-dock') as HTMLElement;
    expect(classes(dock)).toContain('border-ink-primary/[0.06]');
    expect(classes(dock)).not.toContain('border-surface-divider');
    const launch = (): HTMLElement =>
      screen.getByRole('button', { name: /^(Launch|Open session|Launching…)$/ });
    expect(classes(launch())).toEqual(
      expect.arrayContaining([
        'h-[30px]',
        'text-[12px]',
        'leading-[30px]',
        'bg-accent',
        'enabled:hover:bg-accent-fill-hover',
        'disabled:opacity-50',
        ...FOCUS_RING,
      ]),
    );
    expect(classes(launch())).not.toContain('py-1.5');
    expect(classes(launch())).not.toContain('hover:bg-accent-hover');
    // 2026-09-12 review — white on the lighter --accent-hover rose is 3.92:1; the
    // text-carrying fill hovers to the darker oxblood-550 (7.11) instead.
    expect(classes(launch())).not.toContain('enabled:hover:bg-accent-hover');
    expect(launch().getAttribute('title')).toBe('Launch a session with this profile');
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(classes(more)).toEqual(
      expect.arrayContaining(['bg-ink-primary/[0.06]', 'text-ink-primary', ...FOCUS_RING]),
    );
    expect(classes(more)).not.toContain('border');
    expect(classes(more)).not.toContain('border-surface-divider');
    rerender(<ProfilePhoneCard {...props({ running: true })} />);
    // Round 2 — the live button is SOLID ready with the surface colour as its
    // ink (the AI view's own status stamp), not a tint with ready-coloured
    // text: the tint measured 4.4:1 in the light theme once the card wore its
    // stage, and the mockup draws it solid anyway.
    expect(classes(launch())).toEqual(
      expect.arrayContaining(['bg-status-ready', 'text-surface-base']),
    );
    expect(classes(launch())).not.toContain('bg-status-ready/[0.18]');
    expect(classes(launch())).not.toContain('border');
    expect(launch().getAttribute('title')).toBe('Open the running session');
    rerender(<ProfilePhoneCard {...props({ busy: true, launching: true })} />);
    expect(classes(launch())).toEqual(
      expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary', 'cursor-progress']),
    );
    expect(classes(launch())).not.toContain('disabled:opacity-50');
    expect(classes(launch())).not.toContain('bg-accent');
    expect(launch().getAttribute('title')).toBe(
      'Launching — the proxy is checked before the session starts',
    );
    const spinner = byComponent(container, 'launch-spinner') as HTMLElement;
    expect(classes(spinner)).toEqual(
      expect.arrayContaining(['border-ink-muted/40', 'border-t-ink-secondary']),
    );
    expect(classes(spinner)).not.toContain('border-white/35');
    rerender(
      <ProfilePhoneCard
        {...props({ launchDisabled: true, launchDisabledReason: 'Sign in first' })}
      />,
    );
    expect(classes(launch())).toContain('disabled:opacity-50');
    expect(launch().getAttribute('title')).toBe('Sign in first');
    cleanup();
  });
});

describe('P3 — via, caps, meta rows: pills and chips in one family', () => {
  it('the VPN tag keeps the oxblood tint with the LIGHT rose ink and a title that says what VPN means (Check VPN stays on the button + menu row); via is tracking-wider; the address is 9.5px mono; the default badge is a lowercase hairline box', () => {
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({ vpn: true, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const tag = byComponent(container, 'proxy-vpn-tag') as HTMLElement;
    expect(tag.textContent).toBe('VPN');
    // Contrast (2026-09-12): the rose ink is the mode-aware accent-text TOKEN,
    // not the dark-only literal (#e8a0ab measured 1.66 on the light tint).
    expect(classes(tag)).toEqual(
      expect.arrayContaining([
        'bg-accent-subtle',
        'text-accent-text',
        'tracking-wide',
        'uppercase',
      ]),
    );
    expect(classes(tag)).not.toContain('text-accent');
    expect(classes(tag)).not.toContain('text-[#e8a0ab]');
    expect(classes(tag).some((c) => /^text-\[#/.test(c))).toBe(false);
    expect(tag.getAttribute('title')).toBe(
      'OpenVPN / WireGuard tunnel — the whole session, UDP included, travels inside it',
    );
    expect(tag.getAttribute('title')).not.toBe(CHECK_VPN_TITLE);
    expect(screen.getByRole('button', { name: CHECK_VPN_ACTION }).getAttribute('title')).toBe(
      CHECK_VPN_TITLE,
    );
    rerender(
      <ProfilePhoneCard
        {...props({ proxyName: null, proxyAddress: '10.0.0.5:1080', proxyExplicit: false })}
      />,
    );
    expect(classes(screen.getByText('via'))).toContain('tracking-wider');
    expect(classes(screen.getByText('10.0.0.5:1080'))).toEqual(
      expect.arrayContaining(['mono', 'text-[9.5px]']),
    );
    const badge = byComponent(container, 'proxy-inherited-badge') as HTMLElement;
    expect(badge.textContent).toBe('default');
    expect(classes(badge)).toEqual(
      expect.arrayContaining([
        'border',
        'border-surface-divider',
        'text-ink-secondary',
        'leading-[14px]',
      ]),
    );
    expect(classes(badge)).not.toContain('uppercase');
    expect(classes(badge)).not.toContain('bg-surface-divider/40');
    cleanup();
  });

  it("C2 — the accent-text token the VPN tag wears clears 4.5:1 on the tag's tint (accent at the mode alpha over the raised surface) in BOTH modes; the literal it replaced fails light and the bare accent fails dark", () => {
    // Mutations reasoned:
    //  · SOFT_ACCENT_INK back to 'text-[#e8a0ab]' → the class pin above reds,
    //    and inkOf('text-[#e8a0ab]', 'light') on the light wash = 1.66 (the
    //    control below is that exact measurement).
    //  · styles/index.css dark --accent-text-rgb set to the accent itself
    //    (168 59 77) → 2.01 on the dark wash → red. A tint that clears 4.5 on
    //    the raised surface but not on this LIGHTER wash reds here too — the
    //    tag's real background, not the token's design surface.
    const { container } = render(
      <ProfilePhoneCard
        {...props({ vpn: true, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const tag = byComponent(container, 'proxy-vpn-tag') as HTMLElement;
    const inkClass = classes(tag).find((c) => c.startsWith('text-accent')) ?? '';
    expect(inkClass).toBe('text-accent-text');
    const measured: Record<string, number> = {};
    for (const mode of ['light', 'dark'] as const) {
      const ratio = wcagContrast(inkOf(inkClass, mode), accentSubtleWash(mode));
      measured[mode] = ratio;
      expect(ratio).toBeGreaterThanOrEqual(4.5);
    }
    // Positive controls — both directions of the failure the token fixes.
    expect(wcagContrast(hexRgb('#e8a0ab'), accentSubtleWash('light'))).toBeLessThan(4.5); // 1.66
    expect(wcagContrast(modeRgb('accent', 'dark'), accentSubtleWash('dark'))).toBeLessThan(4.5); // 2.01
    // The tile's dark look: the token's dark value is a light rose tint, not the accent.
    expect(inkOf(inkClass, 'dark')).not.toEqual(modeRgb('accent', 'dark'));
    expect(measured['light']).toBeGreaterThan(0);
    cleanup();
  });
  it('chips are 9.5px/600 radius-6 with ONE muted family; the OS chip wears the same chrome (data-component + data-os-tone kept); the "+N" tails on the caps AND meta rows are dashed and transparent', () => {
    const { container } = render(
      <ProfilePhoneCard
        {...props({
          osFingerprint: REAL_OS,
          folder: 'Shopping / Netherlands',
          tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
        })}
      />,
    );
    const udp = container.querySelector('[data-udp="true"]') as HTMLElement;
    expect(classes(udp)).toEqual(
      expect.arrayContaining([
        'text-[9.5px]',
        'font-semibold',
        'rounded-md',
        // C1 (2026-09-12) — 4px a side, not 6. CHIP_WIDTH is measured FROM this
        // padding, so px-1.5 here leaves every entry 4px short of the render:
        // the exact way the table went stale and cut a chip mid-glyph before.
        'px-1',
        'bg-status-ready/10',
        'text-status-ready',
      ]),
    );
    expect(classes(udp)).not.toContain('px-1.5');
    expect(classes(udp)).not.toContain('text-[9px]');
    expect(classes(udp)).not.toContain('font-bold');
    const os = byComponent(
      byRegion(container, 'caps') as HTMLElement,
      'proxy-os-fingerprint',
    ) as HTMLElement;
    expect(os.getAttribute('data-os-tone')).toBe('match');
    expect(os.textContent).toBe('✓ iOS/macOS');
    expect(classes(os)).toEqual(
      expect.arrayContaining(['text-[9.5px]', 'font-semibold', 'rounded-md', 'text-status-ready']),
    );
    expect(classes(os)).not.toContain('rounded-sm');
    const tail = byComponent(container, 'tags-overflow') as HTMLElement;
    expect(classes(tail)).toEqual(
      expect.arrayContaining(['border-dashed', 'bg-transparent', 'text-ink-muted']),
    );
    expect(classes(screen.getByText('📁 Shopping / Netherlands'))).toEqual(
      expect.arrayContaining(['bg-ink-muted/15', 'text-ink-secondary']),
    );
    expect(classes(screen.getByText('📁 Shopping / Netherlands'))).not.toContain('border');
    expect(classes(screen.getByText('📁 Shopping / Netherlands'))).not.toContain(
      'bg-surface-inset',
    );
    // The meta row carries no row-level title; the sealed-store size lives in
    // the details sheet (Phase C — it was a static info row in the ⋯ menu),
    // never on the resting tile and never for '—' (a profile never saved).
    expect(byRegion(container, 'meta')?.getAttribute('title')).toBeNull();
    cleanup();
    const { container: sized } = render(<ProfilePhoneCard {...props({ sizeLabel: '128 MB' })} />);
    expect(byRegion(sized, 'meta')?.getAttribute('title')).toBeNull();
    expect(document.querySelector('[title*="Stored profile size"]')).toBeNull();
    expect((byComponent(sized, 'card-body') as HTMLElement).textContent).not.toContain('128 MB');
    expect(byComponent(document, 'card-actions-menu')?.textContent).not.toContain('128 MB');
    fireEvent.click(screen.getByLabelText('Details for amsterdam shopper'));
    const sizeRow = sized.querySelector('[title*="Stored profile size"]') as HTMLElement;
    expect(byComponent(sized, 'card-details-sheet')?.contains(sizeRow)).toBe(true);
    expect(sizeRow.getAttribute('data-component')).toBe('profile-size');
    cleanup();
    const { container: unsaved } = render(<ProfilePhoneCard {...props({ sizeLabel: '—' })} />);
    fireEvent.click(screen.getByLabelText('Details for amsterdam shopper'));
    expect(byComponent(unsaved, 'card-details-sheet')).not.toBeNull();
    expect(byComponent(unsaved, 'profile-size')).toBeNull();
    cleanup();
    cleanup();
    // The same clientWidth stub the B3 block uses, inlined — that helper is
    // scoped to its own describe.
    const proto = Element.prototype;
    const original = Object.getOwnPropertyDescriptor(proto, 'clientWidth');
    Object.defineProperty(proto, 'clientWidth', {
      configurable: true,
      get(this: Element) {
        return this.getAttribute('data-region') === 'status' ? 118 : 0;
      },
    });
    try {
      const { container: narrow } = render(
        <ProfilePhoneCard {...props({ osFingerprint: REAL_OS })} />,
      );
      const pillEl = byComponent(narrow, 'caps-overflow');
      expect(pillEl, 'a per-proxy chip cut for width still mints the pill').not.toBeNull();
      expect(classes(pillEl as HTMLElement)).toEqual(
        expect.arrayContaining(['border-dashed', 'bg-transparent', 'text-[9.5px]']),
      );
    } finally {
      if (original !== undefined) Object.defineProperty(proto, 'clientWidth', original);
      else Reflect.deleteProperty(proto, 'clientWidth');
      cleanup();
    }
  });

  it("the repair row: Re-test (the Proxies tab's word) is OUTLINED in the soft error ink, Change / Test are outlined divider buttons, all 10px/600 with transition-colors, enabled-guarded hovers and an inset focus ring; in flight the button is the neutral busy button at full opacity with aria-busy", () => {
    expect(RETEST_ACTION).toBe('Re-test');
    // (p) D1 — the grid renders the constant, not a literal of its own.
    expect(source('views/ProxiesView.tsx')).toContain('? RETEST_ACTION :');
    expect(source('views/ProxiesView.tsx')).not.toContain("'Re-test'");
    const { container, rerender } = render(
      <ProfilePhoneCard
        {...props({ exitIp: null, latencyMs: null, capabilities: CANNOT_ROUTE, onEdit: vi.fn() })}
      />,
    );
    const retest = screen.getByRole('button', { name: RETEST_ACTION });
    expect(screen.queryByRole('button', { name: 'Retest' })).toBeNull();
    expect(classes(retest)).toEqual(
      expect.arrayContaining([
        'border',
        'border-status-error/45',
        'bg-status-error/10',
        'text-status-error-text',
        'text-[10px]',
        'font-semibold',
        'transition-colors',
        'enabled:hover:bg-status-error/20',
        'focus-visible:ring-inset',
        'disabled:opacity-50',
      ]),
    );
    expect(classes(retest)).not.toContain('text-status-error');
    expect(classes(retest)).not.toContain('text-[9.5px]');
    expect(retest.getAttribute('aria-busy')).toBe('false');
    const change = screen.getByRole('button', { name: 'Change' });
    expect(classes(change)).toEqual(
      expect.arrayContaining([
        'border',
        'border-surface-divider',
        'text-[10px]',
        'transition-colors',
        'enabled:hover:bg-surface-divider',
        'focus-visible:ring-inset',
      ]),
    );
    expect(classes(change)).not.toContain('hover:bg-surface-divider');
    rerender(
      <ProfilePhoneCard
        {...props({
          exitIp: null,
          latencyMs: null,
          capabilities: CANNOT_ROUTE,
          onEdit: vi.fn(),
          testing: true,
        })}
      />,
    );
    const busy = screen.getByRole('button', { name: 'Testing…' });
    expect(busy).toBeDisabled();
    expect(busy.getAttribute('aria-busy')).toBe('true');
    expect(classes(busy)).toEqual(
      expect.arrayContaining(['cursor-progress', 'bg-surface-elevated', 'text-ink-secondary']),
    );
    expect(classes(busy)).not.toContain('disabled:opacity-50');
    rerender(
      <ProfilePhoneCard
        {...props({ probed: false, capabilities: null, latencyMs: null, exitIp: null })}
      />,
    );
    const test = screen.getByRole('button', { name: 'Test' });
    expect(classes(test)).toEqual(
      expect.arrayContaining([
        'border',
        'border-surface-divider',
        'text-[10px]',
        'font-semibold',
        'transition-colors',
        'enabled:hover:bg-surface-divider',
        'focus-visible:ring-inset',
        'disabled:opacity-50',
      ]),
    );
    rerender(
      <ProfilePhoneCard
        {...props({
          probed: false,
          capabilities: null,
          latencyMs: null,
          exitIp: null,
          testing: true,
        })}
      />,
    );
    const testBusy = screen.getByRole('button', { name: 'Test' });
    expect(testBusy).toBeDisabled();
    expect(testBusy.getAttribute('aria-busy')).toBe('true');
    expect(classes(testBusy)).toContain('cursor-progress');
    expect(classes(testBusy)).not.toContain('disabled:opacity-50');
    // The note glyph is a 16px box with the inset ring.
    rerender(<ProfilePhoneCard {...props({ note: 'vip', onSaveNote: vi.fn() })} />);
    expect(classes(byComponent(container, 'profile-note') as HTMLElement)).toEqual(
      expect.arrayContaining([
        'grid',
        'h-4',
        'w-4',
        'focus-visible:ring-inset',
        'transition-colors',
      ]),
    );
    cleanup();
  });

  it('vertical rhythm: body pt-1.5 pb-1, gaps 5/4/2/4/4/2 (identity · status · exit · via · caps · when) — 10 + 142 + 21 = 173', () => {
    const { container } = render(<ProfilePhoneCard {...props()} />);
    expect(classes(byComponent(container, 'card-body'))).toEqual(
      expect.arrayContaining(['pt-1.5', 'pb-1']),
    );
    expect(classes(byComponent(container, 'card-body'))).not.toContain('pb-1.5');
    const gap = (name: string): string | undefined =>
      classes(byRegion(container, name)).find((c) => /^mb-/.test(c));
    expect([
      gap('identity'),
      gap('status'),
      gap('exit'),
      gap('via'),
      gap('caps'),
      gap('when'),
      gap('meta'),
    ]).toEqual(['mb-[5px]', 'mb-1', 'mb-[2px]', 'mb-1', 'mb-1', 'mb-[2px]', undefined]);
    cleanup();
  });
});

describe('P4 — the ⋯ group: labelled, arrow keys, focus restored to ⋯, Launch closes it', () => {
  const full = (): Partial<ProfilePhoneCardProps> => ({
    onEdit: vi.fn(),
    onClone: vi.fn(),
    onActivity: vi.fn(),
    onTrim: vi.fn(),
    onDelete: vi.fn(),
  });

  it('a labelled role=group of plain buttons (a role=menu of role-less buttons announced as an empty menu; menuitems would break every getByRole("button") pin); ⋯ carries aria-controls; the Clear rows sit in a nested group; rows wear an inset focus ring; the stored size is NOT a menu row (Phase C: the sheet)', () => {
    const { container } = render(
      <ProfilePhoneCard {...props({ ...full(), sizeLabel: '3.0 MiB' })} />,
    );
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    expect(menu.getAttribute('role')).toBe('group');
    expect(menu.getAttribute('aria-label')).toBe('More actions for amsterdam shopper');
    const more = screen.getByRole('button', { name: 'More actions' });
    expect(more.getAttribute('aria-controls')).toBe(menu.id);
    expect(menu.id.length).toBeGreaterThan(0);
    for (const b of menu.querySelectorAll('button')) {
      expect(b.getAttribute('role'), b.getAttribute('aria-label') ?? '').toBeNull();
      expect(classes(b)).toContain('focus-visible:outline-offset-[-2px]');
    }
    // Phase C: the size is no menu row any more (the details sheet holds it —
    // see a-card-details-sheet-holds-every-fact-the-tile-cut.test.tsx).
    expect(byComponent(menu, 'profile-size')).toBeNull();
    expect(menu.textContent).not.toContain('3.0 MiB');
    expect(byRegion(container, 'meta')?.getAttribute('title')).toBeNull();
    fireEvent.click(more);
    fireEvent.click(screen.getByLabelText(/^Clearing options for /));
    expect(screen.getByLabelText(/^Clear cache for /).parentElement?.getAttribute('role')).toBe(
      'group',
    );
    cleanup();
  });

  it('ArrowDown on ⋯ opens the menu and focuses its first enabled item; ArrowDown/ArrowUp/Home/End walk the enabled items (a disabled row is skipped); Escape closes it and returns focus to ⋯', () => {
    render(<ProfilePhoneCard {...props({ ...full(), running: true, onStop: vi.fn() })} />);
    const more = screen.getByRole('button', { name: 'More actions' });
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    expect(menu.getAttribute('data-open')).toBe('true');
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter(
      (b) => !b.disabled,
    );
    expect(items.length).toBeGreaterThan(3);
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[1]);
    fireEvent.keyDown(menu, { key: 'End' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    // Delete is disabled while running: End landed on the last ENABLED row.
    expect(screen.getByLabelText<HTMLButtonElement>('Delete amsterdam shopper').disabled).toBe(
      true,
    );
    expect(document.activeElement).not.toBe(screen.getByLabelText('Delete amsterdam shopper'));
    fireEvent.keyDown(menu, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(menu, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(items[items.length - 1]);
    fireEvent.keyDown(menu, { key: 'Home' });
    expect(document.activeElement).toBe(items[0]);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(menu.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(more);
    cleanup();
  });

  it("activating a row (Enter → click) closes the menu and returns focus to ⋯; the row's handler fires once", () => {
    const onEdit = vi.fn();
    render(<ProfilePhoneCard {...props({ ...full(), onEdit })} />);
    const more = screen.getByRole('button', { name: 'More actions' });
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    more.focus();
    fireEvent.keyDown(more, { key: 'ArrowDown' });
    const edit = screen.getByLabelText('Edit amsterdam shopper');
    edit.focus();
    expect(document.activeElement).toBe(edit);
    fireEvent.click(edit);
    expect(onEdit).toHaveBeenCalledTimes(1);
    expect(menu.getAttribute('data-open')).toBe('false');
    expect(document.activeElement).toBe(more);
    // Mounting a closed card never steals focus (the restore effect is gated on a prior open).
    cleanup();
    render(<ProfilePhoneCard {...props(full())} />);
    expect(document.activeElement).toBe(document.body);
    cleanup();
  });

  it('with the menu open, clicking Launch launches AND closes the menu; a pointer-down on the dock outside ⋯ closes it too', () => {
    const onPrimary = vi.fn();
    const { container } = render(<ProfilePhoneCard {...props({ ...full(), onPrimary })} />);
    const menu = byComponent(document, 'card-actions-menu') as HTMLElement;
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(menu.getAttribute('data-open')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Launch' }));
    expect(onPrimary).toHaveBeenCalledTimes(1);
    expect(menu.getAttribute('data-open')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(menu.getAttribute('data-open')).toBe('true');
    fireEvent.pointerDown(byComponent(container, 'card-dock') as HTMLElement);
    expect(menu.getAttribute('data-open')).toBe('false');
    // …but a pointer-down on ⋯ itself is "inside" (the toggle, not the closer).
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.pointerDown(screen.getByRole('button', { name: 'More actions' }));
    expect(menu.getAttribute('data-open')).toBe('true');
    cleanup();
  });
});

describe('CONTROL — every gallery state', () => {
  it('has the Launch control present, unhidden and OUTSIDE the body; every truncate/line-clamp element titled; all seven regions in order; the health pill exactly once', () => {
    // Renders the harness's own STATES (imported, not copied) so a state added
    // for the gate is a state this arm covers.
    expect(STATES.length).toBeGreaterThanOrEqual(20);
    for (const state of STATES) {
      const { container, unmount } = render(<ProfilePhoneCard {...state.props} />);
      const article = container.querySelector('article') as HTMLElement;
      const body = byComponent(container, 'card-body') as HTMLElement;
      expect(body, `${state.label}: card-body missing`).not.toBeNull();
      const launch = screen.getByRole('button', { name: /^(Launch|Open session|Launching…)$/ });
      expect(launch.hidden, `${state.label}: Launch hidden`).toBe(false);
      expect(classes(launch), `${state.label}: Launch hidden by class`).not.toContain('hidden');
      expect(
        launch.closest('[aria-hidden="true"]'),
        `${state.label}: Launch aria-hidden`,
      ).toBeNull();
      expect(article.contains(launch), `${state.label}: Launch outside the card`).toBe(true);
      expect(body.contains(launch), `${state.label}: Launch inside the body`).toBe(false);
      expect(
        Array.from(container.querySelectorAll('[data-region]')).map((r) =>
          r.getAttribute('data-region'),
        ),
        `${state.label}: regions`,
      ).toEqual(['identity', 'status', 'exit', 'via', 'caps', 'when', 'meta']);
      expect(
        container.querySelectorAll('[data-component="health-pill"]'),
        `${state.label}: pill`,
      ).toHaveLength(1);
      expect(container.textContent, `${state.label}: no stale / Starting…`).not.toMatch(
        /\bstale\b|Starting…/,
      );

      const clamped = article.querySelectorAll('.truncate, [class*="line-clamp-"]');
      expect(
        clamped.length,
        `${state.label}: no clamped text at all — selector broke`,
      ).toBeGreaterThan(0);
      for (const el of clamped) {
        expect(
          el.closest('[title]'),
          `${state.label}: clamped text without a title — ${el.tagName} "${(el.textContent ?? '').trim().slice(0, 40)}"`,
        ).not.toBeNull();
      }
      unmount();
    }
  });
});

// ─── G2 (2026-09-12) — every harness scene renders a ready, populated stage ──
// scripts/gui-text-quality.mjs reads ALL_SCENES from the harness at run time
// and measures each stage's text leaves; this arm is the jsdom half of that
// contract. Through the SAME door the gate uses (`?scene=<name>` →
// `<Gallery />` → sceneFromSearch → the composition), every listed name must
// mount a `[data-scene=<name>][data-ready="1"]` stage carrying MORE THAN 20 text
// leaves (an element with its own non-blank text — the gate's leaf notion), and
// at least one leaf OUTSIDE the window chrome (the Sidebar `<aside>` — the one
// holding `nav[aria-label="Primary"]` — + the TitleBar `[data-tauri-drag-region]`),
// so a scene whose view painted nothing cannot pass on the chrome's labels
// alone. The six marketing names stay first and in order —
// scripts/marketing-screens.mjs's pixel pins and the runbook name them.
//
// LOADED, not merely populated (2026-09-12 review): a view's EMPTY state also
// clears both floors — FleetView's "No fleet members yet…" header alone is 7
// own-text leaves outside the chrome, RecordingsView's "No recordings yet" 5 —
// so for every audit scene the arm ALSO requires each of the harness's
// `auditLoadedMarkers` (the fixture rows the view was fed: 'Rig A' + its
// TEST-NET URL, 'Checkout flow', the saved chat titles, the member emails …)
// among the strings of elements OUTSIDE the chrome: own text nodes plus the
// title / aria-label / placeholder / value / alt attributes and input values
// (a fixture that only reaches an input's `value` still counts). The chrome
// cannot satisfy a marker — its base-URL pill is the same host as
// AUDIT_BASE_URL, so the walk skips it.
//
// Mutations reasoned: drop `data-ready="1"` from the stage in gallery.tsx → the
// query finds nothing → red; narrow `sceneFromSearch` back to MARKETING_SCENES
// → an audit name renders the plain state gallery (no `[data-scene]`) → red;
// reorder or drop a name in ALL_SCENES → the order arm reds; revert
// buildTauriInvoke's `plugin:store|get` (audit-scenes.tsx) to `[null, false]`
// → the real plugin-store over the stub hands FleetView no registry → its
// empty state renders → 'Rig A' is absent outside the chrome → audit-fleet
// reds (audit-agent-chat's saved chats likewise); revert `plugin:fs|exists` /
// `read_text_file` → RecordingsView has no index → 'Checkout flow' absent →
// audit-recordings reds; make one of this file's plugin mocks inert again
// (LazyStore.get → null) → the same empty states → the same reds; drop a
// method from buildAuditClient (sessions.list) → SessionsView's empty state →
// 'Amsterdam checkout' absent → audit-sessions reds.
describe('every harness scene (ALL_SCENES) renders a ready stage with > 20 text leaves', () => {
  const ownTextLeaves = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('*')).filter((el) =>
      Array.from(el.childNodes).some(
        (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '',
      ),
    );
  /** The window chrome's roots inside a stage: the Sidebar — the `<aside>`
   *  that holds `nav[aria-label="Primary"]`, NOT every `<aside>` (AgentChatView's
   *  saved-chat rail and RecordingsView's recording rail are asides of the
   *  VIEW, and the fixture rows they carry are exactly what the markers below
   *  look for). Drag regions are handled separately by `isDragRegion` below,
   *  not by a root list — see its own comment for why. */
  const chromeRoots = (root: HTMLElement): HTMLElement[] =>
    Array.from(root.querySelectorAll<HTMLElement>('aside')).filter(
      (a) => a.querySelector('nav[aria-label="Primary"]') !== null,
    );
  /**
   * Tauri's drag-region attribute is INHERITED down the tree until the
   * NEAREST descendant sets it again — exactly like `-webkit-app-region` in
   * Electron: `="false"` on a button inside a `true` toolbar opts that one
   * button back OUT, it does not stop being nested in a chrome element.
   *
   * ⛔ A fixed "true roots" list (what this used to be —
   * `querySelectorAll('[data-tauri-drag-region]')`, `.contains()`-checked
   * against every element) cannot express that: it does not distinguish
   * `="false"` from the true kind (attribute PRESENCE, not value), so it
   * swallowed every opt-out too — and cannot express a nested opt-BACK-IN
   * either, so even fixing the value check would still have marked
   * SimulatorWindow's whole `simulator-device` bezel (a true region) as
   * chrome, screen and terminal overlay included, because `.contains()`
   * cannot see the `="false"` on `simulator-screen` partway down. Added for
   * the simulator's own gallery scenes ("Bringing The Stage everywhere" stage
   * 1) — the one component in the app that opts interactive descendants back
   * OUT of a `true` ancestor at all (its screen, its drawer, its buttons);
   * every other drag-region user (TitleBar.tsx, IOSKeyboard.tsx) is a single
   * thin, content-free, never-nested strip, so `.closest()` resolving to the
   * nearest attribute-bearing ancestor was always the correct answer there
   * too — it just never had a nested override to get wrong.
   */
  const isDragRegion = (el: HTMLElement): boolean => {
    const nearest = el.closest<HTMLElement>('[data-tauri-drag-region]');
    return nearest !== null && nearest.getAttribute('data-tauri-drag-region') !== 'false';
  };
  const inChrome = (roots: ReadonlyArray<HTMLElement>, el: HTMLElement): boolean =>
    roots.some((r) => r.contains(el)) || isDragRegion(el);
  /** Every string a viewer could read off the elements OUTSIDE the chrome: own
   *  text nodes (each on its own — textContent glues siblings), the surfacing
   *  attributes, and input values. */
  const stringsOutsideChrome = (root: HTMLElement): string[] => {
    const roots = chromeRoots(root);
    const out: string[] = [];
    for (const el of Array.from(root.querySelectorAll<HTMLElement>('*'))) {
      if (inChrome(roots, el)) continue;
      for (const n of Array.from(el.childNodes)) {
        if (n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim() !== '') {
          out.push(n.textContent ?? '');
        }
      }
      for (const attr of ['title', 'aria-label', 'placeholder', 'value', 'alt']) {
        const v = el.getAttribute(attr);
        if (v !== null) out.push(v);
      }
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) out.push(el.value);
    }
    return out;
  };

  it('ALL_SCENES is non-empty, unique, and opens with the seven marketing scenes in order', () => {
    expect(ALL_SCENES.length).toBeGreaterThan(0);
    expect(new Set(ALL_SCENES).size).toBe(ALL_SCENES.length);
    expect(ALL_SCENES.slice(0, MARKETING_SCENES.length)).toEqual([
      'profiles-grid',
      'profiles-list',
      'proxies',
      'simulator',
      'billing',
      'command-center',
      'ai-running',
    ]);
  });

  for (const name of ALL_SCENES) {
    it(`${name}: [data-scene][data-ready="1"] with > 20 text leaves, some outside the chrome${isAuditScene(name) ? ', every loaded-state marker among them' : ''}`, async () => {
      const restore = freezeHarnessClock();
      const search = window.location.search;
      window.history.replaceState(null, '', `?scene=${name}`);
      try {
        const { container } = render(<Gallery />);
        const stage = container.querySelector<HTMLElement>(
          `[data-scene="${name}"][data-ready="1"]`,
        );
        expect(stage, `${name}: no ready stage — did sceneFromSearch accept it?`).not.toBeNull();
        if (stage === null) return;
        // A view that loads through the fixture client / the Tauri stub reaches
        // its data after a tick; wait for the leaves rather than a fixed time.
        // For an audit scene, wait for the LAST marker (the views load async),
        // then require every marker — the empty state never carries them.
        const markers = isAuditScene(name) ? auditLoadedMarkers(name) : [];
        if (isAuditScene(name)) {
          expect(
            markers.length,
            `${name}: an audit scene with no loaded-state marker`,
          ).toBeGreaterThan(0);
        }
        await waitFor(
          () => {
            const leaves = ownTextLeaves(stage);
            const roots = chromeRoots(stage);
            // A sanity check that chrome-detection itself is working (not
            // vacuously — "everything reads as outside chrome" is also what a
            // BROKEN detector looks like), not a claim every scene has a
            // Sidebar: the simulator scenes are their own chrome-less OS
            // window (no `AppWindow`, so `roots` — Sidebar asides — is
            // legitimately empty) and prove the detector the other way, via a
            // real drag region (`isDragRegion` above, checked separately from
            // `roots` for exactly this reason).
            expect(
              roots.length > 0 || stage.querySelector('[data-tauri-drag-region]') !== null,
              `${name}: chrome roots found`,
            ).toBe(true);
            expect(leaves.length, `${name}: text leaves`).toBeGreaterThan(20);
            expect(
              leaves.filter((el) => !inChrome(roots, el)).length,
              `${name}: text leaves outside the Sidebar / TitleBar chrome`,
            ).toBeGreaterThan(0);
            const last = markers[markers.length - 1];
            if (last !== undefined) {
              expect(
                stringsOutsideChrome(stage).join('\n'),
                `${name}: last fixture marker "${last}" outside the chrome`,
              ).toContain(last);
            }
          },
          { timeout: 5_000 },
        );
        const outside = stringsOutsideChrome(stage).join('\n');
        for (const marker of markers) {
          expect(
            outside,
            `${name}: fixture "${marker}" never reached the DOM outside the chrome — the view is on its empty / skeleton state`,
          ).toContain(marker);
        }
      } finally {
        window.history.replaceState(null, '', search === '' ? window.location.pathname : search);
        restore();
        cleanup();
      }
    });
  }
});
