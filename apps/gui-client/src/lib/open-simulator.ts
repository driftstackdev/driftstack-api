// Opens the floating-iPhone simulator window (founder 2026-06-11: a standalone,
// borderless, transparent, draggable iPhone — exactly like the Xcode Simulator).
//
// Launches the SEPARATE "Driftstack Simulator" app (its own Dock icon) via the
// `launch_simulator` Tauri command, handing off the LiveKit join info +
// per-session control key. The separate app renders SimulatorWindow at
// `?window=simulator` and keeps one window per session (multi-window). It is the
// ONLY way the simulator opens — there is no in-app webview fallback (the inline
// window read as embedded in the main GUI and the separate app is reliably
// installed now). A launch failure returns `opened:false` with a reason so the
// caller surfaces a user-facing error instead of silently degrading.

import type { LiveKitInfo } from '@driftstack/sdk';
import type { DriftstackClient } from './client';
import { mintGuiControlKey } from './agent-session-control';

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
   *  (which it generally can't read, so control degrades). This is NOT
   *  the account API key. */
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
 *  carries a human-readable `reason` so callers can SHOW why the launch failed
 *  (there is no in-app fallback — the caller surfaces the error to the user). */
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
    // Per-session gui_control_key carried in the query as the PRIMARY,
    // race-free handoff so the SEPARATE simulator app authorizes the
    // control endpoints on mount (without it the temp-file handoff races
    // the Rust location.search reload → getAgentSession 401s → mode stays
    // null → "Connecting…" forever, founder-hit 2026-06-18). This rides the
    // SAME in-process location.search channel as the LiveKit token above —
    // it is NOT argv-exposed (the launch payload is base64'd, applied to
    // window.location.search by Rust), so it is no less safe than the token.
    // The 0600 temp-file handoff (sim_key_write/sim_key_take) is kept as a
    // secondary path. Empty when no control key is available.
    ck: controlKey ?? '',
    // PUBLIC API host for the separate app (its store may be empty → would
    // default to localhost:3000 and fail every control call). Non-secret;
    // SimulatorWindow persists it on mount. Empty → the app keeps its own store.
    base: baseUrl ?? '',
  });

  // Launch the SEPARATE "Driftstack Simulator" app (its own Dock icon, founder
  // 2026-06-18) — the ONLY path the simulator opens. The separate app can't read
  // the main app's keychain, so it can't use the account API key; instead the
  // main app mints a per-session gui_control_key (24h TTL) and hands it off TWO
  // ways: (1) PRIMARY — in the base64'd launch payload's `ck=` query field above,
  // which Rust applies to window.location.search (in-process, NOT argv/`ps`-
  // visible — same channel as the LiveKit token); SimulatorWindow reads it on
  // mount with no reload race. (2) SECONDARY — a 0600 temp file (sim_key_write
  // here / sim_key_take in the simulator), kept as a belt-and-suspenders fallback
  // (this build is NOT sandboxed — Entitlements.plist has no
  // com.apple.security.app-sandbox — so /tmp is shared between the two apps). See
  // docs/internal/2026-06-18-separate-simulator-app-plan.md.
  //
  // No in-app webview fallback: a borderless window inside the main GUI read as
  // embedded ("still in the same window as the main GUI") and a silent fallback
  // caused a multi-hour "still the same window" debugging saga (founder
  // 2026-06-12). The separate app is reliably installed now, so a launch failure
  // returns a clean `opened:false` reason for the caller to surface to the user.
  // Track whether we wrote the temp control-key file so we can remove it if the
  // launch throws AFTER the write (e.g. simulator not installed): otherwise each
  // failed retry strands a 24h-TTL credential in the shared 0600 /tmp file.
  let wroteControlKey = false;
  try {
    const { invoke } = await import('@tauri-apps/api/core');
    if (controlKey !== undefined && controlKey.length > 0) {
      // Write the control key to the shared 0600 temp file BEFORE the
      // launch so the simulator finds it on startup. Best-effort: a
      // failure just means the simulator falls back to the (failing)
      // keychain read; we don't block the launch on it.
      try {
        await invoke('sim_key_write', { sessionId, key: controlKey });
        wroteControlKey = true;
      } catch {
        // ignore — non-fatal; the simulator degrades to API-key auth.
      }
    }
    // `sessionLabel` (the plain session id) is the per-session window KEY in the
    // separate app (multi-window, founder 2026-06-23): each session opens/focuses its
    // own iPhone window. `payload` stays the b64 (ps-safe) handoff.
    await invoke('launch_simulator', { payload: btoa(params.toString()), sessionLabel: sessionId });
    return { opened: true };
  } catch (err) {
    // Not installed / non-macOS / spawn failed. There is NO in-app fallback —
    // surface why so the caller can show the user a "couldn't open the
    // simulator" error (a silent fallback caused the founder's "still the same
    // window" saga).
    const reason = err instanceof Error ? err.message : String(err);
    console.warn('[simulator] launch_simulator failed; no in-app fallback:', reason);
    // The simulator never launched to consume it, so drop the temp credential we
    // wrote above — best-effort; leaving it would accumulate a stale key per
    // failed retry. sim_key_take reads-and-deletes the shared 0600 /tmp file.
    if (wroteControlKey) {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        await invoke('sim_key_take', { sessionId });
      } catch {
        // ignore — best-effort cleanup; the file carries a 24h TTL regardless.
      }
    }
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
    const controlKey =
      apiKey !== null && apiKey.length > 0
        ? ((await mintGuiControlKey(baseUrl, apiKey, sessionId)) ?? undefined)
        : undefined;
    return await openSimulatorWindow({
      sessionId,
      info,
      baseUrl,
      ...(controlKey !== undefined ? { controlKey } : {}),
    });
  } catch (err) {
    // A closed/missing session 403s/404s on the token mint; any other failure
    // also lands here. Surface a reason — the caller decides whether to toast.
    const reason = err instanceof Error ? err.message : String(err);
    return { opened: false, reason };
  }
}
