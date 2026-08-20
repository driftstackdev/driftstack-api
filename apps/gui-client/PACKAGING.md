# Driftstack self-hosted GUI — macOS packaging runbook

The current build emits a macOS `.app` for Apple silicon and is distributed
outside the App Store. Sandboxing is off because the app connects to arbitrary
HTTPS Driftstack servers, including private self-hosted endpoints. Every
customer-distributed build must use the hardened runtime, Developer ID signing,
notarisation, stapling, and Gatekeeper verification.

## One-time setup (founder)

1. Apple Developer account active. The personal account is fine for
   pre-entity-launch builds; ownership transfers to the entity-org
   cert after KvK closure.
2. Generate two certs in
   <https://developer.apple.com/account/resources/certificates>:
   - **Developer ID Application** (signs the `.app` bundle).
   - **Developer ID Installer** (required only for a signed `.pkg`; the current
     app-only target does not use it).
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

If notarisation fails, Apple's response is logged in the build output
— most failures are "missing entitlement" or "unsigned framework";
re-check `Entitlements.plist` and ensure the signing identity is
"Developer ID" not "Apple Development".

## Smoke-test the unsigned build (no env vars set)

`tauri:build` works without signing env vars — it produces an unsigned
`.app`. macOS will block it with a Gatekeeper warning, but
right-click → Open → Open bypasses the warning for local QA.

## Known limits

- **DMG bundling is enabled, and can still fail LOCALLY.** `targets`
  includes `dmg`, and the release workflow publishes a `.dmg` that its
  own release notes tell customers to download. Building one on a local
  Mac is the part that breaks: the Tauri-bundled `bundle_dmg.sh` runs an
  AppleScript that styles the mounted DMG window (icon positions,
  drop-link), and without Finder automation permission it fails with
  `AppleEvent timed out (-1712)`. The `.app` builds cleanly either way.
  To build a DMG locally, either:
  1. Grant **System Settings → Privacy & Security → Automation →
     Terminal (or your IDE) → Finder** permission; or
  2. Swap to a non-AppleScript DMG tool (e.g. `create-dmg` via
     Homebrew, called from a postbuild script).
     V-035 captures the empirical detail.
- **Apple silicon only.** The current build target is
  `aarch64-apple-darwin`; no Intel binary is distributed.
- **Signed updater active.** `tauri-plugin-updater` checks the configured
  GitHub Releases `latest.json` endpoint on startup. Tauri verifies the
  manifest signature with the configured public key before the GUI offers an
  install/relaunch action. A missing release or network failure degrades to
  “no update available” and never bypasses signature verification.
- **Sandbox off.** This is a direct-distribution application. Its self-hosted
  connectivity and proxy workflows are outside the Mac App Store sandbox
  contract.

## Local build + install without repeated Keychain prompts

The main GUI keeps long-lived API and proxy credentials in macOS Keychain, and
local signing keeps its private key there too. Never work around those prompts by
moving an API key, proxy secret, signing key, or password into an environment
variable, Tauri store, browser storage, or durable plaintext file.

Short-lived per-session `gui_control` credentials follow a deliberately different
contract. The API supplies the credential with its expiry. The main GUI may carry
that response to the separate Simulator through the existing owner-only `0600`,
single-use handoff file; this is ephemeral cross-process transport, not durable
storage. Each launch gets a unique non-secret handoff identity and file path, so an
older same-session opener or cleanup cannot consume its successor. The Simulator
opens without following symlinks, unlinks the exact handoff before reading it,
validates the session/key/expiry, and stores the credential in Rust process memory
before any WebView URL or `ds-session` event is applied. For control authorization,
the internal URL/event contains only the non-secret monotonic `cg` generation,
never the control key or expiry; the separate LiveKit join token follows its
existing in-memory WebView handoff.

