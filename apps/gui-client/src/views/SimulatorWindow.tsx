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

import { useEffect, useRef, useState } from 'react';
import type { WebviewWindow } from '@tauri-apps/api/webviewWindow';
import type { LiveKitInfo } from '@driftstack/sdk';
import type { Room } from '../lib/livekit';
import { useLatencyPing } from '../lib/livekit-latency-ping';
import { useRecordings } from '../lib/recordings';
import { AgentSessionPanel } from '../components/AgentSessionPanel';

/** Frame chrome heights (px) used to derive the window size from the device's
 *  real screen aspect: toolbar above the bezel, the bezel's p-[10px] padding,
 *  and the in-screen status strip the video sits below. */
const TOOLBAR_H = 34;
const BEZEL_PAD = 20; // p-[10px] × 2
const STATUS_STRIP_H = 40;

function infoFromQuery(): {
  info: LiveKitInfo | null;
  deviceName: string;
  profileName: string;
  proxyLabel: string;
  sessionId: string;
} {
  const q = new URLSearchParams(window.location.search);
  const ws_url = q.get('ws');
  const token = q.get('token');
  const deviceName = q.get('name') ?? 'iPhone';
  const profileName = q.get('profile') ?? '';
  const proxyLabel = q.get('proxy') ?? '';
  const sessionId = q.get('session') ?? '';
  if (ws_url === null || token === null || ws_url === '' || token === '') {
    return { info: null, deviceName, profileName, proxyLabel, sessionId };
  }
  // LiveKitInfo carries ws_url + token (the only fields the panel/connect read);
  // room_name is informational. Cast is safe — the panel reads ws_url/token only.
  return {
    info: { ws_url, token, room_name: q.get('room') ?? '' } as unknown as LiveKitInfo,
    deviceName,
    profileName,
    proxyLabel,
    sessionId,
  };
}

/** Tauri-only window ops, dynamically imported on use so the jsdom tests (no
 *  Tauri) never load the native module. No-op outside Tauri. */
