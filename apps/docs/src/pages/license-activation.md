---
layout: ../layouts/DocLayout.astro
title: License activation (GUI client)
description: Activate the Driftstack macOS desktop app through browser sign-in, with a paid customer key or self-hosted key as an explicit fallback.
---

# License activation (GUI client)

You don't need to find or buy a license key. The Driftstack macOS desktop GUI
client defaults to secure browser sign-in: authorize the device in the
dashboard and the app automatically stores its restricted device credential.
Free users do not create or paste a customer API key. A paid cloud customer
key or a key minted by your self-hosted control plane remains available as an
explicit fallback.

## What you need

- The signed desktop app build supplied through your account or self-hosted deployment channel. Do not install builds from unofficial mirrors.
- A Driftstack dashboard account for the default browser sign-in flow.
- Your tier supports GUI client access. Every cloud tier, including Free,
  Manual, API, and Enterprise, can activate; self-hosted
  Solo/Pro/Enterprise customers point at their own server URL.
- Only if using the fallback: a `ds_live_…` customer key from any paid tier,
  including Manual, or a key minted by your own self-hosted deployment.

## First-run flow

On first launch, the GUI client opens a five-step wizard:

1. **Welcome** — brand intro and a one-line value prop.
2. **Deployment mode** — radio: **Cloud** (`https://api.driftstack.dev`) or **Self-hosted** (you paste the URL — defaults to `http://localhost:3000`, matching the port `apps/server` binds to in dev). The GUI is a control panel; the Self-hosted branch points it at a Driftstack Node server you operate yourself.
3. **Sign in** — use **Sign in with browser** by default. After you approve the
   device, the wizard exchanges the one-time code, stores the returned
   credential, and calls `GET /v1/account/me` to validate it. Free receives a
   restricted `ds_test_…` device credential automatically; there is nothing to
   copy from the API-key page. **Have an API key? Paste it instead** is the
   paid-cloud/self-hosted fallback. You see one of:
   - ✅ valid — wizard advances.
   - ❌ wrong fallback key — the message is deployment-aware. Cloud mode:
     "Authentication failed (401). Double-check the key, or create a new one
     at app.driftstack.io/api-keys." Self-hosted mode explains that the key
     must be created on your own server's dashboard — a cloud key will not
     authenticate against a self-hosted server.
   - ❌ unreachable — the message starts with "Couldn't reach `<url>`." and
     gives URL, connection, firewall, VPN, and self-hosted-server guidance.
   - ❌ not permitted — the privacy-safe fixed message is "You do not have
     permission to perform this action." Check the dashboard account status
     and team access rather than expecting server diagnostic prose in the app.
4. **First profile** (skippable) — name + archetype picker. The wizard calls `POST /v1/profiles` against the validated client.
5. **Done** — flag flipped; main app shell takes over.

## Where credentials live

- **Device credential or fallback API key** — stored in macOS Keychain through
  `keyring-rs`. It never lands in `settings.json` on disk.
- **Base URL** — stored in the Tauri settings store (`settings.json`). Plaintext is fine here; the URL alone confers no access.

If you delete the keychain entry manually, the GUI client treats the next launch as first-run and walks you through the wizard again.

## Switching deployments

To re-point the GUI from cloud to self-hosted (or vice versa):

1. **Settings → Account → Sign out**. Removes the current deployment's
   credential from Keychain without revoking it on the server; the non-secret
   base URL and other preferences remain in `settings.json`.
2. The first-run wizard reappears immediately. Pick the new deployment mode.
3. Use browser sign-in for cloud, or paste the
   matching paid/self-hosted fallback key.

Alternatively, edit `settings.json` (Tauri's app data dir) directly to change
`baseUrl`, restart the app so it reloads the store, then authorize again from
**Settings → Account**.

## Self-hosted activation

For self-hosted deployments (Driftstack Self-Hosted Solo / Pro / Enterprise):

1. Stand up the control plane on your own hardware with the [self-hosted operations runbook](https://github.com/driftstackdev/driftstack-api/tree/main/docs/operations).
2. Create an API key against your local control plane (same `/v1/api-keys` flow — requires the `account_owner` scope).
3. In the GUI client wizard, choose **Self-hosted**, paste the URL of your control plane (e.g. `https://drift.your-company.internal`), paste the key.

The same GUI binary works against any control plane — there is no "self-hosted edition" of the desktop app. The deployment-mode toggle is the only switch.

## Platform support

- **macOS on Apple silicon** is the current supported distribution target.
- Builds are **not** Apple Developer ID code-signed, hardened-runtime, or
  notarised. macOS therefore shows an unidentified-developer warning the first
  time you launch the app: right-click it in Applications, choose **Open**, and
  confirm. The release artifacts _are_ signed with our Tauri updater key, which
  is what the update check below verifies — that signature proves an update came
  from us, and is a different thing from Apple code signing.
- Local test builds use a machine-scoped development signing identity and are not distribution artifacts.
- The release pipeline also builds Windows (`.exe`, NSIS) and Linux
  (`.AppImage`, `.deb`) bundles, but macOS on Apple silicon is the only platform
  we support. Installers are published as GitHub Releases from a `gui-v*` tag.

## Updates

Tauri Updater checks the signed GitHub Releases manifest once at startup. When
a newer version exists, the app shows a non-blocking in-app banner; it does not
download anything until you choose **Install**. The updater then downloads the
bundle, verifies its signature against the embedded public key, installs it,
and relaunches the app. See [the gui-client packaging notes](https://github.com/driftstackdev/driftstack-api/blob/main/apps/gui-client/PACKAGING.md) for the full update protocol.

## Troubleshooting

- **"Authentication failed"** — retry cloud browser sign-in first. If you chose
  the fallback, verify that the paid key belongs to the selected deployment.
  In self-hosted mode, a cloud key never works against your own server (and
  vice-versa). Settings re-validates credentials and shows the same guidance.
- **"Couldn't reach control plane"** — for cloud, check [status.driftstack.io](https://status.driftstack.io). For self-hosted, check your control plane's `/v1/status` endpoint directly.
- **Wizard re-fires on every launch** — macOS Keychain may be unavailable to the app. Confirm the app is signed correctly and reinstall the supplied build if it was modified or quarantined.
- **"You do not have permission" on activation** — sign in to the dashboard
  and check the account status and selected team. If the account is active and
  access still fails, email [support@driftstack.dev](mailto:support@driftstack.dev).

## Next steps

- **[Profile management](/guides/profile-management/)** — create and reuse profiles in the GUI.
- **[Session lifecycle](/guides/session-lifecycle/)** — what each session state means.
- **[Quickstart](/quickstart/)** — drive sessions from code instead of (or alongside) the GUI.
