// Visual-check harness (2026-06-15) — renders the real ProfilePhoneCard across
// its meaningful states so an automated screenshot pass (repo-root
// scripts/gui-visual-check.mjs → Playwright → PNG) can review the actual rendered
// UI, not a mockup. NOT part
// of the shipped app: nothing imports this except visual-harness.html, which is
// not a build input (vite/Tauri bundle index.html only). Add new states here as
// the card grows so the visual review stays representative.

import { useMemo, type ContextType, type JSX, type ReactNode } from 'react';
import type { AccountSelfProfile } from '@driftstack/sdk';
import { ProfilePhoneCard, type ProfilePhoneCardProps } from '../components/ProfilePhoneCard';
import { ProfilesTable, type ProfileTableRow } from '../components/ProfilesTable';
import { CostPanel } from '../components/CostPanel';
import { SkeletonRows } from '../components/Skeleton';
import { ProxyForm } from '../views/ProxiesView';
import { DeviceToolbar } from '../views/SimulatorWindow';
import { Kpi } from '../views/CommandCenterView';
import { TierBadge } from '../components/TierBadge';
import { VPN_NOT_STORED_CHECK_NOTICE } from '../lib/proxy-check-copy';
// Marketing scenes (below) — the app's real window chrome + the cockpit readouts.
import { TitleBar } from '../components/TitleBar';
import { Sidebar, type SidebarViewKind } from '../components/Sidebar';
import { ThemeSwitcher } from '../components/ThemeSwitcher';
import { ConnectionPill } from '../components/ConnectionPill';
import { ProfilesActionBar, type ProfileSortBy } from '../components/ProfilesActionBar';
import { ExitIpChip } from '../components/ExitIpChip';
import { QuicReadout } from '../components/QuicReadout';
import { OsReadout } from '../components/OsReadout';
import { IOSKeyboard } from '../components/IOSKeyboard';
import { SettingsContext } from '../lib/SettingsContext';
import { RecordingsProvider } from '../lib/recordings';
import { DEFAULT_SETTINGS, type DriftstackSettings } from '../lib/settings';
import type { ProxyDraft } from '../lib/proxies';
import type { ConnectionStatus } from '../lib/use-connection-status';
import type { AgentSessionCapabilityReport } from '../lib/agent-session-control';
// Audit scenes (2026-09-12) — one composition per view the marketing scenes do
// not cover, for scripts/gui-text-quality.mjs. ⚠️ CYCLE: audit-scenes.tsx
// imports AppWindow / the fixtures from THIS module; it therefore touches no
// gallery export at its own top level, and this module touches AuditScene /
// auditSceneSizes only inside functions (Gallery, sceneSize) — whichever of
// the two a test imports first, both finish evaluating before either binding
// is read. The NAMES live here so `ALL_SCENES` is a plain top-level constant.
import { AuditScene, auditSceneSizes } from './audit-scenes';

const noop = (): void => undefined;

// ─── Marketing-scene clock + stage (hoisted) ──────────────────────────────────
// The marketing scenes (block at the END of this file) render "at" one frozen
// instant. The freeze must run BEFORE `STATES` below is built: the live card's
// `runningSinceIso` is computed from Date.now() at module load, so a freeze
// placed after it left a human opening `?scene=` with a label counted from the
// real clock while the capture script (which pins the clock before navigation)
// showed "running 12m". tests/unit/marketing-scenes.test.tsx loads this module
// with `?scene=` set and asserts both the clock and that offset.

/** The instant every marketing scene is rendered "at". */
export const FROZEN_NOW_ISO = '2026-06-15T06:42:00.000Z';
export const MARKETING_SCENES = [
  'profiles-grid',
  'profiles-list',
  'proxies',
  'simulator',
  'billing',
  'command-center',
] as const;
export type MarketingSceneName = (typeof MARKETING_SCENES)[number];
/** Audit scenes — `?scene=audit-<view>`: the REAL view in the same window
 *  chrome, fed fixture data, for the text-quality gate (compositions + sizes in
 *  audit-scenes.tsx; the names are here so ALL_SCENES is a top-level constant,
 *  see the import note above). Not captured for marketing. */
export const AUDIT_SCENES = [
  'audit-sessions',
  'audit-fleet',
  'audit-recordings',
  'audit-connectivity',
  'audit-settings',
  'audit-first-run',
  'audit-recipes',
  'audit-agent-chat',
  'audit-team',
] as const;
export type AuditSceneName = (typeof AUDIT_SCENES)[number];
export type SceneName = MarketingSceneName | AuditSceneName;
/** Every scene the harness renders — what scripts/gui-text-quality.mjs reads
 *  (marketing first, in capture order; the gate's positive control checks the
 *  six marketing names are present). */
export const ALL_SCENES: ReadonlyArray<SceneName> = [...MARKETING_SCENES, ...AUDIT_SCENES];
export function isAuditScene(name: SceneName): name is AuditSceneName {
  return (AUDIT_SCENES as ReadonlyArray<string>).includes(name);
}
/** The default stage (CSS px); `sceneSize` is the per-scene truth. */
export const SCENE_WIDTH = 1280;
export const SCENE_HEIGHT = 800;
/** Stage per scene. The real ProfilesTable with the eight profiles' rows
 *  (place names, tags, a note, the five row actions) is ~1490 CSS px wide —
 *  inside a 1280 window its Actions column falls off the right edge (the
 *  first capture shipped a cut "Live" pill and no Launch button), so the list
 *  view gets a wider window — and a taller one (880): the eight rows include a
 *  six-tag row that wraps to four lines once the Actions column widened for
 *  'Open session', and at 800 the last row ran past the frame. scripts/
 *  marketing-screens.mjs declares the same sizes, fails when they differ, and
 *  fails when the table does not fit its shell. */
export function sceneSize(name: SceneName): { width: number; height: number } {
  if (isAuditScene(name)) return auditSceneSizes()[name];
  return name === 'profiles-list'
    ? { width: 1800, height: 880 }
    : { width: SCENE_WIDTH, height: SCENE_HEIGHT };
}

/** `?scene=<name>` → the scene (marketing or audit), or null for anything else
 *  (the plain gallery). The clock freeze below keys on this, so an audit scene
 *  renders at FROZEN_NOW_ISO like a marketing one. */
export function sceneFromSearch(search: string): SceneName | null {
  const raw = new URLSearchParams(search).get('scene');
  if (raw === null) return null;
  return (ALL_SCENES as ReadonlyArray<string>).includes(raw) ? (raw as SceneName) : null;
}

/** Pin `Date.now` to FROZEN_NOW_ISO. Returns the restore function. */
export function freezeHarnessClock(): () => void {
  const original = Date.now;
  const fixed = Date.parse(FROZEN_NOW_ISO);
  Date.now = () => fixed;
  return () => {
    Date.now = original;
  };
}

if (typeof window !== 'undefined' && sceneFromSearch(window.location.search) !== null) {
  freezeHarnessClock();
}

function base(over: Partial<ProfilePhoneCardProps>): ProfilePhoneCardProps {
  return {
    name: 'amsterdam shopper',
    monogram: 'AS',
    hue: 210,
    deviceLabel: 'iPhone 17',
    running: false,
    selected: false,
    lastUsedIso: '2026-06-15T06:30:00.000Z',
    folder: '',
    tags: [],
    hasProxy: true,
    proxyExplicit: true,
    // Polish — the default via row is the proxy's LABEL (the comp's); the
    // mono host:port fallback is the 'unnamed proxy' state's, which sets
    // proxyName: null explicitly.
    proxyName: 'Oxylabs residential NL #3',
    proxyAddress: 'gate.nodemaven.com:1080',
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    locationLabel: 'Amsterdam, North Holland',
    latencyMs: 42,
    latencyFillPct: 28,
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
    checkedAtIso: '2026-06-15T06:30:00.000Z',
    busy: false,
    launching: false,
    anyBusy: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    onToggleSelect: noop,
    onPrimary: noop,
    onWatch: noop,
    onTest: noop,
    onAssist: noop,
    onExport: noop,
    onDelete: noop,
    ...over,
  };
}

/** One SOCKS5 result that FAILS `proxyVerdict` (reaches + authenticates, cannot
 *  route) — the shape that trips the repair row. */
const CANNOT_ROUTE = {
  reachable: true,
  auth_ok: true,
  udp_associate: false,
  can_route: false,
  connect_reply: 0x05,
  latency_ms: 0,
  message: 'CONNECT refused by the proxy (reply 0x05 — connection refused)',
} as const;

/** The failure the state matrix names: the proxy did not answer at all. */
const NOT_REACHABLE = {
  reachable: false,
  auth_ok: false,
  udp_associate: false,
  can_route: false,
  connect_reply: 0xff,
  latency_ms: 0,
  message: 'The proxy did not answer. Check the host and port, and that it is online.',
} as const;

const SIXTY_CHAR_NAME = 'amsterdam shopper for the netherlands christmas campaigns 26';
const EIGHTY_CHAR_NOTE =
  'Warm this one every Monday before 09:00 CET; the checkout flow rejects cold ones';
/** Phase B state 11 — a 45-char name (truncates at 178 and at 260). */
const FORTY_FIVE_CHAR_NAME = 'amsterdam shopper with a long descriptive nam';
const LONG_PROXY_NAME = 'Oxylabs residential NL rotating #3';
const LONG_PLACE = 'Amsterdam, North Holland, Netherlands';

