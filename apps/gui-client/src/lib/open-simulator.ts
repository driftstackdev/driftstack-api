// Opens the floating-iPhone simulator window (founder 2026-06-11: a standalone,
// borderless, transparent, draggable iPhone — exactly like the Xcode Simulator).
//
// Creates a SEPARATE Tauri webview window (decorations off + transparent) sized
// to a phone, pointed at the SPA with `?window=simulator` + the LiveKit join
// info in the query so SimulatorWindow can connect. One window per session id
// (re-opening the same session focuses the existing one).
//
// macOS transparency requires `app.macOSPrivateApi: true` in tauri.conf.json.
// The simulator window's permissions are granted by the `simulator` capability.

import type { LiveKitInfo } from '@driftstack/sdk';

/** Phone-ish window size (px). The bezel + screen fill the window; the panel
 *  object-contains the stream so exact aspect isn't load-bearing. SIM_HEIGHT
 *  includes the ~34px Driftstack control toolbar above the device. */
const SIM_WIDTH = 330;
const SIM_HEIGHT = 684 + 34;

export interface OpenSimulatorArgs {
  sessionId: string;
  info: LiveKitInfo;
  /** Human device label shown in the toolbar (e.g. "iPhone 17"), derived from
   *  the profile's archetype. Defaults to "iPhone" when omitted. */
  deviceName?: string;
}

/** Open (or focus) the floating-iPhone window for a session. Returns true when
 *  a window was opened/focused, false when not running under Tauri (e.g. a
 *  browser dev preview) so callers can fall back to the in-app viewer. */
export async function openSimulatorWindow({
  sessionId,
  info,
  deviceName,
}: OpenSimulatorArgs): Promise<boolean> {
  // Tauri-only — guard so a browser preview doesn't throw on the dynamic import.
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return false;

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  // Stable, filesystem-safe label per session (window labels disallow most
  // punctuation; the ses_/agt_ prefix + uuid hyphens are fine).
  const label = `simulator-${sessionId}`;

  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing !== null) {
    await existing.setFocus().catch(() => undefined);
    return true;
  }

  const params = new URLSearchParams({
    window: 'simulator',
    ws: info.ws_url,
    token: info.token,
    // room_name is informational; include when present for the title/debug.
    room: (info as unknown as { room_name?: string }).room_name ?? '',
    // Device label for the toolbar (e.g. "iPhone 17").
    name: deviceName ?? 'iPhone',
  });

  const win = new WebviewWindow(label, {
    url: `index.html?${params.toString()}`,
    title: 'iPhone',
    width: SIM_WIDTH,
    height: SIM_HEIGHT,
    resizable: true,
    decorations: false,
    transparent: true,
    alwaysOnTop: true,
    // Center-ish; the OS places it and the founder drags it where they want.
    center: true,
    shadow: false,
  });

  return await new Promise<boolean>((resolve) => {
    // created/error are the Tauri v2 lifecycle signals for runtime windows.
    void win.once('tauri://created', () => resolve(true));
    void win.once('tauri://error', () => resolve(false));
  });
}
