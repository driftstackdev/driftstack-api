// W542.C — drift guard for /.github/workflows/gui-release.yml.
// V-243 / D-2026-05-06-03 GUI client cross-platform release. Drift
// here either drops the Tauri Updater public-key replacement step
// (would ship a binary with the placeholder key, breaking auto-
// updates), drops a platform from the matrix (would skip that
// platform's release binary), or widens the tag trigger past
// `gui-v*` (would let arbitrary tags cut a GUI release).
//
//   • V-243 / D-2026-05-06-03 anchor + tag-triggered framing.
//   • Pre-launch posture: NO OS-level binary signing; Tauri Updater
//     public-key only.
//   • on: push: tags: gui-v*.
//   • 3-platform matrix: macos-latest (universal-apple-darwin) +
//     ubuntu-22.04 + windows-latest.
//   • TAURI_UPDATER_PUBKEY substitution into tauri.conf.json before
//     Tauri build.
//   • tauri-apps/tauri-action@v0 with TAURI_SIGNING_PRIVATE_KEY +
//     TAURI_SIGNING_PRIVATE_KEY_PASSWORD + V-242 VITE_SENTRY_DSN
//     gate + VITE_APP_VERSION = github.ref_name.
//   • V-240 rust-toolchain.toml pin.
//   • macOS aarch64 + x86_64 target setup for universal binary.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/gui-release.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W542.C /.github/workflows/gui-release.yml content parity', () => {
  const body = read(LIB);

  it("V-243 / D-2026-05-06-03 anchor + tag-triggered + pre-launch-no-OS-signing framing pinned: '# V-243 / D-2026-05-06-03 — GUI client cross-platform release workflow.' + 'Triggered on tags matching `gui-v*` (e.g. `gui-v0.1.0`). Builds three platform binaries in parallel, signs each with the Tauri Updater private key, uploads to a GitHub Release, and writes the `latest.json` manifest the in-app updater consumes.' + '# Pre-launch posture: NO OS-level binary signing. Customers see \"unknown publisher\" / Gatekeeper warnings on first install (normal for indie apps). Subsequent updates are signed via the Tauri Updater public-key. Per-platform code signing certs are deferred (see D-2026-05-06-03 follow-up D-* entries when reached).' — pinned so the V-243 + D-2026-05-06-03 + tag-pattern-gui-v* + 3-platform-parallel + Tauri-Updater-key-signed + latest.json-manifest + pre-launch-NO-OS-signing + Gatekeeper-warning-normal-for-indie + deferred-per-platform-cert commitment survives", () => {
    expect(body).toMatch(
      /# V-243 \/ D-2026-05-06-03 — GUI client cross-platform release workflow\./,
    );
    expect(body).toMatch(
      /# Triggered on tags matching `gui-v\*` \(e\.g\. `gui-v0\.1\.0`\)\. Builds three/,
    );
    expect(body).toMatch(/# platform binaries in parallel, signs each with the Tauri Updater/);
    expect(body).toMatch(/# private key, uploads to a GitHub Release, and writes the/);
    expect(body).toMatch(/# `latest\.json` manifest the in-app updater consumes\./);
    expect(body).toMatch(/# Pre-launch posture: NO OS-level binary signing\. Customers see/);
    expect(body).toMatch(/# "unknown publisher" \/ Gatekeeper warnings on first install \(normal/);
    expect(body).toMatch(
      /# for indie apps\)\. Subsequent updates are signed via the Tauri Updater/,
    );
    expect(body).toMatch(/# public-key\. Per-platform code signing certs are deferred \(see/);
    expect(body).toMatch(/# D-2026-05-06-03 follow-up D-\* entries when reached\)\./);
  });

  it("3-required-secret framing pinned: '# Required GitHub repository secrets:' + '#   * TAURI_UPDATER_PUBKEY — public key embedded in tauri.conf.json' + 'Generate via `npx tauri signer generate`' + 'founder action; see docs/founder-actions/v243-tauri-updater-keys.md' + '#   * TAURI_UPDATER_PRIVKEY — private key for signing update bundles.' + '#   * TAURI_UPDATER_PRIVKEY_PASSWORD — password protecting the private key (set during `signer generate`).' — pinned so the 3-required-secret (pubkey + privkey + privkey_password) + signer-generate-command + founder-runbook-path commitment survives (drift to dropping the password requirement would weaken signing-key-at-rest protection)", () => {
    expect(body).toMatch(/# Required GitHub repository secrets:/);
    expect(body).toMatch(/#\s+\* TAURI_UPDATER_PUBKEY — public key embedded in tauri\.conf\.json/);
    expect(body).toMatch(/#\s+replacement step\. Generate via `npx tauri signer generate`/);
    expect(body).toMatch(
      /#\s+\(founder action; see docs\/founder-actions\/v243-tauri-updater-keys\.md\)\./,
    );
    expect(body).toMatch(/#\s+\* TAURI_UPDATER_PRIVKEY — private key for signing update bundles\./);
    expect(body).toMatch(/#\s+\* TAURI_UPDATER_PRIVKEY_PASSWORD — password protecting the private/);
    expect(body).toMatch(/#\s+key \(set during `signer generate`\)\./);
  });

  it("Trigger + 3-platform-matrix framing pinned: 'name: GUI Release' + 'on: push: tags: - gui-v*' + 'strategy: fail-fast: false + matrix: include:' + '- platform: macos-latest + args: --target universal-apple-darwin' + '- platform: ubuntu-22.04 + args: \\'\\''  + '- platform: windows-latest + args: \\'\\''  + 'runs-on: ${{ matrix.platform }}' — pinned so the gui-v*-tag-trigger + 3-platform-matrix + macOS-universal-binary (aarch64+x86_64 combined) + fail-fast:false (other platforms keep going if one fails) commitment survives (drift to dropping universal-apple-darwin would mean macOS-arm64 customers get x86_64 binaries via Rosetta — slower app)", () => {
    expect(body).toMatch(/^name: GUI Release$/m);
    expect(body).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*- 'gui-v\*'/);
    expect(body).toMatch(/strategy:\s*\n\s*fail-fast: false/);
    expect(body).toMatch(/matrix:\s*\n\s*include:/);
    expect(body).toMatch(
      /- platform: 'macos-latest'\s*\n\s*args: '--target universal-apple-darwin'/,
    );
    expect(body).toMatch(/- platform: 'ubuntu-22\.04'\s*\n\s*args: ''/);
    expect(body).toMatch(/- platform: 'windows-latest'\s*\n\s*args: ''/);
    expect(body).toMatch(/runs-on: \$\{\{ matrix\.platform \}\}/);
  });

  it("Setup-Rust-with-macOS-universal-targets framing pinned: 'Setup Rust (with rust-toolchain.toml pin per V-240)' + 'uses: dtolnay/rust-toolchain@stable' + a `rustup target add aarch64-apple-darwin x86_64-apple-darwin` step that runs with `working-directory: apps/gui-client/src-tauri` + 'uses: Swatinem/rust-cache@v2 with workspaces: apps/gui-client/src-tauri -> target' + Linux apt-deps: 'libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev' — pinned so the V-240 rust-toolchain-pin + macOS-only-aarch64+x86_64 target install + Swatinem/rust-cache-v2 + Linux-5-apt-dep (no pkg-config in this workflow — that's gui-build-check-only) commitment survives.\n\n⚠️ This arm used to pin the `targets:` INPUT to dtolnay/rust-toolchain, and that input never worked: the action adds targets to the toolchain IT installs (stable), while src-tauri/rust-toolchain.toml pins 1.95.0 for every cargo call under that directory. The first release ever cut died with `Target x86_64-apple-darwin is not installed (installed targets: aarch64-apple-darwin)` — with this pin green the whole time, because it recorded what the file SAID rather than whether it worked. It now pins the mechanism that actually installs the targets, including the working-directory that makes rustup resolve the pinned toolchain.", () => {
    expect(body).toMatch(/Setup Rust \(with rust-toolchain\.toml pin per V-240\)/);
    expect(body).toMatch(/uses: dtolnay\/rust-toolchain@stable/);
    expect(body).toMatch(/rustup target add aarch64-apple-darwin x86_64-apple-darwin/);
    expect(body).toMatch(/working-directory: apps\/gui-client\/src-tauri/);
    expect(body).toMatch(/uses: Swatinem\/rust-cache@v2/);
    expect(body).toMatch(/workspaces: 'apps\/gui-client\/src-tauri -> target'/);
    expect(body).toMatch(
      /sudo apt-get install -y libwebkit2gtk-4\.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev/,
    );
  });

  it("TAURI_UPDATER_PUBKEY substitution framing pinned: 'Replace TAURI_UPDATER_PUBKEY placeholder' + 'shell: bash' + 'if [ -z \"${{ secrets.TAURI_UPDATER_PUBKEY }}\" ]; then echo \"::error::TAURI_UPDATER_PUBKEY secret missing — see docs/founder-actions/v243-tauri-updater-keys.md\"; exit 1; fi' + '# Replace the literal placeholder in tauri.conf.json with the secret. # (Tauri 2.x reads $VAR-style env in tauri.conf.json but the updater # `pubkey` field requires the actual key at build; we substitute.)' + 'const path = \\'apps/gui-client/src-tauri/tauri.conf.json\\'' + 'cfg.plugins.updater.pubkey = process.env.TAURI_UPDATER_PUBKEY' + 'fs.writeFileSync(path, JSON.stringify(cfg, null, 2))' — pinned so the missing-secret-fails-with-actionable-error + Tauri-2.x-pubkey-must-be-substituted-at-build (not $VAR) + JSON.stringify-2-space-indent commitment survives", () => {
    expect(body).toMatch(/name: Replace TAURI_UPDATER_PUBKEY placeholder/);
    expect(body).toMatch(/shell: bash/);
    expect(body).toMatch(/if \[ -z "\$\{\{ secrets\.TAURI_UPDATER_PUBKEY \}\}" \]; then/);
    expect(body).toMatch(
      /echo "::error::TAURI_UPDATER_PUBKEY secret missing — see docs\/founder-actions\/v243-tauri-updater-keys\.md"/,
    );
    expect(body).toMatch(
      /# Replace the literal placeholder in tauri\.conf\.json with the secret\./,
    );
    expect(body).toMatch(
      /# \(Tauri 2\.x reads \$VAR-style env in tauri\.conf\.json but the updater/,
    );
    expect(body).toMatch(/# `pubkey` field requires the actual key at build; we substitute\.\)/);
    expect(body).toMatch(/const path = 'apps\/gui-client\/src-tauri\/tauri\.conf\.json';/);
    expect(body).toMatch(/cfg\.plugins\.updater\.pubkey = process\.env\.TAURI_UPDATER_PUBKEY;/);
    expect(body).toMatch(/fs\.writeFileSync\(path, JSON\.stringify\(cfg, null, 2\)\);/);
  });

  it("tauri-action@v0 build + sign + V-242 telemetry gate + Release framing pinned: 'Build + sign Tauri bundles + uses: tauri-apps/tauri-action@v0' + 'TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_UPDATER_PRIVKEY }}' + 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_UPDATER_PRIVKEY_PASSWORD }}' + '# V-242 — Sentry DSN. Empty when unset; gate in telemetry.ts short-circuits cleanly so no event leaves the customer.' + 'VITE_SENTRY_DSN: ${{ secrets.VITE_SENTRY_DSN }}' + 'VITE_APP_VERSION: ${{ github.ref_name }}' + 'projectPath: apps/gui-client + tagName: ${{ github.ref_name }} + releaseName: Driftstack GUI ${{ github.ref_name }}' + Install/Auto-update releaseBody + 'releaseDraft: false + prerelease: false + args: ${{ matrix.args }}' — pinned so the tauri-action-v0 + 3-signing-env (privkey + privkey_password + V-242 VITE_SENTRY_DSN-gate) + ref_name-as-version + 3-OS-installer-instructions + releaseDraft:false-prerelease:false commitment survives", () => {
    expect(body).toMatch(/name: Build \+ sign Tauri bundles/);
    expect(body).toMatch(/uses: tauri-apps\/tauri-action@v0/);
    expect(body).toMatch(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_UPDATER_PRIVKEY \}\}/);
    expect(body).toMatch(
      /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_UPDATER_PRIVKEY_PASSWORD \}\}/,
    );
    expect(body).toMatch(/# V-242 — Sentry DSN\. Empty when unset; gate in telemetry\.ts/);
    expect(body).toMatch(/# short-circuits cleanly so no event leaves the customer\./);
    expect(body).toMatch(/VITE_SENTRY_DSN: \$\{\{ secrets\.VITE_SENTRY_DSN \}\}/);
    expect(body).toMatch(/VITE_APP_VERSION: \$\{\{ github\.ref_name \}\}/);
    expect(body).toMatch(/projectPath: apps\/gui-client/);
    expect(body).toMatch(/tagName: \$\{\{ github\.ref_name \}\}/);
    expect(body).toMatch(/releaseName: 'Driftstack GUI \$\{\{ github\.ref_name \}\}'/);
    expect(body).toMatch(/Cross-platform Driftstack GUI client release\./);
    expect(body).toMatch(/macOS: download the `\.dmg`/);
    expect(body).toMatch(/Windows: download the `\.exe` installer/);
    expect(body).toMatch(/Linux: download the `\.AppImage` \(portable\) or `\.deb`/);
    expect(body).toMatch(
      /Subsequent versions auto-update via the Tauri Updater \(public-key signed\)\./,
    );
    expect(body).toMatch(/releaseDraft: false/);
    expect(body).toMatch(/prerelease: false/);
    expect(body).toMatch(/args: \$\{\{ matrix\.args \}\}/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