// The meaningful visual states. Label each so the screenshot is self-describing.
// ⛔ EXPORTED: the jsdom guard in tests/unit/profile-phone-card.test.tsx renders
// EVERY state here and asserts the Launch control survives each one — a state
// added here is a state that guard covers, with no second list to keep in sync.
// Phase B — the gate (scripts/gui-visual-check.mjs) additionally asserts that
// every state is exactly 234px tall and that every region meets its budget, so
// a state added here is a state the geometry proof covers too.
export const STATES: ReadonlyArray<{ label: string; props: ProfilePhoneCardProps }> = [
  { label: 'idle · UDP ok', props: base({}) },
  {
    label: 'MAX · full egress + folder + tags + saved-tabs + note (overflow repro)',
    props: base({
      name: FORTY_FIVE_CHAR_NAME,
      folder: 'Shopping / Netherlands',
      tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
      savedTabsReopen: true,
      sizeLabel: '128 MB',
      locationLabel: LONG_PLACE,
      proxyName: LONG_PROXY_NAME,
      note: EIGHTY_CHAR_NOTE,
      onSaveNote: noop,
      onEdit: noop,
      onTrim: noop,
      onActivity: noop,
      osFingerprint: { os: 'macos-or-ios', confidence: 'high', reason: 'SYN/TTL 64, MSS 1460' },
    }),
  },
  {
    label: 'launching · proxy check',
    props: base({ busy: true, launching: true }),
  },
  {
    label: 'running · live',
    props: base({
      name: 'tokyo sneakers',
      monogram: 'TS',
      icon: '👟',
      hue: 320,
      running: true,
      runningSinceIso: new Date(Date.now() - 12 * 60_000).toISOString(),
      onStop: noop,
      flag: '🇯🇵',
      countryCode: 'JP',
      exitIp: '133.18.7.40',
      locationLabel: 'Tokyo',
      latencyMs: 88,
      latencyFillPct: 60,
    }),
  },
  {
    label: 'UDP fail (muted, never red)',
    props: base({
      name: 'berlin reviews',
      monogram: 'BR',
      hue: 28,
      flag: '🇩🇪',
      countryCode: 'DE',
      exitIp: '91.64.12.200',
      locationLabel: 'Berlin',
      latencyMs: 210,
      latencyFillPct: 95,
      latencyGood: false,
      capabilities: {
        reachable: true,
        auth_ok: true,
        udp_associate: false,
        can_route: true,
        connect_reply: 0x00,
        latency_ms: 210,
        message: 'no udp',
      },
    }),
  },
  {
    label: 'untested',
    props: base({
      name: 'sao paulo deals',
      monogram: 'SP',
      hue: 140,
      flag: '🇧🇷',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      probed: false,
      capabilities: null,
      checkedAtIso: null,
      lastUsedIso: null,
    }),
  },
  {
    label: 'no proxy',
    props: base({
      name: 'local sandbox',
      monogram: 'LS',
      hue: 0,
      hasProxy: false,
      proxyExplicit: true,
      proxyAddress: null,
      flag: '🌍',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: null,
      checkedAtIso: null,
    }),
  },
  {
    label: 'selected · folder + tags',
    props: base({
      name: 'a profile with a long enough name to clamp',
      monogram: 'LP',
      hue: 260,
      selected: true,
      folder: 'Shopping',
      tags: ['aged', 'verified'],
    }),
  },
  // ── Phase A (2026-09-11) — the states the grid measurement named. Each one
  // exists because a row in it painted past the 178px card before the fix.
  {
    label: 'failed · socks5 (Re-test + Change)',
    props: base({
      name: 'lisbon returns',
      monogram: 'LR',
      hue: 350,
      flag: '🇵🇹',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: NOT_REACHABLE,
      proxyName: LONG_PROXY_NAME,
      lastUsedIso: null,
      checkedAtIso: new Date(Date.now() - 2 * 3_600_000).toISOString(),
      onEdit: noop,
    }),
  },
  {
    label: 'failed · socks5 · cannot route',
    props: base({
      name: 'porto returns',
      monogram: 'PR',
      hue: 340,
      flag: '🇵🇹',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: CANNOT_ROUTE,
      onEdit: noop,
    }),
  },
  {
    label: 'failed · socks5 · testing',
    props: base({
      name: 'lisbon returns',
      monogram: 'LR',
      hue: 350,
      flag: '🇵🇹',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: CANNOT_ROUTE,
      testing: true,
      onEdit: noop,
    }),
  },
  { label: 'healthy · testing', props: base({ testing: true }) },
  {
    label: 'vpn · idle (fleet latency)',
    props: base({
      name: 'zurich banking',
      monogram: 'ZB',
      hue: 190,
      flag: '🇨🇭',
      countryCode: 'CH',
      exitIp: '185.22.1.9',
      locationLabel: 'Zürich, Zurich',
      vpn: true,
      proxyName: 'ProtonVPN CH#42',
      proxyAddress: 'ch-42.protonvpn.net:51820',
      capabilities: null,
      quicProbe: true,
      latencyMs: 61,
      latencyFillPct: 40,
      latencyFromServer: true,
      latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-01' },
    }),
  },
  {
    label: 'vpn · tunnel down (failure + notice + 4 tags)',
    props: base({
      name: 'oslo classifieds',
      monogram: 'OC',
      hue: 80,
      flag: '🇳🇴',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: null,
      vpn: true,
      proxyName: 'Mullvad no-osl-wg-001',
      proxyAddress: '193.32.127.66:51820',
      vpnFailure:
        'The test Mac could not bring the tunnel up: handshake timed out after 20 s (no reply from 193.32.127.66:51820).',
      vpnNotice:
        'Tunnel test not run this time — a live session holds the tunnel. Showing the last result.',
      folder: 'Marketplaces',
      tags: ['classifieds', 'norway', 'aged', 'warm'],
      onEdit: noop,
    }),
  },
  {
    label: 'vpn · no verdict yet',
    props: base({
      name: 'madrid tickets',
      monogram: 'MT',
      hue: 40,
      flag: '🇪🇸',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: null,
      vpn: true,
      proxyName: 'Mullvad es-mad-wg-004',
      checkedAtIso: null,
      // Polish — the notice says 'Endpoint resolves.', so the row carries the
      // resolved pre-flight the grid would: the pill reads 'endpoint ok'.
      endpoint: { resolved: true, message: 'Resolved' },
      vpnNotice: VPN_NOT_STORED_CHECK_NOTICE,
    }),
  },
  {
    // (o) — the fleet brought the tunnel up and observed the exit but reported
    // no latency: the grid's green 'tunnel up · no latency'; the card's pill is
    // 'tunnel up' and the caps row shows what that reply measured.
    label: 'vpn · tunnel up, no latency',
    props: base({
      name: 'vienna listings',
      monogram: 'VL',
      hue: 300,
      flag: '🇦🇹',
      countryCode: 'AT',
      exitIp: '185.22.1.10',
      locationLabel: 'Vienna, Vienna',
      vpn: true,
      proxyName: 'ProtonVPN AT#7',
      proxyAddress: 'at-7.protonvpn.net:51820',
      capabilities: null,
      quicProbe: true,
      latencyMs: null,
      latencyFillPct: 0,
      latencyGood: false,
      latencyVantage: { measuredFrom: 'fleet', nodeId: 'mac-mini-02' },
      endpoint: { resolved: true, message: 'Resolved' },
    }),
  },
  {
    // (o) — the endpoint does not resolve: red 'unresolved' (the resolver's
    // message as title), Re-check + Change, no exit, no Check VPN promise.
    label: 'vpn · endpoint unresolved',
    props: base({
      name: 'warsaw parcels',
      monogram: 'WP',
      hue: 20,
      flag: '🌍',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      latencyFillPct: 0,
      latencyGood: false,
      capabilities: null,
      vpn: true,
      proxyName: 'Mullvad pl-waw-wg-003',
      proxyAddress: 'pl-waw-wg-003.mullvad.net:51820',
      endpoint: {
        resolved: false,
        message: 'DNS lookup of pl-waw-wg-003.mullvad.net failed: no such host.',
      },
      onEdit: noop,
    }),
  },
  {
    label: 'exit probe failed',
    props: base({
      name: 'dublin support',
      monogram: 'DS',
      hue: 120,
      flag: '🇮🇪',
      countryCode: null,
      exitIp: null,
      exitProbeFailed: true,
      locationLabel: null,
      latencyMs: 77,
      latencyFillPct: 50,
    }),
  },
  {
    label: 'socks5 · server vantage',
    props: base({ latencyFromServer: true, latencyVantage: { measuredFrom: 'control_plane' } }),
  },
  {
    label: 'inherited default · 15-char IPv4 · unnamed proxy',
    props: base({
      proxyExplicit: false,
      proxyName: null,
      proxyAddress: '255.255.255.255:65535',
      exitIp: '255.255.255.255',
    }),
  },
  {
    label: 'ipv6 exit',
    props: base({ exitIp: '2001:0db8:85a3:0000:0000:8a2e:0370:7334', locationLabel: null }),
  },
  {
    label: 'long proxy label',
    props: base({
      proxyName: 'Residential rotating pool — Amsterdam #04 (sticky 10 min, nodemaven)',
    }),
  },
  { label: 'note · 80 chars', props: base({ note: EIGHTY_CHAR_NOTE, onSaveNote: noop }) },
  { label: '60-char name', props: base({ name: SIXTY_CHAR_NAME, monogram: 'AS' }) },
  {
    label: 'long-names · 45-char name · long place · long proxy · default',
    props: base({
      name: FORTY_FIVE_CHAR_NAME,
      proxyName: LONG_PROXY_NAME,
      proxyAddress: '255.255.255.255:65535',
      proxyExplicit: false,
      locationLabel: LONG_PLACE,
      exitIp: '255.255.255.255',
    }),
  },
  {
    label: 'saved tabs · never launched',
    props: base({ savedTabsReopen: true, lastUsedIso: null }),
  },
  // ── Phase C (2026-09-11) — the DETAILS SHEET at rest, so the gate measures a
  // sheet-open tile like any other (234px, nothing outside the box, the dock
  // covered, the sheet's body the only scroller) and the review sees its
  // fullest and its emptiest fill. `detailsInitiallyOpen` is harness-only.
  {
    label: 'sheet open · MAX (every fact at full length)',
    props: base({
      name: FORTY_FIVE_CHAR_NAME,
      folder: 'Shopping / Netherlands',
      tags: ['retail', 'nl', 'daily', 'warm', 'checkout'],
      savedTabsReopen: true,
      sizeLabel: '128 MB',
      locationLabel: LONG_PLACE,
      proxyName: LONG_PROXY_NAME,
      note: EIGHTY_CHAR_NOTE,
      onSaveNote: noop,
      onEdit: noop,
      onTrim: noop,
      onActivity: noop,
      osFingerprint: { os: 'macos-or-ios', confidence: 'high', reason: 'SYN/TTL 64, MSS 1460' },
      detailsInitiallyOpen: true,
    }),
  },
  {
    label: 'sheet open · vpn tunnel down (failure + notice in full)',
    props: base({
      name: 'oslo classifieds',
      monogram: 'OC',
      hue: 80,
      flag: '🇳🇴',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      capabilities: null,
      vpn: true,
      proxyName: 'Mullvad no-osl-wg-001',
      proxyAddress: '193.32.127.66:51820',
      vpnFailure:
        'The test Mac could not bring the tunnel up: handshake timed out after 20 s (no reply from 193.32.127.66:51820).',
      vpnNotice:
        'Tunnel test not run this time — a live session holds the tunnel. Showing the last result.',
      folder: 'Marketplaces',
      tags: ['classifieds', 'norway', 'aged', 'warm'],
      onEdit: noop,
      detailsInitiallyOpen: true,
    }),
  },
  {
    label: 'sheet open · untested (the emptiest fill)',
    props: base({
      name: 'sao paulo deals',
      monogram: 'SP',
      hue: 140,
      flag: '🇧🇷',
      countryCode: null,
      exitIp: null,
      locationLabel: null,
      latencyMs: null,
      probed: false,
      capabilities: null,
      checkedAtIso: null,
      lastUsedIso: null,
      detailsInitiallyOpen: true,
    }),
  },
];

