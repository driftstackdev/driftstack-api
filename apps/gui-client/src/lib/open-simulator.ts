// Opens the floating-iPhone simulator window (founder 2026-06-11: a standalone,
// borderless, transparent, draggable iPhone — exactly like the Xcode Simulator).
//
// ON macOS: launches the SEPARATE "Driftstack Simulator" app (its own Dock icon)
// via the `launch_simulator` Tauri command, handing off the LiveKit join info +
// per-session control key. The separate app renders SimulatorWindow at
// `?window=simulator` and keeps one window per session (multi-window). There is
// no in-app fallback there — the inline window read as embedded in the main GUI
// and the separate app is reliably installed — so a launch failure returns
// `opened:false` with a reason and the caller shows a user-facing error.
//
// ON EVERY OTHER PLATFORM there IS no separate app. `launch_simulator`'s
// `#[cfg(not(target_os = "macos"))]` branch answers
// `Err("the separate simulator app is macOS-only")`, and since 0b1fe535f removed
// the in-process fallback that error had nowhere to go: launching a profile —
// the product's central action — failed outright on Windows and Linux. That
// commit's reasoning ("the separate app is reliably installed now") was true of
// macOS only, and the branch it deleted was the one every other platform used;
// the code it removed said so in as many words: "not installed / non-macOS /
// spawn failed -> in-process window fallback".
//
// So the in-process window is restored for non-macOS ONLY, selected by
// `simulator_app_supported` — a compile-time constant from the Rust side rather
// than a guess from the error string. macOS behaviour is unchanged, deliberately:
// the founder-hit "still in the same window as the main GUI" saga is why it has
// no fallback, and that reasoning still holds where the separate app exists.

import type { LiveKitInfo } from '@driftstack/sdk';
import type { DriftstackClient } from './client';
import { mintGuiControlKey, type GuiControlCredential } from './agent-session-control';

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
  /** Per-session gui_control_key plus its server-owned expiry so the SEPARATE Driftstack
   *  Simulator app can drive the control endpoints WITHOUT the main
   *  app's keychain (which it can't read). Handed off securely (see
   *  below). Omitted means control is unavailable; the account API key is
   *  never substituted into the simulator handoff. */
  controlCredential?: GuiControlCredential;
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
 *  carries a human-readable `reason` so callers can SHOW why the launch failed
 *  (there is no in-app fallback — the caller surfaces the error to the user). */
/** Phone-sized window. The video is object-contained, so exact aspect is not
 *  load-bearing; the extra 34px is the in-content toolbar a borderless window
 *  needs in place of OS chrome. */
const SIM_WIDTH = 330;
const SIM_HEIGHT = 684 + 34;

/**
 * Open the simulator as an in-process Tauri window.
 *
 * Used ONLY where no separate Simulator app exists (Windows, Linux). Restored
 * from 0b1fe535f^, which is where it was deleted for macOS-specific reasons.
 * Every option below is carried over from that implementation rather than
 * re-derived, because each one encodes a founder-reported behaviour: spawning
 * BESIDE the main window (a centred borderless window reads as embedded),
 * non-maximizable (the aspect-locked video just letterboxes), borderless +
 * transparent (the iPhone IS the window), and present in the taskbar.
 */
async function openInProcessSimulatorWindow(
  sessionId: string,
  query: string,
  deviceName: string | undefined,
  profileName: string | undefined,
): Promise<OpenSimulatorResult> {
  const { WebviewWindow } = await import('@tauri-apps/api/webviewWindow');
  // Stable, filesystem-safe label per session — one window per session, so a
  // second launch of the same session focuses rather than duplicating.
  const label = `simulator-${sessionId}`;

  const existing = await WebviewWindow.getByLabel(label).catch(() => null);
  if (existing !== null) {
    await existing.setFocus().catch(() => undefined);
    return { opened: true };
  }

  // Beside the main window, not centred over it. Best-effort: fall back to
  // centring only when the main window's geometry is unreadable.
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
      url: `index.html?${query}`,
      title: `${deviceName ?? 'iPhone'}${profileName !== undefined && profileName !== '' ? ` \u2014 ${profileName}` : ''}`,
      width: SIM_WIDTH,
      height: SIM_HEIGHT,
      resizable: true,
      maximizable: false,
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
    /** The backend still holds the label for a window the JS side cannot see —
     *  recoverable by closing it and retrying once. */
    labelCollision?: boolean;
  }

  const attempt = (win: InstanceType<typeof WebviewWindow>): Promise<Attempt> =>
    new Promise<Attempt>((resolve) => {
      void win.once('tauri://created', () => resolve({ opened: true }));
      void win.once('tauri://error', (e) => {
        const reason = typeof e?.payload === 'string' ? e.payload : JSON.stringify(e?.payload ?? e);
        resolve({ opened: false, reason, labelCollision: /already exists|label/i.test(reason) });
      });
    });

  let result = await attempt(buildWindow());
  if (!result.opened && result.labelCollision === true) {
    const stale = await WebviewWindow.getByLabel(label).catch(() => null);
    await stale?.close().catch(() => undefined);
    result = await attempt(buildWindow());
  }

  if (result.opened) return { opened: true };
  return { opened: false, ...(result.reason !== undefined ? { reason: result.reason } : {}) };
}

