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
  /** ISO-3166 alpha-2 exit country of the launching proxy (e.g. "US"), from the
   *  proxy probe (`exitCountry`). Threaded through to the simulator so the
   *  separate app's macOS Dock tile reflects the session's egress country
   *  (founder 2026-06-18). Omitted/null → no Dock-tile country badge. */
  countryCode?: string | null;
  /** Per-session gui_control_key (24h TTL) so the SEPARATE Driftstack
   *  Simulator app can drive the control endpoints WITHOUT the main
   *  app's keychain (which it can't read). Handed off securely (see
   *  below); omitted → the simulator falls back to the account API key
   *  (only works for the in-process window, which shares the keychain).
   *  This is NOT the account API key. */
  controlKey?: string;
  /** The PUBLIC API base URL (e.g. https://api.driftstack.dev). The SEPARATE
   *  Simulator app has its OWN (often empty) settings store → without this it
   *  falls back to localhost:3000 and every control call (mode / End-session /
   *  cookies) fails. Handed off here (non-secret) + persisted by SimulatorWindow
   *  on mount so authedFetch targets the right server (founder 2026-06-23). */
  baseUrl?: string;
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
  countryCode,
  controlKey,
  baseUrl,
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
    // Proxy exit country (ISO alpha-2) for the macOS Dock tile (empty → no
    // country badge). Carried in the same query payload as the other handoff
    // fields (this is NOT a secret — it's the same country the world sees).
    cc: countryCode ?? '',
    // Session id — lets the simulator window attach recordings to the
    // session (night-arc I Record pill).
    session: sessionId,
    // Per-session gui_control_key carried in the query as the PRIMARY,
    // race-free handoff so the SEPARATE simulator app authorizes the
    // control endpoints on mount (without it the temp-file handoff races
    // the Rust location.search reload → getAgentSession 401s → mode stays
    // null → "Connecting…" forever, founder-hit 2026-06-18). This rides the
    // SAME in-process location.search channel as the LiveKit token above —
    // it is NOT argv-exposed (the launch payload is base64'd, applied to
    // window.location.search by Rust), so it is no less safe than the token.
    // The 0600 temp-file handoff (sim_key_write/sim_key_take) is kept as a
    // secondary path. Empty when no control key is available (in-app window).
    ck: controlKey ?? '',
    // PUBLIC API host for the separate app (its store may be empty → would
    // default to localhost:3000 and fail every control call). Non-secret;
    // SimulatorWindow persists it on mount. Empty → the app keeps its own store.
    base: baseUrl ?? '',
  });

  // Stage 2 — prefer the SEPARATE "Driftstack Simulator" app (its own Dock icon,
  // founder 2026-06-18) when it's installed: hand off the session via a launch
  // arg. The separate app can't read the main app's keychain, so it can't use
  // the account API key; instead the main app mints a per-session
  // gui_control_key (24h TTL) and hands it off TWO ways: (1) PRIMARY — in the
  // base64'd launch payload's `ck=` query field above, which Rust applies to
  // window.location.search (in-process, NOT argv/`ps`-visible — same channel as
  // the LiveKit token); SimulatorWindow reads it on mount with no reload race.
  // (2) SECONDARY — a 0600 temp file (sim_key_write here / sim_key_take in the
  // simulator), kept as a belt-and-suspenders fallback (this build is NOT
  // sandboxed — Entitlements.plist has no com.apple.security.app-sandbox — so
  // /tmp is shared between the two apps). See
  // docs/internal/2026-06-18-separate-simulator-app-plan.md.
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    if (controlKey !== undefined && controlKey.length > 0) {
      // Write the control key to the shared 0600 temp file BEFORE the
      // launch so the simulator finds it on startup. Best-effort: a
      // failure just means the simulator falls back to the (failing)
      // keychain read; we don't block the launch on it.
      try {
        await invoke('sim_key_write', { sessionId, key: controlKey });
      } catch {
        // ignore — non-fatal; the simulator degrades to API-key auth.
      }
    }
    // `sessionLabel` (the plain session id) is the per-session window KEY in the
    // separate app (multi-window, founder 2026-06-23): each session opens/focuses its
    // own iPhone window. `payload` stays the b64 (ps-safe) handoff.
    await invoke('launch_simulator', { payload: btoa(params.toString()), sessionLabel: sessionId });
    return { opened: true };
  } catch {
    // not installed / non-macOS / spawn failed → in-process window fallback.
  }

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
      // Resizable so the operator can scale the phone, but NOT maximizable: the
      // device video is aspect-locked, so a full-screen "zoom" (macOS double-click
      // the drag region) just letterboxes the phone in a huge frame — "looks
      // strange" (founder 2026-06-21). SimulatorWindow re-fits to the device aspect
      // on every resize, so manual resizing scales the phone with no side gaps.
      resizable: true,
      maximizable: false,
      // BORDERLESS + transparent — the iPhone IS the window (founder 2026-06-18:
      // "back like it was", no macOS title-bar chrome ON the phone). The
      // separate/selectable part comes from the standalone Driftstack Simulator
      // APP's own Dock icon, NOT a title bar. The in-content toolbar provides
      // close/minimize (a borderless window has no OS chrome).
      decorations: false,
      transparent: true,
      alwaysOnTop: false,
      minimizable: true,
      skipTaskbar: false,
      ...(position !== null ? { x: position.x, y: position.y } : { center: true }),
      shadow: false,
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
