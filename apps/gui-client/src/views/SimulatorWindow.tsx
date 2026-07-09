// Floating-iPhone simulator window (founder 2026-06-11: "really only an iPhone
// on your screen, with its frames... drag around... exactly like the Xcode
// Simulator") + a Driftstack-styled control toolbar above the device (founder
// 2026-06-12: "the thing above with the mac icons, to close, minimize, name of
// the phone, screenshot, rotate... more personalized to driftstack").
//
// Renders in a SEPARATE borderless + transparent Tauri window (opened by
// lib/open-simulator.ts). Layout = a slim toolbar on top (window controls +
// device name + actions) and the device below (dark iPhone bezel with a dynamic
// island, the live session video as the screen, direct tap/type control via the
// LK.6.d input-capture). The toolbar + bezel are `data-tauri-drag-region` so
// dragging either moves the window; the screen + the toolbar buttons opt out so
// clicks reach them.
//
// Session join info (LiveKit ws_url + token) + the device label arrive via the
// window URL query — the opener encodes them when creating the window.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import type { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { LiveKitInfo } from '@driftstack/sdk';
import {
  sendNavigate,
  sendTabListUpdate,
  sendActivateTab,
  RoomEvent,
  type Room,
} from '../lib/livekit';
import { useLatencyPing } from '../lib/livekit-latency-ping';
import { useConnectionStats } from '../lib/livekit-connection-stats';
import {
  useRecordings,
  formatDuration,
  recordingDurationMs,
  recordingTotalBytes,
  type Recording,
} from '../lib/recordings';
import { buildRecordingExport, recordingExportFilename } from '../lib/recordings-export';
import { exportCookies } from '../lib/cookie-export';
import { parseCookies } from '../lib/cookie-import';
import { startSimulatorCrashMarker } from '../lib/simulator-crash-marker';
import { AgentSessionPanel } from '../components/AgentSessionPanel';
import { IOSKeyboard } from '../components/IOSKeyboard';
import { normalizeNavigateUrl, resolveAddressBarInput } from '../lib/address-bar';
import { pointerToViewport } from '../lib/livekit-input-capture';
import { pageErrorCopy, type PageErrorInfo } from '../lib/page-error-copy';
import { formatSessionDiagnostics } from '../lib/session-diagnostics';
import { downloadBlob, downloadJson } from '../lib/download';
import { persistBaseUrl } from '../lib/settings';
import {
  getAgentSession,
  getAgentSessionPageState,
  getAgentSessionCookies,
  setAgentSessionCookies,
  navigateAgentSessionHistory,
  uploadAgentSessionFile,
  listAgentSessionDownloads,
  fetchAgentSessionDownload,
  setSessionMode,
  takeoverSession,
  handbackSession,
  sendAgentMessage,
  endAgentSession,
  AgentSessionControlError,
  type SessionMode,
  type ControlAuth,
  type SessionCookie,
  type SessionFileHandle,
  type SessionDownloadEntry,
} from '../lib/agent-session-control';

/** Frame chrome heights (px) used to derive the window size from the device's
 *  real screen aspect: toolbar above the bezel, the bezel's p-[10px] padding,
 *  and the in-screen status strip the video sits below. */
const TOOLBAR_H = 34;
const BROWSER_BAR_H = 40; // dedicated browser-mode address bar (its own row)
// Browser-style page TAB strip (doc-150 item 4) — its OWN full-width row between the
// toolbar and the address bar, shown only in browser mode (gated identically to
// BROWSER_BAR_H). MUST be added to the `chrome` height expression at all four
// window-sizing sites (fitWindow / resetToActualSize / refitForDrawer / onResized)
// or the device letterboxes (the 402×714 viewport invariant). It's GUI chrome
// OUTSIDE the video — the rendered fingerprint viewport is unchanged.
const TAB_STRIP_H = 32;
// On-screen iOS keyboard height (px). Mounted INSIDE the phone screen, BELOW the
// video (a flex sibling of the screen-host). When SHOWN it must be added to the
// chrome term at every window-sizing site so the window GROWS by exactly its
// height — keeping the video at its full content aspect with the keyboard docked
// below it (iPhone-faithful), instead of letting the flex layout STEAL the
// keyboard's space from the flex-1 screen-host (which shrank the video and left a
// black band — founder #75). Measured from IOSKeyboard's box model: 4 rows ×
// h-[42px] + 3 × gap-[6px] (between the 4 rows) + pt-[8px] + pb-[6px] = 168 + 18 +
// 14 = 200. When the keyboard is HIDDEN it is conditionally NOT rendered (zero
// space), so this term is added ONLY while it's visible.
const KEYBOARD_H = 200;

/** A browser page tab in the GUI's tab model (doc-150 item 4). Mirrors the
 *  `tabListUpdate` / `activateTab` contract entry shape exactly (id/url/scrollY/
 *  title) so a tab can be serialized straight onto the wire. */
interface SimTab {
  id: string;
  url: string;
  scrollY: number;
  title: string;
}

/** Mint a stable, unique tab id. crypto.randomUUID() in the app + Tauri webview;
 *  falls back to a time+random token in any (test) env without it. */
function makeTabId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `tab_${crypto.randomUUID()}`;
    }
  } catch {
    /* crypto unavailable — fall through to the token */
  }
  return `tab_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Real encoded byte size of a base64 data URL (the captured JPEG), so the
 * recording "Size" fact matches the exported file / disk usage. The old
 * `dataUrl.length * 0.75` over-counted (it included the `data:…;base64,` prefix
 * and ignored padding) — only coincidentally close. Strip the prefix, then
 * base64 length × 3/4 minus the `=` padding bytes. Exported for tests.
 */
export function dataUrlByteSize(dataUrl: string): number {
  const comma = dataUrl.indexOf(',');
  const b64 = comma === -1 ? dataUrl : dataUrl.slice(comma + 1);
  if (b64.length === 0) return 0;
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}
// New-tab destination (founder 2026-06-25: "our own blank about:me page instead
// of nothing"). The "+" action opens a fresh tab to the branded Driftstack
// new-tab page (apps/marketing-site/src/pages/newtab.astro) so the box renders an
// on-brand page instead of a literally-empty about:blank. A NAMED CONSTANT so it's
// a one-line swap back to 'about:blank' if A3 prefers it for fingerprint reasons.
// TRAILING SLASH is deliberate: Astro (output:'static', directory format) builds the
// page to dist/newtab/index.html, served at /newtab/. Without the slash CF Pages
// 308-redirects /newtab → /newtab/, which the box reports back as an extra navigation
// (and a url the no-slash blank-tab check no longer matched). Seed the served path so
// there's no redirect hop and the tab reads as blank.
const NEW_TAB_URL = 'https://driftstack.dev/newtab/';
const NEW_TAB_TITLE = 'New Tab';
/** A "home"/blank tab whose url should read as an empty new tab in the UI (no
 *  address shown, label falls back to "New Tab", window title to the device
 *  name) — both the literal about:blank and the branded new-tab page. Normalizes a
 *  trailing slash and accepts the box-reported title chrome so a fresh tab still reads
 *  as blank even if the box reports the redirected (no-slash) or slashed form. */
function isBlankTabUrl(url: string): boolean {
  if (url === '' || url === 'about:blank') return true;
  const normalized = url.replace(/\/$/, '');
  return normalized === 'https://driftstack.dev/newtab';
}
/** #135 — normalize a URL for nav-target comparison (drop trailing slash + fragment,
 *  lowercase), so a box page_state 'errored'/'loaded' frame can be matched to the
 *  current navigation target despite trailing-slash / case / #hash differences. A3
 *  confirmed page_state.errored is emitted ONLY for a MAIN-FRAME nav failure and
 *  carries the failing url — so matching the frame's url against the current target
 *  drops a STALE 'errored' from a page the operator already navigated away from (the
 *  founder's repeated "PAGE FAILED TO LOAD" on an open, fine page). Empty ⇒ untracked. */
function normalizeNavUrl(url: unknown): string {
  if (typeof url !== 'string' || url.trim().length === 0) return '';
  const raw = url.trim();
  try {
    const p = new URL(raw);
    p.hash = '';
    return p.toString().replace(/\/$/, '').toLowerCase();
  } catch {
    return raw.replace(/[/#]+$/, '').toLowerCase();
  }
}
/** The branded new-tab page hard-depends on driftstack.dev being reachable THROUGH the
 *  customer proxy — a geo-block / CF challenge / marketing outage makes the box report
 *  it 'errored'. A blank new tab must never read as a navigation FAILURE (about:blank
 *  always rendered), so a load error on the new-tab url is treated as graceful (no
 *  overlay) rather than a hard error. The operator just types an address as usual. */
function isNewTabLoadError(url: unknown): boolean {
  return typeof url === 'string' && url !== '' && isBlankTabUrl(url);
}
// Tab-switch ack handling (founder 2026-06-25 "could not switch tab" softening).
// If the harness MISSES an activateTab ack (a dropped data-channel frame) within
// this backoff, re-issue the activateTab — up to ACTIVATE_MAX_ATTEMPTS total (the
// initial send + 2 retries) before giving up with a soft, non-blocking notice.
const ACTIVATE_ACK_TIMEOUT_MS = 1200;
const ACTIVATE_MAX_ATTEMPTS = 3;
// Hard upper bound on the "switching…" affordance so it can never hang on the tab
// (a dropped ack AND a dropped page_state). Cleared earlier by any box page-state
// for the tab or an ack; this is the safety net.
const SWITCH_AFFORDANCE_TIMEOUT_MS = 6000;
// Grace window after a navigate / tab switch during which a box page-state frame that
// carries NO tabId must NOT overwrite the active tab's url. Right after a switch the
// box's page-state still reflects the PRIOR tab's page and (on prod) carries no tabId,
// so a tabId-less frame would route the stale url onto the just-switched active tab —
// the founder's "2nd switch stays on the same url" clobber. Both the ~2s poll AND the
// one-shot reconcile gate their url write on this (the title still applies; titles
// self-heal). A tabId-bearing frame routes precisely and is never suppressed.
const PAGE_STATE_GRACE_MS = 2500;
// flip true when A3's navigateHistory handler deploys — bus W2870
const BACK_FORWARD_ENABLED = true; // A3 navigateHistory handler deployed (bus W2872; A3 01a5d48f1)
// Finding #6 — throttle for the unrecognized-data-frame breadcrumb (below). One warn at
// most per window so a flood of drifted frames can't spam the console.
const UNRECOGNIZED_FRAME_WARN_THROTTLE_MS = 10_000;
let lastUnrecognizedFrameWarnAt = 0;
function warnUnrecognizedDataFrame(msg: { type?: string; state?: string }): void {
  // Only frames that LOOK like a structured event (a non-empty type or state) are worth
  // flagging — bare/empty objects are noise. The ping channel is excluded by the caller.
  if ((msg.type ?? '') === '' && (msg.state ?? '') === '') return;
  const now = Date.now();
  if (now - lastUnrecognizedFrameWarnAt < UNRECOGNIZED_FRAME_WARN_THROTTLE_MS) return;
  lastUnrecognizedFrameWarnAt = now;
  // Intentional, prod-visible drift breadcrumb (no Sentry message API — telemetry.ts is
  // crash-only by privacy contract); visible in the Tauri WebView console.
  console.warn('[simulator] unrecognized data frame', msg.type, msg.state);
}
const BEZEL_PAD = 20; // p-[10px] × 2
const STATUS_STRIP_H = 40;

/** Total non-video chrome height (px) above + around the device screen-host: the
 *  Mac toolbar, the optional browser-mode address bar + tab strip, the bezel's
 *  p-[10px] padding (top+bottom = BEZEL_PAD), the in-screen iOS status strip
 *  (STATUS_STRIP_H, the <IosStatusBar/> the live video sits BELOW), and — only
 *  while the on-screen keyboard is shown — KEYBOARD_H (the keyboard is a flex
 *  sibling BELOW the video). Every window-sizing site derives the window HEIGHT as
 *  `chrome + contentW / aspect`, where contentW = phoneW − BEZEL_PAD and `aspect`
 *  is the LIVE content video aspect (videoW/videoH). One helper so the sizing
 *  sites can never drift apart (a missing strip on one site re-introduces a top
 *  cutoff or bottom black band — P1b). `keyboardVisible` defaults false so every
 *  call site that doesn't care about the keyboard reads the keyboard-hidden
 *  height unchanged. */
export function simulatorChromeHeight(browserModeOn: boolean, keyboardVisible = false): number {
  return (
    TOOLBAR_H +
    (browserModeOn ? BROWSER_BAR_H + TAB_STRIP_H : 0) +
    BEZEL_PAD +
    STATUS_STRIP_H +
    (keyboardVisible ? KEYBOARD_H : 0)
  );
}

/** Pure window-height formula (P1b). The device screen-host must be EXACTLY the
 *  live content aspect (videoW/videoH) so the <video> fills it edge-to-edge with
 *  NO letterbox band. window_height = chrome + contentW / aspect, where contentW
 *  is the phone width minus the bezel padding. The screen-host gets contentW wide
 *  and contentW/aspect tall — exactly the content aspect — and AgentSessionPanel
 *  is given the SAME live aspect so its box == host == video (no double
 *  object-contain). Returns a rounded integer px height; 0 for a non-positive
 *  aspect/width (caller guards). */
export function simulatorWindowHeight(
  phoneW: number,
  aspect: number,
  browserModeOn: boolean,
  keyboardVisible = false,
): number {
  if (aspect <= 0 || phoneW <= BEZEL_PAD) return 0;
  return Math.round(
    simulatorChromeHeight(browserModeOn, keyboardVisible) + (phoneW - BEZEL_PAD) / aspect,
  );
}

/** P1b/aspect-track — should an incoming video intrinsic (w×h) trigger a re-fit of the
 *  screen-host to a NEW content aspect? The window-sizing + panel box are sized ONCE from
 *  the first onLoadedMetadata frame, but the live steady-state intrinsic can settle to a
 *  DIFFERENT aspect later (e.g. the first frame is 393×790 ≈ 0.497 then the content-only
 *  steady state is 268×452 ≈ 0.593) → the host stays the stale aspect and the wider live
 *  content letterboxes inside it (the founder's TOP black band). So the host must TRACK the
 *  live intrinsic aspect, not just the first frame.
 *
 *  Thrash-guard: the SFU DOWNSCALES the encoded track under bandwidth (268×452 → smaller)
 *  but those resolution changes PRESERVE the aspect — they must NOT re-fit (a per-frame
 *  window resize would jitter the window). Only re-fit when the ASPECT itself moves beyond
 *  `threshold` (relative). Returns false for a non-positive incoming/current aspect (caller
 *  guards w>0/h>0; a 0 current aspect is never a real "changed" signal). Pure + exported so
 *  the decision is unit-tested independently of the Tauri window plumbing. */
export function shouldRefitForAspectChange(
  currentAspect: number,
  w: number,
  h: number,
  threshold = 0.015,
): boolean {
  if (w <= 0 || h <= 0 || currentAspect <= 0) return false;
  const incoming = w / h;
  // Relative difference so the threshold means the same thing at any aspect; a pure
  // resolution downscale that preserves the aspect yields ~0 here → no re-fit.
  return Math.abs(incoming - currentAspect) / currentAspect > threshold;
}

/** Finding #4 — the cookies/downloads LIST polls render a 200 `status:'unavailable'`
 *  result's `reason` verbatim. The server emits three INTERNAL diagnostic phrases for
 *  that state (agent-sessions.ts) that read as raw debug strings, not customer copy.
 *  Map ONLY those three to a single friendly line; pass everything else through
 *  unchanged so genuinely-actionable reasons (RELAY_BUSY "too many concurrent
 *  requests…", harness outcome messages) and the calm fallback "not available yet"
 *  still surface. Pure + exported for unit tests. */
export function friendlyUnavailableNote(reason: string | null | undefined): string {
  switch (reason) {
    case 'session is not live on a node':
    case 'session node is not connected':
    case 'fleet control plane not enabled':
      return "the session isn't live on a device right now";
    default:
      return reason ?? 'not available yet';
  }
}
// The iPhone CSS-logical width of the launch archetype (iphone17). Fallback for the
// "actual size" reset (Cmd+0) before the live stream reports its per-archetype dims,
// so the device renders at true iPhone-logical px, not whatever width the window
// happens to have been dragged to. Once the stream reports, the reset uses the live
// per-archetype logical width (deviceLogicalRef) instead.
const DEVICE_LOGICAL_WIDTH = 402;
// NOTE: the box formerly published the web content at 3× dpr (e.g. 1206×2142 px), so
// the touch space was videoWidth/3 × videoHeight/3. A3's 2026-06-29 black-band fix
// switched the capture to 1×-display content res — the published track IS now the
// logical viewport (e.g. 402×714) — so the touch space is the track dims directly and
// the former STREAM_DPR division is removed in handleVideoDimensions (taps were
// landing 3× off otherwise; A3 carries a box-side reconcile stopgap until this ships).
// Activity-bar drawer (founder 2026-06-24) — a slim icon RAIL is ALWAYS docked
// next to the phone; clicking a section icon EXPANDS its content PANE to the
// right of the rail (VS Code's activity-bar + side-panel idiom). The window
// widens to fit the rail unconditionally, and by PANE_W more whenever a pane is
// open. The window-sizing math always derives the phone dims from (windowWidth −
// drawerExtra) and adds drawerExtra back, so the drawer never letterboxes the
// device (the prior "window larger than output" hazard). RAIL_W + PANE_W keeps
// the open width at the historical 300 so nothing changes when a pane is open.
const RAIL_W = 48; // always added — the rail is docked beside the phone at all times
const PANE_W = 252; // added only while a pane is open (RAIL_W + PANE_W === old DRAWER_W)

// Approach B drawer (founder 2026-06-24) — the section ids for the icon rail +
// single content pane. Order = the rail's top-to-bottom order. Persisted as a
// PREFERENCE so the operator's last-used section survives a relaunch.
const SIM_DRAWER_PANES = [
  'session',
  'controls',
  'diagnostics',
  'cookies',
  'files',
  'downloads',
  'recording',
] as const;
type SimDrawerPane = (typeof SIM_DRAWER_PANES)[number];
const SIM_DRAWER_PANE_KEY = 'ds-sim-drawer-pane';

interface SessionQuery {
  info: LiveKitInfo | null;
  deviceName: string;
  profileName: string;
  proxyLabel: string;
  sessionId: string;
  /** ISO-3166 alpha-2 proxy exit country (e.g. "US"), from the launch query.
   *  Drives the macOS Dock-tile country badge (founder 2026-06-18). Empty
   *  string → no country (the Dock tile shows no badge). */
  countryCode: string;
  /** Per-session gui_control_key carried in the query as the PRIMARY,
   *  race-free control handoff (the opener always appends it via `ck=` when a
   *  key is available — see lib/open-simulator.ts). The 0600 temp-file handoff
   *  (sim_key_take) is a secondary path. Read on mount so controlAuth is set
   *  without waiting on the Rust location.search reload. Empty string → no key
   *  from the query (in-app window → fall back to the account API key). */
  controlKey: string;
  /** PUBLIC API base URL handed off at launch (`base=`). The SEPARATE Simulator
   *  app's own store may be empty → loadSettings() would default to
   *  localhost:3000 and every control call fails. SimulatorWindow persists this
   *  on mount so authedFetch targets the right server (founder 2026-06-23). Empty
   *  → leave the app's own configured baseUrl alone. */
  baseUrl: string;
}

/** Parse the simulator session from a query string. Defaults to the window's
 *  own `location.search`; the relaunch `ds-session` event passes a fresh query
 *  string so the window can switch session IN PLACE (without a reload that
 *  would tear down the live LiveKit Room). */
// Per-session gui_control_key persistence (founder 2026-06-23 "control request
// failed always"). The separate Simulator app receives its control key ONCE at
// launch (via the sandboxed `ck=` query OR the single-use temp file). A reopened
// or relaunched window arrives with neither → controlAuth was null → every control
// HTTP call (mode / End-session / cookies) failed while manual (LiveKit) kept
// working. Persisting the key (app-local, same risk class as the query/temp-file
// handoff; 24h server TTL, a stale one just 401s → graceful manual) lets a reopen
// restore it. Keyed by the agt_<uuid> session id.
const GCK_STORE_PREFIX = 'ds-gck-';
function persistControlKey(sessionId: string, key: string): void {
  if (sessionId === '' || key === '') return;
  try {
    localStorage.setItem(GCK_STORE_PREFIX + sessionId, key);
  } catch {
    /* storage disabled — the key just won't survive a reopen */
  }
}
function readPersistedControlKey(sessionId: string): string {
  if (sessionId === '') return '';
  try {
    return localStorage.getItem(GCK_STORE_PREFIX + sessionId) ?? '';
  } catch {
    return '';
  }
}

/** Build the ControlAuth, attaching the handed-off API host so the separate
 *  app's control calls target the right server with no store-timing race
 *  (founder 2026-06-23). `controlKey===''` → null (in-app window / no key). */
function controlAuthWith(controlKey: string, baseUrl: string): ControlAuth {
  if (controlKey === '') return null;
  return baseUrl !== '' ? { controlKey, baseUrl } : { controlKey };
}

/** Drop the persisted key once the session is explicitly ended — the 24h
 *  credential is useless after the session is DELETE'd, and clearing it stops
 *  the per-session entries from accumulating unbounded in localStorage (review
 *  a482b Low-(a)). Best-effort. */
function clearPersistedControlKey(sessionId: string): void {
  if (sessionId === '') return;
  try {
    localStorage.removeItem(GCK_STORE_PREFIX + sessionId);
  } catch {
    /* storage disabled — nothing to clear */
  }
}

function infoFromQuery(search: string = window.location.search): SessionQuery {
  const q = new URLSearchParams(search);
  const ws_url = q.get('ws');
  const token = q.get('token');
  const deviceName = q.get('name') ?? 'iPhone';
  const profileName = q.get('profile') ?? '';
  const proxyLabel = q.get('proxy') ?? '';
  const sessionId = q.get('session') ?? '';
  // Proxy exit country (ISO alpha-2) for the macOS Dock tile (empty → no badge).
  const countryCode = q.get('cc') ?? '';
  // Sandboxed-fallback control key (see SessionQuery.controlKey). The
  // non-sandboxed handoff is the 0600 temp file, read via sim_key_take.
  const controlKey = q.get('ck') ?? '';
  // PUBLIC API host handed off at launch (see SessionQuery.baseUrl).
  const baseUrl = q.get('base') ?? '';
  if (ws_url === null || token === null || ws_url === '' || token === '') {
    return {
      info: null,
      deviceName,
      profileName,
      proxyLabel,
      sessionId,
      countryCode,
      controlKey,
      baseUrl,
    };
  }
  // LiveKitInfo carries ws_url + token (the only fields the panel/connect read);
  // room_name is informational. Cast is safe — the panel reads ws_url/token only.
  return {
    info: { ws_url, token, room_name: q.get('room') ?? '' } as unknown as LiveKitInfo,
    deviceName,
    profileName,
    proxyLabel,
    sessionId,
    countryCode,
    controlKey,
    baseUrl,
  };
}

/** Tauri-only window ops, dynamically imported on use so the jsdom tests (no
 *  Tauri) never load the native module. No-op outside Tauri. */
async function withCurrentWindow(fn: (w: WebviewWindow) => Promise<void>): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    await fn(getCurrentWebviewWindow());
  } catch (err) {
    // A failed window op (pin / drag / close / minimize / rotate / resize) must
    // NEVER reach the global unhandledrejection handler — in the BORDERLESS
    // simulator window that paints the fatal overlay → an undraggable black box
    // → force-quit (the exact crash class the founder hit 2026-06-18, just via a
    // Tauri call). Swallow + log; the op simply no-ops. Every `void
    // withCurrentWindow(...)` caller is protected by this single guard.
    console.warn('[simulator] window operation failed (ignored):', err);
  }
}

/** Set (or clear, when `countryCode` is null/empty) the running app's macOS
 *  Dock icon to reflect the session (founder 2026-06-18). The Rust
 *  `set_dock_tile` draws the proxy country's FLAG (from the 2-letter code) as
 *  the Dock icon with the profile name captioned on it; `reset_dock_tile`
 *  restores the bundle icon. Tauri + macOS only — a no-op elsewhere; failures
 *  are swallowed (best-effort cosmetic). */
async function applyDockTile(countryCode: string | null, profileName: string): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    if (countryCode !== null && countryCode !== '') {
      // profileName may be '' (device-only profile) — the Rust side treats an
      // empty name as "flag only, no caption".
      await invoke('set_dock_tile', { countryCode, profileName });
    } else {
      await invoke('reset_dock_tile');
    }
  } catch (err) {
    console.warn('[simulator] dock tile update failed (ignored):', err);
  }
}

/** Host of a ws URL for the info overlay — guarded so a malformed ws value in
 *  the window query degrades to a label instead of throwing in render (which
 *  would drop the whole simulator into the error boundary). */
function wsHost(wsUrl: string): string {
  try {
    return new URL(wsUrl).host;
  } catch {
    return wsUrl.length > 0 ? wsUrl : 'not connected';
  }
}

/** Compact human-readable byte size for the Recording pane (KB up to ~1 MB,
 *  then MB with one decimal) — mirrors RecordingsView's `… MB` formatting. */
function formatRecBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(0, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** A glanceable file-type glyph + accent color for the Files / Downloads cards
 *  (mirrors the approved drawer-full-demo's file cards). Purely cosmetic — keyed
 *  off the mime type with a filename-extension fallback; never affects behavior. */
function fileGlyph(name: string, mime?: string): { icon: string; color: string } {
  const m = (mime ?? '').toLowerCase();
  const ext = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '';
  if (m.startsWith('image/') || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg'].includes(ext))
    return { icon: '🖼️', color: '#c4b5fd' };
  if (m === 'application/pdf' || ext === 'pdf') return { icon: '📄', color: '#7dd3fc' };
  if (m.startsWith('video/') || ['mp4', 'mov', 'webm', 'mkv'].includes(ext))
    return { icon: '🎬', color: '#f87171' };
  if (m.startsWith('audio/') || ['mp3', 'wav', 'm4a', 'aac'].includes(ext))
    return { icon: '🎵', color: '#34d399' };
  if (
    m.startsWith('text/') ||
    ['txt', 'json', 'csv', 'md', 'xml', 'html', 'js', 'ts'].includes(ext)
  )
    return { icon: '📝', color: '#34d8c4' };
  if (['zip', 'gz', 'tar', 'rar', '7z'].includes(ext)) return { icon: '🗜️', color: '#fbbf24' };
  return { icon: '📦', color: '#7dd3fc' };
}

/** KB/MB size for a file/download card — same KB rounding the panes used before
 *  (≥1 KB floor), promoting to MB once over ~1 MB for readability. */
function formatFileSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** iOS-style h:mm (12-hour, no leading zero, no AM/PM — matches the iOS status
 *  bar). The streamed screen is web content with no device clock of its own. */
function formatStatusTime(d: Date): string {
  const hour = d.getHours() % 12 || 12;
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

function useStatusClock(): string {
  const [time, setTime] = useState(() => formatStatusTime(new Date()));
  useEffect(() => {
    const id = setInterval(() => setTime(formatStatusTime(new Date())), 15_000);
    return () => clearInterval(id);
  }, []);
  return time;
}

/**
 * Driftstack control toolbar — the bar above the device (founder's "thing above
 * with the mac icons"). Personalized to Driftstack, not a literal Simulator
 * copy: a close + minimize control on the left, the device name centered, and
 * screenshot + rotate actions on the right. The bar is a drag-region (drag the
 * window by it); the button clusters opt out so clicks land.
 */
/** The Driftstack brand mark — the stacked "drift" cards (a muted card behind,
 *  the accent card in front) with the device dot, matching the app icon/logo.
 *  Replaces the older abstract strokes (founder 2026-06-18: "use our own logo").
 *  Reads cleanly at 14px. */
function DriftMark(): JSX.Element {
  return (
    <svg
      data-component="drift-mark"
      width="15"
      height="15"
      viewBox="0 0 24 24"
      fill="none"
      className="text-accent"
      aria-hidden="true"
    >
      {/* Back card — the drift/stack layer, the accent dimmed. */}
      <rect x="3.5" y="5" width="10" height="14.5" rx="3" fill="currentColor" opacity="0.3" />
      {/* Front card — the brand accent, offset like the logo. */}
      <rect x="9" y="3.5" width="11" height="16" rx="3.2" fill="currentColor" />
      {/* Device dot. */}
      <circle cx="14.5" cy="15.2" r="1.2" fill="#fff" opacity="0.85" />
    </svg>
  );
}

export function DeviceToolbar({
  deviceName,
  profileName,
  running,
  connecting = false,
  keyboardVisible,
  onToggleKeyboard,
  inputEnabled = true,
}: {
  deviceName: string;
  profileName: string;
  /** True when the live video is actually connected + publishing — drives the
   *  green "Live" indicator (so it never lights before the stream arrives). */
  running: boolean;
  /** True when a session is bound but the stream hasn't connected yet — drives an
   *  amber "Connecting…" indicator in place of "Live". */
  connecting?: boolean;
  /** On-screen iOS keyboard visibility + its toggle (founder 2026-06-25). */
  keyboardVisible: boolean;
  onToggleKeyboard: () => void;
  /** False in AI mode — the agent is driving, so manual input is off. Finding #5:
   *  the ⌨ toggle is dead in AI mode (both keyboard render sites gate on
   *  controlMode !== 'ai'), so disable it rather than letting it light up "pressed"
   *  while nothing appears (and nudge the window for a keyboard that never shows). */
  inputEnabled?: boolean;
}): JSX.Element {
  // The activity-bar rail is always docked beside the phone (it lives in the main
  // layout, not this thin toolbar); panes expand on a rail-icon click. There is no
  // longer a whole-drawer toggle here, so the toolbar has no chevron.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  // Robust window drag: data-tauri-drag-region is flaky on macOS over a
  // borderless toolbar (founder 2026-06-18: "not the whole topbar drags").
  // Start a real OS drag on primary-button press anywhere on the bar EXCEPT
  // interactive controls — so the entire toolbar is a grab handle.
  const startToolbarDrag = (e: { button: number; target: EventTarget | null }): void => {
    if (e.button !== 0) return;
    const el = e.target as HTMLElement | null;
    if (el?.closest('button, input, textarea, a, select, [data-no-drag]')) return;
    void withCurrentWindow((w) => w.startDragging());
  };
  return (
    <div ref={wrapRef} data-component="simulator-toolbar-wrap" className="relative w-full shrink-0">
      <div
        onPointerDown={startToolbarDrag}
        data-component="simulator-toolbar"
        className="flex h-[34px] w-full items-center gap-2 rounded-t-[16px] bg-[#1d1e24] px-3 ring-1 ring-white/[0.12] backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.10),inset_0_-1px_0_rgba(0,0,0,0.45)]"
      >
        {/* Left — window controls. The window is BORDERLESS (the iPhone look),
            so these ARE the only close/minimize affordance. */}
        <div data-tauri-drag-region="false" className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={() => void withCurrentWindow((w) => w.close())}
            className="h-3 w-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)] ring-1 ring-black/20 transition hover:brightness-110"
          />
          <button
            type="button"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => void withCurrentWindow((w) => w.minimize())}
            className="h-3 w-3 rounded-full bg-[#febc2e] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)] ring-1 ring-black/20 transition hover:brightness-110"
          />
        </div>
        {/* Center — Drift mark + identity (profile primary, device muted). In
            Browser mode the URL lives in the dedicated browser bar below the
            toolbar, so the identity stays here in every mode. */}
        <div
          data-tauri-drag-region
          className="pointer-events-none flex min-w-0 flex-1 items-center justify-center gap-1.5"
        >
          <DriftMark />
          <span className="max-w-[140px] truncate text-[11px] font-semibold tracking-tight text-white/85">
            {profileName !== '' ? profileName : deviceName}
          </span>
          {profileName !== '' && (
            <span className="hidden truncate text-[11px] tracking-tight text-white/45 sm:inline">
              · {deviceName}
            </span>
          )}
        </div>
        {/* Right — quick Record. The window-controls (rotate / pin / info) live
            in the always-docked rail's expandable panes, so the default chrome
            stays minimal (founder 2026-06-17: "phone showing only" by default). */}
        <div data-tauri-drag-region="false" className="flex items-center gap-1 text-white/70">
          {/* Running indicator (founder Track A) — a live pulse so the window
              reads as a RUNNING session at a glance (today only the per-mode
              window-close existed; no inline running cue). */}
          {running ? (
            <span
              data-component="simulator-running-indicator"
              title="Live video connected"
              className="mr-0.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-status-ready"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ready shadow-[0_0_6px_rgb(var(--status-ready-rgb))]"
              />
              Live
            </span>
          ) : connecting ? (
            <span
              data-component="simulator-connecting-indicator"
              title="Connecting to the live video…"
              className="mr-0.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-status-busy"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-busy"
              />
              Connecting…
            </span>
          ) : null}
          {/* On-screen iOS keyboard toggle (founder 2026-06-25 "behave exactly
              like a real iPhone"). Manual v1 — auto-show-on-focus is deferred to
              A3's box-side focus signal (W2992). */}
          <button
            type="button"
            aria-label={
              !inputEnabled
                ? 'Keyboard unavailable while the agent is driving'
                : keyboardVisible
                  ? 'Hide keyboard'
                  : 'Show keyboard'
            }
            title={
              !inputEnabled
                ? 'The agent is driving — switch to Manual to type'
                : keyboardVisible
                  ? 'Hide the on-screen keyboard'
                  : 'Show the on-screen keyboard'
            }
            aria-pressed={inputEnabled && keyboardVisible}
            disabled={!inputEnabled}
            data-component="simulator-keyboard-toggle"
            className={
              !inputEnabled
                ? 'rounded px-2 py-0.5 text-[18px] leading-none text-white/25 cursor-not-allowed'
                : keyboardVisible
                  ? 'rounded bg-white/10 px-2 py-0.5 text-[18px] leading-none text-accent transition hover:bg-white/15'
                  : 'rounded px-2 py-0.5 text-[18px] leading-none transition hover:bg-white/10 hover:text-ink-primary'
            }
            onClick={onToggleKeyboard}
          >
            ⌨
          </button>
        </div>
      </div>
    </div>
  );
}

/** One labelled row in the simulator's expandable control panel — a glyph + a
 *  text label (clearer than the old cryptic icon-only toolbar), with an active
 *  accent state for the toggles (rotate / pin / info). */
function LabeledControl({
  glyph,
  label,
  hint,
  active,
  onClick,
}: {
  glyph: JSX.Element;
  label: string;
  hint?: string;
  active?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={active}
      title={hint ?? label}
      onClick={onClick}
      className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-[11.5px] transition-colors hover:bg-white/10 ${
        active === true ? 'text-accent' : 'text-ink-secondary hover:text-ink-primary'
      }`}
    >
      <span className="w-4 shrink-0 text-center leading-none" aria-hidden="true">
        {glyph}
      </span>
      <span className="leading-none">{label}</span>
    </button>
  );
}

/** Approach B icon rail (founder 2026-06-24, APPROVED). Hand-rolled inline
 *  stroke-SVG glyphs (viewBox 0 0 24 24, currentColor — no icon-font dependency,
 *  mirroring the existing LabeledControl / chevron SVG idiom) — one per drawer
 *  section. */
const SIM_PANE_ICONS: Record<SimDrawerPane, JSX.Element> = {
  // Session — a control dial.
  session: (
    <>
      <circle cx="12" cy="12" r="3.2" />
      <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
    </>
  ),
  // Controls — sliders.
  controls: (
    <>
      <path d="M4 6h10M18 6h2M4 12h2M10 12h10M4 18h13M21 18h-1" />
      <circle cx="16" cy="6" r="2" />
      <circle cx="8" cy="12" r="2" />
      <circle cx="19" cy="18" r="2" />
    </>
  ),
  // Diagnostics — a pulse/activity line.
  diagnostics: <path d="M3 12h4l2-6 4 12 2-6h6" />,
  // Cookies — a cookie with bites + chips.
  cookies: (
    <>
      <path d="M12 3a9 9 0 1 0 9 9 3 3 0 0 1-3-3 3 3 0 0 1-3-3 3 3 0 0 1-3-3z" />
      <circle cx="9" cy="11" r="0.6" />
      <circle cx="13" cy="15" r="0.6" />
      <circle cx="16" cy="11.5" r="0.6" />
    </>
  ),
  // Files — an upload tray.
  files: (
    <>
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
      <path d="M12 15V4M8 8l4-4 4 4" />
    </>
  ),
  // Downloads — a download tray.
  downloads: (
    <>
      <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" />
      <path d="M12 4v11M8 11l4 4 4-4" />
    </>
  ),
  // Recording — a record disc.
  recording: (
    <>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" />
    </>
  ),
};
const SIM_PANE_TITLES: Record<SimDrawerPane, string> = {
  session: 'Session',
  controls: 'Controls',
  diagnostics: 'Diagnostics',
  cookies: 'Cookies',
  files: 'Files',
  downloads: 'Downloads',
  recording: 'Recording',
};

/** One icon button in the Approach-B drawer rail — a square, ~44px tap target
 *  with a hand-rolled stroke-SVG glyph. The active section gets the accent
 *  background; an optional `pulse` (recording) shows a small live dot. */
function DrawerRailButton({
  pane,
  active,
  pulse,
  onSelect,
}: {
  pane: SimDrawerPane;
  active: boolean;
  pulse?: boolean;
  onSelect: (pane: SimDrawerPane) => void;
}): JSX.Element {
  const title = SIM_PANE_TITLES[pane];
  return (
    <button
      type="button"
      data-component={`sim-rail-${pane}`}
      aria-label={title}
      aria-pressed={active}
      onClick={() => onSelect(pane)}
      className={`group relative flex h-9 w-9 items-center justify-center rounded-lg transition-colors ${
        active
          ? 'bg-accent/20 text-accent ring-1 ring-accent/40'
          : 'text-ink-secondary hover:bg-white/10 hover:text-ink-primary'
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
        {SIM_PANE_ICONS[pane]}
      </svg>
      {pulse === true && (
        <span
          aria-hidden="true"
          className="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full bg-red-500 shadow-[0_0_5px_rgba(239,68,68,0.9)]"
        />
      )}
      {/* Custom hover label — the native title= tooltip is unreliable/slow in the Tauri
          WKWebView (founder couldn't see what an icon was for), so show an IMMEDIATE
          flyout to the LEFT (over the phone edge, so it never clips at the window edge)
          naming the section. pointer-events-none so it never blocks the icon click. */}
      <span
        aria-hidden="true"
        className="pointer-events-none absolute right-full top-1/2 z-50 mr-2 -translate-y-1/2 translate-x-1 whitespace-nowrap rounded-md bg-[#1d1e24] px-2 py-1 text-xs font-medium text-ink-primary opacity-0 shadow-lg ring-1 ring-white/15 transition-all duration-100 group-hover:translate-x-0 group-hover:opacity-100"
      >
        {title}
      </span>
    </button>
  );
}

/** The session-control block at the TOP of the expandable panel — an iOS-style
 *  segmented Mode switch (Agent · Pair · Manual) as the hero, a mode-aware
 *  caption, the contextual Take-over/Hand-back row (pair only), and a panel-only
 *  "tell the agent" composer (ai/pair). Replaces the old static "Full control"
 *  line; the window-chrome rows render below it, unchanged. */
const MODE_OPTIONS: { value: SessionMode; label: string }[] = [
  { value: 'ai', label: 'Agent' },
  { value: 'pair', label: 'Pair' },
  { value: 'manual', label: 'Manual' },
];

export function SessionControlSection({
  mode,
  pairKind,
  busy,
  composerText,
  controlError,
  onRetryControl,
  onSetMode,
  onTakeover,
  onHandback,
  onComposerChange,
  onSendMessage,
}: {
  mode: SessionMode | null;
  pairKind: string | null;
  busy: boolean;
  composerText: string;
  /** Last getAgentSession failure, classified — null when controls loaded /
   *  loading. Drives the "controls unavailable — Retry" caption instead of a
   *  permanent "Connecting…" (founder 2026-06-18). */
  controlError: string | null;
  onRetryControl: () => void;
  onSetMode: (m: SessionMode) => void;
  onTakeover: () => void;
  onHandback: () => void;
  onComposerChange: (v: string) => void;
  onSendMessage: () => void;
}): JSX.Element {
  // One source of truth for the caption + the take-over/hand-back verb: the
  // pair_mode_state.kind carries 'human' when the human holds the pair lock.
  const humanDriving = pairKind !== null && /human/i.test(pairKind);
  // Three control states: loaded (mode set) → mode caption; failed
  // (controlError set, mode still null) → unavailable + Retry; genuine first
  // load (mode null, no error) → "Connecting…".
  const failed = mode === null && controlError !== null;
  const caption = failed
    ? controlError
    : mode === null
      ? 'Connecting…'
      : mode === 'manual'
        ? 'Manual — tap the screen to drive'
        : mode === 'pair'
          ? humanDriving
            ? "You're driving — agent is paused"
            : 'Pair — agent drives, tap to take over'
          : 'Agent is driving — watching live';
  return (
    <div data-component="simulator-control-section">
      <div className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
        Mode
      </div>
      {/* Segmented Mode switch — the hero control. */}
      <div
        role="group"
        aria-label="Session control mode"
        className="mx-3 flex gap-0.5 rounded-lg bg-black/40 p-0.5 ring-1 ring-white/10"
      >
        {MODE_OPTIONS.map((opt) => {
          const active = mode === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              role="radio"
              aria-checked={active}
              aria-label={`${opt.label} mode`}
              disabled={busy || mode === null}
              onClick={() => onSetMode(opt.value)}
              className={`flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors disabled:opacity-50 ${
                active
                  ? 'bg-white/15 text-ink-primary ring-1 ring-white/20'
                  : 'text-ink-secondary hover:bg-white/[0.06] hover:text-ink-primary'
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      <div className="flex items-center gap-1.5 px-3 pt-1.5 text-[10.5px] text-ink-muted">
        <span
          aria-hidden="true"
          className={`${failed ? 'text-amber-400' : 'text-accent'} ${mode === 'ai' ? 'animate-pulse' : ''}`}
        >
          ◉
        </span>
        <span className={failed ? 'text-amber-300' : undefined}>{caption}</span>
        {failed && (
          <button
            type="button"
            onClick={onRetryControl}
            className="ml-auto shrink-0 rounded px-1.5 py-0.5 text-[10.5px] font-medium text-accent transition-colors hover:bg-white/10"
          >
            Retry
          </button>
        )}
      </div>
      {/* Contextual take-over / hand-back — only meaningful in pair mode. */}
      {mode === 'pair' && (
        <button
          type="button"
          disabled={busy}
          onClick={humanDriving ? onHandback : onTakeover}
          className="mt-1.5 flex w-full items-center gap-2 px-3 py-1.5 text-left text-[11.5px] text-ink-secondary transition-colors hover:bg-white/10 hover:text-ink-primary disabled:opacity-50"
        >
          <span className="w-4 shrink-0 text-center leading-none" aria-hidden="true">
            {humanDriving ? '⤺' : '⤿'}
          </span>
          <span className="leading-none">
            {humanDriving ? 'Hand back to agent' : 'Take control'}
          </span>
        </button>
      )}
      {/* "Tell the agent" composer — only when the agent is in the loop (ai/pair),
          panel-only so it never collides with the on-screen keyboard. */}
      {(mode === 'ai' || mode === 'pair') && (
        <form
          className="mx-3 mt-1.5 flex items-center gap-1 rounded-lg bg-black/40 px-2 py-1 ring-1 ring-white/10"
          onSubmit={(e) => {
            e.preventDefault();
            onSendMessage();
          }}
        >
          <input
            type="text"
            value={composerText}
            disabled={busy}
            onChange={(e) => onComposerChange(e.target.value)}
            placeholder="Tell the agent…"
            aria-label="Tell the agent"
            className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink-primary placeholder:text-ink-muted focus:outline-none"
          />
          <button
            type="submit"
            disabled={busy || composerText.trim() === ''}
            aria-label="Send to agent"
            className="shrink-0 rounded p-1 text-accent transition hover:bg-white/10 disabled:opacity-40"
          >
            ➤
          </button>
        </form>
      )}
      <div className="mx-3 my-1.5 h-px bg-white/10" aria-hidden="true" />
    </div>
  );
}

/** Address bar in the expandable control panel (founder 2026-06-19: "can't press
 *  the URL bar"). The fork's rendered iOS-Safari URL bar is browser CHROME, which
 *  the WebDriver page-touch path can't drive — so the GUI provides its own. On
 *  submit it normalizes the entry to an http(s) URL (prepends https:// when no
 *  scheme) and emits a `navigate` command on the SAME LiveKit data channel as
 *  taps; the fork's chrome URL bar stays visual-only. Mirrors the in-app
 *  LiveSessionView address-bar UX (reload affordance + a text field + a Go
 *  submit). Disabled until a control channel is connected (canNavigate). */
function NavigateAddressBar({
  canNavigate,
  onNavigate,
  liveUrl,
}: {
  canNavigate: boolean;
  onNavigate: (url: string) => void;
  /** The page the device is currently on — so Reload works on a loaded page without
   *  first typing (draftUrl starts empty). Mirrors BrowserBar's reload. */
  liveUrl: string;
}): JSX.Element {
  const [draftUrl, setDraftUrl] = useState('');
  // While the control channel is still connecting (the room can take up to ~30s
  // to come up), the bar is disabled — but a bare disabled field reads as
  // BROKEN. Surface an explicit "connecting…" affordance (placeholder + tooltip
  // + a caption) so the wait is legible and distinct from a real failure (which
  // surfaces separately as a navigate-error notice toast).
  const placeholder = canNavigate
    ? 'Search or enter address'
    : 'connecting… — the address bar unlocks once the device is live';
  const disabledTitle = 'Connecting to the device — the address bar unlocks once it is live';
  return (
    <div data-component="simulator-address" className="px-3 pb-1.5 pt-0.5">
      <div className="flex items-center justify-between px-0 pb-1 text-[10px] font-semibold uppercase tracking-wide text-ink-muted">
        <span>Address</span>
        {!canNavigate && (
          <span
            data-component="simulator-address-connecting"
            className="inline-flex items-center gap-1 font-medium normal-case tracking-normal text-ink-secondary"
          >
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber-400"
            />
            connecting…
          </span>
        )}
      </div>
      <form
        className="flex items-center gap-1 rounded-lg bg-black/40 px-2 py-1 ring-1 ring-white/10"
        onSubmit={(e) => {
          e.preventDefault();
          if (!canNavigate) return;
          onNavigate(draftUrl);
        }}
      >
        <button
          type="button"
          disabled={!canNavigate}
          aria-label="Reload"
          title={canNavigate ? 'Reload the current page' : disabledTitle}
          onClick={() => {
            // Reload the page the device is ACTUALLY on (liveUrl), NOT the empty/half-typed
            // draft — so ↻ works on a loaded page without first typing an address (audit
            // 2026-07-08). Falls back to the draft when liveUrl isn't known yet.
            const target = liveUrl.trim() !== '' ? liveUrl.trim() : draftUrl.trim();
            if (canNavigate && target !== '') onNavigate(target);
          }}
          className="shrink-0 rounded p-1 text-ink-secondary transition hover:bg-white/10 hover:text-ink-primary disabled:opacity-40"
        >
          ↻
        </button>
        <input
          type="text"
          value={draftUrl}
          disabled={!canNavigate}
          onChange={(e) => setDraftUrl(e.target.value)}
          placeholder={placeholder}
          title={canNavigate ? undefined : disabledTitle}
          spellCheck={false}
          autoComplete="off"
          aria-label="Address bar"
          className="min-w-0 flex-1 bg-transparent text-[11.5px] text-ink-primary placeholder:text-ink-muted focus:outline-none disabled:opacity-50"
        />
        <button
          type="submit"
          disabled={!canNavigate || draftUrl.trim() === ''}
          aria-label="Go to URL"
          title={canNavigate ? 'Go to URL' : disabledTitle}
          className="shrink-0 rounded p-1 text-accent transition hover:bg-white/10 disabled:opacity-40"
        >
          ⏎
        </button>
      </form>
    </div>
  );
}

/**
 * Browser mode (founder 2026-06-21): a dedicated, full-width browser-chrome bar
 * below the toolbar — a real native address bar (the rendered iOS Safari pill is
 * un-tappable fork chrome). Reload + a bigger live URL field + a loading bar. The
 * live URL + load progress come from A3's page_state over the data channel (bus
 * W2719); until then onNavigate drives an optimistic loading sweep. The field
 * follows the live URL while not being edited. `data-no-drag` so the toolbar's
 * window-drag handler doesn't hijack clicks here.
 */
function BrowserBar({
  canNavigate,
  onNavigate,
  onHistory,
  liveUrl,
  pageLoading,
  loadProgress,
  downloadCount,
  onOpenDownloads,
}: {
  canNavigate: boolean;
  onNavigate: (url: string) => void;
  // Sim back/forward (A3 W2870) — steps the device's browser history via
  // navigateAgentSessionHistory. Rendered only when BACK_FORWARD_ENABLED (flag-off
  // until A3's daemon handler lands).
  onHistory: (direction: 'back' | 'forward') => void;
  liveUrl: string;
  pageLoading: boolean;
  loadProgress: number | null;
  // Mocked iOS download-bar indicator — GUI chrome only (like the address bar; it
  // never touches the rendered iPhone/fingerprint). Count of the session's downloads
  // (reuses the Downloads pane's shared `downloads` state — no second fetch).
  downloadCount: number;
  // Opens the Downloads drawer pane (mirrors the rail buttons' pane switch).
  onOpenDownloads: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(liveUrl);
  const [focused, setFocused] = useState(false);
  // Follow the live URL when the user isn't editing (so a redirect/link-tap
  // updates the bar), but never clobber what they're typing.
  useEffect(() => {
    if (!focused) setDraft(liveUrl);
  }, [liveUrl, focused]);
  // Realistic browser-style load progress (founder: "realistic progress of the
  // page's loading, just like our web browser"). A3 only emits progress 0 (start)
  // then 1 (done), so a raw bar would jump 0→100%. Instead trickle the DISPLAYED
  // progress up toward ~90% while loading (nprogress-style, decelerating — never
  // quite reaching it), snap to 100% on completion, then fade out.
  const [barProgress, setBarProgress] = useState(0);
  const [barVisible, setBarVisible] = useState(false);
  const trickleRef = useRef<number | null>(null);
  const hideRef = useRef<number | null>(null);
  const loadingActiveRef = useRef(false);
  useEffect(() => {
    if (pageLoading) {
      loadingActiveRef.current = true;
      if (hideRef.current !== null) {
        window.clearTimeout(hideRef.current);
        hideRef.current = null;
      }
      setBarVisible(true);
      // Seed from the reported progress (≥ a small visible base); never go backwards.
      setBarProgress((p) => Math.max(p, loadProgress ?? 0, 0.08));
      if (trickleRef.current === null) {
        trickleRef.current = window.setInterval(() => {
          setBarProgress((p) => (p >= 0.9 ? p : p + (0.9 - p) * 0.12));
        }, 400);
      }
    } else if (loadingActiveRef.current) {
      // Was loading, now done → snap to 100%, then fade the bar out.
      loadingActiveRef.current = false;
      if (trickleRef.current !== null) {
        window.clearInterval(trickleRef.current);
        trickleRef.current = null;
      }
      setBarProgress(1);
      hideRef.current = window.setTimeout(() => {
        setBarVisible(false);
        setBarProgress(0);
        hideRef.current = null;
      }, 300);
    }
  }, [pageLoading, loadProgress]);
  useEffect(
    () => () => {
      if (trickleRef.current !== null) window.clearInterval(trickleRef.current);
      if (hideRef.current !== null) window.clearTimeout(hideRef.current);
    },
    [],
  );
  const submit = (): void => {
    if (canNavigate && draft.trim() !== '') onNavigate(draft.trim());
  };
  // Reload re-loads the page the device is ACTUALLY on (a same-URL navigate is a
  // reload), not whatever half-typed text sits in the draft field — clicking
  // Reload mid-edit must never silently navigate away. Falls back to the draft
  // only when the live URL isn't known yet (first page not yet reported).
  const reload = (): void => {
    if (!canNavigate) return;
    // Reload re-loads the page the device is ACTUALLY on (a same-URL navigate is a
    // reload). Navigate the live URL VERBATIM via normalizeNavigateUrl — NOT the
    // omnibox resolver — so a non-http device URL (the initial about:blank, data:, …)
    // is a no-op rather than a Google search for the literal text.
    const target = normalizeNavigateUrl((liveUrl || draft).trim());
    if (target !== null) onNavigate(target);
  };
  // Copy the live URL to the clipboard (a browser-chrome affordance) with a brief
  // "Copied" confirmation. Mirrors the app's existing clipboard pattern
  // (CryptoReceiptView). A locked-down WKWebView can leave navigator.clipboard
  // undefined OR reject the write — surface either as a brief "Couldn't copy"
  // on the button tooltip rather than a dead click.
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const flagCopyFailed = (): void => {
    setCopyFailed(true);
    window.setTimeout(() => setCopyFailed(false), 1600);
  };
  const copyUrl = (): void => {
    const text = (liveUrl || draft).trim();
    if (text === '') return;
    const write = navigator.clipboard?.writeText(text);
    if (write === undefined) {
      flagCopyFailed();
      return;
    }
    void write.then(() => {
      setCopyFailed(false);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    }, flagCopyFailed);
  };
  const copyTarget = (liveUrl || draft).trim();
  // iOS-Safari address treatment: a closed padlock for https origins and, while
  // not editing, the resting field collapses to the hostname (example.com) rather
  // than the raw full URL. Display-only — draft/submit/reload/copy keep the full
  // URL so navigation logic is untouched. about:blank / data: / empty / unparseable
  // values throw in new URL() → fall back to the raw value (never an empty bar),
  // reusing the tab-strip's proven try/catch pattern. (eTLD+1 collapse would need a
  // public-suffix list; .host is the file's existing convention + a large win.)
  const isHttps = (() => {
    try {
      return new URL(liveUrl).protocol === 'https:';
    } catch {
      return false;
    }
  })();
  const restingDisplay = (() => {
    // Founder 2026-06-29: show host + path + query (NOT host-only) so the resting bar
    // visibly reflects the REAL current URL as the page navigates within a site —
    // host-only collapsed every same-site navigation to the unchanged hostname, which
    // read as "the URL isn't updating in realtime". Drop only the scheme (the lock
    // icon already conveys https) so the bar stays clean but tracks the live URL.
    // about:blank / data: / empty / unparseable fall back to the raw value.
    try {
      const u = new URL(liveUrl);
      // No host (data:/about:/blob:) → show the raw value (a bare path would be
      // confusing). With a host, show host + path + query so same-site navigation is
      // visible in the resting bar; strip a lone trailing slash for cleanliness.
      if (u.host === '') return liveUrl;
      const tail = `${u.host}${u.pathname}${u.search}${u.hash}`.replace(/\/$/, '');
      return tail.length > 0 ? tail : u.host;
    } catch {
      return liveUrl;
    }
  })();
  return (
    <div
      data-component="simulator-address-bar"
      data-no-drag
      className="relative flex h-10 w-full shrink-0 items-center gap-2 bg-[#1d1e24] px-3 ring-1 ring-white/[0.10] shadow-[inset_0_-1px_0_rgba(0,0,0,0.45)]"
    >
      {/* Sim back/forward (A3 W2870) — built but NOT rendered until the wire is live;
          BACK_FORWARD_ENABLED flips true when A3's navigateHistory handler deploys. */}
      {BACK_FORWARD_ENABLED && (
        <>
          <button
            type="button"
            aria-label="Back"
            title={canNavigate ? 'Back' : 'Connecting…'}
            disabled={!canNavigate}
            onClick={() => onHistory('back')}
            className="shrink-0 rounded-md p-1 text-ink-secondary transition hover:bg-white/10 hover:text-ink-primary disabled:opacity-40"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M15 18l-6-6 6-6" />
            </svg>
          </button>
          <button
            type="button"
            aria-label="Forward"
            title={canNavigate ? 'Forward' : 'Connecting…'}
            disabled={!canNavigate}
            onClick={() => onHistory('forward')}
            className="shrink-0 rounded-md p-1 text-ink-secondary transition hover:bg-white/10 hover:text-ink-primary disabled:opacity-40"
          >
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M9 18l6-6-6-6" />
            </svg>
          </button>
        </>
      )}
      <button
        type="button"
        aria-label="Reload"
        title={canNavigate ? 'Reload' : 'Connecting…'}
        disabled={!canNavigate}
        onClick={reload}
        className="shrink-0 rounded-md p-1 text-ink-secondary transition hover:bg-white/10 hover:text-ink-primary disabled:opacity-40"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M23 4v6h-6" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
      </button>
      <form
        className="flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md bg-black/30 px-2.5 ring-1 ring-white/10 transition focus-within:bg-black/40 focus-within:ring-white/25"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {isHttps ? (
          // Closed padlock — https origin (iOS Safari secure-site treatment).
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 text-white/35"
          >
            <rect x="5" y="11" width="14" height="10" rx="2" />
            <path d="M8 11V7a4 4 0 0 1 8 0v4" />
          </svg>
        ) : (
          // Globe — http / about: / data: / unparseable (neutral, lower-risk).
          <svg
            viewBox="0 0 24 24"
            width="12"
            height="12"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
            className="shrink-0 text-white/35"
          >
            <circle cx="12" cy="12" r="9" />
            <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
          </svg>
        )}
        <input
          type="text"
          // Resting → hostname-only (iOS Safari collapse); editing → full URL so
          // the user sees/edits the real address. draft still holds the full URL.
          value={focused ? draft : restingDisplay}
          disabled={!canNavigate}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={(e) => {
            setFocused(true);
            // iOS Safari selects the whole URL on tap so the next keystroke
            // overtypes it (matches the omnibox muscle-memory).
            e.currentTarget.select();
          }}
          onBlur={() => setFocused(false)}
          placeholder={canNavigate ? 'Search or enter address' : 'connecting…'}
          title={
            canNavigate
              ? undefined
              : 'Connecting to the device — the address bar unlocks once it is live'
          }
          spellCheck={false}
          autoComplete="off"
          aria-label="Address bar"
          className="min-w-0 flex-1 bg-transparent text-[12px] leading-none text-white/90 placeholder:text-white/35 focus:outline-none disabled:opacity-50"
        />
        <button
          type="button"
          aria-label={copyFailed ? "Couldn't copy" : copied ? 'Copied' : 'Copy URL'}
          title={
            copyFailed ? "Couldn't copy — clipboard blocked" : copied ? 'Copied' : 'Copy address'
          }
          disabled={copyTarget === ''}
          onClick={copyUrl}
          className="shrink-0 rounded p-0.5 text-white/35 transition hover:text-white/80 disabled:opacity-30"
        >
          {copied ? (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              className="text-accent"
            >
              <path d="M20 6 9 17l-5-5" />
            </svg>
          ) : (
            <svg
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
            </svg>
          )}
        </button>
      </form>
      {/* Mocked iOS download-bar indicator (GUI chrome — like the address bar; never
          affects the rendered iPhone/fingerprint). A down-arrow-into-tray button with a
          small count pill; clicking opens the Downloads drawer pane. Hidden when there
          are no downloads (mirrors copy-URL's disabled-when-empty convention). */}
      {downloadCount > 0 && (
        <button
          type="button"
          data-component="simulator-download-indicator"
          aria-label={`Downloads (${downloadCount})`}
          title={`Downloads (${downloadCount}) — open the Downloads panel`}
          onClick={onOpenDownloads}
          className="relative shrink-0 rounded-md p-1 text-ink-secondary transition hover:bg-white/10 hover:text-ink-primary"
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M4 15v4h16v-4" />
            <line x1="12" y1="3" x2="12" y2="14" />
            <polyline points="8,10 12,14 16,10" />
          </svg>
          <span
            data-component="simulator-download-count"
            aria-hidden="true"
            className="absolute -right-1 -top-1 flex min-w-[14px] items-center justify-center rounded-full bg-accent px-1 text-[9px] font-semibold leading-[14px] text-white"
          >
            {downloadCount > 99 ? '99+' : downloadCount}
          </span>
        </button>
      )}
      {/* Live loading bar — realistic browser-style trickle (founder W2719/2740).
          Climbs toward ~90% while loading, snaps to 100% + fades on completion. */}
      {barVisible && (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute bottom-0 left-0 h-[2px] w-full overflow-hidden"
        >
          <div
            data-component="simulator-loadbar"
            className="h-full bg-accent transition-[width,opacity] duration-200 ease-out"
            style={{
              width: `${Math.round(Math.max(0, Math.min(1, barProgress)) * 100)}%`,
              opacity: barProgress >= 1 ? 0 : 1,
            }}
          />
        </div>
      )}
    </div>
  );
}

/**
 * Browser-style page TAB strip (doc-150 item 4) — its own full-width row between the
 * Mac toolbar and the address bar, shown only in browser mode. Pure GUI chrome
 * OUTSIDE the video: switching tabs asks the harness to publish a different page, but
 * never changes the rendered 402×714 fingerprint viewport. Mirrors BrowserBar's dark,
 * compact Tailwind styling. Each tab shows title || url with a per-tab close ✕; a +
 * appends a new tab. Reorder-by-drag is intentionally omitted from v1 (a follow-up).
 */
function TabStrip({
  tabs,
  activeTabId,
  switchingTabId,
  onActivate,
  onClose,
  onNew,
}: {
  tabs: SimTab[];
  activeTabId: string;
  // INSTANT switch-feedback (founder 2026-06-25): the tab currently being switched
  // TO renders a subtle "switching…" affordance until the box reports its page. null
  // when no switch is in flight. iOS-clean, not over-animated.
  switchingTabId: string | null;
  onActivate: (id: string) => void;
  onClose: (id: string) => void;
  onNew: () => void;
}): JSX.Element {
  const label = (t: SimTab): string => {
    const url = t.url.trim();
    // A blank/new tab always reads as "New Tab" — the box reports the branded page's
    // own <title> ("New Tab · Driftstack") which is chrome, not a real page title; it
    // must not leak into the tab label (a fresh tab should look clean).
    if (isBlankTabUrl(url)) return 'New Tab';
    const title = t.title.trim();
    if (title !== '') return title;
    // Show the host (sans scheme) when possible, else the raw url — compact + readable.
    try {
      return new URL(url).host || url;
    } catch {
      return url;
    }
  };
  return (
    <div
      data-component="simulator-tab-strip"
      data-no-drag
      className="relative flex h-8 w-full shrink-0 items-stretch gap-1 overflow-x-auto bg-[#17181d] px-1.5 py-1 ring-1 ring-white/[0.08] shadow-[inset_0_-1px_0_rgba(0,0,0,0.45)]"
    >
      {tabs.map((t) => {
        const active = t.id === activeTabId;
        const switching = t.id === switchingTabId;
        return (
          <div
            key={t.id}
            data-component="simulator-tab"
            data-active={active ? 'true' : 'false'}
            data-switching={switching ? 'true' : 'false'}
            title={t.url || label(t)}
            onClick={() => onActivate(t.id)}
            className={`group relative flex min-w-[88px] max-w-[160px] shrink-0 cursor-default items-center gap-1.5 overflow-hidden rounded-md px-2 text-[11px] leading-none transition ${
              active
                ? 'bg-black/40 text-white/90 ring-1 ring-white/15'
                : 'bg-white/[0.04] text-white/55 hover:bg-white/[0.08] hover:text-white/80'
            }`}
          >
            {/* INSTANT switch-feedback (founder 2026-06-25): a small spinning glyph
                before the label while the box catches up to the switch. Tasteful,
                iOS-clean — cleared the moment the tab's page_state arrives. */}
            {switching && (
              <svg
                data-component="simulator-tab-switching"
                width="10"
                height="10"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
                aria-hidden="true"
                className="shrink-0 animate-spin text-white/70"
              >
                <path d="M21 12a9 9 0 1 1-6.22-8.56" />
              </svg>
            )}
            <span className="min-w-0 flex-1 truncate">{label(t)}</span>
            {tabs.length > 1 && (
              <button
                type="button"
                aria-label="Close tab"
                title="Close tab"
                onClick={(e) => {
                  // Don't let the close click bubble to the tab's activate handler.
                  e.stopPropagation();
                  onClose(t.id);
                }}
                className="shrink-0 rounded p-0.5 text-white/40 opacity-40 transition hover:bg-white/15 hover:text-white/90 focus:opacity-100 group-hover:opacity-100"
              >
                <svg
                  width="10"
                  height="10"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            )}
            {/* Thin progress hint along the bottom edge of the tab while switching —
                a subtle pulsing accent rule (NOT a full reflow). Built-in pulse, no
                custom keyframe; cleared the moment the tab's page_state arrives. */}
            {switching && (
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-x-1 bottom-0 h-[2px] animate-pulse rounded-full bg-accent/80"
              />
            )}
          </div>
        );
      })}
      <button
        type="button"
        aria-label="New tab"
        title="New tab"
        onClick={onNew}
        className="ml-0.5 flex shrink-0 items-center justify-center rounded-md px-2 text-white/45 transition hover:bg-white/10 hover:text-white/85"
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 5v14M5 12h14" />
        </svg>
      </button>
    </div>
  );
}

/**
 * Cosmetic iOS status bar — live clock + cellular/Wi-Fi/battery glyphs, with
 * the dynamic island centered in the strip. A DEDICATED black strip at the top
 * of the screen — the page video starts BELOW it, so it never overlaps browser
 * content (founder 2026-06-12: the overlay version could cover site headers;
 * keep it, but outside the content). Reads like an iPhone with a dark
 * safe-area. Drag-region (drag the window by the strip); inner content
 * pointer-events-none so a click on the strip falls through to drag.
 */
function IosStatusBar(): JSX.Element {
  const time = useStatusClock();
  return (
    <div
      aria-hidden="true"
      data-component="simulator-statusbar"
      data-tauri-drag-region
      className="relative flex h-[40px] w-full shrink-0 items-center justify-between bg-black px-[24px] text-white"
    >
      {/* Dynamic island — centered in the strip (its natural home now that the
          strip is reserved space rather than an overlay). Proportioned to the real
          iPhone island (~125×37pt at the 393–402pt device width): wider + taller
          than the old 92×26 pill so it reads as the island, not a notch dot. A
          faint top-rim highlight + soft outer shadow seat it as recessed glass. */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[32px] w-[120px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-black shadow-[inset_0_1px_1.5px_rgba(255,255,255,0.06),0_1px_2px_rgba(0,0,0,0.6)]"
      />
      <span className="pointer-events-none text-[14px] font-semibold tracking-tight tabular-nums">
        {time}
      </span>
      <div className="pointer-events-none flex items-center gap-[6px]">
        {/* Cellular — four full bars. */}
        <svg width="18" height="12" viewBox="0 0 18 12" fill="currentColor">
          <rect x="0" y="8" width="3" height="4" rx="1" />
          <rect x="5" y="6" width="3" height="6" rx="1" />
          <rect x="10" y="3" width="3" height="9" rx="1" />
          <rect x="15" y="0" width="3" height="12" rx="1" />
        </svg>
        {/* Wi-Fi — two arcs + dot. */}
        <svg width="16" height="12" viewBox="0 0 16 12" fill="currentColor">
          <path d="M8 2.4c2.6 0 5 1 6.8 2.7l-1.5 1.6C11.9 5.4 10 4.6 8 4.6s-3.9.8-5.3 2.1L1.2 5.1C3 3.4 5.4 2.4 8 2.4z" />
          <path d="M8 6.1c1.5 0 2.9.6 3.9 1.6l-1.6 1.6C9.7 8.7 8.9 8.3 8 8.3s-1.7.4-2.3 1L2.5 7.7C3.5 6.7 6.5 6.1 8 6.1z" />
          <circle cx="8" cy="10.5" r="1.3" />
        </svg>
        {/* Battery — full, with cap nub. */}
        <svg width="25" height="12" viewBox="0 0 25 12" fill="none">
          <rect
            x="0.5"
            y="0.5"
            width="21"
            height="11"
            rx="3"
            stroke="currentColor"
            strokeOpacity="0.5"
          />
          <rect x="2" y="2" width="18" height="8" rx="1.5" fill="currentColor" />
          <path d="M23 4c0.8 0.3 0.8 3.7 0 4z" fill="currentColor" fillOpacity="0.5" />
        </svg>
      </div>
    </div>
  );
}

// ── Fancy Cookies pane (founder 2026-06-24, APPROVED) ──────────────────────
// The Cookies section is a live, per-domain jar (mirrors the approved demo): a
// pulsing live indicator, Export (works today, client-side) + a disabled Import
// (the set-cookies wire is pending A3), a client-side search, and per-domain
// expandable groups with per-cookie flag chips. Pure presentation over the
// existing `cookies` / `cookiesNote` state — the poll + gating are unchanged.

/** Deterministic favicon-chip background for a domain — a small fixed palette
 *  (mirrors the demo's colors) keyed by a stable string hash so a domain always
 *  gets the same chip color across renders/sessions. */
const COOKIE_FAVICON_COLORS = ['#34d399', '#7dd3fc', '#fbbf24', '#c4b5fd', '#f87171'];
function cookieFaviconColor(domain: string): string {
  let hash = 0;
  for (let i = 0; i < domain.length; i += 1) {
    hash = (hash * 31 + domain.charCodeAt(i)) | 0;
  }
  const idx = Math.abs(hash) % COOKIE_FAVICON_COLORS.length;
  return COOKIE_FAVICON_COLORS[idx] ?? '#7dd3fc';
}

/** Format a cookie's expiry as a compact relative string from the REAL field.
 *  `expires` is a unix epoch that may arrive in SECONDS (~1.7e9) or MS (~1.7e12):
 *  the lib type doc says ms, but the box wire unit is ambiguous (Swift's
 *  timeIntervalSince1970 is seconds) and unverifiable against a live jar right now —
 *  so AUTO-DETECT by magnitude rather than guess (a wrong unit renders a wildly-
 *  future date). null/undefined = a session cookie. Returns "session" / "expired" /
 *  the largest sensible unit: `45m` / `3h` / `2d` / `3mo` / `1y`. */
function formatCookieExpiry(expires: number | null | undefined): string {
  if (expires === null || expires === undefined) return 'session';
  // seconds (~1.7e9) → ms; ms (~1.7e12) stays. 1e12 cleanly separates them.
  const expMs = expires < 1e12 ? expires * 1000 : expires;
  const ms = expMs - Date.now();
  if (ms <= 0) return 'expired';
  const sec = Math.floor(ms / 1000);
  const min = Math.floor(sec / 60);
  const hr = Math.floor(min / 60);
  const day = Math.floor(hr / 24);
  const mo = Math.floor(day / 30);
  const yr = Math.floor(day / 365);
  if (yr >= 1) return `${yr}y`;
  if (mo >= 1) return `${mo}mo`;
  if (day >= 1) return `${day}d`;
  if (hr >= 1) return `${hr}h`;
  if (min >= 1) return `${min}m`;
  return `${sec}s`;
}

/** Group the live jar by the cookie `domain` field, preserving first-seen order
 *  for both the groups and the cookies within each. */
function groupCookiesByDomain(
  cookies: SessionCookie[],
): { domain: string; cookies: SessionCookie[] }[] {
  const order: string[] = [];
  const byDomain = new Map<string, SessionCookie[]>();
  for (const c of cookies) {
    const list = byDomain.get(c.domain);
    if (list === undefined) {
      order.push(c.domain);
      byDomain.set(c.domain, [c]);
    } else {
      list.push(c);
    }
  }
  return order.map((domain) => ({ domain, cookies: byDomain.get(domain) ?? [] }));
}

/** One flag chip (Secure / HttpOnly / SameSite / expiry) derived from a cookie's
 *  REAL fields. Matches the approved demo's chip palette. */
function CookieFlag({
  kind,
  label,
}: {
  kind: 'secure' | 'http' | 'ss' | 'exp';
  label: string;
}): JSX.Element {
  const cls = {
    secure: 'bg-surface-inset text-ink-secondary',
    http: 'bg-surface-inset text-ink-secondary',
    ss: 'bg-surface-inset text-ink-secondary',
    exp: 'bg-white/10 text-white/45',
  }[kind];
  return (
    <span className={`rounded px-1.5 py-px text-[8.5px] font-semibold tracking-wide ${cls}`}>
      {label}
    </span>
  );
}

// (parseImportedCookies removed 2026-06-30 — the smart multi-format parseCookies in
// ../lib/cookie-import.ts supersedes the old JSON-array-only shape validator; founder #3
// "make import really smart so it takes many formats".)

/**
 * The fancy Cookies pane body — a self-contained sub-component so its local
 * search + per-domain open-state hooks live OUTSIDE the conditionally-rendered
 * branch in SimulatorWindow (hooks must be unconditional). Renders the inert
 * states (null → calm note; [] → "no cookies") and, when populated, the live
 * per-domain expandable jar with Export. Import reads a cookies.json, validates
 * the shape, and writes it into the live session over the control plane (the
 * write-twin of the cookies read); it no-ops gracefully ("ships with the next
 * device update") until A3's harness setCookies extension lands.
 */
function CookiesPane({
  cookies,
  cookiesNote,
  sessionId,
  controlAuth,
}: {
  cookies: SessionCookie[] | null;
  cookiesNote: string | null;
  sessionId: string;
  controlAuth: ControlAuth;
}): JSX.Element {
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [importing, setImporting] = useState(false);
  const [importNote, setImportNote] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  // Cookie values are truncated to fit — track which one was just copied so the
  // row can confirm it (the whole point of opening the panel is to read/copy a
  // value, which was previously impossible: truncated + unselectable).
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const copyCookieValue = (key: string, value: string): void => {
    const write = navigator.clipboard?.writeText(value);
    if (write === undefined) return;
    void write.then(
      () => {
        setCopiedKey(key);
        window.setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1200);
      },
      () => undefined,
    );
  };

  const query = search.trim().toLowerCase();
  const groups = cookies === null ? [] : groupCookiesByDomain(cookies);
  // Filter each group's cookies by name OR its domain, client-side.
  const filtered = groups
    .map((g) => ({
      domain: g.domain,
      cookies:
        query === ''
          ? g.cookies
          : g.cookies.filter(
              (c) => c.name.toLowerCase().includes(query) || g.domain.toLowerCase().includes(query),
            ),
    }))
    .filter((g) => g.cookies.length > 0);

  // A group is open when explicitly toggled; otherwise the first group + any
  // group matching the active search default to expanded.
  const isOpen = (domain: string, index: number): boolean =>
    open[domain] ?? (index === 0 || query !== '');
  const toggle = (domain: string): void =>
    setOpen((prev) => ({ ...prev, [domain]: !(prev[domain] ?? false) }));

  const canExport = cookies !== null && cookies.length >= 1;
  const onExport = (): void => {
    if (cookies === null || cookies.length === 0) return;
    // Shared exporter → clean JSON that round-trips with the smart importer + is
    // EditThisCookie/Playwright-compatible. AWAIT the write + surface a note: the old
    // fire-and-forget wrote to ~/Downloads silently, which read as "export not working"
    // (founder #3, 2026-06-30).
    const out = exportCookies(cookies, 'json');
    const n = cookies.length;
    void downloadBlob(out.filename, new Blob([out.text], { type: out.mime }))
      .then((ok) => {
        setImportNote(
          ok
            ? `Exported ${n} cookie${n === 1 ? '' : 's'} to your Downloads folder (${out.filename}).`
            : "Couldn't save the export — check the app's file-access permission.",
        );
      })
      // A rejected fs write must NOT escalate to the global unhandledrejection handler,
      // which blanks the whole simulator to a fatal overlay (the 2026-06-18 "undraggable
      // black box → force-quit" class). Surface a soft note instead.
      .catch(() => {
        setImportNote("Couldn't save the export — check the app's file-access permission.");
      });
  };

  // Import: read the chosen .json as text → JSON.parse → shape-validate an array of
  // cookies → write into the live session over the control plane. Surfaces success /
  // the failure reason / an honest "not available on this session right now" for the
  // gated-inert (status:'unavailable' / 503) state — so it no-ops gracefully until the
  // box half lands, without promising a (non-existent) future device update (#73).
  // Mirrors the upload pane's FileReader idiom (readAsText vs DataURL).
  const onImportFile = (file: File): void => {
    setImporting(true);
    setImportNote(null);
    const reader = new FileReader();
    reader.onerror = (): void => {
      setImporting(false);
      setImportNote('Could not read the file.');
    };
    reader.onload = (): void => {
      const text = typeof reader.result === 'string' ? reader.result : '';
      // Smart multi-format parse (Netscape cookies.txt / JSON array / EditThisCookie /
      // Playwright storageState / raw `Cookie:` header / name=value pairs — auto-detected).
      // Never throws; malformed lines become warnings (founder #3 2026-06-30 "make import
      // really smart so it takes many formats").
      const { cookies: validated, format, warnings } = parseCookies(text);
      if (validated.length === 0) {
        setImporting(false);
        setImportNote(
          warnings.length > 0
            ? `Couldn't read any cookies — ${warnings[0]}`
            : "Couldn't find any cookies in that file (tried JSON, cookies.txt, Cookie header + name=value).",
        );
        return;
      }
      // Client-side cap to match the server schema (z.array(CookieSchema).min(1).max(2000)).
      // A heavy browser export easily exceeds 2000; catch it before the round-trip so the
      // founder gets a precise reason instead of a generic server 422.
      if (validated.length > 2000) {
        setImporting(false);
        setImportNote('That cookies file has too many cookies (max 2000).');
        return;
      }
      const fmtNote = ` (read as ${format}${warnings.length > 0 ? `, ${warnings.length} skipped` : ''})`;
      void setAgentSessionCookies(sessionId, validated, controlAuth)
        .then((res) => {
          if (res.status === 'ok') {
            setImportNote(
              `Imported ${validated.length} cookie${validated.length === 1 ? '' : 's'}${fmtNote}.`,
            );
          } else if (res.status === 'unavailable') {
            setImportNote(
              res.reason !== undefined
                ? `Can't import right now: ${res.reason}`
                : "Can't import — cookie import isn't available on this session right now.",
            );
          } else if (res.status === 'timeout') {
            setImportNote("Import timed out — the device didn't respond.");
          } else {
            setImportNote(
              res.reason !== undefined ? `Import failed: ${res.reason}` : 'Import failed.',
            );
          }
        })
        .catch((err: unknown) => {
          // Surface the REAL failure instead of masking every error as "ships with the
          // next device update". A 422 = the server rejected the jar (too many cookies /
          // an invalid field); a 404 = the session is gone; only a 503 (gated/not-live)
          // gets the calm pending copy. authedFetch throws AgentSessionControlError(status).
          const status = err instanceof AgentSessionControlError ? err.status : 0;
          if (status === 422) {
            setImportNote('That cookies file was rejected (too many cookies or an invalid field).');
          } else if (status === 404) {
            setImportNote('Session is no longer live.');
          } else if (status === 503) {
            setImportNote("Cookie import isn't available on this session right now.");
          } else {
            setImportNote('Could not import cookies — please try again.');
          }
        })
        .finally(() => {
          setImporting(false);
        });
    };
    reader.readAsText(file);
  };
  const canImport = sessionId !== '' && !importing;

  return (
    <section
      data-component="simulator-cookies"
      className="flex flex-col overflow-hidden rounded-lg bg-black/20"
    >
      {/* Header row — title + live indicator + Export / Import. Wraps at the narrow
          252px drawer width so the action buttons never clip off-edge (founder #2
          2026-06-30 "all content of the sidebar must always be in view at small width") —
          the buttons drop to a second right-aligned row when the title + badge leave no
          room, and stay inline when the window is widened. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1.5 border-b border-white/10 px-3 pb-2 pt-2.5">
        <span className="flex items-center gap-1.5 font-sans text-[12px] font-semibold text-white">
          <span aria-hidden="true">🍪</span>
          Cookies
        </span>
        {cookies !== null && (
          <span
            data-component="simulator-cookies-live"
            className="inline-flex items-center gap-1 text-[9px] font-semibold uppercase tracking-wide text-ink-secondary"
          >
            <span aria-hidden="true" className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
            live
          </span>
        )}
        <span className="ml-auto flex items-center gap-1.5">
          <button
            type="button"
            data-action="export-cookies"
            aria-label="Export cookies"
            title="Export the cookie jar as JSON"
            disabled={!canExport}
            onClick={onExport}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-sans text-[10px] text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <span aria-hidden="true">⬇</span> Export
          </button>
          <button
            type="button"
            data-action="import-cookies"
            aria-label="Import cookies"
            title="Import cookies — JSON, cookies.txt, EditThisCookie, or a Cookie: header (auto-detected)"
            disabled={!canImport}
            onClick={() => importInputRef.current?.click()}
            className="inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-0.5 font-sans text-[10px] text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
          >
            <span aria-hidden="true">⬆</span> {importing ? 'Importing…' : 'Import'}
          </button>
          {/* Hidden native picker — the Import button is a styled trigger over it.
            Restricted to JSON; the onChange reads + validates + writes via onImportFile. */}
          <input
            ref={importInputRef}
            type="file"
            accept=".json,.txt,.text,application/json,text/plain"
            data-component="simulator-cookies-import-input"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportFile(f);
              e.target.value = '';
            }}
          />
        </span>
      </div>

      {/* Import outcome — success / validation error / the calm pending note. */}
      {importNote !== null && (
        <div
          data-component="simulator-cookies-import-note"
          className="border-b border-white/10 px-3 py-1.5 font-mono text-[10px] text-amber-300/80"
        >
          {importNote}
        </div>
      )}

      {/* Search — filters by cookie name OR domain. */}
      {cookies !== null && cookies.length > 0 && (
        <div className="px-3 pt-2">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search cookies or domains…"
            aria-label="Search cookies"
            spellCheck={false}
            autoComplete="off"
            className="w-full rounded-md border border-white/10 bg-black/25 px-2.5 py-1 font-sans text-[11px] text-white/90 placeholder:text-white/30 focus:border-white/25 focus:outline-none"
          />
        </div>
      )}

      {/* Body — inert states, then the per-domain expandable jar. Grows to use
          most of the simulator height (founder: the box was "only a small part of
          the height") — responsive cap so a long jar is browsable, short jars stay
          compact, and it never overflows the window. */}
      <div className="max-h-[55vh] overflow-y-auto px-2 py-2">
        {cookies === null ? (
          <div className="px-1 py-1 font-mono text-[10px] text-white/40">
            {cookiesNote ?? 'loading…'}
          </div>
        ) : cookies.length === 0 ? (
          <div className="px-1 py-1 font-mono text-[10px] text-white/40">
            no cookies on this page
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-1 py-1 font-mono text-[10px] text-white/40">no matching cookies</div>
        ) : (
          <div className="space-y-1">
            {filtered.map((g, i) => {
              const expanded = isOpen(g.domain, i);
              return (
                <div
                  key={g.domain}
                  data-component="simulator-cookie-domain"
                  className="overflow-hidden rounded-lg bg-black/20"
                >
                  <button
                    type="button"
                    aria-expanded={expanded}
                    aria-label={`${g.domain} cookies`}
                    onClick={() => toggle(g.domain)}
                    className="flex w-full items-center gap-2 px-2.5 py-2 text-left transition-colors hover:bg-white/5"
                  >
                    <span
                      aria-hidden="true"
                      style={{ backgroundColor: cookieFaviconColor(g.domain) }}
                      className="flex h-4 w-4 shrink-0 items-center justify-center rounded font-sans text-[9px] font-bold text-black/80"
                    >
                      {g.domain.charAt(0).toUpperCase()}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-sans text-[11.5px] font-semibold text-white/90">
                      {g.domain}
                    </span>
                    <span className="shrink-0 rounded-full bg-white/10 px-1.5 py-px font-sans text-[9.5px] text-white/50">
                      {g.cookies.length}
                    </span>
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                      className={`shrink-0 text-white/35 transition-transform ${expanded ? 'rotate-90' : ''}`}
                    >
                      <path d="M9 18l6-6-6-6" />
                    </svg>
                  </button>
                  {expanded && (
                    <div className="space-y-1 px-2 pb-2">
                      {g.cookies.map((c, ci) => (
                        <div
                          key={`${c.name}|${ci}`}
                          className="rounded-md bg-white/[0.025] px-2 py-1.5 transition-colors hover:bg-white/5"
                        >
                          <div className="flex items-center gap-1.5 font-mono text-[10.5px]">
                            <span className="shrink-0 font-semibold text-ink-secondary">
                              {c.name}
                            </span>
                            <button
                              type="button"
                              title={c.value === '' ? '(empty)' : `${c.value}\n(click to copy)`}
                              aria-label={`Copy value of ${c.name}`}
                              onClick={() =>
                                copyCookieValue(`${g.domain}|${c.name}|${ci}`, c.value)
                              }
                              className="min-w-0 flex-1 truncate text-left text-white/40 transition-colors hover:text-white/70"
                            >
                              {copiedKey === `${g.domain}|${c.name}|${ci}` ? 'Copied ✓' : c.value}
                            </button>
                          </div>
                          <div className="mt-1 flex flex-wrap gap-1">
                            {c.secure === true && <CookieFlag kind="secure" label="🔒 Secure" />}
                            {c.httpOnly === true && <CookieFlag kind="http" label="HttpOnly" />}
                            {c.sameSite !== undefined && c.sameSite !== null && (
                              <CookieFlag kind="ss" label={`SameSite=${c.sameSite}`} />
                            )}
                            <CookieFlag kind="exp" label={`⏱ ${formatCookieExpiry(c.expires)}`} />
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export function SimulatorWindow(): JSX.Element {
  // The session is held in state so the separate Simulator app's RELAUNCH path
  // can switch it in place: the single-instance handler emits a `ds-session`
  // event (instead of re-navigating, which would reload + tear down the live
  // Room), and the listener below re-parses the payload exactly like the initial
  // location.search and updates this state.
  const [query, setQuery] = useState<SessionQuery>(() => infoFromQuery());
  const { info, deviceName, profileName, proxyLabel, sessionId, countryCode, controlKey, baseUrl } =
    query;
  // Founder 2026-06-23 — the separate Simulator app starts with an empty settings
  // store (baseUrl → localhost:3000 default), so its control HTTP calls fail. The
  // launch hands off the real API host via `base=`; persist it so authedFetch
  // (loadSettings().baseUrl) targets the right server. Runs on mount + whenever a
  // relaunch swaps in a fresh base. Non-secret; merge-only; no-op when unchanged.
  useEffect(() => {
    if (baseUrl === '') return;
    void persistBaseUrl(baseUrl);
  }, [baseUrl]);
  // Per-session control credential. The SEPARATE simulator app can't
  // read the main app's keychain, so it authorizes the control
  // endpoints with the per-session gui_control_key instead of the
  // account API key. Resolution: the `?ck=` query param is the PRIMARY,
  // race-free handoff — seeded synchronously here so controlAuth is set
  // on the very first render (no reload race → getAgentSession succeeds →
  // mode resolves → the mode buttons enable). The 0600 temp-file handoff
  // (sim_key_take, Tauri command) is checked async below as a secondary
  // path and only OVERRIDES when it actually returns a key. null → use the
  // API key (in-app window). Re-loaded when the session switches.
  const [controlAuth, setControlAuth] = useState<ControlAuth>(() =>
    controlAuthWith(controlKey, baseUrl),
  );
  useEffect(() => {
    // A new room/session starts with a clean control-health slate — never carry
    // a latched controlUnreachable badge across a session switch.
    setControlUnreachable(false);
    if (sessionId === '') {
      setControlAuth(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      // Try the temp-file handoff first (Tauri-only). A returned key is
      // single-use — sim_key_take unlinks it — so we hold it in state.
      if (typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window) {
        try {
          const { invoke } = await import('@tauri-apps/api/core');
          const fromFile = await invoke<string | null>('sim_key_take', { sessionId });
          if (!cancelled && typeof fromFile === 'string' && fromFile.length > 0) {
            setControlAuth(controlAuthWith(fromFile, baseUrl));
            // Persist so a later REOPEN of this session (temp file already consumed,
            // no fresh ck=) can restore the key (founder 2026-06-23 control-failed).
            persistControlKey(sessionId, fromFile);
            return;
          }
        } catch {
          // No handoff file / not Tauri / command failed → fall through
          // to the query param (sandboxed) or API key (in-app).
        }
      }
      if (cancelled) return;
      // Query-param handoff (sandboxed launch) — persist it for reopens too.
      if (controlKey !== '') {
        setControlAuth(controlAuthWith(controlKey, baseUrl));
        persistControlKey(sessionId, controlKey);
        return;
      }
      // REOPEN survival (founder 2026-06-23): a relaunched/reopened separate-app
      // window arrives with NO fresh ck= and the single-use temp file already
      // consumed → controlAuth would be null and every control HTTP call
      // (mode / End-session / cookies) would fail, even though manual still works
      // over LiveKit. Restore the per-session key persisted from a prior launch. A
      // stale (>24h TTL) key just 401s, which now degrades to Manual rather than a
      // blocking error.
      const stored = readPersistedControlKey(sessionId);
      setControlAuth(controlAuthWith(stored, baseUrl));
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, controlKey, baseUrl]);
  // Relaunch session-switch listener (Tauri-only). The Rust side validated the
  // b64 payload before emitting; decode it the same way the initial launch does
  // (atob → query string) and re-parse. Also sync window.history so a later
  // reload keeps the new session.
  useEffect(() => {
    if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
    let unlisten: (() => void) | undefined;
    void (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlisten = await listen<string>('ds-session', (event) => {
        try {
          const search = atob(event.payload);
          const qs = search.startsWith('?') ? search : `?${search}`;
          window.history.replaceState({}, '', qs);
          setQuery(infoFromQuery(qs));
        } catch {
          // Garbled payload — ignore; the current session keeps streaming.
        }
      });
    })().catch(() => undefined); // listen()/import() unavailable (non-Tauri / mock) — no-op
    return () => {
      unlisten?.();
    };
  }, []);
  // Night-arc I Record pill: frames straight off the live <video> element
  // (the WebRTC stream IS the device screen) into the shared recordings
  // store — 1fps JPEG, same bounded-buffer semantics as the main window.
  const {
    startRecording,
    stopRecording,
    addFrame,
    deleteRecording,
    recordings,
    activeRecordingFor,
  } = useRecordings();
  const recordingId = sessionId !== '' ? activeRecordingFor(sessionId) : null;
  const recordTimerRef = useRef<number | null>(null);
  // The recId currently being captured. recordingId (derived from sessionId) flips to null
  // on an in-place session swap, so track the live id separately to finalize it on swap
  // (audit #2: else the 1fps loop writes the NEW session's frames into the OLD recording —
  // cross-session capture — the Record dot reads OFF, and the timer leaks).
  const activeRecIdRef = useRef<string | null>(null);
  function captureFrame(recId: string): void {
    const el = videoElRef.current;
    if (el === null || el.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = el.videoWidth;
    canvas.height = el.videoHeight;
    canvas.getContext('2d')?.drawImage(el, 0, 0);
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    addFrame(recId, { at: Date.now(), dataUrl, bytes: dataUrlByteSize(dataUrl) });
  }
  function toggleRecord(): void {
    if (sessionId === '') return;
    if (recordingId !== null) {
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      // Await the stop so we can tell an EMPTY recording (every captureFrame
      // early-returned because the stream was black/connecting/frozen — videoWidth===0)
      // from a real one. A 0-frame recording reading "Recording saved" is an error state
      // masquerading as success (the saved file is blank); surface the honest result and
      // discard the empty recording so it doesn't litter the list.
      const idToStop = recordingId;
      void stopRecording(idToStop)
        .then((rec) => {
          if (rec !== null && rec.frameCount === 0) {
            void deleteRecording(idToStop).catch(() => {});
            setNotice('Recording was empty — no video was streaming');
          } else {
            setNotice('Recording saved');
          }
          window.setTimeout(() => setNotice(null), 4000);
        })
        // Never let a rejected recording-store write reach the global
        // unhandledrejection handler (it blanks the app to a fatal overlay — the
        // 2026-06-18 black-box class); report a soft note instead.
        .catch(() => {
          setNotice("Couldn't save the recording — check the app's file-access permission.");
          window.setTimeout(() => setNotice(null), 4000);
        });
      activeRecIdRef.current = null;
      return;
    }
    // No video yet (black / connecting / frozen) → starting would capture zero frames.
    // Tell the founder why instead of silently recording nothing (they'd click Record
    // precisely when they want to capture a problem). publisherState/videoWidth both
    // gate the capture, so check the live element directly.
    const el = videoElRef.current;
    if (publisherState !== 'publishing' || el === null || el.videoWidth === 0) {
      setNotice('No video yet — wait for the stream before recording');
      window.setTimeout(() => setNotice(null), 4000);
      return;
    }
    // Orphan-guard: never leave a prior interval running when starting a new one.
    if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
    const recId = startRecording(sessionId, profileName !== '' ? profileName : undefined);
    activeRecIdRef.current = recId;
    captureFrame(recId);
    recordTimerRef.current = window.setInterval(() => captureFrame(recId), 1000);
  }
  // SLICE 3 — export a saved recording as the portable JSON envelope (reuses the
  // #36 store: buildRecordingExport → downloadJson, the proven blob/anchor path).
  function exportRecording(rec: Recording): void {
    const now = new Date();
    // Finding #8 — AWAIT the write + surface a note (mirrors the cookie-export fix,
    // founder #3): downloadJson returns false when the Tauri fs write fails (e.g. the
    // $DOWNLOAD scope isn't granted) and true on a confirmed write. The old fire-and-
    // forget gave NO confirmation on success and silently swallowed a failed write, so
    // Export read as "does nothing / is broken".
    const fn = recordingExportFilename(rec, now);
    void downloadJson(fn, buildRecordingExport(rec, now))
      .then((ok) => {
        setNotice(
          ok
            ? `Exported recording to your Downloads folder (${fn}).`
            : "Couldn't save the export — check the app's file-access permission.",
        );
        window.setTimeout(() => setNotice(null), 4000);
      })
      // Guard the global unhandledrejection fatal-overlay (2026-06-18 black-box class).
      .catch(() => {
        setNotice("Couldn't save the export — check the app's file-access permission.");
        window.setTimeout(() => setNotice(null), 4000);
      });
  }
  // Two-step confirm for the recording delete — it's PERMANENT (no recycle bin) and the ×
  // sits in a dense list where a mis-click silently destroyed a capture; a failure was also
  // swallowed with no feedback (audit 2026-07-08). First click arms (× → "Delete?"), a second
  // click within 4s deletes and surfaces any failure.
  const [confirmingDeleteRecId, setConfirmingDeleteRecId] = useState<string | null>(null);
  const deleteRecTimerRef = useRef<number | null>(null);
  const onDeleteRecording = (id: string): void => {
    if (confirmingDeleteRecId !== id) {
      setConfirmingDeleteRecId(id);
      if (deleteRecTimerRef.current !== null) window.clearTimeout(deleteRecTimerRef.current);
      deleteRecTimerRef.current = window.setTimeout(() => setConfirmingDeleteRecId(null), 4000);
      return;
    }
    if (deleteRecTimerRef.current !== null) window.clearTimeout(deleteRecTimerRef.current);
    setConfirmingDeleteRecId(null);
    void deleteRecording(id).catch(() => {
      setNotice("Couldn't delete the recording.");
      window.setTimeout(() => setNotice(null), 4000);
    });
  };
  // Stop the capture loop if the window unmounts mid-recording.
  useEffect(() => {
    return () => {
      if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
    };
  }, []);
  // SLICE 3 — drive the Recording pane's live elapsed readout. The capture loop
  // re-renders via addFrame each second, but only when a frame is actually
  // grabbed (videoWidth>0). Tick a clock independently while recording so the
  // elapsed time advances even before/while the stream warms up; the interval
  // is armed only while a recording is active and torn down on stop/unmount.
  const [recNow, setRecNow] = useState<number>(() => Date.now());
  useEffect(() => {
    if (recordingId === null) return;
    setRecNow(Date.now());
    const t = window.setInterval(() => setRecNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [recordingId]);
  // Night-arc C cockpit: live room handle (from the panel) drives the
  // previously-dormant LK.6.e latency ping; rendered in the overlay.
  const [room, setRoom] = useState<Room | null>(null);
  // The panel's live connection + publisher state, surfaced via its callbacks. The
  // BrowserBar / address bar / back-forward / reload gate on these (NOT merely room !==
  // null) so a URL typed during "connecting…" — before the box renderer is up — can't
  // silently no-op behind a fake loading bar (edge-errors review). canNavigate below
  // derives from BOTH: the room reports connected AND a video track has arrived.
  const [connState, setConnState] = useState<
    'idle' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error'
  >('idle');
  const [publisherState, setPublisherState] = useState<'waiting' | 'publishing' | 'none'>(
    'waiting',
  );
  // P1a — TERMINAL session-end signal. The box session actually ended (the worker
  // browser closed / the session was destroyed/errored / the orphan sweeper reaped
  // it): the control plane reports status='closed' (or a closed_at/closed_reason).
  // When set, ALL reconnect/resubscribe/rebuild/freeze machinery short-circuits and
  // the panel shows a clear "Session ended" terminal state with a Close action —
  // NOT an endless "reconnecting" against a session that's gone. A TRANSIENT
  // transport drop (session still live per the status poll) leaves this null, so the
  // existing bounded reconnect keeps running. `reason` is the close_reason for honest
  // copy ('idle_timeout', 'orphaned-lifetime', a worker-close, …). Reset on every
  // session swap (a fresh session starts non-terminal). Declared up here (before the
  // freeze-recovery effect that reads it) to avoid a TDZ on the effect's dep array.
  const [sessionEnded, setSessionEnded] = useState<{ reason: string | null } | null>(null);
  // Live mirror of sessionEnded for the data-channel onData callback (its effect closes
  // over a stale value and doesn't re-subscribe per session-end). Finding #3 — a late
  // page_state frame the box pushes as it tears down (or one still buffered in LiveKit)
  // must NOT re-light the loading bar / re-stamp the stalled badge ABOVE the "Session
  // ended" overlay (those render as window chrome around the video panel). The poll
  // already bails on sessionEnded; this lets the data-channel source freeze too.
  const sessionEndedRef = useRef(sessionEnded);
  useEffect(() => {
    sessionEndedRef.current = sessionEnded;
  }, [sessionEnded]);
  const videoElRef = useRef<HTMLVideoElement | null>(null);
  // fps: rolling 1s counter via requestVideoFrameCallback (browser-native;
  // no LiveKit internals). null until the first full window.
  const [fps, setFps] = useState<number | null>(null);
  const fpsCounterRef = useRef({ frames: 0, windowStart: 0 });
  // Guard: React ref callbacks re-fire on every parent re-render (inline
  // identity), and the panel re-renders constantly while streaming — without
  // this, multiple rVFC chains stack on the same element and fps reads
  // multiplied (caught in the night distance-audit).
  const fpsArmedElRef = useRef<HTMLVideoElement | null>(null);
  // #3/#6 — wall-clock timestamp of the LAST frame the <video> ELEMENT actually
  // produced (rVFC fired). This is the freeze detector's source of truth: a
  // legitimately idle-but-live stream (A3's idle frame-pump down-clock, W2952)
  // STILL fires rVFC at the down-clocked rate, so its last-frame time keeps
  // advancing — only a TRUE freeze (the element stops producing frames) lets it
  // go stale. Down-clock-invariant by construction (unlike decodeFps===0, which
  // an idle stream trivially hits). Updated by the same rVFC chain as the fps
  // counter so there's a single per-frame callback.
  const lastVideoFrameAtRef = useRef(0);
  function armFpsCounter(el: HTMLVideoElement): void {
    if (fpsArmedElRef.current === el) return;
    fpsArmedElRef.current = el;
    const tick = (now: number): void => {
      // Every rVFC tick is a real produced frame → the element is live.
      lastVideoFrameAtRef.current = Date.now();
      const c = fpsCounterRef.current;
      if (c.windowStart === 0) c.windowStart = now;
      c.frames += 1;
      if (now - c.windowStart >= 1000) {
        setFps(Math.round((c.frames * 1000) / (now - c.windowStart)));
        c.frames = 0;
        c.windowStart = now;
      }
      // requestVideoFrameCallback is one-shot — re-arm per frame; the
      // chain dies naturally with the element.
      el.requestVideoFrameCallback?.((t) => tick(t));
    };
    el.requestVideoFrameCallback?.((t) => tick(t));
  }
  const [notice, setNotice] = useState<string | null>(null);
  // Non-fatal control-channel health: set when the FIRST input publish fails
  // (the LiveKit data channel is effectively dead, so taps/keys aren't reaching
  // the device). Surfaced as a small badge rather than blocking the view.
  const [controlUnreachable, setControlUnreachable] = useState(false);
  const latency = useLatencyPing({ room, enabled: room !== null });
  // WebRTC transport diagnostics (relay/tcp? loss? freezes?) — founder's
  // "is it slow because we're on TCP?" question. Read-only stats poll.
  const conn = useConnectionStats({ room, enabled: room !== null });
  // Client-side VIDEO-FREEZE detector (#3/#6). The box-reported 'stalled' page_state
  // covers a frozen RENDERER, and the transport badge covers a TCP/relay slow link —
  // but a pure CLIENT decode freeze (decoder stalls / SFU stops delivering frames /
  // severe loss) WITHOUT a box-side stall leaves the last frame frozen with no
  // indicator.
  //
  // Source of truth = the <video> ELEMENT's OWN frame progress, NOT decodeFps. A3's
  // idle frame-pump down-clock (W2952) drives the publish FPS to ~0 on a static/idle
  // page → a decodeFps===0-for-Ns heuristic FALSE-FIRES "Video frozen" on a perfectly
  // healthy idle stream (the reported "reconnecting, happens too often"). But a
  // legitimately idle-but-LIVE stream STILL advances currentTime / fires rVFC at the
  // down-clocked rate, so the element's last-frame time keeps moving — only a TRUE
  // freeze (the element stops producing frames) lets it go stale. We declare frozen
  // only when BOTH the rVFC last-frame time AND el.currentTime have stopped advancing
  // for the window (currentTime is the fallback for a browser without rVFC). This is
  // down-clock-invariant by construction. Connected-only (a transport drop is the
  // panel's overlay, not ours).
  const [videoFrozen, setVideoFrozen] = useState(false);
  const sawFramesRef = useRef(false);
  const freezeSinceRef = useRef<number | null>(null);
  // currentTime-advance fallback: the last sampled currentTime + the wall-clock when
  // it last CHANGED. A live (even down-clocked) stream keeps advancing currentTime;
  // a true freeze pins it.
  const lastSampledCurrentTimeRef = useRef<number | null>(null);
  const lastCurrentTimeAdvanceAtRef = useRef(0);
  useEffect(() => {
    // Suppress the freeze badge when the LiveKit connection itself isn't connected: a
    // transport drop (disconnected/reconnecting) naturally stops frame progress, and the
    // panel's own "The live stream disconnected" overlay + Reconnect is the single
    // source of truth there. Without this the parent's "Video frozen" pill contradicted
    // the panel's overlay. Only a freeze WHILE connected is a genuine client decode stall.
    if (room === null || connState !== 'connected') {
      sawFramesRef.current = false;
      freezeSinceRef.current = null;
      lastSampledCurrentTimeRef.current = null;
      lastCurrentTimeAdvanceAtRef.current = 0;
      setVideoFrozen(false);
      return;
    }
    const FREEZE_AFTER_MS = 4000;
    const tick = (): void => {
      // The session has terminally ended (worker reaped / closed) — the "Session ended"
      // overlay is the truth. LiveKit's signal socket can linger 'connected' for a few
      // seconds after the last frame, and this effect's dep array is [room, connState]
      // (no sessionEnded), so without this per-tick ref check the detector would fire
      // "Video frozen" OVER the ended overlay in that window (the resubscribe-recovery
      // driver already has this short-circuit; the detector lacked it).
      if (sessionEndedRef.current !== null) {
        setVideoFrozen(false);
        return;
      }
      const now = Date.now();
      const el = videoElRef.current;
      // currentTime advancement (rVFC-independent fallback). Treat a change of >1ms as
      // progress so float jitter doesn't read as advance/freeze either way.
      const ct = el !== null && Number.isFinite(el.currentTime) ? el.currentTime : null;
      if (ct !== null) {
        const prev = lastSampledCurrentTimeRef.current;
        if (prev === null) {
          // FIRST sample: SEED the baseline only — do NOT stamp it as an advance.
          // Before any real frame the <video>'s currentTime is pinned at 0; if the
          // null-baseline counted as progress it stamped lastCurrentTimeAdvanceAtRef,
          // which armed sawFramesRef (lastProgressAt>0) even though nothing was ever
          // decoded — so a session whose worker never publishes (proxy down / long
          // cold start) false-fired 'Video frozen' 4s later, which drove the
          // resubscribe→Room-rebuild recovery loop (~every 16s) and SUPPRESSED the
          // honest 'no live video' launch-failed overlay (its 30s no-publisher timer
          // never elapsed because the rebuild kept restarting it). Progress is now
          // recorded only on an ACTUAL currentTime change. (Fable GUI re-audit
          // 2026-07-02.)
          lastSampledCurrentTimeRef.current = ct;
        } else if (Math.abs(ct - prev) > 0.001) {
          lastSampledCurrentTimeRef.current = ct;
          lastCurrentTimeAdvanceAtRef.current = now;
        }
      }
      // The most-recent moment the element produced a frame, by EITHER signal: rVFC
      // fired (last-frame time) OR currentTime advanced. Either advancing = the element
      // is live (incl. an idle down-clocked stream — that's the whole point).
      const lastProgressAt = Math.max(
        lastVideoFrameAtRef.current,
        lastCurrentTimeAdvanceAtRef.current,
      );
      // Only arm after the element has genuinely produced a frame (avoids the
      // pre-first-frame false positive). lastProgressAt === 0 → nothing ever produced.
      if (lastProgressAt > 0) sawFramesRef.current = true;
      if (!sawFramesRef.current) return;
      // Frozen iff no frame progressed for the full window. The freeze "since" is the
      // last progress moment itself, so detection takes exactly FREEZE_AFTER_MS after
      // frames stop (not 2× the window). Any fresh frame clears it immediately.
      freezeSinceRef.current = lastProgressAt;
      const frozen = now - lastProgressAt >= FREEZE_AFTER_MS;
      setVideoFrozen(frozen);
      // Finding #12 — null the fps reading while frozen. fps is only updated inside the
      // rVFC chain, which STOPS firing on a true freeze, so it would otherwise hold its
      // last live value (e.g. 30) and contradict the "Video frozen" badge in the status
      // strip, the Diagnostics Render tile, AND Copy-diagnostics (all read this state).
      // The rVFC chain repopulates it the moment frames resume.
      if (frozen) setFps(null);
    };
    tick();
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
  }, [room, connState]);
  // #5/#9 — RESUBSCRIBE-TO-RECOVER on a sustained TRUE freeze. The freeze detector
  // above only SHOWS a badge; a genuine client decode stall (the SFU/encoder stopped
  // sending frames, severe loss, a wedged decoder) while the transport itself stays
  // 'connected' won't self-heal from a passive badge. When videoFrozen stays true for
  // a sustained window we actively pull the recovery lever the GUI has: bump
  // `recoverAction` so the panel toggles the remote video subscription off→on (the
  // resubscribe makes the browser send a PLI → the SFU/encoder pushes a fresh
  // keyframe). If frame-progress doesn't resume within a few seconds we escalate ONCE
  // to a full Room rebuild (mode:'rebuild' → the panel bumps its retryNonce). The
  // moment frames resume (videoFrozen flips false) the whole machine resets, so the
  // next freeze starts a fresh attempt. recoverAction.nonce is monotonic so the panel
  // reacts to each distinct trigger exactly once.
  const SUSTAINED_FREEZE_MS = 8_000;
  const RESUBSCRIBE_GRACE_MS = 4_000;
  const [recoverAction, setRecoverAction] = useState<{
    nonce: number;
    mode: 'resubscribe' | 'rebuild';
  }>({ nonce: 0, mode: 'resubscribe' });
  // `recovering` is true ONLY while a recovery is actually in flight (between firing a
  // lever and frames resuming / the rebuild escalation). It drives the badge copy so
  // we never claim "recovering" when we're merely showing a passive freeze badge.
  const [recovering, setRecovering] = useState(false);
  // Recovery phase, held in a ref so the driver effect doesn't re-run on each phase
  // change: 'idle' (no freeze) → 'resubscribed' (lever 1 fired, awaiting recovery) →
  // 'rebuilt' (lever 2 fired, terminal until frames resume or the freeze clears).
  const recoverPhaseRef = useRef<'idle' | 'resubscribed' | 'rebuilt'>('idle');
  useEffect(() => {
    // P1a — the session terminally ended (worker browser closed / destroyed /
    // reaped): NEVER run the resubscribe→rebuild freeze recovery. The frozen "last
    // frame" is the ended session, and a rebuild would reconnect a fresh Room
    // against a session that's gone (the "reconnecting forever" bug). Short-circuit
    // to idle and let the panel show the terminal "Session ended" overlay.
    if (sessionEnded !== null) {
      recoverPhaseRef.current = 'idle';
      setRecovering(false);
      return;
    }
    // Frames are flowing (or we're not connected): reset the machine so a future
    // freeze gets a clean two-stage attempt. The connected-only gate matches the
    // detector — a transport drop is the panel's overlay + its own auto-reconnect.
    if (!videoFrozen || connState !== 'connected') {
      recoverPhaseRef.current = 'idle';
      setRecovering(false);
      return;
    }
    // videoFrozen has been true since (now − FREEZE_AFTER_MS) when this effect ran.
    // Stage 1 fires after the freeze has SUSTAINED a further SUSTAINED_FREEZE_MS;
    // stage 2 fires RESUBSCRIBE_GRACE_MS after stage 1 if it's still frozen. Both
    // are single-shot per freeze via recoverPhaseRef.
    let stage2Handle: number | null = null;
    const stage1Handle = window.setTimeout(() => {
      if (recoverPhaseRef.current !== 'idle') return;
      recoverPhaseRef.current = 'resubscribed';
      setRecovering(true);
      setRecoverAction((a) => ({ nonce: a.nonce + 1, mode: 'resubscribe' }));
      // Stage 2 — escalate ONCE to a Room rebuild if the resubscribe didn't restore
      // frame progress (this effect is still mounted, i.e. still frozen + connected).
      stage2Handle = window.setTimeout(() => {
        if (recoverPhaseRef.current !== 'resubscribed') return;
        recoverPhaseRef.current = 'rebuilt';
        setRecoverAction((a) => ({ nonce: a.nonce + 1, mode: 'rebuild' }));
      }, RESUBSCRIBE_GRACE_MS);
    }, SUSTAINED_FREEZE_MS);
    return () => {
      window.clearTimeout(stage1Handle);
      if (stage2Handle !== null) window.clearTimeout(stage2Handle);
    };
  }, [videoFrozen, connState, sessionEnded]);
  // #48 item 2 — "Copy diagnostics": a paste-ready snapshot of the session-info
  // overlay (the founder keeps reporting streaming/latency issues and needs the
  // exact figures for a bug report). formatSessionDiagnostics is pure + tested;
  // clipboard write mirrors the address-bar copyUrl idiom (silent on failure).
  const [diagCopied, setDiagCopied] = useState(false);
  const [diagCopyFailed, setDiagCopyFailed] = useState(false);
  const copyDiagnostics = (): void => {
    const text = formatSessionDiagnostics({
      sessionId,
      profileName,
      deviceName,
      link: info ? wsHost(info.ws_url) : null,
      egress: proxyLabel,
      fps,
      latencyMs: latency.rttMs,
      linkRttMs: conn.rttMs,
      transport: conn.transport,
      relayed: conn.relayed,
      decodeFps: conn.decodeFps,
      packetLossPct: conn.packetLossPct,
      jitterMs: conn.jitterMs,
      freezeCount: conn.freezeCount,
      build: typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev',
    });
    const flagFailed = (): void => {
      setDiagCopyFailed(true);
      window.setTimeout(() => setDiagCopyFailed(false), 1600);
    };
    const write = navigator.clipboard?.writeText(text);
    if (write === undefined) {
      flagFailed();
      return;
    }
    void write.then(() => {
      setDiagCopyFailed(false);
      setDiagCopied(true);
      window.setTimeout(() => setDiagCopied(false), 1200);
    }, flagFailed);
  };
  const [landscape, setLandscape] = useState(false);
  // On-screen iOS keyboard (founder 2026-06-25 "behave exactly like a real
  // iPhone"). v1 is MANUAL — toggled from the toolbar; auto-show-on-focus + the
  // keyboard viewport-resize are deferred to A3's box-side signals (W2992). The
  // keyboard is GUI chrome mounted BELOW the video, so it never moves the
  // <video> on-screen rect the tap/scroll coord mapping reads. Forwarded only in
  // manual/pair mode (in AI mode the agent drives — local input would fight it).
  const [keyboardVisible, setKeyboardVisible] = useState(false);
  // Live mirror of keyboardVisible for the window-sizing closures (fitWindow /
  // resetToActualSize / refitForDrawer / the onResized aspect-lock), which close
  // over the value and must read the CURRENT one without re-subscribing. The
  // chrome height grows by KEYBOARD_H while the keyboard is shown, so the window
  // gets taller for it (video keeps its full aspect, keyboard docks below) rather
  // than the flex-1 screen-host losing the keyboard's height to a bottom band (#75).
  const keyboardVisibleRef = useRef(keyboardVisible);
  keyboardVisibleRef.current = keyboardVisible;
  // Pin = always-on-top (the floating-iPhone default). Unpinned the window
  // behaves like a normal sibling window (Cmd+` cycling, Mission Control,
  // doesn't hover over other apps) — the strongest separate-window identity
  // macOS allows inside one app (a per-window Dock icon needs a helper app
  // bundle — scoped as a post-launch item).
  // Matches the window's alwaysOnTop:false at create (a normal, switchable
  // window by default; the pin toggle floats it on top on demand).
  const [pinned, setPinned] = useState(false);
  // Cockpit info overlay (demo-concepts arc): session facts at a glance.
  // Expandable control panel — collapsed by default so the window is phone-only
  // (founder 2026-06-17); the chevron reveals the labelled control rows. EXCEPT
  // until the user has navigated at least once: A3's tap-path investigation
  // (wpiyo8v6x, 2026-06-21) found the founder kept tapping the RENDERED Safari
  // pill (non-interactive fork chrome) because the GUI's own Address bar — which
  // lives in this panel — wasn't discoverable. So we open the panel on launch
  // (its first item is the Address bar) until a successful navigate sets the
  // flag, after which it returns to collapsed-by-default. Self-resolving: the
  // controls advertise themselves exactly until they're used. The panel is an
  // absolute overlay (no effect on the fixed TOOLBAR_H window-sizing math) and
  // auto-dismisses on the first tap, so it never lingers over the device.
  // Activity-bar drawer (founder 2026-06-24) — a slim icon RAIL is ALWAYS docked
  // beside the phone; `activePane` is which section's PANE is expanded to the
  // right of the rail (null = collapsed, rail-only). Persisted as a PREFERENCE in
  // localStorage (NOT cleared by the in-place session-reset, unlike the per-session
  // UI state) so the operator's last-used section survives a relaunch — the stored
  // value is the pane id, or empty/absent for collapsed. Lazy init reads it in a
  // Founder 2026-06-24: on a fresh open NOTHING is expanded — just the rail icons;
  // a pane opens ONLY when the operator clicks its icon (no auto-open, no last-used
  // restore). Hover tooltips on the rail (title=) cover discoverability that the old
  // auto-open-Controls used to. selectPane still persists the choice for the session,
  // but the window always starts collapsed (rail-only).
  const [activePane, setActivePane] = useState<SimDrawerPane | null>(null);
  // Extra window width contributed by the docked drawer. Kept current every render
  // (like landscapeRef) so the window-sizing closures (fitWindow / resetToActualSize
  // / the onResized aspect-lock / refitForDrawer) ALWAYS read the live value without
  // re-subscribing. Width = phoneW + drawerExtra; the rail is ALWAYS present (RAIL_W),
  // and an open pane adds PANE_W. Phone dims are derived from (windowWidth − drawerExtra).
  const paneOpen = activePane !== null;
  const drawerExtraRef = useRef(0);
  drawerExtraRef.current = RAIL_W + (paneOpen ? PANE_W : 0);

  // A rail-icon click TOGGLES its pane: same id → collapse (null); a different id →
  // open that pane. Persists the id (or '' for collapsed) so the choice survives a
  // relaunch.
  const selectPane = (pane: SimDrawerPane): void => {
    setActivePane((prev) => {
      const next = prev === pane ? null : pane;
      try {
        localStorage.setItem(SIM_DRAWER_PANE_KEY, next ?? '');
      } catch {
        /* storage disabled — the active pane just won't persist across reopens */
      }
      return next;
    });
  };
  // Collapse the drawer back to the rail (the status-strip ✕ + Escape).
  const collapseDrawer = (): void => {
    setActivePane(null);
    try {
      localStorage.setItem(SIM_DRAWER_PANE_KEY, '');
    } catch {
      /* storage disabled — nothing to persist */
    }
  };
  // Force-open a specific pane (the browser-bar download indicator → Downloads).
  // Unlike selectPane (a rail TOGGLE), this always OPENS the target — an indicator
  // click should reveal the section, never collapse it. Persists like selectPane.
  const openPane = (pane: SimDrawerPane): void => {
    setActivePane(pane);
    try {
      localStorage.setItem(SIM_DRAWER_PANE_KEY, pane);
    } catch {
      /* storage disabled — the active pane just won't persist across reopens */
    }
  };
  // Per-pane "is this section the active pane" booleans — the data/utility polls
  // (cookies / downloads) gate on these so they only fire while their pane is
  // actually shown. Depending on the BOOLEAN (not the whole activePane string)
  // keeps the effect from re-arming when an UNRELATED pane switch happens.
  const cookiesPaneActive = activePane === 'cookies';
  const downloadsPaneActive = activePane === 'downloads';

  // Browser mode (founder 2026-06-21, greenlit) — a native GUI URL bar in the
  // toolbar instead of relying on the rendered iOS-Safari chrome (which the page
  // tap-path can't reach). When on, the toolbar center is an editable address
  // field (Enter → navigate) rather than the device identity; fingerprint-neutral
  // (operator-view only). DEFAULT ON (founder 2026-06-21) — opt-out via the panel
  // toggle (persists '0'). Phase 1; tabs + A3 content-only video follow. See
  // docs/internal/gui-browser-chrome-mode-plan-2026-06-21.md.
  const [browserMode, setBrowserMode] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ds-sim-browser-mode') !== '0';
    } catch {
      return true;
    }
  });
  // Device aspect (videoW / videoH) from the live stream — drives window sizing so
  // the frame fits ANY archetype. Seeded to iphone17 until the stream reports.
  const deviceAspectRef = useRef(402 / 874);
  // P1b — the LIVE content aspect passed to AgentSessionPanel so its <video> box ==
  // the screen-host == the video (no double object-contain → no bottom-black band).
  // The window-sizing math sizes the screen-host to EXACTLY this aspect (contentW ×
  // contentW/aspect); giving the panel the SAME aspect makes the video fill it
  // edge-to-edge. STATE (not just deviceAspectRef) so the panel re-renders with the
  // real aspect when the first content-only frame reports. Seeded to the launch
  // archetype's FULL-DEVICE aspect (402×874) until the stream reports the true
  // CONTENT aspect (e.g. 402×714) — the old hardcoded 402:874 panel box was the bug:
  // the content-only fork publishes 402×714, so a 402:874 box letterboxed the wider
  // content top+bottom inside it (founder's persistent bottom-black gap). Held flat
  // (not landscape-inverted): the panel's own box just needs to match whatever the
  // <video>'s real frame aspect is, which IS videoW/videoH in either orientation.
  const [contentAspect, setContentAspect] = useState(402 / 874);
  // The live per-archetype captured-frame LOGICAL CSS-px dims (videoW/DPR ×
  // videoH/DPR) the Mac touch injector addresses (A3 84de32ad4d content-only fork).
  // STATE (not just a ref) so it flows into AgentSessionPanel → useInputCapture and
  // re-keys the capture effect when the per-archetype frame arrives. Seeded to the
  // launch archetype's screen (402×874) until the first full-res frame reports; set
  // ONCE from the first-reported (full-res) dims so the SFU downscale can't shrink
  // the touch space (A3 W2811 invariance). A mirror ref feeds the Cmd+0 reset.
  const [inputLogical, setInputLogical] = useState<{ width: number; height: number }>({
    width: 402,
    height: 874,
  });
  const deviceLogicalRef = useRef(inputLogical);
  deviceLogicalRef.current = inputLogical;
  // A3 W3005 — once the box's page_state delivers the FIXED per-archetype logical
  // content dims, they OWN the tap/scroll coordinate space; the track-derived dims in
  // handleVideoDimensions become a pre-first-page_state fallback only (the encoded
  // track downscales under bandwidth → can't be trusted for tap coords). Latched true
  // on the first frame carrying dims; reset per session alongside sizedToStreamRef.
  const hasPageStateDimsRef = useRef(false);
  // Landscape ref kept current every render so the window-sizing closures (fitWindow
  // + the onResized listener) use the ROTATED aspect — else rotate snaps back to a
  // portrait sliver (audit B2/B3). Declared here (before fitWindow) so those
  // closures can read it.
  const landscapeRef = useRef(false);
  landscapeRef.current = landscape;
  // The window-sizing aspect: inverted when rotated to landscape.
  const sizingAspect = (): number =>
    landscapeRef.current ? 1 / deviceAspectRef.current : deviceAspectRef.current;
  // #75b — on a SHORT (laptop) work area, docking the keyboard BELOW the video grows
  // the window past `avail - 24`, which trips the screen-clamp in fitWindow /
  // resetToActualSize / onResized: the height is pinned to avail-24 and the width is
  // re-derived from (height - chrome) * aspect. Because `chrome` then includes
  // KEYBOARD_H, the video area = realH - chrome shrinks dramatically and the window
  // NARROWS with it — the keyboard appears to crop the browser (founder's exact
  // symptom) instead of merely growing the window. So when the keyboard-docked window
  // would NOT fit, OVERLAY the keyboard over the bottom of the video instead of
  // docking it below — exactly iPhone-faithful (the keyboard occludes the page) and it
  // keeps KEYBOARD_H OUT of `chrome` at every sizing site so the video keeps its full
  // aspect + width. pointerToViewport reads video.getBoundingClientRect (which the
  // overlay does not change), so taps stay aligned; taps under the keyboard correctly
  // hit the keyboard. Decided off the device's NATURAL logical size (the actual-size
  // target) so the render + the sizing closures agree deterministically and the
  // decision does not oscillate with the operator's drag width.
  // iPhone-faithful: the on-screen keyboard ALWAYS overlays the bottom of the video
  // (position:absolute) and NEVER resizes the phone window. We previously docked the
  // keyboard below the video and grew/clamped the window when the screen had headroom,
  // but that made the phone visibly resize on every toggle (founder: "toggling the
  // keyboard resizes the phone smaller instead of being on the screen"). A real iPhone
  // slides the keyboard up OVER the page; the window/device never changes size. So
  // keyboardOverlay == keyboardVisible, and KEYBOARD_H is never folded into the window
  // chrome (keyboardChromeOn stays false). pointerToViewport reads
  // video.getBoundingClientRect (unchanged by an overlay) so taps stay aligned; a tap
  // under the keyboard correctly hits the keyboard.
  const keyboardOverlay = keyboardVisible;
  const keyboardOverlayRef = useRef(keyboardOverlay);
  keyboardOverlayRef.current = keyboardOverlay;
  // The keyboard contributes KEYBOARD_H to `chrome` ONLY when it docks BELOW the video
  // (not in overlay mode). One helper so every sizing site agrees — a site that still
  // subtracted KEYBOARD_H after an overlay clamp would re-narrow the window.
  const keyboardChromeOn = (): boolean => keyboardVisibleRef.current && !keyboardOverlayRef.current;
  // Size the window so the device video FILLS the frame width AND the whole window
  // FITS the screen height. The iPhone's tall aspect makes a width-driven height
  // overflow a laptop screen → the OS clamps the height → the device letterboxes
  // with side gaps ("the iphone view is lower width than the window", founder
  // 2026-06-21). Fix: derive height from the width; if it would overflow the screen
  // work area, clamp to the screen and derive the WIDTH from the aspect instead, so
  // the device always fills the frame edge-to-edge.
  const fitWindow = (browserModeOn: boolean): void => {
    void withCurrentWindow(async (win) => {
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const factor = await win.scaleFactor();
      const size = await win.innerSize();
      const curWidth = Math.round(size.width / factor);
      const aspect = sizingAspect(); // videoW / videoH (inverted in landscape)
      // Option B — the open drawer occupies a fixed slice of the window width; the
      // PHONE is everything left of it. Derive the device dims from (window − drawer)
      // and add the drawer back, so the drawer never letterboxes the device.
      const drawerExtra = drawerExtraRef.current;
      const phoneW = curWidth - drawerExtra;
      // The on-screen keyboard adds KEYBOARD_H to the chrome ONLY when it docks
      // BELOW the video; on a short laptop work area it overlays the video instead
      // (#75b), and must NOT be folded into chrome there or the screen-clamp would
      // carve KEYBOARD_H out of the video and narrow the window ("keyboard crops the
      // browser"). keyboardChromeOn() is the single source of truth across all five
      // sizing sites.
      const keyboardOn = keyboardChromeOn();
      const chrome = simulatorChromeHeight(browserModeOn, keyboardOn);
      // The device screen-area must match the video aspect or the video
      // object-contains with side gaps. Height for a phone width = chrome + (w-bezel)/aspect.
      // First pass: ask for that height, pre-capped to the screen work area (a hint).
      const avail = typeof window !== 'undefined' ? (window.screen?.availHeight ?? 0) : 0;
      let height = simulatorWindowHeight(phoneW, aspect, browserModeOn, keyboardOn);
      let width = curWidth; // = phoneW + drawerExtra, preserved
      if (avail > 0 && height > avail - 24) {
        height = avail - 24;
        width = Math.round((height - chrome) * aspect + BEZEL_PAD) + drawerExtra;
      }
      await win.setSize(new LogicalSize(width, Math.round(height)));
      // GUARANTEE — independent of any screen-size guess: macOS clamps a window to
      // the work area, which would re-letterbox the device with side gaps. Read back
      // the ACTUAL size; if the height got clamped, derive the WIDTH from that real
      // height (plus the drawer) so the device fills the frame edge-to-edge on ANY screen.
      await new Promise((resolve) => setTimeout(resolve, 90));
      const after = await win.innerSize();
      const realH = Math.round(after.height / factor);
      const realW = Math.round(after.width / factor);
      const needW = Math.round((realH - chrome) * aspect + BEZEL_PAD) + drawerExtra;
      if (needW > 0 && Math.abs(realW - needW) > 2) {
        await win.setSize(new LogicalSize(needW, realH));
      }
    });
  };
  // Snap the device content back to the iPhone CSS-logical width (Cmd+0, the
  // standard "actual size"). fitWindow PRESERVES the current width, so once the
  // window has been dragged large it stays large ("the webkit browser is suddenly
  // larger than our output", founder 2026-06-22) — this is the one-gesture way back
  // to true iPhone-logical size. Mirrors fitWindow's screen-clamp + read-back.
  const resetToActualSize = (): void => {
    void withCurrentWindow(async (win) => {
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const factor = await win.scaleFactor();
      const aspect = sizingAspect();
      // Keyboard docks below the video → grow the window by KEYBOARD_H via the chrome
      // term so the video keeps its full aspect, no bottom band (#75). On a short work
      // area it overlays instead and is excluded from chrome (#75b) via keyboardChromeOn.
      const keyboardOn = keyboardChromeOn();
      const chrome = simulatorChromeHeight(browserMode, keyboardOn);
      // Target device-content width = the per-archetype iPhone CSS-logical width (its
      // long edge when rotated to landscape), then the window adds the bezel padding +
      // (if open) the right drawer's fixed width. Live per-archetype width from the
      // dispatched stream (deviceLogicalRef, seeded to the launch 402 until the frame
      // reports) so Cmd+0 resets a 390/430 device to ITS true width, not 402.
      const drawerExtra = drawerExtraRef.current;
      const logicalW = deviceLogicalRef.current.width || DEVICE_LOGICAL_WIDTH;
      const targetContentW = landscapeRef.current
        ? Math.round(logicalW / deviceAspectRef.current)
        : logicalW;
      const phoneW = targetContentW + BEZEL_PAD;
      let width = phoneW + drawerExtra;
      let height = simulatorWindowHeight(phoneW, aspect, browserMode, keyboardOn);
      // An iPhone is taller than many laptop work areas; if the ideal height would
      // overflow, cap it and derive the width from the aspect so the device still
      // fills the frame edge-to-edge (same guarantee fitWindow makes).
      const avail = typeof window !== 'undefined' ? (window.screen?.availHeight ?? 0) : 0;
      if (avail > 0 && height > avail - 24) {
        height = avail - 24;
        width = Math.round((height - chrome) * aspect + BEZEL_PAD) + drawerExtra;
      }
      await win.setSize(new LogicalSize(width, Math.round(height)));
      await new Promise((resolve) => setTimeout(resolve, 90));
      const after = await win.innerSize();
      const realH = Math.round(after.height / factor);
      const realW = Math.round(after.width / factor);
      const needW = Math.round((realH - chrome) * aspect + BEZEL_PAD) + drawerExtra;
      if (needW > 0 && Math.abs(realW - needW) > 2) {
        await win.setSize(new LogicalSize(needW, realH));
      }
    });
  };
  const toggleBrowserMode = (): void => {
    const next = !browserMode;
    setBrowserMode(next);
    try {
      localStorage.setItem('ds-sim-browser-mode', next ? '1' : '0');
    } catch {
      /* storage disabled — mode just won't persist */
    }
    // Re-fit the whole window (not a naive ±bar-height bump, which could overflow
    // the screen and re-introduce the side-gap letterbox).
    fitWindow(next);
  };
  // Show/hide the on-screen iOS keyboard. When it docks BELOW the video, showing it
  // GROWS the window by KEYBOARD_H (and hiding it shrinks back) so the video keeps its
  // full content aspect with the keyboard below it (#75). On a short laptop work area
  // it OVERLAYS the bottom of the video instead (#75b), in which case KEYBOARD_H is NOT
  // added to chrome (the video keeps its full size). BOTH refs are set synchronously
  // BEFORE fitWindow so the sizing closure (which reads the refs, not the not-yet-
  // committed state) sees the new values this tick; otherwise the first fitWindow after
  // a toggle reads a stale overlay flag and re-introduces the shrink for a frame.
  const toggleKeyboard = (): void => {
    const next = !keyboardVisibleRef.current;
    keyboardVisibleRef.current = next;
    keyboardOverlayRef.current = next; // always overlay — never resize the window
    setKeyboardVisible(next);
    fitWindow(browserMode);
  };
  // Widen/narrow the window by PANE_W when a pane opens/closes (the rail's RAIL_W
  // is always present). HEIGHT-driven (keep the height, re-derive the phone width,
  // add the drawer) — distinct from the width-preserving fitWindow, which would
  // mis-read the phone width on toggle (curWidth still reflects the OLD drawer
  // state). The onResized aspect-lock uses the same needW formula, so it reads this
  // as on-aspect → no fight.
  const refitForDrawer = (): void => {
    void withCurrentWindow(async (win) => {
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const factor = await win.scaleFactor();
      const size = await win.innerSize();
      const h = Math.round(size.height / factor);
      const aspect = sizingAspect();
      const chrome = simulatorChromeHeight(browserMode, keyboardChromeOn());
      const width = Math.round((h - chrome) * aspect + BEZEL_PAD) + drawerExtraRef.current;
      if (width > 0) await win.setSize(new LogicalSize(width, h));
    });
  };

  // Belt-and-suspenders: fit the window when the session first renders AND whenever
  // browser mode toggles — NOT only when the video reports its dimensions. The
  // device video object-contains, so if handleVideoDimensions never fires (callback
  // timing) the window keeps its initial 330×718 and the browser bar's extra height
  // letterboxes the device with side gaps (founder: "window larger width than the
  // iphone, because of the url"). fitWindow uses the seeded aspect here, refined by
  // the real stream dimensions later. Runs after paint so innerSize is settled.
  const didInitialFitRef = useRef(false);
  useEffect(() => {
    if (info === null) return;
    const isInitial = !didInitialFitRef.current;
    didInitialFitRef.current = true;
    const t = window.setTimeout(() => {
      // FRESH open: size HEIGHT-driven to the iPhone-natural width + the always-docked
      // rail (resetToActualSize), so the rail is never SUBTRACTED out of the default
      // 330-wide window into a tiny phone (founder 2026-06-24 "started off really small";
      // the regression from the rail-always rework — fitWindow does phoneW = curWidth −
      // drawerExtra, which on the initial default width shrinks the phone). Subsequent
      // fires (browser-mode toggle / dims refine) PRESERVE the operator's width via fitWindow.
      if (isInitial) resetToActualSize();
      else fitWindow(browserMode);
    }, 0);
    return () => window.clearTimeout(t);
  }, [browserMode, info]);

  // Cmd+0 / Ctrl+0 — the standard "actual size" gesture snaps the sim back to true
  // iPhone-logical size (founder 2026-06-22: window dragged larger than the output).
  useEffect(() => {
    if (info === null) return;
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && (e.key === '0' || e.code === 'Digit0')) {
        e.preventDefault();
        resetToActualSize();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [browserMode, info]);

  // Escape collapses the open pane back to the always-docked rail (the drawer is a
  // docked side panel, NOT an overlay — so an outside-pointer-down must NOT close
  // it, or every tap on the phone would collapse it). Keyboard-only dismiss; only
  // armed while a pane is open.
  useEffect(() => {
    if (!paneOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') collapseDrawer();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [paneOpen]);

  // Widen/narrow the window when a pane opens/closes (the rail width is constant,
  // so only the pane toggle changes the drawer width; drawerExtraRef is already
  // updated render-time before this effect fires). Runs after paint so the aside's
  // layout width is applied first.
  const didInitialDrawerRef = useRef(false);
  useEffect(() => {
    if (info === null) return;
    // SKIP the initial mount: the initial-fit effect (resetToActualSize) already owns the
    // first sizing AND already incorporates the always-docked rail's width. Running
    // refitForDrawer on mount too RACES it — refitForDrawer is height-driven off the
    // create-time 718h and lands a tiny ~337px window LAST (during resetToActualSize's
    // 90ms read-back sleep), clobbering it → the founder's "started off really small"
    // regression returns. Only refit on a REAL later pane open/close.
    if (!didInitialDrawerRef.current) {
      didInitialDrawerRef.current = true;
      return;
    }
    const t = window.setTimeout(() => refitForDrawer(), 0);
    return () => window.clearTimeout(t);
  }, [paneOpen, info]);

  // Aspect-lock manual resizing (founder 2026-06-21 "if i double click it fully
  // maximizes, looks strange"): the device video is aspect-locked, so any resize
  // to an off-aspect size letterboxes the phone. Disable the macOS zoom and, after
  // a resize settles, snap the WIDTH to match the (user-chosen) height + aspect so
  // the phone always fills the frame — resizing scales the phone instead of adding
  // gaps. Loop-safe: only corrects when off-aspect by >4px (our own setSize then
  // re-fires onResized but reads as already-on-aspect → no-op). Tauri-only.
  useEffect(() => {
    if (info === null || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window))
      return;
    let unlisten = (): void => {};
    let disposed = false;
    let timer = 0;
    void (async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
        const { LogicalSize } = await import('@tauri-apps/api/dpi');
        const win = getCurrentWebviewWindow();
        await win.setMaximizable(false).catch(() => undefined);
        const stop = await win.onResized(() => {
          window.clearTimeout(timer);
          timer = window.setTimeout(() => {
            void (async () => {
              try {
                const factor = await win.scaleFactor();
                const size = await win.innerSize();
                const h = Math.round(size.height / factor);
                const w = Math.round(size.width / factor);
                const aspect = sizingAspect();
                const chrome = simulatorChromeHeight(browserMode, keyboardChromeOn());
                // Window width = phone width (aspect-locked to the height) + the open
                // drawer's fixed width, so a manual resize scales the PHONE and never
                // eats the drawer. The keyboard (when shown) is folded into `chrome`
                // so the aspect-lock derives the phone width from the video-only height.
                const needW =
                  Math.round((h - chrome) * aspect + BEZEL_PAD) + drawerExtraRef.current;
                if (needW > 0 && Math.abs(w - needW) > 4) {
                  await win.setSize(new LogicalSize(needW, h));
                }
              } catch {
                /* window API unavailable (non-Tauri / mock) — ignore */
              }
            })();
          }, 110);
        });
        if (disposed) stop();
        else unlisten = stop;
      } catch {
        /* getCurrentWebviewWindow / onResized unavailable (non-Tauri / mock) — ignore */
      }
    })();
    return () => {
      disposed = true;
      window.clearTimeout(timer);
      unlisten();
    };
  }, [browserMode, info]);

  // DERIVED address-bar view of the ACTIVE tab (live-state accuracy refactor,
  // doc-150 item 4). liveUrl/liveTitle are NOT the source of truth and are NEVER
  // written back into tab storage — they mirror the active tab so the BrowserBar +
  // window title can read a plain string. The SINGLE writer of a tab's stored
  // url/title is a box-sourced page_state frame (data channel OR the ~2s poll),
  // routed by tabId when present, else to the active tab. onNavigate / onActivateTab
  // seed them optimistically for instant feedback; a useEffect re-derives them from
  // the active tab whenever the tab record changes (so a box update reflows here).
  const [liveUrl, setLiveUrl] = useState('');
  // Title half of the derived active-tab view (feeds the tab label `title || url`
  // AND the window title). Separate from liveUrl so a title-only frame still
  // refreshes the bar. Empty until the active tab has a title.
  const [liveTitle, setLiveTitle] = useState('');
  const [pageLoading, setPageLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  // 'stalled' (A3 W2845): the device renderer froze (hung JS / compositor
  // deadlock) — the LiveKit stream still reports `live` (the pump repeats the
  // last frame), so the GUI can't detect it from the track. The harness watchdog
  // reports it via pageState{state:'stalled'}; we surface a "reconnecting —
  // page unresponsive" badge over the (still-visible) last frame, cleared when
  // the box reports any non-stalled state again.
  const [pageStalled, setPageStalled] = useState(false);
  // #4 — TTL the latched 'stalled' badge. The server-side page-state store has NO
  // TTL: once the box reports 'stalled', every page-state POLL re-reads that same
  // record and re-applies `pageStalled=true`, so a ONE-TIME stall (a brief hang the
  // renderer recovered from without emitting a fresh non-stalled frame) would keep
  // the badge lit FOREVER. We stamp the wall-clock of the most-recent 'stalled'
  // frame and auto-clear the badge if none has arrived within STALLED_BADGE_TTL_MS.
  // A genuinely still-stalled page keeps re-reporting 'stalled' (data channel +
  // poll), refreshing the stamp, so the badge stays lit for a real ongoing freeze;
  // only a stale latch self-clears. applyStalledState centralises both paths so the
  // stamp + state stay consistent (data channel ~3043, poll ~3127).
  const STALLED_BADGE_TTL_MS = 12_000;
  const lastStalledAtRef = useRef(0);
  // Wall-clock of the most-recent DATA-CHANNEL page-state frame. The data channel is
  // the AUTHORITATIVE live source (the box pushes it the instant the renderer state
  // changes); the ~2s control-plane poll reads a store with NO TTL, so right after the
  // box recovers (data channel pushes 'loaded' → badge cleared) a poll can still read
  // the STALE 'stalled' record and re-raise the "Reconnecting — page unresponsive"
  // badge — which then stays lit/flickers for up to STALLED_BADGE_TTL_MS because every
  // poll re-stamps the TTL. Recording the live frame time lets the poll defer to a
  // fresher data-channel state instead of re-raising over a page that already recovered.
  const lastDataChannelStateAtRef = useRef(0);
  const applyStalledState = useCallback((isStalled: boolean): void => {
    if (isStalled) lastStalledAtRef.current = Date.now();
    else lastStalledAtRef.current = 0;
    setPageStalled(isStalled);
  }, []);
  // The auto-clear sweep: while the badge is lit, drop it once the last 'stalled'
  // frame is older than the TTL (a real ongoing stall refreshes lastStalledAtRef
  // faster than this fires). Runs only while lit so an idle window does no work.
  useEffect(() => {
    if (!pageStalled) return;
    const tick = (): void => {
      if (lastStalledAtRef.current === 0) return;
      if (Date.now() - lastStalledAtRef.current >= STALLED_BADGE_TTL_MS) {
        lastStalledAtRef.current = 0;
        setPageStalled(false);
      }
    };
    const handle = window.setInterval(tick, 1000);
    return () => window.clearInterval(handle);
  }, [pageStalled]);
  // Page-NAVIGATION error (W616 — DNS/TLS/HTTP/timeout/net). The harness emits a
  // page_state{state:'errored', error:{kind,...}} on a failed load over BOTH the
  // LiveKit data channel AND the control-plane page-state poll. Without surfacing
  // it the loading bar just vanishes and the last frame stays frozen — a real
  // failure reading as a blank successful load (audit, sibling of the launch-no-
  // stream bug). null = no error; set on an 'errored' frame, cleared on any
  // loading/loaded/stalled state + on every operator navigate. The in-app
  // LiveSessionView already shows this overlay; the standalone Simulator (the
  // surface used daily) did not — this closes that gap with the same per-kind copy.
  const [pageError, setPageError] = useState<PageErrorInfo | null>(null);
  // A failed navigate SEND (the data-channel publish rejected) — holds the url so
  // the user gets a persistent Retry instead of a 3s toast that vanishes (M5).
  const [navSendFailed, setNavSendFailed] = useState<string | null>(null);
  // #135 — a SOFT load-stall advisory, distinct from BOTH the W2845 renderer-freeze
  // badge (pageStalled → "page unresponsive") and the W616 hard nav-failure overlay
  // (pageError → "Page failed to load"). A3's nav-stall timer (box 5eeaf794a) emits a
  // page_state{state:'stalled', error:{kind:'timeout', message}} when a main-frame nav
  // hasn't committed/finished within ~40s: the page is STILL TRYING, just slow — NOT a
  // freeze and NOT a terminal error. We surface a gentle "taking longer than usual —
  // Retry" banner (the founder's "it just stops loading, stays on the same site" report),
  // and per A3's contract a later 'loaded' clears it while an 'errored' upgrades it to the
  // hard overlay. The timeout `error.kind` is what distinguishes it from the freeze stall
  // (which carries no error), so the two don't collide on the shared 'stalled' state.
  const [pageLoadStalled, setPageLoadStalled] = useState<{ url: string; message: string } | null>(
    null,
  );
  // #72 — has the CURRENT navigation already reached a painted 'loaded' state? The box
  // emits page_state{state:'errored'} for a navigation failure, but a LATE 'errored'
  // frame that arrives AFTER the page already loaded+painted is a SUB-RESOURCE / late
  // request failure (an analytics beacon, a lazy image, a fetch the page itself made) —
  // NOT a top-level navigation failure. Slamming the full-screen "Page failed to load"
  // overlay over a working page (and inviting a "Try again" that re-navigates = a full
  // refresh) nukes a perfectly good page — the founder's exact report ("the page
  // actually opened, maybe just failed a smaller request later, which causes a full
  // refresh which is bad"). So we only honor an 'errored' frame as a REAL nav failure
  // until the page reaches 'loaded'; once loaded, a later 'errored' for the same page is
  // suppressed (the overlay is for a page that NEVER opened, not one that did). Reset to
  // false on every navigate / tab switch (a fresh navigation can legitimately fail), and
  // set true when a 'loaded' frame arrives. A ref (not state): the data-channel + poll
  // callbacks read it synchronously and it must never itself trigger a re-render.
  const pageReachedLoadedRef = useRef(false);
  // #135 — the current top-level nav target (normalized), so a stale/superseded
  // page_state frame from a DIFFERENT page can't drive the load-gate or error overlay.
  // Set on an operator navigate + on each box 'loading' frame (which tracks link-clicks
  // + redirects the box commits to); '' = untracked (then we don't over-suppress).
  // Honor 'errored' + set 'loaded' ONLY when the frame's url matches this (or ''). Kills
  // the founder's stale "PAGE FAILED TO LOAD" over a working page AND the inverse
  // (a stale 'loaded' from the old page suppressing a real new-page failure — audit #2).
  const currentNavTargetRef = useRef<string>('');
  // Browser-style page TABS (doc-150 item 4; locked A2↔A3 contract). The GUI owns the
  // tab model; each tab is a page the harness keeps a renderer for, and `activeTabId`
  // is the one currently published into the video. We seed exactly one tab on mount so
  // there's always ≥1 (the close handler also refuses to drop below one). The ACTIVE
  // tab's url/title track liveUrl + page_state; a navigate updates the active tab's url
  // and re-sends the full list. The strip is GUI chrome OUTSIDE the video — switching
  // tabs changes which page the BOX publishes, never the rendered 402×714 viewport.
  // Seed a single tab + make it active in one initializer pass so they share an id
  // (no set-during-render). The seed tab's url is empty until liveUrl/page_state fills
  // it (synced by the effect below) — there's always exactly one tab on mount.
  const seedTabRef = useRef<SimTab>({ id: makeTabId(), url: '', scrollY: 0, title: '' });
  const [tabs, setTabs] = useState<SimTab[]>(() => [seedTabRef.current]);
  const [activeTabId, setActiveTabId] = useState<string>(() => seedTabRef.current.id);
  // In-flight activateTab requests keyed by requestId so the harness's
  // activateTabResult reply (handled in onData) can revert an optimistic switch that
  // the box rejected. A missed reply just leaves the optimistic switch (v1 behaviour).
  const pendingActivationsRef = useRef<Map<string, { tabId: string; prevTabId: string }>>(
    new Map(),
  );
  // INSTANT switch-feedback (founder 2026-06-25: "kinda slow to switch"). The real
  // speed lever is A3's box-side no-reload; on the GUI we make the switch FEEL
  // responsive with a subtle "switching…" affordance on the target tab. Holds the
  // tabId currently being switched TO; set on click, cleared the moment the box's
  // page_state for that tab arrives (the one-shot reconcile / activateTabResult ok /
  // a tab-routed page_state frame) or on a bounded timeout so it never hangs.
  const [switchingTabId, setSwitchingTabId] = useState<string | null>(null);
  // SOFTER "could not switch tab" handling (founder 2026-06-25). The harness can
  // MISS an activateTab ack (a dropped data-channel frame); rather than silently
  // leaving the switch half-acknowledged we RE-SEND activateTab once or twice with a
  // short backoff before giving up. One in-flight retry context per target tab,
  // keyed by tabId; cleared on any ack (ok or reject) or when superseded by a newer
  // switch. The re-issue is the ONLY non-blocking failure path — no alert().
  const activationRetryRef = useRef<
    Map<string, { tabId: string; prevTabId: string; attempts: number; timer: number }>
  >(new Map());
  const loadWatchdogRef = useRef<number | null>(null);
  // Timestamp of the last operator navigate. The ~2s page-state poll can fire before
  // the box has seen a just-submitted navigate and would read the PREVIOUS page as
  // 'loaded' → kill the optimistic spinner instantly (audit wqhvarsb9). For a short
  // grace after a navigate, the poll won't turn loading OFF (the watchdog still
  // bounds it), so the loading bar survives until the box reports the new page.
  const lastNavAtRef = useRef(0);
  // Timestamp of the last tab SWITCH (onActivateTab). Same grace role as
  // lastNavAtRef for navigates: the ~2s page-state poll can carry the PRIOR tab's
  // url (the box hasn't re-reported the switched page yet, and prod's poll frames
  // don't carry a tabId) and would clobber the just-switched active tab's url back
  // to the old page — the founder's "2nd switch stays on the same url" bug. Within
  // a short grace after a switch the poll won't overwrite the active tab's url
  // (the one-shot reconcile + a real data-channel frame refresh it instead).
  const lastSwitchAtRef = useRef(0);
  // Live mirror of activeTabId for the data-channel + poll callbacks (which close
  // over a stale activeTabId — their effects don't re-subscribe per switch). Used
  // to resolve "the active tab" when a box frame carries no tabId.
  const activeTabIdRef = useRef(activeTabId);
  useEffect(() => {
    activeTabIdRef.current = activeTabId;
  }, [activeTabId]);
  // Live mirror of the tab list for the data-channel callbacks (onData closes over a
  // stale `tabs`). Used by the activateTabResult revert path to look up the
  // previously-active tab's url/scrollY so the box can be switched BACK to it.
  const tabsRef = useRef(tabs);
  useEffect(() => {
    tabsRef.current = tabs;
  }, [tabs]);
  // Resolve a tab's switch: clear the "switching…" affordance if THIS tab is the one
  // being switched to, and cancel any pending re-issue timer for it. Called when the
  // box acks the switch, reports a page for the tab, or a newer switch supersedes it.
  const resolveSwitch = useCallback((tabId: string): void => {
    const retry = activationRetryRef.current.get(tabId);
    if (retry !== undefined) {
      window.clearTimeout(retry.timer);
      activationRetryRef.current.delete(tabId);
    }
    setSwitchingTabId((cur) => (cur === tabId ? null : cur));
  }, []);
  const resolveSwitchRef = useRef(resolveSwitch);
  useEffect(() => {
    resolveSwitchRef.current = resolveSwitch;
  }, [resolveSwitch]);
  // #116 warm-tabs — cancel a tab's re-issue timer WITHOUT clearing the "switching…"
  // affordance. Used on a COLD activate ack: the switch is acked (stop re-issuing) but
  // the blank stays up until the target's `loaded` frame hides the re-navigation, so a
  // cold switch never flashes the old/loading page. A WARM ack uses resolveSwitch (clears
  // the blank immediately — the live view is already front).
  const cancelActivationRetry = useCallback((tabId: string): void => {
    const retry = activationRetryRef.current.get(tabId);
    if (retry !== undefined) {
      window.clearTimeout(retry.timer);
      activationRetryRef.current.delete(tabId);
    }
  }, []);
  const cancelActivationRetryRef = useRef(cancelActivationRetry);
  useEffect(() => {
    cancelActivationRetryRef.current = cancelActivationRetry;
  }, [cancelActivationRetry]);
  // Cancel every pending switch re-issue timer + clear the affordance. Used when the
  // tab set is replaced (tabListRestore / relaunch) and on unmount so no orphan timer
  // re-sends an activateTab for a tab that no longer exists. Functionless on []-deps.
  const clearAllActivationRetries = useCallback((): void => {
    for (const r of activationRetryRef.current.values()) window.clearTimeout(r.timer);
    activationRetryRef.current.clear();
    setSwitchingTabId(null);
  }, []);
  useEffect(() => () => clearAllActivationRetries(), [clearAllActivationRetries]);
  // SINGLE writer of a tab's stored url/title (live-state accuracy refactor). Applies
  // a box-sourced page_state to ONE tab: the frame's tabId when present (forward-
  // compatible per-tab routing — activates automatically once the box sends tabId),
  // else the active tab. Re-publishes the full list only when something actually
  // changed (no wire storm from the ~2s poll re-asserting the same values). liveUrl/
  // liveTitle are mirrored separately (only when the written tab IS the active one).
  const writeTabPageState = useCallback(
    (
      frame: { tabId?: string | null; url?: string | null; title?: string | null },
      // Whether this frame is AUTHORITATIVE for resolving an in-flight switch. A switch
      // must only resolve (clear "switching…" + cancel the activateTab retry net) on a
      // frame that genuinely reflects the SWITCHED page — a tabId-routed frame to the
      // target, OR a tabId-less frame that arrived OUTSIDE the post-switch grace window
      // (the box has had time to re-report the new page). A tabId-less poll/reconcile
      // frame that lands DURING the grace window still carries the PRIOR tab's state, so
      // it must NOT resolve the switch — doing so silently re-introduces the dropped-ack
      // failure the activateTab retry net was added to fix (cancels the retry timer +
      // clears the spinner before the box actually switches). Data-channel + ack paths
      // are always authoritative.
      isAuthoritative: boolean,
    ): void => {
      const rawFrameTabId =
        typeof frame.tabId === 'string' && frame.tabId !== '' ? frame.tabId : null;
      // Regression guard — the box's per-tab page_state TAGGING went live (#63). The
      // box now stamps a tabId, but if that id doesn't correspond to a tab THIS window
      // actually has (box↔GUI id-scheme skew, or a background renderer's id), routing
      // the url/title to it matches NO tab and silently drops the update → the founder's
      // "title/url stopped changing at all". Treat an UNRECOGNISED tabId as tabId-less:
      // fall back to the active tab (the proven pre-tagging path) so url/title keep
      // updating live. A tabId we DO recognise still routes exactly to that tab.
      const frameTabId =
        rawFrameTabId !== null && tabsRef.current.some((t) => t.id === rawFrameTabId)
          ? rawFrameTabId
          : null;
      const targetId = frameTabId ?? activeTabIdRef.current;
      // The box reported a page for this tab → the switch (if any) landed; clear the
      // "switching…" affordance + cancel its re-issue timer (instant-feedback path).
      // Only on an authoritative frame: a stale in-grace tabId-less poll must keep the
      // retry net running until a genuine frame/ack for the switched page arrives.
      if (isAuthoritative) resolveSwitchRef.current(targetId);
      // #116 — the founder's "tab switch blinks the new page then REVERTS to the old
      // tab" + wrong url/title. On prod the box still emits page_state WITHOUT a tabId
      // (per-tab tagging is A3's held fix), so a tabId-LESS frame that lands in the
      // ~2.5s AFTER a switch may describe the PRIOR tab — writing its url/title onto the
      // just-switched-to tab is exactly the revert.
      const inSwitchGrace =
        frameTabId === null && Date.now() - lastSwitchAtRef.current < PAGE_STATE_GRACE_MS;
      setTabs((prev) => {
        // Suppress ONLY the provably-stale case: an in-grace tabId-less frame whose url
        // is ALREADY the stored url of a DIFFERENT (non-target) tab — that is the prior
        // tab's lagging poll/reconcile, not a fresh load. A genuine first-load or in-tab
        // navigation (url not held by any other tab) still writes through, so a newly
        // opened/navigated tab updates its bar + label live. When it fires, drop the
        // WHOLE frame (url AND title) — the switched-to tab keeps its own correct state
        // until a tabId-matching or post-grace frame arrives.
        if (
          inSwitchGrace &&
          typeof frame.url === 'string' &&
          frame.url !== '' &&
          prev.some((t) => t.id !== targetId && t.url === frame.url)
        ) {
          return prev;
        }
        let changed = false;
        const next = prev.map((t) => {
          if (t.id !== targetId) return t;
          const patch: Partial<SimTab> = {};
          if (typeof frame.url === 'string' && frame.url !== '' && frame.url !== t.url)
            patch.url = frame.url;
          if (typeof frame.title === 'string' && frame.title !== '' && frame.title !== t.title)
            patch.title = frame.title;
          if (Object.keys(patch).length === 0) return t;
          changed = true;
          return { ...t, ...patch };
        });
        if (!changed) return prev;
        emitTabListRef.current(next, activeTabIdRef.current);
        return next;
      });
    },
    [],
  );
  // emitTabList is defined later (after the tab callbacks); a ref lets the
  // box-sourced writer above publish without a forward-reference cycle.
  const emitTabListRef = useRef<(tabs: SimTab[], activeId: string) => void>(() => {});
  // reconcilePageState is defined later too; a ref lets the data-channel onData handler
  // (the activateTabResult path) trigger a one-shot reconcile without a forward cycle.
  const reconcilePageStateRef = useRef<() => void>(() => {});
  const clearLoadWatchdog = (): void => {
    if (loadWatchdogRef.current !== null) {
      window.clearTimeout(loadWatchdogRef.current);
      loadWatchdogRef.current = null;
    }
  };
  // Centralized load-watchdog arming. EVERY transition into loading=true (re)arms the
  // 6s safety net so the loading bar self-terminates if the box never reports a terminal
  // frame — not just operator navigates. Box-reported loading (data-channel page_state,
  // the ~2s poll) is the dominant path in AI mode (agent navigations) + for redirects /
  // sub-navigations / SPA route changes; without arming here the bar trickles to ~90%
  // and sticks forever when the box drops a terminal frame or a session ends mid-load.
  const armLoadWatchdog = (): void => {
    clearLoadWatchdog();
    loadWatchdogRef.current = window.setTimeout(() => {
      setPageLoading(false);
      loadWatchdogRef.current = null;
    }, 6000);
  };
  useEffect(() => () => clearLoadWatchdog(), []);
  // Optimistically reset the per-page chrome (error overlay / loading bar / stalled
  // badge / progress) on a tab switch/open/close. These four pieces of state are
  // currently GLOBAL to the window (not per-tab), so without this reset a prior tab's
  // "Page failed to load" overlay, loading bar, or "page unresponsive" badge bleeds
  // across onto the newly-active tab — and the overlay's "Try again" re-navigates the
  // WRONG tab (liveUrl has already re-derived to the new tab). The box's next
  // page_state for the now-active tab re-asserts the real state. Until pageError/
  // pageLoading/pageStalled/loadProgress move into the per-tab SimTab record, this is
  // the correct optimistic clear.
  const resetPageChromeForSwitch = useCallback((): void => {
    setPageError(null);
    setPageStalled(false);
    setPageLoadStalled(null); // #135 — don't bleed a load-stall advisory across tabs
    setPageLoading(false);
    setLoadProgress(null);
    // #72 — a switched-to / freshly-opened tab is a new navigation; until IT reaches
    // 'loaded', an 'errored' frame is a real top-level failure (so re-arm the gate).
    pageReachedLoadedRef.current = false;
    // #135 — untrack the nav target on a switch; the new tab's next box 'loading' frame
    // sets it (until then '' ⇒ don't over-suppress its first real failure).
    currentNavTargetRef.current = '';
    clearLoadWatchdog();
  }, []);
  useEffect(() => {
    if (room === null) return;
    const onData = (payload: Uint8Array): void => {
      try {
        const msg = JSON.parse(new TextDecoder().decode(payload)) as {
          type?: string;
          state?: string;
          url?: string;
          title?: string;
          loading?: boolean;
          progress?: number;
          // A3 W3005 / box 76b720c0d — the per-archetype FIXED logical content
          // viewport (CSS-px the injector's origin:viewport maps to, e.g. 402×714
          // launch / 402×678 Family-A), emitted on EVERY page_state frame. The GUI
          // uses THIS as the tap/scroll coordinate space, never the SFU-downscaled
          // video track px (which vary with bandwidth → would corrupt tap coords).
          logicalContentWidth?: number;
          logicalContentHeight?: number;
          // A3 W3019/#6 — the box emits this on every page_state frame once a text
          // field on the page gains/loses focus (fork DRIFTSTACK_INPUT_FOCUS token →
          // harness PageState.inputFocused). Drives the on-screen keyboard exactly like
          // a real iPhone: appears the instant the user taps into a field, disappears
          // when focus leaves — no manual toggle needed. Auto-show is ACTIVE BY DEFAULT
          // (founder 2026-06-30); the manual ⌨ toggle stays available as an override/
          // fallback (e.g. while a session is on an older box build pre-dating this).
          inputFocused?: boolean;
          // tabId (doc-150 item 4 → live-state accuracy) — a page_state frame the box
          // attributes to a specific renderer. When present we route url/title to THAT
          // tab; absent → the active tab. Forward-compatible: per-tab routing activates
          // automatically the moment the box starts stamping it.
          tabId?: string | null;
          // activateTabResult (doc-150 item 4) — the harness's reply to activateTab.
          requestId?: string;
          ok?: boolean;
          // A3 warm-tabs (#116, harness wasWarm 13ad369ae) — true when the box brought
          // the target tab's LIVE pre-warmed view to front (instant, no re-navigation);
          // absent/false = a COLD switch (re-navigate). Drives whether the GUI drops the
          // "switching…" blank on the ack (warm = instant, drop now) or keeps it until the
          // target's `loaded` frame (cold = keep, so the re-nav doesn't flash the old page).
          wasWarm?: boolean;
          // `error` is overloaded across frame types: a string on activateTabResult
          // (narrowed via typeof below) and a {kind,http_status,message} object on a
          // page_state{state:'errored'} frame (W616). Typed `unknown` so each path
          // narrows it safely.
          error?: unknown;
          // tabListRestore (doc-150 §7.5) — the box pushes the decrypted
          // ProfileBlob.openTabs set on profile reopen so the bar repopulates.
          tabs?: unknown;
          activeTabId?: unknown;
        };
        // activateTabResult — correlate by requestId against our optimistic switch.
        // ok (or a missing ok with no error) → confirmed, drop the pending record. A
        // rejection (ok:false / error) → revert to the tab that was active before, and
        // surface a brief notice. A reply for an unknown requestId is ignored (already
        // resolved / a different window). This is the only re-issue-on-miss handling;
        // a DROPPED reply leaves the optimistic switch in place (acceptable for v1).
        if (msg.type === 'activateTabResult' && typeof msg.requestId === 'string') {
          const pending = pendingActivationsRef.current.get(msg.requestId);
          if (pending !== undefined) {
            // A switch can have SEVERAL in-flight requestIds for the SAME tab (each
            // re-issue mints a new one). The first ack RESOLVES that tab; drop EVERY
            // pending entry for the same tabId so a sibling retry's late/colliding ack
            // (a duplicate wd.navigate can collide → -1005 error even though the page
            // switched) can't later REVERT a switch that already landed (founder
            // 2026-06-25 "could not switch tab" yank under lag).
            for (const [id, p] of pendingActivationsRef.current) {
              if (p.tabId === pending.tabId) pendingActivationsRef.current.delete(id);
            }
            // #116 warm-tabs — the affordance-clear now depends on warm vs cold:
            //  - WARM swap (wasWarm=true): the box brought the live tab to front INSTANTLY,
            //    so drop the "switching…" blank now — the target is already showing.
            //  - COLD success ack: the box RE-NAVIGATES, so clearing the blank on the ack
            //    would flash the old/loading page — cancel only the re-issue timer and keep
            //    the blank until the target's `loaded` frame hides the reload.
            //  - ERROR ack (ok:false / error): clear here; the revert path below resets the
            //    chrome for the tab we fall back to.
            if (msg.wasWarm === true || msg.ok === false || typeof msg.error === 'string') {
              resolveSwitchRef.current(pending.tabId);
            } else {
              cancelActivationRetryRef.current(pending.tabId);
            }
          }
          // A superseded ack (the operator has since switched to a DIFFERENT tab, or a
          // sibling retry already resolved this one) must never yank the current tab.
          // Only revert when this ack's tab is STILL the active one — i.e. its switch is
          // the live one. activeTabIdRef mirrors the latest active tab (the closure's
          // activeTabId is stale across switches).
          if (
            pending !== undefined &&
            pending.tabId === activeTabIdRef.current &&
            (msg.ok === false || typeof msg.error === 'string')
          ) {
            // SOFT failure (founder 2026-06-25): revert to the previously-active tab
            // (a sensible state — never leave it half-switched) and show a brief,
            // NON-BLOCKING notice. No alert(); the toast auto-dismisses.
            setActiveTabId(pending.prevTabId);
            // audit wb1w3015f #6 — reset the (window-global) page chrome on the revert
            // exactly like the forward-switch paths do, so the REJECTED tab's overlay /
            // spinner / stalled badge / load-gate can't bleed onto the reverted-to tab
            // (whose own re-activated page_state below re-asserts the truth). Without
            // this a stale 'Try again' overlay could force-refresh the working prev tab.
            resetPageChromeForSwitch();
            // The box switched (or tried to) to the REJECTED tab and is now publishing
            // it — reverting only the GUI's activeTabId leaves the video on the failed
            // page while the strip + address bar show the previous tab. Re-activate the
            // previous tab on the box too so the published page matches the reverted UI
            // (correlated activateTab, like a normal switch). Look the prev tab up from
            // the live ref (onData closes over a stale `tabs`); guard on it still
            // existing + a connected room.
            const prevTab = tabsRef.current.find((t) => t.id === pending.prevTabId);
            if (prevTab !== undefined && room !== null) {
              const activateUrl = isBlankTabUrl(prevTab.url) ? NEW_TAB_URL : prevTab.url;
              sendActivateAttemptRef.current({
                tabId: prevTab.id,
                prevTabId: pending.tabId,
                url: activateUrl,
                scrollY: prevTab.scrollY,
              });
            }
            setNotice('Could not switch tab');
            window.setTimeout(() => setNotice(null), 3000);
          } else if (
            pending !== undefined &&
            pending.tabId === activeTabIdRef.current &&
            !(msg.ok === false || typeof msg.error === 'string')
          ) {
            // CONFIRMED switch — the box acknowledged it landed on `pending.tabId`.
            // Fire a one-shot reconcile so the now-active tab refreshes from the box
            // even if the data-channel page_state for the switched page dropped (the
            // immediate pull in onActivateTab can race ahead of the box settling; this
            // is the catch-up). Routes by tabId when the box stamps it, else active.
            reconcilePageStateRef.current();
          }
          return;
        }
        // tabListRestore (doc-150 §7.5) — on profile reopen the box decrypts the
        // server-opaque ProfileBlob.openTabs and PUSHES the restored set over this
        // channel so the bar repopulates (the only path: the server can't decrypt
        // the URLs to supply them over REST). REPLACE the local tab model with the
        // restored set + point the address bar at the active tab's url. Sanitize
        // hostile frames defensively (the GUI is the encoder's twin, but a frame is
        // semi-trusted): require a non-empty tabs ARRAY of well-formed entries, drop
        // malformed entries, never go below one tab, and resolve activeTabId to a real
        // tab (fall back to the first). A malformed/empty frame is ignored entirely
        // (keep the current bar) rather than blanking it.
        if (msg.type === 'tabListRestore') {
          if (!Array.isArray(msg.tabs)) return; // not-an-array / missing → ignore
          const restored: SimTab[] = [];
          for (const raw of msg.tabs as unknown[]) {
            if (typeof raw !== 'object' || raw === null) continue;
            const t = raw as { id?: unknown; url?: unknown; scrollY?: unknown; title?: unknown };
            if (typeof t.id !== 'string' || t.id === '') continue;
            restored.push({
              id: t.id,
              url: typeof t.url === 'string' ? t.url : '',
              scrollY: typeof t.scrollY === 'number' && t.scrollY >= 0 ? t.scrollY : 0,
              title: typeof t.title === 'string' ? t.title : '',
            });
          }
          const first = restored[0];
          if (first === undefined) return; // nothing usable → keep the current bar
          const wantActive = typeof msg.activeTabId === 'string' ? msg.activeTabId : '';
          const active = restored.find((t) => t.id === wantActive) ?? first;
          // Pending optimistic switches reference ids from the OLD set — clear them so
          // a late activateTabResult can't revert into a tab that no longer exists.
          // Cancel any in-flight switch re-issue timers + the affordance too (their
          // target tab ids are gone).
          pendingActivationsRef.current.clear();
          for (const r of activationRetryRef.current.values()) window.clearTimeout(r.timer);
          activationRetryRef.current.clear();
          setSwitchingTabId(null);
          setTabs(restored);
          setActiveTabId(active.id);
          // Reflect the active tab's url in the address bar (the BrowserBar reads liveUrl).
          if (active.url !== '') setLiveUrl(active.url);
          if (active.title !== '') setLiveTitle(active.title);
          return;
        }
        // Accept BOTH the proposed {type:'page_state', url, loading, progress}
        // envelope AND A3's shipped HarnessOutbound.PageState {sessionId, state,
        // url, error} where state ∈ loading|loaded|errored (bus W2717-done). The
        // box emits the latter over THIS data channel on navigate; prod's
        // page-state REST endpoint is stubbed, so the channel is the only live
        // source — keying only on type:'page_state' silently dropped every event.
        const isHarnessState =
          msg.state === 'loading' ||
          msg.state === 'loaded' ||
          msg.state === 'errored' ||
          msg.state === 'stalled';
        if (msg.type !== 'page_state' && !isHarnessState) {
          // Finding #6 — the frame matched NONE of the known discriminants
          // (activateTabResult / tabListRestore / page_state / a harness state). The
          // latency-ping channel shares this data channel, so exclude it first; then
          // emit a throttled, prod-visible breadcrumb so a real box-envelope drift is
          // diagnosable instead of silently stalling page_state + the overlays.
          if (msg.type !== 'ping') warnUnrecognizedDataFrame(msg);
          return;
        }
        // Finding #3 — once the session has terminally ended (one-way latch), freeze the
        // page-state chrome the same way the poll does (it bails on sessionEnded). A late
        // 'loading'/'stalled'/'errored' frame the box pushes as it tears down — or one
        // still buffered in the LiveKit data channel — would otherwise re-light the
        // loading bar / re-stamp the "page unresponsive" badge ABOVE the "Session ended"
        // overlay (window chrome around the video panel, not suppressed by it).
        if (sessionEndedRef.current !== null) return;
        // A3 W3005 — adopt the box's FIXED per-archetype logical content dims as the
        // tap/scroll coordinate space (every page_state frame carries them). The
        // durable fix for SFU-downscale tap drift: the encoded track px vary with
        // bandwidth, but these CSS-px viewport dims are stable, so taps map 1:1 to what
        // the injector's origin:viewport expects. Update only when present + changed (a
        // CP-poll frame without dims never clears them); latch so the track-derived
        // fallback in handleVideoDimensions stops overriding.
        {
          const lw = msg.logicalContentWidth;
          const lh = msg.logicalContentHeight;
          if (typeof lw === 'number' && lw > 0 && typeof lh === 'number' && lh > 0) {
            hasPageStateDimsRef.current = true;
            if (deviceLogicalRef.current.width !== lw || deviceLogicalRef.current.height !== lh) {
              setInputLogical({ width: lw, height: lh });
            }
          }
        }
        // #6 — auto-show/hide the on-screen keyboard from the box's real DOM focus
        // state (a real iPhone never makes you reach for a toggle). Mirrors the box
        // signal directly; the manual ⌨ button can still show/hide it at any time
        // (e.g. before this signal arrives on an older build) and isn't fought by a
        // frame that doesn't carry the field (absent → no change, not a hide). Gated
        // OUT in AI mode: the focus event there is the AGENT typing, not the founder
        // — popping the keyboard for the agent's own input would be confusing chrome
        // over a read-only view (the ⌨ toggle is already disabled in AI mode).
        if (typeof msg.inputFocused === 'boolean' && controlModeRef.current !== 'ai') {
          setKeyboardVisible(msg.inputFocused);
        }
        // Box is the ONLY writer of a tab's stored url/title (live-state accuracy
        // refactor). Route by tabId when the frame carries one, else the active tab;
        // a title-only frame (no url) still refreshes the label. The derived effect
        // re-mirrors the active tab into liveUrl/liveTitle, so the address bar +
        // window title follow automatically when the written tab is the active one.
        if (
          (typeof msg.url === 'string' && msg.url !== '') ||
          (typeof msg.title === 'string' && msg.title !== '')
        ) {
          // Data-channel page_state is authoritative for the switch — it's the box's
          // live push for the page it's actually showing.
          writeTabPageState({ tabId: msg.tabId, url: msg.url, title: msg.title }, true);
        }
        // #135 — a page_state{state:'stalled'} is OVERLOADED: A3's NAV-stall timer
        // (box 5eeaf794a) tags a slow-LOAD stall with error.kind==='timeout', while the
        // W2845 renderer-FREEZE stall carries no error. Split them: the timeout variant
        // is the soft "taking longer to load — Retry" advisory (pageLoadStalled, handled
        // once navTargetOk is known below), NOT the "page unresponsive" freeze badge.
        const stallErr =
          typeof msg.error === 'object' && msg.error !== null
            ? (msg.error as { kind?: string; message?: string })
            : null;
        const isLoadTimeoutStall = msg.state === 'stalled' && stallErr?.kind === 'timeout';
        // A3 W2845 — a FREEZE 'stalled' frame surfaces the frozen-renderer badge; any
        // other harness state clears it (the page is responsive again). #4 —
        // applyStalledState stamps the frame time so the TTL sweep can self-clear a
        // stale latch (the store re-applies a one-time stall forever otherwise). The
        // load-timeout stall is EXCLUDED here (it is not a freeze) → no "unresponsive".
        if (isHarnessState) {
          // Stamp the live-source time FIRST so a near-simultaneous poll defers to this
          // authoritative frame (the poll's un-TTL'd store can lag behind a recovery).
          lastDataChannelStateAtRef.current = Date.now();
          applyStalledState(msg.state === 'stalled' && !isLoadTimeoutStall);
        }
        // #72 + #135 — track when the CURRENT navigation reaches 'loaded'. navTargetOk
        // gates on the frame's url matching the current nav target so a STALE 'loaded'
        // from a page the operator already left can't flip the gate (which would then
        // suppress the NEW page's real failure — audit #2). '' target ⇒ untracked → we
        // don't over-suppress (fall back to the #72 loaded-gate alone).
        const navTargetOk =
          currentNavTargetRef.current === '' ||
          normalizeNavUrl(msg.url) === currentNavTargetRef.current;
        if (msg.state === 'loaded' && !isNewTabLoadError(msg.url) && navTargetOk) {
          pageReachedLoadedRef.current = true;
        }
        // W616 — a page-NAVIGATION error: surface the per-kind error overlay (the
        // failure must not read as a blank successful load). Any other harness
        // state means the page is loading/loaded/responsive → clear it.
        if (isHarnessState) {
          // #72 — honor 'errored' as a REAL failure only BEFORE the page loaded; #135 —
          // AND only when the frame is for the CURRENT nav target (drop a STALE 'errored'
          // from a superseded page = the founder's false "PAGE FAILED TO LOAD" over a
          // working, open page). A3 confirmed errored is main-frame-only, so url-match
          // never hides a real sub-resource-vs-toplevel distinction.
          if (
            msg.state === 'errored' &&
            !isNewTabLoadError(msg.url) &&
            !pageReachedLoadedRef.current &&
            navTargetOk
          ) {
            setPageError(typeof msg.error === 'object' && msg.error !== null ? msg.error : {});
          } else {
            // A real error overlay, OR a blank new-tab whose branded page couldn't load
            // through the proxy, OR a late post-load sub-resource error (#72) → clear/
            // never show the hard error (keep the page that already opened).
            setPageError(null);
          }
        }
        // #135 — the soft load-stall advisory (A3's timeout-tagged 'stalled'). Show it
        // ONLY for the CURRENT nav target that has not yet painted 'loaded' (a late stall
        // after load, or one for a page already left, is ignored). ANY other harness state
        // — a real 'loaded'/'errored'/fresh 'loading', or the freeze stall — supersedes it,
        // matching A3's "a later loaded clears it, errored upgrades it" contract.
        if (isHarnessState) {
          if (isLoadTimeoutStall && navTargetOk && !pageReachedLoadedRef.current) {
            setPageLoadStalled({
              url: typeof msg.url === 'string' ? msg.url : '',
              message:
                typeof stallErr?.message === 'string' && stallErr.message.length > 0
                  ? stallErr.message
                  : 'This page is taking longer than usual to load.',
            });
          } else {
            setPageLoadStalled(null);
          }
        }
        // #135 — the box committing to a 'loading' of a url IS the current nav target
        // (covers link-clicks + redirects the operator never typed). Track it so the
        // following 'loaded'/'errored' for THAT page matches, while a stale frame from a
        // page already left does not.
        if (
          isHarnessState &&
          msg.state === 'loading' &&
          typeof msg.url === 'string' &&
          msg.url.length > 0 &&
          !isNewTabLoadError(msg.url)
        ) {
          const norm = normalizeNavUrl(msg.url);
          if (norm !== currentNavTargetRef.current) {
            // a NEW top-level page the box committed to (a link-click / redirect the
            // operator never typed) → re-arm the load-gate so THIS page's real failure
            // can surface (the gate otherwise only reset on operator navigate/switch).
            currentNavTargetRef.current = norm;
            pageReachedLoadedRef.current = false;
          }
        }
        const loading = isHarnessState ? msg.state === 'loading' : msg.loading;
        if (typeof loading === 'boolean') {
          // audit wb1w3015f #7 — mirror the poll-path grace guard (line ~3849) on this
          // authoritative data-channel path: a stale loading=false from the page the
          // operator just LEFT (or a late frame before the box sees our just-submitted
          // navigate) must NOT clear the NEW navigation's optimistic spinner — that reads
          // as "nothing is happening" right after a click. Drop a within-grace
          // loading=false UNLESS it's for the CURRENT nav target (navTargetOk ⇒ a genuine
          // fast new-page load, which SHOULD clear the spinner immediately). loading=true
          // always applies (escalate), and past the grace window we always apply.
          const staleClear =
            !loading && !navTargetOk && Date.now() - lastNavAtRef.current < PAGE_STATE_GRACE_MS;
          if (!staleClear) {
            setPageLoading(loading);
            // Finding #1 — a box-reported loading=true arms the watchdog too (not just
            // operator navigates), so it self-terminates if the box never pushes a
            // terminal frame (session ends mid-load, renderer wedges, dropped frame).
            if (loading) armLoadWatchdog();
            else clearLoadWatchdog();
          }
        }
        setLoadProgress(typeof msg.progress === 'number' ? msg.progress : null);
      } catch {
        /* not a page_state JSON message — ignore */
      }
    };
    const r = room as unknown as {
      on?: (e: string, cb: (p: Uint8Array) => void) => void;
      off?: (e: string, cb: (p: Uint8Array) => void) => void;
    };
    try {
      r.on?.(RoomEvent.DataReceived, onData);
    } catch {
      return;
    }
    return () => {
      try {
        r.off?.(RoomEvent.DataReceived, onData);
      } catch {
        /* ignore */
      }
    };
  }, [room, writeTabPageState, applyStalledState]);

  // Live URL via the page-state API (A3 W2730): the box reports pageState over the
  // CONTROL PLANE (→ server sessionPageStateStore), NOT the LiveKit data channel —
  // which is why the data-channel consumer above never populated it. The founder
  // asked the API to expose the URL; this POLLS GET /v1/agent-sessions/:id/
  // page-state (~2s) so the address bar shows the device's actual current URL
  // (including the first page it opens + redirects). Best-effort + guarded; null
  // until the box reports. BrowserBar won't clobber what the operator is typing.
  useEffect(() => {
    // Stop polling once the session has terminally ended (one-way latch): otherwise the
    // poll keeps calling writeTabPageState / setPageLoading / applyStalledState /
    // setPageError against the dead session, so the loading bar can keep trickling and
    // the stalled badge keep re-stamping UNDER the "Session ended" overlay (those render
    // as window chrome OUTSIDE the overlaid video panel). When sessionEnded flips the
    // effect re-runs, returns early, and the cleanup tears the interval down — freezing
    // the chrome in its last live state.
    if (sessionId === '' || room === null || !browserMode || sessionEnded !== null) return;
    let cancelled = false;
    const tick = (): void => {
      void getAgentSessionPageState(sessionId, controlAuth)
        .then((ps) => {
          if (cancelled || ps === null) return;
          // Box-sourced url/title → tab storage (the box is the only writer). When
          // the poll frame carries a tabId, route precisely — no grace needed (it
          // lands on the right tab). When it does NOT (today's prod page-state poll),
          // it targets the ACTIVE tab and could carry the PRIOR tab's url for ~2s
          // after a switch/navigate (the box hasn't re-reported the new page yet) →
          // the founder's "2nd switch stays on the same url" clobber. So within the
          // grace window suppress BOTH the URL and the TITLE (founder 2026-07-07:
          // "title/url not accurate at all times"). A tabId-less in-grace frame
          // carries the PRIOR tab's page, so applying its title routes the WRONG
          // tab's title onto the just-switched tab — the persistent inaccuracy. The
          // earlier design let the title through ("self-heals") but that assumption
          // fails when the box keeps re-asserting the tabId-less prior title; keeping
          // the tab's own last-known title (null ⇒ writeTabPageState skips it) until a
          // genuine frame arrives is strictly more accurate. Tag tabId box-side to
          // make this fully precise (A3 #116).
          const hasTabId = typeof ps.tabId === 'string' && ps.tabId !== '';
          const inGrace =
            Date.now() - lastSwitchAtRef.current < PAGE_STATE_GRACE_MS ||
            Date.now() - lastNavAtRef.current < PAGE_STATE_GRACE_MS;
          const suppress = !hasTabId && inGrace;
          // Authoritative for the SWITCH iff it routes by tabId OR it arrived outside
          // the post-switch grace window — a tabId-less in-grace poll still carries the
          // PRIOR tab's page, so it must NOT resolve the switch (keep the retry net up).
          const inSwitchGrace = Date.now() - lastSwitchAtRef.current < PAGE_STATE_GRACE_MS;
          writeTabPageState(
            {
              tabId: ps.tabId,
              url: suppress ? null : ps.url,
              title: suppress ? null : ps.title,
            },
            hasTabId || !inSwitchGrace,
          );
          // A3 W2845 — surface/clear the frozen-renderer badge from the poll too
          // (independent of the loading grace window; a stall is real regardless).
          // #4 — through applyStalledState so each 'stalled' poll refreshes the TTL
          // stamp: a real ongoing stall keeps re-stamping (badge stays lit), while a
          // one-time stall the store keeps re-reading self-clears after the TTL.
          //
          // BUT defer to a fresher DATA-CHANNEL frame: the poll reads an un-TTL'd store
          // that lags a recovery, so right after the box recovers (data channel pushed a
          // non-stalled state, badge cleared) a stale 'stalled' poll would re-raise the
          // badge — and then keep it lit for the full TTL (each poll re-stamps it). When
          // the live data channel reported within the grace window, skip the poll's
          // stale stall flip entirely; a genuinely-still-stalled page keeps pushing
          // 'stalled' over the data channel, so the badge stays lit for a REAL freeze.
          const liveFrameFresh =
            Date.now() - lastDataChannelStateAtRef.current < PAGE_STATE_GRACE_MS;
          if (!liveFrameFresh) applyStalledState(ps.state === 'stalled');
          // #135 — mirror the data-channel: a 'loading' poll tracks the current nav
          // target; the loaded/errored gates match against it so a stale poll frame from
          // a page already left can't drive the overlay / load-gate.
          if (
            ps.state === 'loading' &&
            typeof ps.url === 'string' &&
            ps.url.length > 0 &&
            !isNewTabLoadError(ps.url)
          ) {
            const pnorm = normalizeNavUrl(ps.url);
            if (pnorm !== currentNavTargetRef.current) {
              currentNavTargetRef.current = pnorm;
              pageReachedLoadedRef.current = false; // #135 — new box-driven page → re-arm gate
            }
          }
          const pollNavTargetOk =
            currentNavTargetRef.current === '' ||
            normalizeNavUrl(ps.url) === currentNavTargetRef.current;
          // #72 — same painted-'loaded' gate as the data-channel path: once this
          // navigation has loaded, a later 'errored' poll is a sub-resource failure,
          // not a top-level nav failure → don't pop the overlay over a working page.
          if (ps.state === 'loaded' && !isNewTabLoadError(ps.url) && pollNavTargetOk) {
            pageReachedLoadedRef.current = true;
          }
          // W616 — surface/clear the page-navigation error from the poll too (same
          // payload as the data-channel path); 'errored' shows the overlay ONLY before
          // the page ever loaded (#72), any other state clears it. A blank new-tab
          // whose branded page couldn't load through the proxy is graceful (no overlay).
          setPageError((prev) =>
            ps.state === 'errored' &&
            !isNewTabLoadError(ps.url) &&
            !pageReachedLoadedRef.current &&
            pollNavTargetOk
              ? // #7 — within the post-navigate / post-switch grace window a stale
                // 'errored' from the un-correlated store must NOT re-raise the overlay
                // the operator just dismissed (keep `prev`); the live data-channel push
                // surfaces a REAL post-nav error immediately, and the next out-of-grace
                // poll still raises it (the store keeps the latest 'errored', so it is
                // deferred, not lost — mirroring the 'loading' grace below).
                inGrace
                ? prev
                : (ps.error ?? {})
              : null,
          );
          // #135 — clear the soft load-stall advisory from the POLL too. A3's timeout
          // stall arrives ONLY over the data channel (publishPageStateToRoom), so the
          // poll never SETS pageLoadStalled — but the terminal 'loaded'/'errored' that
          // supersedes it may reach the GUI only via the poll if the data-channel frame
          // was dropped/coalesced, which would otherwise latch the banner over a loaded
          // page forever. Defer to a fresher data-channel frame (which already cleared
          // it in its else-branch) and only clear for the current nav target reaching a
          // terminal state.
          if (
            !liveFrameFresh &&
            pollNavTargetOk &&
            (ps.state === 'loaded' || ps.state === 'errored')
          ) {
            setPageLoadStalled(null);
          }
          const loading = ps.state === 'loading';
          // Don't let a stale 'loaded' (the box hasn't seen our just-submitted
          // navigate yet) kill the optimistic spinner. Within the grace window after
          // a navigate, only ESCALATE to loading; the 6s watchdog still bounds it.
          if (!loading && Date.now() - lastNavAtRef.current < PAGE_STATE_GRACE_MS) return;
          setPageLoading(loading);
          // Finding #1 — arm the watchdog on a box-reported loading=true here too, so a
          // poll-driven load (the dominant path in AI mode) self-terminates if the box
          // never reports completion (renderer wedge / dropped terminal frame).
          if (loading) armLoadWatchdog();
          else clearLoadWatchdog();
        })
        .catch(() => {
          /* best-effort poll — transient errors are non-fatal */
        });
    };
    tick();
    const handle = window.setInterval(tick, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [
    sessionId,
    controlAuth,
    room,
    browserMode,
    writeTabPageState,
    applyStalledState,
    sessionEnded,
  ]);

  // P1a — TERMINAL session-end poll. The freeze cluster's auto-reconnect/resubscribe/
  // rebuild machinery treated a session that ACTUALLY ENDED (the worker browser
  // closed, the session was destroyed/errored, the orphan sweeper reaped it) the same
  // as a transient transport drop → the GUI showed "reconnecting" and retried forever
  // against a session that's gone. This ~5s poll of GET /v1/agent-sessions/:id reads
  // the lifecycle status (status='closed' / closed_at / closed_reason) and latches the
  // terminal "Session ended" state the moment the CP reports it. Once latched it STAYS
  // (terminal is one-way — a closed session never re-opens), and the panel + the freeze
  // driver short-circuit all recovery. Distinct from the page-state poll (that reports
  // the PAGE's load state, which has its own 'errored'/'stalled' overlays; this is the
  // SESSION lifecycle). Runs whenever there's a session id; best-effort + guarded — a
  // transient control-API error is non-fatal (a transport blip must NOT read as ended).
  useEffect(() => {
    // Once the terminal end has latched (one-way) there's nothing left to detect — stop
    // GET-ing the dead session every 5s forever. When sessionEnded flips the effect
    // re-runs, returns early, and the cleanup clears the interval.
    if (sessionId === '' || sessionEnded !== null) return;
    let cancelled = false;
    const reqSessionId = sessionId;
    const tick = (): void => {
      void getAgentSession(reqSessionId, controlAuth)
        .then((s) => {
          // Drop a result that resolved after an in-place session swap.
          if (cancelled || reqSessionId !== sessionIdRef.current) return;
          // One-way: only LATCH terminal — never clear it (a non-terminal read after a
          // real end can't happen for the same id, and we must not let a stale/racing
          // poll un-end a closed session). A fresh session swap resets sessionEnded.
          if (s.terminal) {
            setSessionEnded({ reason: s.closedReason });
            return;
          }
          // Finding #11 — this same 5s round-trip already carries the live pair state
          // (s.pairKind), but it was thrown away. In pair mode the AGENT autonomously
          // grabs/releases driving control server-side; without this the GUI keeps
          // showing the stale "who is driving" state + offers the wrong Take/Hand-back
          // action. Apply it when the session is non-terminal and no mutation is in
          // flight (guard like refreshControl, so it never clobbers an optimistic
          // onSetMode/onTakeover/onHandback). Zero extra network cost.
          if (!controlBusyRef.current) {
            setPairKind(s.pairKind);
            setControlMode(s.mode);
            setControlModeConfirmed(true);
          }
        })
        .catch((err: unknown) => {
          // Drop a result that resolved after an in-place session swap (mirrors .then).
          if (cancelled || reqSessionId !== sessionIdRef.current) return;
          // An expired/invalid per-session gui_control_key (24h TTL, standalone
          // Simulator app) 401/403s EVERY poll, so this terminal session-end poll can
          // never read status='closed' again — `sessionEnded` silently stops latching,
          // and a worker browser that then closes leaves the reconnecting overlay lit
          // forever ("session shows running after the browser closed"). Surface the
          // degraded state via the always-visible controlUnreachable badge (controlError
          // only renders when mode===null, i.e. invisible in the common browser-mode
          // case) so the operator knows live-status detection is degraded and to reopen
          // the session. Transient/network/5xx errors stay silent (retry next tick) — a
          // transport blip must NOT read as ended.
          const status = err instanceof AgentSessionControlError ? err.status : 0;
          if (status === 401 || status === 403) setControlUnreachable(true);
        });
    };
    tick();
    const handle = window.setInterval(tick, 5000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [sessionId, controlAuth, sessionEnded]);

  // Founder #48 — live cookie-jar view. Polls GET /v1/agent-sessions/:id/cookies
  // ONLY while the session-info / diagnostics panel is open (no background load on
  // a panel nobody's looking at). `cookies` = the live jar (ok); `cookiesNote` = a
  // calm "pending data source" line for every inert state (control plane off /
  // node offline / node not yet serving cookies / gated 503). Best-effort + guarded
  // — a transient/gated failure just keeps the pending note, never throws.
  const [cookies, setCookies] = useState<SessionCookie[] | null>(null);
  const [cookiesNote, setCookiesNote] = useState<string | null>(null);
  // Founder 2026-07-06 "cookies sometimes showing, sometimes not — should show all
  // this profile's cookies at all times". The poll used to setCookies(null) on EVERY
  // non-'ok' tick (timeout=device merely slow, transient 5xx, gated), blanking a
  // populated panel each hiccup then repainting on the next success = the flicker.
  // Fix: RETAIN the last-known jar through transient states; only the terminal
  // session-ended path clears it. This ref lets the calm "waiting…" note show ONLY
  // when there's genuinely nothing fetched yet (else we keep the jar on screen, no note).
  const hasCookiesRef = useRef(false);
  useEffect(() => {
    // Approach B perf — poll ONLY while the Cookies pane is the active section
    // (was gated on the whole drawer being open). Switching away tears the
    // interval down via the effect cleanup; switching back re-fires tick().
    if (!cookiesPaneActive || sessionId === '' || room === null) return;
    // Finding #13 — once the session has terminally ended, stop polling the dead session
    // (the page-state + terminal-end polls already bail on sessionEnded). Otherwise the
    // cookies endpoint 404s forever and the catch branch shows "cookies will appear once
    // a page loads" — framed as if a future load can populate them, which can't happen on
    // an ended session. Show an honest terminal note instead.
    if (sessionEnded !== null) {
      setCookies(null);
      hasCookiesRef.current = false; // terminal clear — a new session starts fresh
      setCookiesNote('Session ended — cookies are no longer available.');
      return;
    }
    // Finding #5 — self-scheduling poll with exponential backoff. The next tick is
    // scheduled ONLY inside .finally (after the prior request settles), so requests can
    // never overlap/stack (this self-scheduling IS the single-flight guard; the server
    // holds a cookies request up to ~10s, so a fixed 3s interval would pile ~3-4 in
    // flight). Steady cadence stays 3s; on a persistently gated/unreachable path the
    // delay doubles (cap 30s) so the GUI stops hammering the control plane. backoff
    // resets to 3s only on a TRUE 'ok' — a calm timeout/pending is the persistently-
    // degraded case that should back off too.
    let cancelled = false;
    let backoff = 3000;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      void getAgentSessionCookies(sessionId, controlAuth)
        .then((res) => {
          if (cancelled) return;
          if (res.status === 'ok') {
            const jar = res.cookies ?? [];
            setCookies(jar);
            hasCookiesRef.current = jar.length > 0;
            setCookiesNote(null);
            backoff = 3000; // reset cadence on a real success
          } else if (res.status === 'timeout') {
            // Founder report 2026-07-02 (profile Qqd11) — "not realtime at all
            // times". A 'timeout' means the SERVER already held the request
            // open ~10s waiting for the device to answer — the device is live,
            // just slow, not dead/gated. Doubling the CLIENT's own retry delay
            // on top of that 10s hold compounded into a worst-case ~40-50s gap
            // before the next real attempt. The 10s server-side hold is
            // already a natural throttle; stay at the steady cadence so a
            // device that's merely slow gets polled again promptly instead of
            // being treated like a persistently degraded/gated path.
            // RETAIN the jar — a 'timeout' means the device is merely SLOW, not gone;
            // blanking it here was the founder's flicker. Note only when nothing yet.
            setCookiesNote(hasCookiesRef.current ? null : 'waiting for the device…');
          } else {
            // RETAIN the jar through a degraded/gated tick; note only when nothing yet.
            setCookiesNote(hasCookiesRef.current ? null : friendlyUnavailableNote(res.reason));
            backoff = Math.min(backoff * 2, 30000); // genuinely degraded → back off
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // getAgentSessionCookies throws (via authedFetch) on any non-2xx, with
          // the HTTP status attached to AgentSessionControlError. Branch on it so
          // the note reflects the real state instead of one blanket message:
          //   401/403 → the per-session gui_control_key expired (24h TTL) — manual
          //             control over LiveKit still works, so degrade calmly (mirrors
          //             refreshControl) instead of an endless "retrying" loop.
          //   404 → no cookie jar yet (no page has loaded in the session)
          //   503 → the cookies route is gated off on this deployment
          //   else (network / 5xx) → a transient hiccup we'll retry on the next tick
          const status = err instanceof AgentSessionControlError ? err.status : 0;
          // RETAIN the last-known jar through a transient/gated failure (never blank a
          // populated panel — the founder's "sometimes showing, sometimes not"). Show a
          // note only when there's nothing fetched yet; EXCEPT 401/403 (creds expired →
          // the jar can't refresh) which keeps its actionable note even over a stale jar.
          const note =
            status === 401 || status === 403
              ? 'Session control credential expired — reopen the session to refresh.'
              : status === 404
                ? 'cookies will appear once a page loads in the session'
                : status === 503
                  ? "cookies aren't enabled on this deployment"
                  : "couldn't load cookies — retrying";
          const credsExpired = status === 401 || status === 403;
          setCookiesNote(hasCookiesRef.current && !credsExpired ? null : note);
          backoff = Math.min(backoff * 2, 30000); // failure → back off
        })
        .finally(() => {
          if (cancelled) return; // a torn-down effect never reschedules
          handle = setTimeout(tick, backoff);
        });
    };
    tick();
    return () => {
      cancelled = true;
      if (handle !== null) clearTimeout(handle);
    };
  }, [cookiesPaneActive, sessionId, controlAuth, room, sessionEnded]);

  // File-control upload (A3 W2851 / founder "control files"). Upload a file's bytes
  // (base64) into the running session's isolated 0o700 jail → get an OPAQUE handle
  // the customer can hand to a page's <input type=file>. Upload-only here; the
  // file-chooser handle-pick DRIVE (when a page opens a chooser) is A3's next
  // harness piece, so we just collect handles for now.
  const [files, setFiles] = useState<SessionFileHandle[]>([]);
  const [uploadNote, setUploadNote] = useState<string | null>(null);
  // Reset the uploaded-handle list on every session swap (the standalone window can swap
  // the live session in place via the 'ds-session' relaunch listener, changing sessionId
  // WITHOUT a remount). The upload handles are bound to the OLD session's upload jail, so
  // they're meaningless/invalid for the new session — clear them (and the note) so the
  // Files pane doesn't list the prior session's stale handles. Mirrors how the cookies/
  // downloads polls self-heal by re-keying on sessionId.
  useEffect(() => {
    setFiles([]);
    setUploadNote(null);
  }, [sessionId]);
  const [uploading, setUploading] = useState(false);
  // Visual-only: highlight the drop-zone while a file is dragged over it.
  const [fileDragOver, setFileDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const onUploadFile = (file: File): void => {
    if (file.size > 64 * 1024 * 1024) {
      setUploadNote(`${file.name} is too large (max 64 MiB).`);
      return;
    }
    setUploading(true);
    setUploadNote(null);
    const reader = new FileReader();
    reader.onerror = (): void => {
      setUploading(false);
      setUploadNote('Could not read the file.');
    };
    reader.onload = (): void => {
      // readAsDataURL → "data:<mime>;base64,<b64>"; take the part after the comma.
      const dataUrl = typeof reader.result === 'string' ? reader.result : '';
      const dataB64 = dataUrl.slice(dataUrl.indexOf(',') + 1);
      // Capture the session this upload is FOR: a standalone-window session swap can
      // change `sessionId` in place during the (up to ~30s) request, so every result-write
      // below is guarded on it still being current — else the OLD session's handle/note
      // bleeds into the NEW session (audit 2026-07-08; same sessionIdRef guard the
      // cookies/downloads polls already use).
      const reqSessionId = sessionId;
      void uploadAgentSessionFile(
        reqSessionId,
        { name: file.name, mime: file.type || 'application/octet-stream', dataB64 },
        controlAuth,
      )
        .then((res) => {
          if (reqSessionId !== sessionIdRef.current) return; // session swapped — drop stale result
          const h = res.handle;
          if (res.status === 'ok' && h !== null) {
            setFiles((prev) => [h, ...prev]);
            // Finding #10 — confirm success instead of clearing the note (every failure
            // branch sets one; on a fast upload a silently-cleared note read as if the
            // click didn't register). Matches the cookie-import success copy.
            setUploadNote(`Uploaded ${file.name} — ready to attach to the page's file picker.`);
          } else if (res.status === 'unavailable') {
            // Honest (#73 twin): the upload path is LIVE; 'unavailable' = the session
            // isn't live on a node right now, not a future feature. `reason` carries
            // the precise server cause when present.
            setUploadNote(
              res.reason !== undefined
                ? `Can't upload right now: ${res.reason}`
                : "Can't upload — the session isn't live on a device right now.",
            );
          } else if (res.status === 'timeout') {
            setUploadNote("Upload timed out — the device didn't respond.");
          } else {
            setUploadNote(
              res.reason !== undefined ? `Upload failed: ${res.reason}` : 'Upload failed.',
            );
          }
        })
        .catch(() => {
          if (reqSessionId !== sessionIdRef.current) return; // session swapped — drop stale note
          // Gated 503 / 404 / network — a transient reachability gap, not a missing
          // feature. Retry by picking the file again once the session is reachable.
          setUploadNote("Couldn't upload — the device isn't reachable right now.");
        })
        .finally(() => {
          if (reqSessionId !== sessionIdRef.current) return; // new session owns its own uploading flag
          setUploading(false);
        });
    };
    reader.readAsDataURL(file);
  };

  // File-control DOWNLOAD (A3 W2856). Poll the session's download jar like cookies;
  // fetching one saves it to the user's machine via an <a download>. The jar is empty
  // until A3's fork download-delegate populates it → "No downloads yet".
  const [downloads, setDownloads] = useState<SessionDownloadEntry[] | null>(null);
  const [downloadsNote, setDownloadsNote] = useState<string | null>(null);
  // Twin of hasCookiesRef (#134) — audit wb1w3015f found the downloads poll had the
  // IDENTICAL flicker (blanked the list + the browser-bar count badge on every
  // timeout/gated/transient tick) but never got the cookies retention fix. Retain
  // the last-known list through transient states; the note shows only when nothing
  // has been fetched yet.
  const hasDownloadsRef = useRef(false);
  const [downloadingName, setDownloadingName] = useState<string | null>(null);
  // The browser-bar download indicator (GUI chrome — like the address bar; never
  // touches the rendered iPhone/fingerprint) shows a count badge whenever there are
  // downloads, so the poll must also run while it's visible (browser mode), not only
  // while the Downloads PANE is open. ONE poll feeds both — the indicator reuses this
  // same `downloads` state, no second fetch path.
  const downloadsPollActive = downloadsPaneActive || browserMode;
  useEffect(() => {
    // Approach B perf — poll while the Downloads pane is the active section OR the
    // browser-bar indicator is shown (browser mode); single shared interval. Cleanup
    // tears the interval down on switching away; switching back re-fires tick().
    if (!downloadsPollActive || sessionId === '' || room === null) return;
    // Finding #13 — stop polling once the session has terminally ended (consistency with
    // the cookies / page-state / terminal-end polls): the endpoint 404s forever on a dead
    // session. Keep the last fetched list frozen in view rather than churning the dead id.
    if (sessionEnded !== null) return;
    // Finding #5 — self-scheduling poll with exponential backoff (twin of the cookies
    // poll). The next tick is scheduled ONLY in .finally, so requests never overlap/
    // stack — the server holds a downloads request up to ~30s, so a fixed 3s interval
    // could pile ~10 in flight. backoff resets to 3s only on a TRUE 'ok'; a calm
    // timeout/pending or a failure doubles it (cap 30s) so a persistently gated path
    // stops hammering the control plane.
    let cancelled = false;
    let backoff = 3000;
    let handle: ReturnType<typeof setTimeout> | null = null;
    const tick = (): void => {
      void listAgentSessionDownloads(sessionId, controlAuth)
        .then((res) => {
          if (cancelled) return;
          if (res.status === 'ok') {
            const files = res.files ?? [];
            setDownloads(files);
            hasDownloadsRef.current = files.length > 0;
            setDownloadsNote(null);
            backoff = 3000; // reset cadence on a real success
          } else if (res.status === 'timeout') {
            // RETAIN the list — the server held the request ~30s for a merely-slow
            // device; blanking the panel + count badge on that soft status was the
            // (un-fixed) twin of the cookies flicker. Note only when nothing yet.
            setDownloadsNote(hasDownloadsRef.current ? null : 'waiting for the device…');
          } else {
            // RETAIN through a degraded/gated/WSS-reconnect (failAll) tick.
            setDownloadsNote(hasDownloadsRef.current ? null : friendlyUnavailableNote(res.reason));
            backoff = Math.min(backoff * 2, 30000); // genuinely degraded → back off
          }
        })
        .catch((err: unknown) => {
          if (cancelled) return;
          // Honest current-state copy (#73): the download list/fetch path IS live
          // (server route + harness wire shipped) — a failed poll is a transient
          // reachability gap, NOT a missing future feature. The OLD copy promised a
          // "next device update" that doesn't exist (mirrors the cookies-#58 stale
          // pending bug). Branch on the real HTTP status so the note reflects reality:
          //   401/403 → the per-session control key expired (24h TTL) → reopen.
          //   404 → the session is no longer live (a 404 is thrown only for a missing/
          //         inaccessible session; an EMPTY download jail returns 200 ok files:[],
          //         never a 404 — so "appear once a page saves" would be the wrong copy).
          //   503 → the downloads route is gated off on this deployment.
          //   else (network / 5xx) → a genuine transient gap we retry on the next tick.
          const status = err instanceof AgentSessionControlError ? err.status : 0;
          // RETAIN the last-known list through a transient/gated failure (never blank
          // a populated panel + count badge). Note only when nothing fetched yet;
          // EXCEPT 401/403 (creds expired → can't refresh) keeps its actionable note.
          const note =
            status === 401 || status === 403
              ? 'Session control credential expired — reopen the session to refresh.'
              : status === 404
                ? 'Session is no longer live.'
                : status === 503
                  ? "downloads aren't enabled on this deployment"
                  : "couldn't reach the device for downloads — retrying";
          const credsExpired = status === 401 || status === 403;
          setDownloadsNote(hasDownloadsRef.current && !credsExpired ? null : note);
          backoff = Math.min(backoff * 2, 30000); // failure → back off
        })
        .finally(() => {
          if (cancelled) return; // a torn-down effect never reschedules
          handle = setTimeout(tick, backoff);
        });
    };
    tick();
    return () => {
      cancelled = true;
      if (handle !== null) clearTimeout(handle);
    };
  }, [downloadsPollActive, sessionId, controlAuth, room, sessionEnded]);

  const onDownloadFile = (name: string): void => {
    setDownloadingName(name);
    setDownloadsNote(null);
    // Capture the session this fetch is FOR (session can swap in place during the up-to-30s
    // hold); guard every result-write — including the disk save — on it still being current,
    // so an old session's file/note never lands in a switched-to session (audit 2026-07-08).
    const reqSessionId = sessionId;
    void fetchAgentSessionDownload(reqSessionId, name, controlAuth)
      .then((res) => {
        if (reqSessionId !== sessionIdRef.current) return; // session swapped — drop stale result + save
        if (res.status === 'ok' && res.file !== null) {
          // base64 → bytes → Blob → the shared, Tauri-WKWebView-proven download helper.
          const f = res.file;
          try {
            const bin = atob(f.dataB64);
            const bytes = new Uint8Array(bin.length);
            for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
            // Finding #9 — chain the async write + report BOTH outcomes (consistent with
            // every other branch here). downloadBlob returns false when the Tauri fs
            // write fails (e.g. no $DOWNLOAD scope); the old voided promise swallowed it,
            // so the Save button gave no success confirmation AND no error on a silent
            // write failure — it read as a dead button.
            void downloadBlob(
              f.name,
              new Blob([bytes], { type: f.mime || 'application/octet-stream' }),
            )
              .then((ok) => {
                setDownloadsNote(
                  ok
                    ? `Saved ${f.name} to your Downloads folder.`
                    : "Couldn't save the file — check the app's file-access permission.",
                );
              })
              .catch(() => {
                setDownloadsNote('Could not save the file.');
              });
          } catch {
            setDownloadsNote('Could not save the file.');
          }
        } else if (res.status === 'unavailable') {
          // Honest (#73): the download path is live; 'unavailable' = the session isn't
          // live on a node right now (ended / node offline / control plane off), NOT a
          // future feature. `reason` carries the precise server cause when present.
          setDownloadsNote(
            res.reason !== undefined
              ? `Can't fetch the file right now: ${res.reason}`
              : "Can't fetch the file — the session isn't live on a device right now.",
          );
        } else if (res.status === 'timeout') {
          setDownloadsNote("Download timed out — the device didn't respond.");
        } else {
          setDownloadsNote(
            res.reason !== undefined ? `Download failed: ${res.reason}` : 'Download failed.',
          );
        }
      })
      .catch(() => {
        if (reqSessionId !== sessionIdRef.current) return; // session swapped — drop stale note
        setDownloadsNote("Couldn't fetch the file — the device isn't reachable right now.");
      })
      .finally(() => {
        if (reqSessionId !== sessionIdRef.current) return; // new session owns its own Save-button state
        setDownloadingName(null);
      });
  };

  // iOS TAP cursor (founder 2026-06-17: "standard is full control + iOS TAP
  // cursor"): a short-lived ring at the tap point, so a click on the screen
  // reads as a deliberate iOS touch. Capture-phase + purely visual (never
  // preventDefault/stopPropagation) so the real tap still reaches the device's
  // input-capture untouched.
  const screenHostRef = useRef<HTMLDivElement | null>(null);
  const tapIdRef = useRef(0);
  const [taps, setTaps] = useState<{ id: number; x: number; y: number }[]>([]);
  // True when the pointer is on a SIZED live video but maps OFF its object-contain
  // surface (a letterbox/pillarbox bar) — exactly where the wire's input-capture sends
  // nothing. Used to suppress the tap ripple + fingertip dot so the visual feedback
  // matches what the device receives. False (fall through, show the feedback) when the
  // video isn't mounted/sized yet — pointerToViewport returns null for an unsized rect
  // too, and the pre-stream ripple is harmless.
  const isOffVideoSurface = (e: ReactPointerEvent<HTMLDivElement>): boolean => {
    const video = videoElRef.current;
    if (video === null) return false;
    const vr = video.getBoundingClientRect();
    if (vr.width === 0 || vr.height === 0) return false; // not sized yet → don't suppress
    // Use the SAME per-archetype logical frame the wire uses (deviceLogicalRef →
    // useInputCapture), so the ripple/dot off-surface test matches what the device
    // actually receives on the dispatched archetype.
    return pointerToViewport(e.nativeEvent, video, deviceLogicalRef.current) === null;
  };
  const showTap = (e: ReactPointerEvent<HTMLDivElement>): void => {
    // Finding #6 — no tap feedback in AI mode. Input capture is off (the host is
    // interactive={controlMode !== 'ai'}), so the tap is never sent to the device; a
    // ripple/fingertip-press there would falsely signal "it worked" on a silent no-op
    // (the same confusion the off-surface guard below prevents). The taps.map render is
    // also gated on controlMode !== 'ai', but early-returning here avoids the wasted
    // touchPoint state churn too. (controlMode is a closure read — safe at call time.)
    if (controlMode === 'ai') return;
    const host = screenHostRef.current;
    if (host === null) return;
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (r.width === 0 || x < 0 || y < 0 || x > r.width || y > r.height) return;
    // Off-surface guard: gate the ripple/cursor on the SAME surface test the wire uses.
    // A click in the object-contain letterbox bars (or anywhere the device receives
    // nothing) returns null from pointerToViewport — render NO ripple/dot there, so the
    // visual feedback never signals success on a silent no-op (founder "taps near the
    // edge feel dropped"). Only suppress when the video is actually SIZED (a real rect);
    // an unmounted/unsized video also returns null and must fall through to the host
    // clamp (the ripple is harmless pre-stream).
    if (isOffVideoSurface(e)) return;
    // Press feedback for the touch-point cursor — it shrinks/brightens on press,
    // alongside the bloom ring below (resets on pointer up / leave). Position + press
    // are direct-DOM ref writes (no re-render); visibility flips only if not already shown.
    positionDot(x, y);
    setDotPressed(true);
    if (!dotVisible) setDotVisible(true);
    const id = (tapIdRef.current += 1);
    setTaps((cur) => [...cur, { id, x, y }]);
    window.setTimeout(() => {
      setTaps((cur) => cur.filter((t) => t.id !== id));
    }, 480);
  };
  // iOS touch-point cursor (founder 2026-06-18): over the SCREEN, hide the PC
  // arrow (cursor-none on the host) and show a soft fingertip dot that tracks the
  // pointer — so you read the device as a touchscreen, not a desktop window. It's
  // pointer-events-none (never intercepts the real tap) and pairs with the
  // press-time tap ripple above. The toolbar/bezel keep the normal arrow (you
  // need it for the window controls + dragging).
  // PERF (audit 2026-07-08, founder "not smooth / laggy during fast interaction"): the
  // dot's POSITION + PRESSED state are driven by DIRECT DOM writes through refs, NOT React
  // state, so a pointer-move over the screen mutates ONE element's style instead of
  // re-rendering this ~4500-line component 60-120×/sec. Only the dot's VISIBILITY is React
  // state (`dotVisible`), and it flips just on the show/hide TRANSITIONS (enter / leave /
  // crossing the off-surface boundary) — never per-move. So a continuous drag/hover inside
  // the video surface causes ZERO re-renders, while the mount stays conditional (the dot is
  // truly absent when hidden). On the hidden→shown re-render the element seeds its
  // position/press from the refs (both set before the transition), and any later re-render
  // for an unrelated reason re-derives the same position/press from those refs.
  const [dotVisible, setDotVisible] = useState(false);
  const touchDotRef = useRef<HTMLSpanElement | null>(null);
  const dotPosRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const dotPressedRef = useRef(false);
  const positionDot = (x: number, y: number): void => {
    dotPosRef.current = { x, y };
    const d = touchDotRef.current;
    if (d !== null) {
      d.style.left = `${x}px`;
      d.style.top = `${y}px`;
    }
  };
  const setDotPressed = (pressed: boolean): void => {
    dotPressedRef.current = pressed;
    touchDotRef.current?.classList.toggle('ds-touch-dot--pressed', pressed);
  };
  const moveTouchPoint = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const host = screenHostRef.current;
    if (host === null) return;
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (r.width === 0 || x < 0 || y < 0 || x > r.width || y > r.height) {
      if (dotVisible) setDotVisible(false);
      return;
    }
    // Hide the fingertip dot in the object-contain letterbox bars — the device receives
    // nothing there, so a touch cursor would falsely read as a live touch surface (same
    // surface test the wire uses). Keep the dot only where pointerToViewport is non-null.
    if (isOffVideoSurface(e)) {
      if (dotVisible) setDotVisible(false);
      return;
    }
    positionDot(x, y); // direct DOM write — no re-render on a continuous move
    if (!dotVisible) setDotVisible(true); // re-render ONLY on the hidden→shown transition
  };
  const hideTouchPoint = (): void => {
    if (dotVisible) setDotVisible(false);
    setDotPressed(false);
  };
  // Session control (founder 2026-06-18): Mode segmented control + contextual
  // takeover/handback + a "tell the agent" composer in the expandable panel.
  // SimulatorWindow has no SDK client → lib/agent-session-control raw-fetches
  // (reads {apiKey,baseUrl} via loadSettings). null mode = not loaded yet.
  const [controlMode, setControlMode] = useState<SessionMode | null>(null);
  // #6 — a fresh-reads mirror for the long-lived onData effect (deps [room, ...], so
  // it does NOT re-subscribe on every controlMode change): without this the
  // inputFocused→keyboard handler would close over a STALE mode and could pop the
  // keyboard for the agent's own typing after a manual↔AI switch mid-session.
  const controlModeRef = useRef(controlMode);
  useEffect(() => {
    controlModeRef.current = controlMode;
  }, [controlMode]);
  // Distinguishes a CONFIRMED mode (a successful getAgentSession round-trip) from
  // one DEFAULTED to 'manual' because the control HTTP API was unreachable (e.g.
  // the separate Simulator app reopened without its per-session control key). The
  // mode-aware close handler ends a session ONLY when the mode is a confirmed
  // 'manual' — an unconfirmed/defaulted 'manual' falls through to the non-manual
  // (hide-and-leave-running) path, so closing a window that COULDN'T verify it's
  // human-only never silently kills an agent session the founder meant to keep
  // running (audit; matches the documented "never silently kill a session we
  // can't confirm is human-only" intent). Reset to false on every session swap.
  const [controlModeConfirmed, setControlModeConfirmed] = useState(false);
  const [pairKind, setPairKind] = useState<string | null>(null);
  const [controlBusy, setControlBusy] = useState(false);
  const [composerText, setComposerText] = useState('');
  // CRITICAL session-switch reset. The relaunch listener swaps sessionId IN PLACE
  // (no remount — to keep the live Room), so per-session UI state would otherwise
  // carry over. Two real bugs that causes (audit wqhvarsb9): (1) a stale controlMode
  // ('manual' from the previous session) makes the mode-aware close handler
  // endAgentSession(NEW_sessionId) — DELETING the freshly-launched session; (2) the
  // browser bar shows the previous session's URL/loading until the new box reports.
  // Reset to a clean slate on every sessionId change (controlMode=null is the safe
  // non-manual default; refreshControl re-fetches the real mode right after).
  useEffect(() => {
    // Finalize any in-flight recording BEFORE the new session takes over — else the 1fps
    // loop keeps capturing the NEW session's screen into the OLD recording (cross-session
    // capture) and the Record dot reads OFF, stranding the user with no stop (audit #2).
    if (recordTimerRef.current !== null) {
      window.clearInterval(recordTimerRef.current);
      recordTimerRef.current = null;
    }
    if (activeRecIdRef.current !== null) {
      void stopRecording(activeRecIdRef.current).catch(() => {}); // never escalate to the fatal overlay
      activeRecIdRef.current = null;
    }
    setControlMode(null);
    setControlModeConfirmed(false);
    setPairKind(null);
    // P1a — a fresh/relaunched session starts NON-terminal; clear any prior
    // "Session ended" state so the new session's first frame isn't covered by the
    // old session's terminal overlay (in-place relaunch swaps sessionId without
    // remount, so this state would otherwise carry over).
    setSessionEnded(null);
    setLiveUrl('');
    setPageLoading(false);
    setLoadProgress(null);
    // A3 W2845 / audit pre-push (w83xq1aht): clear the frozen-renderer badge on a
    // per-session reset so a previous session's "stalled" overlay can't persist
    // over a NEW session's live frame after an in-place session swap.
    setPageStalled(false);
    setPageLoadStalled(null); // #135 — drop a prior session's load-stall advisory too
    // Clear any page-navigation error so a prior session's error overlay can't
    // persist over the new session's first frame (mirrors the pageStalled reset).
    setPageError(null);
    // audit wb1w3015f — RE-ARM the load-error gate on an in-place session swap. The
    // swap keeps the Room (no remount) so pageReachedLoadedRef persists from the OLD
    // session; if it stayed true, the NEW session's genuine first-page load failure
    // (bad proxy / dead start URL / DNS — box emits 'errored' before any 'loaded')
    // would be SUPPRESSED as a "late sub-resource error" → reads as a blank success.
    pageReachedLoadedRef.current = false;
    currentNavTargetRef.current = ''; // #135 — untrack; the new session's first box frame sets it
    // Drop the prior session's cookies/downloads so the new session doesn't briefly
    // render the OLD session's jar (the retain-refs would otherwise hold them through
    // the new session's first transient tick).
    setCookies(null);
    hasCookiesRef.current = false;
    setCookiesNote(null);
    setDownloads(null);
    hasDownloadsRef.current = false;
    setDownloadsNote(null);
    // Clear in-flight upload/download UI flags too (audit 2026-07-08): a swap while a
    // fetch/upload is mid-hold would otherwise leave the new session's Save buttons
    // disabled / the composer's "uploading" state stuck until the OLD request settles
    // (the guarded .finally above no longer clears them for a swapped-away request).
    setDownloadingName(null);
    setUploading(false);
    // Reset the per-session TAB model + title to a clean single-seed state. The
    // in-place relaunch swaps sessionId WITHOUT remounting (to keep the Room), so
    // tabs/activeTabId/liveTitle would otherwise carry the OLD session's tabs into
    // the new one (the new box has no knowledge of them → desynced strip; the
    // stale liveTitle then stamps onto the new first tab — audit). Mint a fresh
    // seed tab so there's always exactly one, and drop any pending optimistic
    // switches referencing the old tab ids.
    const seed: SimTab = { id: makeTabId(), url: '', scrollY: 0, title: '' };
    seedTabRef.current = seed;
    setTabs([seed]);
    setActiveTabId(seed.id);
    setLiveTitle('');
    pendingActivationsRef.current.clear();
    // Drop any in-flight switch re-issue timers + the affordance — they reference the
    // PRIOR session's tab ids.
    for (const r of activationRetryRef.current.values()) window.clearTimeout(r.timer);
    activationRetryRef.current.clear();
    setSwitchingTabId(null);
  }, [sessionId, stopRecording]);
  // Control-channel load state for the panel caption (founder 2026-06-18: the
  // mode toggle was stuck "Connecting…" forever when getAgentSession failed and
  // the error was swallowed). null = no error; a classified message = the last
  // getAgentSession failed and the panel should show a "controls unavailable —
  // Retry" state instead of a permanent "Connecting…".
  const [controlError, setControlError] = useState<string | null>(null);
  const clientIdRef = useRef<string>(
    typeof crypto !== 'undefined' && 'randomUUID' in crypto
      ? crypto.randomUUID()
      : `sim-${profileName || deviceName}`,
  );
  // One place classifies a control error into a short, human caption — used by
  // both the transient notice toast and the persistent panel "unavailable" state.
  const controlErrorMessage = (err: unknown): string =>
    err instanceof AgentSessionControlError
      ? err.kind === 'forbidden'
        ? "Your key can't control this session"
        : err.kind === 'conflict'
          ? 'Session is no longer active'
          : err.kind === 'auth_missing'
            ? 'Sign in to control the session'
            : err.message
      : 'Control request failed';
  const noticeControlError = (err: unknown): void => {
    setNotice(controlErrorMessage(err));
    window.setTimeout(() => setNotice(null), 4000);
  };
  // The LiveKit room handle, surfaced by the panel after a (re)connect. Wrap
  // setRoom so a fresh/reconnected room CLEARS the latched controlUnreachable
  // badge — the data channel is live again, so a stale "control may not be
  // reaching the device" warning from a prior failed publish must not persist
  // (it was set but previously never reset on recovery).
  const handleRoom = useCallback((r: Room | null): void => {
    setRoom(r);
    if (r !== null) setControlUnreachable(false);
  }, []);
  // Navigation (address bar / back-forward / reload) is enabled ONLY once the device is
  // actually live — the LiveKit room reports 'connected' AND a video track is publishing
  // — not the instant the Room object exists (room !== null fired during "connecting…",
  // so a URL typed then trickled a fake loading bar and silently did nothing). Mirrors
  // the box readiness the navigate actually needs.
  const canNavigate = connState === 'connected' && publisherState === 'publishing';
  // Keep the current session + busy state readable from late async callbacks so a
  // getAgentSession result can't apply to the WRONG session (in-place relaunch
  // swaps sessionId without remount) or clobber an in-flight mode mutation —
  // either would let a stale 'manual' mode make window-close wrongly END the
  // now-active agent session (adversarial review wza0t39g8 #2/#3).
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;
  const controlBusyRef = useRef(controlBusy);
  controlBusyRef.current = controlBusy;
  const refreshControl = useCallback((): void => {
    if (sessionId === '') return;
    const reqSessionId = sessionId; // epoch: the session this fetch is for
    setControlError(null); // clear any prior failure while this attempt is in flight
    void getAgentSession(sessionId, controlAuth)
      .then((s) => {
        // Drop a result that resolved after the window swapped to another session
        // OR while a mode mutation (onSetMode) is in flight — applying a stale mode
        // would clobber the optimistic/confirmed mutation and could make
        // window-close end the wrong session.
        if (reqSessionId !== sessionIdRef.current || controlBusyRef.current) return;
        setControlMode(s.mode);
        // The mode was actually fetched from the server — CONFIRMED. Only a
        // confirmed 'manual' lets window-close end the session (see the close
        // handler); a defaulted-to-manual (control unreachable) must not.
        setControlModeConfirmed(true);
        setPairKind(s.pairKind);
        // P1a — the SAME round-trip carries lifecycle liveness. A terminal status
        // (the worker browser closed / the session was destroyed/errored/reaped)
        // latches the "Session ended" state so the reconnect/freeze machinery
        // short-circuits. A non-terminal result is the normal case (don't touch
        // sessionEnded so a transient blip never clears a real terminal end).
        if (s.terminal) setSessionEnded({ reason: s.closedReason });
        // A successful control round-trip proves the session is reachable —
        // clear any stale "control may not be reaching the device" badge.
        setControlUnreachable(false);
      })
      .catch((err: unknown) => {
        if (reqSessionId !== sessionIdRef.current) return;
        // The control HTTP API is unreachable (e.g. the separate Simulator app's
        // per-session control key didn't reach this window). Manual control still
        // works over the LiveKit data channel, so DEFAULT to 'manual' + a soft note
        // rather than a blocking "controls unavailable — Retry" error (founder
        // 2026-06-23: "should just be on manual unless changed" + "I can control
        // manually just fine"). An explicit mode CHANGE that fails still surfaces
        // its own error via noticeControlError. The root key-handoff fix is tracked
        // separately; this keeps the panel usable meanwhile.
        setControlMode((prev) => prev ?? 'manual');
        setControlError(null);
        // Log for diagnostics without scaring the operator.
        console.warn('[simulator] control fetch failed; defaulting to manual:', err);
      });
  }, [sessionId, controlAuth]);
  // Seed on mount + re-read whenever a pane opens (cheap, no idle polling). Keys
  // off the open/closed boolean (not the whole activePane string) so switching
  // BETWEEN open panes doesn't needlessly re-fetch the control state.
  useEffect(() => {
    refreshControl();
  }, [refreshControl, paneOpen]);
  // #137 — crash breadcrumb for a simulator window that DIES without a clean close
  // (native WKWebView crash / force-kill — the founder's "the window closes itself").
  // A JS error paints the fatal overlay (window stays up) and an intentional close
  // runs teardown, so a window that just vanishes died below the JS layer. We heartbeat
  // a per-session marker while alive + clear it on teardown; the NEXT boot reports any
  // marker that went stale (its window vanished) into the persisted dev log. pagehide
  // is the belt for the window-close path where the React cleanup may not run before the
  // webview tears down; startSimulatorCrashMarker's stop() is idempotent so both fire safely.
  useEffect(() => {
    if (sessionId === '') return;
    const stop = startSimulatorCrashMarker(sessionId);
    const onPageHide = (): void => stop();
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      stop();
    };
  }, [sessionId]);
  // Closing the simulator window is MODE-AWARE (founder 2026-06-18): in MANUAL
  // mode the human IS the session, so closing the phone ENDS it (the worker
  // tears down the browser/fork — "close the phone → it really stops"). In
  // ai/pair (agent-driven) modes the agent keeps working in the background, so
  // closing just hides the window — the session keeps running and can be
  // reopened (the profile-row "Live view"). Unknown/null mode (controls never
  // loaded) AND a manual that was only DEFAULTED because the control API was
  // unreachable (controlModeConfirmed === false) are treated as NON-manual: never
  // silently kill a session we can't CONFIRM is human-only. Only a confirmed
  // manual (a successful getAgentSession / explicit mode set) ends on close.
  // Covers the toolbar close button (window.close fires this) AND the OS close.
  // The MANUAL path preventDefaults + races a 2s timeout so a slow/failed end can
  // never wedge the window open; destroy() then closes without re-firing.
  // controlMode + controlModeConfirmed are in the deps so the handler always sees
  // the current mode (the listener re-registers on a mode switch — same pattern as
  // controlAuth). Declared AFTER the control state so they're in scope.
  useEffect(() => {
    if (sessionId === '' || typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
      return;
    }
    let unlisten: (() => void) | undefined;
    let disposed = false;
    let closing = false;
    void (async () => {
      const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
      const win = getCurrentWebviewWindow();
      const stop = await win.onCloseRequested(async (event) => {
        if (closing) return;
        closing = true;
        // CONFIRMED manual → end the session before closing; agent-driven
        // (ai/pair), unknown, OR a manual that was only DEFAULTED because the
        // control API was unreachable → close immediately and leave the session
        // running. Requiring controlModeConfirmed here is the safety guard: a
        // window that couldn't verify the mode (reopened without its control key)
        // must NOT end what might be a live agent session on close (audit).
        if (controlMode === 'manual' && controlModeConfirmed) {
          event.preventDefault();
          try {
            await Promise.race([
              endAgentSession(sessionId, controlAuth),
              new Promise((resolve) => setTimeout(resolve, 2000)),
            ]);
          } catch {
            // Best-effort — the window MUST close even if the end call fails
            // (rejects, e.g. session already gone) or hangs (the 2s race wins).
          }
          // destroy() closes without re-firing onCloseRequested.
          await win.destroy();
        }
        // Non-manual: don't preventDefault — let the default close proceed; the
        // agent session keeps running in the background.
      });
      // If the effect was torn down before this async registration resolved, the
      // cleanup's unlisten?.() already ran as a no-op — unregister now so the
      // handler can't leak + accumulate (and later fire with a stale controlMode,
      // wrongly ending a session). Mirrors the onResized effect's disposed guard.
      if (disposed) stop();
      else unlisten = stop;
    })().catch(() => undefined); // window API unavailable (non-Tauri / mock) — no close handler
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [sessionId, controlAuth, controlMode, controlModeConfirmed]);
  // Dynamic macOS Dock icon (founder 2026-06-18: "the Dock should be the proxy
  // country's FLAG, with the profile name on it"). With a live session, set the
  // Dock icon to the proxy country's flag captioned with the profile name; with
  // no session (the standalone app launched empty) reset to the bundle icon.
  // Cleared on unmount so a closed simulator never leaves a stale icon on the
  // Dock. No-op outside Tauri/macOS — applyDockTile guards + swallows.
  useEffect(() => {
    void applyDockTile(sessionId !== '' ? countryCode : null, profileName);
    return () => {
      void applyDockTile(null, profileName);
    };
  }, [sessionId, countryCode, profileName]);
  const onSetMode = (target: SessionMode): void => {
    if (sessionId === '' || target === controlMode) return;
    const prev = controlMode;
    setControlMode(target); // optimistic
    setControlBusy(true);
    void setSessionMode(sessionId, target, controlAuth)
      .then((s) => {
        setControlMode(s.mode);
        // The founder explicitly set the mode and the server confirmed it — a
        // confirmed mode (so a deliberate switch to manual lets close end it).
        setControlModeConfirmed(true);
        setPairKind(s.pairKind);
      })
      .catch((err: unknown) => {
        setControlMode(prev); // revert on rejection
        noticeControlError(err);
      })
      .finally(() => setControlBusy(false));
  };
  const onTakeover = (): void => {
    if (sessionId === '') return;
    setControlBusy(true);
    void takeoverSession(sessionId, clientIdRef.current, controlAuth)
      .then((kind) => setPairKind(kind))
      .catch(noticeControlError)
      .finally(() => setControlBusy(false));
  };
  const onHandback = (): void => {
    if (sessionId === '') return;
    setControlBusy(true);
    void handbackSession(sessionId, controlAuth)
      .then((kind) => setPairKind(kind))
      .catch(noticeControlError)
      .finally(() => setControlBusy(false));
  };
  const onSendMessage = (): void => {
    const text = composerText.trim();
    if (sessionId === '' || text === '') return;
    setControlBusy(true);
    void sendAgentMessage(sessionId, text, controlAuth)
      .then(() => {
        setComposerText('');
        setNotice('Sent to agent');
        window.setTimeout(() => setNotice(null), 3000);
      })
      .catch(noticeControlError)
      .finally(() => setControlBusy(false));
  };
  // Explicit Stop/End (founder Track A) — END the agent session no matter the
  // mode (in ai/pair the OS-close only HIDES the window, leaving the session
  // running with no in-window way to truly stop it). Same end-session path
  // window-close uses (endAgentSession → DELETE /v1/agent-sessions/:id). On
  // success the window closes (the session is gone — nothing left to show);
  // a failure surfaces a notice and leaves the window open. `controlBusy`
  // gates it so a double-click can't double-DELETE.
  // Two-step confirm for the destructive End-session (provider-free — the Simulator window
  // has no ConfirmProvider). First click ARMS + asks; a second click within 4s ends. Ending
  // tears down the worker browser + fork with NO undo, and this rail icon sits next to
  // everyday controls, so a stray single click must not kill a live session (audit 2026-07-08,
  // mirrors RecordingsView's permanent-delete two-step).
  const [endArmed, setEndArmed] = useState(false);
  const endArmTimerRef = useRef<number | null>(null);
  const onEndSession = (): void => {
    if (sessionId === '' || controlBusy) return;
    if (!endArmed) {
      setEndArmed(true);
      setNotice('Click End again to end the session — this stops the device (no undo).');
      if (endArmTimerRef.current !== null) window.clearTimeout(endArmTimerRef.current);
      endArmTimerRef.current = window.setTimeout(() => {
        setEndArmed(false);
        setNotice(null);
      }, 4000);
      return;
    }
    if (endArmTimerRef.current !== null) window.clearTimeout(endArmTimerRef.current);
    setEndArmed(false);
    setControlBusy(true);
    // The session is ending either way — drop its persisted control key so the
    // 24h credential doesn't linger in localStorage + entries don't accumulate.
    clearPersistedControlKey(sessionId);
    void endAgentSession(sessionId, controlAuth)
      .then(() => {
        void withCurrentWindow((w) => w.destroy());
      })
      .catch(() => {
        // Control HTTP couldn't reach the server to DELETE the session (e.g. a
        // reopened window with no control key). Closing the window still ENDS the
        // session: dropping the LiveKit connection trips the worker-disconnect
        // reaper, which closes it on the box. So End-session does the right thing
        // even without control auth, instead of a dead "control request failed"
        // (founder 2026-06-23 "still cant end session"). Best-effort notice first.
        setNotice('Ending — closing the window (the session will stop on the box).');
        window.setTimeout(() => {
          void withCurrentWindow((w) => w.destroy());
        }, 600);
      })
      .finally(() => setControlBusy(false));
  };
  // Address-bar navigation (founder 2026-06-19: "can't press the URL bar"). The
  // fork's rendered URL bar is un-tappable chrome, so the GUI's own address bar
  // emits a `navigate` command on the SAME LiveKit data channel as taps (no
  // server route — it would 401 for the keychain-less app; A3 W2668). Normalize
  // to http(s) first (prepend https:// when scheme-less); a non-http(s) entry is
  // dropped here and the harness re-validates with the same allowlist + SSRF
  // rejection. No-op until the room is connected.
  // ── Browser-style page TABS (doc-150 item 4; locked A2↔A3 contract) ──────────
  // Fire-and-forget full-list publish to the harness; called on EVERY new / close /
  // switch / reorder so the harness reconciles its per-tab pages. No-op (the wire
  // payload is still computed) until the room connects. MUST .catch: the livekit
  // wrapper only swallows BENIGN teardown races, but a tab op landing mid-RECONNECT
  // rejects with "Publisher connection not set" / "could not establish Publisher
  // connection" (not benign-matched) → re-thrown into this `void` → the global
  // unhandledrejection backstop paints the fatal overlay over the borderless
  // window (the 2026-06-18 blank-black-box incident). A dropped tab-list push
  // during a reconnect is harmless — the next new/close/switch re-syncs the set.
  const emitTabList = useCallback(
    (nextTabs: SimTab[], nextActiveId: string): void => {
      if (room === null || sessionId === '') return;
      void sendTabListUpdate(room, {
        sessionId,
        tabs: nextTabs.map((t) => ({ id: t.id, url: t.url, scrollY: t.scrollY, title: t.title })),
        activeTabId: nextActiveId,
      }).catch(() => undefined);
    },
    [room, sessionId],
  );
  // Keep the forward-reference ref (consumed by writeTabPageState, declared above
  // the tab callbacks) pointing at the latest emitTabList so a box-sourced page_state
  // write can publish the reconciled list without a declaration-order cycle.
  useEffect(() => {
    emitTabListRef.current = emitTabList;
  }, [emitTabList]);
  // One-shot page-state pull (live-state accuracy refactor). Fired right after a tab
  // switch so the active tab reconciles from the box immediately rather than waiting
  // up to ~2s for the next poll tick. Same routing as the poll (tabId → that tab, else
  // active) AND the SAME grace gating: a tabId-less frame that resolves WITHIN the
  // switch grace window still reflects the PRIOR tab's page (the box hasn't re-reported
  // the switched page yet) — applying its url to the just-switched active tab is the
  // exact "2nd switch stays on the same url" clobber. So suppress the url for a
  // tabId-less in-grace result (the title still applies + self-heals); a tabId-bearing
  // frame routes precisely and is never suppressed. The HTTP round-trip resolves on a
  // macrotask AFTER the switch's activeTabIdRef commit, so the grace check must run at
  // RESOLVE time, not call time. Best-effort + guarded.
  const reconcilePageState = useCallback(async (): Promise<void> => {
    if (sessionId === '') return;
    try {
      const ps = await getAgentSessionPageState(sessionId, controlAuth);
      if (ps === null) return;
      const hasTabId = typeof ps.tabId === 'string' && ps.tabId !== '';
      const inGrace =
        Date.now() - lastSwitchAtRef.current < PAGE_STATE_GRACE_MS ||
        Date.now() - lastNavAtRef.current < PAGE_STATE_GRACE_MS;
      // #139-followup — suppress BOTH url + title for a tabId-less in-grace frame
      // (it carries the PRIOR tab's page); mirrors the poll path so a wrong title
      // can't leak onto the just-switched tab.
      const suppress = !hasTabId && inGrace;
      // Same switch-resolution gating as the poll: a tabId-less reconcile result that
      // lands inside the switch grace window reflects the PRIOR page and must NOT
      // resolve the switch (the box hasn't re-reported the switched page yet).
      const inSwitchGrace = Date.now() - lastSwitchAtRef.current < PAGE_STATE_GRACE_MS;
      writeTabPageState(
        {
          tabId: ps.tabId,
          url: suppress ? null : ps.url,
          title: suppress ? null : ps.title,
        },
        hasTabId || !inSwitchGrace,
      );
    } catch {
      /* best-effort reconcile — transient errors are non-fatal */
    }
  }, [sessionId, controlAuth, writeTabPageState]);
  useEffect(() => {
    reconcilePageStateRef.current = () => void reconcilePageState();
  }, [reconcilePageState]);
  // Patch the active tab's fields (url/title/scrollY) and re-publish the list. Used by
  // onNavigate to point the active tab at a just-submitted address (the OPTIMISTIC
  // local write — the box then becomes the authoritative writer via writeTabPageState).
  // A functional setState so it composes with concurrent updates; the list is emitted
  // from the SAME next state, only when something actually changed.
  const updateActiveTab = useCallback(
    (patch: Partial<Omit<SimTab, 'id'>>): void => {
      setTabs((prev) => {
        const next = prev.map((t) => (t.id === activeTabId ? { ...t, ...patch } : t));
        const changed = next.some((t, i) => t !== prev[i]);
        if (changed) emitTabList(next, activeTabId);
        return changed ? next : prev;
      });
    },
    [activeTabId, emitTabList],
  );
  // New tab — append a fresh tab pointed at the branded Driftstack new-tab page
  // (NEW_TAB_URL), activate it, publish. The box opens that page for the new tab
  // instead of a literally-empty about:blank (founder 2026-06-25); the operator
  // drives it onward via the address bar afterward. The stored url/title seed from
  // NEW_TAB_URL so the tab label + address bar read sensibly before the box reports.
  const onNewTab = useCallback((): void => {
    const tab: SimTab = { id: makeTabId(), url: NEW_TAB_URL, scrollY: 0, title: NEW_TAB_TITLE };
    const prevActive = activeTabId;
    setTabs((prev) => {
      const next = [...prev, tab];
      emitTabList(next, tab.id);
      return next;
    });
    setActiveTabId(tab.id);
    // Clear the prior tab's error overlay / loading bar / stalled badge so they don't
    // cover the fresh new tab (the new-tab page re-asserts its own loading state).
    resetPageChromeForSwitch();
    // Mark a switch so the ~2s poll's grace window suppresses a stale prior-tab url
    // landing on the fresh blank tab. liveUrl/liveTitle re-derive from the new active
    // tab automatically (the about:blank/'New Tab' record), so there's no manual
    // reset to do — and no stamp-back loop to carry the prior page onto the + tab.
    lastSwitchAtRef.current = Date.now();
    // ACTIVELY switch the box's published page to the new tab NOW. emitTabList above
    // is a state-only tabListUpdate that does NOT switch the published page (per the
    // A2↔A3 contract), so without this the box keeps publishing the PRIOR tab and the
    // founder sees the old page linger until the box happens to catch up (founder
    // 2026-07-02: "new tab keeps the old tab open until the new page loads"). Fire the
    // same activateTab path onActivateTab uses so the box starts loading NEW_TAB_URL
    // immediately + the GUI shows instant "switching…" feedback. Via the *Ref handles
    // because sendActivateAttempt / reconcilePageState are defined below this callback.
    if (room !== null) {
      setSwitchingTabId(tab.id);
      sendActivateAttemptRef.current({
        tabId: tab.id,
        prevTabId: prevActive,
        url: NEW_TAB_URL,
        scrollY: 0,
      });
      reconcilePageStateRef.current();
      window.setTimeout(() => {
        setSwitchingTabId((s) => (s === tab.id ? null : s));
      }, SWITCH_AFFORDANCE_TIMEOUT_MS);
    }
  }, [emitTabList, resetPageChromeForSwitch, activeTabId, room]);
  // Close a tab — remove it; if it was active, activate the nearest neighbor (prefer
  // the one to the left, else the right). NEVER drops below one tab (the close button
  // is hidden on the last tab too, but guard here as well).
  const onCloseTab = useCallback(
    (id: string): void => {
      // Cancel any in-flight switch retry for the tab being CLOSED so its ack-miss
      // timer can't re-issue activateTab for a tab that no longer exists (the box
      // would try to switch its published page to a removed tab). Same root cause
      // as the superseded-switch cancel in onActivateTab. (Fable GUI re-audit
      // 2026-07-02.)
      const closingRetry = activationRetryRef.current.get(id);
      if (closingRetry !== undefined) {
        window.clearTimeout(closingRetry.timer);
        activationRetryRef.current.delete(id);
      }
      // Whether the close moves focus to a neighbour (we closed the ACTIVE tab). Side
      // effects (grace-arm + chrome reset) run OUTSIDE the setTabs reducer to keep it pure.
      const closingActive = id === activeTabId;
      // Compute the neighbour we're focusing (deterministic from the current `tabs`) so we
      // can ask the box to ACTIVATE it — tabListUpdate is fire-and-forget state-only and
      // does NOT switch the published page (only activateTab does, per the A2↔A3 contract,
      // agent-tab-ops.ts). Without an activateTab the strip + address bar flip to the
      // neighbour but the BOX keeps publishing the just-closed tab's page → the founder's
      // "closed a tab and the content didn't change."
      let focusNeighbor: SimTab | undefined;
      if (closingActive) {
        const idx = tabs.findIndex((t) => t.id === id);
        const remaining = tabs.filter((t) => t.id !== id);
        if (idx !== -1 && remaining.length > 0) {
          focusNeighbor = remaining[Math.max(0, idx - 1)] ?? remaining[0];
        }
      }
      if (closingActive) {
        // Arm the switch grace window so the ~2s poll doesn't clobber the newly-active
        // neighbour's url with the just-closed tab's stale prior-page url (the box is
        // still publishing/reporting the old page for ~2s — the "2nd switch stays on the
        // same url" clobber, on the close path).
        lastSwitchAtRef.current = Date.now();
        // Clear the closed tab's error overlay / loading bar / stalled badge so they
        // don't bleed onto the neighbour the close focuses (the box re-asserts the
        // neighbour's real state on its next page_state).
        resetPageChromeForSwitch();
      }
      setTabs((prev) => {
        if (prev.length <= 1) return prev; // never go below one tab
        const idx = prev.findIndex((t) => t.id === id);
        if (idx === -1) return prev;
        const next = prev.filter((t) => t.id !== id);
        // Choosing the new active tab only matters if we closed the active one.
        // `next` is non-empty here (prev had >1 and we removed one); prefer the tab to
        // the left of the closed index, else the first remaining.
        let nextActive = activeTabId;
        if (closingActive) {
          const neighbor = next[Math.max(0, idx - 1)] ?? next[0];
          if (neighbor !== undefined) nextActive = neighbor.id;
        }
        emitTabList(next, nextActive);
        if (nextActive !== activeTabId) setActiveTabId(nextActive);
        return next;
      });
      // Tell the box to actually switch the published page to the focused neighbour
      // (correlated activateTab, re-issued on a missed ack like a normal switch). Done
      // OUTSIDE the reducer (keep it pure); guarded on a real neighbour + a connected
      // room. A blank/seed neighbour stores url='' which the box's navigate allowlist
      // rejects → send the branded new-tab url instead (mirrors onActivateTab).
      if (closingActive && focusNeighbor !== undefined && room !== null) {
        const activateUrl = isBlankTabUrl(focusNeighbor.url) ? NEW_TAB_URL : focusNeighbor.url;
        setSwitchingTabId(focusNeighbor.id);
        // Via the ref (sendActivateAttempt is declared below; the ref is stable + the
        // handler runs post-render, so .current is always the latest).
        sendActivateAttemptRef.current({
          tabId: focusNeighbor.id,
          prevTabId: id,
          url: activateUrl,
          scrollY: focusNeighbor.scrollY,
        });
        window.setTimeout(() => {
          setSwitchingTabId((s) => (s === focusNeighbor?.id ? null : s));
        }, SWITCH_AFFORDANCE_TIMEOUT_MS);
      }
    },
    [activeTabId, emitTabList, resetPageChromeForSwitch, room, tabs],
  );
  // Send a single activateTab attempt for a switch + arm the ack-miss re-issue timer
  // (founder 2026-06-25 softer "could not switch tab" handling). On a missed ack the
  // timer fires: while attempts remain it RE-SENDS activateTab (short backoff); once
  // exhausted it gives up SOFTLY — a brief non-blocking notice, never an alert, and
  // the optimistic switch is left in a sensible state (we keep the operator on the
  // tab they tapped rather than yanking them back on a mere dropped-ack). A real
  // reject (activateTabResult{ok:false}) still reverts via onData. resolveSwitch
  // (box page-state / ack) cancels the timer so a healthy switch never retries.
  const sendActivateAttempt = useCallback(
    (ctx: { tabId: string; prevTabId: string; url: string; scrollY: number }): void => {
      if (room === null) return;
      void sendActivateTab(room, {
        sessionId,
        tabId: ctx.tabId,
        url: ctx.url,
        scrollY: ctx.scrollY,
      }).then(
        (requestId) => {
          pendingActivationsRef.current.set(requestId, {
            tabId: ctx.tabId,
            prevTabId: ctx.prevTabId,
          });
        },
        () => {
          /* benign teardown — swallowed in the wrapper; nothing to track */
        },
      );
      const existing = activationRetryRef.current.get(ctx.tabId);
      const attempts = (existing?.attempts ?? 0) + 1;
      if (existing !== undefined) window.clearTimeout(existing.timer);
      const timer = window.setTimeout(() => {
        const cur = activationRetryRef.current.get(ctx.tabId);
        if (cur === undefined) return; // resolved (ack / page-state) — nothing to do
        if (cur.attempts < ACTIVATE_MAX_ATTEMPTS) {
          sendActivateAttemptRef.current(ctx); // re-issue on the missed ack
        } else {
          // Exhausted — give up softly. Clear the affordance + retry record; leave the
          // operator on the tab they tapped (a dropped ack ≠ a reject). A gentle toast.
          activationRetryRef.current.delete(ctx.tabId);
          // Also drop this tab's now-orphaned pending-activation entries (keyed by
          // requestId): we've stopped retrying, so their acks will never resolve, and
          // otherwise only a relaunch/restore/unmount clears them — a slow bounded Map
          // leak on a lossy channel (audit #4, 2026-07-08).
          for (const [rid, p] of pendingActivationsRef.current) {
            if (p.tabId === ctx.tabId) pendingActivationsRef.current.delete(rid);
          }
          setSwitchingTabId((s) => (s === ctx.tabId ? null : s));
          setNotice('Still switching tabs…');
          window.setTimeout(() => setNotice(null), 3000);
        }
      }, ACTIVATE_ACK_TIMEOUT_MS);
      activationRetryRef.current.set(ctx.tabId, {
        tabId: ctx.tabId,
        prevTabId: ctx.prevTabId,
        attempts,
        timer,
      });
    },
    [room, sessionId],
  );
  // Stable self-reference so the setTimeout closure always re-issues via the latest
  // sendActivateAttempt (it captures room/sessionId) without a forward-ref cycle.
  const sendActivateAttemptRef = useRef(sendActivateAttempt);
  useEffect(() => {
    sendActivateAttemptRef.current = sendActivateAttempt;
  }, [sendActivateAttempt]);
  // Switch tabs — set active, OPTIMISTICALLY switch (the address bar + viewport follow
  // immediately) + show a subtle "switching…" affordance on the target tab, then ask
  // the harness to publish that tab's page via activateTab (correlated by requestId,
  // re-issued on a missed ack — see sendActivateAttempt) and re-publish the list. A
  // reject reverts + notifies; a dropped ack retries then soft-fails (see onData).
  const onActivateTab = useCallback(
    (id: string): void => {
      const target = tabs.find((t) => t.id === id);
      if (target === undefined || id === activeTabId) return;
      const prevActive = activeTabId;
      // SUPERSEDE any in-flight switch to a DIFFERENT tab: cancel its ack-miss
      // retry timer so a stale timer can't later re-issue activateTab for the
      // abandoned tab. Without this, tapping B then quickly C left B's 1200ms
      // retry armed; if B's ack lagged past that window the timer re-activated B
      // on the box — swinging the published video BACK to B while the GUI shows C
      // (video/GUI desync), and the next tabId-less poll then wrote B's url onto
      // tab C (corrupting the active tab's stored URL). resolveSwitch's own doc
      // says it's called "when a newer switch supersedes it" — this wires that.
      // (Fable GUI re-audit 2026-07-02.)
      for (const [tid, r] of activationRetryRef.current) {
        if (tid !== id) {
          window.clearTimeout(r.timer);
          activationRetryRef.current.delete(tid);
          // Prune the superseded tab's pending-activation entries too (audit #4) — a late
          // ack for a pruned requestId is a safe no-op (the ack handler guards on presence).
          for (const [rid, p] of pendingActivationsRef.current) {
            if (p.tabId === tid) pendingActivationsRef.current.delete(rid);
          }
        }
      }
      // Mark the switch BEFORE flipping active so the ~2s poll's grace window is
      // armed for the moment the activeTabId changes — without it a poll tick that
      // already carries the PRIOR tab's url (no tabId) would clobber the just-
      // switched active tab's url back to the old page (the founder's "2nd switch
      // stays on the same url" bug). liveUrl/liveTitle re-derive from the target
      // tab's OWN stored url/title via the derived effect below — NO stamp-back.
      lastSwitchAtRef.current = Date.now();
      // Clear the prior tab's error overlay / loading bar / stalled badge so they don't
      // bleed onto the newly-active tab (and so "Try again" can't re-navigate the wrong
      // tab). The box's next page_state for the now-active tab re-asserts the real state.
      resetPageChromeForSwitch();
      setActiveTabId(id);
      // INSTANT feedback — show "switching…" on the target tab immediately (real
      // speed is A3's box-side no-reload). Cleared when the box reports the tab's
      // page (resolveSwitch via writeTabPageState / ack), or the hard timeout below.
      setSwitchingTabId(id);
      emitTabList(tabs, id);
      if (room !== null) {
        // A blank/seed tab stores url='' (or about:blank); the box's navigate
        // allowlist REJECTS an empty url → "Could not switch tab". Send the
        // branded new-tab url instead so the box accepts the activate and the
        // tab still reads as blank (isBlankTabUrl normalizes NEW_TAB_URL back to
        // "New Tab" in the bar). Non-blank tabs send their real url unchanged.
        const activateUrl = isBlankTabUrl(target.url) ? NEW_TAB_URL : target.url;
        sendActivateAttempt({
          tabId: id,
          prevTabId: prevActive,
          url: activateUrl,
          scrollY: target.scrollY,
        });
        // One-shot reconcile: pull the box's current page-state immediately so the
        // active tab refreshes from the device without waiting for the next ~2s poll
        // tick. void it (no floating promise) — best-effort, transient errors ignored.
        void reconcilePageState();
        // Hard safety net: never let the "switching…" affordance hang on the tab even
        // if both the ack AND the page-state for it are dropped.
        window.setTimeout(() => {
          setSwitchingTabId((s) => (s === id ? null : s));
        }, SWITCH_AFFORDANCE_TIMEOUT_MS);
      } else {
        // No control channel yet — nothing to ack the switch; don't strand the
        // affordance (it would otherwise spin forever with no box to clear it).
        setSwitchingTabId(null);
      }
    },
    [
      tabs,
      activeTabId,
      emitTabList,
      room,
      sendActivateAttempt,
      reconcilePageState,
      resetPageChromeForSwitch,
    ],
  );
  // DERIVE the address-bar view (liveUrl/liveTitle) from the ACTIVE tab's stored
  // url/title (live-state accuracy refactor). This REPLACES the old stamp-back sync
  // effect that wrote liveUrl/liveTitle INTO the active tab — the inverted loop that
  // converged every tab onto one url. Now the box (via writeTabPageState) is the sole
  // writer of tab storage; this effect is read-only on tabs and only mirrors the
  // active tab outward for the BrowserBar + window title. Re-runs whenever the active
  // tab's record OR which tab is active changes.
  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeTabUrl = activeTab?.url ?? '';
  const activeTabTitle = activeTab?.title ?? '';
  useEffect(() => {
    // A blank/new tab reads as a CLEAN empty address bar — the branded new-tab url
    // (the served /newtab/ page) is chrome, not a destination the operator typed, so
    // don't surface it in the bar (founder 2026-06-25: a fresh tab should look blank,
    // not show driftstack.dev/newtab/). Any real page url flows through verbatim.
    setLiveUrl(isBlankTabUrl(activeTabUrl) ? '' : activeTabUrl);
    // A blank/new tab's title is chrome, not a real page title — don't surface it as
    // the window title; leave liveTitle empty so the title falls back to the device
    // name (matches the tab-label rule). Covers both the seeded 'New Tab' placeholder
    // and the box-reported branded page <title> ('New Tab · Driftstack').
    setLiveTitle(isBlankTabUrl(activeTabUrl) || activeTabTitle === 'New Tab' ? '' : activeTabTitle);
    // Re-derive whenever the active tab's stored url/title changes (a box page_state
    // write) or which tab is active changes (a switch reads the new tab's own values).
  }, [activeTabUrl, activeTabTitle]);
  // Reflect the live page title in the OS window title in REALTIME (founder pain #2:
  // "browser title doesn't update on a new page"). The derived liveTitle now flows
  // from the active tab's box-sourced title on EVERY title-bearing frame — not just
  // a load-commit — so this updates as the page's <title> changes. Fall back to the
  // page host, then the device/profile name, so the window is never untitled. No-op
  // outside Tauri (jsdom tests) via withCurrentWindow's guard.
  useEffect(() => {
    const base = profileName !== '' ? profileName : deviceName;
    let host = '';
    if (!isBlankTabUrl(liveUrl)) {
      try {
        host = new URL(liveUrl).host;
      } catch {
        /* not a parseable URL — leave host empty, fall back to the base name */
      }
    }
    const page = liveTitle !== '' ? liveTitle : host;
    const title = page !== '' ? `${page} — ${base}` : base;
    void withCurrentWindow((w) => w.setTitle(title));
  }, [liveTitle, liveUrl, deviceName, profileName]);
  const onNavigate = (raw: string): void => {
    if (room === null) return;
    // Omnibox behaviour: a URL navigates, anything else becomes a web search —
    // null only for empty input or a rejected dangerous scheme.
    const url = resolveAddressBarInput(raw);
    if (url === null) {
      setNotice('Enter an address or a search term');
      window.setTimeout(() => setNotice(null), 3000);
      return;
    }
    // A fresh navigate supersedes a prior failed-send banner (incl. our own Retry).
    setNavSendFailed(null);
    // First successful navigate: stop auto-opening the Controls pane on launch
    // (the Address bar has been discovered + used). See the activePane lazy init.
    try {
      localStorage.setItem('ds-sim-navigated', '1');
    } catch {
      /* private mode / storage disabled — harmless, panel just keeps advertising */
    }
    // Optimistic loading state for the browser bar. If the harness emits
    // page_state it overrides this (and clears it on {loading:false}); otherwise
    // the watchdog clears the sweep so it never spins forever.
    setLiveUrl(url);
    setPageLoading(true);
    setLoadProgress(null);
    // The navigate happens in the ACTIVE tab — point its url at the new address +
    // re-send the full list so the harness's per-tab page tracks the address bar
    // (the title follows via page_state). updateActiveTab emits tabListUpdate itself.
    updateActiveTab({ url });
    // An operator navigate optimistically clears the frozen-renderer badge — the
    // page is being driven again; the box re-asserts 'stalled' if it's still frozen.
    setPageStalled(false);
    // #135 — same for the load-stall advisory: a fresh navigate (incl. our own Retry)
    // supersedes it; the box re-emits the timeout stall if THIS load also runs long.
    setPageLoadStalled(null);
    // W616 — a fresh navigate clears any stale page-error overlay; the box
    // re-asserts 'errored' if THIS navigation also fails.
    setPageError(null);
    // #72 — a NEW top-level navigation re-arms the error gate: until this navigation
    // reaches 'loaded', an 'errored' frame is a real failure worth the overlay (after
    // it loads, a later 'errored' is a sub-resource failure and stays suppressed).
    pageReachedLoadedRef.current = false;
    // #135 — this typed url is the new current nav target; a stale 'errored' for the
    // page we just left will no longer match → no false "PAGE FAILED TO LOAD".
    currentNavTargetRef.current = normalizeNavUrl(url);
    lastNavAtRef.current = Date.now();
    clearLoadWatchdog();
    loadWatchdogRef.current = window.setTimeout(() => {
      setPageLoading(false);
      loadWatchdogRef.current = null;
    }, 6000);
    void sendNavigate(room, url).catch(() => {
      // Persistent + actionable rather than a 3s auto-toast — the send can fail on a
      // congested/dropped data channel and the user should be able to Retry (M5).
      setNavSendFailed(url);
      setPageLoading(false);
      clearLoadWatchdog();
    });
  };
  // Sim back/forward (A3 W2870) — steps the device's browser history one entry over
  // the control plane (HTTP, unlike navigate which rides the LiveKit data channel; the
  // history route correlates a navigateHistory → navigateHistoryResult round-trip).
  // Wired to BrowserBar's gated buttons (BACK_FORWARD_ENABLED, flag-off until A3's
  // daemon handler lands). No-op until the room is connected.
  const onHistory = (direction: 'back' | 'forward'): void => {
    if (room === null || sessionId === '') return;
    // #72 — back/forward is a fresh top-level navigation: re-arm the error gate (and
    // grace window) so an 'errored' on the navigated-to page can surface, while a late
    // sub-resource error after it loads stays suppressed. Clear any stale overlay too.
    setPageError(null);
    pageReachedLoadedRef.current = false;
    // #135 — history nav's target is box-determined; untrack, the box's next 'loading'
    // frame for the resulting page sets it.
    currentNavTargetRef.current = '';
    lastNavAtRef.current = Date.now();
    // Finding #2 — back/forward is enabled (BACK_FORWARD_ENABLED) but gave zero loading
    // feedback, so a click read as a dead button (and a cached/instant step never lit
    // the bar at all). Mirror onNavigate's optimistic affordance: light the loading bar
    // immediately + arm the shared watchdog so it self-clears if the box's history step
    // produces no page_state (e.g. a cached step the box doesn't report as 'loading').
    setPageLoading(true);
    setLoadProgress(null);
    setPageStalled(false);
    armLoadWatchdog();
    void navigateAgentSessionHistory(sessionId, direction, controlAuth).catch(() => {
      setNotice(`Could not go ${direction}`);
      window.setTimeout(() => setNotice(null), 3000);
      setPageLoading(false);
      clearLoadWatchdog();
    });
  };
  const togglePinned = (): void => {
    const next = !pinned;
    setPinned(next);
    void withCurrentWindow((w) => w.setAlwaysOnTop(next));
  };
  // Resize-to-archetype runs ONCE per window (first real video dimensions) so
  // it never fights the user's manual resize or the rotate toggle.
  const sizedToStreamRef = useRef(false);
  // …but a DIFFERENT session streaming into the SAME window (in-place relaunch)
  // must re-fit: clear the once-guard when the LiveKit join info changes, else a
  // different-aspect archetype keeps the prior window shape + letterboxes (audit S5).
  useEffect(() => {
    sizedToStreamRef.current = false;
    // A3 W3005 — a new session re-negotiates its archetype dims; drop the latch so the
    // box's fresh page_state dims (or the track fallback) re-own the touch space.
    hasPageStateDimsRef.current = false;
    // Re-seed the touch logical frame to the launch archetype until the NEW session's
    // first full-res frame reports its per-archetype dims (mirrors sizedToStreamRef).
    setInputLogical({ width: 402, height: 874 });
    // P1b — re-seed the panel content aspect too, so a new session's first frame
    // re-adopts ITS true content aspect (a different archetype must not keep the
    // prior box aspect → letterbox).
    setContentAspect(402 / 874);
  }, [info?.ws_url, info?.token]);

  // The stream reported its REAL pixel dimensions (the archetype's screen
  // resolution): resize the window so the frame matches the device's true
  // proportions — width stays put (no jump under the cursor), height derives
  // from the aspect + the fixed chrome (toolbar / bezel / status strip).
  // Works for ANY archetype — nothing per-device hardcoded.
  const handleVideoDimensions = (w: number, h: number): void => {
    if (w <= 0 || h <= 0) return;
    const isFirstFrame = !sizedToStreamRef.current;
    // After the first frame the host is sized to the first-frame aspect, but the live
    // steady-state intrinsic can settle to a DIFFERENT aspect (the content-only frame
    // arrives a beat later, e.g. first 393×790 ≈ 0.497 then steady 268×452 ≈ 0.593). If
    // the host keeps the stale aspect the wider live content letterboxes inside it → the
    // founder's TOP/BOTTOM black band. So TRACK the live aspect: re-fit whenever it moves
    // beyond the threshold. Thrash-guard: the SFU downscales the encoded track under
    // bandwidth (268×452 → smaller) PRESERVING the aspect — shouldRefitForAspectChange
    // returns false for those, so a pure resolution change never re-fits the window.
    const aspectChanged =
      !isFirstFrame && shouldRefitForAspectChange(deviceAspectRef.current, w, h);
    if (!isFirstFrame && !aspectChanged) return;
    sizedToStreamRef.current = true;
    deviceAspectRef.current = w / h;
    // P1b — adopt the LIVE content aspect for the panel box so the <video> fills the
    // screen-host edge-to-edge (no bottom-black letterbox). Same value that drives the
    // window-sizing math below, so box == host == video.
    setContentAspect(w / h);
    // FALLBACK touch-coordinate space ONLY. The box's page_state now delivers the
    // FIXED per-archetype logical content dims (A3 W3005) which OWN the touch space —
    // see the page_state reader's hasPageStateDimsRef latch above. Until the first
    // page_state frame carrying dims arrives, derive a provisional space from the
    // captured-frame dims (A3's 2026-06-29 inner_height capture makes the track ≈ the
    // content viewport, e.g. 402×714) so very-early taps aren't wildly off. Once the
    // latch is set the fixed page_state dims win and this never overrides them — the
    // encoded track downscales under bandwidth (268×476 / 300×654 observed) and is
    // unreliable for tap coords (A3 W2811 / W3004). Set ONLY on the FIRST frame: a later
    // aspect-track re-fit must NOT touch the touch space (it's decoupled from the video
    // aspect — the fixed page_state dims own it, and the first-frame fallback already
    // seeded it; re-seeding from a downscaled later frame would drift taps).
    if (isFirstFrame && !hasPageStateDimsRef.current) {
      setInputLogical({
        width: Math.round(w),
        height: Math.round(h),
      });
    }
    // Fit to the real device aspect + the current chrome, in EITHER orientation —
    // fitWindow's sizingAspect inverts for landscape. The old early-return on landscape
    // dropped the aspect entirely → the window stayed at the seeded 402/874 and letterboxed
    // permanently (audit #4: landscape-at-first-frame / in-place relaunch while rotated).
    // Runs on the first frame AND on a real later aspect change (rare, thrash-guarded above).
    fitWindow(browserMode);
  };

  // Rotate: swap the window's width/height so the bezel reflows to the new
  // orientation (the screen object-contains, so the video re-letterboxes). The
  // device-side orientation change is a harness follow-up; this is the window/
  // frame rotate. No-op outside Tauri.
  const toggleRotate = (): void => {
    const next = !landscape;
    setLandscape(next);
    // Size to the NEW orientation via the landscape-aware sizer (resetToActualSize re-adds
    // the always-docked rail's drawerExtra HORIZONTALLY + chrome VERTICALLY + clamps to the
    // screen work area) instead of naively transposing the whole window. The old transpose
    // (setSize(lh, lw)) folded the horizontal rail/pane width into the vertical height basis
    // and dropped chrome → an oversized landscape window (badly so with a pane open) and no
    // screen clamp. Set landscapeRef now so the sizer reads the new orientation immediately
    // (not next render).
    landscapeRef.current = next;
    resetToActualSize();
  };

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      {info === null ? (
        // Standalone empty state — shown when this window opens without a
        // session (e.g. the separate Driftstack Simulator app launched from the
        // Dock with nothing streaming yet). Branded + actionable, not a bare line.
        // The window is BORDERLESS + transparent, so this is an OPAQUE rounded
        // card (the desktop must not bleed through) that is itself a window
        // drag-region (no title bar to grab) with its own close affordance.
        <div
          data-tauri-drag-region
          data-component="simulator-empty"
          className="relative flex flex-col items-center gap-3 rounded-3xl bg-[#1d1e24] p-8 text-center ring-1 ring-white/10"
        >
          <button
            type="button"
            aria-label="Close"
            title="Close"
            data-tauri-drag-region="false"
            onClick={() => void withCurrentWindow((w) => w.close())}
            className="absolute left-4 top-4 h-3 w-3 rounded-full bg-[#ff5f57] shadow-[inset_0_0.5px_0_rgba(255,255,255,0.4)] ring-1 ring-black/20 transition hover:brightness-110"
          />
          <div className="scale-[2.4]" aria-hidden="true">
            <DriftMark />
          </div>
          <p className="mt-2 text-sm font-medium text-white/85">No session yet</p>
          <p className="max-w-[16rem] text-xs leading-relaxed text-white/45">
            Launch a profile in Driftstack to stream a real iPhone here.
          </p>
        </div>
      ) : (
        <div data-component="simulator-shell" className="flex h-full w-full flex-col">
          <DeviceToolbar
            deviceName={deviceName}
            profileName={profileName}
            // P1a — the green pulsing "Live" indicator must clear the instant the
            // session TERMINALLY ends, matching the "Session ended" overlay the panel
            // renders. sessionId stays non-empty after a terminal end (it isn't cleared
            // until a fresh session swaps in), so gate on the sessionEnded latch too —
            // otherwise the toolbar reads "Live" while the screen says the session
            // stopped (the exact "running after the browser closed" confusion).
            running={
              sessionId !== '' &&
              sessionEnded === null &&
              connState === 'connected' &&
              publisherState === 'publishing'
            }
            connecting={
              sessionId !== '' &&
              sessionEnded === null &&
              !(connState === 'connected' && publisherState === 'publishing')
            }
            keyboardVisible={keyboardVisible}
            onToggleKeyboard={toggleKeyboard}
            inputEnabled={controlMode !== 'ai'}
          />
          {/* Browser-style page TAB strip (doc-150 item 4) — full-width row between
              the toolbar and the address bar, gated on browserMode exactly like the
              BrowserBar below. OUTSIDE simulator-screen (the fingerprint-safe video
              area): the rendered 402×714 viewport is unchanged. Its TAB_STRIP_H is in
              the chrome height at all four window-sizing sites. */}
          {browserMode && (
            <TabStrip
              tabs={tabs}
              activeTabId={activeTabId}
              switchingTabId={switchingTabId}
              onActivate={onActivateTab}
              onClose={onCloseTab}
              onNew={onNewTab}
            />
          )}
          {browserMode && (
            <BrowserBar
              canNavigate={canNavigate}
              onNavigate={onNavigate}
              onHistory={onHistory}
              liveUrl={liveUrl}
              pageLoading={pageLoading}
              loadProgress={loadProgress}
              downloadCount={downloads?.length ?? 0}
              onOpenDownloads={() => openPane('downloads')}
            />
          )}
          {/* Option B body — the device and (when the drawer is open) the wide
              right control rail, side by side. The toolbar + browser bar stay
              full-width above; the window-sizing math keeps device width = window −
              drawer, so the drawer never letterboxes the phone. */}
          <div data-component="simulator-body" className="flex min-h-0 w-full flex-1 flex-row">
            {/* Device body — the bezel. data-tauri-drag-region makes the frame a
              window-drag handle; the inner screen overrides it so taps reach the
              device. flex-1 fills the width left of the drawer. */}
            <div
              data-tauri-drag-region
              data-component="simulator-device"
              className="relative flex min-h-0 min-w-0 flex-1 flex-col rounded-b-[2.75rem] bg-gradient-to-b from-[#1b1c20] via-[#0d0e11] to-[#08090b] p-[10px] shadow-2xl ring-1 ring-white/[0.12]"
            >
              {/* Screen — status strip on top (with the dynamic island), the live
                video BELOW it (never overlapped). NOT a drag region except the
                strip itself (taps on the video control the device). */}
              <div
                data-tauri-drag-region="false"
                data-component="simulator-screen"
                className="relative flex flex-1 flex-col overflow-hidden rounded-[2.1rem] bg-black shadow-[inset_0_0_0_1px_rgba(0,0,0,0.9),inset_0_0_12px_rgba(0,0,0,0.55)]"
              >
                <IosStatusBar />
                {notice !== null && (
                  <div
                    role="status"
                    className="absolute left-1/2 top-12 z-20 max-w-[min(90%,26rem)] -translate-x-1/2 rounded-lg bg-black/90 px-3.5 py-2 text-center text-[13px] font-medium leading-snug text-white shadow-lg ring-1 ring-white/20 backdrop-blur"
                  >
                    {notice}
                  </div>
                )}
                {navSendFailed !== null && (
                  <div
                    role="alert"
                    className="absolute left-1/2 top-12 z-20 flex max-w-[min(90%,26rem)] -translate-x-1/2 items-center gap-2 rounded-lg bg-black/90 px-3.5 py-2 text-[13px] font-medium leading-snug text-white shadow-lg ring-1 ring-status-error/50 backdrop-blur"
                  >
                    <span className="min-w-0 flex-1">Couldn&apos;t send that to the device.</span>
                    <button
                      type="button"
                      onClick={() => onNavigate(navSendFailed)}
                      className="shrink-0 rounded bg-white/15 px-2 py-0.5 text-xs hover:bg-white/25"
                    >
                      Retry
                    </button>
                    <button
                      type="button"
                      aria-label="Dismiss"
                      onClick={() => setNavSendFailed(null)}
                      className="shrink-0 text-white/50 hover:text-white/90"
                    >
                      ✕
                    </button>
                  </div>
                )}
                {controlUnreachable && (
                  <div
                    role="status"
                    data-component="control-unreachable-badge"
                    className="absolute left-1/2 top-20 z-20 -translate-x-1/2 rounded-full bg-amber-500/90 px-3 py-1 text-[10px] font-medium text-black shadow"
                  >
                    Control may not be reaching the device
                  </div>
                )}
                {/* A3 W2845 — frozen-renderer ("stalled") badge. The page hung
                  (the last frame is still showing, the stream still reports live),
                  so we overlay a calm reconnecting indicator on the visible frame
                  rather than blanking to black. Cleared the moment the box reports
                  any non-stalled page state. */}
                {pageStalled && (
                  <div
                    role="status"
                    data-component="page-stalled-badge"
                    className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-black/75 px-4 py-2 text-[11px] font-medium text-white shadow-lg backdrop-blur"
                  >
                    <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                    Reconnecting — page unresponsive
                  </div>
                )}
                {/* Client-side video-freeze badge (audit). Surfaced ONLY when the
                  box hasn't already reported a renderer stall and there's no
                  page-error overlay (those take priority and explain the frozen
                  frame); a calm indicator over the last frame, same treatment as the
                  page-stalled badge. #5/#9 — the copy reflects REALITY: plain "Video
                  frozen" while the freeze is just being shown, and "Video frozen —
                  recovering" only once a recovery (resubscribe / Room rebuild) is
                  actually in flight (`recovering`). It never claims to be reconnecting
                  when nothing is. */}
                {videoFrozen && !pageStalled && pageError === null && (
                  <div
                    role="status"
                    data-component="video-frozen-badge"
                    data-recovering={recovering ? 'true' : 'false'}
                    className="absolute left-1/2 top-1/2 z-20 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2 rounded-full bg-black/75 px-4 py-2 text-[11px] font-medium text-white shadow-lg backdrop-blur"
                  >
                    <span className="h-2 w-2 animate-pulse rounded-full bg-amber-400" />
                    {recovering ? 'Video frozen — recovering' : 'Video frozen'}
                  </div>
                )}
                {/* W616 — honest page-navigation error overlay (DNS/TLS/HTTP/
                  timeout/net). The standalone Simulator previously dropped the
                  error payload entirely — the loading bar vanished and the frozen
                  last frame read as a blank successful load (audit). Mirror the
                  in-app LiveSessionView treatment: a per-kind message (shared
                  lib/page-error-copy) over the last frame + a Try again that
                  re-navigates the current address. Cleared on any loading/loaded/
                  stalled state and on every navigate. */}
                {pageError !== null && (
                  <div
                    data-component="page-error-overlay"
                    className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black/75 px-6 text-center"
                  >
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-status-error">
                      Page failed to load
                    </span>
                    <span className="max-w-xs text-sm text-white">{pageErrorCopy(pageError)}</span>
                    {!isBlankTabUrl(liveUrl) && (
                      <button
                        type="button"
                        data-action="retry-navigate"
                        onClick={() => onNavigate(liveUrl)}
                        className="rounded-md border border-white/20 bg-white/10 px-3 py-1.5 text-xs font-medium text-white transition hover:bg-white/20"
                      >
                        Try again
                      </button>
                    )}
                  </div>
                )}
                {/* #135 — SOFT load-stall advisory (A3 box 5eeaf794a: a main-frame nav
                  that hasn't finished in ~40s). NON-blocking — the page is still trying,
                  so a gentle top banner with a Retry, NOT the full-screen "failed" overlay.
                  Suppressed while the hard error overlay is up (an 'errored' frame
                  supersedes the advisory); a later 'loaded'/navigate clears it. Directly
                  answers the founder's "it just stops loading, stays on the same site." */}
                {pageLoadStalled !== null && pageError === null && (
                  <div
                    role="status"
                    data-component="page-load-stalled-banner"
                    className="absolute left-1/2 top-28 z-20 flex max-w-[min(90%,26rem)] -translate-x-1/2 items-center gap-2.5 rounded-lg bg-black/85 px-3.5 py-2 text-[12px] font-medium leading-snug text-white shadow-lg ring-1 ring-amber-400/40 backdrop-blur"
                  >
                    <span className="h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />
                    <span className="min-w-0">{pageLoadStalled.message}</span>
                    <button
                      type="button"
                      data-action="retry-stalled-navigate"
                      onClick={() =>
                        onNavigate(pageLoadStalled.url !== '' ? pageLoadStalled.url : liveUrl)
                      }
                      className="ml-1 shrink-0 rounded-md border border-white/20 bg-white/10 px-2.5 py-1 text-[11px] font-medium text-white transition hover:bg-white/20"
                    >
                      Retry
                    </button>
                  </div>
                )}
                {/* LOUD transport-fallback badge (A3 wmdoil11r rec (a)): WebRTC
                  silently falls back to a TCP/TURN relay when direct UDP is
                  blocked (box firewall / NAT / ISP) — head-of-line blocking makes
                  real-time video feel "1000× slower". Surface it prominently
                  (NOT only in the info overlay) so a relayed session is never
                  silently slow — this is the #1 latency suspect. */}
                {(conn.transport === 'tcp' || conn.relayed === true) && (
                  <div
                    role="status"
                    data-component="transport-fallback-badge"
                    title="The video is going through a TCP/TURN relay because direct UDP is blocked (firewall / NAT / ISP). Real-time video over TCP head-of-line-blocks, which feels very slow. Fix: open the box UDP port range to your network, or use a closer (EU) box."
                    className="absolute left-1/2 top-32 z-20 -translate-x-1/2 whitespace-nowrap rounded-full bg-status-error px-3 py-1 text-[10px] font-semibold text-white shadow"
                  >
                    ⚠ Slow link — video{' '}
                    {conn.relayed === true ? 'relayed' : `over ${conn.transport?.toUpperCase()}`}{' '}
                    (UDP blocked)
                  </div>
                )}
                {/* Finding #7 — persistent "Agent is driving" pill over the video in AI
                  mode. Input capture is off (interactive=false), so taps/scroll/keys do
                  nothing on the device — but with the drawer collapsed (the default
                  minimal chrome) the only cue is the caption inside the Session pane.
                  Without an on-screen badge a tap reads as a frozen/broken stream rather
                  than "the agent has control". Tappable → opens the Session pane so the
                  founder can switch to Manual to take over. Bottom-anchored so it never
                  collides with the top-center stalled / freeze / transport badges. */}
                {controlMode === 'ai' && (
                  <button
                    type="button"
                    data-component="ai-driving-badge"
                    onClick={() => openPane('session')}
                    title="The agent is driving this session. Open the Session pane to switch to Manual and take control."
                    className="absolute bottom-4 left-1/2 z-20 flex -translate-x-1/2 items-center gap-2 whitespace-nowrap rounded-full bg-black/75 px-4 py-2 text-[11px] font-medium text-white shadow-lg backdrop-blur transition hover:bg-black/85"
                  >
                    <span className="h-2 w-2 animate-pulse rounded-full bg-accent" />
                    Agent is driving — switch to Manual to take control
                  </button>
                )}
                <div
                  ref={screenHostRef}
                  data-component="simulator-screen-host"
                  // bg-black so any object-contain margin around the aspect-locked
                  // video reads as bezel-black, never a light see-through border
                  // (founder 2026-06-23 white-border / A3 W2827).
                  className={`relative min-h-0 flex-1 bg-black ${controlMode === 'ai' ? '' : 'cursor-none'}`}
                  onPointerDownCapture={showTap}
                  onPointerMove={moveTouchPoint}
                  onPointerEnter={moveTouchPoint}
                  onPointerLeave={hideTouchPoint}
                  onPointerUp={() => setDotPressed(false)}
                >
                  <AgentSessionPanel
                    info={info}
                    // P1b — the panel box uses the LIVE content aspect (videoW/videoH)
                    // so it == the screen-host == the <video>: no double object-contain,
                    // no bottom-black band. The content-only fork publishes the web
                    // content edge-to-edge (e.g. 402×714, NOT the full-device 402×874),
                    // so the old hardcoded 402:874 box letterboxed the wider content
                    // top+bottom inside it. Seeded to 402:874 until the first frame.
                    aspectRatio={contentAspect}
                    // Chrome-band masks dropped: the content-only per-archetype fork
                    // (A3 84de32ad4d, box mac-macstadium-us-001) publishes the web
                    // content edge-to-edge with NO bands, so the old bottom/top masks
                    // covered REAL content (founder's black-bottom + top-cutoff). The
                    // captured video IS the device's content frame now.
                    // Per-archetype captured-frame logical dims (videoW/dpr × videoH/dpr)
                    // drive the tap/scroll coordinate mapping so coords land right on
                    // whatever device the box dispatched (no 402×874 hardcode).
                    inputLogical={inputLogical}
                    // Forward mouse/keyboard to the device only in manual/pair
                    // mode; in AI mode the agent is driving, so local input would
                    // fight it.
                    interactive={controlMode !== 'ai'}
                    onVideoDimensions={handleVideoDimensions}
                    onRoom={handleRoom}
                    onStateChange={(s) => setConnState(s.kind)}
                    onPublisher={setPublisherState}
                    onPublishError={() => setControlUnreachable(true)}
                    onVideoEl={(el) => {
                      videoElRef.current = el;
                      if (el !== null) armFpsCounter(el);
                    }}
                    // #5/#9 — recovery lever for a sustained TRUE freeze. The driver
                    // above bumps recoverAction.nonce with mode 'resubscribe' (toggle
                    // the remote video subscription → fresh keyframe) or 'rebuild'
                    // (full Room reconnect) — the panel holds the publication + the
                    // retryNonce in scope, so it actually performs the recovery.
                    recoverAction={recoverAction}
                    // P1a — terminal session-end: when the box session actually ended
                    // (worker browser closed / destroyed / reaped), the panel stops all
                    // reconnect/resubscribe/rebuild machinery and shows "Session ended".
                    sessionEnded={sessionEnded}
                    // #5 (founder 2026-06-30) — while a tab switch is in flight, blank the
                    // video with an about:blank placeholder so the OLD tab doesn't linger.
                    switching={switchingTabId !== null}
                    onClose={() => void withCurrentWindow((w) => w.close())}
                  />
                  {/* iOS touch-point cursor — a soft fingertip dot that tracks the
                    pointer over the screen (the PC arrow is hidden via cursor-none
                    on the host). Shrinks + brightens on press. pointer-events-none
                    so it never intercepts the real tap. */}
                  {dotVisible && controlMode !== 'ai' && (
                    <span
                      ref={touchDotRef}
                      data-component="touch-cursor"
                      aria-hidden="true"
                      className={`ds-touch-dot pointer-events-none absolute z-20 ${
                        dotPressedRef.current ? 'ds-touch-dot--pressed' : ''
                      }`}
                      style={{ left: dotPosRef.current.x, top: dotPosRef.current.y }}
                    />
                  )}
                  {/* iOS tap cursor — a ring that blooms at each tap point then
                    fades. pointer-events-none so it never intercepts the tap. */}
                  {taps.map((t) => (
                    <span
                      key={t.id}
                      data-component="tap-ripple"
                      aria-hidden="true"
                      className="ds-tap-ring pointer-events-none absolute z-20 h-9 w-9 rounded-full border border-white/55 bg-white/10"
                      style={{ left: t.x, top: t.y }}
                    />
                  ))}
                  {/* #75b — OVERLAY keyboard: on a short laptop work area the
                    docked-below keyboard would overflow the screen and trip the
                    screen-clamp, which carves KEYBOARD_H out of the video and narrows
                    the window ("keyboard crops the browser"). Instead, anchor the
                    keyboard over the BOTTOM of the video — exactly iPhone-faithful (the
                    keyboard occludes the page) — and exclude KEYBOARD_H from chrome (see
                    keyboardChromeOn) so the video keeps its full aspect + width.
                    pointer-events stay live (keys fire); the video's getBoundingClientRect
                    that pointerToViewport reads is unchanged, so taps under the keyboard
                    correctly hit the keyboard. Anchored INSIDE simulator-screen so its
                    bottom-row corners follow the rounded display mask — which is what a
                    real on-screen iPhone keyboard does (it lives inside the display). */}
                  {keyboardOverlay && controlMode !== 'ai' && (
                    <div
                      data-tauri-drag-region="false"
                      data-component="ios-keyboard-overlay"
                      className="absolute inset-x-0 bottom-0 z-30 animate-keyboard-in"
                    >
                      <IOSKeyboard
                        room={room}
                        width={inputLogical.width}
                        onDismiss={() => {
                          if (!keyboardVisibleRef.current) return;
                          keyboardVisibleRef.current = false;
                          keyboardOverlayRef.current = false;
                          setKeyboardVisible(false);
                          fitWindow(browserMode);
                        }}
                      />
                    </div>
                  )}
                </div>
              </div>
              {/* On-screen iOS keyboard (founder 2026-06-25 "behave exactly like
                  a real iPhone"). GUI chrome BELOW the rounded phone screen, a flex
                  sibling of `simulator-screen` (the flex-1 device screen) inside the
                  bezel (`simulator-device`). It must live OUTSIDE `simulator-screen`:
                  that container is `rounded-[2.1rem] overflow-hidden`, so a keyboard
                  nested inside it had its bottom row's corners clipped by the ~34px
                  corner radius (founder "keyboard renders cropped"). As a sibling it
                  renders un-clipped below the screen. The window-sizing math reserves
                  KEYBOARD_H in `chrome`, so `simulator-screen` (flex-1) still gets the
                  full video-aspect height and the <video>'s own on-screen rect that
                  pointerToViewport maps against is unchanged — taps/scroll stay
                  aligned. Only in manual/pair mode (AI mode = the agent drives; local
                  input would fight it). Emits the SAME keyDown/keyUp the host keyboard
                  does — pure chrome, no fingerprint change (the viewport-resize that
                  WOULD change the page's view is deferred to A3, W2992). */}
              {keyboardVisible && !keyboardOverlay && controlMode !== 'ai' && (
                <div
                  data-tauri-drag-region="false"
                  data-component="ios-keyboard-docked"
                  className="shrink-0"
                >
                  <IOSKeyboard
                    room={room}
                    width={inputLogical.width}
                    onDismiss={() => {
                      if (!keyboardVisibleRef.current) return;
                      keyboardVisibleRef.current = false;
                      keyboardOverlayRef.current = false;
                      setKeyboardVisible(false);
                      fitWindow(browserMode);
                    }}
                  />
                </div>
              )}
            </div>
            {/* Activity-bar drawer (founder 2026-06-24) — the icon RAIL is ALWAYS
              docked beside the phone (VS Code's activity bar). The window widens by
              RAIL_W for the rail unconditionally, and by PANE_W more whenever a pane
              is open. Clicking a rail icon EXPANDS its content PANEL to the right of
              the rail (the active icon again collapses it). The rail carries the
              always-reachable red End-session button at its bottom. NOT a drag
              region (its controls must be clickable). */}
            <aside
              data-tauri-drag-region="false"
              data-component="simulator-drawer"
              /* NOT overflow-hidden: the rail icons' hover-tooltip flyouts extend LEFT
                 (over the phone edge) past the rail and were being CLIPPED here (founder:
                 "still don't see hoverable icon"). The rail + panel children are
                 fixed-width and self-clip (the panel is its own overflow-hidden), so the
                 aside doesn't need to clip — dropping it lets the tooltips show. */
              className="flex shrink-0 flex-row border-l border-white/[0.12] bg-[#1d1e24] text-[11.5px]"
            >
              {/* The RAIL — always visible. Top: one icon per section (the active one
                highlighted only while its pane is open). Bottom: a separator + the
                red End-session button so a true Stop is reachable even when
                collapsed. */}
              <nav
                data-component="sim-drawer-rail"
                aria-label="Drawer sections"
                className="flex w-12 shrink-0 flex-col items-center gap-1 py-2"
              >
                {SIM_DRAWER_PANES.map((pane) => (
                  <DrawerRailButton
                    key={pane}
                    pane={pane}
                    active={activePane === pane}
                    pulse={pane === 'recording' && recordingId !== null}
                    onSelect={selectPane}
                  />
                ))}
                {/* End-session — the always-reachable Stop. Same handler + busy
                  gating as the old footer; pinned to the rail bottom under a
                  separator. Only when a session is bound. */}
                {sessionId !== '' && (
                  <>
                    <div aria-hidden="true" className="mx-auto mt-auto mb-1 h-px w-6 bg-white/10" />
                    <button
                      type="button"
                      data-component="sim-rail-end"
                      aria-label={endArmed ? 'Confirm — end session' : 'End session'}
                      title={
                        endArmed
                          ? 'Click again to end the session (no undo)'
                          : 'End the session — stops the worker and tears down the browser'
                      }
                      disabled={controlBusy}
                      onClick={onEndSession}
                      className={`flex h-9 w-9 items-center justify-center rounded-lg transition-colors disabled:opacity-50 ${
                        endArmed
                          ? 'bg-red-500/30 text-red-200 ring-1 ring-red-400/70'
                          : 'text-red-400 hover:bg-red-500/20 hover:text-red-300'
                      }`}
                    >
                      <span aria-hidden="true">{controlBusy ? '…' : '◼'}</span>
                    </button>
                  </>
                )}
              </nav>
              {/* The PANEL — the status strip + the active pane's content. Renders to
                the RIGHT of the rail ONLY when a pane is open. */}
              {paneOpen && (
                <div
                  data-component="sim-drawer-panel"
                  className="flex w-[252px] shrink-0 flex-col overflow-hidden border-l border-white/[0.12]"
                >
                  {/* Pinned status strip: the cross-cutting vitals (mode · link ·
                    transport · fps · latency · egress) on 1–2 compact lines, with the
                    collapse ✕ in the top-right. Never scrolls. */}
                  <div
                    data-component="sim-drawer-status"
                    className="shrink-0 border-b border-white/[0.10] bg-black/20 px-2.5 py-2 font-mono text-[10px] leading-tight text-white/70"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="truncate">
                          <span className="text-white/90">
                            {controlMode !== null
                              ? controlMode === 'ai'
                                ? 'Agent'
                                : controlMode === 'pair'
                                  ? 'Pair'
                                  : 'Manual'
                              : '…'}
                          </span>
                          <span className="text-white/30"> · </span>
                          <span>{info ? wsHost(info.ws_url) : 'not connected'}</span>
                          <span className="text-white/30"> · </span>
                          {conn.transport !== null ? (
                            <span
                              className={
                                conn.transport === 'udp' && conn.relayed !== true
                                  ? 'text-ink-secondary'
                                  : 'text-status-error'
                              }
                            >
                              {conn.transport}
                              {conn.relayed ? ' relay⚠' : ''}
                            </span>
                          ) : (
                            <span className="text-white/40">link…</span>
                          )}
                        </div>
                        <div className="truncate">
                          {fps !== null && <span>{fps}fps · </span>}
                          {latency.rttMs !== null ? (
                            <span
                              className={
                                latency.rttMs < 150 ? 'text-ink-secondary' : 'text-amber-300'
                              }
                            >
                              {latency.rttMs}ms
                            </span>
                          ) : conn.rttMs !== null ? (
                            <span
                              className={conn.rttMs < 150 ? 'text-ink-secondary' : 'text-amber-300'}
                            >
                              {conn.rttMs}ms
                            </span>
                          ) : (
                            <span className="text-white/40">measuring…</span>
                          )}
                          {proxyLabel !== '' && (
                            <span className="text-white/60"> · 🌍 {proxyLabel}</span>
                          )}
                        </div>
                      </div>
                      <button
                        type="button"
                        aria-label="Close drawer"
                        title="Collapse"
                        onClick={collapseDrawer}
                        className="-mr-1 -mt-0.5 shrink-0 rounded px-1 text-[13px] leading-none text-white/50 transition hover:bg-white/10 hover:text-white"
                      >
                        ✕
                      </button>
                    </div>
                  </div>

                  {/* The active section's content PANE — scrolls (the rail + status
                  strip don't). */}
                  <div
                    data-component="sim-drawer-pane"
                    className="min-w-0 flex-1 space-y-2.5 overflow-y-auto p-2.5"
                  >
                    {/* Session — mode switch + (ai/pair) the agent composer. The pane is
                      wider than the old dropdown, so this IS the "bigger AI chat". */}
                    {activePane === 'session' && (
                      <section
                        data-component="drawer-session"
                        className="rounded-lg bg-black/20 pb-1"
                      >
                        <div className="px-3 pt-2 font-sans text-[11px] font-semibold text-white/90">
                          Session
                        </div>
                        <SessionControlSection
                          mode={controlMode}
                          pairKind={pairKind}
                          busy={controlBusy}
                          composerText={composerText}
                          controlError={controlError}
                          onRetryControl={refreshControl}
                          onSetMode={onSetMode}
                          onTakeover={onTakeover}
                          onHandback={onHandback}
                          onComposerChange={setComposerText}
                          onSendMessage={onSendMessage}
                        />
                      </section>
                    )}

                    {/* Controls — the address bar (non-browser-mode) + window toggles. */}
                    {activePane === 'controls' && (
                      <section
                        data-component="drawer-controls"
                        className="rounded-lg bg-black/20 py-1"
                      >
                        <div className="px-3 pb-0.5 pt-1 font-sans text-[11px] font-semibold text-white/90">
                          Controls
                        </div>
                        {!browserMode && (
                          <NavigateAddressBar
                            canNavigate={canNavigate}
                            onNavigate={onNavigate}
                            liveUrl={liveUrl}
                          />
                        )}
                        <LabeledControl
                          label={browserMode ? 'Browser mode: on' : 'Browser mode'}
                          hint={
                            browserMode
                              ? 'URL bar lives in the toolbar'
                              : 'Type URLs in the toolbar, not the phone'
                          }
                          active={browserMode}
                          onClick={toggleBrowserMode}
                          glyph={
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <circle cx="12" cy="12" r="9" />
                              <path d="M3 12h18M12 3a15 15 0 0 1 0 18 15 15 0 0 1 0-18" />
                            </svg>
                          }
                        />
                        <LabeledControl
                          label={landscape ? 'Rotate to portrait' : 'Rotate to landscape'}
                          active={landscape}
                          onClick={toggleRotate}
                          glyph={
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M23 4v6h-6" />
                              <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
                            </svg>
                          }
                        />
                        <LabeledControl
                          label={pinned ? 'Unpin from top' : 'Pin on top'}
                          hint={pinned ? 'Behave like a normal window' : 'Float above everything'}
                          active={pinned}
                          onClick={togglePinned}
                          glyph={
                            <svg
                              width="13"
                              height="13"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="2"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                            >
                              <path d="M12 17v5" />
                              <path d="M9 3h6l-1 7 3 3H7l3-3z" />
                            </svg>
                          }
                        />
                      </section>
                    )}

                    {/* Diagnostics — the session facts + Copy. (The drawer-close ✕
                      now lives in the pinned status strip.) */}
                    {activePane === 'diagnostics' &&
                      (() => {
                        // The latency value the strip/Copy report, with its
                        // health color (#139 sweep: neutral ink < 150ms, else the
                        // kept amber "warn" cue — good stays quiet, slow warns).
                        const rttMs = latency.rttMs !== null ? latency.rttMs : conn.rttMs;
                        const rttFromLink = latency.rttMs === null && conn.rttMs !== null;
                        const rttHealthy = rttMs !== null && rttMs < 150;
                        return (
                          <section
                            data-component="drawer-diagnostics"
                            className="space-y-2.5 text-[11px] text-white/80"
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
                                data-action="copy-diagnostics"
                                onClick={copyDiagnostics}
                                className="ml-auto inline-flex items-center gap-1 rounded-md border border-white/15 bg-white/5 px-2 py-0.5 text-[10px] font-medium text-white/80 transition-colors hover:bg-white/10"
                              >
                                <span aria-hidden="true">⧉</span>
                                {diagCopyFailed
                                  ? "Couldn't copy"
                                  : diagCopied
                                    ? 'Copied ✓'
                                    : 'Copy'}
                              </button>
                            </div>

                            {/* 2-up stat tiles — Render fps + Latency (with sparkline). */}
                            <div className="grid grid-cols-2 gap-2">
                              <div className="rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2">
                                <div className="text-[9.5px] uppercase tracking-[0.04em] text-white/40">
                                  Render
                                </div>
                                <div className="mt-0.5 text-[16px] font-bold leading-none">
                                  {fps !== null ? fps : '—'}
                                  <span className="ml-0.5 text-[10px] font-medium text-white/45">
                                    fps
                                  </span>
                                </div>
                              </div>
                              <div className="rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2">
                                <div className="text-[9.5px] uppercase tracking-[0.04em] text-white/40">
                                  Latency
                                </div>
                                {rttMs !== null ? (
                                  <>
                                    <div
                                      className={`mt-0.5 text-[16px] font-bold leading-none ${
                                        rttHealthy ? 'text-ink-secondary' : 'text-amber-300'
                                      }`}
                                    >
                                      {rttMs}
                                      <span className="ml-0.5 text-[10px] font-medium text-white/45">
                                        ms{rttFromLink ? ' (link)' : ''}
                                      </span>
                                    </div>
                                    <svg
                                      className="mt-1 h-[18px] w-full"
                                      viewBox="0 0 100 22"
                                      preserveAspectRatio="none"
                                      aria-hidden="true"
                                    >
                                      <polyline
                                        points="0,16 14,12 28,15 42,8 56,11 70,7 84,10 100,6"
                                        fill="none"
                                        stroke={rttHealthy ? '#34d399' : '#fbbf24'}
                                        strokeWidth="1.5"
                                      />
                                    </svg>
                                  </>
                                ) : (
                                  <div className="mt-0.5 text-[11px] text-white/50">measuring…</div>
                                )}
                              </div>
                            </div>

                            {/* Transport + decode/loss/jitter/freeze line (preserved). */}
                            <div className="rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2 font-mono text-[10px] leading-relaxed">
                              <div className="font-sans text-[9.5px] uppercase tracking-[0.04em] text-white/40">
                                Transport
                              </div>
                              <div className="mt-0.5 truncate">
                                {conn.transport !== null ? (
                                  <span
                                    className={
                                      conn.transport === 'udp' && conn.relayed !== true
                                        ? 'text-ink-secondary'
                                        : 'text-status-error'
                                    }
                                  >
                                    {conn.transport}
                                    {conn.relayed ? ' · relay ⚠' : ' · direct'}
                                  </span>
                                ) : (
                                  <span className="text-white/50">measuring…</span>
                                )}
                              </div>
                              {/* Finding #4 — flex-wrap (was `truncate`) so jitter +
                                  freezes flow onto a second line instead of clipping
                                  off-screen at the narrow drawer width (~212px usable);
                                  freezes>0 in amber is the stall signal an operator
                                  needs. gap-x-2 supplies the separator spacing the
                                  dropped ` · ` characters provided. */}
                              {(conn.decodeFps !== null ||
                                conn.packetLossPct !== null ||
                                conn.freezeCount !== null) && (
                                <div className="mt-1 flex flex-wrap gap-x-2 text-white/70">
                                  {conn.decodeFps !== null && (
                                    <span>decode {conn.decodeFps} fps</span>
                                  )}
                                  {conn.packetLossPct !== null && (
                                    <span
                                      className={conn.packetLossPct > 1 ? 'text-amber-300' : ''}
                                    >
                                      loss {conn.packetLossPct}%
                                    </span>
                                  )}
                                  {conn.jitterMs !== null && <span>jitter {conn.jitterMs}ms</span>}
                                  {conn.freezeCount !== null && (
                                    <span className={conn.freezeCount > 0 ? 'text-amber-300' : ''}>
                                      freezes {conn.freezeCount}
                                    </span>
                                  )}
                                </div>
                              )}
                            </div>

                            {/* Info cards — Profile / Device / Link / Egress (preserved values). */}
                            {profileName !== '' && (
                              <div className="rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2">
                                <div className="text-[9.5px] uppercase tracking-[0.04em] text-white/40">
                                  Profile
                                </div>
                                <div className="mt-0.5 truncate">{profileName}</div>
                              </div>
                            )}
                            <div className="rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2">
                              <div className="text-[9.5px] uppercase tracking-[0.04em] text-white/40">
                                Device
                              </div>
                              <div className="mt-0.5 truncate">{deviceName}</div>
                            </div>
                            <div className="rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2">
                              <div className="text-[9.5px] uppercase tracking-[0.04em] text-white/40">
                                Link
                              </div>
                              <div className="mt-0.5 truncate">
                                {info ? wsHost(info.ws_url) : 'not connected'}
                                {info && <span className="text-ink-secondary"> · ws ✓</span>}
                              </div>
                            </div>
                            {proxyLabel !== '' && (
                              <div className="rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2">
                                <div className="text-[9.5px] uppercase tracking-[0.04em] text-white/40">
                                  Egress
                                </div>
                                <div className="mt-0.5 truncate">🌍 {proxyLabel}</div>
                              </div>
                            )}

                            {/* Identity facts (preserved). */}
                            <div className="rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-white/80">
                              <div className="font-sans text-[9.5px] uppercase tracking-[0.04em] text-white/40">
                                Identity
                              </div>
                              <div className="mt-0.5 truncate">engine-deep · bit-exact device</div>
                              <div className="truncate">input human-cadence native</div>
                              <div className="truncate text-white/40">
                                build{' '}
                                {typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev'}
                              </div>
                            </div>
                          </section>
                        );
                      })()}

                    {/* Cookies — live jar for the current page (httpOnly included), pulled
                      over the control plane; "pending" until the device build serves it.
                      Cross-domain whole-jar arrives later ("this page" → "all"). */}
                    {activePane === 'cookies' && (
                      <CookiesPane
                        cookies={cookies}
                        cookiesNote={cookiesNote}
                        sessionId={sessionId}
                        controlAuth={controlAuth}
                      />
                    )}

                    {/* Files — upload a file into the session's isolated 0o700 jail; the
                      OPAQUE handle drives a page's <input type=file> (A3 W2851 / founder
                      "control files"). Upload-only for now — the file-chooser handle-pick
                      drive (when a page opens a chooser) is A3's next harness piece. */}
                    {activePane === 'files' && (
                      <section
                        data-component="simulator-files"
                        className="space-y-2.5 text-[11px] text-white/80"
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
                              <path d="M4 15v4h16v-4" />
                              <line x1="12" y1="3" x2="12" y2="14" />
                              <polyline points="8,7 12,3 16,7" />
                            </svg>
                          </span>
                          <span>Files</span>
                          {files.length > 0 && (
                            <span className="text-white/40">· {files.length}</span>
                          )}
                        </div>

                        {/* The hidden native input is the upload mechanism — the
                          drop-zone below is a styled trigger over it. Behavior
                          (onUploadFile, 64 MiB guard, opaque-handle list) unchanged. */}
                        <input
                          ref={fileInputRef}
                          type="file"
                          className="hidden"
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (f) onUploadFile(f);
                            e.target.value = '';
                          }}
                        />

                        {/* Dashed drop-zone — click OR drag-and-drop runs the same
                          upload flow. Disabled (dimmed, non-interactive) while a
                          previous upload is in flight or before a session is live. */}
                        <button
                          type="button"
                          aria-label="Upload file"
                          title="Upload a file into the session"
                          disabled={uploading || sessionId === ''}
                          onClick={() => fileInputRef.current?.click()}
                          onDragOver={(e) => {
                            if (uploading || sessionId === '') return;
                            e.preventDefault();
                            setFileDragOver(true);
                          }}
                          onDragLeave={() => setFileDragOver(false)}
                          onDrop={(e) => {
                            e.preventDefault();
                            setFileDragOver(false);
                            if (uploading || sessionId === '') return;
                            const f = e.dataTransfer.files?.[0];
                            if (f) onUploadFile(f);
                          }}
                          className={`flex w-full flex-col items-center gap-1 rounded-xl border border-dashed px-4 py-5 text-center transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                            fileDragOver
                              ? 'border-accent bg-accent/5 text-accent'
                              : 'border-white/15 text-white/45 hover:border-accent hover:bg-accent/5 hover:text-accent'
                          }`}
                        >
                          <span aria-hidden="true" className="text-[15px] leading-none">
                            ⬆
                          </span>
                          <span className="text-[11.5px] font-medium">
                            {uploading ? 'Uploading…' : 'Drop a file or click to upload'}
                          </span>
                          <span className="text-[10px] text-white/35">
                            → feeds the page&apos;s file picker · max 64 MiB
                          </span>
                        </button>

                        {uploadNote !== null && (
                          <div className="font-mono text-[10px] text-amber-300/80">
                            {uploadNote}
                          </div>
                        )}

                        {files.length === 0 ? (
                          <div className="font-mono text-[10px] text-white/40">
                            no files uploaded
                          </div>
                        ) : (
                          <div className="max-h-48 space-y-2 overflow-y-auto pr-0.5">
                            {files.map((f) => {
                              const g = fileGlyph(f.name, f.mime);
                              return (
                                <div
                                  key={f.id}
                                  className="flex items-center gap-2.5 rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2"
                                >
                                  <span
                                    aria-hidden="true"
                                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px]"
                                    style={{ backgroundColor: `${g.color}22`, color: g.color }}
                                  >
                                    {g.icon}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[11.5px] font-semibold text-white">
                                      {f.name}
                                    </div>
                                    <div className="truncate text-[10px] text-white/40">
                                      {formatFileSize(f.size)} · uploaded
                                    </div>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    )}

                    {/* Downloads — files a page wrote into the session's download jail
                      (A3 W2856 / founder "control files"). Click one to save it to your
                      machine. Empty until A3's fork download-delegate populates the jail. */}
                    {activePane === 'downloads' && (
                      <section
                        data-component="simulator-downloads"
                        className="space-y-2.5 text-[11px] text-white/80"
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
                              <path d="M4 15v4h16v-4" />
                              <line x1="12" y1="3" x2="12" y2="14" />
                              <polyline points="8,10 12,14 16,10" />
                            </svg>
                          </span>
                          <span>Downloads</span>
                          {downloads !== null && downloads.length > 0 && (
                            <span className="text-white/40">· {downloads.length}</span>
                          )}
                          {downloads !== null && (
                            <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold text-ink-secondary">
                              <span
                                aria-hidden="true"
                                className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent"
                              />
                              live
                            </span>
                          )}
                        </div>

                        {downloadsNote !== null && (
                          <div className="font-mono text-[10px] text-amber-300/80">
                            {downloadsNote}
                          </div>
                        )}

                        {downloads === null || downloads.length === 0 ? (
                          <div className="font-mono text-[10px] text-white/40">
                            no downloads yet
                          </div>
                        ) : (
                          <div className="max-h-48 space-y-2 overflow-y-auto pr-0.5">
                            {downloads.map((d) => {
                              const g = fileGlyph(d.name, d.mime);
                              return (
                                <div
                                  key={d.name}
                                  className="flex items-center gap-2.5 rounded-[10px] border border-white/[0.10] bg-black/20 px-2.5 py-2"
                                >
                                  <span
                                    aria-hidden="true"
                                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-[13px]"
                                    style={{ backgroundColor: `${g.color}22`, color: g.color }}
                                  >
                                    {g.icon}
                                  </span>
                                  <div className="min-w-0 flex-1">
                                    <div className="truncate text-[11.5px] font-semibold text-white">
                                      {d.name}
                                    </div>
                                    <div className="truncate text-[10px] text-white/40">
                                      {formatFileSize(d.size)}
                                    </div>
                                  </div>
                                  <button
                                    type="button"
                                    aria-label={`Save ${d.name}`}
                                    title="Save this file to your machine"
                                    disabled={downloadingName !== null}
                                    onClick={() => onDownloadFile(d.name)}
                                    className="shrink-0 rounded-md border border-white/15 bg-white/5 px-2 py-1 font-sans text-[10px] text-white/80 transition-colors hover:bg-white/10 disabled:opacity-40"
                                  >
                                    {downloadingName === d.name ? 'Saving…' : '⬇ Save'}
                                  </button>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </section>
                    )}

                    {/* Recording — SLICE 3 (founder-approved drawer-full-demo
                      PANES.recording). A big Start/Stop record control with a live
                      elapsed/frames/size readout while recording, plus the saved-
                      recordings list with per-row Export ⬇ / Delete ×. Reuses the
                      #36 recordings store (useRecordings) + recordings-export — no
                      new storage or recording mechanism. The rail's Recording icon
                      red-pulses while recording (slice 1, untouched). Play is OMITTED
                      here: playback lives in the dedicated RecordingsView gallery
                      (with its frame player); the slim drawer has no player host and
                      this slice does not invent one. */}
                    {activePane === 'recording' &&
                      (() => {
                        const activeRec =
                          recordingId !== null ? (recordings.get(recordingId) ?? null) : null;
                        const isRec = activeRec !== null;
                        // Saved list = every recording that is not the live one,
                        // newest first (mirrors the demo's "Saved recordings · N").
                        const saved = Array.from(recordings.values())
                          .filter((r) => r.id !== recordingId)
                          .sort((a, b) => b.startedAt - a.startedAt);
                        // `recNow` keeps the elapsed readout ticking each second while
                        // recording (read here so React tracks the dependency).
                        const elapsedMs = isRec
                          ? Math.max(recordingDurationMs(activeRec), recNow - activeRec.startedAt)
                          : 0;
                        const liveFrames = activeRec?.frames.length ?? 0;
                        const liveBytes = activeRec !== null ? recordingTotalBytes(activeRec) : 0;
                        return (
                          <section
                            data-component="drawer-recording"
                            className="space-y-2.5 text-[11px] text-white/80"
                          >
                            <div className="flex items-center gap-2 font-sans text-[11px] font-semibold text-white">
                              <span>Recording</span>
                              {isRec && (
                                <span className="inline-flex items-center gap-1 text-[9.5px] font-semibold text-red-400">
                                  <span
                                    aria-hidden="true"
                                    className="h-1.5 w-1.5 animate-pulse rounded-full bg-red-400 shadow-[0_0_6px_rgba(248,113,113,0.6)]"
                                  />
                                  REC {formatDuration(elapsedMs)}
                                </span>
                              )}
                            </div>

                            {/* Record control */}
                            <div
                              className={`rounded-lg border p-3 ${
                                isRec
                                  ? 'border-red-500/30 bg-red-500/[0.06]'
                                  : 'border-white/[0.10] bg-black/20'
                              }`}
                            >
                              <button
                                type="button"
                                aria-label={isRec ? 'Stop recording' : 'Start recording'}
                                title={
                                  isRec
                                    ? 'Stop and save the recording'
                                    : 'Capture the live session as frames you can replay or export'
                                }
                                disabled={sessionId === ''}
                                onClick={toggleRecord}
                                className={`flex w-full items-center justify-center gap-2 rounded-lg px-3 py-2 text-[12px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                                  isRec
                                    ? 'bg-red-500/20 text-red-200 hover:bg-red-500/30'
                                    : 'bg-white/5 text-white/90 hover:bg-white/10'
                                }`}
                              >
                                <span
                                  aria-hidden="true"
                                  className={
                                    isRec
                                      ? 'h-2.5 w-2.5 rounded-[2px] bg-red-400'
                                      : 'h-2.5 w-2.5 rounded-full bg-red-500'
                                  }
                                />
                                {isRec ? 'Stop recording' : 'Start recording'}
                              </button>
                              <div
                                className={`mt-2 text-center text-[10px] ${
                                  isRec ? 'text-red-200/80' : 'text-white/40'
                                }`}
                              >
                                {isRec
                                  ? `${formatDuration(elapsedMs)} · ${liveFrames.toLocaleString()} frames · ${formatRecBytes(liveBytes)} · capturing…`
                                  : 'Capture the live session as frames you can replay or export'}
                              </div>
                            </div>

                            {/* Saved recordings */}
                            <div className="mt-3 px-0.5 text-[10px] uppercase tracking-[0.04em] text-white/40">
                              Saved recordings
                              {saved.length > 0 && <span> · {saved.length}</span>}
                            </div>
                            {saved.length === 0 ? (
                              <div className="py-6 text-center text-[11px] text-white/40">
                                No recordings yet.
                              </div>
                            ) : (
                              <div className="space-y-2">
                                {saved.map((r) => {
                                  const frames = r.frameCount > 0 ? r.frameCount : r.frames.length;
                                  return (
                                    <div
                                      key={r.id}
                                      data-component="sim-recording-row"
                                      className="flex items-center gap-2.5 rounded-lg border border-white/[0.10] bg-black/20 px-2.5 py-2"
                                    >
                                      <span
                                        aria-hidden="true"
                                        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-surface-inset text-ink-secondary"
                                      >
                                        <svg
                                          width="13"
                                          height="13"
                                          viewBox="0 0 24 24"
                                          fill="currentColor"
                                        >
                                          <path d="M8 5v14l11-7z" />
                                        </svg>
                                      </span>
                                      <div className="min-w-0 flex-1">
                                        <div className="truncate text-[11.5px] font-semibold text-white">
                                          {r.label ?? 'Session recording'}
                                        </div>
                                        <div className="truncate text-[10px] text-white/40">
                                          {formatDuration(recordingDurationMs(r))} ·{' '}
                                          {frames.toLocaleString()} frames ·{' '}
                                          {formatRecBytes(recordingTotalBytes(r))}
                                        </div>
                                      </div>
                                      <button
                                        type="button"
                                        aria-label={`Export ${r.label ?? 'recording'}`}
                                        title="Export this recording as JSON"
                                        onClick={() => exportRecording(r)}
                                        className="shrink-0 rounded border border-white/15 bg-white/5 px-2 py-0.5 text-[11px] text-white/80 transition-colors hover:bg-white/10"
                                      >
                                        ⬇
                                      </button>
                                      <button
                                        type="button"
                                        aria-label={`Delete ${r.label ?? 'recording'}`}
                                        title={
                                          confirmingDeleteRecId === r.id
                                            ? 'Click again to permanently delete'
                                            : 'Delete this recording'
                                        }
                                        onClick={() => onDeleteRecording(r.id)}
                                        className={`shrink-0 rounded border px-2 py-0.5 text-[11px] transition-colors ${
                                          confirmingDeleteRecId === r.id
                                            ? 'border-red-400/70 bg-red-500/30 text-red-200'
                                            : 'border-white/15 bg-white/5 text-white/60 hover:bg-red-500/20 hover:text-red-300'
                                        }`}
                                      >
                                        {confirmingDeleteRecId === r.id ? 'Delete?' : '×'}
                                      </button>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </section>
                        );
                      })()}
                  </div>
                </div>
              )}
            </aside>
          </div>
        </div>
      )}
    </div>
  );
}
