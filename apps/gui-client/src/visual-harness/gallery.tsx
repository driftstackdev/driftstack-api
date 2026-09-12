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
  'audit-logs',
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
 *  report; this is a fully-observed one (exit + HTTP/3 + OS), TEST-NET exit. */
export const MARKETING_CAPABILITY_REPORT: AgentSessionCapabilityReport = {
  manual_input_available: true,
  streaming_state: 'live',
  egress_state: 'live',
  h3_connection_observed: true,
  h3_connection_count: 4,
  exit_ip: TEST_NET.nl,
  exit_country: 'NL',
  exit_timezone: 'Europe/Amsterdam',
  webrtc_candidate_ips: [TEST_NET.nl],
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
 *  Audit scenes (audit-scenes.tsx) pass `settingsOverrides` (a fixture SDK
 *  client, an example.com base URL) and the matching title-bar `subtitle`; the
 *  marketing scenes pass neither, so their output is byte-for-byte what it was
 *  (scripts/marketing-screens.mjs --verify pins that). */
export function AppWindow({
  scene,
  current,
  children,
  settingsOverrides,
  subtitle = 'cloud',
}: {
  scene: SceneName;
  current: SidebarViewKind;
  children: ReactNode;
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

/** The simulator is its own borderless window: the real DeviceToolbar over the
 *  phone's screen host, the real on-screen iOS keyboard, and the docked pane
 *  with the Egress card's real readouts (ExitIpChip / QuicReadout / OsReadout)
 *  fed a fixture report. The live video needs a session, so the screen host is
 *  the app's own black host with nothing attached. */
function SimulatorScene(): JSX.Element {
  const phoneW = 300;
  const simSize = sceneSize('simulator');
  const infoCard = 'rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2';
  // Mirrors SimulatorWindow's drawer captions (S1: text-white/50 = 4.9 on #1d1e24;
  // /40 was 3.77). A replica that lags the real drawer is what the text-quality
  // gate measures, so it must move with it.
  const infoLabel = 'text-[9.5px] uppercase tracking-[0.04em] text-white/50';
  return (
    <div
      data-scene="simulator"
      data-ready="1"
      data-frozen-now={FROZEN_NOW_ISO}
      data-stage-width={simSize.width}
      data-stage-height={simSize.height}
      style={{ width: simSize.width, height: simSize.height }}
      className="relative flex shrink-0 items-center justify-center overflow-hidden bg-surface-base font-sans text-ink-primary antialiased"
    >
      <div
        data-component="scene-simulator-window"
        // The real simulator-shell scopes its fixed-dark chrome to the dark
        // tokens in both themes (SimulatorWindow.tsx); the scene's window does
        // the same so the light-theme measurement is of the chrome as shipped.
        data-mode="dark"
        className="flex flex-col overflow-hidden rounded-[16px] bg-[#1d1e24] shadow-[0_30px_80px_rgba(0,0,0,0.55)] ring-1 ring-white/[0.12]"
        style={{ width: phoneW + 252 }}
      >
        <DeviceToolbar
          deviceName="iPhone 17"
          profileName="amsterdam shopper"
          running
          keyboardVisible
          onToggleKeyboard={noop}
        />
        <div className="flex min-h-0" style={{ height: 660 }}>
          <div className="flex flex-col" style={{ width: phoneW }}>
            <div
              data-component="simulator-screen-host"
              className="relative min-h-0 flex-1 bg-black"
            />
            <IOSKeyboard room={null} width={phoneW} onDismiss={noop} />
          </div>
          <div
            data-component="sim-drawer-panel"
            data-state="open"
            className="flex w-[252px] shrink-0 flex-col overflow-hidden border-l border-white/[0.12]"
          >
            <div
              data-component="sim-drawer-status"
              className="shrink-0 border-b border-white/[0.10] bg-black/20 px-2.5 py-2 font-mono text-[10px] leading-tight text-white/70"
            >
              <div className="truncate">
                <span className="text-white/90">Manual</span> · ws ✓ · webrtc
              </div>
              <div className="truncate">60 fps · 38 ms · egress live</div>
            </div>
            <div className="flex flex-col gap-2 p-2.5 text-[11px] text-white/80">
              <div className={infoCard}>
                <div className={infoLabel}>Profile</div>
                <div className="mt-0.5 truncate">amsterdam shopper</div>
              </div>
              <div className={infoCard}>
                <div className={infoLabel}>Device</div>
                <div className="mt-0.5 truncate">iPhone 17</div>
              </div>
              <div className={infoCard}>
                <div className={infoLabel}>Link</div>
                <div className="mt-0.5 truncate">
                  eu-1.fleet.example.com<span className="text-white/50"> · ws ✓</span>
                </div>
              </div>
              <div className={infoCard}>
                <div className={infoLabel}>Egress</div>
                <div className="mt-0.5 truncate" title="🌍 Residential NL #3 · Europe/Amsterdam">
                  🌍 Residential NL #3
                  <span data-component="sim-proxy-timezone"> · Europe/Amsterdam</span>
                </div>
                <ExitIpChip report={MARKETING_CAPABILITY_REPORT} />
                <QuicReadout report={MARKETING_CAPABILITY_REPORT} />
                <OsReadout report={MARKETING_CAPABILITY_REPORT} />
              </div>
              <div className={`${infoCard} font-mono text-[10px] leading-relaxed`}>
                <div className={`font-sans ${infoLabel}`}>Identity</div>
                <div className="mt-0.5 truncate">engine-deep · bit-exact device</div>
                <div className="truncate">input human-cadence native</div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
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
