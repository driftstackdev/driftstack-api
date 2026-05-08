# V-328 — Tauri custom URL scheme deep-link (founder validation)

V-328 wires the GUI client to register a `driftstack://` URL scheme,
so the dashboard's auth-confirmation page can hand off to the desktop
app via OS deep-link instead of the V-268 polling loop.

This document captures the founder action items that the autopilot
slice could not run / could not validate. Code is on `main`; the
native bundle path needs an actual run on each OS before release.

## Code already on main (autopilot slice)

- `apps/gui-client/src-tauri/Cargo.toml`: added
  `tauri-plugin-deep-link = "2.0"` dependency.
- `apps/gui-client/src-tauri/src/lib.rs`: registered
  `tauri_plugin_deep_link::init()` in the Tauri builder.
- `apps/gui-client/src-tauri/tauri.conf.json`: declared the URL
  scheme under `plugins.deep-link.desktop.schemes`.
- `apps/gui-client/src/lib/browser-sign-in.ts`: registered the
  `onOpenUrl` listener BEFORE arming the poll loop. Deep-link arrival
  fires the exchange; polling continues as a fallback for installs
  where the URL scheme registration didn't take.
- `apps/gui-client/tests/unit/use-browser-sign-in.test.tsx`: 3 new
  tests cover the deep-link primary path + state mismatch silent-skip
  - polling fallback when `onOpenUrl` throws.

## Founder validation per platform

### macOS

```sh
cd apps/gui-client
npm run tauri build  # signs the app bundle
open src-tauri/target/release/bundle/macos/Driftstack.app
# In the dashboard, complete a sign-in to the point where it would
# redirect to driftstack://auth/callback?code=...&state=...
# The GUI should pick up the auth instantly (no 2s poll wait).
```

If the URL scheme doesn't register: check
`Driftstack.app/Contents/Info.plist` includes a
`CFBundleURLTypes` array with `CFBundleURLSchemes = ["driftstack"]`.
The Tauri 2.x deep-link plugin should add this automatically based on
the tauri.conf.json `schemes` entry, but the build process is
opinionated about Info.plist merging — verify post-build.

### Windows

```powershell
cd apps\gui-client
npm run tauri build
# Run the produced .msi installer. Installation writes registry
# entries under HKCU\Software\Classes\driftstack mapping the scheme to
# the app executable.
```

If `driftstack://` URLs don't open the app: open `regedit.exe` and
verify `HKCU\Software\Classes\driftstack\shell\open\command` exists
and points to the installed .exe with a `%1` placeholder.

### Linux (.deb / AppImage)

```sh
cd apps/gui-client
npm run tauri build
sudo dpkg -i src-tauri/target/release/bundle/deb/driftstack_*.deb
# Or: chmod +x src-tauri/target/release/bundle/appimage/Driftstack_*.AppImage
```

The `.deb` path writes a `/usr/share/applications/driftstack.desktop`
entry with `MimeType=x-scheme-handler/driftstack;`. Test:

```sh
xdg-open driftstack://auth/callback?code=test&state=test
```

If the GUI doesn't launch: verify the .desktop file's `Exec=` line
points to the installed binary AND that `MimeType=` contains the
scheme handler. Run `update-desktop-database` if needed.

The AppImage path is separate; deep-link registration on AppImage is
notoriously inconsistent and is documented as a fallback path that
relies on the polling loop to keep working.

## Server-side dashboard work (separate slice)

The dashboard's `/auth/cli-callback` page currently shows a "click to
approve" UI that mints a key + lets the desktop app pick it up via
the V-268 polling loop. V-328 expects the page to ALSO emit a
`window.location.href = "driftstack://auth/callback?code=...&state=..."`
redirect on success so the OS hand-off fires.

The server-side change is NOT in this slice. Until it lands, the
desktop app behaves identically to V-268 (polling-only), since the
deep-link listener never fires (no driftstack:// URL is ever opened).
The native deep-link plumbing is ready; it just sits idle until the
dashboard page emits the redirect.

That follow-on lands as `V-328e` once the founder confirms the
per-platform native bundle test above.

## Rollback

If a per-platform test reveals a regression that's hard to fix
quickly:

```sh
git revert <V-328-commit-sha>
```

The pre-V-328 polling loop is fully functional and ships as a
fallback even with V-328 active, so a revert just removes the
listener registration — no data loss, no key re-mint required.
