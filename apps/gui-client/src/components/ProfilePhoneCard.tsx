// GX (2026-06-15) — phone-framed profile card v3. Founder feedback round 2:
// - taller screen (height only) so everything renders with room to breathe;
// - secondary controls are now a LABELLED hover strip (icon + caption) instead
//   of bare emoji you couldn't read;
// - UDP badge is explicitly red (no relay) / green (relay verified);
// - the device label is a readable chip, no longer colliding with the select
//   checkbox or washing out over the identity gradient.
// Phase A (2026-09-11) — "nothing outside the box": the body clips horizontally
// (overflow-x-hidden, min-w-0 on every row), the egress widget clips its own
// children, the latency row wraps, the ⋯ menu is anchored to BOTH card edges
// instead of a fixed 176px, and every truncated/clamped text carries a title.
// Phase B (2026-09-11) — the "simulator tile". Phase A made horizontal escape
// impossible; the ROOT CAUSE the design panel measured stayed: `aspect-[9/18.5]`
// made the card's height a function of its WIDTH, so at the grid's 178px minimum
// the body had ~228px for content that needed up to 220px more, and hid the rest
// by scrolling (invisible under macOS overlay scrollbars — the owner's "things
// outside the grid view box"). The card is now a FIXED 234px tile at every
// column width: a 220px screen holding eight single-line fixed-height regions
// (identity 38 · status 20 · exit 18 · via 16 · caps 20 · when 14 · meta 16)
// plus a 47px dock, each region `data-region`, explicit `h-*`, `shrink-0`,
// `overflow-hidden`, every truncating text titled. What does not fit a region
// is CUT IN JS (chip cap, meta cap, one health pill with a strict precedence),
// never by the browser — so it is deterministic and unit-testable without
// layout (`healthPill`, `visibleChips`, `visibleMeta` below). Geometry is
// proved by scripts/gui-visual-check.mjs at 178/240/260px; jsdom pins the rules.
// Polish (2026-09-11) — the tile judged against the owner's comp and the app's
// tokens: a slate bezel (never a black ring), ONE radial hue wash (the body
// stays on the raised surface so 9–10px text keeps ≥ 4.5:1), translucent slate
// pills/chips (never the near-black inset), soft inks for red/rose text on
// tints, a compact "when" row ('3 mo ago · CHECKED 2 H AGO'), a mint frame +
// dock for a live tile, a neutral busy dock button, a selected halo that is a
// Tailwind ring (it survives the hover shadow), solid focus rings, and a
// keyboard-complete ⋯ group (arrow keys, focus restored to ⋯ on close).
// Phase C (2026-09-11) — the click-opened DETAILS SHEET. Every fact Phase B cut
// from the visible tile (the full capability set with the OS fact and its
// hints, the exact checked-at and last-used stamps, the whole folder + tag
// list, the note, a VPN failure/notice in full, the stored size, the exit
// address) lives in `[data-component="card-details-sheet"]`: a role="dialog"
// overlay built like the note editor (absolute inset-0 z-40 INSIDE the screen,
// so it covers the dock and never reshapes the card), opened by the ⓘ glyph
// (`data-action="open-details"`, the 16px visibleMeta reserves) or the first
// row of the ⋯ menu, closed by ×, Escape or an outside pointer-down; focus is
// trapped inside and returns to the opener. Nothing opens on hover: the harness's
// forced hover is inert for the card. The ⋯ menu is PORTALED to document.body
// (position: fixed from the card's rect, flipped by the room above the dock) so
// no ancestor clip can cut it and it never widens the article's box.
// Pure presentational; ProfilesView passes data/display strings + handlers.
// flag covers every ISO country via flagEmoji (regional-indicator transform —
// no hardcoded list).

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type JSX,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';
import {
  ProxyCapabilityChips,
  ProxyOsChip,
  proxyCapabilities,
  type ProxyCapability,
} from './ProxyCapabilities';
import { formatElapsed } from './ProfilesTable';
import { proxyVerdict, type ProxyTestResult } from '../lib/proxies';

/** Hover text on the card's probe measurements. The probe runs on this Mac; the
 *  profile runs on Driftstack's servers (same sentence as ProxiesView, kept local
 *  because lib/proxies is hand-mocked by dozens of suites). */
export const PROBE_ORIGIN_TITLE =
  'Measured from your computer, not from the server that runs your profile.';
/** T-1 — hover text on a latency measured by the control plane, closer to the
 *  fleet that runs the profile than this Mac. */
export const SERVER_LATENCY_TITLE = 'Measured from Driftstack, not your computer.';
/** The menu row's and the first-measurement button's description of a SOCKS5
 *  test (one string, two surfaces on the same card). */
const TEST_PROXY_TITLE = 'Test proxy from this Mac — reachability, latency, exit IP';
const SAVED_TABS_REOPEN_TITLE = "This profile's saved tabs reopen when you launch it";
/** Polish — the ONE word for re-running a failed SOCKS5 test is the Proxies
 *  tab's ('Re-test', ProxiesView; the comp said 'Retest'). Pinned verbatim
 *  against that source; hoisting it into lib/proxy-check-copy.ts so the tab
 *  reads the constant too is the grid follow-up. */
export const RETEST_ACTION = 'Re-test';
/** Polish — the Proxies grid's EndpointHealthPill word + title for a VPN row
 *  whose endpoint resolved and whose tunnel was never brought up (the card said
 *  'not measured' for the same cache entry). Pinned verbatim against ProxiesView. */
export const ENDPOINT_OK_PILL = 'endpoint ok';
export const ENDPOINT_OK_TITLE =
  'The endpoint resolved. The tunnel itself is measured by the test Mac when the proxy is stored on your account, and verified at launch.';
/** Polish — the exit line's title for a proxy whose LAST test measured nothing
 *  (probed, usable, no failure stamp); the text says 'no exit IP', the title
 *  says what fills it. */
const NO_EXIT_AFTER_TEST_TITLE = 'No exit was measured by the last test — run Test proxy again';
/** Polish — dock / when-row titles that ADD something to the visible word
 *  (a title that restates its button is a tooltip that says nothing). */
const LAUNCH_TITLE = 'Launch a session with this profile';
const OPEN_SESSION_TITLE = 'Open the running session';
const LAUNCHING_TITLE = 'Launching — the proxy is checked before the session starts';
const LAUNCH_CHECK_TITLE = 'Checking the proxy before the session starts';
const NEVER_LAUNCHED_TITLE = 'This profile has never been launched';
/** Polish — what the VPN tag MEANS (the Check VPN sentence belongs to the button
 *  and the menu row, not to a label that performs nothing). */
const VPN_TAG_TITLE =
  'OpenVPN / WireGuard tunnel — the whole session, UDP included, travels inside it';
/** Polish — soft inks for coloured text on its own tint. The red-400 and
 *  oxblood-500 TOKENS measure 3.3–3.8:1 and 1.9:1 at 9–10px on their 15–25%
 *  tints; one step lighter (red-300 / oxblood-300) passes 4.5 (measured on the
 *  rendered tile). Literals, because the token file is outside this component. */
const SOFT_ERROR_INK = 'text-[#fca5a5]';
const SOFT_ACCENT_INK = 'text-[#e8a0ab]';
import {
  OS_FINGERPRINT_MEASURING,
  VPN_TUNNEL_OS_FINGERPRINT,
  osFingerprintVerdict,
  type OsFingerprint,
} from '../lib/os-fingerprint-verdict';
import type { MeasuredQuic } from '../lib/account-proxies';
import { vantageLabel, type ServerVantage } from '../lib/proxy-vantage';
import {
  CHECK_VPN_ACTION,
  CHECK_VPN_TITLE,
  ENDPOINT_UNRESOLVED,
  ENDPOINT_UNRESOLVED_EXIT_TITLE,
  EXIT_GEO_UNAVAILABLE_SHORT,
  EXIT_GEO_UNAVAILABLE_TITLE,
  RECHECK_ACTION,
  VPN_LATENCY_NOT_MEASURED,
  VPN_NO_API_KEY_CHECK_NOTICE,
  VPN_NO_EXIT_YET_SHORT,
  VPN_NO_EXIT_YET_TITLE,
  VPN_NO_LATENCY_YET_TITLE,
  VPN_NOT_STORED_CHECK_NOTICE,
  VPN_TUNNEL_UP_NO_LATENCY_TITLE,
} from '../lib/proxy-check-copy';

/** (o) — the pre-flight of a VPN/HTTP row: a DNS resolve of the configured
 *  endpoint (field names match the cache's `CachedEndpointVerdict`; typed
 *  structurally so this presentational component imports no cache module). */
export interface EndpointPreflight {
  resolved: boolean;
  message: string;
}

