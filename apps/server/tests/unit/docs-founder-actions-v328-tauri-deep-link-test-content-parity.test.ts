// W545.B — drift guard for /docs/founder-actions/v328-tauri-deep-link-test.md.
// V-328 GUI client custom URL scheme deep-link founder validation.
// Drift here either drops the V-268-polling-fallback safety net
// (would risk shipping a release with no graceful degradation if
// deep-link registration fails on a platform), changes the
// driftstack:// scheme name (would break the dashboard-emit-redirect
// handoff), or weakens the per-platform Info.plist / registry /
// .desktop verification.
//
//   • V-328 anchor + driftstack:// URL scheme.
//   • Code-already-on-main inventory: Cargo.toml + lib.rs + tauri.
//     conf.json + browser-sign-in.ts + 3 new tests.
//   • V-268-polling-fallback parity for all platforms.
//   • Per-platform validation (macOS Info.plist CFBundleURLTypes +
//     Windows HKCU registry + Linux .desktop MimeType).
//   • Server-side V-328e follow-on (dashboard emits
//     window.location.href redirect).
//   • Rollback: git revert; polling-loop continues to work.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/founder-actions/v328-tauri-deep-link-test.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W545.B /docs/founder-actions/v328-tauri-deep-link-test.md content parity', () => {
  const body = read(LIB);

  it("Header + V-328 + driftstack:// + V-268-polling-replacement framing pinned: '# V-328 — Tauri custom URL scheme deep-link (founder validation)' + 'V-328 wires the GUI client to register a `driftstack://` URL scheme, so the dashboard's auth-confirmation page can hand off to the desktop app via OS deep-link instead of the V-268 polling loop.' + 'This document captures the founder action items that the autopilot slice could not run / could not validate. Code is on `main`; the native bundle path needs an actual run on each OS before release.' — pinned so the V-328 + driftstack://-scheme + V-268-polling-replacement + autopilot-slice-cannot-validate-per-platform + code-on-main-needs-actual-OS-run commitment survives", () => {
    expect(body).toMatch(/# V-328 — Tauri custom URL scheme deep-link \(founder validation\)/);
    expect(body).toMatch(/V-328 wires the GUI client to register a `driftstack:\/\/` URL scheme,/);
    expect(body).toMatch(/so the dashboard's auth-confirmation page can hand off to the desktop/);
    expect(body).toMatch(/app via OS deep-link instead of the V-268 polling loop\./);
    expect(body).toMatch(/This document captures the founder action items that the autopilot/);
    expect(body).toMatch(/slice could not run \/ could not validate\. Code is on `main`; the/);
    expect(body).toMatch(/native bundle path needs an actual run on each OS before release\./);
  });

  it("Code-already-on-main inventory framing pinned: '`apps/gui-client/src-tauri/Cargo.toml`: added `tauri-plugin-deep-link = \"2.0\"` dependency.' + '`apps/gui-client/src-tauri/src/lib.rs`: registered `tauri_plugin_deep_link::init()` in the Tauri builder.' + '`apps/gui-client/src-tauri/tauri.conf.json`: declared the URL scheme under `plugins.deep-link.desktop.schemes`.' + '`apps/gui-client/src/lib/browser-sign-in.ts`: registered the `onOpenUrl` listener BEFORE arming the poll loop. Deep-link arrival fires the exchange; polling continues as a fallback for installs where the URL scheme registration didn't take.' + '`apps/gui-client/tests/unit/use-browser-sign-in.test.tsx`: 3 new tests cover the deep-link primary path + state mismatch silent-skip + polling fallback when `onOpenUrl` throws.' — pinned so the tauri-plugin-deep-link-v2.0 + lib.rs-init-registration + tauri.conf.json-schemes + browser-sign-in-onOpenUrl-BEFORE-poll-loop + polling-fallback + 3-test-coverage (primary + state-mismatch + onOpenUrl-throws) commitment survives", () => {
    expect(body).toMatch(/## Code already on main \(autopilot slice\)/);
    expect(body).toMatch(/- `apps\/gui-client\/src-tauri\/Cargo\.toml`: added/);
    expect(body).toMatch(/`tauri-plugin-deep-link = "2\.0"` dependency\./);
    expect(body).toMatch(/- `apps\/gui-client\/src-tauri\/src\/lib\.rs`: registered/);
    expect(body).toMatch(/`tauri_plugin_deep_link::init\(\)` in the Tauri builder\./);
    expect(body).toMatch(/- `apps\/gui-client\/src-tauri\/tauri\.conf\.json`: declared the URL/);
    expect(body).toMatch(/scheme under `plugins\.deep-link\.desktop\.schemes`\./);
    expect(body).toMatch(/- `apps\/gui-client\/src\/lib\/browser-sign-in\.ts`: registered the/);
    expect(body).toMatch(/`onOpenUrl` listener BEFORE arming the poll loop\./);
    expect(body).toMatch(/Deep-link arrival/);
    expect(body).toMatch(/fires the exchange; polling continues as a fallback for installs/);
    expect(body).toMatch(/where the URL scheme registration didn't take\./);
    expect(body).toMatch(
      /- `apps\/gui-client\/tests\/unit\/use-browser-sign-in\.test\.tsx`: 3 new/,
    );
    expect(body).toMatch(/tests cover the deep-link primary path \+ state mismatch silent-skip/);
    expect(body).toMatch(/- polling fallback when `onOpenUrl` throws\./);
  });

  it("macOS validation + Info.plist + CFBundleURLTypes framing pinned: '### macOS' + 'cd apps/gui-client' + 'npm run tauri build  # signs the app bundle' + 'open src-tauri/target/release/bundle/macos/Driftstack.app' + 'In the dashboard, complete a sign-in to the point where it would redirect to driftstack://auth/callback?code=...&state=...' + 'The GUI should pick up the auth instantly (no 2s poll wait).' + 'If the URL scheme doesn't register: check `Driftstack.app/Contents/Info.plist` includes a `CFBundleURLTypes` array with `CFBundleURLSchemes = [\"driftstack\"]`.' + 'The Tauri 2.x deep-link plugin should add this automatically based on the tauri.conf.json `schemes` entry, but the build process is opinionated about Info.plist merging — verify post-build.' — pinned so the macOS-validation + signed-app-bundle + driftstack://auth/callback example + no-2s-poll-wait + Info.plist CFBundleURLTypes / CFBundleURLSchemes verification + opinionated-Info.plist-merging caveat commitment survives", () => {
    expect(body).toMatch(/### macOS/);
    expect(body).toMatch(/cd apps\/gui-client/);
    expect(body).toMatch(/npm run tauri build {2}# signs the app bundle/);
    expect(body).toMatch(/open src-tauri\/target\/release\/bundle\/macos\/Driftstack\.app/);
    expect(body).toMatch(/# In the dashboard, complete a sign-in to the point where it would/);
    expect(body).toMatch(/# redirect to driftstack:\/\/auth\/callback\?code=\.\.\.&state=\.\.\./);
    expect(body).toMatch(/# The GUI should pick up the auth instantly \(no 2s poll wait\)\./);
    expect(body).toMatch(/If the URL scheme doesn't register: check/);
    expect(body).toMatch(/`Driftstack\.app\/Contents\/Info\.plist` includes a/);
    expect(body).toMatch(/`CFBundleURLTypes` array with/);
    expect(body).toMatch(/`CFBundleURLSchemes = \["driftstack"\]`\./);
    expect(body).toMatch(/The Tauri 2\.x deep-link plugin should add this automatically based on/);
    expect(body).toMatch(/the tauri\.conf\.json `schemes` entry, but the build process is/);
    expect(body).toMatch(/opinionated about Info\.plist merging — verify post-build\./);
  });

  it("Windows + Linux validation framing pinned: '### Windows' + 'Run the produced .msi installer. Installation writes registry entries under HKCU\\Software\\Classes\\driftstack mapping the scheme to the app executable.' + 'If `driftstack://` URLs don't open the app: open `regedit.exe` and verify `HKCU\\Software\\Classes\\driftstack\\shell\\open\\command` exists and points to the installed .exe with a `%1` placeholder.' + '### Linux (.deb / AppImage)' + 'sudo dpkg -i src-tauri/target/release/bundle/deb/driftstack_*.deb' + 'Or: chmod +x src-tauri/target/release/bundle/appimage/Driftstack_*.AppImage' + 'The `.deb` path writes a `/usr/share/applications/driftstack.desktop` entry with `MimeType=x-scheme-handler/driftstack;`.' + 'xdg-open driftstack://auth/callback?code=test&state=test' + 'If the GUI doesn't launch: verify the .desktop file's `Exec=` line points to the installed binary AND that `MimeType=` contains the scheme handler. Run `update-desktop-database` if needed.' + 'The AppImage path is separate; deep-link registration on AppImage is notoriously inconsistent and is documented as a fallback path that relies on the polling loop to keep working.' — pinned so the Windows-HKCU-registry-%1-placeholder + Linux-.desktop-MimeType-x-scheme-handler/driftstack + xdg-open-test-command + AppImage-notoriously-inconsistent-polling-fallback commitment survives", () => {
    expect(body).toMatch(/### Windows/);
    expect(body).toMatch(/Run the produced \.msi installer\. Installation writes registry/);
    expect(body).toMatch(/entries under HKCU\\Software\\Classes\\driftstack mapping the scheme to/);
    expect(body).toMatch(/the app executable\./);
    expect(body).toMatch(/If `driftstack:\/\/` URLs don't open the app: open `regedit\.exe` and/);
    expect(body).toMatch(
      /verify `HKCU\\Software\\Classes\\driftstack\\shell\\open\\command` exists/,
    );
    expect(body).toMatch(/and points to the installed \.exe with a `%1` placeholder\./);
    expect(body).toMatch(/### Linux \(\.deb \/ AppImage\)/);
    expect(body).toMatch(
      /sudo dpkg -i src-tauri\/target\/release\/bundle\/deb\/driftstack_\*\.deb/,
    );
    expect(body).toMatch(
      /# Or: chmod \+x src-tauri\/target\/release\/bundle\/appimage\/Driftstack_\*\.AppImage/,
    );
    expect(body).toMatch(
      /The `\.deb` path writes a `\/usr\/share\/applications\/driftstack\.desktop`/,
    );
    expect(body).toMatch(/entry with `MimeType=x-scheme-handler\/driftstack;`\./);
    expect(body).toMatch(/xdg-open driftstack:\/\/auth\/callback\?code=test&state=test/);
    expect(body).toMatch(/If the GUI doesn't launch: verify the \.desktop file's `Exec=` line/);
    expect(body).toMatch(/points to the installed binary AND that `MimeType=` contains the/);
    expect(body).toMatch(/scheme handler\. Run `update-desktop-database` if needed\./);
    expect(body).toMatch(/The AppImage path is separate; deep-link registration on AppImage is/);
    expect(body).toMatch(/notoriously inconsistent and is documented as a fallback path that/);
    expect(body).toMatch(/relies on the polling loop to keep working\./);
  });

  it("Server-side V-328e follow-on + Rollback framing pinned: '## Server-side dashboard work (separate slice)' + (V-800 retracted the not-in-this-slice / listener-never-fires framing: cli/authorize.astro emits the redirect on success today) '## Rollback' + 'If a per-platform test reveals a regression that's hard to fix quickly:' + 'git revert <V-328-commit-sha>' + 'The pre-V-328 polling loop is fully functional and ships as a fallback even with V-328 active, so a revert just removes the listener registration — no data loss, no key re-mint required.' — pinned so the V-328e follow-on + /auth/cli-callback window.location.href + polling-fallback-still-works-after-revert + no-data-loss-no-key-re-mint commitment survives", () => {
    expect(body).toMatch(/## Server-side dashboard work \(separate slice\)/);
    // V-800 — the dashboard side SHIPPED. cli/authorize.astro defines
    // returnToDesktop(delayMs), which assigns driftstack://auth/callback, and
    // calls it with 600 on the success path and 0 on the unknown-outcome retry.
    // The old assertions froze the opposite and would have had the founder read
    // a working hand-off as a broken one mid-test.
    expect(body).toMatch(/mints a key, lets the desktop app pick/);
    expect(body).toMatch(/`returnToDesktop\(delayMs\)`, which assigns/);
    expect(body).toMatch(/delay on the success path/);
    expect(body).toMatch(/with 0 on the retry path when the authorize outcome is/);
    expect(body, 'the retraction stays so this cannot quietly revert').toMatch(
      /V-800 — this section used to say the redirect was not in the slice/,
    );
    expect(body).not.toMatch(/deep-link listener never fires/);
    expect(body).not.toMatch(/The server-side change is NOT in this slice/);
    expect(body).not.toMatch(/it just sits idle until the/);
    expect(body).toMatch(/Both halves are now live: the native listener is registered and the/);
    expect(body).toMatch(/manual confirmation below, not a wait on the server side\./);
    expect(body).toMatch(/## Rollback/);
    expect(body).toMatch(/git revert <V-328-commit-sha>/);
    expect(body).toMatch(/The pre-V-328 polling loop is fully functional and ships as a/);
    expect(body).toMatch(/fallback even with V-328 active, so a revert just removes the/);
    expect(body).toMatch(/listener registration — no data loss, no key re-mint required\./);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