async function withCurrentWindow(fn: (w: WebviewWindow) => Promise<void>): Promise<void> {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  await fn(getCurrentWebviewWindow());
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
/** The Drift mark — three offset drift strokes (layers sliding past each
 *  other), in the brand accent. Minimal enough to read at 14px. */
function DriftMark(): JSX.Element {
  return (
    <svg
      data-component="drift-mark"
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="3"
      strokeLinecap="round"
      className="text-accent"
      aria-hidden="true"
    >
      <path d="M4 6h13" />
      <path d="M7 12h13" />
      <path d="M4 18h10" />
    </svg>
  );
}

export function DeviceToolbar({
  deviceName,
  profileName,
  landscape,
  pinned,
  infoOpen,
  expanded,
  onToggleRotate,
  onTogglePinned,
  onToggleInfo,
  onToggleExpanded,
  onSnapshot,
  recording,
  onToggleRecord,
}: {
  deviceName: string;
  profileName: string;
  landscape: boolean;
  pinned: boolean;
  infoOpen: boolean;
  expanded: boolean;
  onToggleRotate: () => void;
  onTogglePinned: () => void;
  onToggleInfo: () => void;
  onToggleExpanded: () => void;
  onSnapshot: () => void;
  recording: boolean;
  onToggleRecord: () => void;
}): JSX.Element {
  return (
    <div
      data-tauri-drag-region
      data-component="simulator-toolbar-wrap"
      className="relative w-full shrink-0"
    >
      <div
        data-tauri-drag-region
        data-component="simulator-toolbar"
        className="flex h-[34px] w-full items-center justify-between rounded-t-[14px] bg-[#161618] px-3 ring-1 ring-white/10"
      >
        {/* Left — window controls (the window is borderless, so these ARE the
            only way to close/minimize it). */}
        <div data-tauri-drag-region="false" className="flex items-center gap-2">
          <button
            type="button"
            aria-label="Close"
            title="Close"
            onClick={() => void withCurrentWindow((w) => w.close())}
            className="h-3 w-3 rounded-full bg-[#ff5f57] ring-1 ring-black/20 transition hover:brightness-110"
          />
          <button
            type="button"
            aria-label="Minimize"
            title="Minimize"
            onClick={() => void withCurrentWindow((w) => w.minimize())}
            className="h-3 w-3 rounded-full bg-[#febc2e] ring-1 ring-black/20 transition hover:brightness-110"
          />
        </div>
        {/* Center — Drift mark + identity: the profile this phone runs as
            (primary) and the device (muted). Profile-less → device only. */}
        <div
          data-tauri-drag-region
          className="pointer-events-none absolute left-1/2 flex -translate-x-1/2 items-center gap-1.5"
        >
          <DriftMark />
          <span className="max-w-[140px] truncate text-2xs font-semibold tracking-tight text-ink-secondary">
            {profileName !== '' ? profileName : deviceName}
          </span>
          {profileName !== '' && (
            <span className="text-2xs tracking-tight text-ink-muted">· {deviceName}</span>
          )}
        </div>
        {/* Right — quick Record + the expand chevron. The window-controls
            (snapshot / rotate / pin / info) live in the expandable panel below
            so the default chrome stays minimal (founder 2026-06-17: "phone
            showing only" by default, a clean expandable row for the controls). */}
        <div data-tauri-drag-region="false" className="flex items-center gap-1 text-ink-muted">
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
              <path d="M6 9l6 6 6-6" />
            </svg>
          </button>
        </div>
      </div>
      {/* Expandable control panel — an ABSOLUTE dropdown so it never changes the
          toolbar height (the window-sizing math in handleVideoDimensions depends
          on the fixed TOOLBAR_H). Clear LABELLED rows, led by the control-mode
          line so the default "full control + iOS tap" is obvious. */}
      {expanded && (
        <div
          data-tauri-drag-region="false"
          data-component="simulator-controls"
          className="absolute right-2 top-full z-30 mt-1 w-56 overflow-hidden rounded-xl border border-white/10 bg-[#161618] py-1 shadow-[0_14px_34px_rgba(0,0,0,0.6)]"
        >
          <div className="flex items-center gap-2 px-3 py-2 text-[11px]">
            <span className="text-accent" aria-hidden="true">
              ◉
            </span>
            <span className="font-semibold text-ink-primary">Full control</span>
            <span className="text-ink-muted">· tap the screen to interact</span>
          </div>
          <div className="mx-3 mb-1 h-px bg-white/10" aria-hidden="true" />
          <LabeledControl
            label="Save snapshot"
            hint="Save a PNG of the current frame"
            onClick={onSnapshot}
            glyph={<span className="text-[13px] leading-none">⤓</span>}
          />
          <LabeledControl
            label={landscape ? 'Rotate to portrait' : 'Rotate to landscape'}
            active={landscape}
            onClick={onToggleRotate}
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
            onClick={onTogglePinned}
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
          <LabeledControl
            label="Session info"
            active={infoOpen}
            onClick={onToggleInfo}
            glyph={<span className="text-[13px] leading-none">ⓘ</span>}
          />
        </div>
      )}
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
        className="pointer-events-none absolute left-1/2 top-1/2 h-[26px] w-[88px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-[#060607] ring-1 ring-white/10"
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
  const { info, deviceName, profileName, proxyLabel, sessionId } = infoFromQuery();
  // Night-arc I Record pill: frames straight off the live <video> element
  // (the WebRTC stream IS the device screen) into the shared recordings
  // store — 1fps JPEG, same bounded-buffer semantics as the main window.
  const { startRecording, stopRecording, addFrame, activeRecordingFor } = useRecordings();
  const recordingId = sessionId !== '' ? activeRecordingFor(sessionId) : null;
  const recordTimerRef = useRef<number | null>(null);
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
      setSnapshotNotice('Recording saved');
      window.setTimeout(() => setSnapshotNotice(null), 4000);
      return;
    }
    const recId = startRecording(sessionId, profileName !== '' ? profileName : undefined);
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
  const [snapshotNotice, setSnapshotNotice] = useState<string | null>(null);
  // Night-arc I (cockpit pills): Snapshot — draw the CURRENT live frame to
  // a canvas and save a PNG into ~/Downloads via the fs plugin (no native
  // screenshot API needed; the WebRTC frame IS the device screen).
  async function handleSnapshot(): Promise<void> {
    const el = videoElRef.current;
    if (el === null || el.videoWidth === 0) {
      setSnapshotNotice('No frame yet');
      return;
    }
    try {
      const canvas = document.createElement('canvas');
      canvas.width = el.videoWidth;
      canvas.height = el.videoHeight;
      canvas.getContext('2d')?.drawImage(el, 0, 0);
      const dataUrl = canvas.toDataURL('image/png');
      const bytes = Uint8Array.from(atob(dataUrl.split(',')[1] ?? ''), (c) => c.charCodeAt(0));
      const { writeFile, BaseDirectory } = await import('@tauri-apps/plugin-fs');
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const file = `driftstack-${profileName !== '' ? profileName : deviceName}-${stamp}.png`;
      await writeFile(file, bytes, { baseDir: BaseDirectory.Download });
      setSnapshotNotice(`Saved ${file} to Downloads`);
    } catch (err) {
      setSnapshotNotice(err instanceof Error ? err.message : 'Snapshot failed');
    }
    window.setTimeout(() => setSnapshotNotice(null), 4000);
  }
  const latency = useLatencyPing({ room, enabled: room !== null });
  const [landscape, setLandscape] = useState(false);
  // Pin = always-on-top (the floating-iPhone default). Unpinned the window
  // behaves like a normal sibling window (Cmd+` cycling, Mission Control,
  // doesn't hover over other apps) — the strongest separate-window identity
  // macOS allows inside one app (a per-window Dock icon needs a helper app
  // bundle — scoped as a post-launch item).
  const [pinned, setPinned] = useState(true);
  // Cockpit info overlay (demo-concepts arc): session facts at a glance.
  const [infoOpen, setInfoOpen] = useState(false);
  // Expandable control panel — collapsed by default so the window is phone-only
  // (founder 2026-06-17); the chevron reveals the labelled control rows.
  const [toolbarExpanded, setToolbarExpanded] = useState(false);
  const togglePinned = (): void => {
    const next = !pinned;
    setPinned(next);
    void withCurrentWindow((w) => w.setAlwaysOnTop(next));
  };
  const landscapeRef = useRef(false);
  landscapeRef.current = landscape;
  // Resize-to-archetype runs ONCE per window (first real video dimensions) so
  // it never fights the user's manual resize or the rotate toggle.
  const sizedToStreamRef = useRef(false);

  // The stream reported its REAL pixel dimensions (the archetype's screen
  // resolution): resize the window so the frame matches the device's true
  // proportions — width stays put (no jump under the cursor), height derives
  // from the aspect + the fixed chrome (toolbar / bezel / status strip).
  // Works for ANY archetype — nothing per-device hardcoded.
  const handleVideoDimensions = (w: number, h: number): void => {
    if (sizedToStreamRef.current || landscapeRef.current || w <= 0 || h <= 0) return;
    sizedToStreamRef.current = true;
    void withCurrentWindow(async (win) => {
      const { LogicalSize } = await import('@tauri-apps/api/dpi');
      const size = await win.innerSize();
      const factor = await win.scaleFactor();
      const width = Math.round(size.width / factor);
      const screenW = width - BEZEL_PAD;
      const height = Math.round(TOOLBAR_H + BEZEL_PAD + STATUS_STRIP_H + screenW * (h / w));
      await win.setSize(new LogicalSize(width, height));
    });
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
        <div className="rounded-xl bg-black/80 px-4 py-3 text-sm text-ink-primary">
          No session — open this window from a launched profile.
        </div>
      ) : (
        <div data-component="simulator-shell" className="flex h-full w-full flex-col">
          <DeviceToolbar
            deviceName={deviceName}
            profileName={profileName}
            landscape={landscape}
            pinned={pinned}
            infoOpen={infoOpen}
            expanded={toolbarExpanded}
            onToggleRotate={toggleRotate}
            onTogglePinned={togglePinned}
            onToggleInfo={() => setInfoOpen((v) => !v)}
            onToggleExpanded={() => setToolbarExpanded((v) => !v)}
            onSnapshot={() => void handleSnapshot()}
            recording={recordingId !== null}
            onToggleRecord={toggleRecord}
          />
          {/* Device body — the bezel. data-tauri-drag-region makes the frame a
              window-drag handle; the inner screen overrides it so taps reach the
              device. flex-1 fills the height below the toolbar. */}
          <div
            data-tauri-drag-region
            data-component="simulator-device"
            className="relative flex min-h-0 flex-1 w-full flex-col rounded-b-[2.75rem] bg-[#0b0b0d] p-[10px] shadow-2xl ring-1 ring-white/10"
          >
            {/* Screen — status strip on top (with the dynamic island), the live
                video BELOW it (never overlapped). NOT a drag region except the
                strip itself (taps on the video control the device). */}
            <div
              data-tauri-drag-region="false"
              data-component="simulator-screen"
              className="relative flex flex-1 flex-col overflow-hidden rounded-[2.1rem] bg-black"
            >
              <IosStatusBar />
              {snapshotNotice !== null && (
                <div
                  role="status"
                  className="absolute left-1/2 top-12 z-20 -translate-x-1/2 rounded-full bg-black/80 px-3 py-1 font-mono text-[10px] text-white/90 backdrop-blur"
                >
                  {snapshotNotice}
                </div>
              )}
              {infoOpen && (
                <div
                  data-component="simulator-info-overlay"
                  className="absolute right-2 top-12 z-10 w-52 rounded-lg border border-white/15 bg-black/80 p-3 font-mono text-[10px] leading-relaxed text-white/80 backdrop-blur"
                >
                  <div className="mb-1 font-sans text-[11px] font-semibold text-white">Session</div>
                  {profileName !== '' && <div className="truncate">profile {profileName}</div>}
                  <div className="truncate">device {deviceName}</div>
                  <div className="truncate">
                    link {info ? new URL(info.ws_url).host : 'not connected'}
                  </div>
                  {proxyLabel !== '' && <div className="truncate">egress 🌍 {proxyLabel}</div>}
                  <div className="truncate">
                    {fps !== null && <span>{fps} fps · </span>}
                    latency{' '}
                    {latency.rttMs !== null ? (
                      <span className={latency.rttMs < 150 ? 'text-emerald-300' : 'text-amber-300'}>
                        {latency.rttMs} ms
                      </span>
                    ) : (
                      <span className="text-white/50">measuring…</span>
                    )}
                  </div>
                  <div className="mt-1.5 border-t border-white/15 pt-1.5">
                    <div className="font-sans text-[11px] font-semibold text-white">Identity</div>
                    <div className="truncate">engine-deep · bit-exact device</div>
                    <div className="truncate">input human-cadence native</div>
                  </div>
                </div>
              )}
              <div className="relative min-h-0 flex-1">
                <AgentSessionPanel
                  info={info}
                  interactive
                  onVideoDimensions={handleVideoDimensions}
                  onRoom={setRoom}
                  onVideoEl={(el) => {
                    videoElRef.current = el;
                    if (el !== null) armFpsCounter(el);
                  }}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
