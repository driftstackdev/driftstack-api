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
  /** Profile name shown next to the Drift mark in the toolbar (the identity
   *  this phone is running as). Omitted → the toolbar shows the device only. */
  profileName?: string;
  /** Night-arc C: egress label for the cockpit overlay — 'label · host:port'
   *  of the proxy the session launched through. Omitted → row hidden. */
  proxyLabel?: string;
}

export interface OpenSimulatorResult {
  opened: boolean;
  /** Why the separate window did NOT open (shown to the user by the caller —
   *  an invisible fallback caused a multi-hour "still the same window"
   *  debugging saga, founder-hit 2026-06-12). */
  reason?: string;
}

/** Open (or focus) the floating-iPhone window for a session. `opened:false`
 *  carries a human-readable `reason` so callers can SHOW why they fell back
 *  to the in-app viewer. */
export async function openSimulatorWindow({
  sessionId,
  info,
  deviceName,
  profileName,
  proxyLabel,
}: OpenSimulatorArgs): Promise<OpenSimulatorResult> {
  // Tauri-only — guard so a browser preview doesn't throw on the dynamic import.
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return { opened: false, reason: 'not running under Tauri (browser preview)' };
  }

  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  // Stable, filesystem-safe label per session (window labels disallow most
  // punctuation; the ses_/agt_ prefix + uuid hyphens are fine).
  const label = `simulator-${sessionId}`;

  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing !== null) {
    await existing.setFocus().catch(() => undefined);
    return { opened: true };
  }

  const params = new URLSearchParams({
    window: 'simulator',
    ws: info.ws_url,
    token: info.token,
    // room_name is informational; include when present for the title/debug.
    room: (info as unknown as { room_name?: string }).room_name ?? '',
    // Device label for the toolbar (e.g. "iPhone 17").
    name: deviceName ?? 'iPhone',
    // Profile identity for the toolbar branding (empty → device-only).
    profile: profileName ?? '',
    // Egress line for the cockpit overlay (empty → row hidden).
    proxy: proxyLabel ?? '',
    // Session id — lets the simulator window attach recordings to the
    // session (night-arc I Record pill).
    session: sessionId,
  });

  // Spawn BESIDE the main window, not centered over it — a borderless
  // always-on-top window centered on the main GUI reads as embedded
  // (founder-hit: "still in the same window as the main GUI"). Best-effort:
  // place it to the right of the main window with a small gap; fall back to
  // centering only when the main window's position isn't readable.
  let position: { x: number; y: number } | null = null;
  try {
    const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow');
    const main = getCurrentWebviewWindow();
    const pos = await main.outerPosition();
    const size = await main.outerSize();
    const factor = await main.scaleFactor();
    position = {
      x: Math.round(pos.x / factor + size.width / factor + 16),
      y: Math.round(pos.y / factor),
    };
  } catch {
    position = null;
  }

  const buildWindow = (): InstanceType<typeof WebviewWindow> =>
    new WebviewWindow(label, {
      url: `index.html?${params.toString()}`,
      // Title shows in the macOS Window menu + Mission Control so the floating
      // phone is a discoverable, switchable window (founder 2026-06-18: "should
      // show up in the taskbar").
      title: `${deviceName ?? 'iPhone'}${profileName !== undefined && profileName !== '' ? ` — ${profileName}` : ''}`,
      width: SIM_WIDTH,
      height: SIM_HEIGHT,
      resizable: true,
      // DECORATED (real macOS title bar) — founder requested "a separate window
      // selectable in the taskbar" multiple times. A borderless + transparent
      // window is a panel-like surface that does NOT appear in Mission Control /
      // the Window menu / Cmd-` / minimizable to the Dock, no matter what
      // skipTaskbar/alwaysOnTop say. A decorated window IS a first-class macOS
      // window: selectable, switchable, minimizable — the Xcode-Simulator model
      // (title bar + device). The OS title bar provides close/minimize, so the
      // in-content toolbar drops its custom traffic-lights.
      decorations: true,
      transparent: false,
      backgroundColor: '#0b0f14',
      alwaysOnTop: false,
      minimizable: true,
      skipTaskbar: false,
      ...(position !== null ? { x: position.x, y: position.y } : { center: true }),
    });

  interface Attempt {
    opened: boolean;
    reason?: string;
    /** True when the backend rejected because the label is still registered
     *  (a window we couldn't see via getByLabel) — recoverable by closing it. */
    labelCollision?: boolean;
  }

  const attempt = (win: InstanceType<typeof WebviewWindow>): Promise<Attempt> =>
    new Promise<Attempt>((resolve) => {
      // created/error are the Tauri v2 lifecycle signals for runtime windows.
      void win.once('tauri://created', () => resolve({ opened: true }));
      void win.once('tauri://error', (e) => {
        const reason = typeof e?.payload === 'string' ? e.payload : JSON.stringify(e?.payload ?? e);
        resolve({ opened: false, reason, labelCollision: /already exists|label/i.test(reason) });
      });
    });

  let result = await attempt(buildWindow());

  // The up-front getByLabel guard misses the case where the Rust backend still
  // holds the label but the JS side can't see the handle (e.g. the prior window
  // was closed from its toolbar, or a relaunch of the same session). Close the
  // lingering window and recreate ONCE before falling back in-app.
  if (!result.opened && result.labelCollision === true) {
    const stale = await WebviewWindow.getByLabel(label).catch(() => null);
    await stale?.close().catch(() => undefined);
    result = await attempt(buildWindow());
  }

  if (result.opened) return { opened: true };
  // Surfaced ALL THE WAY TO THE UI, not just the console: a silent fallback
  // caused the founder's "still the same window" saga.
  console.warn('[simulator] separate window creation failed; falling back in-app:', result.reason);
  return { opened: false, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
}
