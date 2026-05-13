// W544.A — drift guard for /docs/founder-actions/v243-tauri-updater-keys.md.
// Founder runbook for Tauri Updater key generation. Cross-referenced
// from W541.C gui-build-check parity + W542.C gui-release parity.
// Drift here either drops the V-252 file-naming correction (would
// re-introduce the `.key` extension bug), removes the stdin-not-body
// password-handling rule (would re-permit a shell-history-exposed
// secret), or drops the rotation guidance (would leave no recovery
// path if the private key is suspected compromised).
//
//   • V-243 / D-2026-05-06-03 anchor + one-time-keygen +
//     rotation-requires-bridge-release framing.
//   • `npx tauri signer generate -w ~/.driftstack-keys/gui-update`
//     command + 1Password recording.
//   • V-252 file-naming correction: outputs are `gui-update` (no
//     extension) + `gui-update.pub`. NOT `.key` / `.key.pub`.
//   • Stdin (`<`) for `gh secret set`, NOT `--body 'pass'` (shell
//     history exposure rationale).
//   • Web-UI alternative for password.
//   • Rotation: ship release built with OLD key containing NEW
//     pubkey, wait 30d, retire old key.
//   • Backup encrypted in 1Password attachment or disk image.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'docs/founder-actions/v243-tauri-updater-keys.md');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W544.A /docs/founder-actions/v243-tauri-updater-keys.md content parity', () => {
  const body = read(LIB);

  it("Header + V-243 / D-2026-05-06-03 anchor + one-time-keygen-with-rotation-bridge framing pinned: '# V-243 — Tauri Updater key generation (founder ops action)' + 'Per V-243 / D-2026-05-06-03: the GUI client's Tauri Updater needs a public/private keypair for signing update bundles. This is a one-time generation; the keys live for the lifetime of the GUI client product (rotation requires shipping a new public key in a release that's signed by the OLD key, then deprecating the old key after customers have upgraded).' — pinned so the V-243 + D-2026-05-06-03 + one-time-keygen + rotation-via-OLD-key-signed-bridge-release commitment survives (drift to claiming routine rotation would mislead future operators about the customer-install-key-embedded constraint)", () => {
    expect(body).toMatch(/# V-243 — Tauri Updater key generation \(founder ops action\)/);
    expect(body).toMatch(/Per V-243 \/ D-2026-05-06-03: the GUI client's Tauri Updater needs a/);
    expect(body).toMatch(/public\/private keypair for signing update bundles\./);
    expect(body).toMatch(
      /This is a one-time\s*\n?generation; the keys live for the lifetime of the GUI client product/,
    );
    expect(body).toMatch(/\(rotation requires shipping a new public key in a release that's/);
    expect(body).toMatch(/signed by the OLD key, then deprecating the old key after customers/);
    expect(body).toMatch(/have upgraded\)\./);
  });

  it("Tauri signer generate command + 1Password-recording framing pinned: 'Run on the founder's local Mac (anywhere `npx tauri` resolves):' + 'cd /path/to/driftstack-api/apps/gui-client' + 'npx tauri signer generate -w ~/.driftstack-keys/gui-update' + 'The command prompts for a password (interactive). Choose a strong one; record it in 1Password under \"Driftstack GUI Updater Signing Key\".' — pinned so the founder-local-Mac + apps/gui-client cwd + `npx tauri signer generate` + -w-flag-pointing-to-~/.driftstack-keys/gui-update + interactive-password + 1Password-entry-name commitment survives", () => {
    expect(body).toMatch(/Run on the founder's local Mac \(anywhere `npx tauri` resolves\):/);
    expect(body).toMatch(/cd \/path\/to\/driftstack-api\/apps\/gui-client/);
    expect(body).toMatch(/npx tauri signer generate -w ~\/\.driftstack-keys\/gui-update/);
    expect(body).toMatch(
      /The command prompts for a password \(interactive\)\. Choose a strong one;/,
    );
    expect(body).toMatch(/record it in 1Password under "Driftstack GUI Updater Signing Key"\./);
  });

  it("V-252 file-naming correction framing pinned: '## Outputs (V-252 corrected — Tauri 2.x signer file naming)' + 'Two files at `~/.driftstack-keys/`:' + '`gui-update` — **private** key. NO file extension.' + '`gui-update.pub` — **public** key. Safe to embed in app bundles + commit to repo.' + 'replace the `$TAURI_UPDATER_PUBKEY` placeholder in `apps/gui-client/src-tauri/tauri.conf.json` with the literal public-key string before the first release build.' + 'The CI workflow `.github/workflows/gui-release.yml` does this substitution automatically' + 'V-252 correction: an earlier revision of this runbook listed the outputs as `gui-update.key` + `gui-update.key.pub`. Tauri 2.x signer actually emits `gui-update` (no extension) + `gui-update.pub`. Use the file names exactly as written above.' — pinned so the V-252 file-naming-correction (gui-update + gui-update.pub, NOT gui-update.key + gui-update.key.pub) + Tauri-2.x-signer-emits-no-extension commitment survives", () => {
    expect(body).toMatch(/## Outputs \(V-252 corrected — Tauri 2\.x signer file naming\)/);
    expect(body).toMatch(/Two files at `~\/\.driftstack-keys\/`:/);
    expect(body).toMatch(/- `gui-update` — \*\*private\*\* key\. NO file extension\./);
    expect(body).toMatch(
      /- `gui-update\.pub` — \*\*public\*\* key\. Safe to embed in app bundles \+/,
    );
    expect(body).toMatch(/commit to repo\./);
    expect(body).toMatch(/Upload to GitHub Actions secret `TAURI_UPDATER_PUBKEY`/);
    expect(body).toMatch(/replace the `\$TAURI_UPDATER_PUBKEY` placeholder in/);
    expect(body).toMatch(/`apps\/gui-client\/src-tauri\/tauri\.conf\.json`/);
    expect(body).toMatch(/\(The CI workflow `\.github\/workflows\/gui-release\.yml` does this/);
    expect(body).toMatch(
      /> \*\*V-252 correction\*\*: an earlier revision of this runbook listed the/,
    );
    expect(body).toMatch(/> outputs as `gui-update\.key` \+ `gui-update\.key\.pub`\./);
    expect(body).toMatch(
      /> actually emits `gui-update` \(no extension\) \+ `gui-update\.pub`\. Use/,
    );
  });

  it("stdin-not-body shell-history-rationale framing pinned: 'After generating + recording the password. **Use stdin (`<`) for the password — never `--body 'the-password'`** because shell history captures `--body` arguments and exposes the secret to anyone who runs `history` on the founder's machine:' + 'gh secret set TAURI_UPDATER_PUBKEY < ~/.driftstack-keys/gui-update.pub' + 'gh secret set TAURI_UPDATER_PRIVKEY < ~/.driftstack-keys/gui-update' + 'gh secret set TAURI_UPDATER_PRIVKEY_PASSWORD <<< 'the-password-from-1Password'' + 'Alternative: set the password via the GitHub web UI under **Settings → Secrets and variables → Actions**. The web UI never captures the value in any shell history.' — pinned so the stdin-not-body + shell-history-exposure-rationale + 3-gh-secret-set commands + heredoc-for-password + web-UI-alternative commitment survives (drift to recommending --body would expose secrets to shell history)", () => {
    expect(body).toMatch(
      /\*\*Use stdin \(`<`\) for the\s*\n?password — never `--body 'the-password'`\*\*/,
    );
    expect(body).toMatch(/because shell history/);
    expect(body).toMatch(/captures `--body` arguments and exposes the secret to anyone who runs/);
    expect(body).toMatch(/`history` on the founder's machine:/);
    expect(body).toMatch(
      /gh secret set TAURI_UPDATER_PUBKEY < ~\/\.driftstack-keys\/gui-update\.pub/,
    );
    expect(body).toMatch(/gh secret set TAURI_UPDATER_PRIVKEY < ~\/\.driftstack-keys\/gui-update/);
    expect(body).toMatch(
      /gh secret set TAURI_UPDATER_PRIVKEY_PASSWORD <<< 'the-password-from-1Password'/,
    );
    expect(body).toMatch(/Alternative: set the password via the GitHub web UI under/);
    expect(body).toMatch(/\*\*Settings → Secrets and variables → Actions\*\*\./);
    expect(body).toMatch(/The web UI never\s*\n?captures the value in any shell history\./);
  });

  it("First-release verification + 3-platform-binary checklist framing pinned: '1. Trigger the first release: `git tag gui-v0.1.0 && git push --tags`.' + 'Verify:' + 'Release exists at `github.com/driftstackdev/driftstack-api/releases/tag/gui-v0.1.0`.' + 'Three platform binaries attached: `.dmg` (macOS), `.exe` (Windows), `.AppImage` + `.deb` (Linux).' + '`gui-latest.json` manifest attached.' + 'Test auto-update by installing v0.1.0, then tagging `gui-v0.1.1`, then waiting for the in-app prompt or restarting.' — pinned so the gui-v0.1.0-first-tag + 3-platform-binary-checklist (.dmg + .exe + .AppImage + .deb) + gui-latest.json-manifest + v0.1.0→v0.1.1 auto-update-test commitment survives", () => {
    expect(body).toMatch(
      /1\.\s+Trigger the first release: `git tag gui-v0\.1\.0 && git push --tags`\./,
    );
    expect(body).toMatch(
      /-\s+Release exists at `github\.com\/driftstackdev\/driftstack-api\/releases\/tag\/gui-v0\.1\.0`\./,
    );
    expect(body).toMatch(
      /-\s+Three platform binaries attached: `\.dmg` \(macOS\), `\.exe` \(Windows\), `\.AppImage` \+ `\.deb` \(Linux\)\./,
    );
    expect(body).toMatch(/-\s+`gui-latest\.json` manifest attached\./);
    expect(body).toMatch(
      /3\.\s+Test auto-update by installing v0\.1\.0, then tagging `gui-v0\.1\.1`,/,
    );
  });

  it("Rotation + Backup + Related framing pinned: '## Rotation (future, not now)' + 'If the private key is suspected compromised:' + '1. Generate a new keypair (same command).' + '2. Ship a release built with the OLD private key that contains a tauri.conf.json updated to the NEW public key.' + '3. After ~30 days (most customers updated), retire the old key.' + '4. Document the rotation date in `docs/decisions.md` as a follow-up to D-2026-05-06-03.' + 'Store a backup of `~/.driftstack-keys/` in encrypted form (1Password attachment, or encrypted disk image).' + 'If the private key is lost, existing customer installs cannot receive any further updates without also reinstalling — there is no recovery path other than full re-distribution with a new public key.' + '## Related' + 'D-2026-05-06-03 (this decision).' + 'V-243 (V-log entry for the autopilot work landing this scaffold).' + 'Tauri Updater docs: https://tauri.app/v1/guides/distribution/updater/' — pinned so the OLD-key-signs-bridge-release + 30-day-wait + decisions.md follow-up + no-recovery-on-lost-private-key + Tauri-v1-docs-URL commitment survives", () => {
    expect(body).toMatch(/## Rotation \(future, not now\)/);
    expect(body).toMatch(/If the private key is suspected compromised:/);
    expect(body).toMatch(/1\. Generate a new keypair \(same command\)\./);
    expect(body).toMatch(/2\. Ship a release built with the OLD private key that contains a/);
    expect(body).toMatch(/tauri\.conf\.json updated to the NEW public key\./);
    expect(body).toMatch(/3\. After ~30 days \(most customers updated\), retire the old key\./);
    expect(body).toMatch(/4\. Document the rotation date in `docs\/decisions\.md` as a follow-up/);
    expect(body).toMatch(/to D-2026-05-06-03\./);
    expect(body).toMatch(
      /Store a backup of `~\/\.driftstack-keys\/` in encrypted form \(1Password/,
    );
    expect(body).toMatch(/attachment, or encrypted disk image\)\./);
    expect(body).toMatch(/If the private key is lost,/);
    expect(body).toMatch(/existing customer installs cannot receive any further updates without/);
    expect(body).toMatch(/also reinstalling — there is no recovery path other than full/);
    expect(body).toMatch(/re-distribution with a new public key\./);
    expect(body).toMatch(/## Related/);
    expect(body).toMatch(/- D-2026-05-06-03 \(this decision\)\./);
    expect(body).toMatch(/- V-243 \(V-log entry for the autopilot work landing this scaffold\)\./);
    expect(body).toMatch(
      /- Tauri Updater docs: https:\/\/tauri\.app\/v1\/guides\/distribution\/updater\//,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