export async function openSimulatorWindow({
  sessionId,
  info,
  deviceName,
  profileName,
  proxyLabel,
  countryCode,
  controlCredential,
  baseUrl,
}: OpenSimulatorArgs): Promise<OpenSimulatorResult> {
  // Tauri-only — guard so a browser preview doesn't throw on the dynamic import.
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) {
    return { opened: false, reason: 'not running under Tauri (browser preview)' };
  }

  // Validate the LiveKit join info BEFORE building the query: URLSearchParams
  // stringifies a missing ws_url/token to the literal 'undefined', so on token
  // contract-drift the launch would still succeed (opened:true) but the iPhone
  // window hangs on "Connecting…" forever with no error to surface. Fail fast
  // with a clean reason so the caller shows why instead of a silent hang.
  if (
    typeof info.ws_url !== 'string' ||
    info.ws_url.length === 0 ||
    typeof info.token !== 'string' ||
    info.token.length === 0
  ) {
    return { opened: false, reason: 'incomplete session token from server' };
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
    // PUBLIC API host for the separate app (its store may be empty → would
    // default to localhost:3000 and fail every control call). Non-secret;
    // SimulatorWindow persists it on mount. Empty → the app keeps its own store.
    base: baseUrl ?? '',
  });
  if (controlCredential !== undefined) {
    // Per-session gui_control_key + exact API expiry. Rust atomically consumes
    // both from the complete 0600 single-use handoff, caps the expiry, and
    // strips them before the WebView sees the internal query. Base64 is
    // encoding, never process-list protection; argv carries only sessionId.
    params.set('ck', controlCredential.key);
    params.set('cke', String(Date.parse(controlCredential.expiresAt)));
  }

  // Launch the SEPARATE "Driftstack Simulator" app (its own Dock icon, founder
  // 2026-06-18) — the ONLY path the simulator opens. The separate app can't read
  // the main app's keychain, so it can't use the account API key; instead the
  // main app mints a per-session gui_control_key (24h TTL). launch_simulator
  // receives the complete encoded query over Tauri IPC, writes it to an
  // owner-only single-use handoff file, and launches with only the non-secret
  // session label in argv. The Simulator consumes the file before creating or
  // updating the session WebView.
  //
  // No in-app webview fallback: a borderless window inside the main GUI read as
  // embedded ("still in the same window as the main GUI") and a silent fallback
  // caused a multi-hour "still the same window" debugging saga (founder
  // 2026-06-12). The separate app is reliably installed now, so a launch failure
  // returns a clean `opened:false` reason for the caller to surface to the user.
  const { invoke } = await import('@tauri-apps/api/core');

  // Which of the two paths this platform gets. ONLY an explicit `false` switches
  // to the in-process window: a rejection (older binary without the command) or
  // any non-boolean answer keeps the exact macOS behaviour rather than silently
  // gaining an inline window — the failure mode 0b1fe535f was written to end. A
  // pre-command binary on Windows could not launch a profile either way, so the
  // conservative default costs nothing there.
  const hasSeparateApp =
    (await invoke<boolean>('simulator_app_supported').catch(() => true)) !== false;
  if (!hasSeparateApp) {
    // No separate app on this platform. `launch_simulator` would answer
    // Err("the separate simulator app is macOS-only"), so do not call it at all —
    // the in-process window is the supported path here, not a degradation.
    try {
      return await openInProcessSimulatorWindow(
        sessionId,
        params.toString(),
        deviceName,
        profileName,
      );
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      console.warn('[simulator] in-process simulator window failed:', reason);
      return { opened: false, reason };
    }
  }

  try {
    // `sessionLabel` (the plain session id) is the per-session window KEY in the
    // separate app (multi-window, founder 2026-06-23): each session opens/focuses its
    // own iPhone window. `payload` crosses only Tauri IPC; Rust writes it to an
    // owner-only single-use file. Base64 is not process-list protection.
    await invoke('launch_simulator', { payload: btoa(params.toString()), sessionLabel: sessionId });
    return { opened: true };
  } catch (err) {
    // Not installed / non-macOS / spawn failed. There is NO in-app fallback —
    // surface why so the caller can show the user a "couldn't open the
    // simulator" error (a silent fallback caused the founder's "still the same
    // window" saga).
    const reason = err instanceof Error ? err.message : String(err);
    console.warn('[simulator] launch_simulator failed; no in-app fallback:', reason);
    return { opened: false, reason };
  }
}

/** Reopen the floating-iPhone window for an already-running agent session given
 *  only its id — the shape the dashboard's "Open in desktop client" deep-link
 *  (`driftstack://session/open?session_id=…`) carries. Mints a fresh LiveKit
 *  join token + a per-session gui_control_key (so the SEPARATE simulator app,
 *  which can't read this app's keychain, can drive the control endpoints), then
 *  opens the window. The deep-link doesn't carry the profile/device label, so
 *  the toolbar shows the device-only default ("iPhone"). Returns the same
 *  `{ opened, reason }` shape as openSimulatorWindow; `opened:false` with a
 *  reason on any failure (no client / closed-or-missing session / launch fail)
 *  so the caller can surface it. */
export async function openSessionById(args: {
  client: DriftstackClient | null;
  baseUrl: string;
  apiKey: string | null;
  sessionId: string;
}): Promise<OpenSimulatorResult> {
  const { client, baseUrl, apiKey, sessionId } = args;
  if (client === null) {
    return { opened: false, reason: 'not signed in' };
  }
  try {
    const info = await client.agentSessions.livekitToken(sessionId);
    const controlCredential =
      apiKey !== null && apiKey.length > 0
        ? ((await mintGuiControlKey(baseUrl, apiKey, sessionId)) ?? undefined)
        : undefined;
    return await openSimulatorWindow({
      sessionId,
      info,
      baseUrl,
      ...(controlCredential !== undefined ? { controlCredential } : {}),
    });
  } catch (err) {
    // A closed/missing session 403s/404s on the token mint; any other failure
    // also lands here. Surface a reason — the caller decides whether to toast.
    const reason = err instanceof Error ? err.message : String(err);
    return { opened: false, reason };
  }
}