/** Phase A — `?w=178|240|260` pins every phone card to that exact width, so the
 *  measurement gate (scripts/gui-visual-check.mjs) can assert geometry at the
 *  grid's real minimum instead of at whatever the viewport happens to divide
 *  into. The classes are spelled out so Tailwind's scanner emits them. */
const FIXED_WIDTH_CLASS: Readonly<Record<string, string>> = {
  '178': 'w-[178px]',
  '240': 'w-[240px]',
  '260': 'w-[260px]',
};
function fixedWidthClass(): string | null {
  if (typeof window === 'undefined') return null;
  const w = new URLSearchParams(window.location.search).get('w');
  if (w === null) return null;
  return FIXED_WIDTH_CLASS[w] ?? null;
}

export function Gallery(): JSX.Element {
  // `?scene=<name>` — one marketing composition in the app's window chrome
  // (see the Marketing scenes block at the end of this file). Anything else
  // renders the state gallery below, unchanged.
  const scene = typeof window === 'undefined' ? null : sceneFromSearch(window.location.search);
  if (scene !== null) {
    return isAuditScene(scene) ? <AuditScene name={scene} /> : <MarketingScene name={scene} />;
  }
  const fixedWidth = fixedWidthClass();
  return (
    <div className="min-h-screen bg-surface-base p-8">
      <h1 className="mb-1 text-lg font-semibold text-ink-primary">
        ProfilePhoneCard — visual states
      </h1>
      <p className="mb-6 text-sm text-ink-secondary">
        Automated render for the geometry gate (scripts/gui-visual-check.mjs). Every tile is 234px
        tall at 178 / 240 / 260px; the gate measures each region against its budget, plain and
        hovered, and opens the ⋯ menu on the first and last card.
      </p>
      <div
        data-harness="phone-cards"
        data-fixed-width={fixedWidth ?? 'auto'}
        className={
          fixedWidth === null
            ? 'grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3'
            : 'flex flex-wrap items-start gap-3'
        }
      >
        {STATES.map((s) => (
          <div
            key={s.label}
            data-state={s.label}
            className={`flex flex-col gap-1 ${fixedWidth ?? ''}`}
          >
            <span className="truncate text-2xs uppercase tracking-wide text-ink-muted">
              {s.label}
            </span>
            <ProfilePhoneCard {...s.props} />
          </div>
        ))}
      </div>

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        ProfilesTable — list view
      </h1>
      <ProfilesTable
        rows={TABLE_ROWS}
        sortKey="name"
        sortDir="asc"
        onSort={noop}
        allSelected={false}
        onToggleSelectAll={noop}
        onToggleSelect={noop}
        onPrimary={noop}
        onWatch={noop}
        onStop={noop}
        onTest={noop}
        onEdit={noop}
        onClone={noop}
        onTrim={noop}
        onDelete={noop}
        onSaveNote={noop}
      />

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        BillingCostView — wrapper states (header / skeleton / ready)
      </h1>
      <div className="flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-ink-muted">loading (skeleton)</span>
        <BillingWrapperShell>
          <SkeletonRows rows={4} label="Loading cost breakdown…" />
        </BillingWrapperShell>
      </div>
      <div className="mt-4 flex flex-col gap-1">
        <span className="text-2xs uppercase tracking-wide text-ink-muted">ready</span>
        <BillingWrapperShell>
          <CostPanel
            breakdown={{
              computeCents: 1840,
              storageCents: 120,
              egressCents: 640,
              emailCents: 15,
              llmCents: 2310,
              totalCents: 4925,
              thresholdState: 'between-soft-and-hard',
            }}
            billingCycle="2026-06"
          />
        </BillingWrapperShell>
      </div>

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        SimulatorWindow toolbar — idle · live · recording
      </h1>
      <div className="flex flex-wrap gap-10">
        <div className="w-72">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">idle</span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running={false}
            keyboardVisible={false}
            onToggleKeyboard={noop}
          />
        </div>
        <div className="w-72 pb-48">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">
            live session
          </span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running
            keyboardVisible={false}
            onToggleKeyboard={noop}
          />
        </div>
        <div className="w-72">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">
            keyboard open
          </span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running
            keyboardVisible
            onToggleKeyboard={noop}
          />
        </div>
      </div>

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        ProxyForm — proxy type editor (socks5 / wireguard / openvpn)
      </h1>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(360px,1fr))] gap-4">
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-muted">socks5</span>
          <ProxyForm
            mode="add"
            initial={{
              label: '',
              scheme: 'socks5',
              host: '',
              port: 1080,
              username: null,
              password: null,
            }}
            onCancel={noop}
            onSave={noop}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-muted">wireguard</span>
          <ProxyForm
            mode="add"
            initial={{
              label: '',
              scheme: 'wireguard',
              host: '',
              port: 51820,
              username: null,
              password: null,
            }}
            onCancel={noop}
            onSave={noop}
          />
        </div>
        <div className="flex flex-col gap-1">
          <span className="text-2xs uppercase tracking-wide text-ink-muted">openvpn</span>
          <ProxyForm
            mode="add"
            initial={{
              label: '',
              scheme: 'openvpn',
              host: '',
              port: 1194,
              username: null,
              password: null,
            }}
            onCancel={noop}
            onSave={noop}
          />
        </div>
      </div>

      <h1 className="mb-3 mt-10 text-lg font-semibold text-ink-primary">
        Command Center — Plan KPI (T-18)
      </h1>
      <p className="mb-3 text-sm text-ink-secondary">
        The plan tier is a category, so the Plan value is a TierBadge pill, not the big-number
        treatment that clipped &ldquo;Enterprise&rdquo; to &ldquo;Enterpr…&rdquo; at the card edge.
        A numeric KPI sits alongside for contrast.
      </p>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={<span>▦</span>} label="Profiles" value="3 / 10" />
        <Kpi
          icon={<span>✦</span>}
          label="Plan"
          value="Enterprise"
          valueNode={<TierBadge tier="enterprise" size="md" />}
        />
        <Kpi
          icon={<span>✦</span>}
          label="Plan"
          value="Agency"
          valueNode={<TierBadge tier="agency_manual" size="md" />}
        />
        <Kpi
          icon={<span>✦</span>}
          label="Plan"
          value="Free"
          valueNode={<TierBadge tier="free" size="md" />}
        />
      </div>
    </div>
  );
}

