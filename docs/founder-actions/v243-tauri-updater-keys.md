# V-243 — Tauri Updater key generation (founder ops action)

Per V-243 / D-2026-05-06-03: the GUI client's Tauri Updater needs a
public/private keypair for signing update bundles. This is a one-time
generation; the keys live for the lifetime of the GUI client product
(rotation requires shipping a new public key in a release that's
signed by the OLD key, then deprecating the old key after customers
have upgraded).

## Action

Run on the founder's local Mac (anywhere `npx tauri` resolves):

```sh
cd /path/to/driftstack-api/apps/gui-client
npx tauri signer generate -w ~/.driftstack-keys/gui-update
```

The command prompts for a password (interactive). Choose a strong one;
record it in 1Password under "Driftstack GUI Updater Signing Key".

## Outputs

Two files at `~/.driftstack-keys/gui-update`:

- `gui-update.key` — **private** key. Never commit. Never share.
  Upload to GitHub Actions secret `TAURI_UPDATER_PRIVKEY`.
- `gui-update.key.pub` — **public** key. Safe to embed in app
  bundles + commit to repo. Upload to GitHub Actions secret
  `TAURI_UPDATER_PUBKEY` AND replace the `$TAURI_UPDATER_PUBKEY`
  placeholder in `apps/gui-client/src-tauri/tauri.conf.json` with the
  literal public-key string before the first release build.

  (The CI workflow `.github/workflows/gui-release.yml` does this
  substitution automatically using the `TAURI_UPDATER_PUBKEY` secret;
  the placeholder in the committed config is a build-time reminder.)

## GitHub Actions secrets to set

After generating + recording the password:

```
gh secret set TAURI_UPDATER_PUBKEY < ~/.driftstack-keys/gui-update.key.pub
gh secret set TAURI_UPDATER_PRIVKEY < ~/.driftstack-keys/gui-update.key
gh secret set TAURI_UPDATER_PRIVKEY_PASSWORD --body 'the-password-from-1Password'
```

(Or set via the GitHub web UI under **Settings → Secrets and variables → Actions**.)

## After the secrets are set

1. Trigger the first release: `git tag gui-v0.1.0 && git push --tags`.
2. The workflow builds + signs cross-platform binaries + publishes a
   GitHub Release. Verify:
   - Release exists at `github.com/driftstackdev/driftstack-api/releases/tag/gui-v0.1.0`.
   - Three platform binaries attached: `.dmg` (macOS), `.exe` (Windows), `.AppImage` + `.deb` (Linux).
   - `gui-latest.json` manifest attached.
3. Test auto-update by installing v0.1.0, then tagging `gui-v0.1.1`,
   then waiting for the in-app prompt or restarting.

## Backup

Store a backup of `~/.driftstack-keys/` in encrypted form (1Password
attachment, or encrypted disk image). If the private key is lost,
existing customer installs cannot receive any further updates without
also reinstalling — there is no recovery path other than full
re-distribution with a new public key.

## Rotation (future, not now)

If the private key is suspected compromised:

1. Generate a new keypair (same command).
2. Ship a release built with the OLD private key that contains a
   tauri.conf.json updated to the NEW public key. (Customers running
   the previous version verify the update with the OLD pub-key
   embedded in their install, then trust the NEW pub-key going forward.)
3. After ~30 days (most customers updated), retire the old key.
4. Document the rotation date in `docs/decisions.md` as a follow-up
   to D-2026-05-06-03.

## Related

- D-2026-05-06-03 (this decision).
- V-243 (V-log entry for the autopilot work landing this scaffold).
- Tauri Updater docs: https://tauri.app/v1/guides/distribution/updater/