export interface ProfilePhoneCardProps {
  name: string;
  monogram: string;
  /** Optional chosen emoji icon; when set, shown instead of the monogram. */
  icon?: string;
  /** 0–359 identity hue (screen wash). */
  hue: number;
  deviceLabel: string;
  running: boolean;
  selected: boolean;
  lastUsedIso: string | null;
  /** Phase B — when the bound session started (ISO), so a running card's "when"
   *  row reads `running 12m` from the SAME formatElapsed the list uses. Null /
   *  absent → the row falls back to last-used. */
  runningSinceIso?: string | null;
  /** doc-150 item 5 — already-formatted per-profile storage size (e.g. "2.4 MiB"
   *  or "—" when never saved). The parent formats it via fmtBytes so the card
   *  stays purely presentational. Phase B: rendered by the details sheet (Phase
   *  C); the tile has no slot for it. Kept so the call site is stable. */
  sizeLabel?: string;
  /** Existing save metadata proves this profile has a persisted browser-state
   *  blob. The exact tab count stays encrypted inside ProfileBlob.openTabs, so
   *  the card truthfully promises restore without inventing a number. */
  savedTabsReopen?: boolean;
  folder: string;
  tags: ReadonlyArray<string>;
  /** Free-text note (F3 — now editable in the grid card too, not just the table).
   *  Empty string = no note. */
  note?: string;
  /** Save the trimmed note (Enter / Save / blur in the inline editor); empty
   *  clears it. Omitted → the "Edit note" affordance isn't offered. */
  onSaveNote?: (note: string) => string | null | void | Promise<string | null | void>;
  // proxy / egress
  hasProxy: boolean;
  /** The proxy's own LABEL, so the card says WHICH proxy it is using.
   *  The card previously received only `hasProxy`, a boolean — the resolved
   *  ProxyConfig carrying `label` was in scope at the call site and dropped
   *  there, so a customer with several proxies could see that a profile had one
   *  and never which. Null when unbound or unnamed. */
  proxyName?: string | null;
  /** Phase B (N8) — `host:port` of the bound proxy, already derived for the list
   *  at the call site. The "via" row falls back to it when the proxy has no
   *  label, and every via row carries `name — host:port` as its title. */
  proxyAddress?: string | null;
  /**
   * Whether this profile is bound to that proxy DELIBERATELY, or merely inherits it.
   *
   * With no explicit binding a profile resolves to the first saved proxy, so the
   * moment one proxy exists every card starts showing its country and exit IP —
   * reported as "suddenly all profiles are linked to this proxy". Nothing was
   * written; the display simply could not tell a choice from a default. The edit
   * modal already distinguishes them ("First available saved proxy"); this makes
   * the card agree.
   */
  proxyExplicit: boolean;
  flag: string; // emoji or '🌍'
  countryCode: string | null; // exit country code (e.g. 'NL') for the badge
  exitIp: string | null; // real exit IP, or null = no exit to show
  /**
   * (n) N-M1 — V-857's THIRD exit state, which this card had collapsed away.
   * The exit has THREE states, not two, and the Proxies grid renders all three
   * (ProxiesView.tsx:1965-1982):
   *   • an ip           → `exitIp` holds it;
   *   • `true` here     → the proxy is usable and the echo round-trip did NOT
   *                       complete through it (the grid's `exit === null`);
   *   • absent/`false`  → never exit-probed.
   * The card said "no exit IP" for BOTH of the last two, so a customer who had
   * just run a Test that measured nothing read the same dead-end words as one
   * who had never tested at all — and the grid, for the same proxy at the same
   * moment, said why. The parent derives this from the same place the grid does:
   * `deriveProbeViewWithEndpointRows(...).exitResults[id] === null`.
   */
  exitProbeFailed?: boolean;
  locationLabel?: string | null; // #6 — resolved "city, region" / country name for the exit
  /** Phase B — reserved: the exit's IANA timezone, rendered as a trailing ≤40px
   *  glyph on the exit row when a caller starts passing it. No relayout. */
  exitTz?: string | null;
  latencyMs: number | null;
  latencyFillPct: number;
  latencyGood: boolean;
  /** T-1 — true when latencyMs is the SERVER-measured value (control plane), so
   *  the card labels it as such rather than as the native "from this Mac" probe. */
  latencyFromServer?: boolean;
  /** T-1 — WHERE that server number was measured: a fleet Mac (named) or the
   *  server when none was free. Undefined with latencyFromServer keeps the
   *  plain "server" marker (a number recorded before the vantage existed). */
  latencyVantage?: ServerVantage;
  probed: boolean;
  capabilities: ProxyTestResult | null;
  /** T-6 — the QUIC verdict measured in a live session: 'h3' lets the QUIC chip
   *  go green, 'h2-only' is a measured negative, null/undefined stays inferred. */
  quicMeasured?: MeasuredQuic | null;
  /** T-27 — the fleet Mac's standalone QUIC-relay verdict (`quic_ok`): true/false is a
   *  measurement, undefined = none. As of 2026-09-09 it FEEDS the single QUIC chip (a
   *  live h3/h2-only measurement outranks it) rather than rendering a separate chip. */
  quicProbe?: boolean;
  /** N-2 — passive OS fingerprint of the proxy's own stack, when the control
   *  plane observed one. Undefined = never measured. */
  osFingerprint?: OsFingerprint;
  /** (h) — the bound proxy is an OpenVPN/WireGuard TUNNEL: its Test is a DNS
   *  resolve + a fleet tunnel test (never a SOCKS5 probe), UDP is carried by the
   *  tunnel rather than probed, and the menu row says so. */
  vpn?: boolean;
  /** (h) — the fleet's sentence when the last tunnel test FAILED to bring this
   *  VPN up. Renders the broken-proxy banner (a VPN row has no SOCKS5 caps to
   *  trip it); cleared by the next check. */
  vpnFailure?: string;
  /** (o) — the row's last ENDPOINT pre-flight (a VPN/HTTP row's check resolves
   *  the configured host; it is never a SOCKS5 probe), from the same derivation
   *  the Proxies grid reads (`deriveProbeViewWithEndpointRows(...).endpointResults`).
   *  `resolved: false` is the one state this card had no word for: it read
   *  "not measured" + "no exit measured yet — run Check VPN" and offered a
   *  Check VPN button, while the grid's pill for the SAME cache entry was a red
   *  "unresolved" carrying the resolver's message. Undefined / null = the row
   *  holds no pre-flight (a SOCKS5 row, or never checked). */
  endpoint?: EndpointPreflight | null;
  /** (h) — the server's sentence when the last tunnel test was NOT RUN (a live
   *  session holds the tunnel, no fleet Mac was free…). A muted notice, never
   *  a failure; the card keeps its prior data beside it. */
  vpnNotice?: string;
  /** When the bound proxy was last checked (ISO), rendered as a relative
   *  "checked" stamp beside the latency. (h) finding 5 — for a VPN row the
   *  parent dates it from the fleet's own answer, never the pre-flight. */
  checkedAtIso: string | null;
  // actions
  busy: boolean;
  /** This row is specifically creating a session. `busy` also covers stop,
   *  reopen, clone, trim, and delete, so it cannot safely drive launch copy. */
  launching: boolean;
  /** True when SOME OTHER profile is busy (a global single-flight is held, e.g.
   *  another row launching through the ~12s server probe). The mutate actions
   *  (Duplicate / Trim / Delete) early-return on that global guard, so they're
   *  disabled here with a tooltip rather than no-op'ing silently on a click. */
  anyBusy: boolean;
  testing: boolean;
  testDisabled: boolean;
  launchDisabled: boolean;
  launchDisabledReason?: string;
  onToggleSelect: () => void;
  onPrimary: () => void; // Launch (idle) / Open session (running)
  /** Kept for call-site compatibility. Phase B removed the menu's Watch / View
   *  live row: ProfilesView gives onWatch and onPrimary identical bodies, so the
   *  row was a second name for the primary button (D8/C9). */
  onWatch: () => void;
  onTest: () => void;
  onAssist?: () => void;
  /** Stop the running session (founder Track A) — close the bound agent/driver
   *  session so the card flips back to Launch. The Stop affordance renders ONLY
   *  when the profile is running AND this handler is provided (idle cards never
   *  show Stop); guarded by `busy` so a double-click can't double-close. */
  onStop?: () => void;
  /** Management actions in the ⋯ menu (grid view) — edit metadata, duplicate,
   *  export a portable copy, delete the profile. Omitted → that action isn't
   *  offered. */
  onEdit?: () => void;
  /** Duplicate this profile into a fresh one (server clone). Disabled at the
   *  tier cap (the caller passes `cloneDisabled` + a reason). */
  onClone?: () => void;
  cloneDisabled?: boolean;
  cloneDisabledReason?: string;
  onExport?: () => void;
  /** P-23 — open the profile's recent-activity panel (pages its sessions opened,
   *  read from the account's session records). Labelled ACTIVITY, never history:
   *  Clear history does not remove these rows (D-1). Omitted → not offered. */
  onActivity?: () => void;
  /** doc-150 §8 — "Clear cache, keep logins". Trims the profile's re-fetchable
   *  caches while keeping logins/storage/tabs. Omitted → the action isn't
   *  offered. Disabled while busy (a launch/clone/trim in flight). */
  /**
   * Clear a scope of this profile's stored data. Typed with a local union rather
   * than the SDK's TrimProfileScope so this presentational component keeps no
   * dependency on the API client.
   */
  onTrim?: (scope: 'cache' | 'cookies' | 'history' | 'all') => void;
  onDelete?: () => void;
  /** Phase C — HARNESS ONLY: mount with the details sheet already open, so the
   *  gallery can list sheet-open states and the geometry gate can measure them
   *  at rest. The app never passes it; the sheet opens by click alone. */
  detailsInitiallyOpen?: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Phase B — the pure rules. Exported so the precedence and the caps are pinned
// without layout; the render tree below only reads them.
// ─────────────────────────────────────────────────────────────────────────────

/** The content width the JS caps assume when nothing has been measured yet
 *  (jsdom, the first paint before the layout effect): the 240px column's 206px.
 *  A real browser overwrites it synchronously in useLayoutEffect, before paint. */
export const DEFAULT_CONTENT_WIDTH = 206;
/** Static widths (px) of every chip the caps row can show, MEASURED from the
 *  live render at text-[9.5px] font-semibold px-1.5 gap-0.5 (Chromium, Geist;
 *  scratchpad/polish-chips.mjs reads offsetWidth per chip and asserts no caps
 *  child's right edge passes the row's at 178/186/240/260). The cut is decided
 *  from this table, not from layout, so it is the same in jsdom and in Chromium.
 *  ⛔ The table was stale by ~10px per chip (32 for a 44px 'UDP ✓'): the sum
 *  said MAX fit the 186px column's 152px, the browser then cut the OS chip
 *  mid-glyph. Anything not listed uses the 6px/char + 14px rule (rounded up). */
const CHIP_WIDTH: Readonly<Record<string, number>> = {
  'UDP ✓': 45, // 44.22 rendered
  '⤵ UDP': 44, // 43.47
  'QUIC ✓': 49, // 48.30
  'QUIC ~': 47, // 46.03
  '⤵ QUIC': 48, // 47.55
  '✓ iOS/macOS': 78, // 77.38
  '✗ Windows': 68, // the 6px/char rule; not in the harness — re-measure when it is
  '… OS': 38, // 37.41
};
const CHIP_GAP = 4;
/** The dashed '+N' tail: 9.5px semibold + 12px padding + 2px border. */
const OVERFLOW_PILL_WIDTH = 27;
const chipWidth = (text: string): number => CHIP_WIDTH[text] ?? Math.ceil(text.length * 6 + 14);

export type HealthState =
  | 'none'
  | 'broken'
  | 'checking'
  | 'untested'
  | 'ok'
  | 'slow'
  | 'unmeasured';
/** (o) — the ONE state whose word is not in the list/proxies.ts/copy file: the
 *  Proxies grid's `EndpointHealthPill` ("unresolved", red, title = the
 *  resolver's message). Pinned verbatim against views/ProxiesView.tsx. */
export const ENDPOINT_UNRESOLVED_PILL = ENDPOINT_UNRESOLVED;
/** (o) — the grid's "tunnel up · no latency" state, cut to the pill's 15 chars;
 *  the "no latency" half is what the title says. */
export const TUNNEL_UP_PILL = 'tunnel up';
export type HealthTone = 'ready' | 'busy' | 'error' | 'muted';
export interface HealthPill {
  /** ≤ 15 characters, every value pinned in profile-phone-card.test.tsx. */
  text: string;
  state: HealthState;
  tone: HealthTone;
  /** Always set: the pill truncates (a safety net — every string is ≤ 15
   *  chars), and a truncating text carries its full form as its title. */
  title: string;
}
export type HealthPillInput = Pick<
  ProfilePhoneCardProps,
  | 'hasProxy'
  | 'capabilities'
  | 'vpn'
  | 'vpnFailure'
  | 'vpnNotice'
  | 'endpoint'
  | 'testing'
  | 'launching'
  | 'probed'
  | 'latencyMs'
  | 'latencyGood'
  | 'latencyFromServer'
  | 'latencyVantage'
  | 'exitIp'
>;

/** (o) — the row's pre-flight ran and the endpoint did NOT resolve. */
const endpointUnresolved = (p: Pick<ProfilePhoneCardProps, 'endpoint'>): boolean =>
  p.endpoint != null && !p.endpoint.resolved;
/** (o) — the test Mac brought this tunnel up (the grid's `tunnelUp`: the
 *  fleet vantage is on the row) but reported no latency number. */
const tunnelUpNoLatency = (
  p: Pick<ProfilePhoneCardProps, 'vpn' | 'latencyMs' | 'latencyVantage'>,
): boolean => p.vpn === true && p.latencyMs === null && p.latencyVantage?.measuredFrom === 'fleet';

/**
 * R2 — ONE health pill, strict precedence (first arm that holds wins):
 *   1. no proxy                 → 'no proxy'
 *   2. a SOCKS5 verdict that is not ok → its label ('Not reachable' · 'Auth failed' · 'Cannot route')
 *   3. a VPN whose tunnel test failed  → 'VPN tunnel down'
 *   3b. (o) an endpoint pre-flight that did NOT resolve → 'unresolved' (the grid's word),
 *       error, title = the resolver's message — nothing downstream ran
 *   4. a test in flight          → 'Checking…' (VPN) | 'Testing…' — a LAUNCH too (polish): the
 *      launch runs the proxy check, so the card says a check is in flight, not a stale number
 *   5. never probed, nothing measured → 'untested'
 *   6. a latency number          → `${n}ms`, tone by latencyGood; title says WHERE it was measured
 *      (polish: the title is the origin sentence ALONE — it used to append the SOCKS5
 *      label's own '… · 42 ms', a second number beside the pill's)
 *   6b. (o) a VPN the test Mac brought up with no number → 'tunnel up' (the grid's
 *       'tunnel up · no latency'), ready, one shared title
 *   6c. (polish) a VPN whose endpoint RESOLVED and whose tunnel was never brought up →
 *       'endpoint ok' (the Proxies grid's word for the same cache entry), muted
 *   7. probed with no number and no failure → 'not measured' ('stale' is gone: a number that
 *      was never taken did not age); a VPN title never says "no exit yet" beside an exit
 * Arm 2 outranks 7 by construction, so a failed SOCKS5 can never read 'not measured';
 * arm 3b outranks 7 so an unresolved endpoint can never read it either.
 */
export function healthPill(p: HealthPillInput): HealthPill {
  if (!p.hasProxy)
    return { text: 'no proxy', state: 'none', tone: 'muted', title: 'no proxy bound' };
  const verdict = p.capabilities !== null ? proxyVerdict(p.capabilities) : null;
  if (verdict !== null && !verdict.ok) {
    return {
      text: verdict.label,
      state: 'broken',
      tone: 'error',
      title: p.capabilities?.message ?? verdict.label,
    };
  }
  if (p.vpn === true && p.vpnFailure !== undefined) {
    return {
      text: 'VPN tunnel down',
      state: 'broken',
      tone: 'error',
      title: p.vpnNotice !== undefined ? `${p.vpnFailure} — ${p.vpnNotice}` : p.vpnFailure,
    };
  }
  if (endpointUnresolved(p)) {
    const message = p.endpoint?.message ?? '';
    return {
      text: ENDPOINT_UNRESOLVED_PILL,
      state: 'broken',
      tone: 'error',
      title: message.length > 0 ? message : ENDPOINT_UNRESOLVED_EXIT_TITLE,
    };
  }
  if (p.testing || p.launching) {
    return {
      text: p.vpn === true ? 'Checking…' : 'Testing…',
      state: 'checking',
      tone: 'muted',
      title: p.testing ? (p.vpn === true ? CHECK_VPN_TITLE : TEST_PROXY_TITLE) : LAUNCH_CHECK_TITLE,
    };
  }
  if (!p.probed && p.capabilities === null) {
    return {
      text: 'untested',
      state: 'untested',
      tone: 'muted',
      title: p.vpn === true ? CHECK_VPN_TITLE : TEST_PROXY_TITLE,
    };
  }
  if (p.latencyMs !== null) {
    const where =
      p.latencyFromServer === true
        ? p.latencyVantage !== undefined
          ? vantageLabel(p.latencyVantage).title
          : SERVER_LATENCY_TITLE
        : PROBE_ORIGIN_TITLE;
    return {
      text: `${p.latencyMs.toString()}ms`,
      state: p.latencyGood ? 'ok' : 'slow',
      tone: p.latencyGood ? 'ready' : 'busy',
      title: where,
    };
  }
  if (tunnelUpNoLatency(p)) {
    return {
      text: TUNNEL_UP_PILL,
      state: 'ok',
      tone: 'ready',
      title:
        p.vpnNotice !== undefined
          ? `${VPN_TUNNEL_UP_NO_LATENCY_TITLE} — ${p.vpnNotice}`
          : VPN_TUNNEL_UP_NO_LATENCY_TITLE,
    };
  }
  if (p.vpn === true && p.endpoint?.resolved === true) {
    return {
      text: ENDPOINT_OK_PILL,
      state: 'unmeasured',
      tone: 'muted',
      title:
        p.vpnNotice !== undefined ? `${ENDPOINT_OK_TITLE} — ${p.vpnNotice}` : ENDPOINT_OK_TITLE,
    };
  }
  // (o) — the VPN title must not assert "no exit measured yet" on a tile whose
  // exit row shows one (a session-reported exit adopted with no fleet number).
  const vpnUnmeasuredTitle =
    p.exitIp !== null && p.exitIp !== undefined ? VPN_NO_LATENCY_YET_TITLE : VPN_NO_EXIT_YET_TITLE;
  return {
    text: VPN_LATENCY_NOT_MEASURED,
    state: 'unmeasured',
    tone: 'muted',
    title: p.vpn === true ? (p.vpnNotice ?? vpnUnmeasuredTitle) : TEST_PROXY_TITLE,
  };
}

/** Polish — ready at /10 (the /15 green tint over a green hue wash measured
 *  4.41:1 on one card); error text is the soft ink (the token measured 3.3–3.8);
 *  muted is the comp's translucent slate — the near-black inset made the
 *  quietest states ('untested', 'no proxy') the darkest object on the tile. */
const HEALTH_TONE_CLASS: Readonly<Record<HealthTone, string>> = {
  ready: 'bg-status-ready/10 text-status-ready',
  busy: 'bg-status-busy/15 text-status-busy',
  error: `bg-status-error/15 ${SOFT_ERROR_INK}`,
  muted: 'bg-ink-muted/15 text-ink-secondary',
};
/** Polish — one fill and one ink for every non-green chip: a guess ('QUIC ~')
 *  must not read brighter than a measured negative ('⤵ QUIC'). */
const CHIP_MUTED_CLASS = 'bg-ink-muted/15 text-ink-secondary';
const CHIP_READY_CLASS = 'bg-status-ready/10 text-status-ready';

export type CapsMode = 'none' | 'repair' | 'measured' | 'first';
export type CapsInput = Pick<
  ProfilePhoneCardProps,
  | 'hasProxy'
  | 'capabilities'
  | 'quicMeasured'
  | 'quicProbe'
  | 'osFingerprint'
  | 'vpn'
  | 'vpnFailure'
  | 'endpoint'
  | 'testing'
  | 'latencyMs'
  | 'latencyVantage'
>;

/** R5 — which of the four rows the caps region shows. Exactly one. */
export function capsMode(p: CapsInput): CapsMode {
  if (!p.hasProxy) return 'none';
  const verdict = p.capabilities !== null ? proxyVerdict(p.capabilities) : null;
  // (o) — an endpoint that does not resolve is a repair, not a first
  // measurement: "Check VPN" cannot bring a tunnel up on an address that does
  // not resolve, so the row offers Re-check + Change, as it does for a tunnel
  // the test Mac could not bring up.
  if (
    (verdict !== null && !verdict.ok) ||
    (p.vpn === true && p.vpnFailure !== undefined) ||
    endpointUnresolved(p)
  ) {
    return 'repair';
  }
  if (verdict !== null) return 'measured';
  // A VPN row has no SOCKS5 caps; a fleet number is its measurement — and so
  // is a tunnel the test Mac brought up without reporting one (o): its QUIC
  // relay probe and the tunnel's UDP hint are what that reply measured.
  if (p.vpn === true && (p.latencyMs !== null || tunnelUpNoLatency(p))) return 'measured';
  return 'first';
}

export interface CapChip {
  key: 'udp' | 'quic' | 'os';
  /** The visible text, also the key into the static width table. */
  text: string;
  width: number;
  className: string;
  title: string;
  /** Data attributes; the OS chip carries `data-component="proxy-os-fingerprint"`
   *  + `data-os-tone` here (polish: it renders with CHIP_BASE like its neighbours
   *  — ProxyOsChip's 9px/400 rounded-sm was a second chip typography in the row). */
  attrs: Readonly<Record<string, string>>;
}

/** Polish — 9.5px/600, radius 6 (the comp's chip; 9px bold rendered heavier and
 *  smaller than the buttons and the pill in the same rows). */
const CHIP_BASE =
  'inline-flex shrink-0 cursor-help items-center gap-0.5 whitespace-nowrap rounded-md px-1.5 py-px text-[9.5px] font-semibold leading-4';
/** The '+N' tail: transparent with a dashed divider — visibly "there is more",
 *  not another chip. The meta row's '+N' wears the same. */
const OVERFLOW_PILL_CLASS =
  'border border-dashed border-surface-divider bg-transparent text-ink-muted';

/** The UDP chip's hover text (kept from v3): the WebRTC/QUIC consequence of the
 *  relay verdict, with the QUIC clause read from the CANONICAL quic chip — never
 *  a guess from udp_associate. */
function udpTitle(vpn: boolean, caps: ProxyCapability[] | null, quicCap?: ProxyCapability): string {
  if (vpn) {
    return `UDP travels inside the VPN tunnel — not a probed grant. WebRTC and QUIC use the tunnel’s own UDP; run ${CHECK_VPN_ACTION} to measure QUIC through it.`;
  }
  if (caps === null) return 'Run Test to check UDP (WebRTC + QUIC) support on this exit.';
  const udpOk = caps.find((c) => c.key === 'webrtc')?.ok ?? false;
  if (!udpOk) return 'No UDP relay — WebRTC falls back to TURN-over-TCP and QUIC to HTTP/2.';
  const quicClause =
    quicCap?.inferred === true
      ? 'QUIC likely (not yet measured)'
      : quicCap?.ok === true
        ? 'QUIC ✓'
        : 'QUIC ✗ (HTTP/2 on last measure)';
  return `UDP relay verified — WebRTC ✓; ${quicClause} through this exit.`;
}

/** A VPN row's QUIC verdict comes from the fleet relay probe or a live session,
 *  never from a SOCKS5 result (it has none). Reuses proxyCapabilities so the hint
 *  wording is the one shared definition; only a MEASURED verdict is admitted —
 *  the UDP inference has no UDP grant to infer from on a tunnel. */
function vpnQuicCap(quicMeasured: MeasuredQuic | null | undefined, quicProbe: boolean | undefined) {
  const measured =
    quicMeasured === 'h3' || quicMeasured === 'h2-only' || typeof quicProbe === 'boolean';
  if (!measured) return undefined;
  const synthetic: ProxyTestResult = {
    reachable: true,
    auth_ok: true,
    udp_associate: false,
    can_route: true,
    connect_reply: 0x00,
    latency_ms: 0,
    message: '',
  };
  return proxyCapabilities(synthetic, quicMeasured, quicProbe).find((c) => c.key === 'quic');
}

/**
 * R5 mode A — the chips a row is ELIGIBLE to show, in fixed order UDP → QUIC →
 * OS, plus the hints that never get a chip (a VPN's "UDP via tunnel", an OS
 * placeholder). Eligibility = a MEASUREMENT or a measured inference only:
 *   • UDP: 'UDP ✓' (green) when the relay was verified, '⤵ UDP' (muted — a
 *     measured fall-back, never red) when it was not; no chip on a VPN row;
 *   • QUIC: 'QUIC ✓' measured (green), '⤵ QUIC' measured negative (muted),
 *     'QUIC ~' inferred (muted, `data-quic-inferred="true"`);
 *   • OS: the shared ProxyOsChip for a match ('✓ iOS/macOS'), a mismatch ('✗
 *     Windows' — the ONE measured defect that stays red) or a probe in flight
 *     ('… OS'); the '—' / '?' placeholders are hints, not chips.
 */
export function capabilityChips(p: CapsInput): { eligible: CapChip[]; hidden: string[] } {
  const vpn = p.vpn === true;
  const caps =
    p.capabilities !== null ? proxyCapabilities(p.capabilities, p.quicMeasured, p.quicProbe) : null;
  const quicCap = vpn
    ? vpnQuicCap(p.quicMeasured, p.quicProbe)
    : caps?.find((c) => c.key === 'quic');
  const eligible: CapChip[] = [];
  const hidden: string[] = [];

  if (vpn) {
    hidden.push(`UDP via tunnel — ${udpTitle(true, null)}`);
  } else if (caps !== null) {
    const udpOk = caps.find((c) => c.key === 'webrtc')?.ok ?? false;
    const text = udpOk ? 'UDP ✓' : '⤵ UDP';
    eligible.push({
      key: 'udp',
      text,
      width: chipWidth(text),
      className: udpOk ? CHIP_READY_CLASS : CHIP_MUTED_CLASS,
      title: udpTitle(false, caps, quicCap),
      attrs: { 'data-udp': udpOk ? 'true' : 'false' },
    });
  }

  if (quicCap !== undefined) {
    const inferred = quicCap.inferred === true;
    const text = inferred ? 'QUIC ~' : quicCap.ok ? 'QUIC ✓' : '⤵ QUIC';
    eligible.push({
      key: 'quic',
      text,
      width: chipWidth(text),
      className: !inferred && quicCap.ok ? CHIP_READY_CLASS : CHIP_MUTED_CLASS,
      title: quicCap.hint,
      attrs: { 'data-quic-inferred': inferred ? 'true' : 'false' },
    });
  }

  // (o) O4 — "measuring" is rendered from `p.testing` (a probe THIS client has
  // in flight), never from an absent fingerprint; and never on a VPN row at
  // all: nothing fingerprints a tunnel, so a VPN row states that cause from its
  // own scheme in every state. A reading the server did send outranks both.
  const fingerprint =
    p.osFingerprint ??
    (vpn ? VPN_TUNNEL_OS_FINGERPRINT : p.testing ? OS_FINGERPRINT_MEASURING : undefined);
  const os = osFingerprintVerdict(fingerprint);
  const osText = `${os.glyph} ${os.label}`;
  if (os.tone === 'match' || os.tone === 'mismatch' || os.glyph === '…') {
    eligible.push({
      key: 'os',
      text: osText,
      width: chipWidth(osText),
      // The colour rule is osFingerprintVerdict's (match green, the ONE measured
      // defect red, measuring muted) — only the chip chrome is the card's.
      className:
        os.tone === 'match'
          ? CHIP_READY_CLASS
          : os.tone === 'mismatch'
            ? `bg-status-error/15 ${SOFT_ERROR_INK}`
            : CHIP_MUTED_CLASS,
      title: os.hint,
      attrs: { 'data-component': 'proxy-os-fingerprint', 'data-os-tone': os.tone },
    });
  } else {
    hidden.push(`OS — ${os.hint}`);
  }
  return { eligible, hidden };
}

export interface VisibleChips {
  chips: CapChip[];
  /** One line per hidden chip or placeholder: `label — hint`. The '+N' pill's title. */
  hiddenHints: string[];
}

/**
 * R5 mode A — the static width-table cut: fixed order, as many whole chips as
 * fit `contentWidth` (gaps 4px), then a '+N' pill (27px) when anything is
 * hidden. MAX (UDP ✓ 45 + QUIC ~ 47 + ✓ iOS/macOS 78 + gaps 8 = 178) fits
 * neither the 178px column's 144px nor the 186px column's 152px (the 1440
 * viewport), so it renders 'UDP ✓ · QUIC ~ · +1' there and all three at
 * 240/260. Deterministic in JS; the row's `overflow-hidden` is a safety net,
 * never the mechanism.
 */
export function visibleChips(p: CapsInput, contentWidth: number): VisibleChips {
  const { eligible, hidden } = capabilityChips(p);
  for (let k = Math.min(3, eligible.length); k >= 0; k -= 1) {
    const shown = eligible.slice(0, k);
    const hiddenCount = eligible.length - k + hidden.length;
    let width = shown.reduce((sum, c) => sum + c.width, 0) + Math.max(0, k - 1) * CHIP_GAP;
    if (hiddenCount > 0) width += (k > 0 ? CHIP_GAP : 0) + OVERFLOW_PILL_WIDTH;
    if (width <= contentWidth || k === 0) {
      return {
        chips: shown,
        hiddenHints: [...eligible.slice(k).map((c) => `${c.text} — ${c.title}`), ...hidden],
      };
    }
  }
  return { chips: [], hiddenHints: [...eligible.map((c) => `${c.text} — ${c.title}`), ...hidden] };
}

export interface MetaPill {
  kind: 'folder' | 'tag';
  text: string;
  title: string;
  width: number;
}
export interface VisibleMeta {
  pills: MetaPill[];
  /** Names of the pills that did not fit: the '+N' pill's title (joined ' · '). */
  hidden: string[];
}
const FOLDER_PILL_MAX = 72;
const TAG_PILL_MAX = 50;
const META_GLYPH_WIDTH = 16;
const metaPillWidth = (text: string, cap: number): number =>
  Math.min(cap, Math.round(text.length * 5.2 + 14));

/**
 * R7 — pills fill left to right (folder first, then tags), as many WHOLE pills
 * as fit after the trailing glyphs are reserved, then a '+N' pill whose title
 * names what was hidden. At 178 that is typically folder + '+N'; at 260 folder
 * + 2 tags + '+N'. `glyphs` = how many trailing glyph buttons the row shows.
 */
export function visibleMeta(
  p: Pick<ProfilePhoneCardProps, 'folder' | 'tags'>,
  contentWidth: number,
  glyphs: number,
): VisibleMeta {
  const all: MetaPill[] = [];
  if (p.folder !== '') {
    const text = `📁 ${p.folder}`;
    all.push({
      kind: 'folder',
      text,
      title: p.folder,
      width: metaPillWidth(text, FOLDER_PILL_MAX),
    });
  }
  for (const tag of p.tags) {
    all.push({ kind: 'tag', text: tag, title: tag, width: metaPillWidth(tag, TAG_PILL_MAX) });
  }
  const available = contentWidth - glyphs * (META_GLYPH_WIDTH + CHIP_GAP);
  for (let k = all.length; k >= 0; k -= 1) {
    const shown = all.slice(0, k);
    let width = shown.reduce((sum, c) => sum + c.width, 0) + Math.max(0, k - 1) * CHIP_GAP;
    if (k < all.length) width += (k > 0 ? CHIP_GAP : 0) + OVERFLOW_PILL_WIDTH;
    if (width <= available || k === 0) {
      return { pills: shown, hidden: all.slice(k).map((c) => c.title) };
    }
  }
  return { pills: [], hidden: all.map((c) => c.title) };
}

/**
 * Polish — the "when" row's compact relative form. RelativeTime's long form
 * ('3 months ago') truncated to '3 m…' (reads as minutes) on 24 of 27 tiles at
 * the 178px column; both halves of the row now fit: 'just now' · '5 min ago' ·
 * '2 h ago' · 'yesterday' · '2 d ago' · '3 mo ago' · '1 yr ago'. The absolute
 * stamp stays in the title. A future or unparseable stamp degrades honestly.
 */
type AgoUnit = 'now' | 'min' | 'h' | 'd' | 'mo' | 'yr';
function agoParts(iso: string, nowMs: number): { n: number; unit: AgoUnit } | null {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return null;
  const s = Math.round((nowMs - t) / 1000);
  if (s < 60) return { n: 0, unit: 'now' };
  const m = Math.round(s / 60);
  if (m < 60) return { n: m, unit: 'min' };
  const h = Math.round(m / 60);
  if (h < 24) return { n: h, unit: 'h' };
  const d = Math.round(h / 24);
  if (d < 30) return { n: d, unit: 'd' };
  const mo = Math.round(d / 30.44);
  if (mo < 12) return { n: Math.max(1, mo), unit: 'mo' };
  return { n: Math.max(1, Math.round(d / 365.25)), unit: 'yr' };
}
export function compactAgo(iso: string, nowMs: number = Date.now()): string {
  const a = agoParts(iso, nowMs);
  if (a === null) return '—';
  if (a.unit === 'now') return 'just now';
  if (a.unit === 'd' && a.n === 1) return 'yesterday';
  return `${a.n.toString()} ${a.unit} ago`;
}
/**
 * Polish — the "checked" stamp's TERSE form ('checked 3 mo' · 'checked 59 min'
 * · 'checked <1 min'): the verb already places it in the past, and beside
 * 'never launched' (70.5px at 9.5px) the 144px row leaves 70px — 'checked
 * 59 min ago' measures 89, 'checked 59 min' 67 (tracking-tight). Measured in
 * the live harness; the absolute stamp is the title.
 */
export function terseAgo(iso: string, nowMs: number = Date.now()): string {
  const a = agoParts(iso, nowMs);
  if (a === null) return '—';
  if (a.unit === 'now') return '<1 min';
  return `${a.n.toString()} ${a.unit}`;
}

/** Polish — hues 4–175 (orange → cyan) take the LIGHT thumb gradient
 *  (L58→L52) with the inverted (dark) ink; 176–359 and 0–3 (blue → magenta →
 *  red) the DARK gradient (L32→L24) with white. Searched over the hue wheel
 *  against BOTH gradient stops: every hue ≥ 4.64:1 with its ink. */
export function thumbUsesDarkInk(hue: number): boolean {
  const h = ((hue % 360) + 360) % 360;
  return h >= 4 && h <= 175;
}

/**
 * Polish — the clause of a VPN failure the "when" row SHOWS. The fleet's
 * sentence opens with a generic preamble ('The test Mac could not bring the
 * tunnel up: …') that repeats the pill above it, so at every column width the
 * visible part carried no information and the cause was hidden. The row now
 * shows what follows the first ': ' (or the sentence minus that preamble); the
 * whole sentence stays in the title.
 */
export function vpnFailureClause(sentence: string): string {
  const colon = sentence.indexOf(': ');
  const clause =
    colon > 0
      ? sentence.slice(colon + 2)
      : sentence.replace(/^The test Mac could not bring the tunnel up\b[\s:.—-]*/i, '');
  const trimmed = clause.trim();
  return /[A-Za-z0-9]/.test(trimmed) ? trimmed : sentence;
}

/**
 * Polish — the clause of a VPN notice the "when" row SHOWS. The two notices the
 * server sends both open with the reassurance ('Endpoint resolves.') and cut
 * the NEXT STEP at every width; each gets a ≤ 30-char row form and keeps the
 * full sentence in the title. An unknown notice drops that first sentence.
 */
export function vpnNoticeClause(notice: string): string {
  if (notice === VPN_NOT_STORED_CHECK_NOTICE) return 'not stored yet — launch once';
  if (notice === VPN_NO_API_KEY_CHECK_NOTICE) return 'needs an API key — Settings';
  const rest = notice.replace(/^Endpoint resolves\.\s*/, '').trim();
  return rest === '' ? notice : rest;
}

/** The content width of the tile's rows, measured from a row that always
 *  renders, so the JS caps cut for the column the card is actually in. Read in a
 *  layout effect (before paint — no flash of a wider cut at 178) and kept fresh
 *  by a ResizeObserver where one exists; jsdom measures 0 and keeps the default. */
function useContentWidth(ref: RefObject<HTMLElement | null>): number {
  const [width, setWidth] = useState(DEFAULT_CONTENT_WIDTH);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const read = (): void => {
      const w = el.clientWidth;
      if (w > 0) setWidth(w);
    };
    read();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(read);
    observer.observe(el);
    return () => observer.disconnect();
  }, [ref]);
  return width;
}

