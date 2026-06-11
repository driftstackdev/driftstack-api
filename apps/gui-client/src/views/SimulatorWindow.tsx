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
            <AgentSessionPanel info={info} interactive />
          </div>
        </div>
      )}
    </div>
  );
}
