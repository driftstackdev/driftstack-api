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
import { sendNavigate, RoomEvent, type Room } from '../lib/livekit';
import { useLatencyPing } from '../lib/livekit-latency-ping';
import { useConnectionStats } from '../lib/livekit-connection-stats';
import { useRecordings } from '../lib/recordings';
import { AgentSessionPanel } from '../components/AgentSessionPanel';
import { normalizeNavigateUrl, resolveAddressBarInput } from '../lib/address-bar';
import { formatSessionDiagnostics } from '../lib/session-diagnostics';
import { persistBaseUrl } from '../lib/settings';
import {
  getAgentSession,
  getAgentSessionPageState,
  getAgentSessionCookies,
  setSessionMode,
  takeoverSession,
  handbackSession,
  sendAgentMessage,
  endAgentSession,
  AgentSessionControlError,
  type SessionMode,
  type ControlAuth,
  type SessionCookie,
} from '../lib/agent-session-control';

/** Frame chrome heights (px) used to derive the window size from the device's
 *  real screen aspect: toolbar above the bezel, the bezel's p-[10px] padding,
 *  and the in-screen status strip the video sits below. */
const TOOLBAR_H = 34;
const BROWSER_BAR_H = 40; // dedicated browser-mode address bar (its own row)
const BEZEL_PAD = 20; // p-[10px] × 2
const STATUS_STRIP_H = 40;
// The iPhone CSS-logical width of the launch archetype (iphone17). Used by the
// "actual size" reset (Cmd+0) so the device renders at true iPhone-logical px,
// not whatever width the window happens to have been dragged to.
const DEVICE_LOGICAL_WIDTH = 402;
// Option B (founder 2026-06-23) — the chevron toggle reveals a wide right DRAWER
// (Session · Controls · Diagnostics · Cookies). When open, the WINDOW widens by
// exactly this much; the phone keeps its size. The window-sizing math always
// derives the phone dims from (windowWidth − drawerExtra) and adds drawerExtra
// back, so the drawer never letterboxes the device (the prior "window larger than
// output" hazard). Reversible: closing removes the extra width exactly.
const DRAWER_W = 264;

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
  expanded,
  onToggleExpanded,
  recording,
  onToggleRecord,
  running,
}: {
  deviceName: string;
  profileName: string;
  /** True when the right control DRAWER is open (Option B). The chevron toggles
   *  it; the drawer itself + the controls it holds live in the main layout
   *  (SimulatorWindow), not in this thin toolbar. */
  expanded: boolean;
  onToggleExpanded: () => void;
  recording: boolean;
  onToggleRecord: () => void;
  /** True when a live agent session is bound to this window — drives the running
   *  indicator. */
  running: boolean;
}): JSX.Element {
  // Escape closes the drawer (it's a docked side panel now, NOT an overlay — so
  // an outside-pointer-down must NOT close it, or every tap on the phone would
  // collapse it). Keyboard-only dismiss.
  const wrapRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onToggleExpanded();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
    };
  }, [expanded, onToggleExpanded]);
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
        {/* Right — quick Record + the expand chevron. The window-controls
            (rotate / pin / info) live in the expandable panel below so the
            default chrome stays minimal (founder 2026-06-17: "phone showing
            only" by default, a clean expandable row for the controls). */}
        <div data-tauri-drag-region="false" className="flex items-center gap-1 text-white/70">
          {/* Running indicator (founder Track A) — a live pulse so the window
              reads as a RUNNING session at a glance (today only the per-mode
              window-close existed; no inline running cue). */}
          {running && (
            <span
              data-component="simulator-running-indicator"
              title="Session is running"
              className="mr-0.5 inline-flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-status-ready"
            >
              <span
                aria-hidden="true"
                className="h-1.5 w-1.5 animate-pulse rounded-full bg-status-ready shadow-[0_0_6px_rgb(var(--status-ready-rgb))]"
              />
              Live
            </span>
          )}
          <button
            type="button"
            aria-label={recording ? 'Stop recording' : 'Start recording'}
            title={recording ? 'Stop and save the recording' : 'Record this session (1fps)'}
            className={
              recording
                ? 'animate-pulse rounded px-1.5 py-0.5 text-[13px] text-red-400 transition hover:bg-white/10'
                : 'rounded px-1.5 py-0.5 text-[13px] transition hover:bg-white/10 hover:text-ink-primary'
            }
            onClick={onToggleRecord}
          >
            ●
          </button>
          <button
            type="button"
            aria-label={expanded ? 'Hide controls' : 'Show controls'}
            aria-expanded={expanded}
            title={expanded ? 'Hide controls' : 'More controls'}
            onClick={onToggleExpanded}
            className={`rounded p-1 transition hover:bg-white/10 hover:text-ink-primary ${expanded ? 'text-accent' : ''}`}
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
              className={`transition-transform ${expanded ? 'rotate-180' : ''}`}
            >
              {/* Right-pointing ›: the panel is a RIGHT drawer now (Option B), so
                  the chevron opens to the right (rotates to ‹ to close). */}
              <path d="M9 18l6-6-6-6" />
            </svg>
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
}: {
  canNavigate: boolean;
  onNavigate: (url: string) => void;
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
            if (canNavigate && draftUrl.trim() !== '') onNavigate(draftUrl);
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
  liveUrl,
  pageLoading,
  loadProgress,
}: {
  canNavigate: boolean;
  onNavigate: (url: string) => void;
  liveUrl: string;
  pageLoading: boolean;
  loadProgress: number | null;
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
  // (CryptoReceiptView) — silently no-ops in locked-down envs.
  const [copied, setCopied] = useState(false);
  const copyUrl = (): void => {
    const text = (liveUrl || draft).trim();
    if (text === '') return;
    void navigator.clipboard?.writeText(text).then(
      () => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      },
      () => {
        /* clipboard blocked — silent */
      },
    );
  };
  const copyTarget = (liveUrl || draft).trim();
  return (
    <div
      data-component="simulator-address-bar"
      data-no-drag
      className="relative flex h-10 w-full shrink-0 items-center gap-2 bg-[#1d1e24] px-3 ring-1 ring-white/[0.10] shadow-[inset_0_-1px_0_rgba(0,0,0,0.45)]"
    >
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
        <input
          type="text"
          value={draft}
          disabled={!canNavigate}
          onChange={(e) => setDraft(e.target.value)}
          onFocus={() => setFocused(true)}
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
          aria-label={copied ? 'Copied' : 'Copy URL'}
          title={copied ? 'Copied' : 'Copy address'}
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
              className="text-emerald-400"
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
          strip is reserved space rather than an overlay). */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute left-1/2 top-1/2 h-[26px] w-[92px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-black shadow-[inset_0_1px_1px_rgba(255,255,255,0.04)]"
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
  const { startRecording, stopRecording, addFrame, activeRecordingFor } = useRecordings();
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
    addFrame(recId, { at: Date.now(), dataUrl, bytes: Math.round(dataUrl.length * 0.75) });
  }
  function toggleRecord(): void {
    if (sessionId === '') return;
    if (recordingId !== null) {
      if (recordTimerRef.current !== null) {
        window.clearInterval(recordTimerRef.current);
        recordTimerRef.current = null;
      }
      void stopRecording(recordingId);
      activeRecIdRef.current = null;
      setNotice('Recording saved');
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
  // Stop the capture loop if the window unmounts mid-recording.
  useEffect(() => {
    return () => {
      if (recordTimerRef.current !== null) window.clearInterval(recordTimerRef.current);
    };
  }, []);
  // Night-arc C cockpit: live room handle (from the panel) drives the
  // previously-dormant LK.6.e latency ping; rendered in the overlay.
  const [room, setRoom] = useState<Room | null>(null);
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
  function armFpsCounter(el: HTMLVideoElement): void {
    if (fpsArmedElRef.current === el) return;
    fpsArmedElRef.current = el;
    const tick = (now: number): void => {
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
  // #48 item 2 — "Copy diagnostics": a paste-ready snapshot of the session-info
  // overlay (the founder keeps reporting streaming/latency issues and needs the
  // exact figures for a bug report). formatSessionDiagnostics is pure + tested;
  // clipboard write mirrors the address-bar copyUrl idiom (silent on failure).
  const [diagCopied, setDiagCopied] = useState(false);
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
    void navigator.clipboard?.writeText(text).then(
      () => {
        setDiagCopied(true);
        window.setTimeout(() => setDiagCopied(false), 1200);
      },
      () => {
        /* clipboard blocked — silent */
      },
    );
  };
  const [landscape, setLandscape] = useState(false);
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
  const [toolbarExpanded, setToolbarExpanded] = useState<boolean>(() => {
    try {
      return localStorage.getItem('ds-sim-navigated') !== '1';
    } catch {
      return false;
    }
  });
  // Option B — extra window width contributed by the open right DRAWER. Kept
  // current every render (like landscapeRef) so the window-sizing closures
  // (fitWindow / resetToActualSize / the onResized aspect-lock / refitForDrawer)
  // ALWAYS read the live value without re-subscribing. Window width = phoneW +
  // drawerExtra; phone dims are derived from (windowWidth − drawerExtra).
  const drawerExtraRef = useRef(0);
  drawerExtraRef.current = toolbarExpanded ? DRAWER_W : 0;

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
  // Landscape ref kept current every render so the window-sizing closures (fitWindow
  // + the onResized listener) use the ROTATED aspect — else rotate snaps back to a
  // portrait sliver (audit B2/B3). Declared here (before fitWindow) so those
  // closures can read it.
  const landscapeRef = useRef(false);
  landscapeRef.current = landscape;
  // The window-sizing aspect: inverted when rotated to landscape.
  const sizingAspect = (): number =>
    landscapeRef.current ? 1 / deviceAspectRef.current : deviceAspectRef.current;
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
      const chrome = TOOLBAR_H + (browserModeOn ? BROWSER_BAR_H : 0) + BEZEL_PAD + STATUS_STRIP_H;
      // The device screen-area must match the video aspect or the video
      // object-contains with side gaps. Height for a phone width = chrome + (w-bezel)/aspect.
      // First pass: ask for that height, pre-capped to the screen work area (a hint).
      const avail = typeof window !== 'undefined' ? (window.screen?.availHeight ?? 0) : 0;
      let height = Math.round(chrome + (phoneW - BEZEL_PAD) / aspect);
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
      const chrome = TOOLBAR_H + (browserMode ? BROWSER_BAR_H : 0) + BEZEL_PAD + STATUS_STRIP_H;
      // Target device-content width = the iPhone CSS-logical width (its long edge
      // when rotated to landscape), then the window adds the bezel padding + (if
      // open) the right drawer's fixed width.
      const drawerExtra = drawerExtraRef.current;
      const targetContentW = landscapeRef.current
        ? Math.round(DEVICE_LOGICAL_WIDTH / deviceAspectRef.current)
        : DEVICE_LOGICAL_WIDTH;
      const phoneW = targetContentW + BEZEL_PAD;
      let width = phoneW + drawerExtra;
      let height = Math.round(chrome + (phoneW - BEZEL_PAD) / aspect);
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
  // Option B — widen/narrow the window by DRAWER_W when the drawer opens/closes.
  // HEIGHT-driven (keep the height, re-derive the phone width, add the drawer) —
  // distinct from the width-preserving fitWindow, which would mis-read the phone
  // width on toggle (curWidth still reflects the OLD drawer state). The onResized
  // aspect-lock uses the same needW formula, so it reads this as on-aspect → no fight.
  const refitForDrawer = (): void => {
    void withCurrentWindow(async (win) => {
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const factor = await win.scaleFactor();
      const size = await win.innerSize();
      const h = Math.round(size.height / factor);
      const aspect = sizingAspect();
      const chrome = TOOLBAR_H + (browserMode ? BROWSER_BAR_H : 0) + BEZEL_PAD + STATUS_STRIP_H;
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
  useEffect(() => {
    if (info === null) return;
    const t = window.setTimeout(() => fitWindow(browserMode), 0);
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

  // Option B — widen/narrow the window when the right drawer opens/closes
  // (drawerExtraRef is already updated render-time before this effect fires). Runs
  // after paint so the aside's layout width is applied first.
  useEffect(() => {
    if (info === null) return;
    const t = window.setTimeout(() => refitForDrawer(), 0);
    return () => window.clearTimeout(t);
  }, [toolbarExpanded, info]);

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
                const chrome =
                  TOOLBAR_H + (browserMode ? BROWSER_BAR_H : 0) + BEZEL_PAD + STATUS_STRIP_H;
                // Window width = phone width (aspect-locked to the height) + the open
                // drawer's fixed width, so a manual resize scales the PHONE and never
                // eats the drawer.
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

  // Live page state from the device (A3 page_state over the LiveKit data channel,
  // bus W2719) — drives the browser-mode address bar's live URL + loading bar.
  // Until the harness emits it, onNavigate optimistically shows a loading sweep
  // that a watchdog clears (graceful fallback).
  const [liveUrl, setLiveUrl] = useState('');
  const [pageLoading, setPageLoading] = useState(false);
  const [loadProgress, setLoadProgress] = useState<number | null>(null);
  const loadWatchdogRef = useRef<number | null>(null);
  // Timestamp of the last operator navigate. The ~2s page-state poll can fire before
  // the box has seen a just-submitted navigate and would read the PREVIOUS page as
  // 'loaded' → kill the optimistic spinner instantly (audit wqhvarsb9). For a short
  // grace after a navigate, the poll won't turn loading OFF (the watchdog still
  // bounds it), so the loading bar survives until the box reports the new page.
  const lastNavAtRef = useRef(0);
  const clearLoadWatchdog = (): void => {
    if (loadWatchdogRef.current !== null) {
      window.clearTimeout(loadWatchdogRef.current);
      loadWatchdogRef.current = null;
    }
  };
  useEffect(() => () => clearLoadWatchdog(), []);
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
        };
        // Accept BOTH the proposed {type:'page_state', url, loading, progress}
        // envelope AND A3's shipped HarnessOutbound.PageState {sessionId, state,
        // url, error} where state ∈ loading|loaded|errored (bus W2717-done). The
        // box emits the latter over THIS data channel on navigate; prod's
        // page-state REST endpoint is stubbed, so the channel is the only live
        // source — keying only on type:'page_state' silently dropped every event.
        const isHarnessState =
          msg.state === 'loading' || msg.state === 'loaded' || msg.state === 'errored';
        if (msg.type !== 'page_state' && !isHarnessState) return;
        if (typeof msg.url === 'string' && msg.url !== '') setLiveUrl(msg.url);
        const loading = isHarnessState ? msg.state === 'loading' : msg.loading;
        if (typeof loading === 'boolean') {
          setPageLoading(loading);
          if (!loading) clearLoadWatchdog();
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
  }, [room]);

  // Live URL via the page-state API (A3 W2730): the box reports pageState over the
  // CONTROL PLANE (→ server sessionPageStateStore), NOT the LiveKit data channel —
  // which is why the data-channel consumer above never populated it. The founder
  // asked the API to expose the URL; this POLLS GET /v1/agent-sessions/:id/
  // page-state (~2s) so the address bar shows the device's actual current URL
  // (including the first page it opens + redirects). Best-effort + guarded; null
  // until the box reports. BrowserBar won't clobber what the operator is typing.
  useEffect(() => {
    if (sessionId === '' || room === null || !browserMode) return;
    let cancelled = false;
    const tick = (): void => {
      void getAgentSessionPageState(sessionId, controlAuth)
        .then((ps) => {
          if (cancelled || ps === null) return;
          if (typeof ps.url === 'string' && ps.url !== '') setLiveUrl(ps.url);
          const loading = ps.state === 'loading';
          // Don't let a stale 'loaded' (the box hasn't seen our just-submitted
          // navigate yet) kill the optimistic spinner. Within the grace window after
          // a navigate, only ESCALATE to loading; the 6s watchdog still bounds it.
          if (!loading && Date.now() - lastNavAtRef.current < 2500) return;
          setPageLoading(loading);
          if (!loading) clearLoadWatchdog();
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
  }, [sessionId, controlAuth, room, browserMode]);

  // Founder #48 — live cookie-jar view. Polls GET /v1/agent-sessions/:id/cookies
  // ONLY while the session-info / diagnostics panel is open (no background load on
  // a panel nobody's looking at). `cookies` = the live jar (ok); `cookiesNote` = a
  // calm "pending data source" line for every inert state (control plane off /
  // node offline / node not yet serving cookies / gated 503). Best-effort + guarded
  // — a transient/gated failure just keeps the pending note, never throws.
  const [cookies, setCookies] = useState<SessionCookie[] | null>(null);
  const [cookiesNote, setCookiesNote] = useState<string | null>(null);
  useEffect(() => {
    if (!toolbarExpanded || sessionId === '' || room === null) return;
    let cancelled = false;
    const tick = (): void => {
      void getAgentSessionCookies(sessionId, controlAuth)
        .then((res) => {
          if (cancelled) return;
          if (res.status === 'ok') {
            setCookies(res.cookies ?? []);
            setCookiesNote(null);
          } else {
            setCookies(null);
            setCookiesNote(
              res.status === 'timeout'
                ? 'waiting for the device…'
                : (res.reason ?? 'not available yet'),
            );
          }
        })
        .catch(() => {
          if (cancelled) return;
          // Gated 503 / 404 / network — the cookies view isn't live on this
          // build/box yet. Show the calm pending note rather than an error.
          setCookies(null);
          setCookiesNote('pending — live cookie view ships with the next device update');
        });
    };
    tick();
    const handle = window.setInterval(tick, 3000);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [toolbarExpanded, sessionId, controlAuth, room]);

  // iOS TAP cursor (founder 2026-06-17: "standard is full control + iOS TAP
  // cursor"): a short-lived ring at the tap point, so a click on the screen
  // reads as a deliberate iOS touch. Capture-phase + purely visual (never
  // preventDefault/stopPropagation) so the real tap still reaches the device's
  // input-capture untouched.
  const screenHostRef = useRef<HTMLDivElement | null>(null);
  const tapIdRef = useRef(0);
  const [taps, setTaps] = useState<{ id: number; x: number; y: number }[]>([]);
  const showTap = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const host = screenHostRef.current;
    if (host === null) return;
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (r.width === 0 || x < 0 || y < 0 || x > r.width || y > r.height) return;
    // Press feedback for the touch-point cursor — it shrinks/brightens on press,
    // alongside the bloom ring below (resets on pointer up / leave).
    setTouchPoint({ x, y });
    setTouchPressed(true);
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
  const [touchPoint, setTouchPoint] = useState<{ x: number; y: number } | null>(null);
  const [touchPressed, setTouchPressed] = useState(false);
  const moveTouchPoint = (e: ReactPointerEvent<HTMLDivElement>): void => {
    const host = screenHostRef.current;
    if (host === null) return;
    const r = host.getBoundingClientRect();
    const x = e.clientX - r.left;
    const y = e.clientY - r.top;
    if (r.width === 0 || x < 0 || y < 0 || x > r.width || y > r.height) {
      setTouchPoint(null);
      return;
    }
    setTouchPoint({ x, y });
  };
  const hideTouchPoint = (): void => {
    setTouchPoint(null);
    setTouchPressed(false);
  };
  // Session control (founder 2026-06-18): Mode segmented control + contextual
  // takeover/handback + a "tell the agent" composer in the expandable panel.
  // SimulatorWindow has no SDK client → lib/agent-session-control raw-fetches
  // (reads {apiKey,baseUrl} via loadSettings). null mode = not loaded yet.
  const [controlMode, setControlMode] = useState<SessionMode | null>(null);
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
      void stopRecording(activeRecIdRef.current);
      activeRecIdRef.current = null;
    }
    setControlMode(null);
    setPairKind(null);
    setLiveUrl('');
    setPageLoading(false);
    setLoadProgress(null);
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
        setPairKind(s.pairKind);
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
  // Seed on mount + re-read whenever the panel opens (cheap, no idle polling).
  useEffect(() => {
    refreshControl();
  }, [refreshControl, toolbarExpanded]);
  // Closing the simulator window is MODE-AWARE (founder 2026-06-18): in MANUAL
  // mode the human IS the session, so closing the phone ENDS it (the worker
  // tears down the browser/fork — "close the phone → it really stops"). In
  // ai/pair (agent-driven) modes the agent keeps working in the background, so
  // closing just hides the window — the session keeps running and can be
  // reopened (the profile-row "Live view"). Unknown/null mode (controls never
  // loaded) is treated as NON-manual: never silently kill a session we can't
  // confirm is human-only. Covers the toolbar close button (window.close fires
  // this) AND the OS close. The MANUAL path preventDefaults + races a 2s timeout
  // so a slow/failed end can never wedge the window open; destroy() then closes
  // without re-firing. controlMode is in the deps so the handler always sees the
  // current mode (the listener re-registers on a mode switch — same pattern as
  // controlAuth). Declared AFTER the control state so controlMode is in scope.
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
        // Manual → end the session before closing; agent-driven (ai/pair) or
        // unknown → close immediately and leave the session running.
        if (controlMode === 'manual') {
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
  }, [sessionId, controlAuth, controlMode]);
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
  const onEndSession = (): void => {
    if (sessionId === '' || controlBusy) return;
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
    // First successful navigate: stop auto-opening the controls panel on launch
    // (the Address bar has been discovered + used). See toolbarExpanded init.
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
    lastNavAtRef.current = Date.now();
    clearLoadWatchdog();
    loadWatchdogRef.current = window.setTimeout(() => {
      setPageLoading(false);
      loadWatchdogRef.current = null;
    }, 6000);
    void sendNavigate(room, url).catch(() => {
      setNotice('Navigation could not be sent');
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
  }, [info?.ws_url, info?.token]);

  // The stream reported its REAL pixel dimensions (the archetype's screen
  // resolution): resize the window so the frame matches the device's true
  // proportions — width stays put (no jump under the cursor), height derives
  // from the aspect + the fixed chrome (toolbar / bezel / status strip).
  // Works for ANY archetype — nothing per-device hardcoded.
  const handleVideoDimensions = (w: number, h: number): void => {
    if (sizedToStreamRef.current || w <= 0 || h <= 0) return;
    sizedToStreamRef.current = true;
    deviceAspectRef.current = w / h;
    // Fit ONCE to the real device aspect + the current chrome, in EITHER orientation —
    // fitWindow's sizingAspect inverts for landscape. The old early-return on landscape
    // dropped the aspect entirely → the window stayed at the seeded 402/874 and letterboxed
    // permanently (audit #4: landscape-at-first-frame / in-place relaunch while rotated).
    fitWindow(browserMode);
  };

  // Rotate: swap the window's width/height so the bezel reflows to the new
  // orientation (the screen object-contains, so the video re-letterboxes). The
  // device-side orientation change is a harness follow-up; this is the window/
  // frame rotate. No-op outside Tauri.
  const toggleRotate = (): void => {
    const next = !landscape;
    setLandscape(next);
    void withCurrentWindow(async (w) => {
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const size = await w.innerSize();
      const factor = await w.scaleFactor();
      const lw = size.width / factor;
      const lh = size.height / factor;
      await w.setSize(new LogicalSize(Math.round(lh), Math.round(lw)));
    });
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
            expanded={toolbarExpanded}
            onToggleExpanded={() => setToolbarExpanded((v) => !v)}
            recording={recordingId !== null}
            onToggleRecord={toggleRecord}
            running={sessionId !== ''}
          />
          {browserMode && (
            <BrowserBar
              canNavigate={room !== null}
              onNavigate={onNavigate}
              liveUrl={liveUrl}
              pageLoading={pageLoading}
              loadProgress={loadProgress}
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
                    className="absolute left-1/2 top-12 z-20 -translate-x-1/2 rounded-full bg-black/80 px-3 py-1 font-mono text-[10px] text-white/90 backdrop-blur"
                  >
                    {notice}
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
                    className="absolute left-1/2 top-32 z-20 -translate-x-1/2 whitespace-nowrap rounded-full bg-rose-600/90 px-3 py-1 text-[10px] font-semibold text-white shadow"
                  >
                    ⚠ Slow link — video{' '}
                    {conn.relayed === true ? 'relayed' : `over ${conn.transport?.toUpperCase()}`}{' '}
                    (UDP blocked)
                  </div>
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
                  onPointerUp={() => setTouchPressed(false)}
                >
                  <AgentSessionPanel
                    info={info}
                    // The box hides the iOS-Safari URL bar fleet-wide
                    // (DRIFTSTACK_SAFARI_CHROME_HIDDEN, founder "remove the url bar");
                    // mask the ~110px freed band at the capture bottom (A3 W2784).
                    coverChromeBand
                    // Forward mouse/keyboard to the device only in manual/pair
                    // mode; in AI mode the agent is driving, so local input would
                    // fight it.
                    interactive={controlMode !== 'ai'}
                    onVideoDimensions={handleVideoDimensions}
                    onRoom={handleRoom}
                    onPublishError={() => setControlUnreachable(true)}
                    onVideoEl={(el) => {
                      videoElRef.current = el;
                      if (el !== null) armFpsCounter(el);
                    }}
                  />
                  {/* iOS touch-point cursor — a soft fingertip dot that tracks the
                    pointer over the screen (the PC arrow is hidden via cursor-none
                    on the host). Shrinks + brightens on press. pointer-events-none
                    so it never intercepts the real tap. */}
                  {touchPoint !== null && controlMode !== 'ai' && (
                    <span
                      data-component="touch-cursor"
                      aria-hidden="true"
                      className={`ds-touch-dot pointer-events-none absolute z-20 ${
                        touchPressed ? 'ds-touch-dot--pressed' : ''
                      }`}
                      style={{ left: touchPoint.x, top: touchPoint.y }}
                    />
                  )}
                  {/* iOS tap cursor — a ring that blooms at each tap point then
                    fades. pointer-events-none so it never intercepts the tap. */}
                  {taps.map((t) => (
                    <span
                      key={t.id}
                      data-component="tap-ripple"
                      aria-hidden="true"
                      className="ds-tap-ring pointer-events-none absolute z-20 h-9 w-9 rounded-full border-2 border-white/80"
                      style={{ left: t.x, top: t.y }}
                    />
                  ))}
                </div>
              </div>
            </div>
            {/* Option B right DRAWER (founder 2026-06-23) — revealed by the chevron;
              the window widens by DRAWER_W so the rail sits beside the phone, not
              over it. Sections: Session · Controls · Diagnostics(✕) · Cookies · End.
              NOT a drag region (its controls must be clickable); scrolls when the
              rail is taller than the phone. */}
            {toolbarExpanded && (
              <aside
                data-tauri-drag-region="false"
                data-component="simulator-drawer"
                className="flex w-[264px] shrink-0 flex-col gap-2.5 overflow-y-auto border-l border-white/[0.12] bg-[#1d1e24] p-2.5 text-[11.5px]"
              >
                {/* Session — mode switch + (ai/pair) the agent composer. The rail is
                  wider than the old dropdown, so this IS the "bigger AI chat". */}
                <section
                  data-component="drawer-session"
                  className="shrink-0 rounded-lg bg-black/20 pb-1"
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

                {/* Controls — the address bar (non-browser-mode) + window toggles. */}
                <section
                  data-component="drawer-controls"
                  className="shrink-0 rounded-lg bg-black/20 py-1"
                >
                  <div className="px-3 pb-0.5 pt-1 font-sans text-[11px] font-semibold text-white/90">
                    Controls
                  </div>
                  {!browserMode && (
                    <NavigateAddressBar canNavigate={room !== null} onNavigate={onNavigate} />
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

                {/* Diagnostics — the session facts + Copy; ✕ closes the drawer
                  (founder: "there's no close diagnostics"). */}
                <section
                  data-component="drawer-diagnostics"
                  className="shrink-0 rounded-lg bg-black/20 p-3 font-mono text-[10px] leading-relaxed text-white/80"
                >
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-sans text-[11px] font-semibold text-white">
                      Diagnostics
                    </span>
                    <button
                      type="button"
                      aria-label="Close drawer"
                      title="Close"
                      onClick={() => setToolbarExpanded(false)}
                      className="-mr-1 rounded px-1 text-[13px] leading-none text-white/50 transition hover:bg-white/10 hover:text-white"
                    >
                      ✕
                    </button>
                  </div>
                  {profileName !== '' && <div className="truncate">profile {profileName}</div>}
                  <div className="truncate">device {deviceName}</div>
                  <div className="truncate">
                    link {info ? wsHost(info.ws_url) : 'not connected'}
                  </div>
                  {proxyLabel !== '' && <div className="truncate">egress 🌍 {proxyLabel}</div>}
                  <div className="truncate">
                    {fps !== null && <span>{fps} fps · </span>}
                    latency{' '}
                    {latency.rttMs !== null ? (
                      <span className={latency.rttMs < 150 ? 'text-emerald-300' : 'text-amber-300'}>
                        {latency.rttMs} ms
                      </span>
                    ) : conn.rttMs !== null ? (
                      <span className={conn.rttMs < 150 ? 'text-emerald-300' : 'text-amber-300'}>
                        {conn.rttMs} ms (link)
                      </span>
                    ) : (
                      <span className="text-white/50">measuring…</span>
                    )}
                  </div>
                  <div className="truncate">
                    transport{' '}
                    {conn.transport !== null ? (
                      <span
                        className={
                          conn.transport === 'udp' && conn.relayed !== true
                            ? 'text-emerald-300'
                            : 'text-rose-300'
                        }
                      >
                        {conn.transport}
                        {conn.relayed ? ' · relay ⚠' : ' · direct'}
                      </span>
                    ) : (
                      <span className="text-white/50">measuring…</span>
                    )}
                  </div>
                  {(conn.decodeFps !== null ||
                    conn.packetLossPct !== null ||
                    conn.freezeCount !== null) && (
                    <div className="truncate text-white/70">
                      {conn.decodeFps !== null && <span>decode {conn.decodeFps} fps · </span>}
                      {conn.packetLossPct !== null && (
                        <span className={conn.packetLossPct > 1 ? 'text-amber-300' : ''}>
                          loss {conn.packetLossPct}% ·{' '}
                        </span>
                      )}
                      {conn.jitterMs !== null && <span>jitter {conn.jitterMs}ms · </span>}
                      {conn.freezeCount !== null && (
                        <span className={conn.freezeCount > 0 ? 'text-amber-300' : ''}>
                          freezes {conn.freezeCount}
                        </span>
                      )}
                    </div>
                  )}
                  <div className="mt-1.5 border-t border-white/15 pt-1.5">
                    <div className="font-sans text-[11px] font-semibold text-white">Identity</div>
                    <div className="truncate">engine-deep · bit-exact device</div>
                    <div className="truncate">input human-cadence native</div>
                    <div className="truncate text-white/40">
                      build {typeof __BUILD_STAMP__ !== 'undefined' ? __BUILD_STAMP__ : 'dev'}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-action="copy-diagnostics"
                    onClick={copyDiagnostics}
                    className="mt-1.5 w-full rounded border border-white/15 px-2 py-1 text-center font-sans text-[10px] text-white/70 transition hover:bg-white/10 hover:text-white"
                  >
                    {diagCopied ? 'Copied ✓' : 'Copy diagnostics'}
                  </button>
                </section>

                {/* Cookies — live jar for the current page (httpOnly included), pulled
                  over the control plane; "pending" until the device build serves it.
                  Cross-domain whole-jar arrives later ("this page" → "all"). */}
                <section
                  data-component="simulator-cookies"
                  className="shrink-0 rounded-lg bg-black/20 p-3 font-mono text-[10px] leading-relaxed text-white/80"
                >
                  <div className="mb-0.5 flex items-center justify-between">
                    <span className="font-sans text-[11px] font-semibold text-white">
                      Cookies
                      {cookies !== null && (
                        <span className="text-white/40"> · {cookies.length}</span>
                      )}
                    </span>
                    <span className="font-sans text-[9px] text-white/30">this page</span>
                  </div>
                  {cookies === null ? (
                    <div className="text-white/40">{cookiesNote ?? 'loading…'}</div>
                  ) : cookies.length === 0 ? (
                    <div className="text-white/40">no cookies on this page</div>
                  ) : (
                    <div className="max-h-40 space-y-0.5 overflow-y-auto pr-1">
                      {cookies.map((c, i) => (
                        <div key={`${c.domain}|${c.name}|${i}`} className="truncate">
                          <span className="text-white/50">{c.domain}</span>{' '}
                          <span className="text-emerald-300/80">{c.name}</span>
                          <span className="text-white/30">=</span>
                          <span className="text-white/70">{c.value}</span>
                          {c.httpOnly === true && (
                            <span className="text-white/30"> · httpOnly</span>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </section>

                {/* Explicit Stop/End — a true Stop (distinct from window-close, which
                  only HIDES the window in ai/pair). controlBusy gates a double-DELETE. */}
                {sessionId !== '' && (
                  <button
                    type="button"
                    aria-label="End session"
                    title="End the session — stops the worker and tears down the browser"
                    disabled={controlBusy}
                    onClick={onEndSession}
                    className="flex w-full shrink-0 items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11.5px] text-red-300 transition-colors hover:bg-red-500/20 disabled:opacity-50"
                  >
                    <span aria-hidden="true">{controlBusy ? '…' : '◼'}</span>
                    <span>{controlBusy ? 'Ending…' : 'End session'}</span>
                  </button>
                )}
              </aside>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