/** R8 — the ⋯ menu opens UPWARD (over the body) unless fewer than this many px
 *  of room lie above the dock inside the nearest scroll container, in which
 *  case it opens downward over the next row. Phase C portals it. Polish: 360
 *  (was 320) — the menu grew to max-h 350 so a 13-row menu (Assist + note +
 *  Clear… expanded) has no fold; scripts/gui-visual-check.mjs mirrors it. */
const MENU_FLIP_ROOM_PX = 360;
function roomAbove(el: HTMLElement): number {
  const top = el.getBoundingClientRect().top;
  for (let n = el.parentElement; n !== null; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
      return top - n.getBoundingClientRect().top;
    }
  }
  return top;
}

/** Phase C — the portaled menu's fixed box. Anchored to BOTH card edges inside
 *  the bezel's 6px padding (Phase A's `left-1.5 right-1.5`), 6px below the
 *  card when it opens downward, 6px above the dock when it opens upward — the
 *  exact offsets the absolute menu had (`top-full mt-1.5` / `bottom-[59px]`),
 *  now in viewport coordinates so no ancestor clip can cut it.
 *
 *  Polish — those absolute offsets resolved against the article's PADDING box
 *  (inside its 1px border); `getBoundingClientRect` is the BORDER box. Insetting
 *  the rect by the literal alone made the fixed menu 2px wider than before,
 *  over the border on both sides, and 1px lower when it opened downward. The
 *  border is read from the element (`borderInsets`), never spelled as a
 *  literal, so a bezel change cannot re-open this. */
