# Separate "Driftstack Simulator" app — own Dock icon (founder 2026-06-18)

Founder wants the iPhone simulator as a **separate app with its own Dock icon**
beside the main Driftstack GUI (macOS gives Dock icons to apps, not windows, so
a window can't get its own Dock icon — it must be a second app). Building in
stages; the single-app GUI stays working throughout.

## Stage 1 — DONE ✅ (the second app exists)

- `apps/gui-client/src-tauri/tauri.simulator.conf.json` — a Tauri v2 override
  config (deep-merged over `tauri.conf.json` by `tauri build --config`):
  `productName "Driftstack Simulator"`, `identifier dev.driftstack.simulator`,
  one decorated window (`url index.html?window=simulator`, the existing
  `SimulatorWindow` UI), `bundle.targets ["app"]`, updater **off**, deep-link
  schemes **cleared** (only the main app owns `driftstack://`). Reuses the main
  icon set for now.
- `package.json`: `tauri:build:simulator` → `tauri build --config src-tauri/tauri.simulator.conf.json`.
- VERIFIED: produces `Driftstack Simulator.app` (CFBundleIdentifier
  `dev.driftstack.simulator`) → a distinct Dock icon; the main app build is
  unaffected. No Rust/React changes; same crate `run()` (main.tsx already
  branches on `?window=simulator`).

## Stage 2 — session handoff (the harder part, TODO)

The sim app opens `index.html?window=simulator` with NO session → "No session"
empty state. The main app must launch it AND hand off the live session.

1. **Main app launch** (replace `openSimulatorWindow`'s `WebviewWindow` create
   in `src/lib/open-simulator.ts`): spawn the sim app via a Tauri shell/command:
   `open -n -a "/Applications/Driftstack Simulator.app" --args --ds-session=<b64>`
   where `<b64>` = base64(JSON `{ws_url, token, device, profile, proxy, session}`).
   **Do NOT include the API key in argv** (visible via `ps`) — the sim app reads
   it from the SAME Keychain (`KEYRING_SERVICE = "dev.driftstack.gui"`, hard-coded
   in lib.rs:30; the different-signed sim app triggers a ONE-TIME macOS "allow"
   prompt, then works). LiveKit needs only ws_url+token (in the payload); the API
   key is only for the control endpoints + session-end.
2. **Sim app receive** (lib.rs setup hook, gated on the arg so the MAIN app is
   unaffected): read `std::env::args` for `--ds-session=`; if present, decode +
   `window.navigate("index.html?window=simulator&ws=…&token=…&…")`. The frontend
   already parses these (`infoFromQuery` in SimulatorWindow.tsx) — no React change.
   Also wire the single-instance callback to re-navigate on a second launch (so
   launching a new profile reuses the open sim window OR opens per-session).
3. **Close → end session**: the sim window's `onCloseRequested` already calls
   `endAgentSession` (works in the sim app too).

## Stage 3 — bundle / sign / install both apps (TODO)

- Build both: `npm run tauri:build` (main) + `npm run tauri:build:simulator`.
  NOTE shared Cargo target → sequential rebuilds (config change invalidates the
  build script); fine for release, or set distinct `CARGO_TARGET_DIR`.
- Install BOTH to /Applications, each adhoc-signed with the proven pattern
  (`rm -rf` + `ditto` + `xattr -cr` + `codesign --force --sign - --identifier <id>`
  inner-binary then bundle + `lsregister -f`). The sim app's identifier =
  `dev.driftstack.simulator` (use it for the re-sign, NOT the main app's id).
- The main app launches `/Applications/Driftstack Simulator.app` (fixed path) —
  or fall back to a bundled copy if not installed.
- **Distinct Dock icon (prep, founder design-input):** the sim config currently
  reuses `icons/` → the two Dock icons would be IDENTICAL. Before the dual-install,
  give the sim app a distinct icon: render a variant via `scripts/render-gui-icon.mjs`
  (the brand "Drift Layers" mark is founder-picked — keep it; vary the squircle
  backing or add a subtle "live" accent), `tauri icon` into `icons-simulator/`, then
  point `tauri.simulator.conf.json` `bundle.icon` at it. The exact look is a
  founder-taste call (don't guess-and-churn) — confirm the variant when installing.

## Risks / notes

- Keychain: one-time "allow" prompt the first time the sim app reads the key.
- lib.rs:531 unit test asserts `KEYRING_SERVICE == "dev.driftstack.gui"` — still
  passes (constant unchanged; the sim app shares the main app's keychain service).
- macOS only (Dock). On other platforms the in-process window is the fallback.
- Until Stage 2 ships, the GUI keeps using the in-process decorated
  `WebviewWindow` (current behaviour) so nothing regresses.
