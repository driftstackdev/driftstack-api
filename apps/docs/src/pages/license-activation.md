---
layout: ../layouts/DocLayout.astro
title: License activation (GUI client)
description: Activate the Driftstack macOS desktop app with the API key you already have — no separate license key, for both cloud and self-hosted deployments.
---

# License activation (GUI client)

You don't need to find or buy a license key — the API key you already have is the activation. The Driftstack macOS desktop GUI client doesn't use a separate license-key system. It activates against the same API key you use for SDK calls, and points at either the cloud control plane or your own self-hosted instance.

## What you need

- The signed desktop app build supplied through your account or self-hosted deployment channel. Do not install builds from unofficial mirrors.
- An API key from [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys/). Same shape as the API key your SDK calls use.
- Your tier supports GUI client access. Cloud customers on any Manual or API tier (or the Free tier) can activate; self-hosted Solo/Pro/Enterprise customers point at their own server URL.

## First-run flow

On first launch, the GUI client opens a five-step wizard:

1. **Welcome** — brand intro and a one-line value prop.
2. **Deployment mode** — radio: **Cloud** (`https://api.driftstack.dev`) or **Self-hosted** (you paste the URL — defaults to `http://localhost:3000`, matching the port `apps/server` binds to in dev). The GUI is a control panel; the Self-hosted branch points it at a Driftstack Node server you operate yourself.
3. **API key** — paste the key. The wizard immediately calls `GET /v1/account/me` to validate. You see one of:
   - ✅ valid — wizard advances.
   - ❌ wrong key — the message is deployment-aware. Cloud mode: "Authentication failed (401). Double-check the key, or create a new one at app.driftstack.dev/api-keys." Self-hosted mode explains that the key must be created on your own server's dashboard — a key from app.driftstack.dev won't authenticate against a self-hosted server (keys are bound to the deployment that minted them).
   - ❌ unreachable — "Couldn't reach the control plane at `<url>`. Check the URL and your network."
   - ❌ tier-suspended — "This account is suspended. Email support@driftstack.dev."
4. **First profile** (skippable) — name + archetype picker. The wizard calls `POST /v1/profiles` against the validated client.
5. **Done** — flag flipped; main app shell takes over.

## Where credentials live

- **API key** — stored in macOS Keychain through `keyring-rs`. The key never lands in `settings.json` on disk.
- **Base URL** — stored in the Tauri settings store (`settings.json`). Plaintext is fine here; the URL alone confers no access.

If you delete the keychain entry manually, the GUI client treats the next launch as first-run and walks you through the wizard again.

## Switching deployments

To re-point the GUI from cloud to self-hosted (or vice versa):

1. **Settings → Account → Sign out**. Wipes the keychain entry and `settings.json` baseUrl.
2. Restart the app. The first-run wizard shows again.
3. Pick the new deployment mode and paste the matching API key.

Alternatively, edit `settings.json` (Tauri's app data dir) directly to change `baseUrl`, then re-paste a key in **Settings → Account → API key**.

## Self-hosted activation

For self-hosted deployments (Driftstack Self-Hosted Solo / Pro / Enterprise):

1. Stand up the control plane on your own hardware with the [self-hosted operations runbook](https://github.com/driftstackdev/driftstack-api/tree/main/docs/operations).
2. Create an API key against your local control plane (same `/v1/api-keys` flow — requires the `account_owner` scope).
3. In the GUI client wizard, choose **Self-hosted**, paste the URL of your control plane (e.g. `https://drift.your-company.internal`), paste the key.

The same GUI binary works against any control plane — there is no "self-hosted edition" of the desktop app. The deployment-mode toggle is the only switch.

## Platform support

- **macOS on Apple silicon** is the current supported distribution target.
- Distributed builds must pass Developer ID signature, hardened-runtime, notarisation, and Gatekeeper verification before installation.
- Local test builds use a machine-scoped development signing identity and are not distribution artifacts.
- The current distribution channel does not publish Windows or Linux installers.

## Updates

Tauri Updater + GitHub Releases ship updates automatically. The app polls the manifest URL on startup, downloads + signature-verifies new versions in the background, and prompts you on next launch. See [the gui-client packaging notes](https://github.com/driftstackdev/driftstack-api/blob/main/apps/gui-client/PACKAGING.md) for the full update protocol.

## Troubleshooting

- **"Authentication failed"** — in cloud mode, verify the key in [app.driftstack.dev/api-keys](https://app.driftstack.dev/api-keys/); revoking and reissuing the key is the safest reset. In self-hosted mode, make sure the key was created on the server the GUI points at — keys are bound to the deployment that minted them, so a cloud key never works against your own server (and vice-versa). Settings also re-validates the key on every save and shows the same guidance inline.
- **"Couldn't reach control plane"** — for cloud, check [status.driftstack.dev](https://status.driftstack.dev). For self-hosted, check your control plane's `/v1/status` endpoint directly.
- **Wizard re-fires on every launch** — macOS Keychain may be unavailable to the app. Confirm the app is signed correctly and reinstall the supplied build if it was modified or quarantined.
- **Tier-suspended on activation** — the account is in a suspended state in billing. Email [support@driftstack.dev](mailto:support@driftstack.dev) with the account email and we'll resolve.

## Next steps

- **[Profile management](/guides/profile-management/)** — create and reuse profiles in the GUI.
- **[Session lifecycle](/guides/session-lifecycle/)** — what each session state means.
- **[Quickstart](/quickstart/)** — drive sessions from code instead of (or alongside) the GUI.