// Mirrors BillingCostView's header + layout chrome so the screenshot review
// matches the shipped wrapper (the view itself needs SettingsContext + the
// cost hook, which don't render headless). Keep in sync with BillingCostView.
function BillingWrapperShell({ children }: { children: JSX.Element }): JSX.Element {
  return (
    <div className="flex flex-col gap-4 rounded border border-surface-divider bg-surface-base p-6">
      <header className="flex items-start justify-between gap-4">
        <div>
          <span className="section-label">Billing</span>
          <h2 className="mt-1 text-lg font-medium tracking-tight text-ink-primary">Usage & cost</h2>
          <p className="mt-1 text-xs text-ink-muted">
            Metered usage and spend for the selected billing cycle.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="text-sm text-ink-secondary">Billing cycle</label>
          <select
            className="rounded border border-surface-divider bg-surface-input px-2 py-1 text-sm text-ink-primary"
            defaultValue="2026-06"
          >
            <option>2026-06</option>
          </select>
          <button type="button" className="btn-secondary">
            Refresh
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}

const TABLE_ROWS: ReadonlyArray<ProfileTableRow> = [
  {
    id: '1',
    name: 'amsterdam shopper',
    icon: '🛒',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇳🇱',
    countryCode: 'NL',
    exitIp: '82.14.220.9',
    proxyAddress: '127.0.0.1:24000',
    locationLabel: 'Netherlands',
    probed: true,
    udp: 'ok',
    latencyMs: 42,
    folder: 'Shopping',
    tags: ['aged'],
    lastUsedIso: '2026-06-15T06:30:00.000Z',
    selected: false,
    busy: true,
    launching: true,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '4.2 MiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
  {
    id: '2',
    name: 'tokyo sneakers',
    deviceLabel: 'iPhone 17',
    running: true,
    hasProxy: true,
    flag: '🇯🇵',
    countryCode: 'JP',
    exitIp: '133.18.7.40',
    proxyAddress: 'gate.nodemaven.com:1080',
    locationLabel: 'Japan',
    probed: true,
    udp: 'ok',
    latencyMs: 88,
    folder: '',
    tags: [],
    lastUsedIso: '2026-06-14T20:00:00.000Z',
    selected: true,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '18.7 MiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
  {
    id: '3',
    name: 'berlin reviews',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇩🇪',
    countryCode: 'DE',
    exitIp: '91.64.12.200',
    proxyAddress: '10.0.0.5:1080',
    locationLabel: 'Germany',
    probed: true,
    udp: 'fail',
    latencyMs: 210,
    folder: 'Reviews',
    tags: ['warm'],
    lastUsedIso: null,
    selected: false,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '1.1 GiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
  {
    id: '4',
    name: 'sao paulo deals',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: true,
    flag: '🇧🇷',
    countryCode: 'BR',
    exitIp: null,
    proxyAddress: '127.0.0.1:24010',
    locationLabel: null,
    probed: false,
    udp: 'unknown',
    latencyMs: null,
    folder: '',
    tags: [],
    lastUsedIso: '2026-06-10T12:00:00.000Z',
    selected: false,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '—',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
  {
    id: '5',
    name: 'local sandbox',
    deviceLabel: 'iPhone 17',
    running: false,
    hasProxy: false,
    flag: '🌍',
    countryCode: null,
    exitIp: null,
    proxyAddress: null,
    locationLabel: null,
    probed: false,
    udp: 'unknown',
    latencyMs: null,
    folder: '',
    tags: [],
    lastUsedIso: null,
    selected: false,
    busy: false,
    launching: false,
    testing: false,
    testDisabled: false,
    launchDisabled: false,
    note: '',
    sizeLabel: '512.0 KiB',
    createdAtIso: '2026-06-01T00:00:00.000Z',
  },
];

// ─── Marketing scenes (2026-09-11) ────────────────────────────────────────────
//
// `?scene=<name>` renders ONE full-width composition inside the app's real
// window chrome (TitleBar + Sidebar, dark + oxblood) at a fixed 1280×800 stage,
// so repo-root scripts/marketing-screens.mjs can capture the REAL components
// (same code, same CSS as the shipped app) for the marketing site. Nothing here
// touches STATES / TABLE_ROWS — the scenes READ them, with privacy overrides:
//
// ⛔ PRIVACY — never a real session, proxy, exit IP or account. Every host is
//    *.example.com, every exit IP is TEST-NET (RFC 5737), the account is
//    ops@example.com. tests/unit/marketing-scenes.test.tsx scans every scene's
//    rendered text for vendor hosts and non-TEST-NET IPv4s.
// ⛔ DETERMINISM — the clock is frozen at FROZEN_NOW_ISO (relative-time labels,
//    LiveElapsed, ConnectionPill's "last ok"), motion is killed by the capture
//    context's reduced-motion setting, and the Refreshed pill is a fixed string.
//    `freezeHarnessClock` runs at module load when a scene is requested (the
//    hoisted block near the top of this file, BEFORE `STATES` computes the live
//    card's start time), so a human opening the URL sees the same frame the
//    script captures.

/** RFC 5737 documentation addresses — never a real exit. */
const TEST_NET = {
  nl: '203.0.113.7',
  jp: '198.51.100.24',
  de: '192.0.2.61',
  ch: '203.0.113.42',
  gb: '198.51.100.8',
  fr: '192.0.2.118',
} as const;

export const FIXTURE_ACCOUNT: AccountSelfProfile = {
  id: 'acc_example',
  email: 'ops@example.com',
  name: null,
  tier: 'team_manual',
  status: 'active',
  timezone: 'Europe/Amsterdam',
  slug: null,
  region: 'eu',
  onboarding_completed_at: '2026-06-01T00:00:00.000Z',
  avatar_url: null,
  avatar_source: 'none',
  mfa_enrolled: true,
  concurrent_session_cap: 3,
  concurrent_session_active: 1,
  profile_cap: 10,
  profile_count: 8,
  teams: [],
};

export const FIXTURE_SETTINGS: DriftstackSettings = {
  ...DEFAULT_SETTINGS,
  apiKey: 'ds_live_example',
  baseUrl: 'https://driftstack.io',
};

const noopAsync = (): Promise<void> => Promise.resolve();

function stateProps(label: string): ProfilePhoneCardProps {
  const found = STATES.find((s) => s.label === label);
  if (found === undefined) throw new Error(`marketing scene: gallery state missing: ${label}`);
  return found.props;
}

/** The 8 curated cards of the profiles grid — each is an existing STATES entry
 *  (so the geometry gate already covers its layout) with example hosts and
 *  TEST-NET exits laid over it. Exported so the scene test can scan them. */
export const MARKETING_CARDS: ReadonlyArray<{ label: string; props: ProfilePhoneCardProps }> = [
  {
    label: 'idle · UDP ok',
    props: {
      ...stateProps('idle · UDP ok'),
      proxyName: 'Residential NL #3',
      proxyAddress: 'nl-3.proxy.example.com:1080',
      exitIp: TEST_NET.nl,
    },
  },
  {
    label: 'running · live',
    props: {
      ...stateProps('running · live'),
      proxyName: 'Residential JP #1',
      proxyAddress: 'jp-1.proxy.example.com:1080',
      exitIp: TEST_NET.jp,
      locationLabel: 'Tokyo, Tokyo',
    },
  },
  {
    label: 'vpn · idle (fleet latency)',
    props: {
      ...stateProps('vpn · idle (fleet latency)'),
      proxyName: 'WireGuard CH #42',
      proxyAddress: 'ch-42.vpn.example.com:51820',
      exitIp: TEST_NET.ch,
    },
  },
  {
    label: 'UDP fail (muted, never red)',
    props: {
      ...stateProps('UDP fail (muted, never red)'),
      proxyName: 'Datacenter DE #7',
      proxyAddress: 'de-7.proxy.example.com:1080',
      exitIp: TEST_NET.de,
      locationLabel: 'Berlin, Berlin',
    },
  },
  {
    label: 'selected · folder + tags',
    props: {
      ...stateProps('selected · folder + tags'),
      name: 'london checkout',
      monogram: 'LC',
      hue: 260,
      flag: '🇬🇧',
      countryCode: 'GB',
      exitIp: TEST_NET.gb,
      locationLabel: 'London, England',
      proxyName: 'Residential UK #2',
      proxyAddress: 'uk-2.proxy.example.com:1080',
      latencyMs: 35,
      latencyFillPct: 24,
    },
  },
  {
    label: 'MAX · full egress + folder + tags + saved-tabs + note (overflow repro)',
    props: {
      ...stateProps('MAX · full egress + folder + tags + saved-tabs + note (overflow repro)'),
      name: 'amsterdam wardrobe',
      monogram: 'AW',
      hue: 20,
      proxyName: 'Residential NL rotating #3',
      proxyAddress: 'nl-3.proxy.example.com:1080',
      exitIp: TEST_NET.nl,
      note: 'Warm every Monday before 09:00 CET; the checkout flow rejects cold profiles',
    },
  },
  {
    label: 'untested',
    props: {
      ...stateProps('untested'),
      proxyName: 'Residential BR #1',
      proxyAddress: 'br-1.proxy.example.com:1080',
    },
  },
  {
    label: 'saved tabs · never launched',
    props: {
      ...stateProps('saved tabs · never launched'),
      name: 'paris fashion',
      monogram: 'PF',
      hue: 200,
      flag: '🇫🇷',
      countryCode: 'FR',
      exitIp: TEST_NET.fr,
      locationLabel: 'Paris, Île-de-France',
      proxyName: 'Residential FR #5',
      proxyAddress: 'fr-5.proxy.example.com:1080',
      latencyMs: 58,
      latencyFillPct: 38,
    },
  },
];

function tableRowById(id: string): ProfileTableRow {
  const found = TABLE_ROWS.find((r) => r.id === id);
  if (found === undefined) throw new Error(`marketing scene: gallery table row missing: ${id}`);
  return found;
}
/** The live profile started 12 minutes before the frozen instant — the same
 *  offset the grid's live card uses (STATES computes it from the frozen clock). */
const RUNNING_SINCE_ISO = new Date(Date.parse(FROZEN_NOW_ISO) - 12 * 60_000).toISOString();
const CHECKED_AT_ISO = new Date(Date.parse(FROZEN_NOW_ISO) - 12 * 60_000).toISOString();
/** A row for a profile the gallery's TABLE_ROWS does not carry: the first row's
 *  shape (every flag the table reads, at its idle defaults) without its icon. */
function gridOnlyRow(over: Partial<ProfileTableRow> & Pick<ProfileTableRow, 'id' | 'name'>) {
  const { icon, ...plain } = tableRowById('1');
  void icon;
  return {
    ...plain,
    busy: false,
    launching: false,
    folder: '',
    tags: [],
    note: '',
    lastUsedIso: '2026-06-15T06:30:00.000Z',
    ...over,
  } satisfies ProfileTableRow;
}

/** The list view shows the SAME eight profiles as the grid — the site places
 *  both captures as one app at one instant — sorted by name the way the
 *  table's "PROFILE ↑" header says. TABLE_ROWS' four proxied rows are
 *  re-hosted to *.example.com / TEST-NET and aligned with their grid cards
 *  (place names, selection, the live row's start time); the four grid-only
 *  profiles are rows built from the first row's shape. `local sandbox` (no
 *  proxy) is not in the grid and is not here. */
export const MARKETING_TABLE_ROWS: ReadonlyArray<ProfileTableRow> = [
  {
    ...tableRowById('1'),
    proxyAddress: 'nl-3.proxy.example.com:1080',
    exitIp: TEST_NET.nl,
    locationLabel: 'Amsterdam, North Holland',
    busy: false,
    launching: false,
  },
  gridOnlyRow({
    id: 'm-wardrobe',
    name: 'amsterdam wardrobe',
    proxyAddress: 'nl-3.proxy.example.com:1080',
    exitIp: TEST_NET.nl,
    locationLabel: 'Amsterdam, North Holland',
    folder: 'Shopping',
    tags: ['aged', 'warm', 'vip', 'eu', 'q3', 'checkout'],
    note: 'Warm every Monday before 09:00 CET; the checkout flow rejects cold profiles',
    savedTabsReopen: true,
    sizeLabel: '96.3 MiB',
  }),
  {
    ...tableRowById('3'),
    proxyAddress: 'de-7.proxy.example.com:1080',
    exitIp: TEST_NET.de,
    locationLabel: 'Berlin, Berlin',
  },
  gridOnlyRow({
    id: 'm-london',
    name: 'london checkout',
    flag: '🇬🇧',
    countryCode: 'GB',
    exitIp: TEST_NET.gb,
    proxyAddress: 'uk-2.proxy.example.com:1080',
    locationLabel: 'London, England',
    latencyMs: 35,
    folder: 'Shopping',
    tags: ['aged', 'vip'],
    selected: true,
    sizeLabel: '7.3 MiB',
  }),
  gridOnlyRow({
    id: 'm-paris',
    name: 'paris fashion',
    flag: '🇫🇷',
    countryCode: 'FR',
    exitIp: TEST_NET.fr,
    proxyAddress: 'fr-5.proxy.example.com:1080',
    locationLabel: 'Paris, Île-de-France',
    latencyMs: 58,
    savedTabsReopen: true,
    lastUsedIso: null,
    sizeLabel: '2.8 MiB',
  }),
  { ...tableRowById('4'), proxyAddress: 'br-1.proxy.example.com:1080' },
  {
    ...tableRowById('2'),
    proxyAddress: 'jp-1.proxy.example.com:1080',
    exitIp: TEST_NET.jp,
    locationLabel: 'Tokyo, Tokyo',
    runningSinceIso: RUNNING_SINCE_ISO,
    selected: false,
  },
  gridOnlyRow({
    id: 'm-zurich',
    name: 'zurich banking',
    flag: '🇨🇭',
    countryCode: 'CH',
    exitIp: TEST_NET.ch,
    proxyAddress: 'ch-42.vpn.example.com:51820',
    locationLabel: 'Zürich, Zurich',
    vpn: true,
    latencyFromServer: true,
    latencyMs: 61,
    udp: 'ok',
    quic: 'ok',
    checkedAtIso: CHECKED_AT_ISO,
    sizeLabel: '9.6 MiB',
  }),
];

/** The simulator cockpit's Egress readouts read the session's capability
 *  report; this is a fully-observed one (exit + HTTP/3 + OS), TEST-NET exit.
 *  ⛔ It is the SIMULATOR SCENE's session, so it must agree with that scene's
 *  profile — `tokyo sneakers`, whose grid card is the one card marked `Live`
 *  and reads `via Residential JP #1` / `Tokyo, Tokyo`. The WebRTC candidate
 *  tracks the exit deliberately: equal means no leak, and `sim-webrtc-candidates
 *  [data-leak="false"]` is a capture guard. Consumed ONLY by SimulatorScene
 *  (grep: this file), so the six pinned captures never see it. */
export const MARKETING_CAPABILITY_REPORT: AgentSessionCapabilityReport = {
  manual_input_available: true,
  streaming_state: 'live',
  egress_state: 'live',
  h3_connection_observed: true,
  h3_connection_count: 4,
  exit_ip: TEST_NET.jp,
  exit_country: 'JP',
  exit_timezone: 'Asia/Tokyo',
  webrtc_candidate_ips: [TEST_NET.jp],
  observed_at: '2026-06-15T06:41:30.000Z',
  os_fingerprint: { os: 'Linux', confidence: 'high' },
  proxy_kind: 'socks5',
};

/** What the fleet knows about a proxy in the scene, in the terms ProxiesView
 *  tallies its header from: `isRowHealthy` counts a SOCKS5 row with a passing
 *  test and a VPN row the fleet brought up; the "WebRTC + QUIC" tally counts
 *  SOCKS5 rows with a measured UDP associate and is deliberately NOT VPN-aware
 *  (a tunnel carries UDP by construction; the tally is about proxies that
 *  had to prove it). The header numbers are DERIVED from these, never typed. */
export type MarketingProxyVerdict = 'socks5_ok_udp' | 'socks5_ok' | 'vpn_up' | 'untested';
export function proxyTally(list: ReadonlyArray<{ verdict: MarketingProxyVerdict }>): {
  total: number;
  healthy: number;
  udpCapable: number;
} {
  return {
    total: list.length,
    healthy: list.filter((p) => p.verdict !== 'untested').length,
    udpCapable: list.filter((p) => p.verdict === 'socks5_ok_udp').length,
  };
}

/** A key-shaped value that is not a key. The editors never show keys (the
 *  WireGuard summary names endpoint / address / allowed IPs / DNS only, and the
 *  replace box is empty in edit mode), but a stored WireGuard row always HAS
 *  its block — `validateDraft` refuses a save without one and `toDraft` carries
 *  it into the editor — so an edit-mode draft without one is a state the app
 *  cannot produce (the first capture showed the add-mode placeholder). */
const EXAMPLE_KEY = 'ExampleExampleExampleExampleExampleExampleE=';

/** The three proxies of the Proxies scene: each editor's saved draft (what
 *  `toDraft` hands ProxyForm for a stored row) plus the fleet's verdict. */
export const MARKETING_PROXIES: ReadonlyArray<{
  label: string;
  draft: ProxyDraft;
  verdict: MarketingProxyVerdict;
}> = [
  {
    label: 'socks5',
    verdict: 'socks5_ok_udp',
    draft: {
      label: 'Residential NL #3',
      scheme: 'socks5',
      host: 'nl-3.proxy.example.com',
      port: 1080,
      username: 'nl3-user',
      password: null,
    },
  },
  {
    label: 'wireguard',
    verdict: 'vpn_up',
    draft: {
      label: 'WireGuard CH #42',
      scheme: 'wireguard',
      host: 'ch-42.vpn.example.com',
      port: 51820,
      username: null,
      password: null,
      wireguard: {
        private_key: EXAMPLE_KEY,
        peer_public_key: EXAMPLE_KEY,
        endpoint: 'ch-42.vpn.example.com:51820',
        address: '10.7.0.2/32',
        allowed_ips: '0.0.0.0/0, ::/0',
        dns: '10.7.0.1',
      },
    },
  },
  {
    label: 'openvpn',
    verdict: 'vpn_up',
    draft: {
      label: 'OpenVPN DE #7',
      scheme: 'openvpn',
      host: 'de-7.vpn.example.com',
      port: 1194,
      // A VPN row keeps no SOCKS-style credential (the form clears both on a
      // scheme switch); the OpenVPN auth user rides inside the block.
      username: null,
      password: null,
      openvpn: {
        config_blob: [
          'client',
          'dev tun',
          'proto udp',
          'remote de-7.vpn.example.com 1194',
          'resolv-retry infinite',
          'nobind',
          'persist-key',
          'persist-tun',
          'remote-cert-tls server',
          'cipher AES-256-GCM',
          'auth SHA256',
          'verb 3',
        ].join('\n'),
        username: 'de7-user',
      },
    },
  },
];
export const MARKETING_PROXY_TALLY = proxyTally(MARKETING_PROXIES);

/** The macOS traffic lights sit in the title bar's pl-24 clearance in the real
 *  window (drawn by the OS, outside the DOM). Harness-only, decorative. */
function TrafficLights(): JSX.Element {
  return (
    <span
      aria-hidden="true"
      data-component="scene-traffic-lights"
      className="pointer-events-none absolute left-3 top-0 flex h-9 items-center gap-2"
    >
      <span className="h-3 w-3 rounded-full bg-[#ff5f57] ring-1 ring-black/20" />
      <span className="h-3 w-3 rounded-full bg-[#febc2e] ring-1 ring-black/20" />
      <span className="h-3 w-3 rounded-full bg-[#28c840] ring-1 ring-black/20" />
    </span>
  );
}

/** What the window hands the tree through SettingsContext (the provider's own
 *  value type is not exported). Audit scenes override `client` / `settings`. */
export type HarnessSettingsValue = NonNullable<ContextType<typeof SettingsContext>>;

/** The main window's chrome around one view: the real TitleBar (with the slot
 *  App.tsx fills) and the real Sidebar, fed the fixture account through the
 *  real SettingsContext. 1280×800, overflow hidden — nothing escapes the stage.
 *  `overlay` is the one slot ABOVE the window's own layers — what the simulator
 *  scene floats its popped-out device window in. A scene that passes nothing
 *  renders `undefined`, i.e. NO node at all, so the five other SCENES — six
 *  captures, `profiles-grid-hero` being a crop of `profiles-grid` — stay
 *  byte-identical (scripts/marketing-screens.mjs --verify pins all six).
 *  Audit scenes (audit-scenes.tsx) pass `settingsOverrides` (a fixture SDK
 *  client, an example.com base URL) and the matching title-bar `subtitle`; the
 *  marketing scenes pass neither, so their output is byte-for-byte what it was
 *  (scripts/marketing-screens.mjs --verify pins that). */
export function AppWindow({
  scene,
  current,
  children,
  overlay,
  settingsOverrides,
  subtitle = 'cloud',
}: {
  scene: SceneName;
  current: SidebarViewKind;
  children: ReactNode;
  overlay?: ReactNode;
  settingsOverrides?: Partial<HarnessSettingsValue>;
  subtitle?: string;
}): JSX.Element {
  const settingsValue = useMemo<HarnessSettingsValue>(
    () => ({
      settings: FIXTURE_SETTINGS,
      loading: false,
      client: null,
      activeWorkspace: null,
      setActiveWorkspace: noop,
      accountMe: FIXTURE_ACCOUNT,
      refreshAccountMe: noopAsync,
      authExpired: false,
      dismissAuthExpired: noop,
      update: noopAsync,
      ...settingsOverrides,
    }),
    [settingsOverrides],
  );
  const size = sceneSize(scene);
  const status: ConnectionStatus = {
    state: 'connected',
    lastOkAt: Date.parse(FROZEN_NOW_ISO) - 4_000,
    lastError: null,
    driver: null,
    agentExecution: null,
  };
  return (
    <SettingsContext.Provider value={settingsValue}>
      <RecordingsProvider>
        <div
          data-scene={scene}
          data-ready="1"
          data-frozen-now={FROZEN_NOW_ISO}
          data-stage-width={size.width}
          data-stage-height={size.height}
          style={{ width: size.width, height: size.height }}
          className="relative flex shrink-0 flex-col overflow-hidden bg-surface-base font-sans text-ink-primary antialiased"
        >
          <div className="relative shrink-0">
            <TrafficLights />
            <TitleBar
              subtitle={subtitle}
              right={
                <>
                  <ThemeSwitcher />
                  <span className="text-surface-divider">|</span>
                  <ConnectionPill status={status} baseUrl={settingsValue.settings.baseUrl} />
                  <span className="section-label">v0.1.49</span>
                </>
              }
            />
          </div>
          <div className="flex min-h-0 flex-1 overflow-hidden">
            <Sidebar current={current} onNavigate={noop} onSignOut={noop} onOpenPalette={noop} />
            <main className="min-w-0 flex-1 overflow-auto bg-surface-base">{children}</main>
          </div>
          {overlay}
        </div>
      </RecordingsProvider>
    </SettingsContext.Provider>
  );
}

// Mirrors the ProfilesView hero + header strip (the view itself needs the
// profile store, probe cache and live sessions, which don't render headless).
// Keep in sync with ProfilesView's `profiles-hero` block. The grid class is the
// view's PROFILES_GRID_CLASS, spelled out here so Tailwind emits it.
const PROFILES_GRID_CLASS_MIRROR = 'grid grid-cols-[repeat(auto-fill,minmax(178px,1fr))] gap-3';
function ProfilesFrame({
  viewMode,
  liveCount,
  total,
  sortBy = 'last-used',
  sortDir = 'desc',
  children,
}: {
  viewMode: 'grid' | 'list';
  liveCount: number;
  total: number;
  sortBy?: ProfileSortBy;
  sortDir?: 'asc' | 'desc';
  children: ReactNode;
}): JSX.Element {
  const toggle = (mode: 'grid' | 'list', glyph: string, label: string): JSX.Element => (
    <button
      type="button"
      aria-pressed={viewMode === mode}
      className={
        viewMode === mode
          ? 'rounded bg-accent-subtle px-2 py-1 text-xs font-medium text-ink-primary'
          : 'rounded px-2 py-1 text-xs text-ink-muted hover:text-ink-primary'
      }
    >
      {glyph} {label}
    </button>
  );
  return (
    <div className="flex h-full min-w-0 flex-col gap-4 p-6">
      <div
        data-component="profiles-hero"
        className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3"
      >
        <div className="min-w-0">
          <h2 className="text-[19px] font-semibold tracking-tight text-ink-primary">
            Good morning
          </h2>
          <p className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary">
            <b className="font-semibold text-ink-primary">{liveCount}</b> live
            <span className="text-surface-divider">·</span>
            <span className="font-semibold text-status-ready">87.5% proxy health</span>
            <span className="text-surface-divider">·</span>
            all systems nominal
          </p>
        </div>
        <div className="ml-auto flex flex-col items-end gap-2">
          <div className="flex items-center gap-2">
            <button type="button" className="btn-secondary flex items-center gap-1.5">
              <span aria-hidden="true">⤒</span>
              <span>Import</span>
            </button>
            <button type="button" className="btn-primary flex items-center gap-1.5">
              <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
                <path
                  d="M8 3v10M3 8h10"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                />
              </svg>
              <span>New profile</span>
            </button>
          </div>
          <button
            type="button"
            className="flex items-center gap-1.5 whitespace-nowrap text-[11px] text-ink-muted hover:text-ink-secondary"
          >
            <span
              aria-hidden="true"
              className="relative inline-block h-1.5 w-1.5 rounded-full bg-status-ready"
            />
            Refreshed <span className="mono">06:42:00</span> · auto-refresh 15s
          </button>
        </div>
      </div>
      <header className="flex flex-col gap-3">
        <ProfilesActionBar
          searchQuery=""
          onSearchChange={noop}
          statusFilter="all"
          onStatusFilterChange={noop}
          sortBy={sortBy}
          onSortByChange={noop}
          sortDir={sortDir}
          onSortDirChange={noop}
          visibleCount={total}
          totalCount={total}
        />
        <div className="flex items-center justify-end gap-2">
          {toggle('list', '☰', 'List')}
          {toggle('grid', '▦', 'Grid')}
        </div>
      </header>
      {children}
    </div>
  );
}

// Mirrors the ProxiesView hero strip (keep in sync with `proxies-hero`); the
// tallies are derived from MARKETING_PROXIES the way the view derives its own.
function ProxiesFrame({ children }: { children: ReactNode }): JSX.Element {
  return (
    <div className="flex flex-col gap-4 p-6">
      <div
        data-component="proxies-hero"
        className="flex flex-wrap items-start gap-4 border-b border-surface-divider pb-3"
      >
        <div className="flex min-w-0 items-start gap-3">
          <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-accent/15 text-lg text-accent ring-1 ring-accent/25">
            🌍
          </span>
          <div className="min-w-0">
            <span className="section-label text-accent-text">Network egress</span>
            <h2 className="mt-0.5 text-[19px] font-semibold tracking-tight text-ink-primary">
              Egress proxies
              <span className="mono ml-2 text-base font-normal text-ink-muted">
                {MARKETING_PROXY_TALLY.total}
              </span>
            </h2>
            <p
              data-component="scene-proxies-tally"
              data-healthy={MARKETING_PROXY_TALLY.healthy}
              data-udp={MARKETING_PROXY_TALLY.udpCapable}
              className="mt-0.5 flex flex-wrap items-center gap-1.5 text-xs text-ink-secondary"
            >
              <b className="font-semibold text-status-ready">{MARKETING_PROXY_TALLY.healthy}</b>{' '}
              healthy
              <span className="text-surface-divider">·</span>
              <b className="font-semibold text-ink-primary">
                {MARKETING_PROXY_TALLY.udpCapable}
              </b>{' '}
              WebRTC + QUIC
              <span className="text-surface-divider">·</span>
              <span className="text-ink-muted">protected locally · encrypted sync at launch</span>
            </p>
          </div>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <button type="button" className="btn-secondary">
            Test all
          </button>
          <button type="button" className="btn-primary flex items-center gap-1.5">
            <span aria-hidden="true">+</span>
            <span>New proxy</span>
          </button>
        </div>
      </div>
      {children}
    </div>
  );
}

/** What the phone screen shows (S2): a DRAWN stand-in for the page a live
 *  session is looking at. EXTERNAL web content is the one thing in these
 *  scenes that must NOT be a real component — app chrome always is, a third
 *  party's page never can be — so this is deliberately an example shop.
 *
 *  ⛔ Every name here is a plain CATEGORY phrase ("Packable Rain Coat"), never
 *  a product someone sells. The first draft shipped `Harbour Parka`, which is
 *  Helly Hansen's — an invented-sounding phrase that happens to name a real
 *  SKU is exactly what this rule exists to catch, so a name added here gets
 *  SEARCHED before it ships, not judged by how invented it sounds.
 *
 *  FOUR products, prices `€NN.NN`: SIMULATOR_ALT (apps/marketing-site/src/
 *  pages/index.astro) promises a reader "four jackets with their prices in
 *  euros" and marketing-scenes.test.tsx counts them. Changing the count or the
 *  currency here silently makes the alt text — which is read ALOUD to someone
 *  who cannot see the picture — a lie. See the batch report for the one
 *  coherence argument against euros (the session's exit is Tokyo).
 *
 *  The art is a drawn silhouette over a flat CSS wash, never an image: the
 *  first draft's neutral-gray washes read as unloaded images / loading
 *  skeletons at the page's downscale — a placeholder look, on the one capture
 *  that exists to prove the phone screen is NOT broken. */
const SHOP_PAGE_PRODUCTS: ReadonlyArray<{
  name: string;
  detail: string;
  price: string;
  wash: string;
  ink: string;
}> = [
  {
    name: 'Coastal Rain Jacket',
    detail: 'Unisex · Navy',
    price: '€89.00',
    wash: 'linear-gradient(150deg,#cfe0f5,#9db9de)',
    ink: '#2f5486',
  },
  {
    name: 'Hooded Shell Jacket',
    detail: 'Unisex · Moss',
    price: '€124.00',
    wash: 'linear-gradient(150deg,#d8e6d4,#a7c2a2)',
    ink: '#3f6042',
  },
  {
    name: 'Quilted Rain Parka',
    detail: 'Unisex · Clay',
    price: '€149.00',
    wash: 'linear-gradient(150deg,#f0dfd0,#d5b295)',
    ink: '#8a5a3b',
  },
  {
    name: 'Packable Rain Coat',
    detail: 'Unisex · Ink',
    price: '€79.00',
    wash: 'linear-gradient(150deg,#dfe4ea,#9aa3b2)',
    ink: '#3a3f52',
  },
];

/** One product tile's art: a hooded jacket drawn over the tile's wash.
 *  Invented geometry — no brand mark, no logo, no person, no photograph. */
function ShopTileArt({ wash, ink }: { wash: string; ink: string }): JSX.Element {
  return (
    <div aria-hidden="true" className="relative min-h-0 flex-1" style={{ backgroundImage: wash }}>
      <svg
        viewBox="0 0 64 40"
        preserveAspectRatio="xMidYMid meet"
        className="absolute inset-0 h-full w-full p-[6%]"
      >
        {/* hood */}
        <path d="M26 10c0-5.5 12-5.5 12 0l-1.4 3h-9.2z" fill={ink} />
        {/* body + sleeves */}
        <path
          d="M26.5 10.5 21 13l-4.5 15 4.6 1.4L24 19v17h16V19l2.9 10.4 4.6-1.4L43 13l-5.5-2.5z"
          fill={ink}
        />
        {/* zip */}
        <path
          d="M32 13.5V36"
          stroke="#ffffff"
          strokeOpacity="0.5"
          strokeWidth="1.1"
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    </div>
  );
}

/** One button of the device window's drawer RAIL — a static mirror of
 *  SimulatorWindow's `DrawerRailButton` (private to that module, and it needs
 *  the live pane store). Icons are that component's own `SIM_PANE_ICONS`
 *  paths.
 *
 *  ⚠️ ONE deliberate divergence: the real rail's label is 7.5px, and this
 *  capture's own text-quality gate refuses readable text under 9px
 *  (scripts/gui-text-quality.mjs MIN_PX) — a marketing PNG must not ship text
 *  it calls illegible. The label is 9px here; everything else (h-10 w-11, the
 *  active accent state, the 18px icon, truncate under the button's aria-label)
 *  is the real button's. */
function SimRailButton({
  pane,
  label,
  title,
  active = false,
  children,
}: {
  pane: string;
  label: string;
  title: string;
  active?: boolean;
  children: ReactNode;
}): JSX.Element {
  return (
    <button
      type="button"
      data-component={`sim-rail-${pane}`}
      aria-label={title}
      aria-pressed={active}
      onClick={noop}
      className={`relative flex h-10 w-11 flex-col items-center justify-center gap-0.5 rounded-lg ${
        active ? 'bg-accent/20 text-accent-text ring-1 ring-accent/40' : 'text-ink-secondary'
      }`}
    >
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        {children}
      </svg>
      <span
        aria-hidden="true"
        // The size divergence must not also change the WORDS. MEASURED in the
        // harness at 9px: "Downloads" is 47.25px at the real `tracking-tight`
        // and 45.2px at `tracking-tighter`, against the real button's 42px cap
        // — so the cap is 47 and the tracking one step tighter, and all eight
        // labels render whole inside the 48px rail exactly as the real 7.5px
        // rail's do. ⚠️ An ellipsis here is invisible to every gate: a
        // max-width-clamped `truncate` span reports scrollWidth == clientWidth,
        // so gui-text-quality's CUT check cannot see it. Re-render and LOOK.
        className="max-w-[47px] truncate text-[9px] font-medium leading-none tracking-tighter"
      >
        {label}
      </span>
    </button>
  );
}

/** §5's picture, in one frame: the desktop app you point and click — its real
 *  window chrome around the real profiles grid — with the popped-out device
 *  window floating OVER it, bottom-right, lifted on the shadow it already had.
 *  The floating window's parts are real components wherever one exists without
 *  a live session (the app's DeviceToolbar, its on-screen iOS keyboard, the
 *  Egress card's ExitIpChip / QuicReadout / OsReadout fed the fixture
 *  capability report); the drawer's rail, status strip and Diagnostics pane are
 *  static mirrors of SimulatorWindow's, which need the live stores.
 *
 *  ⛔ ONE session, ONE story. The window drives `tokyo sneakers` — the profile
 *  whose card in the grid behind says `Live · running 12m · Open session`, the
 *  one session `1 live` and `Active sessions 1 / 3` count. It used to say
 *  `amsterdam shopper`, whose card (top-left, uncovered) says `Idle · Launch`:
 *  the shipped app cannot produce a popped-out live window for an idle profile,
 *  and both halves were visible in the same frame. The egress follows that
 *  profile: the JP exit in MARKETING_CAPABILITY_REPORT and the
 *  `Residential JP #1 · Asia/Tokyo` readouts, matching the card's
 *  `via Residential JP #1` / `Tokyo, Tokyo`. The shop page stays in euros —
 *  SIMULATOR_ALT and marketing-scenes.test.tsx pin that, and a store is not
 *  obliged to price in its visitor's currency (see SHOP_PAGE_PRODUCTS).
 *
 *  ⛔ The screen host is no longer an empty black rectangle. A capture of the
 *  product's flagship surface showing a blank screen reads as a broken app, and
 *  the live video needs a session no capture can have, so the host holds the
 *  drawn page (S2) and the keyboard stays its sibling below — the same
 *  host/keyboard stack SimulatorWindow builds. The ONE divergence: this host is
 *  `overflow-hidden` (the real one, SimulatorWindow.tsx ~9530, is not — it
 *  holds a video that is already aspect-locked, while a drawn page must be
 *  clipped to the screen rather than painted over the bezel).
 *
 *  ⛔ The app half is NOT the agent mid-task, which §5's copy would have
 *  preferred: AgentChatView's transcript is useAgentChat's own
 *  `useState<ChatTurn[]>([])` and its ONLY seeding path is `chat.restore(...)`
 *  inside the history rail's click handler — no prop, context or store key
 *  reaches it — so a fixture client cannot render one; a rail click renders the
 *  view's own "continuing starts a new session — the agent won't remember it"
 *  divider (the wrong sentence for this frame) and cannot be synchronous with
 *  the static `data-ready="1"` the capture waits on. (The view's
 *  `useConnectionStatus` probe is NOT part of the blocker: it returns without
 *  fetching when `baseUrl` is blank, so the console error a capture fails on is
 *  avoidable — the transcript is what a fixture client cannot reach.) Measured,
 *  then taken to the brief's stated fallback: the profiles grid, which is real
 *  and needs no client, no Tauri stub and no network. ⚠️ That fallback makes
 *  this picture rhyme with `profiles-grid-hero`; the orchestrator owns that
 *  call, see the batch report. */
function SimulatorScene(): JSX.Element {
  // The real window's own sizing math (SimulatorWindow.tsx RAIL_W / PANE_W):
  // the icon rail is docked beside the phone at ALL times and the pane adds
  // 252 while it is open. 300 + 48 + 252 = 600 puts the window's left edge at
  // x 656 on this stage — exactly the profile grid's third column boundary, so
  // the columns it covers are covered WHOLE. The 552px it was (no rail) landed
  // 48px inside that column and left two cards as sliced fragments.
  const phoneW = 300;
  const railW = 48;
  const paneW = 252;
  // 34 (DeviceToolbar) + 694 puts the window's top edge at y 48: 12px below the
  // app's own title bar, and ABOVE the profiles header's `⤒ Import` / `+ New
  // profile` buttons (y 60–92) instead of through them. At the old 660 the edge
  // fell at y 82 and cut both buttons' bottom 10px, amputating the descenders —
  // which reads as a rendering bug, not as one window over another.
  const bodyH = 694;
  const infoCard = 'rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2';
  // Mirrors SimulatorWindow's drawer captions (S1: text-white/50 = 4.9 on #1d1e24;
  // /40 was 3.77). A replica that lags the real drawer is what the text-quality
  // gate measures, so it must move with it.
  const infoLabel = 'text-[9.5px] uppercase tracking-[0.04em] text-white/50';
  return (
    <AppWindow
      scene="simulator"
      current="profiles"
      overlay={
        // 600×728, anchored 24px clear of the stage's bottom-right corner
        // (x 656–1256, y 48–776 of 1280×800). The stage is `overflow-hidden`,
        // so anything that outgrows that is CUT, not shipped — which is what
        // the capture script's fits / fitsY guards are there to catch.
        <div
          data-component="scene-simulator-window"
          // The real simulator-shell scopes its fixed-dark chrome to the dark
          // tokens in both themes (SimulatorWindow.tsx); the scene's window does
          // the same so the light-theme measurement is of the chrome as shipped.
          data-mode="dark"
          className="absolute bottom-6 right-6 z-20 flex flex-col overflow-hidden rounded-[16px] bg-[#1d1e24] shadow-[0_30px_80px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.12]"
          style={{ width: phoneW + railW + paneW }}
        >
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="tokyo sneakers"
            running
            keyboardVisible
            onToggleKeyboard={noop}
          />
          <div className="flex min-h-0" style={{ height: bodyH }}>
            <div className="flex flex-col" style={{ width: phoneW }}>
              <div
                data-component="simulator-screen-host"
                className="relative min-h-0 flex-1 overflow-hidden bg-black"
              >
                {/* EXTERNAL web content, so: FIXED colours, never theme tokens
                    — a web page inside a device looks the same in both themes,
                    and the text-quality gate measures it in both. */}
                <div
                  data-component="simulator-screen-page"
                  className="absolute inset-0 flex flex-col overflow-hidden bg-[#ffffff] text-[#111827]"
                >
                  <div className="flex shrink-0 items-center gap-1.5 border-b border-[#d5d8de] bg-[#eef0f3] px-2.5 py-1.5">
                    <span aria-hidden="true" className="text-[10px]">
                      🔒
                    </span>
                    <span className="text-[10px] text-[#3f4653]">shop.example.com</span>
                  </div>
                  {/* The field the on-screen keyboard below is open for. */}
                  <div className="shrink-0 px-2.5 pt-2.5">
                    <div className="flex items-center gap-1.5 rounded-[8px] border-2 border-[#1d4ed8] bg-[#ffffff] px-2 py-1">
                      <span aria-hidden="true" className="text-[11px]">
                        🔍
                      </span>
                      <span className="text-[11px] leading-[15px] text-[#111827]">rain jacket</span>
                      <span aria-hidden="true" className="h-[13px] w-px bg-[#1d4ed8]" />
                    </div>
                  </div>
                  <div className="flex shrink-0 items-baseline justify-between px-2.5 pt-2.5">
                    <span className="text-[13px] font-semibold leading-[16px] text-[#111827]">
                      Example Store
                    </span>
                    <span className="text-[10px] text-[#3f4653]">24 results</span>
                  </div>
                  <div className="grid min-h-0 flex-1 grid-cols-2 grid-rows-2 gap-2 px-2.5 pb-2.5 pt-2">
                    {SHOP_PAGE_PRODUCTS.map((item) => (
                      <div
                        key={item.name}
                        className="flex min-h-0 flex-col overflow-hidden rounded-[10px] border border-[#e1e4e9] bg-[#ffffff]"
                      >
                        <ShopTileArt wash={item.wash} ink={item.ink} />
                        <div className="shrink-0 px-2 py-1.5">
                          <div className="text-[10.5px] leading-[13px] text-[#111827]">
                            {item.name}
                          </div>
                          <div className="mt-0.5 text-[9.5px] leading-[12px] text-[#3f4653]">
                            {item.detail}
                          </div>
                          <div className="mt-1 text-[11px] font-semibold leading-[13px] text-[#111827]">
                            {item.price}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
              <IOSKeyboard room={null} width={phoneW} onDismiss={noop} />
            </div>
            {/* The drawer: the icon RAIL (always docked, SimulatorWindow.tsx
                ~9738) and the open pane beside it. The scene used to draw the
                pane with no rail — a shape the shipped app cannot produce,
                since the rail is what opens and closes that pane. The real
                aside carries the phone/rail hairline on itself; here it rides
                on the rail so the drawer is exactly railW + paneW and nothing
                inside the window overflows. */}
            <aside
              data-component="simulator-drawer"
              className="flex shrink-0 flex-row bg-[#1d1e24] text-[11.5px]"
            >
              <nav
                data-component="sim-drawer-rail"
                aria-label="Drawer sections"
                className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-white/[0.12] py-2"
              >
                <SimRailButton pane="session" label="Session" title="Session">
                  <circle cx="12" cy="12" r="3.2" />
                  <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
                </SimRailButton>
                <SimRailButton pane="controls" label="Controls" title="Controls">
                  <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h13M21 18h-1" />
                  <circle cx="16" cy="6" r="2" />
                  <circle cx="8" cy="12" r="2" />
                  <circle cx="19" cy="18" r="2" />
                </SimRailButton>
                {/* The ACTIVE one — the pane beside it is Diagnostics. An
                    inactive rail beside an open pane is another impossible
                    state. */}
                <SimRailButton pane="diagnostics" label="Health" title="Diagnostics" active>
                  <path d="M3 12h4l2-6 4 12 2-6h6" />
                </SimRailButton>
                <SimRailButton pane="cookies" label="Cookies" title="Cookies">
                  <path d="M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3-3 3 3 0 0 1-3-3 3 3 0 0 1-3-3z" />
                  <circle cx="9" cy="11" r="0.6" />
                  <circle cx="13" cy="15" r="0.6" />
                  <circle cx="16" cy="11.5" r="0.6" />
                </SimRailButton>
                <SimRailButton pane="network" label="Network" title="Network">
                  <circle cx="12" cy="12" r="9" />
                  <path d="M3 12h18M12 3v18M5 6.5c2 1.4 12 1.4 14 0M5 17.5c2-1.4 12-1.4 14 0" />
                </SimRailButton>
                <SimRailButton pane="files" label="Files" title="Files">
                  <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
                  <path d="M12 15V4M8 8l4-4 4 4" />
                </SimRailButton>
                <SimRailButton pane="downloads" label="Downloads" title="Downloads">
                  <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
                  <path d="M12 4v11M8 11l4 4 4-4" />
                </SimRailButton>
                <SimRailButton pane="recording" label="Record" title="Recording">
                  <circle cx="12" cy="12" r="9" />
                  <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
                </SimRailButton>
                {/* The always-reachable Stop, pinned to the rail's bottom under
                    its separator — the real rail draws it whenever a session is
                    bound, and this window is a bound, running session. */}
                <div aria-hidden="true" className="mx-auto mb-1 mt-auto h-px w-6 bg-white/10" />
                <button
                  type="button"
                  data-component="sim-rail-end"
                  aria-label="End session"
                  title="End the session — stops the worker and tears down the browser"
                  onClick={noop}
                  className="flex h-10 w-11 flex-col items-center justify-center gap-0.5 rounded-lg text-red-400"
                >
                  <span aria-hidden="true">◼</span>
                  <span aria-hidden="true" className="text-[9px] font-medium leading-none">
                    End
                  </span>
                </button>
              </nav>
              <div
                data-component="sim-drawer-panel"
                data-state="open"
                className="flex w-[252px] shrink-0 flex-col overflow-hidden border-l border-white/[0.12]"
              >
                <div
                  data-component="sim-drawer-status"
                  className="shrink-0 border-b border-white/[0.10] bg-black/20 px-2.5 py-2 font-mono text-[10px] leading-tight text-white/70"
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 flex-1 space-y-0.5">
                      {/* The real strip's own shape: mode · ws host · transport,
                          then fps · rtt · 🌍 proxy · timezone (SimulatorWindow.tsx
                          ~9817). It used to read `Manual · ws ✓ · webrtc` /
                          `60 fps · 38 ms · egress live` — three readouts the app
                          never renders (`egress live` exists nowhere in src, and
                          `· ws ✓` belongs to the Link card below). */}
                      {/* BOTH lines WRAP where the real strip truncates. The
                          real strip hangs no `title` on either, and a title is
                          invisible in a PNG anyway; a clipped untitled element
                          is exactly what the capture's text-quality gate fails
                          (measured: line 1 clipped 12px, line 2 ~80px). Same
                          tokens, same text, nothing hidden — the app's own
                          Transport row wraps rather than clips for this reason
                          (SimulatorWindow.tsx "Finding #4"). */}
                      <div className="break-words">
                        <span className="text-white/90">Manual</span>
                        <span className="text-white/30"> · </span>
                        <span>eu-1.fleet.example.com</span>
                        <span className="text-white/30"> · </span>
                        <span className="text-ink-secondary">udp</span>
                      </div>
                      <div className="break-words">
                        <span>60fps · </span>
                        <span className="text-ink-secondary">38ms</span>
                        <span className="text-white/60">
                          {' · 🌍 Residential JP #1'}
                          <span data-component="sim-proxy-timezone"> · Asia/Tokyo</span>
                        </span>
                      </div>
                    </div>
                    <button
                      type="button"
                      aria-label="Close drawer"
                      title="Collapse"
                      onClick={noop}
                      className="-mr-1 -mt-0.5 shrink-0 rounded px-1 text-[13px] leading-none text-white/50"
                    >
                      ✕
                    </button>
                  </div>
                </div>
                {/* The Diagnostics pane, in the real pane's own order: header,
                    the 2-up Render/Latency tiles, Transport, then the info
                    cards. The scene used to start at the info cards, which left
                    a 252×228 flat rectangle at the panel's bottom — the largest
                    dead area in the whole frame, inside the subject the capture
                    exists to show. */}
                <div
                  data-component="sim-drawer-pane"
                  className="min-w-0 flex-1 space-y-2.5 overflow-y-auto p-2.5 text-[11px] text-white/80"
                >
                  <div className="flex items-center gap-2 font-sans text-[11px] font-semibold text-white">
                    <span aria-hidden="true" className="text-accent">
                      <svg
                        width="14"
                        height="14"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <polyline points="3,13 8,13 11,5 14,19 16,13 21,13" />
                      </svg>
                    </span>
                    <span>Diagnostics</span>
                    <button
                      type="button"
                      onClick={noop}
                      className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/80"
                    >
                      <span aria-hidden="true">⧉</span>
                      Copy
                    </button>
                  </div>
                  <div className="grid grid-cols-2 gap-2">
                    <div className={infoCard}>
                      <div className={infoLabel}>Render</div>
                      <div className="mt-0.5 text-[16px] font-bold leading-none">
                        60
                        {/* The real tile's unit is text-white/45, MEASURED at
                            4.49:1 on this card (need 4.5) by
                            scripts/gui-text-quality.mjs — so it is /50 here,
                            the same bump the drawer captions took. The real
                            component still ships /45; see the batch report. */}
                        <span className="ml-0.5 text-[10px] font-medium text-white/50">fps</span>
                      </div>
                    </div>
                    <div className={infoCard}>
                      <div className={infoLabel}>Latency</div>
                      <div className="mt-0.5 text-[16px] font-bold leading-none text-ink-secondary">
                        38
                        <span className="ml-0.5 text-[10px] font-medium text-white/50">ms</span>
                      </div>
                    </div>
                  </div>
                  <div className={`${infoCard} font-mono text-[10px] leading-relaxed`}>
                    <div className={`font-sans ${infoLabel}`}>Transport</div>
                    <div className="mt-0.5 truncate text-ink-secondary">udp · direct</div>
                    <div className="mt-1 flex flex-wrap gap-x-2 text-white/70">
                      <span>decode 60 fps</span>
                      <span>loss 0%</span>
                      <span>jitter 8ms</span>
                      <span>freezes 0</span>
                      <span>frames 60 dec / 60 shown / 0 dropped</span>
                    </div>
                  </div>
                  <div className={infoCard}>
                    <div className={infoLabel}>Profile</div>
                    <div className="mt-0.5 truncate">tokyo sneakers</div>
                  </div>
                  <div className={infoCard}>
                    <div className={infoLabel}>Device</div>
                    <div className="mt-0.5 truncate">iPhone 17</div>
                  </div>
                  <div className={infoCard}>
                    {/* The fleet node that RUNS the device — deliberately not the
                        exit's region: the Mac hosting the session and the proxy
                        it egresses through are independent by design, which is
                        why the drawer labels them Link and Egress separately. */}
                    <div className={infoLabel}>Link</div>
                    <div className="mt-0.5 truncate">
                      eu-1.fleet.example.com<span className="text-white/50"> · ws ✓</span>
                    </div>
                  </div>
                  <div className={infoCard}>
                    <div className={infoLabel}>Egress</div>
                    <div className="mt-0.5 truncate" title="🌍 Residential JP #1 · Asia/Tokyo">
                      🌍 Residential JP #1
                      <span data-component="sim-proxy-timezone"> · Asia/Tokyo</span>
                    </div>
                    <ExitIpChip report={MARKETING_CAPABILITY_REPORT} />
                    <QuicReadout report={MARKETING_CAPABILITY_REPORT} />
                    <OsReadout report={MARKETING_CAPABILITY_REPORT} />
                  </div>
                  <div className={`${infoCard} font-mono text-[10px] leading-relaxed`}>
                    <div className={`font-sans ${infoLabel}`}>Identity</div>
                    <div className="mt-0.5 truncate">engine-deep · bit-exact device</div>
                    {/* The real card's 4th line is `build {__BUILD_STAMP__}`.
                        Omitted: in the harness that define is absent, so it
                        renders `build dev` — and any value I typed instead
                        would be a build stamp nobody built. */}
                    <div className="truncate">input human-cadence native</div>
                  </div>
                </div>
              </div>
            </aside>
          </div>
        </div>
      }
    >
      <ProfilesFrame viewMode="grid" liveCount={1} total={MARKETING_CARDS.length}>
        <div data-scene-region="grid" className={PROFILES_GRID_CLASS_MIRROR}>
          {MARKETING_CARDS.map((c) => (
            <ProfilePhoneCard key={c.label} {...c.props} />
          ))}
        </div>
      </ProfilesFrame>
    </AppWindow>
  );
}

// Mirrors the Command Center header band (T-18); the KPI strip is the real Kpi.
function CommandCenterScene(): JSX.Element {
  return (
    <AppWindow scene="command-center" current="home">
      <div className="flex flex-col gap-4 p-6">
        <section className="flex flex-col gap-3 rounded-xl border border-surface-divider bg-surface-raised p-5">
          <div className="flex flex-col gap-1">
            <span className="section-label text-accent-text">Good morning</span>
            <h1 className="text-xl font-semibold tracking-tight text-ink-primary">
              What do you want to automate?
            </h1>
            <p className="text-sm text-ink-secondary">
              {`${String(FIXTURE_ACCOUNT.concurrent_session_active)} session running · ${String(FIXTURE_ACCOUNT.profile_count)} profiles · ${String(MARKETING_PROXY_TALLY.healthy)} proxies healthy`}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary gap-2">
              ✦ Ask Driftstack AI
            </button>
            <button type="button" className="btn-secondary gap-2">
              ▤ Saved tasks
            </button>
          </div>
        </section>
        <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Kpi
            icon={<span>▦</span>}
            label="Profiles"
            value={`${String(FIXTURE_ACCOUNT.profile_count)} / ${String(FIXTURE_ACCOUNT.profile_cap)}`}
          />
          <Kpi
            icon={<span>⚡</span>}
            label="Active"
            value={String(FIXTURE_ACCOUNT.concurrent_session_active)}
            accent
          />
          <Kpi icon={<span>🌍</span>} label="Proxies" value={String(MARKETING_PROXY_TALLY.total)} />
          <Kpi
            icon={<span>✦</span>}
            label="Plan"
            value="Team"
            valueNode={<TierBadge tier="team_manual" size="md" />}
          />
        </section>
      </div>
    </AppWindow>
  );
}

export function MarketingScene({ name }: { name: MarketingSceneName }): JSX.Element {
  switch (name) {
    case 'profiles-grid':
      return (
        <AppWindow scene={name} current="profiles">
          <ProfilesFrame viewMode="grid" liveCount={1} total={MARKETING_CARDS.length}>
            <div data-scene-region="grid" className={PROFILES_GRID_CLASS_MIRROR}>
              {MARKETING_CARDS.map((c) => (
                <ProfilePhoneCard key={c.label} {...c.props} />
              ))}
            </div>
          </ProfilesFrame>
        </AppWindow>
      );
    case 'profiles-list':
      return (
        <AppWindow scene={name} current="profiles">
          <ProfilesFrame
            viewMode="list"
            liveCount={1}
            total={MARKETING_TABLE_ROWS.length}
            sortBy="name"
            sortDir="asc"
          >
            <div data-scene-region="list">
              <ProfilesTable
                rows={MARKETING_TABLE_ROWS}
                sortKey="name"
                sortDir="asc"
                onSort={noop}
                allSelected={false}
                onToggleSelectAll={noop}
                onToggleSelect={noop}
                onPrimary={noop}
                onWatch={noop}
                onStop={noop}
                onTest={noop}
                onEdit={noop}
                onClone={noop}
                onTrim={noop}
                onDelete={noop}
                onSaveNote={noop}
              />
            </div>
          </ProfilesFrame>
        </AppWindow>
      );
    case 'proxies':
      return (
        <AppWindow scene={name} current="proxies">
          <ProxiesFrame>
            <div data-scene-region="proxy-forms" className="grid grid-cols-3 gap-4">
              {MARKETING_PROXIES.map((p) => (
                <ProxyForm
                  key={p.label}
                  mode="edit"
                  initial={p.draft}
                  onCancel={noop}
                  onSave={noop}
                />
              ))}
            </div>
          </ProxiesFrame>
        </AppWindow>
      );
    case 'simulator':
      return <SimulatorScene />;
    case 'billing':
      return (
        <AppWindow scene={name} current="billing">
          <div className="p-6">
            <BillingWrapperShell>
              <CostPanel
                breakdown={{
                  computeCents: 1840,
                  storageCents: 120,
                  egressCents: 640,
                  emailCents: 15,
                  llmCents: 2310,
                  totalCents: 4925,
                  thresholdState: 'between-soft-and-hard',
                }}
                billingCycle="2026-06"
              />
            </BillingWrapperShell>
          </div>
        </AppWindow>
      );
    case 'command-center':
      return <CommandCenterScene />;
  }
}
