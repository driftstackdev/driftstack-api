// Visual-check harness (2026-06-15) — renders the real ProfilePhoneCard across
// its meaningful states so an automated screenshot pass (repo-root
// scripts/gui-visual-check.mjs → Playwright → PNG) can review the actual rendered
// UI, not a mockup. NOT part
// of the shipped app: nothing imports this except visual-harness.html, which is
// not a build input (vite/Tauri bundle index.html only). Add new states here as
// the card grows so the visual review stays representative.

import { useMemo, type ContextType, type JSX, type ReactNode } from 'react';
import type { AccountSelfProfile } from '@driftstack/sdk';
import {
  ProfilePhoneCard,
  capabilityChips,
  type ProfilePhoneCardProps,
} from '../components/ProfilePhoneCard';
import { ProfilesTable, type ProfileTableRow } from '../components/ProfilesTable';
import { CostPanel } from '../components/CostPanel';
import { SkeletonRows } from '../components/Skeleton';
import { ProxyForm, UDP_AND_QUIC_TALLY_LABEL } from '../views/ProxiesView';
import { DeviceToolbar, SIM_PANE_RAIL_LABELS, SIM_PANE_TITLES } from '../views/SimulatorWindow';
import {
  IconChat,
  IconCookie,
  IconDownload,
  IconGlobe,
  IconRecordDot,
  IconSignal,
  IconSliders,
  IconUpload,
} from '../views/agent-chat/icons';
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
import { UdpReadout } from '../components/UdpReadout';
import { OsReadout } from '../components/OsReadout';
import { IOSKeyboard } from '../components/IOSKeyboard';
import { SettingsContext } from '../lib/SettingsContext';
import { RecordingsProvider } from '../lib/recordings';
import { DEFAULT_SETTINGS, type DriftstackSettings } from '../lib/settings';
import type { ProxyDraft } from '../lib/proxies';
import type { ConnectionStatus } from '../lib/use-connection-status';
import type { AgentSessionCapabilityReport } from '../lib/agent-session-control';
import { isFingerprintConfidence, isFingerprintedOs } from '../lib/os-fingerprint-verdict';
// Audit scenes (2026-09-12) — one composition per view the marketing scenes do
// not cover, for scripts/gui-text-quality.mjs. ⚠️ CYCLE: audit-scenes.tsx
// imports AppWindow / the fixtures from THIS module; it therefore touches no
// gallery export at its own top level, and this module touches AuditScene /
// auditSceneSizes only inside functions (Gallery, sceneSize) — whichever of
// the two a test imports first, both finish evaluating before either binding
// is read. The NAMES live here so `ALL_SCENES` is a plain top-level constant.
import { AiRunningMarketingScene, AuditScene, auditSceneSizes } from './audit-scenes';

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
  // "Bringing The Stage everywhere" §4/§7 — the AI view mid-task (a plan
  // running, the phone lit, the steps beside it), captured through the same
  // seam spec §8 built for the audit-agent-chat-* scenes (AiRunningMarketingScene,
  // audit-scenes.tsx): a stand-in image, no live model call, no network,
  // *.example.com / RFC 5737 fixtures, the module's frozen clock.
  'ai-running',
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
  // The first-run screen as a customer lands on it after the server refused
  // the app's key (revoked, or not recognised): the wizard under the notice
  // that says why they were signed out.
  'audit-signed-out',
  'audit-recipes',
  // The AI view in each state a customer can be in. It is the ONE view whose
  // states cannot be reached from fixture data alone — a plan running, an
  // approval waiting, a stop in flight all need a live session and a device on
  // the other end of a stream — so it is also the one view the gates had only
  // ever measured EMPTY. The seven below drive the REAL view through the seams
  // in agent-chat-scenes.tsx (spec §8); the first thing they found was a status
  // pill at 2.47:1 that had shipped for months.
  'audit-agent-chat',
  'audit-agent-chat-nokey',
  // ⛔ THE DEPLOYMENT THAT PLANS BUT DOES NOT ACT. `preview` is a real product
  // state — the view derives it from the server's own `/version` answer and
  // stamps `data-ai-preview` — and for three stages it was the one state with
  // CSS written for it, a second branch of customer copy behind it, and NO
  // scene: the unlit-glass rule and IdleHero's preview explainer had never been
  // rendered by a gate, in either theme. Round C found it when a vendor-name
  // negative control injected into that explainer stayed green because nothing
  // reached the line.
  'audit-agent-chat-preview',
  'audit-agent-chat-planning',
  'audit-agent-chat-running',
  'audit-agent-chat-approval',
  'audit-agent-chat-done',
  'audit-agent-chat-trouble',
  'audit-agent-chat-stopping',
  // Not an eighth STATE — the running state at the 960x600 Tauri minimum, so
  // the narrow tier the redesign invented is measured by the gate instead of
  // hand-checked once. Its stage size is declared in `auditDefaultSizes`.
  'audit-agent-chat-small',
  // Also a window rather than a state, and the only scene whose SCREEN is the
  // real AgentSessionPanel rather than a drawn page: the session has ended, so
  // the panel shows its own terminal overlay, in the ~205px box stage 4 gave it
  // (spec §9 stage 7). Its stage is 960x600 for that reason — at 1280x800 the
  // screen is wide enough that the compact layout never comes up.
  'audit-agent-chat-ended',
  // ⛔ THE TWO BRANCHES THAT MAY NAME A MODEL VENDOR (copy spec D5: the
  // customer is being told whose key to go and buy). They exist so the privacy
  // scan's vendor ban is an ALLOWLIST BY CONSTRUCTION rather than a ban that
  // happens to be green because nothing renders the sanctioned sentences —
  // marketing-scenes.test.tsx now requires each approved sentence to be reached
  // by the scene that is allowed to say it.
  'audit-agent-chat-consent',
  'audit-agent-chat-budget',
  'audit-team',
  'audit-proxies',
  // The simulator window's own device/room/state-light restyle ("Bringing The
  // Stage everywhere" stage 1, design brief §2, §5 stage 1) — the REAL
  // `<SimulatorWindow>`, not the hand-built `?scene=simulator` mirror below,
  // driven through the query + `standIn` seam SimulatorWindow.tsx itself
  // defines (simulator-scenes.tsx). Four of the five states a customer's
  // popped-out device can be in — connecting, live & healthy,
  // degraded/reconnecting, ended — reached with no live network call, the same
  // discipline as the AI view's own `audit-agent-chat-*` scenes.
  'audit-simulator-connecting',
  'audit-simulator-live',
  'audit-simulator-degraded',
  'audit-simulator-ended',
  // Round-2 stage B (design brief §2, the owner's "Love it!" on the mockup)
  // — the drawer's real Agent/Pair conversation panel, driven through the
  // SAME `<SimulatorWindow>` seam as the four above, plus the mission-axis
  // fixture seam simulator-scenes.tsx adds (`agentChatOverride`/
  // `settingsOverride`). Named for the mockup's own `?state=` values.
  'audit-simulator-agent-running',
  'audit-simulator-agent-approval',
  'audit-simulator-agent-done',
  'audit-simulator-pair',
  // A window, not a state (like `audit-agent-chat-small`): the agent driving,
  // the Session pane open, at the Simulator's MINIMUM window — where the phone
  // is narrowest and the agent-driving pill and the rail labels ran out of room
  // (gui-v0.1.72: "…switch to Manual to take cont", "Downlo…").
  'audit-simulator-agent-small',
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
    // (V-219) The exit's own measurement time, and the harness's `nowMs` beside
    // it. Both FIXED: the sheet states the age of the address, so a fixture dated
    // against the wall clock would make every card capture change by the minute.
    // Twelve minutes before the frozen instant — a realistic fresh reading, which
    // is the state the undated fallback would otherwise hide from every capture.
    exitSeenAtMs: Date.parse('2026-06-15T06:30:00.000Z'),
    nowMs: Date.parse(FROZEN_NOW_ISO),
    locationLabel: 'Amsterdam, North Holland',
    latencyMs: 42,
    latencyFillPct: 28,
    latencyGood: true,
    probed: true,
    capabilities: {
      reachable: true,
      auth_ok: true,
      udp_associate: true,
      udp_relay: 'relays',
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
    // ⛔ THE STATE THE GEOMETRY GATE COULD NOT SEE. The chip row's narrow-column
    // cut was wrong for the single most ordinary healthy proxy — UDP relay
    // verified, QUIC MEASURED (not inferred), and an OS fingerprint that
    // matches — which at 178px rendered 'UDP ✓ QUIC ✓ +1' with the measured OS
    // chip inside the pill. Every other fixture carries the INFERRED 'QUIC ~',
    // which is 2px narrower and fit, so 87 browser measurements said nothing
    // about the one combination that was broken. A gate is blind to a state no
    // fixture produces, and the arithmetic it polices is per-state.
    label: 'idle · fully measured: UDP ok + QUIC measured + OS match (the narrow-column trio)',
    props: base({
      name: 'tokyo sneakers',
      quicMeasured: 'h3',
      osFingerprint: {
        os: 'macos-or-ios',
        confidence: 'high',
        reason: 'network signature matches an Apple device',
      },
    }),
  },
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
      osFingerprint: {
        os: 'macos-or-ios',
        confidence: 'high',
        reason: 'network signature matches an Apple device',
      },
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
  {
    // Proxy-accuracy audit G2 — the card's own "fails from Driftstack" pill: this
    // Mac's check says healthy (its UDP relays), Driftstack's says the proxy does
    // not work. The pill outranks the local verdict and carries the sentence.
    label: 'failed · socks5 · fails from Driftstack (healthy from this Mac)',
    props: base({
      name: 'porto marketplace',
      monogram: 'PM',
      hue: 20,
      vpnFailure: 'The proxy did not answer. Check the host and port, and that it is online.',
      onEdit: noop,
    }),
  },
  { label: 'healthy · testing', props: base({ testing: true }) },
  {
    label: 'vpn · idle (latency from Driftstack)',
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
        'The tunnel could not be brought up: handshake timed out after 20 s (no reply from 193.32.127.66:51820).',
      vpnNotice:
        'Tunnel test not run this time — a live session holds the tunnel. Showing the last result.',
      folder: 'Marketplaces',
      tags: ['classifieds', 'norway', 'aged', 'warm'],
      onEdit: noop,
    }),
  },
  {
    label: 'vpn · no result yet',
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
    label: 'socks5 · latency from the server',
    props: base({
      latencyFromServer: true,
      latencyVantage: { measuredFrom: 'control_plane' },
      // (V-219) Dated an hour before the card's Checked stamp, because that gap
      // is the state this row exists to show: a native re-check carries the
      // server number and re-stamps the date beside it, so the sheet states the
      // measurement's own date. A fixture with the two dates equal would render
      // nothing and the harness would never show the line at all.
      serverMeasuredAtMs: Date.parse('2026-06-15T05:30:00.000Z'),
    }),
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
      osFingerprint: {
        os: 'macos-or-ios',
        confidence: 'high',
        reason: 'network signature matches an Apple device',
      },
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
        'The tunnel could not be brought up: handshake timed out after 20 s (no reply from 193.32.127.66:51820).',
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
        {/* ⛔ THE CONNECTING STATE HAD NO SCENE AT ALL, which is how a bar that
            says one word for twelve different problems survived review: the state
            was never rendered where anyone looks. Added when that word was
            replaced by the specific blocker — and the replacement is the reason
            the SECOND tile below exists rather than just the first.

            The label went from "Connecting…" (11 characters) to as many as 26,
            in a 34px bar whose only truncating element is the device name. ⚠️
            NEITHER automated gate can see that: the text-quality gate flags an
            element only when it clips WITH AN ELLIPSIS AND lacks a title, and
            this pill carries a title and no truncate class, so an over-long
            label overflows rather than ellipses and is invisible on both counts.
            The geometry gate measures profile cards, not this bar. So the tile is
            here to be LOOKED AT, which is what the release runbook asks for and
            what a green gate would not have given. */}
        {/* ⚠️ 402px, not the w-72 the tiles above use: that is
            DEVICE_LOGICAL_WIDTH, the real width this bar has in the app. The
            release runbook asks for the REAL width, and the first pass of this
            check was done at 288px — 30% narrower than anything a customer sees —
            which makes every label look worse than it is and would have bought a
            fix for a width that does not exist. */}
        <div className="w-[402px]">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">
            connecting — typical (real 402px width)
          </span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running={false}
            connecting
            connectingLabel="waiting for the screen…"
            connectingTitle="Connected — waiting for the phone’s screen to arrive."
            keyboardVisible={false}
            onToggleKeyboard={noop}
          />
        </div>
        <div className="w-[402px]">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">
            connecting — longest label (real 402px width)
          </span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running={false}
            connecting
            connectingLabel="finishing the last change…"
            connectingTitle="Finishing the last change to this session — one moment."
            keyboardVisible={false}
            onToggleKeyboard={noop}
          />
        </div>
        {/* ⛔ 280px is SIM_MIN_WIDTH — the narrowest a customer can drag this
            window, not a hypothetical. The first pass of this check happened to
            be at 288px and showed the profile name crushed to the single letter
            "a" with the device name gone; I nearly dismissed that as an artifact
            of testing too narrow, and it is not. It is one pixel-width away from
            a state the app actually permits.

            So this tile stays as the adjacent state the release runbook asks you
            to try on purpose: the longest label at the smallest window. What it
            must show is graceful degradation — an ellipsis rather than a hard
            cut, and enough of the profile name to tell two windows apart. */}
        <div className="w-[280px]">
          <span className="mb-1 block text-2xs uppercase tracking-wide text-ink-muted">
            connecting — longest label at SIM_MIN_WIDTH (280px)
          </span>
          <DeviceToolbar
            deviceName="iPhone 17"
            profileName="amsterdam shopper"
            running={false}
            connecting
            connectingLabel="finishing the last change…"
            connectingTitle="Finishing the last change to this session — one moment."
            keyboardVisible={false}
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
        Command Center — Plan KPI
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
            className="rounded border border-surface-divider bg-surface-inset px-2 py-1 text-sm text-ink-primary"
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

/** The fixture's theme mode is the one the committed marketing captures are
 *  taken in (scripts/marketing-screens.mjs `CAPTURE_MODE`): the title-bar
 *  toggle draws its icon from it. Named here rather than inherited from
 *  DEFAULT_SETTINGS, whose mode is a NEW install's — a later change to that
 *  default must not change the captures. LIGHT since 2026-09-25, when the
 *  captures were retaken in the app's white theme (they were dark until
 *  then). Change the two together (marketing-scenes.test.tsx holds them
 *  equal). The render gates set data-mode themselves and are unaffected. */
export const FIXTURE_SETTINGS: DriftstackSettings = {
  ...DEFAULT_SETTINGS,
  themeMode: 'light',
  apiKey: 'ds_live_example',
  baseUrl: 'https://driftstack.io',
};

const noopAsync = (): Promise<void> => Promise.resolve();

function stateProps(label: string): ProfilePhoneCardProps {
  const found = STATES.find((s) => s.label === label);
  if (found === undefined) throw new Error(`marketing scene: gallery state missing: ${label}`);
  return found.props;
}

/** The simulator cockpit's Egress readouts read the session's capability
 *  report; this is a fully-observed one (exit + HTTP/3 + OS), TEST-NET exit.
 *  ⛔ It is the SIMULATOR SCENE's session, so it must agree with that scene's
 *  profile — `tokyo sneakers`, whose grid card is the one card marked `Live`
 *  and reads `via Residential JP #1` / `Tokyo, Tokyo`. The WebRTC candidate
 *  tracks the exit deliberately: equal means no leak, and `sim-webrtc-candidates
 *  [data-leak="false"]` is a capture guard. Consumed by SimulatorScene and, for
 *  that live card's own readings, by MARKETING_CARDS (`liveSessionReadings`,
 *  below) — so the grid, its hero crop and the list show the session the
 *  window shows; no other scene reads it (grep: this file). Declared ABOVE
 *  MARKETING_CARDS for that reason: a module-level const is not readable
 *  before its declaration. */
export const MARKETING_CAPABILITY_REPORT: AgentSessionCapabilityReport = {
  manual_input_available: true,
  streaming_state: 'live',
  egress_state: 'live',
  h3_connection_observed: true,
  h3_connection_count: 4,
  // A session that reached sites over HTTP/3 relays UDP: say so, as the card does.
  proxy_udp_supported: true,
  exit_ip: TEST_NET.jp,
  exit_country: 'JP',
  exit_timezone: 'Asia/Tokyo',
  webrtc_candidate_ips: [TEST_NET.jp],
  observed_at: '2026-06-15T06:41:30.000Z',
  // ⛔ (V-219) DATED, and dated FIXED. The readout labels a reading past its
  // freshness window (`? Linux · high confidence · 3 mo ago`), so an undated fixture would
  // exercise only the legacy shape, and a fixture dated relative to the wall
  // clock would make this capture change every day. Stamped just before the
  // report's own `observed_at`, and the scene passes that same instant as `nowMs`
  // — a fresh reading, rendered exactly as it is today, deterministically.
  // ⛔ 'linux', the WIRE value — it was 'Linux', which no control plane sends and
  // `isFingerprintedOs` rightly refuses, so since 2026-09-24 this capture printed
  // "OS: unknown · high" about a reading the fixture names. In the one vocabulary
  // (gui-v0.1.72) the line reads "? Linux · high confidence": the reading, named,
  // and withheld as every surface withholds a reading with no vantage flag.
  os_fingerprint: { os: 'linux', confidence: 'high', at: '2026-06-15T06:40:00.000Z' },
  proxy_kind: 'socks5',
};

/** The instant the simulator scene is captured AT. Fixed, because a relative-age
 *  label rendered against the wall clock would change the capture every day. */
export const MARKETING_CAPTURED_AT_MS = Date.parse('2026-06-15T06:41:30.000Z');

/**
 * gui-v0.1.73 review — the live card's readings ARE its session's. The
 * simulator scene's window drives `tokyo sneakers` and renders
 * MARKETING_CAPABILITY_REPORT ("✓ UDP", "✓ QUIC · HTTP/3 live", "? Linux ·
 * high confidence"), while the same profile's card, in the grid right behind
 * it, read "✓ UDP  ~ QUIC  — OS": one session, measured and unmeasured in one
 * public picture. The card now takes them from that report — the HTTP/3 the
 * session observed is the card's measured QUIC (`quicMeasured`), and the OS
 * reading the window names is the card's — so the two cannot drift apart
 * again (marketing-scenes.test.tsx compares the two badges for badge).
 */
function liveSessionReadings(
  report: AgentSessionCapabilityReport,
): Pick<ProfilePhoneCardProps, 'osFingerprint' | 'quicMeasured'> {
  const fp = report.os_fingerprint;
  if (fp === undefined || !isFingerprintedOs(fp.os) || !isFingerprintConfidence(fp.confidence)) {
    throw new Error('marketing scene: the live session reports no OS reading a card can draw');
  }
  return {
    ...(report.h3_connection_observed === true ? { quicMeasured: 'h3' as const } : {}),
    osFingerprint: {
      os: fp.os,
      confidence: fp.confidence,
      reason: '',
      ...(fp.at !== undefined ? { at: Date.parse(fp.at) } : {}),
      ...(fp.observed_via !== undefined ? { observedVia: fp.observed_via } : {}),
      ...(fp.single_host_vantage === true ? { singleHostVantage: true } : {}),
      ...(fp.web_port_vantage === true ? { webPortVantage: true } : {}),
    },
  };
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
      ...liveSessionReadings(MARKETING_CAPABILITY_REPORT),
    },
  },
  {
    label: 'vpn · idle (latency from Driftstack)',
    props: {
      ...stateProps('vpn · idle (latency from Driftstack)'),
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
const MARKETING_TABLE_ROWS_BASE: ReadonlyArray<ProfileTableRow> = [
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

/** Owner item 9 (2026-09-24) — the list's Network cell draws the grid card's own
 *  QUIC chip and OS reading, so the list scene takes them FROM the grid scene's
 *  card of the same name (`capabilityChips`, the card's builder) rather than
 *  typing a second copy that could disagree with the capture beside it. */
function withCardNetwork(row: ProfileTableRow): ProfileTableRow {
  const card = MARKETING_CARDS.find((c) => c.props.name === row.name)?.props;
  if (card === undefined) return row;
  const chips = capabilityChips(card).eligible;
  const quic = chips.find((c) => c.key === 'quic');
  // The card's UDP chip decides the row's UDP state too: the zurich tunnel's row
  // was typed `udp: 'ok'` while its card, from the same scene, reads "⇢ UDP".
  const udpAttr = chips.find((c) => c.key === 'udp')?.attrs['data-udp'];
  const udp: ProfileTableRow['udp'] | undefined =
    udpAttr === 'true'
      ? 'ok'
      : udpAttr === 'false'
        ? 'fail'
        : udpAttr === 'tunnel'
          ? 'unknown'
          : undefined;
  return {
    ...row,
    ...(udp !== undefined ? { udp } : {}),
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
    ...(card.osFingerprint !== undefined ? { osFingerprint: card.osFingerprint } : {}),
  };
}
export const MARKETING_TABLE_ROWS: ReadonlyArray<ProfileTableRow> =
  MARKETING_TABLE_ROWS_BASE.map(withCardNetwork);

/** What the fleet knows about a proxy in the scene, in the terms ProxiesView
 *  tallies its header from: `isRowHealthy` counts a SOCKS5 row with a passing
 *  test and a VPN row the fleet brought up; the "UDP + QUIC" tally counts the
 *  rows whose own chips read ✓ UDP AND ✓ QUIC (`rowShowsUdpAndQuic`, owner item
 *  9, 2026-09-24 — it was "WebRTC + QUIC" over the UDP grant alone). The header
 *  numbers are DERIVED from these, never typed. */
export type MarketingProxyVerdict =
  | 'socks5_ok_udp_quic'
  | 'socks5_ok_udp'
  | 'socks5_ok'
  | 'vpn_up'
  | 'untested';
export function proxyTally(list: ReadonlyArray<{ verdict: MarketingProxyVerdict }>): {
  total: number;
  healthy: number;
  udpCapable: number;
} {
  return {
    total: list.length,
    healthy: list.filter((p) => p.verdict !== 'untested').length,
    udpCapable: list.filter((p) => p.verdict === 'socks5_ok_udp_quic').length,
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
    // UDP relayed, QUIC NOT measured — the same proxy's card in the grid scene
    // ('idle · UDP ok', Residential NL #3) reads 'UDP ✓' beside 'QUIC ~', so it
    // is not a "UDP + QUIC" row and the header counts 0 (owner item 9: the tally
    // counts what it says; it read "1 WebRTC + QUIC" over an inferred QUIC).
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
            <span className="section-label text-accent-text">Proxies &amp; VPNs</span>
            <h2 className="mt-0.5 text-[19px] font-semibold tracking-tight text-ink-primary">
              Proxies
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
              {UDP_AND_QUIC_TALLY_LABEL}
              <span className="text-surface-divider">·</span>
              <span className="text-ink-muted">
                protected on this device · synced encrypted when a session starts
              </span>
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
 *  ⛔ THE WORDS ARE THE APP'S OWN, READ FROM IT: the label under the icon is
 *  `SIM_PANE_RAIL_LABELS[pane]` and the button's name `SIM_PANE_TITLES[pane]`.
 *  This mirror used to carry its own literals, and when the app's rail label
 *  "Downloads" (which read "Downlo…" in every window) became "Saved", the
 *  committed simulator.png kept saying "Downloads" (gui-v0.1.72 review);
 *  marketing-scenes.test.tsx now pins every label against the app's map.
 *  The label's chrome is the real one's too (9px, max 42px, tracking-tight):
 *  the 7.5px → 9px divergence this mirror once carried ended when the real rail
 *  moved to the 9px floor. */
function SimRailButton({
  pane,
  active = false,
  icon,
}: {
  pane: keyof typeof SIM_PANE_RAIL_LABELS;
  active?: boolean;
  icon: ReactNode;
}): JSX.Element {
  const label = SIM_PANE_RAIL_LABELS[pane];
  const title = SIM_PANE_TITLES[pane];
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
      {/* Round 2: the real rail's icons (index.css/SimulatorWindow.tsx) moved
          to the AI view's 16-unit/`.ai-i` vocabulary — mirrored here (NOTES.md
          §3: "any bezel or drawer markup change here must land in the mirror
          in the same commit"). `.ai-i` is `width/height:1em`, so this 18px
          span reproduces the old `<svg width="18" height="18">`'s optical size. */}
      <span className="text-[18px] leading-none" aria-hidden="true">
        {icon}
      </span>
      <span
        data-component={`sim-rail-label-${pane}`}
        aria-hidden="true"
        className="max-w-[42px] truncate text-[9px] font-medium leading-none tracking-tight"
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
          // "Bringing The Stage everywhere" stage 1 — this mirror shows the
          // window mid RUNNING session (DeviceToolbar `running`, below), so its
          // state light is `live`: the same `[data-sim-state]`/`--sim-light-rgb`
          // idea index.css gives the real `simulator-device`, applied here to
          // the mirror's own outer ring (`.sim-aura` behind it is the room glow;
          // NOT `.sim-device` itself — this box also fills for the flat toolbar/
          // drawer chrome the real component keeps as separate elements, so it
          // keeps its own `bg-[#1d1e24]` rather than the phone's metal gradient).
          data-sim-state="live"
          // The real simulator-shell scopes its fixed-dark chrome to the dark
          // tokens in both themes (SimulatorWindow.tsx); the scene's window does
          // the same so the light-theme measurement is of the chrome as shipped.
          data-mode="dark"
          className="absolute bottom-6 right-6 z-20 flex flex-col overflow-hidden rounded-[16px] bg-[#1d1e24]"
          style={{
            width: phoneW + railW + paneW,
            // The outer glow's blur/spread MUST track `.sim-device`'s own (index.css)
            // — coordinator round 2: the rim read as a hairline because this figure
            // was too tight. Kept in lockstep with the real recipe's measured value.
            boxShadow:
              '0 30px 80px rgba(0,0,0,0.55), inset 0 0 0 1px rgb(var(--sim-light-rgb) / 0.5), 0 0 85px -11px rgb(var(--sim-light-rgb) / 0.45)',
          }}
        >
          <div className="sim-aura" aria-hidden="true" />
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
              // `relative` + the glow div below mirror SimulatorWindow.tsx's real
              // drawer exactly (coordinator round 2 — the room's light has to leak
              // into the chrome beside the phone too, not just above it).
              className="relative flex shrink-0 flex-row bg-[#1d1e24] text-[11.5px]"
            >
              <div className="sim-drawer-glow" aria-hidden="true" />
              <nav
                data-component="sim-drawer-rail"
                aria-label="Drawer sections"
                className="flex w-12 shrink-0 flex-col items-center gap-1 border-l border-white/[0.12] py-2"
              >
                <SimRailButton pane="session" icon={<IconChat />} />
                <SimRailButton pane="controls" icon={<IconSliders />} />
                {/* The ACTIVE one — the pane beside it is Diagnostics. An
                    inactive rail beside an open pane is another impossible
                    state. */}
                <SimRailButton pane="diagnostics" active icon={<IconSignal />} />
                <SimRailButton pane="cookies" icon={<IconCookie />} />
                {/* Network is a CONDITIONAL entry in the shipped rail since
                    2026-09-16 (SimulatorWindow visibleSimDrawerPanes): it is
                    withheld until the session has reported a request, so an
                    always-empty section is never offered. Drawing it here is a
                    scene choice, not a default — this window is a session that
                    HAS reported one, which is the state that shows the icon. A
                    scene of a session that has reported nothing would simply
                    omit this button and close the gap; the rest of the rail is
                    unchanged either way. */}
                <SimRailButton pane="network" icon={<IconGlobe />} />
                <SimRailButton pane="files" icon={<IconUpload />} />
                <SimRailButton pane="downloads" icon={<IconDownload />} />
                <SimRailButton pane="recording" icon={<IconRecordDot />} />
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
                      {/* The headline pill — mirrors the real strip's own
                          `.ai-chip`-style treatment (design brief §2 proposal 3,
                          SimulatorWindow.tsx `simChip`). This window is running,
                          so the ready-toned "LIVE" pill, same as the real one at
                          `data-sim-state="live"`. */}
                      <div className="flex items-center gap-1.5 pb-0.5">
                        <span className="ai-chip ai-chip-state sim-chip-halo ai-chip-open">
                          <i className="ai-pip is-ready" aria-hidden="true" />
                          LIVE
                        </span>
                      </div>
                      {/* The real strip's own shape: mode · link state · route,
                          then fps · rtt · 🌍 proxy · timezone (SimulatorWindow.tsx
                          "sim-drawer-status"). It used to read a ws tick and
                          `webrtc` / `60 fps · 38 ms · egress live` — readouts the
                          app never renders; the live strip says `connected` and
                          `direct`, and names no host (owner directive 2026-09-15:
                          the customer sees WHAT they get, never HOW it runs). */}
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
                        <span>connected</span>
                        <span className="text-white/30"> · </span>
                        <span className="text-ink-secondary">direct</span>
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
                    {/* The active section's name, from the app's own map — the
                        rail button beside it is named with it (gui-v0.1.73:
                        this said "Diagnostics" under a rail word "Health"). */}
                    <span data-component="sim-pane-title">{SIM_PANE_TITLES.diagnostics}</span>
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
                    {/* The Link card mirrors the real drawer: "Connected ✓", no
                        host and no "ws" marker (owner directive 2026-09-15). The
                        machine hosting the session and the proxy it egresses
                        through are independent by design, which is why the
                        drawer labels them Link and Egress separately. */}
                    <div className={infoLabel}>Link</div>
                    <div className="mt-0.5 truncate">Connected ✓</div>
                  </div>
                  <div className={infoCard}>
                    <div className={infoLabel}>Egress</div>
                    <div className="mt-0.5 truncate" title="🌍 Residential JP #1 · Asia/Tokyo">
                      🌍 Residential JP #1
                      <span data-component="sim-proxy-timezone"> · Asia/Tokyo</span>
                    </div>
                    <ExitIpChip report={MARKETING_CAPABILITY_REPORT} />
                    {/* The real window's three readings, in its order (UDP, QUIC,
                        OS) — the mirror had no UDP line (gui-v0.1.72). */}
                    <UdpReadout report={MARKETING_CAPABILITY_REPORT} />
                    <QuicReadout report={MARKETING_CAPABILITY_REPORT} />
                    <OsReadout
                      report={MARKETING_CAPABILITY_REPORT}
                      nowMs={MARKETING_CAPTURED_AT_MS}
                    />
                  </div>
                  <div className={`${infoCard} font-mono text-[10px] leading-relaxed`}>
                    <div className={`font-sans ${infoLabel}`}>Identity</div>
                    <div className="mt-0.5 truncate">Verified iPhone device</div>
                    {/* The real card's 4th line is `build {__BUILD_STAMP__}`.
                        Omitted: in the harness that define is absent, so it
                        renders `build dev` — and any value I typed instead
                        would be a build stamp nobody built. */}
                    <div className="truncate">Native touch input</div>
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
        <section className="cc-hero flex flex-col gap-3 rounded-xl border border-surface-divider bg-surface-raised p-5 shadow">
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
              ✦ Describe a task
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
            live
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
    case 'ai-running':
      return <AiRunningMarketingScene />;
  }
}
