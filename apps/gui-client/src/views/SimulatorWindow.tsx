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
import { AgentSessionPanel } from '../components/AgentSessionPanel';

/** Frame chrome heights (px) used to derive the window size from the device's
 *  real screen aspect: toolbar above the bezel, the bezel's p-[10px] padding,
 *  and the in-screen status strip the video sits below. */
const TOOLBAR_H = 34;
const BEZEL_PAD = 20; // p-[10px] × 2
const STATUS_STRIP_H = 40;

function infoFromQuery(): { info: LiveKitInfo | null; deviceName: string; profileName: string } {
  const q = new URLSearchParams(window.location.search);
  const ws_url = q.get('ws');
  const token = q.get('token');
  const deviceName = q.get('name') ?? 'iPhone';
  const profileName = q.get('profile') ?? '';
  if (ws_url === null || token === null || ws_url === '' || token === '') {
    return { info: null, deviceName, profileName };
  }
  // LiveKitInfo carries ws_url + token (the only fields the panel/connect read);
  // room_name is informational. Cast is safe — the panel reads ws_url/token only.
  return {
    info: { ws_url, token, room_name: q.get('room') ?? '' } as unknown as LiveKitInfo,
    deviceName,
    profileName,
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

/** Capture the current live video frame to a PNG download. The <video> is the
 *  device screen rendered by AgentSessionPanel; we grab its natural-resolution
 *  pixels. No-op until a frame with real dimensions is playing. */
function captureScreenshot(deviceName: string): void {
  const video = document.querySelector('video');
  if (video === null || video.videoWidth === 0 || video.videoHeight === 0) return;
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  const slug = deviceName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  const a = document.createElement('a');
  a.href = canvas.toDataURL('image/png');
  a.download = `driftstack-${slug || 'device'}.png`;
  a.click();
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

function DeviceToolbar({
  deviceName,
  profileName,
  landscape,
  pinned,
  onToggleRotate,
  onTogglePinned,
  onToggleInfo,
}: {
  deviceName: string;
  profileName: string;
  landscape: boolean;
  pinned: boolean;
  onToggleRotate: () => void;
  onTogglePinned: () => void;
  onToggleInfo: () => void;
}): JSX.Element {
  return (
    <div
      data-tauri-drag-region
      data-component="simulator-toolbar"
      className="flex h-[34px] w-full shrink-0 items-center justify-between rounded-t-[14px] bg-[#161618] px-3 ring-1 ring-white/10"
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
      {/* Right — actions. */}
      <div data-tauri-drag-region="false" className="flex items-center gap-1.5 text-ink-muted">
        <button
          type="button"
          aria-label={pinned ? 'Unpin (stop floating on top)' : 'Pin on top'}
          title={pinned ? 'Unpin — behave like a normal window' : 'Pin — float above everything'}
          onClick={onTogglePinned}
          className={`rounded p-1 transition hover:bg-white/10 hover:text-ink-primary ${pinned ? 'text-accent' : ''}`}
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
          >
            <path d="M12 17v5" />
            <button
              type="button"
              aria-label="Session info"
              title="Session info"
              onClick={onToggleInfo}
              className="grid h-4 w-4 place-items-center rounded text-[10px] text-ink-muted transition hover:text-ink-primary"
            >
              ⓘ
            </button>
            <path d="M9 3h6l-1 7 3 3H7l3-3z" />
          </svg>
        </button>
        <button
          type="button"
          aria-label="Screenshot"
          title="Save a screenshot"
          onClick={() => captureScreenshot(deviceName)}
          className="rounded p-1 transition hover:bg-white/10 hover:text-ink-primary"
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
          >
            <path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z" />
            <circle cx="12" cy="13" r="4" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={landscape ? 'Rotate to portrait' : 'Rotate to landscape'}
          title="Rotate"
          onClick={onToggleRotate}
          className={`rounded p-1 transition hover:bg-white/10 hover:text-ink-primary ${landscape ? 'text-accent' : ''}`}
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
          >
            <path d="M23 4v6h-6" />
            <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
          </svg>
        </button>
      </div>
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
  const { info, deviceName, profileName } = infoFromQuery();
  const [landscape, setLandscape] = useState(false);
  // Pin = always-on-top (the floating-iPhone default). Unpinned the window
  // behaves like a normal sibling window (Cmd+` cycling, Mission Control,
  // doesn't hover over other apps) — the strongest separate-window identity
  // macOS allows inside one app (a per-window Dock icon needs a helper app
  // bundle — scoped as a post-launch item).
  const [pinned, setPinned] = useState(true);
  // Cockpit info overlay (demo-concepts arc): session facts at a glance.
  const [infoOpen, setInfoOpen] = useState(false);
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
            onToggleRotate={toggleRotate}
            onTogglePinned={togglePinned}
            onToggleInfo={() => setInfoOpen((v) => !v)}
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
                </div>
              )}
              <div className="relative min-h-0 flex-1">
                <AgentSessionPanel
                  info={info}
                  interactive
                  onVideoDimensions={handleVideoDimensions}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