export interface MenuBox {
  left: number;
  width: number;
  top?: number;
  bottom?: number;
  /** The box's height cap: the class's 350px, or less when the viewport edge
   *  it opens toward is nearer — a fixed box cannot be scrolled INTO view by
   *  the grid (a grid scroll closes it), so it must never leave the viewport;
   *  the rows past the cap scroll inside the menu instead. */
  maxHeight: number;
}
const EMPTY_MENU_BOX: MenuBox = { left: 0, width: 0, top: 0, maxHeight: 350 };
const MENU_INSET_PX = 6;
const MENU_GAP_PX = 6;
/** The element's border widths, from layout: `clientLeft`/`clientTop` are the
 *  near borders; offset − client is BOTH borders on that axis (the article has
 *  no scrollbar — its overflow is visible), so the remainder is the far one.
 *  jsdom reports 0 for all six, so there the padding box IS the rect. */
function borderInsets(el: HTMLElement): { left: number; right: number; bottom: number } {
  const left = el.clientLeft;
  const top = el.clientTop;
  return {
    left,
    right: el.offsetWidth - el.clientWidth - left,
    bottom: el.offsetHeight - el.clientHeight - top,
  };
}
/** The menu's own height cap (mirrors `max-h-[350px]` on the box). */
export const MENU_MAX_HEIGHT_PX = 350;
/** Breathing room kept between the menu and the viewport edge it opens toward. */
export const MENU_VIEWPORT_EDGE_PX = 8;
/** The cap never drops under this: with less room than four rows the menu is
 *  still a menu (it scrolls), not a sliver — the flip rule is what keeps a
 *  menu away from a short side in the first place. */
export const MENU_MIN_HEIGHT_PX = 96;
function clampMenuHeight(room: number): number {
  return Math.max(
    MENU_MIN_HEIGHT_PX,
    Math.min(MENU_MAX_HEIGHT_PX, Math.floor(room - MENU_VIEWPORT_EDGE_PX)),
  );
}
export function menuBoxFor(article: HTMLElement, dock: HTMLElement, below: boolean): MenuBox {
  const a = article.getBoundingClientRect();
  const d = dock.getBoundingClientRect();
  const b = borderInsets(article);
  // Padding-box edges: the border box's, moved in by the border on each side.
  const base = {
    left: a.left + b.left + MENU_INSET_PX,
    width: Math.max(0, a.width - b.left - b.right - 2 * MENU_INSET_PX),
  };
  const viewportHeight =
    typeof window !== 'undefined' ? window.innerHeight : document.documentElement.clientHeight;
  if (below) {
    // `top-full mt-1.5` sat 6px under the padding box: the border box's bottom
    // less the bottom border.
    const top = a.bottom - b.bottom + MENU_GAP_PX;
    return { ...base, top, maxHeight: clampMenuHeight(viewportHeight - top) };
  }
  const menuBottom = d.top - MENU_GAP_PX;
  return {
    ...base,
    bottom: viewportHeight - menuBottom,
    maxHeight: clampMenuHeight(menuBottom),
  };
}

/** Phase C — keyboard scrolling of the sheet's body. The body is the sheet's
 *  only scroller and focus lands on the DIALOG node when the sheet opens (or on
 *  ×), so a browser's default arrow/page scroll would move the nearest
 *  scrollable ANCESTOR of the focused element — the grid behind the sheet —
 *  and the facts under the fold stayed unreachable by keyboard whenever the
 *  card had no trailing note button to Tab to. Returns the new scrollTop, or
 *  null when the key is not a scroll key. `clientHeight` is 0 in jsdom, hence
 *  the page fallback. */
export const SHEET_ARROW_STEP_PX = 32;
export const SHEET_PAGE_FALLBACK_PX = 160;
export function scrollSheetBody(body: HTMLElement, key: string): number | null {
  const page = Math.max(SHEET_PAGE_FALLBACK_PX, body.clientHeight - SHEET_ARROW_STEP_PX);
  const delta =
    key === 'ArrowDown'
      ? SHEET_ARROW_STEP_PX
      : key === 'ArrowUp'
        ? -SHEET_ARROW_STEP_PX
        : key === 'PageDown'
          ? page
          : key === 'PageUp'
            ? -page
            : null;
  if (delta === null) return null;
  const next = Math.max(0, body.scrollTop + delta);
  body.scrollTop = next;
  return next;
}

/** Phase C — the sheet's focus ring: Tab from the last focusable wraps to the
 *  first, Shift+Tab from the first (or from the dialog node itself) to the
 *  last. The dialog is the only overlay on the card, so nothing behind it may
 *  take focus while it is open. */
