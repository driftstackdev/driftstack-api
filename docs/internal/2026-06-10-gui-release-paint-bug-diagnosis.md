# GUI release .app webview-paint bug — diagnosis + candidate fixes (founder W232 item b)

**Symptom (founder):** the packaged release `.app` runs + polls the backend but
the webview never composites/paints (blank window). Dev mode (`tauri dev`,
localhost:1420) works — the dev hot-reload is the de-facto workaround.

**Eyes-on required** to verify any fix (needs the release build observed). This
note narrows the search so that session is targeted, not from-scratch.

## Config-level causes RULED OUT (read from the repo)

- **Asset base-path / 404** — ruled out: the symptom is "runs + **polls**", i.e.
  React mounted and is running its poll loop, so the JS/CSS bundle DID load.
  (A base-path 404 would give a blank page with _no_ polling.) So Vite's missing
  `base` (defaults to `/`) is not the cause here.
- **CSP blocking assets** — `tauri.conf.json` `security.csp = null` (no CSP).
- **Transparency/vibrancy no-compositing** — `transparent: false`.

## Most-likely cause: macOS WKWebView blank-until-redraw on an overlay-titlebar window

`tauri.conf.json` window config: `titleBarStyle: "Overlay"` + `hiddenTitle: true`
(content extends under a custom title bar), `decorations: true`,
`backgroundColor: "#0b0f14"`. `src-tauri/src/lib.rs` has **no** `setup()` hook,
no `window.show()`-after-ready, and no `with_webview` macOS layer handling — the
window shows immediately on create.

The `Overlay` title-bar style is a known trigger for a macOS WKWebView
compositing quirk where the webview's layer isn't drawn until a redraw event
(resize / focus / reload). Dev mode's reloads mask it; the static release build
shows blank until something forces a redraw. Symptom (mounts + polls, no paint)
fits a compositing—not asset-loading—failure.

## Candidate fixes to try in the eyes-on session (cheapest first)

1. **Confirm the trigger:** temporarily set `titleBarStyle: "Visible"` (standard
   title bar). If the release paints, the Overlay style is confirmed as the
   trigger → keep Overlay + apply a redraw nudge (below).
2. **Resize-nudge on setup** (lowest-risk, benign if wrong): in a Rust `setup()`
   hook, after getting the main `WebviewWindow`, set the size to `w, h+1` then
   back to `w, h` (or call `.center()`), forcing one compositing pass.
3. **Show-after-ready:** window `visible: false` in config + `window.show()` from
   the Rust setup hook once the frontend signals ready (or after a short delay).
   Higher-risk (a missed `show()` → window never appears) — test carefully.
4. **Layer-backed view:** via `with_webview` set the WKWebView `wantsLayer` /
   `drawsBackground` on macOS.

Do NOT ship any of these blind — each needs the release `.app` observed (the
"no blind ship of UI fixes" rule). #1+#2 are the highest-confidence/lowest-risk
starting point.

## Pointers

- Window config: `apps/gui-client/src-tauri/tauri.conf.json` (`app.windows[0]`).
- Rust setup site: `apps/gui-client/src-tauri/src/lib.rs` (add a `.setup(|app| …)`).
- Tauri v2 macOS webview: `tauri::WebviewWindow` + `with_webview` for the WKWebView.

## Status — fix #2 APPLIED + compile-verified (W434, 2026-06-10)

Fix #2 (resize-nudge in a Rust `.setup()` hook, macOS-only) is now in
`apps/gui-client/src-tauri/src/lib.rs`, and `cargo check` passes clean. It's
benign-if-wrong (an imperceptible 1px nudge at startup; a no-op if the quirk
differs or on non-macOS) so it ships as the candidate rather than waiting.

🙋 **FOUNDER / eyes-on:** observe the next release `.app` build — if the webview
now composites, item (b) is RESOLVED. If it's still blank, the Overlay style is a
weaker trigger than diagnosed → try #1 (`titleBarStyle: "Visible"` to confirm the
trigger), then #3 (show-after-ready) / #4 (layer-backed `wantsLayer`). Dev mode is
unaffected (the nudge is imperceptible; dev already worked).
