# Driftstack self-hosted GUI — macOS packaging runbook

The GUI ships as a notarised `.app` bundle inside a `.dmg`, distributed
outside the App Store. Sandboxing is off (the app needs to talk to
arbitrary HTTP/HTTPS Driftstack servers, including localhost during
self-host); hardened runtime + notarisation are on (Gatekeeper requires
both for distribution).

## One-time setup (founder)

1. Apple Developer account active. The personal account is fine for
   pre-entity-launch builds; ownership transfers to the entity-org
   cert after KvK closure.
2. Generate two certs in
   <https://developer.apple.com/account/resources/certificates>:
   - **Developer ID Application** (signs the `.app` bundle).
   - **Developer ID Installer** (signs `.pkg` if we ever ship one;
     currently `.dmg` only, so optional).
     Download both; install into the **login keychain**.
3. Create an **app-specific password** at
   <https://account.apple.com/account/manage> → Sign-in security →
   App-specific passwords. Save the value (one-shot — Apple won't show
   it again).
4. Find your **team id** in
   <https://developer.apple.com/account#MembershipDetailsCard>.

## Per-build env vars

The `tauri build` step reads these from the environment:

| Env var                  | What                                    | Example                                                        |
| ------------------------ | --------------------------------------- | -------------------------------------------------------------- |
| `APPLE_SIGNING_IDENTITY` | The cert's common name                  | `Developer ID Application: <YOUR DEVELOPER NAME> (XXXXXXXXXX)` |
| `APPLE_ID`               | Apple ID email                          | `your@apple.id`                                                |
| `APPLE_PASSWORD`         | App-specific password from setup step 3 | `xxxx-xxxx-xxxx-xxxx`                                          |
| `APPLE_TEAM_ID`          | Team id from setup step 4               | `XXXXXXXXXX`                                                   |

Do **not** commit any of these. Keep them in `~/.driftstack/build.env`
or similar and `source` it before building:

```bash
set -a; . ~/.driftstack/build.env; set +a
```

## Build

```bash
cd apps/gui-client
npm run tauri:build
```

Tauri will:

1. Compile the React frontend (`vite build`).
2. Compile the Rust binary in release mode.
3. Wrap it as `Driftstack.app` under `src-tauri/target/release/bundle/macos/`.
4. Codesign the bundle with `APPLE_SIGNING_IDENTITY` (hardened runtime
   on, entitlements from `Entitlements.plist`).
5. Submit the bundle to Apple for notarisation
   (`xcrun notarytool submit --wait`).
6. Staple the notarisation ticket to the bundle.
7. Wrap it as `Driftstack_<version>_aarch64.dmg`.

If notarisation fails, Apple's response is logged in the build output
— most failures are "missing entitlement" or "unsigned framework";
re-check `Entitlements.plist` and ensure the signing identity is
"Developer ID" not "Apple Development".

## Smoke-test the unsigned build (no env vars set)

`tauri:build` works without signing env vars — it produces an unsigned
`.app` and `.dmg`. macOS will block it with a Gatekeeper warning, but
right-click → Open → Open bypasses the warning for local QA.

## Known limits

- **DMG bundling currently disabled** (`targets: ["app"]`). The
  Tauri-bundled `bundle_dmg.sh` runs an AppleScript that styles the
  mounted DMG window (icon positions, drop-link); on this Mac it
  fails with `AppleEvent timed out (-1712)` because Finder
  automation permission isn't granted to the build process. The
  `.app` builds cleanly. To re-enable DMG output, either:
  1. Grant **System Settings → Privacy & Security → Automation →
     Terminal (or your IDE) → Finder** permission, then flip targets
     back to `["app", "dmg"]`; or
  2. Swap to a non-AppleScript DMG tool (e.g. `create-dmg` via
     Homebrew, called from a postbuild script).
     V-035 captures the empirical detail.
- **Universal binary not configured.** Current build is single-arch
  (`aarch64-apple-darwin`). Adding `x86_64-apple-darwin` requires
  installing the cross-target via `rustup target add` and configuring
  `tauri.conf.json bundle.macOS.frameworks` appropriately. Surface to
  founder when it matters; Apple Silicon-only is fine for the
  founder's personal dev tool.
- **No auto-update mechanism.** Tauri's updater plugin can sign and
  publish update manifests; queued for a later phase once the
  release cadence stabilises.
- **Sandbox off.** As noted above. If we ever distribute through the
  Mac App Store we'd need to re-architect for sandbox compatibility,
  primarily around the proxy config and self-hosted server
  connectivity — non-trivial.

## Local build + install without repeated Keychain prompts

The main GUI and Simulator read protected credentials from macOS Keychain. Never
work around a prompt by moving API, proxy, or per-session control keys into a file,
environment variable, Tauri store, or browser storage.

An ad-hoc signature (`codesign --sign -`) has no stable signer identity. Its
designated requirement is the executable's CDHash, which changes on every rebuild;
Keychain therefore treats every rebuilt main and Simulator app as new code and asks
again. The canonical installer refuses that unsafe and annoying state.

For local-only development on a Mac without an Apple signing certificate, run once:

```bash
scripts/setup-local-gui-signing.sh
```

The script creates `Driftstack Local Development Signing` in the user's login
keychain, grants its private key only to `/usr/bin/codesign`, and deletes its
owner-only temporary key material on exit. When noninteractive administrator
authorization is already cached, it installs the code-signing trust record in the
system trust domain without another password dialog. Otherwise macOS may ask once
to unlock the login keychain or approve user-domain trust; the script never reads or
stores that password. The identity is local development trust only;
it cannot replace Developer ID signing/notarisation for a distributed build.

Then use only the canonical installer:

```bash
scripts/build-install-gui.sh --preflight
scripts/build-install-gui.sh
```

`--preflight` resolves a valid stable identity without compiling. The full command
builds and signs both bundles with the same certificate anchor, rejects CDHash-only
requirements, checks each bundle identifier, and proves the installed copy retained
the exact designated requirement. This local path requests only the macOS `.app`
target that it installs, so unrelated distribution packaging (DMG, NSIS, AppImage,
and deb) cannot block a developer update. `APPLE_SIGNING_IDENTITY` overrides local
discovery for real Developer ID builds and is validated against the login keychain
first.
