# GUI live-flow hardening + the (b) release-paint diagnosis — status & how-to

Founder context: the GUI now runs real profiles + streaming, so this session
audited the live-flow code for real bugs and shipped fixes. This note records
what's hardened, **how you can diagnose the (b) release-paint bug**, and one
surfaced edge that needs your call.

## Hardening shipped this session (W260–W263) — all the poll/timer/effect class

| commit     | fix                                                                                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `0a388c10` | session-stream: `schedule()` cleared no pending timer before re-arming → a `resume()` during an in-flight fetch spawned **two timer chains** (2× poll rate + leak). Now single-timer.                                                                                 |
| `69dbd430` | latency-ping: effect dep was `[opts]` (object) → an inline-`{room,enabled}` caller re-armed the 2s ping loop every render (DataChannel flood). Now `[room, enabled]`. Latent (unwired).                                                                               |
| `3beb17d2` | AgentSessionPanel: effect dep was `[info, onStateChange]` → an inline `onStateChange` would **reconnect the LiveKit room every render** (stream thrash). Now connection-identity `[info.ws_url, info.token]` + a latest-callback ref. Latent (sole consumer is safe). |
| `058d8ebd` | LiveSessionView: the fixed-500ms capture poll had no in-flight guard → a slow screenshot stacked **concurrent captures**. Now `fetchInFlightRef` skips overlaps.                                                                                                      |

Audited **clean** (don't re-audit): use-connection-status, session-events,
session-control, use-notifications, notifications, use-sessions-list,
ProfilesView `handleLaunch`, recordings `addFrame` (ring-buffer-capped at 1200).

Earlier this session: (a) stretched view fixed, (c) keychain→settings.json,
(d) in-app dev logs + file-persist. So GUI W232 (a)/(c)/(d) are done.

## (b) release `.app` paint bug — how to diagnose (needs your build + launch)

Symptom: the installed release `.app` runs + polls data (server log proves JS
runs) but the window doesn't composite (black, no error). Dev mode paints fine.

**Ruled out** (this session, from config + the "JS runs" fact): transparent /
invisible window (config is `transparent:false, decorations:true`); asset
resolution (JS loads under the Tauri protocol, so `/assets/*` resolves). →
It's a **WKWebView layer-compositing** issue, not boot/assets.

**To diagnose (you, with a build+launch):**

1. `cd apps/gui-client && npm run tauri build -- --bundles app`, install, launch.
2. Read the dev-log file (W259 ships this): `~/Library/Application Support/dev.driftstack.gui/recordings/dev-log.txt`
   — it captures console + errors even when the window is black. Confirms boot
   reached polling with no JS error (→ pure compositing) vs failed earlier.
3. Try, one at a time (rebuild + relaunch between):
   - `tauri.conf.json` window `titleBarStyle: "Overlay"` → `"Visible"` (Overlay
     is the unusual config + a plausible macOS compositing culprit; note this
     changes the custom-TitleBar layout, so it's a diagnostic, not a final fix).
   - A window nudge after content-ready (Rust `src-tauri/src/lib.rs`): on the
     webview's load, `window.set_size(+1px)` then back — forces a composite.
   - A Tauri / wry version bump (check their changelog for macOS compositing fixes).

I can't do step 1–3 autonomously (eyes-on, and it changes window UX), so it's
queued for when you're at the machine. Ping me with what the dev-log shows + which
toggle helped and I'll land the fix + a content-parity pin.

## ⚠️ Surfaced (your call): recordings flush-on-close is best-effort

`recordings.tsx` auto-flushes an active recording on React unmount via a
**fire-and-forget** `void persistRecording(...)` (it can't await during teardown).
On an abrupt app-close the async fs write may not finish → the in-progress
recording's frames are lost. It's a documented best-effort, not a silent bug, and
the data-loss is edge (only a recording active at the exact moment of an abrupt
close). The proper fix is a Tauri `onCloseRequested` handler that prevents the
close, awaits the flush, then closes — that's Rust + needs a launch to verify, so
it's a founder-present slice rather than an autopilot one. Flagging for your call.