The native store is bound to the exact window, session, and generation; holds at
most 32 credentials; preserves the API expiry with an additional 24-hour ceiling;
does not extend expiry on reads; and zeroizes native values on replacement, expiry,
LRU eviction, explicit deletion, window destruction, and process teardown. The
Simulator exposes only dedicated native load/delete commands for an exact active
generation. Generic Keychain save/load/delete commands remain restricted to the
main GUI's bounded API/proxy namespaces. Pre-existing `gui_control:*` Keychain
items are inert: the app neither reads, enumerates, nor deletes them, avoiding a
migration-time authorization prompt. Legacy browser entries are scrubbed rather
than imported. Frontend and API-response strings are managed-language copies and
are not claimed to be deterministically zeroized.

An ad-hoc signature (`codesign --sign -`) has no stable signer identity. Its
designated requirement is the executable's CDHash, which changes on every rebuild;
Keychain therefore treats every rebuilt caller of the remaining durable secrets
and the signing identity as new code and can ask again. The canonical installer
refuses that unsafe and annoying state.

For local-only development on a Mac without an Apple signing certificate, run once:

```bash
scripts/setup-local-gui-signing.sh
```

The script creates `Driftstack Local Development Signing` in the user's login
keychain, grants `/usr/bin/codesign` access, and scopes the partition change to that
exact private key using its certificate subject-key identifier. macOS requires the
`apple:` code-signing partition in addition to the imported trusted-application ACL;
without it, every rebuilt bundle can stop at a password dialog. The setup command may
ask once for the login-keychain password through SecurityAgent. Approve that explicit
setup action; the script never reads, passes on a command line, or stores the password.
When noninteractive administrator authorization is already cached, it installs the
code-signing trust record in the system trust domain without another password dialog.
Otherwise macOS may also ask once to approve user-domain trust. Owner-only temporary
key material is deleted on exit. The identity is local development trust only;
it cannot replace Developer ID signing/notarisation for a distributed build.

Then use only the canonical installer for normal updates:

```bash
scripts/build-install-gui.sh
```

`--preflight` is an optional first-setup or diagnostic check; the full installer
already performs the same check before it compiles anything:

```bash
scripts/build-install-gui.sh --preflight
```

The one-time setup and installer share one descriptor-owned kernel lock, acquired before
setup discovers the default Keychain or the installer discovers an identity. The installer
therefore admits only one local build/sign/install attempt at a time, and setup cannot
replace or repartition its selected key mid-build; two terminals cannot multiply Keychain
authorization requests. `--preflight` resolves a valid stable identity without compiling.
Identity discovery binds the certificate's exact public hash to its name, collapses
duplicate listings of that same hash, and fails before private-key access if one name
resolves to different keys. For the local-only identity, it also reads the selected
certificate fingerprint and requires the exact owner-only v2 authorization marker written
by `setup-local-gui-signing.sh`. It then
performs one bounded signature on a disposable copy of `/usr/bin/true`; the marker is
accepted only when that real private-key operation and signature verification finish
without an authorization wait. A missing, rotated, stale, or ineffective marker is
invalidated and stops with the setup instruction before either Tauri build, bundle
signature, or installation can start. This turns a broken ACL into one bounded
preflight failure instead of several nested main/Simulator Keychain prompts.

The full command removes Apple certificate/signing/notarisation variables only from its
two local Tauri build subprocesses, preventing Tauri from independently asking for the
private key. The installer then performs exactly the two final source-bundle signatures
it owns, using the selected exact identity hash and the same certificate anchor for both.
It rejects CDHash-only requirements, checks each bundle identifier, signs and verifies
both source bundles before replacing either installed application, and proves each
installed copy retained the exact designated requirement. This local path requests only
the macOS `.app` target that it installs, so unrelated distribution packaging (DMG,
NSIS, AppImage, and deb) cannot block a developer update. Distribution builds continue
to use the Apple variables documented above. `APPLE_SIGNING_IDENTITY` overrides local
discovery for a valid Developer ID identity; that Apple-issued identity is validated
against the keychain but does not use the local setup marker.