const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
export function trapTab(
  dialog: HTMLElement,
  e: { shiftKey: boolean; preventDefault(): void },
): void {
  const items = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
  if (items.length === 0) {
    e.preventDefault();
    dialog.focus();
    return;
  }
  const first = items[0] as HTMLElement;
  const last = items[items.length - 1] as HTMLElement;
  const active = document.activeElement;
  if (e.shiftKey) {
    if (active === first || active === dialog || !dialog.contains(active)) {
      e.preventDefault();
      last.focus();
    }
    return;
  }
  if (active === last || !dialog.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

/** Polish — the enabled menu rows, in DOM order (the arrow-key ring). The
 *  rows stay plain <button>s inside a role="group": every suite that reaches a
 *  row by `getByRole('button', …)` keeps working, and a group of buttons is
 *  valid ARIA where a role="menu" of buttons was not. */
function menuItemsOf(menu: HTMLElement | null): HTMLElement[] {
  if (menu === null) return [];
  return Array.from(menu.querySelectorAll<HTMLButtonElement>('button')).filter(
    (el) => !el.disabled,
  );
}
function focusMenuItem(menu: HTMLElement | null, which: 'first' | 'last' | 'next' | 'prev'): void {
  const items = menuItemsOf(menu);
  if (items.length === 0) return;
  const i = items.findIndex((el) => el === document.activeElement);
  const target =
    which === 'first'
      ? items[0]
      : which === 'last'
        ? items[items.length - 1]
        : which === 'next'
          ? items[(i + 1) % items.length]
          : items[i <= 0 ? items.length - 1 : i - 1];
  target?.focus();
}

export function ProfilePhoneCard(p: ProfilePhoneCardProps): JSX.Element {
  // Secondary actions live behind a ⋯ button in the dock so they're
  // tap-discoverable on a trackpad, not hover-only (founder 2026-06-16,
  // matching the visual-demo dock).
  const [actionsOpen, setActionsOpen] = useState(false);
  const [menuBelow, setMenuBelow] = useState(false);
  // Phase C — the portaled menu's fixed-position box, computed from the card's
  // rect the moment it opens (never on render: jsdom measures 0 everywhere).
  const [menuBox, setMenuBox] = useState<MenuBox>(EMPTY_MENU_BOX);
  // Phase C — the details sheet. `detailsOpenerRef` is the control that opened
  // it (the ⓘ glyph or the ⋯ toggle), where focus returns when it closes.
  const [detailsOpen, setDetailsOpen] = useState(p.detailsInitiallyOpen === true);
  const detailsOpenerRef = useRef<HTMLElement | null>(null);
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const sheetBodyRef = useRef<HTMLDivElement | null>(null);
  const sheetTitleId = useId();
  // F3 — inline note editor (opened from the ⋯ menu's "Edit note" row or the
  // meta row's 🗒 glyph). Lives here so the small <textarea> overlays the card
  // body without leaving the grid.
  const [editingNote, setEditingNote] = useState(false);
  const [noteDraft, setNoteDraft] = useState(p.note ?? '');
  const [noteSaving, setNoteSaving] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);
  const noteSaveInFlightRef = useRef(false);
  const commitNote = async (): Promise<void> => {
    if (p.onSaveNote === undefined || noteSaveInFlightRef.current) return;
    noteSaveInFlightRef.current = true;
    setNoteSaving(true);
    setNoteError(null);
    try {
      const error = await p.onSaveNote(noteDraft.trim());
      if (typeof error === 'string' && error.length > 0) {
        setNoteError(error.slice(0, 240));
        return;
      }
      setEditingNote(false);
    } catch {
      setNoteError("Couldn't save the note. Check your connection and try again.");
    } finally {
      noteSaveInFlightRef.current = false;
      setNoteSaving(false);
    }
  };
  // Polish — the control focus goes back to when the editor closes (Cancel,
  // Escape, a saved note): the 🗒 glyph, ⋯ for the menu row — and for the
  // sheet's note row the SHEET's opener (ⓘ or ⋯), the row itself having
  // unmounted with the sheet. Null when nothing focusable opened it.
  const noteEditorReturnRef = useRef<HTMLElement | null>(null);
  const openNoteEditor = (returnTo: HTMLElement | null): void => {
    noteEditorReturnRef.current = returnTo;
    setNoteDraft(p.note ?? '');
    setNoteError(null);
    // Phase C — exclusive overlays: the editor replaces the sheet (its note
    // row is one of the editor's openers) and the menu.
    setDetailsOpen(false);
    setActionsOpen(false);
    setEditingNote(true);
  };
  // Phase C — open the details sheet from a control; the menu and the note
  // editor close (one overlay at a time), and focus returns to that control.
  const openDetails = (opener: HTMLElement | null): void => {
    detailsOpenerRef.current = opener;
    setActionsOpen(false);
    setEditingNote(false);
    setDetailsOpen(true);
  };
  const closeDetails = (): void => setDetailsOpen(false);
  // Dismiss the tap-opened ⋯ menu on an outside pointer-down or Escape — a
  // toggle-opened dropdown that can only be re-toggled shut reads as stuck.
  // Phase B: the menu is a sibling of the screen (it must escape the screen's
  // overflow-hidden to open downward). Polish: "inside" is the ⋯ toggle OR the
  // menu — it was the whole dock, so clicking Launch with the menu open
  // launched AND left the menu standing.
  const articleRef = useRef<HTMLElement | null>(null);
  const footerRef = useRef<HTMLDivElement | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const menuId = useId();
  // Phase C — the same hook dismisses the details sheet: a pointer-down outside
  // the sheet closes it, and so does Escape wherever focus sits. "Inside" is
  // tested on the DOM nodes (menuRef / sheetRef), so the PORTALED menu counts
  // as inside even though it is no descendant of the card.
  useEffect(() => {
    if (!actionsOpen && !detailsOpen) return;
    const onPointerDown = (e: PointerEvent): void => {
      const target = e.target as Node;
      if (actionsOpen) {
        const inside =
          (moreRef.current !== null && moreRef.current.contains(target)) ||
          (menuRef.current !== null && menuRef.current.contains(target));
        if (!inside) setActionsOpen(false);
      }
      if (detailsOpen && sheetRef.current !== null && !sheetRef.current.contains(target)) {
        setDetailsOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      setActionsOpen(false);
      setDetailsOpen(false);
    };
    // A fixed-position menu detaches from its card when the grid scrolls or the
    // window resizes; it closes instead of floating free. A scroll INSIDE the
    // menu (an expanded Clear group scrolling its last row into view) is not
    // the grid scrolling.
    const onScroll = (e: Event): void => {
      if (!actionsOpen) return;
      if (
        menuRef.current !== null &&
        e.target instanceof Node &&
        menuRef.current.contains(e.target)
      )
        return;
      setActionsOpen(false);
    };
    document.addEventListener('pointerdown', onPointerDown, true);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [actionsOpen, detailsOpen]);
  // Phase C — focus management for the sheet: on open, focus moves INTO the
  // dialog (its own node, so the first Tab lands on the close button and a
  // screen reader announces the label); on close, focus returns to the opener
  // when it was inside the sheet or fell to <body> — never when another
  // control (the note editor's textarea) already took it.
  const sheetWasOpenRef = useRef(false);
  useEffect(() => {
    if (detailsOpen) {
      sheetWasOpenRef.current = true;
      sheetRef.current?.focus({ preventScroll: true });
      return;
    }
    if (!sheetWasOpenRef.current) return;
    sheetWasOpenRef.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      detailsOpenerRef.current?.focus({ preventScroll: true });
    }
  }, [detailsOpen]);
  // Polish — the same rule for the note editor. Its textarea took focus on
  // open (autoFocus), so when it unmounts focus falls to <body> and a keyboard
  // user restarted from the top of the page — from the sheet's note row too,
  // where the sheet's own return had (correctly) stood down for the textarea.
  // Declared after the sheet's effect: when the sheet REPLACES the editor the
  // dialog is already focused here, and nothing is stolen back.
  const editorWasOpenRef = useRef(false);
  useEffect(() => {
    if (editingNote) {
      editorWasOpenRef.current = true;
      return;
    }
    if (!editorWasOpenRef.current) return;
    editorWasOpenRef.current = false;
    const returnTo = noteEditorReturnRef.current;
    noteEditorReturnRef.current = null;
    const active = document.activeElement;
    if (active === null || active === document.body) {
      // The opener can be GONE by now: the 🗒 glyph renders only while the
      // profile has a note, and the parent applies a save to its state before
      // `onSaveNote` resolves — so a save that empties the note unmounts the
      // very control that opened the editor. Focusing a detached node is a
      // silent no-op (focus stays on <body>); the ⓘ glyph is always rendered
      // and sits in the same meta row, so it is the fallback.
      const target =
        returnTo !== null && returnTo.isConnected
          ? returnTo
          : articleRef.current?.querySelector<HTMLElement>('[data-action="open-details"]');
      target?.focus({ preventScroll: true });
    }
  }, [editingNote]);
  // Polish — keyboard: closing the menu (Escape, Enter on a row) made the
  // focused row `invisible` and focus fell to <body>, so the next Tab restarted
  // at the top of the page. Focus returns to ⋯ whenever the menu closes with
  // focus inside it (or lost); a menu opened with ArrowDown/ArrowUp focuses its
  // first/last item once the rows are visible.
  const wasOpenRef = useRef(false);
  const focusOnOpenRef = useRef<'first' | 'last' | null>(null);
  useEffect(() => {
    if (actionsOpen) {
      wasOpenRef.current = true;
      const which = focusOnOpenRef.current;
      focusOnOpenRef.current = null;
      if (which !== null) focusMenuItem(menuRef.current, which);
      return;
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    const active = document.activeElement;
    if (
      active === null ||
      active === document.body ||
      (menuRef.current !== null && menuRef.current.contains(active))
    ) {
      moreRef.current?.focus({ preventScroll: true });
    }
  }, [actionsOpen]);
  const toggleMenu = (): void => {
    if (!actionsOpen && footerRef.current !== null) {
      const below = roomAbove(footerRef.current) < MENU_FLIP_ROOM_PX;
      setMenuBelow(below);
      if (articleRef.current !== null) {
        setMenuBox(menuBoxFor(articleRef.current, footerRef.current, below));
      }
    }
    setDetailsOpen(false);
    setActionsOpen((v) => !v);
  };

  const statusRowRef = useRef<HTMLDivElement | null>(null);
  const contentWidth = useContentWidth(statusRowRef);

  const pill = healthPill(p);
  const mode = capsMode(p);
  const chips = visibleChips(p, contentWidth);
  // Mode C has no measured chips, but the row's standing facts (a tunnel
  // carries UDP; why the OS stack cannot be read) are still true before any
  // test — they ride in a '+N' pill beside the button rather than vanishing.
  const firstHints = mode === 'first' ? visibleChips(p, 0).hiddenHints : [];
  const vpn = p.vpn === true;
  const hasNote = p.onSaveNote !== undefined && p.note !== undefined && p.note.trim() !== '';
  // Phase C — the ⓘ glyph is always on the row (every card has a sheet); the
  // note glyph joins it when there is a note: 2 glyphs reserved, else 1.
  const meta = visibleMeta(p, contentWidth, hasNote ? 2 : 1);
  // Phase C — what the sheet lists under Capabilities: every chip the row is
  // eligible for (its text and hint) and every hint that never gets a chip.
  const allCaps = capabilityChips(p);
  const capabilityHints = [
    ...allCaps.eligible.map((c) => `${c.text} — ${c.title}`),
    ...allCaps.hidden,
  ];
  const sheetFingerprint =
    p.osFingerprint ??
    (vpn ? VPN_TUNNEL_OS_FINGERPRINT : p.testing ? OS_FINGERPRINT_MEASURING : undefined);
  // (o) — 'tunnel up' (no number) is a fleet reading too: the vantage attribute
  // names the test Mac, never this Mac (no native probe runs on a tunnel).
  const latencyVantage =
    pill.state === 'ok' || pill.state === 'slow'
      ? p.latencyFromServer === true || p.latencyMs === null
        ? (p.latencyVantage?.measuredFrom ?? 'server')
        : 'this_mac'
      : undefined;

  // R3 — the exit line's states. The flag is rendered ONLY when an exit is
  // known (G12 — the parent's '🌍' never asserts an exit); a null state shows a
  // 13px dashed ring of the flag's width (polish: the ◌ glyph rendered as a
  // 6px speck and the 🚫 emoji was the one saturated pictogram on a muted
  // row), its SHORT clause, and a title that says something the text does not.
  const hasExit = p.hasProxy && (p.exitIp !== null || p.countryCode !== null);
  const exitPlace = p.locationLabel != null && p.locationLabel !== '' ? p.locationLabel : null;
  const socksVerdict = p.capabilities !== null ? proxyVerdict(p.capabilities) : null;
  const exit: { glyph: string | null; text: string; title: string; muted: boolean } = !p.hasProxy
    ? { glyph: null, text: 'no proxy bound', title: 'Choose a proxy in Edit', muted: true }
    : hasExit
      ? {
          glyph: p.flag,
          text: exitPlace ?? p.countryCode ?? p.exitIp ?? '',
          title: [exitPlace ?? p.countryCode, p.exitIp]
            .filter((s): s is string => typeof s === 'string' && s.length > 0)
            .join(' · '),
          muted: false,
        }
      : endpointUnresolved(p)
        ? // (o) — no check can measure an exit through an endpoint that does
          // not resolve; the "run Check VPN" promise is the one thing this line
          // must not make. The SHORT clause stays honest; the title says why.
          {
            glyph: null,
            text: vpn ? VPN_NO_EXIT_YET_SHORT : 'no exit IP',
            title: ENDPOINT_UNRESOLVED_EXIT_TITLE,
            muted: true,
          }
        : vpn
          ? { glyph: null, text: VPN_NO_EXIT_YET_SHORT, title: VPN_NO_EXIT_YET_TITLE, muted: true }
          : p.exitProbeFailed === true
            ? {
                glyph: null,
                text: EXIT_GEO_UNAVAILABLE_SHORT,
                title: EXIT_GEO_UNAVAILABLE_TITLE,
                muted: true,
              }
            : !p.probed && p.capabilities === null
              ? // Polish — never probed reads the LIST's word for this cell
                // ('untested', ProfilesTable) and names the action that fills it.
                { glyph: null, text: 'untested', title: TEST_PROXY_TITLE, muted: true }
              : {
                  glyph: null,
                  text: 'no exit IP',
                  // A failed SOCKS5 explains itself here (its message); a usable
                  // proxy whose last test measured nothing says what fills it.
                  title:
                    socksVerdict !== null && !socksVerdict.ok
                      ? p.capabilities?.message || socksVerdict.label
                      : NO_EXIT_AFTER_TEST_TITLE,
                  muted: true,
                };

  // R4 — via: the proxy's label, or its host:port when it has none.
  const proxyName = p.proxyName != null && p.proxyName !== '' ? p.proxyName : null;
  const proxyAddress = p.proxyAddress != null && p.proxyAddress !== '' ? p.proxyAddress : null;
  const viaTitle =
    proxyName !== null && proxyAddress !== null
      ? `${proxyName} — ${proxyAddress}`
      : (proxyName ?? proxyAddress ?? undefined);

  // R6 — when.
  const runningSince =
    p.running && p.runningSinceIso != null && p.runningSinceIso !== '' ? p.runningSinceIso : null;
  const whenTitle =
    runningSince !== null
      ? `Running since ${new Date(runningSince).toLocaleString()}`
      : p.lastUsedIso !== null
        ? `Last used: ${new Date(p.lastUsedIso).toLocaleString()}`
        : NEVER_LAUNCHED_TITLE;
  // When a VPN failure/notice takes the whole "when" line, the facts it
  // displaces (last used, checked) move into that line's title — and the
  // stamp stays machine-readable on the line (`data-checked-at`).
  const displacedFacts =
    p.checkedAtIso !== null
      ? ` · ${whenTitle} · Checked: ${new Date(p.checkedAtIso).toLocaleString()}`
      : ` · ${whenTitle}`;

  // Polish — which thumb recipe this hue gets (see the identity row).
  const thumbDarkInk = thumbUsesDarkInk(p.hue);

  const dot = (cls: string): JSX.Element => (
    <span aria-hidden="true" className={`mr-1 inline-block h-1.5 w-1.5 rounded-full ${cls}`} />
  );

  return (
    <article
      ref={articleRef}
      role="button"
      tabIndex={0}
      aria-pressed={p.selected}
      aria-label={`Select ${p.name}`}
      onClick={p.onToggleSelect}
      onKeyDown={(e) => {
        // Only the card itself toggles selection on Enter/Space. Without this,
        // a keydown bubbling up from a nested control (Launch, the ⋯ menu, the
        // Retest/Change buttons) would trip selection and pre-empt that
        // control's own keyboard activation — breaking its operability.
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          p.onToggleSelect();
        }
      }}
      // Polish — the bezel: a hairline of white/8% over a slate gradient (the
      // #0a0d12 ring was darker than the page and read as a black outline; the
      // 160° grey-green gradient sat outside the slate family), an inset top
      // highlight + soft drop. Hover DEEPENS the shadow with the 2px lift
      // (`hover:shadow-xl` swapped in a lighter one, so the lift read as a
      // flatten, and rewrote --tw-shadow — which erased the selected ring).
      // Selected = accent2 border + a 2px 35% halo in the RING layer, so it
      // composes with every shadow utility; running = a mint frame visible
      // from across the grid. Focus: a solid ring at 2px offset (the global
      // 40%-alpha outline composited to 1.4:1 — invisible).
      className={`group relative cursor-pointer rounded-[24px] border p-1.5 transition-[transform,box-shadow,border-color] duration-150 hover:-translate-y-0.5 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.06),0_18px_40px_rgba(0,0,0,0.45)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover focus-visible:ring-offset-2 focus-visible:ring-offset-surface-base ${
        p.selected
          ? 'border-accent-hover ring-2 ring-accent-hover/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_30px_rgba(0,0,0,0.35)]'
          : p.running
            ? 'border-status-ready/35 shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_30px_rgba(0,0,0,0.35)]'
            : 'border-white/[0.08] shadow-[inset_0_1px_0_rgba(255,255,255,0.04),0_10px_30px_rgba(0,0,0,0.35)]'
      }`}
      style={{ background: 'linear-gradient(180deg,#141c2f,#0c1322)' }}
    >
      {/* SCREEN — a FIXED 220px of glass (Phase B: no aspect ratio, so the
          card's height depends on neither its width nor its state). */}
      <div
        data-component="phone-screen"
        className="relative flex h-[220px] min-w-0 flex-col overflow-hidden rounded-[17px] bg-surface-raised"
      >
        {/* F3 — inline note editor overlay. Floats over the screen so it never
            reshapes the card; stops propagation so typing/saving never toggles
            selection. Enter saves, Shift+Enter newlines, Escape cancels. */}
        {editingNote ? (
          <div
            className="absolute inset-0 z-40 flex flex-col gap-2 bg-surface-raised/95 p-3 backdrop-blur-sm"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => e.stopPropagation()}
          >
            <span className="text-[11px] font-semibold text-ink-secondary">Note</span>
            <textarea
              autoFocus
              aria-label={`Note for ${p.name}`}
              value={noteDraft}
              disabled={noteSaving}
              maxLength={280}
              rows={5}
              placeholder="Add a note…"
              onChange={(e) => setNoteDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void commitNote();
                } else if (e.key === 'Escape') {
                  setNoteDraft(p.note ?? '');
                  setEditingNote(false);
                }
              }}
              className="min-h-0 flex-1 resize-none rounded-lg border border-surface-divider bg-surface-inset px-2 py-1.5 text-[11.5px] text-ink-primary placeholder:text-ink-muted focus:border-accent focus:outline-none"
            />
            {noteError !== null ? (
              <p role="alert" className="text-[10px] text-status-error">
                {noteError}
              </p>
            ) : null}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                disabled={noteSaving}
                onClick={() => {
                  setNoteDraft(p.note ?? '');
                  setNoteError(null);
                  setEditingNote(false);
                }}
                className="rounded-lg border border-surface-divider px-2.5 py-1 text-[11px] font-medium text-ink-secondary transition-colors hover:text-ink-primary"
              >
                Cancel
              </button>
              <button
                type="button"
                disabled={noteSaving}
                aria-busy={noteSaving}
                onClick={() => void commitNote()}
                className="btn-primary text-[11px]"
              >
                {noteSaving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </div>
        ) : null}
        {/* Phase C — the DETAILS SHEET: every fact the tile cut, at full length,
            in a role="dialog" that covers the screen AND the dock (absolute
            inset-0 inside the screen, like the note editor — the card is never
            reshaped, the dock is covered, not displaced). The body scrolls
            vertically inside the sheet; nothing scrolls the screen. Clicks and
            keys stop here so they never toggle selection; Escape closes; Tab
            is trapped (`trapTab`). */}
        {detailsOpen ? (
          <div
            ref={sheetRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={sheetTitleId}
            tabIndex={-1}
            data-component="card-details-sheet"
            className="absolute inset-0 z-40 flex flex-col bg-surface-raised/95 backdrop-blur-sm focus-visible:outline-none"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Escape') {
                e.preventDefault();
                closeDetails();
              } else if (e.key === 'Tab' && sheetRef.current !== null) {
                trapTab(sheetRef.current, e);
              } else if (
                sheetBodyRef.current !== null &&
                scrollSheetBody(sheetBodyRef.current, e.key) !== null
              ) {
                // Arrow / Page keys scroll the BODY wherever focus sits in the
                // sheet (the dialog node, ×, the body, the note row) — never the
                // grid behind it (the browser default for a non-scrolling
                // focused element).
                e.preventDefault();
              }
            }}
          >
            <div className="flex h-7 shrink-0 items-center gap-1.5 border-b border-white/[0.06] pl-2.5 pr-1.5">
              <span
                id={sheetTitleId}
                className="min-w-0 flex-1 truncate text-[11px] font-semibold leading-4 text-ink-primary"
                title={p.name}
              >
                {p.name}
              </span>
              <button
                type="button"
                data-action="close-details"
                aria-label="Close details"
                title="Close (Esc)"
                onClick={closeDetails}
                className="grid h-5 w-5 shrink-0 place-items-center rounded text-[13px] leading-none text-ink-secondary transition-colors hover:bg-white/10 hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
              >
                ×
              </button>
            </div>
            {/* The body is a focus stop (tabIndex 0 — a scrollable region must
                be reachable by Tab, and `trapTab`'s ring includes it between ×
                and the note row) with an inset focus ring so the stop is
                visible; the arrow/page keys above scroll it from anywhere in
                the sheet. */}
            <div
              ref={sheetBodyRef}
              data-component="card-details-body"
              tabIndex={0}
              className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-2.5 py-1.5 text-[10.5px] leading-4 text-ink-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-accent-hover"
            >
              <dl className="flex flex-col gap-1.5">
                {/* Exit — the address the tile keeps in its title. A muted
                    state shows its word AND the sentence the tile hides. */}
                <DetailRow fact="exit" label="Exit">
                  <div data-component="exit-row" className="flex flex-col gap-px">
                    {hasExit ? (
                      <>
                        <span className="break-words text-ink-primary">
                          <span aria-hidden="true">{exit.glyph} </span>
                          {exitPlace ?? p.countryCode ?? ''}
                        </span>
                        {p.exitIp !== null ? (
                          <span className="mono break-all text-[9.5px] text-ink-secondary">
                            {p.exitIp}
                          </span>
                        ) : null}
                      </>
                    ) : (
                      <>
                        <span className="italic text-ink-muted">{exit.text}</span>
                        <span className="text-ink-muted">{exit.title}</span>
                      </>
                    )}
                  </div>
                </DetailRow>
                {p.hasProxy ? (
                  <DetailRow fact="proxy" label={vpn ? 'VPN' : 'Proxy'}>
                    <div className="flex flex-col gap-px">
                      <span className="break-words text-ink-primary">{proxyName ?? '—'}</span>
                      {proxyAddress !== null ? (
                        <span className="mono break-all text-[9.5px]">{proxyAddress}</span>
                      ) : null}
                      {vpn ? <span className="text-ink-muted">{VPN_TAG_TITLE}</span> : null}
                      {!p.proxyExplicit ? (
                        <span className="text-ink-muted">
                          Inherited default — no proxy chosen for this profile.
                        </span>
                      ) : null}
                    </div>
                  </DetailRow>
                ) : null}
                <DetailRow fact="status" label="Status">
                  <span className="text-ink-primary">{pill.text}</span>
                  <span className="text-ink-muted"> — {pill.title}</span>
                </DetailRow>
                {p.hasProxy ? (
                  <DetailRow fact="capabilities" label="Capabilities">
                    <div className="flex flex-col gap-1">
                      {!vpn && p.capabilities !== null ? (
                        <ProxyCapabilityChips
                          result={p.capabilities}
                          quicMeasured={p.quicMeasured}
                          quicProbe={p.quicProbe}
                          size="xs"
                        />
                      ) : null}
                      {vpn && allCaps.eligible.some((c) => c.key !== 'os') ? (
                        <div className="flex flex-wrap items-center gap-1">
                          {allCaps.eligible
                            .filter((c) => c.key !== 'os')
                            .map((c) => (
                              <span
                                key={c.key}
                                {...c.attrs}
                                title={c.title}
                                className={`${CHIP_BASE} ${c.className}`}
                              >
                                {c.text}
                              </span>
                            ))}
                        </div>
                      ) : null}
                      <ProxyOsChip fingerprint={sheetFingerprint} size="xs" />
                      <ul data-component="capability-hints" className="flex flex-col gap-px">
                        {capabilityHints.map((hint) => (
                          <li key={hint} className="break-words text-ink-muted">
                            {hint}
                          </li>
                        ))}
                      </ul>
                    </div>
                  </DetailRow>
                ) : null}
                {vpn && p.vpnFailure !== undefined ? (
                  <DetailRow fact="vpn-failure" label="Tunnel">
                    <p data-component="proxy-vpn-failure" className="break-words text-status-error">
                      {p.vpnFailure}
                    </p>
                  </DetailRow>
                ) : null}
                {vpn && p.vpnNotice !== undefined ? (
                  <DetailRow fact="vpn-notice" label="Notice">
                    <p data-component="proxy-vpn-notice" role="status" className="break-words">
                      {p.vpnNotice}
                    </p>
                  </DetailRow>
                ) : null}
                {p.hasProxy ? (
                  <DetailRow fact="checked" label="Checked">
                    {p.checkedAtIso !== null ? (
                      <span data-component="proxy-checked-at" data-checked-at={p.checkedAtIso}>
                        <time dateTime={p.checkedAtIso}>
                          {new Date(p.checkedAtIso).toLocaleString()}
                        </time>
                      </span>
                    ) : (
                      <span className="italic text-ink-muted">never checked</span>
                    )}
                  </DetailRow>
                ) : null}
                <DetailRow fact="last-used" label={runningSince !== null ? 'Running' : 'Last used'}>
                  <span data-component="profile-last-used">
                    {runningSince !== null ? (
                      <>
                        since{' '}
                        <time dateTime={runningSince}>
                          {new Date(runningSince).toLocaleString()}
                        </time>
                      </>
                    ) : p.lastUsedIso !== null ? (
                      <time dateTime={p.lastUsedIso}>
                        {new Date(p.lastUsedIso).toLocaleString()}
                      </time>
                    ) : (
                      <span className="italic text-ink-muted">never launched</span>
                    )}
                  </span>
                </DetailRow>
                {p.sizeLabel !== undefined ? (
                  <DetailRow fact="size" label="Stored">
                    {p.sizeLabel !== '—' ? (
                      <span
                        data-component="profile-size"
                        title={`Stored profile size (encrypted browser state): ${p.sizeLabel}`}
                      >
                        {p.sizeLabel} stored
                      </span>
                    ) : (
                      <span className="italic text-ink-muted">not saved yet</span>
                    )}
                  </DetailRow>
                ) : null}
                {p.folder !== '' || p.tags.length > 0 ? (
                  <DetailRow fact="tags" label="Folder & tags">
                    <div data-component="tags-row" className="flex flex-wrap items-center gap-1">
                      {p.folder !== '' ? (
                        <span className="break-words rounded-full bg-ink-muted/15 px-1.5 text-[9.5px] leading-[15px] text-ink-secondary">
                          📁 {p.folder}
                        </span>
                      ) : null}
                      {p.tags.map((tag) => (
                        <span
                          key={tag}
                          className="break-words rounded-full bg-ink-muted/15 px-1.5 text-[9.5px] leading-[15px] text-ink-secondary"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </DetailRow>
                ) : null}
                {p.onSaveNote !== undefined ? (
                  <DetailRow fact="note" label="Note">
                    {/* The note row IS the editor's opener: clicking it swaps the
                        sheet for the textarea (one overlay at a time). */}
                    <button
                      type="button"
                      data-component="profile-note"
                      aria-label={
                        hasNote ? `Note on ${p.name} — click to edit` : `Add a note to ${p.name}`
                      }
                      onClick={() => openNoteEditor(detailsOpenerRef.current)}
                      className="w-full whitespace-pre-wrap break-words rounded-md border border-surface-divider bg-white/[0.03] px-1.5 py-1 text-left text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
                    >
                      {hasNote ? p.note : 'Add note…'}
                    </button>
                  </DetailRow>
                ) : p.note !== undefined && p.note.trim() !== '' ? (
                  <DetailRow fact="note" label="Note">
                    <p data-component="profile-note" className="whitespace-pre-wrap break-words">
                      {p.note}
                    </p>
                  </DetailRow>
                ) : null}
              </dl>
            </div>
          </div>
        ) : null}
        {/* Polish — ONE identity-hue wash: a radial from above the top edge
            that fades out by 60%, so the top third glows and the body stays on
            the raised surface (the full-screen tint + blurred disc + vignette
            coloured whole screens green/purple/brown and cost every 9–10px
            text its contrast). */}
        <div
          aria-hidden="true"
          data-component="screen-wash"
          className="pointer-events-none absolute inset-0"
          style={{
            background: `radial-gradient(120% 55% at 50% -10%, hsl(${p.hue} 60% 55% / 0.28), transparent 60%)`,
          }}
        />
        {/* top gloss */}
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0 top-0 z-[5] h-1/3 bg-gradient-to-b from-white/[0.07] to-transparent"
        />

        {/* T-19 — selection marker. The whole card toggles selection on click
            (the article), so this is only an indicator — but it must be visible
            BEFORE hover: the owner (#5) read the old opacity-0-until-hover ring
            as no way to select at all. Hollow ring when unselected, filled accent
            check when selected, never opacity-0. Its tooltip is the one place on
            the card that says what a click does; it takes pointer events so the
            tooltip shows, and its click bubbles to the article like any other
            spot. Not on the article itself: a card-level title would leak onto
            the untitled Launch button as its hover text. Phase B: it sits over
            the identity row's left gutter (R1 has pl-5), never under the name.
            Polish: a 1.5px white/35 ring with no fill (the filled disc competed
            with the thumbnail), and z-[15] — above the body (z-10), BELOW the
            ⋯ menu (z-20, a sibling of the screen in the same stacking context):
            at z-30 it painted through the open menu's top row. */}
        <span
          data-component="select-indicator"
          aria-hidden="true"
          title={p.selected ? 'Selected — click to deselect' : 'Click to select'}
          className={`absolute left-1.5 top-[7px] z-[15] grid h-4 w-4 place-items-center rounded-full text-[9px] font-bold transition-all ${
            p.selected
              ? 'bg-accent text-white shadow-[0_0_0_1px_rgba(0,0,0,0.35)] group-hover:bg-accent-hover'
              : 'border-[1.5px] border-white/35 bg-transparent text-transparent group-hover:border-white/70'
          }`}
        >
          ✓
        </span>

        {/* BODY — eight fixed single-line regions. `overflow-hidden`, never a
            scroll: every child has an explicit height, so the sum (173px) is the
            body, and nothing can be below a fold that does not exist.
            Polish rhythm — padding 6+4 and gaps 5/4/2/4/4/2 (= 21): exit + via
            read as a pair, status and caps as separate blocks (the flat
            4/3/3/3/3/3 made every row equidistant). 10 + 142 + 21 = 173. */}
        <div
          data-component="card-body"
          className="relative z-10 flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden px-2.5 pb-1 pt-1.5"
        >
          {/* R1 · identity — thumbnail + name over device (the device chip moved
              here from the old status bar, N10). Both lines truncate + title.
              Polish: TWO thumb recipes keyed by hue — white on the old L54→L38
              gradient measured 1.7–2.7:1 for half the hue wheel, and no single
              gradient passes 4.5 with either ink at every hue (the cyan and
              orange troughs fail both). Hues 4–175 (orange → cyan) get a
              LIGHT gradient (L58→L52) with the inverted ink; 176–3 (blue →
              magenta → red) a DARK one (L32→L24) with white — searched over
              the hue wheel at BOTH gradient stops, worst hue 4.64. The explicit
              background-color is the recipe's worst-case stop, so a contrast
              reader that cannot see gradients measures the honest floor. */}
          <div
            data-region="identity"
            className="mb-[5px] flex h-[38px] shrink-0 items-center gap-2 overflow-hidden pl-5"
          >
            <span
              data-component="identity-thumb"
              data-ink={thumbDarkInk ? 'dark' : 'white'}
              className={`relative grid h-[38px] w-[22px] shrink-0 place-items-center rounded-[5px] font-bold ring-1 ring-white/25 ${
                thumbDarkInk ? 'text-ink-inverted' : 'text-white'
              } ${p.icon ? 'text-[12px]' : 'text-[9px]'}`}
              style={{
                backgroundColor: thumbDarkInk
                  ? `hsl(${(p.hue + 34) % 360} 52% 52%)`
                  : `hsl(${p.hue} 58% 32%)`,
                backgroundImage: thumbDarkInk
                  ? `linear-gradient(145deg, hsl(${p.hue} 58% 58%), hsl(${(p.hue + 34) % 360} 52% 52%))`
                  : `linear-gradient(145deg, hsl(${p.hue} 58% 32%), hsl(${(p.hue + 34) % 360} 52% 24%))`,
              }}
            >
              {p.icon ? p.icon : p.monogram}
              {p.running ? (
                // The ONE pulsing dot on a live tile (1.6s, haloed by the
                // raised surface so it separates from the thumb).
                <span
                  aria-hidden="true"
                  data-component="thumb-live-dot"
                  className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 animate-pulse rounded-full bg-status-ready ring-2 ring-surface-raised [animation-duration:1.6s]"
                />
              ) : null}
            </span>
            <div className="flex min-w-0 flex-1 flex-col justify-center">
              <p
                className="truncate text-[12.5px] font-semibold leading-4 text-ink-primary"
                title={p.name}
              >
                {p.name}
              </p>
              <p
                className="truncate text-[10px] leading-[14px] text-ink-secondary"
                title={p.deviceLabel}
              >
                {p.deviceLabel}
              </p>
            </div>
          </div>

          {/* R2 · status — session pill (list parity: 'Live' | 'Idle'; launching
              stays 'Idle', as the list does) + ONE health pill (healthPill). */}
          <div
            ref={statusRowRef}
            data-region="status"
            className="mb-1 flex h-5 shrink-0 items-center gap-1.5 overflow-hidden"
          >
            {p.running ? (
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[9.5px] font-semibold uppercase leading-4 tracking-wider text-status-ready">
                <span className="h-1.5 w-1.5 rounded-full bg-status-ready shadow-[0_0_6px_rgb(var(--status-ready-rgb))]" />
                Live
              </span>
            ) : (
              <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap text-[9.5px] font-semibold uppercase leading-4 tracking-wider text-ink-secondary">
                <span className="h-1.5 w-1.5 rounded-full border border-ink-muted" />
                Idle
              </span>
            )}
            {/* Polish: flush right (`ml-auto`), so rows 2 and 6 share one
                label-left / value-right rhythm. */}
            <span
              data-component="health-pill"
              data-health={pill.state}
              data-latency-vantage={latencyVantage}
              title={pill.title}
              className={`ml-auto min-w-0 truncate whitespace-nowrap rounded-[5px] px-1.5 py-px text-[10px] font-semibold leading-4 ${HEALTH_TONE_CLASS[pill.tone]}`}
            >
              {pill.state === 'checking' ? dot('animate-pulse bg-ink-muted') : null}
              {pill.text}
            </span>
          </div>

          {/* R3 · exit — flag + place (the exit IP rides in the title; the list's
              Exit IP column is where IPs are scanned). The CC chip is gone. */}
          <div
            data-region="exit"
            data-component="exit-location"
            className="mb-[2px] flex h-[18px] shrink-0 items-center gap-[5px] overflow-hidden"
          >
            {exit.glyph !== null ? (
              <span aria-hidden="true" className="shrink-0 text-[13px] leading-none">
                {exit.glyph}
              </span>
            ) : (
              <span
                aria-hidden="true"
                data-component="exit-placeholder"
                className="h-[13px] w-[13px] shrink-0 rounded-full border-[1.5px] border-dashed border-ink-muted opacity-70"
              />
            )}
            <span
              className={`min-w-0 flex-1 truncate text-[10.5px] leading-4 ${
                exit.muted ? 'italic text-ink-muted' : 'text-ink-secondary'
              }`}
              title={exit.title}
            >
              {exit.text}
            </span>
            {p.exitTz != null && p.exitTz !== '' ? (
              <span
                className="max-w-[40px] shrink-0 truncate text-[9px] leading-4 text-ink-muted"
                title={p.exitTz}
              >
                {p.exitTz}
              </span>
            ) : null}
          </div>

          {/* R4 · via — WHICH proxy (its label, or host:port when unnamed), a VPN
              tag for tunnels (N3), and the inherited-default badge (N5). The row
              keeps its height with no proxy so every card's rows line up. */}
          <div
            data-region="via"
            {...(p.hasProxy && (proxyName !== null || proxyAddress !== null)
              ? { 'data-component': 'profile-card-proxy-name' }
              : {})}
            className="mb-1 flex h-4 shrink-0 items-center gap-[5px] overflow-hidden"
          >
            {p.hasProxy ? (
              <>
                {vpn ? (
                  // Polish: the same oxblood tint with a LIGHT rose ink (the
                  // accent token on its own tint measured 1.9:1), and a title
                  // that says what VPN means here — not the Check VPN sentence.
                  <span
                    data-component="proxy-vpn-tag"
                    className={`shrink-0 rounded bg-accent-subtle px-1 text-[9px] font-semibold uppercase leading-4 tracking-wide ${SOFT_ACCENT_INK}`}
                    title={VPN_TAG_TITLE}
                  >
                    VPN
                  </span>
                ) : (
                  <span className="shrink-0 text-[9px] font-semibold uppercase leading-4 tracking-wider text-ink-muted">
                    via
                  </span>
                )}
                <span
                  className={`min-w-0 flex-1 truncate leading-4 ${
                    proxyName !== null
                      ? 'text-[10.5px] text-ink-secondary'
                      : proxyAddress !== null
                        ? // 9.5px: Berkeley Mono's x-height at 10px outweighed the
                          // 10.5px place name directly above it.
                          'mono text-[9.5px] text-ink-secondary'
                        : 'text-[10.5px] text-ink-muted'
                  }`}
                  title={viaTitle ?? '—'}
                >
                  {proxyName ?? proxyAddress ?? '—'}
                </span>
                {!p.proxyExplicit && (
                  // An inherited default, not a choice. Saying so is what stops a
                  // second proxy silently moving every profile that never picked one.
                  // Polish: lowercase in a hairline box (the comp's .dflt) — the
                  // uppercase tracked 'DEFAULT' ate two glyphs of the label.
                  <span
                    data-component="proxy-inherited-badge"
                    title="No proxy chosen for this profile — it uses the first saved proxy, and will follow whichever that is."
                    className="shrink-0 rounded border border-surface-divider px-1 text-[9px] font-medium leading-[14px] text-ink-secondary"
                  >
                    default
                  </span>
                )}
              </>
            ) : (
              // Polish: the row keeps its height with no glyph — a bare '—'
              // under 'no proxy bound' read as broken data.
              <span aria-hidden="true" className="h-4" />
            )}
          </div>

          {/* R5 · capability / repair — exactly one of four modes (capsMode). */}
          <div
            data-region="caps"
            data-caps-mode={mode}
            className="mb-1 flex h-5 shrink-0 items-center gap-1 overflow-hidden"
          >
            {mode === 'none' ? (
              <span aria-hidden="true" className="h-4" />
            ) : mode === 'repair' ? (
              // A proxy that FAILED its last test (or a tunnel the fleet could
              // not bring up) gets its two actions ON the card. No label text
              // here — the health pill carries the verdict (B5).
              <div
                data-component="proxy-broken-banner"
                data-vpn-failure={vpn && p.vpnFailure !== undefined ? 'true' : 'false'}
                role="status"
                className="flex items-center gap-1.5"
              >
                <button
                  type="button"
                  data-action="retest-proxy"
                  disabled={p.testing || p.testDisabled}
                  aria-busy={p.testing}
                  onClick={(e) => {
                    // The card body is itself clickable (select), so a bare
                    // click here would also toggle the row.
                    e.stopPropagation();
                    p.onTest();
                  }}
                  // Polish: OUTLINED repair button (the comp's), soft red ink;
                  // in flight it is the neutral busy button at full opacity —
                  // busy is not unavailable, and the in-flight word was the
                  // least readable thing on the card at 50%. Only testDisabled
                  // dims. Hover only while enabled; an inset focus ring (the
                  // 20px row clips an offset one).
                  className={`shrink-0 whitespace-nowrap rounded-md border px-2 py-px text-[10px] font-semibold leading-4 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover ${
                    p.testing
                      ? 'cursor-progress border-surface-divider bg-surface-elevated text-ink-secondary'
                      : `border-status-error/45 bg-status-error/10 ${SOFT_ERROR_INK} enabled:hover:bg-status-error/20 disabled:opacity-50`
                  }`}
                >
                  {p.testing
                    ? vpn
                      ? 'Checking…'
                      : 'Testing…'
                    : vpn || p.endpoint != null
                      ? // A row holding a pre-flight re-runs it (the grid's word
                        // for both buttons once a pre-flight exists).
                        RECHECK_ACTION
                      : RETEST_ACTION}
                </button>
                {p.onEdit !== undefined && (
                  // Straight to the edit modal, which is where the proxy is
                  // chosen — "retest or change more conveniently" needs both
                  // to be one click from the card that reports the problem.
                  <button
                    type="button"
                    data-action="change-proxy"
                    disabled={p.anyBusy}
                    onClick={(e) => {
                      e.stopPropagation();
                      p.onEdit?.();
                    }}
                    className="shrink-0 whitespace-nowrap rounded-md border border-surface-divider bg-white/[0.04] px-2 py-px text-[10px] font-semibold leading-4 text-ink-secondary transition-colors enabled:hover:bg-surface-divider focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover disabled:opacity-50"
                  >
                    Change
                  </button>
                )}
              </div>
            ) : mode === 'first' ? (
              // Nothing measured yet: the list's inline Test, by its one name.
              // While the test runs the pill already says 'Testing…'; the
              // button keeps its word, disabled.
              <button
                type="button"
                data-action="retest-proxy"
                disabled={p.testing || p.testDisabled}
                aria-busy={p.testing}
                title={vpn ? CHECK_VPN_TITLE : TEST_PROXY_TITLE}
                onClick={(e) => {
                  e.stopPropagation();
                  p.onTest();
                }}
                className={`shrink-0 whitespace-nowrap rounded-md border border-surface-divider px-2 py-px text-[10px] font-semibold leading-4 text-ink-secondary transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover ${
                  p.testing
                    ? 'cursor-progress bg-surface-elevated'
                    : 'bg-white/[0.04] enabled:hover:bg-surface-divider enabled:hover:text-ink-primary disabled:opacity-50'
                }`}
              >
                {vpn ? CHECK_VPN_ACTION : 'Test'}
              </button>
            ) : null}
            {mode === 'first' && firstHints.length > 0 ? (
              <span
                data-component="caps-overflow"
                title={firstHints.join('\n')}
                className={`${CHIP_BASE} ${OVERFLOW_PILL_CLASS}`}
              >
                +{firstHints.length}
              </span>
            ) : null}
            {mode === 'measured' ? (
              <>
                {chips.chips.map((c) => (
                  <span
                    key={c.key}
                    {...c.attrs}
                    title={c.title}
                    className={`${CHIP_BASE} ${c.className}`}
                  >
                    {c.text}
                  </span>
                ))}
                {chips.hiddenHints.length > 0 ? (
                  <span
                    data-component="caps-overflow"
                    title={chips.hiddenHints.join('\n')}
                    className={`${CHIP_BASE} ${OVERFLOW_PILL_CLASS}`}
                  >
                    +{chips.hiddenHints.length}
                  </span>
                ) : null}
              </>
            ) : null}
          </div>

          {/* R6 · when — last used / running-since ⟷ checked; a VPN failure or
              notice takes the whole line (list parity: one line, full text in
              the title; the four-line paragraph is gone, D4). */}
          <div
            data-region="when"
            className="mb-[2px] flex h-[14px] shrink-0 items-center justify-between gap-1 overflow-hidden text-[9.5px] leading-[14px] text-ink-muted"
          >
            {vpn && p.vpnFailure !== undefined ? (
              // Polish: the row shows the CAUSE (the clause after the fleet's
              // preamble), which the pill above does not; the whole sentence,
              // the notice and the displaced facts stay in the title.
              <div
                data-component="proxy-vpn-failure"
                data-checked-at={p.checkedAtIso ?? undefined}
                className="min-w-0 flex-1 truncate text-status-error"
                title={`${p.vpnNotice !== undefined ? `${p.vpnFailure} — ${p.vpnNotice}` : p.vpnFailure}${displacedFacts}`}
              >
                {vpnFailureClause(p.vpnFailure)}
              </div>
            ) : vpn && p.vpnNotice !== undefined ? (
              // (h) — the tunnel test was NOT RUN: a notice in muted ink, never
              // the red banner (and never the busy amber: on this tile that is
              // the slow-latency colour, and a not-run notice is not a caution).
              // Polish: the row shows the NEXT STEP, the sentence is the title.
              <div
                data-component="proxy-vpn-notice"
                role="status"
                data-checked-at={p.checkedAtIso ?? undefined}
                className="min-w-0 flex-1 truncate text-ink-muted"
                title={`${p.vpnNotice}${displacedFacts}`}
              >
                {vpnNoticeClause(p.vpnNotice)}
              </div>
            ) : (
              <>
                {/* Polish: compact forms on both halves, the left fact has
                    priority (it never collapses to '3 m…'), the right half
                    is ONE label in ONE case, terse ('checked 3 mo' — the
                    comp's whole-uppercase 'CHECKED 3 MO AGO' measured 108px
                    against the 100px the 178px column leaves beside '3 mo
                    ago', so it truncated on 23 of 26 tiles; 'CHECKED 3 months
                    ago' mixed two cases; with 'ago' it still lost to 'never
                    launched'). It truncates first. Absolute stamps live in
                    the titles. */}
                <span
                  className={`truncate ${p.checkedAtIso !== null ? 'max-w-[60%] shrink-0' : 'min-w-0'}`}
                  title={whenTitle}
                >
                  {runningSince !== null ? (
                    <>running {formatElapsed(runningSince)}</>
                  ) : p.lastUsedIso !== null ? (
                    <time dateTime={p.lastUsedIso}>{compactAgo(p.lastUsedIso)}</time>
                  ) : (
                    'never launched'
                  )}
                </span>
                {/* (h) finding 5 — WHEN the proxy was last checked. For a VPN
                    row the parent dates this from the fleet's own answer. */}
                {p.checkedAtIso !== null && (
                  <span
                    data-component="proxy-checked-at"
                    data-checked-at={p.checkedAtIso}
                    className="min-w-0 truncate whitespace-nowrap text-[9px] tracking-tight"
                    title={`Checked: ${new Date(p.checkedAtIso).toLocaleString()}`}
                  >
                    checked <time dateTime={p.checkedAtIso}>{terseAgo(p.checkedAtIso)}</time>
                  </span>
                )}
              </>
            )}
          </div>

          {/* R7 · meta — folder + tag pills, JS-capped with a '+N' tail that names
              what was hidden; the note is a glyph (its text in the title, click
              to edit). Empty row when nothing applies — the height is kept. */}
          {/* Polish: no row-level title — each pill and the '+N' tail carry
              their own, and a title that only surfaced between pills was
              information with no affordance. doc-150 item 5 (`sizeLabel`)
              moved to a static row in the ⋯ menu. Pills
              are the comp's: a translucent slate fill, no border (three
              outlined boxes read as a toolbar); '+N' is the dashed tail the
              caps row also wears. Tags stay neutral — the accent is Launch's
              (the comp's rose tag was a second accent tint). */}
          <div data-region="meta" className="flex h-4 shrink-0 items-center gap-1 overflow-hidden">
            {meta.pills.map((pill) =>
              pill.kind === 'folder' ? (
                <span
                  key="folder"
                  className="h-[15px] max-w-[72px] shrink-0 truncate rounded-full bg-ink-muted/15 px-1.5 text-[9px] leading-[15px] text-ink-secondary"
                  title={pill.title}
                >
                  📁 {p.folder}
                </span>
              ) : (
                <span
                  key={`tag-${pill.text}`}
                  className="h-[15px] max-w-[50px] shrink-0 truncate rounded-full bg-ink-muted/15 px-1.5 text-[9px] leading-[15px] text-ink-secondary"
                  title={pill.title}
                >
                  {pill.text}
                </span>
              ),
            )}
            {meta.hidden.length > 0 ? (
              <span
                data-component="tags-overflow"
                className="h-[15px] shrink-0 whitespace-nowrap rounded-full border border-dashed border-surface-divider bg-transparent px-1.5 text-[9px] leading-[13px] text-ink-muted"
                title={meta.hidden.join(' · ')}
              >
                +{meta.hidden.length}
              </span>
            ) : null}
            {/* Phase C — the trailing glyphs visibleMeta reserved: 🗒 (a note)
                and ⓘ (always — the sheet is every card's click-opened depth). */}
            <span className="ml-auto flex shrink-0 items-center gap-1">
              {hasNote ? (
                // Polish: a 16px box so the inset focus ring has room (a 14×11
                // glyph showed a partial arc), hover fades 150ms like its peers.
                <button
                  type="button"
                  data-component="profile-note"
                  aria-label={`Edit the note on ${p.name}`}
                  title={`${p.note ?? ''} — Click to edit note`}
                  onClick={(e) => {
                    e.stopPropagation();
                    openNoteEditor(e.currentTarget);
                  }}
                  className="grid h-4 w-4 shrink-0 place-items-center rounded text-[11px] leading-none text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
                >
                  🗒
                </button>
              ) : null}
              <button
                type="button"
                data-action="open-details"
                aria-label={`Details for ${p.name}`}
                aria-haspopup="dialog"
                aria-expanded={detailsOpen}
                title="Details — every fact about this profile, in full"
                onClick={(e) => {
                  e.stopPropagation();
                  openDetails(e.currentTarget);
                }}
                className="grid h-4 w-4 shrink-0 place-items-center rounded text-[11.5px] font-semibold leading-none text-ink-secondary transition-colors hover:text-ink-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-hover"
              >
                ⓘ
              </button>
            </span>
          </div>
        </div>

        {/* R8 · dock — Launch/Open (flex-1) + a persistent ⋯ for the secondary
            actions, mirroring the visual-demo dock (founder 2026-06-16). Outside
            the body, so no state can push it anywhere. */}
        {/* Polish: a hairline of white/6% (the divider token was a bright rule
            across every tile); Launch is a 30px 12px/600 block (the 29.25px
            fractional height blurred its edge); live → the mint tint carried
            into the dock, launching → the neutral busy button at FULL opacity
            (the 50%-dimmed accent read as a broken Launch — busy is not
            unavailable; only launchDisabled dims); ⋯ is a white/6% fill with no
            border. Both get a solid focus ring at 2px offset. */}
        <div
          ref={footerRef}
          data-component="card-dock"
          className="relative z-10 flex h-[47px] shrink-0 items-center gap-1.5 border-t border-white/[0.06] bg-white/[0.03] px-2.5"
        >
          <button
            type="button"
            className={`h-[30px] min-w-0 flex-1 truncate whitespace-nowrap rounded-[10px] px-1 py-0 text-center text-[12px] font-semibold leading-[30px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised ${
              p.running
                ? 'bg-status-ready/[0.18] text-status-ready enabled:hover:bg-status-ready/25 disabled:opacity-50'
                : p.launching
                  ? 'cursor-progress bg-ink-muted/15 text-ink-secondary'
                  : 'bg-accent text-white shadow-[0_3px_10px_rgba(0,0,0,0.4),inset_0_1px_0_rgba(255,255,255,0.18)] enabled:hover:bg-accent-hover disabled:opacity-50'
            }`}
            disabled={p.busy || (!p.running && p.launchDisabled)}
            aria-busy={!p.running && p.launching}
            // A truncating control carries a title: the disabled reason, the
            // saved-tabs promise (N11), else a sentence that ADDS to the word.
            title={
              !p.running && p.launchDisabled
                ? (p.launchDisabledReason ?? LAUNCH_TITLE)
                : p.savedTabsReopen === true && !p.running
                  ? SAVED_TABS_REOPEN_TITLE
                  : p.running
                    ? OPEN_SESSION_TITLE
                    : p.launching
                      ? LAUNCHING_TITLE
                      : LAUNCH_TITLE
            }
            onClick={(e) => {
              e.stopPropagation();
              // Launching with the menu open closes it (it is a sibling of the
              // dock; the outside-pointerdown test no longer treats the whole
              // dock as "inside").
              setActionsOpen(false);
              p.onPrimary();
            }}
          >
            {p.running ? (
              'Open session'
            ) : p.launching ? (
              <span className="inline-flex items-center justify-center gap-1.5">
                <span
                  aria-hidden="true"
                  data-component="launch-spinner"
                  className="h-3 w-3 animate-spin rounded-full border-2 border-ink-muted/40 border-t-ink-secondary"
                />
                Launching…
              </span>
            ) : (
              <>
                {p.savedTabsReopen === true ? (
                  // N11 — the "Saved tabs reopen" pill became this glyph; the
                  // sentence is the button's title.
                  <span data-component="saved-tabs-reopen" aria-hidden="true" className="mr-1">
                    ↻
                  </span>
                ) : null}
                Launch
              </>
            )}
          </button>
          <button
            ref={moreRef}
            type="button"
            aria-label="More actions"
            aria-expanded={actionsOpen}
            aria-controls={menuId}
            title="More actions"
            className={`flex h-[30px] w-[34px] shrink-0 items-center justify-center rounded-[10px] text-[15px] leading-none transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-hover focus-visible:ring-offset-2 focus-visible:ring-offset-surface-raised ${
              actionsOpen
                ? 'border border-accent bg-accent-subtle text-ink-primary'
                : 'bg-white/[0.06] text-ink-primary hover:bg-white/10'
            }`}
            onClick={(e) => {
              e.stopPropagation();
              toggleMenu();
            }}
            onKeyDown={(e) => {
              // ArrowDown/ArrowUp on the toggle: open (if closed) and move into
              // the menu — the menu-button pattern.
              if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
              e.preventDefault();
              e.stopPropagation();
              const which = e.key === 'ArrowDown' ? 'first' : 'last';
              if (actionsOpen) {
                focusMenuItem(menuRef.current, which);
              } else {
                focusOnOpenRef.current = which;
                toggleMenu();
              }
            }}
          >
            ⋯
          </button>
        </div>
      </div>

      {/* action menu — a clean VERTICAL DROPDOWN of labelled rows (founder
          2026-06-17). Anchored to BOTH card edges. Opens UPWARD over the body,
          or DOWNWARD (over the next row) when fewer than 320px of room lie above
          the dock inside the scroller — which is why it is a sibling of the
          screen, not a child: the screen clips.
          ⛔ Opened ONLY by the ⋯ toggle. It also opened on card HOVER
          (group-hover:opacity-100), so moving the pointer across the grid
          unfurled every action — the destructive ones included — over whatever
          card the cursor passed (owner 2026-08-30). Same correction as the Clear
          group in V-2149, one level up. Rows stay in the DOM (opacity-toggled)
          so the accessible labels are always queryable. */}
      {/* Phase C — PORTALED to document.body with a fixed box from the card's
          rect (`menuBoxFor`): no ancestor clip (the grid's scroller, a
          transformed hover lift) can cut it, and it never widens the article.
          React events still bubble to the article through the portal, so the
          container stops clicks (a click on the menu's padding must not
          toggle selection); the dismiss hook tests `menuRef.contains`, which
          holds for a portal node. Closes on grid scroll / resize. */}
      {createPortal(
        <div
          ref={menuRef}
          id={menuId}
          data-component="card-actions-menu"
          data-open={actionsOpen ? 'true' : 'false'}
          data-placement={menuBelow ? 'below' : 'above'}
          onClick={(e) => e.stopPropagation()}
          style={{
            left: menuBox.left,
            width: menuBox.width,
            top: menuBox.top,
            bottom: menuBox.bottom,
            // ⊆ viewport at ANY window height (tauri minHeight 600): the class's
            // 350 cap, or the room to the viewport edge when that is less — the
            // cut rows scroll inside the menu (a scroll inside never closes it).
            maxHeight: menuBox.maxHeight,
          }}
          // Polish: a labelled role="group" of plain buttons (a role="menu" whose
          // rows were role-less buttons was an ARIA required-children violation —
          // announced as an empty menu); ArrowDown/ArrowUp/Home/End walk the
          // enabled rows, Tab still traverses them; max-h 350 so the 13-row
          // real-app maximum has no fold (at 260 'Clear everything' and 'Delete'
          // sat under an invisible overlay scrollbar).
          role="group"
          aria-label={`More actions for ${p.name}`}
          onKeyDown={(e) => {
            if (e.key === 'Tab') {
              // The menu-button pattern: Tab / Shift+Tab CLOSE the menu and move
              // focus on. The portal node sits at the END of document.body, so
              // the browser's own next/previous tabbable from a row is browser
              // chrome (or the app's first control) — nowhere near the card.
              // Focus is put back on ⋯ synchronously and the default is left
              // alone: the browser's sequential navigation runs AFTER dispatch
              // from the element focused THEN, so Tab lands on the control
              // after ⋯ (the next card) and Shift+Tab on the one before it.
              setActionsOpen(false);
              moreRef.current?.focus({ preventScroll: true });
              return;
            }
            const which =
              e.key === 'ArrowDown'
                ? 'next'
                : e.key === 'ArrowUp'
                  ? 'prev'
                  : e.key === 'Home'
                    ? 'first'
                    : e.key === 'End'
                      ? 'last'
                      : null;
            if (which === null) return;
            e.preventDefault();
            e.stopPropagation();
            focusMenuItem(menuRef.current, which);
          }}
          className={`fixed z-50 max-h-[350px] overflow-y-auto overflow-x-hidden rounded-xl border border-surface-divider bg-surface-raised py-1 shadow-[0_12px_30px_rgba(0,0,0,0.5)] transition-opacity duration-150 ${
            // `invisible` as well as opacity-0: a closed menu of many rows is
            // taller than the room above the dock, and visibility (inherited,
            // unlike opacity) is what keeps its rows out of the raw-rect "outside
            // the box" measurement, out of hit-testing and out of the a11y tree.
            actionsOpen
              ? 'visible pointer-events-auto opacity-100'
              : 'invisible pointer-events-none opacity-0'
          }`}
        >
          {/* Phase C — the first row opens the same sheet the ⓘ glyph does; focus
            returns to ⋯ (the control that was focused) when it closes. */}
          <MenuRow
            glyph="ⓘ"
            caption="Details"
            label={`Details — every fact about ${p.name}, in full`}
            action="open-details-row"
            onClick={() => openDetails(moreRef.current)}
          />
          {p.onAssist ? (
            <MenuRow
              glyph="✦"
              caption="Assist"
              label={`Ask the AI assistant about ${p.name}`}
              onClick={() => {
                setActionsOpen(false);
                p.onAssist?.();
              }}
            />
          ) : null}
          {/* Stop — only for a RUNNING profile with a stop handler (idle cards
            never show it). Reuses `busy` so a double-click can't double-close
            (founder Track A). */}
          {p.running && p.onStop ? (
            <MenuRow
              glyph={p.busy ? '…' : '◼'}
              caption={p.busy ? 'Stopping…' : 'Stop session'}
              // Polish: the label opens with the visible caption (WCAG 2.5.3 —
              // 'click Stop session' must match).
              label={`Stop session — end ${p.name}'s running session`}
              tone="danger"
              onClick={() => {
                setActionsOpen(false);
                p.onStop?.();
              }}
              disabled={p.busy}
            />
          ) : null}
          {p.hasProxy ? (
            <MenuRow
              glyph={p.testing ? '…' : '⟳'}
              // (l) #10 — the grid's button and this menu row name the VPN
              // check the same way, from one constant.
              caption={vpn ? CHECK_VPN_ACTION : 'Test proxy'}
              label={vpn ? CHECK_VPN_TITLE : TEST_PROXY_TITLE}
              onClick={() => {
                setActionsOpen(false);
                p.onTest();
              }}
              disabled={p.testDisabled}
            />
          ) : null}
          {p.onEdit ? (
            <MenuRow
              glyph="✎"
              caption="Edit"
              label={`Edit ${p.name}`}
              onClick={() => {
                setActionsOpen(false);
                p.onEdit?.();
              }}
            />
          ) : null}
          {p.onSaveNote ? (
            <MenuRow
              glyph="🗒"
              caption={p.note && p.note.trim() !== '' ? 'Edit note' : 'Add note'}
              label={`Edit note for ${p.name}`}
              onClick={() => {
                setActionsOpen(false);
                openNoteEditor(moreRef.current);
              }}
            />
          ) : null}
          {p.onClone ? (
            <MenuRow
              glyph="⧉"
              caption="Duplicate"
              label={`Duplicate ${p.name}`}
              title={
                p.cloneDisabled
                  ? p.cloneDisabledReason
                  : p.anyBusy && !p.busy
                    ? 'Another profile is busy — wait for it to finish'
                    : undefined
              }
              disabled={p.cloneDisabled || p.busy || p.anyBusy}
              onClick={() => {
                setActionsOpen(false);
                p.onClone?.();
              }}
            />
          ) : null}
          {p.onActivity ? (
            <MenuRow
              glyph="🕘"
              caption="Activity"
              label={`Activity — recent pages opened with ${p.name}`}
              onClick={() => {
                setActionsOpen(false);
                p.onActivity?.();
              }}
            />
          ) : null}
          {p.onExport ? (
            <MenuRow
              glyph="⤓"
              caption="Export"
              label={`Export ${p.name} as a portable JSON copy`}
              onClick={() => {
                setActionsOpen(false);
                p.onExport?.();
              }}
            />
          ) : null}
          {/* doc-150 item 5 — the sealed-store size moved to the details sheet
            (Phase C, its final home): a static info row in an actions menu was
            the one row that did nothing. */}
          {/* doc-150 §8 — Trim: clear re-fetchable caches, keep logins. The
            title spells out exactly what's kept so the customer knows
            nothing identity-bearing is dropped. Disabled while busy. */}
          {p.onTrim ? (
            <MenuGroup glyph="🧹" caption="Clear…" label={`Clearing options for ${p.name}`}>
              <MenuRow
                glyph="🧹"
                caption="Clear cache"
                label={`Clear cache for ${p.name}`}
                title={
                  p.anyBusy && !p.busy
                    ? 'Another profile is busy — wait for it to finish'
                    : 'Free re-fetchable files. Logins, site data and tabs are kept'
                }
                disabled={p.busy || p.anyBusy}
                onClick={() => {
                  setActionsOpen(false);
                  p.onTrim?.('cache');
                }}
              />
              {/* W3120 (doc-150 §8.4). These three DESTROY state the customer
                cannot get back, unlike a cache clear which simply refetches,
                so each title says plainly what goes before the confirm does. */}
              <MenuRow
                glyph="🍪"
                caption="Clear cookies"
                label={`Clear cookies for ${p.name}`}
                title={
                  p.anyBusy && !p.busy
                    ? 'Another profile is busy — wait for it to finish'
                    : 'Signs this profile out everywhere. Cached files and tabs are kept'
                }
                disabled={p.busy || p.anyBusy}
                onClick={() => {
                  setActionsOpen(false);
                  p.onTrim?.('cookies');
                }}
              />
              <MenuRow
                glyph="🕘"
                caption="Clear history"
                label={`Clear history for ${p.name}`}
                title={
                  p.anyBusy && !p.busy
                    ? 'Another profile is busy — wait for it to finish'
                    : 'Forgets the remembered tabs — the only page record a profile keeps'
                }
                disabled={p.busy || p.anyBusy}
                onClick={() => {
                  setActionsOpen(false);
                  p.onTrim?.('history');
                }}
              />
              <MenuRow
                glyph="🧨"
                caption="Clear everything"
                label={`Clear all browsing data for ${p.name}`}
                title={
                  p.anyBusy && !p.busy
                    ? 'Another profile is busy — wait for it to finish'
                    : 'Cookies, site data, cache and tabs. The profile and its fingerprint stay'
                }
                disabled={p.busy || p.anyBusy}
                onClick={() => {
                  setActionsOpen(false);
                  p.onTrim?.('all');
                }}
              />
            </MenuGroup>
          ) : null}
          {p.onDelete ? (
            <>
              <div role="separator" className="my-1 h-px bg-surface-divider" aria-hidden="true" />
              {/* Delete is rejected by the server for a RUNNING session, so
                disable it (matching ProfilesTable) and explain via the
                tooltip rather than letting the click 409. Also disable while
                BUSY (a launch/clone in flight) so a delete can't race an
                in-flight launch before `running` is set — w410wv3eq #4. */}
              <MenuRow
                glyph="🗑"
                caption="Delete"
                label={`Delete ${p.name}`}
                title={
                  p.running
                    ? 'Stop the session first before deleting'
                    : p.anyBusy && !p.busy
                      ? 'Another profile is busy — wait for it to finish'
                      : undefined
                }
                tone="danger"
                disabled={p.busy || p.running || p.anyBusy}
                onClick={() => {
                  setActionsOpen(false);
                  p.onDelete?.();
                }}
              />
            </>
          ) : null}
        </div>,
        document.body,
      )}
    </article>
  );
}

/** Phase C — one labelled fact in the details sheet: a 9px uppercase label
 *  (`dt`) over the value (`dd`), the group tagged `data-fact` so the sheet's
 *  rows are addressable without reusing the tile's `data-region` names (the
 *  geometry gate asserts those appear exactly once, in order). */
function DetailRow({
  fact,
  label,
  children,
}: {
  fact: string;
  label: string;
  children: ReactNode;
}): JSX.Element {
  return (
    <div data-fact={fact} className="flex min-w-0 flex-col gap-px">
      <dt className="text-[9px] font-semibold uppercase leading-3 tracking-wider text-ink-muted">
        {label}
      </dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

// MenuRow — one labelled row in the grid-card ⋯ dropdown menu (founder
// 2026-06-17: "the dots should be a cleaner vertical dropdown with labels").
// glyph + caption are visible; `label` is the descriptive aria-label/title
// (kept stable so the harness queries by it).
/**
 * A collapsible group of menu rows.
 *
 * ⭐ Four "Clear …" rows sat inline in a thirteen-item card menu, so the two
 * actions a customer reaches for daily were buried under variants of one they use
 * rarely. Owner-reported: they "take up too many items".
 *
 * ⚠️ Opens on hover AND on click/focus, deliberately. Hover alone is what a mouse
 * user asks for and it is unreachable by keyboard and unusable on touch — the
 * disclosure would simply never open.
 *
 * ⛔ CLICK ONLY — hover-to-open was removed (owner 2026-08-30: "the clear
 * shouldn't be hover but click to expand"). Opening a group of DESTRUCTIVE rows
 * because a pointer crossed the word "Clear…" pushes those rows under the cursor
 * without the customer choosing to look at them. `onFocus` went with it: tabbing
 * to a disclosure should not expand it either. Click (or Enter/Space on the
 * focused button) toggles, which is what a disclosure button is expected to do.
 *
 * Stays open once opened rather than closing on mouseleave: the rows below are
 * destructive, and a submenu that retracts while the pointer travels toward it
 * turns a careful click into a mis-click on whatever moves into its place.
 */
function MenuGroup({
  glyph,
  caption,
  label,
  children,
}: {
  glyph: ReactNode;
  caption: string;
  label: string;
  children: ReactNode;
}): JSX.Element {
  const [open, setOpen] = useState(false);
  const rowsRef = useRef<HTMLDivElement | null>(null);
  // Polish — belt and braces under the menu's max-h: an expanded group scrolls
  // its last row into view, so a destructive row is never left under the fold.
  useEffect(() => {
    if (!open) return;
    const last = rowsRef.current?.lastElementChild;
    if (last instanceof HTMLElement && typeof last.scrollIntoView === 'function') {
      last.scrollIntoView({ block: 'nearest' });
    }
  }, [open]);
  return (
    <div data-component="menu-group" data-open={open ? 'true' : 'false'}>
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        title={label}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11.5px] font-medium text-ink-secondary transition-colors hover:bg-surface-elevated hover:text-ink-primary focus-visible:bg-surface-elevated focus-visible:outline-offset-[-2px]"
      >
        <span className="w-4 shrink-0 text-center text-[13px] leading-none" aria-hidden="true">
          {glyph}
        </span>
        <span className="leading-none">{caption}</span>
        <span className="ml-auto text-[10px] leading-none text-ink-muted" aria-hidden="true">
          {open ? '▾' : '▸'}
        </span>
      </button>
      {open ? (
        <div ref={rowsRef} role="group" className="border-l border-surface-divider pl-1.5">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function MenuRow({
  glyph,
  caption,
  label,
  title,
  action,
  onClick,
  disabled,
  tone,
}: {
  glyph: ReactNode;
  caption: string;
  label: string;
  /** Optional hover title; falls back to `label` (e.g. a disabled-reason). */
  title?: string;
  /** Optional `data-action` (Phase C: the Details row). */
  action?: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: 'danger';
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      title={title ?? label}
      data-action={action}
      disabled={disabled}
      onClick={(e) => {
        e.stopPropagation();
        onClick();
      }}
      // Polish: the focus ring is inset (the menu's overflow-x-hidden clipped
      // an offset ring to two horizontal lines) and the row highlights like hover.
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11.5px] font-medium transition-colors focus-visible:outline-offset-[-2px] disabled:opacity-40 ${
        tone === 'danger'
          ? 'text-status-error/90 hover:bg-status-error/15 hover:text-status-error focus-visible:bg-status-error/15'
          : 'text-ink-secondary hover:bg-surface-elevated hover:text-ink-primary focus-visible:bg-surface-elevated'
      }`}
    >
      <span className="w-4 shrink-0 text-center text-[13px] leading-none" aria-hidden="true">
        {glyph}
      </span>
      <span className="leading-none">{caption}</span>
    </button>
  );
}
