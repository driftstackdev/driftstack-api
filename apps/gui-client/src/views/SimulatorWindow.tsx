// Floating-iPhone simulator window (founder 2026-06-11: "really only an iPhone
// on your screen, with its frames... drag around... exactly like the Xcode
// Simulator").
//
// This renders in a SEPARATE borderless + transparent Tauri window (opened by
// lib/open-simulator.ts), so the only thing painted on the desktop is the
// device: a dark iPhone bezel with a dynamic island, the live session video as
// the screen, and direct control (click/type drives the real device via the
// LK.6.d input-capture). The bezel is a `data-tauri-drag-region`, so dragging
// the frame moves the window around the desktop — the screen itself is NOT a
// drag region (clicks there go to the device).
//
// Session join info (LiveKit ws_url + token) arrives via the window URL query
// — the opener encodes it when creating the window.

import { useEffect, useState } from 'react';
import type { LiveKitInfo } from '@driftstack/sdk';
import { AgentSessionPanel } from '../components/AgentSessionPanel';

function infoFromQuery(): LiveKitInfo | null {
  const q = new URLSearchParams(window.location.search);
  const ws_url = q.get('ws');
  const token = q.get('token');
  if (ws_url === null || token === null || ws_url === '' || token === '') return null;
  // LiveKitInfo carries ws_url + token (the only fields the panel/connect read);
  // room_name is informational. Cast is safe — the panel reads ws_url/token only.
  return { ws_url, token, room_name: q.get('room') ?? '' } as unknown as LiveKitInfo;
}

/** iOS-style h:mm (12-hour, no leading zero, no AM/PM — matches the iOS status
 *  bar). The streamed screen is web content with no device clock of its own. */
function formatStatusTime(d: Date): string {
  const hour = d.getHours() % 12 || 12;
  const minute = String(d.getMinutes()).padStart(2, '0');
  return `${hour}:${minute}`;
}

/** Live wall-clock for the status bar, refreshed well within a minute so the
 *  displayed minute is never visibly stale. */
function useStatusClock(): string {
  const [time, setTime] = useState(() => formatStatusTime(new Date()));
  useEffect(() => {
    const id = setInterval(() => setTime(formatStatusTime(new Date())), 15_000);
    return () => clearInterval(id);
  }, []);
  return time;
}

/**
 * Cosmetic iOS status bar — live clock on the left, cellular/Wi-Fi/battery
 * glyphs on the right, flanking the centered dynamic island (Xcode-Simulator
 * style). `pointer-events-none` so taps fall through to the device screen; a
 * faint drop-shadow keeps the white glyphs legible over arbitrary web content.
 */
function IosStatusBar(): JSX.Element {
  const time = useStatusClock();
  return (
    <div
      aria-hidden="true"
      data-component="simulator-statusbar"
      className="pointer-events-none absolute inset-x-0 top-0 z-20 flex h-[40px] items-center justify-between px-[24px] text-white [filter:drop-shadow(0_0_2px_rgba(0,0,0,0.45))]"
    >
      <span className="text-[14px] font-semibold tracking-tight tabular-nums">{time}</span>
      <div className="flex items-center gap-[6px]">
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
  const info = infoFromQuery();

  return (
    <div className="flex h-screen w-screen items-center justify-center bg-transparent">
      {info === null ? (
        <div className="rounded-xl bg-black/80 px-4 py-3 text-sm text-ink-primary">
          No session — open this window from a launched profile.
        </div>
      ) : (
        // Device body — the bezel. data-tauri-drag-region makes the whole frame
        // a window-drag handle; the inner screen overrides it so taps reach the
        // device. h-full/w-full fills the (phone-aspect-sized) window.
        <div
          data-tauri-drag-region
          data-component="simulator-device"
          className="relative flex h-full w-full flex-col rounded-[2.75rem] bg-[#0b0b0d] p-[10px] shadow-2xl ring-1 ring-white/10"
        >
          {/* Dynamic island — purely cosmetic; sits over the top of the screen. */}
          <div
            aria-hidden="true"
            data-tauri-drag-region
            className="pointer-events-none absolute left-1/2 top-[18px] z-10 h-[26px] w-[88px] -translate-x-1/2 rounded-full bg-black"
          />
          {/* Screen — the live video. NOT a drag region (taps control the
              device). object-contain inside the panel letterboxes if needed. */}
          <div
            data-tauri-drag-region="false"
            data-component="simulator-screen"
            className="relative flex-1 overflow-hidden rounded-[2.1rem] bg-black"
          >
            {/* iOS status bar overlay (cosmetic; the web video has none of its
                own). pointer-events-none → taps still reach the device. */}
            <IosStatusBar />
            <AgentSessionPanel info={info} interactive />
          </div>
        </div>
      )}
    </div>
  );
}
