// W541.C — drift guard for /.github/workflows/gui-build-check.yml.
// V-245 cross-platform GUI compile check. Drift here either drops a
// platform from the matrix (would let a regression on, say, Windows
// land silently), forgets the Linux apt-get build-dep block (would
// fail cargo build with cryptic webkit2gtk errors), drops the
// V-241 keyring-rs cargo test (would let macOS Keychain integration
// regress), or accidentally triggers on all paths (would balloon
// runner minutes since this workflow does a full Tauri build).
//
//   • V-245 anchor + V-243-distinction (this is debug-build-no-sign,
//     gui-release.yml is tag-triggered-signs).
//   • V-241 + V-243 + V-244 regression catch rationale.
//   • Path-filter triggers: apps/gui-client/** + packages/sdk-
//     typescript/** + this workflow file.
//   • Concurrency cancel-in-progress on same ref.
//   • Matrix: macos-latest + ubuntu-22.04 + windows-latest +
//     fail-fast: false.
//   • Linux libwebkit2gtk-4.1-dev + libappindicator3-dev + librsvg2-
//     dev + patchelf + libssl-dev + pkg-config apt-deps.
//   • Node 22 + Rust stable + Swatinem/rust-cache@v2.
//   • Steps: typecheck gui-client + build frontend (Vite) +
//     cargo check + cargo test (V-241 keyring tests).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, '.github/workflows/gui-build-check.yml');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W541.C /.github/workflows/gui-build-check.yml content parity', () => {
  const body = read(LIB);

  it("V-245 anchor + V-243-distinction + regression-catch-rationale framing pinned: '# V-245 — cross-platform GUI build verification.' + 'Separate from V-243 `gui-release.yml` (tag-triggered, signs binaries). This workflow runs on every push to main + every PR that touches `apps/gui-client/**` and validates that the Tauri Rust + React build succeeds cleanly on all three target platforms.' + 'Catches early: V-241 keyring-rs platform-specific build issues, V-243 tauri-plugin-updater dep resolution, V-244 wizard import regressions, anything that would only fail on a non-dev platform.' + 'Does NOT produce signed artifacts — debug build, no signing key required, no GitHub Release. Pure \"does it compile?\" check.' — pinned so the V-245 + 4-V-anchor-regression-catch (V-241 keyring + V-243 updater-deps + V-244 wizard-import + non-dev-platform) + V-243-distinction-debug-build-no-sign commitment survives", () => {
    expect(body).toMatch(/# V-245 — cross-platform GUI build verification\./);
    expect(body).toMatch(
      /# Separate from V-243 `gui-release\.yml` \(tag-triggered, signs binaries\)\./,
    );
    expect(body).toMatch(
      /# This workflow runs on every push to main \+ every PR that touches\s*\n#\s*`apps\/gui-client\/\*\*` and validates that the Tauri Rust \+ React build/,
    );
    expect(body).toMatch(/# succeeds cleanly on all three target platforms\./);
    expect(body).toMatch(/# Catches early: V-241 keyring-rs platform-specific build issues,/);
    expect(body).toMatch(/# V-243 tauri-plugin-updater dep resolution, V-244 wizard import/);
    expect(body).toMatch(/# regressions, anything that would only fail on a non-dev platform\./);
    expect(body).toMatch(/# Does NOT produce signed artifacts — debug build, no signing key/);
    expect(body).toMatch(/# required, no GitHub Release\. Pure "does it compile\?" check\./);
  });

  it("Path-filter trigger + concurrency framing pinned: 'name: GUI cross-platform build check' + 'on: push: branches: [main] + paths: apps/gui-client/** + packages/sdk-typescript/** + .github/workflows/gui-build-check.yml' + 'pull_request: branches: [main] + paths: same 3' + 'concurrency: cancel-in-progress: true' — pinned so the path-filtered-trigger (only fires when GUI or its SDK or this workflow changes — not on every push) + same-3-path-filter on push + PR + cancel-in-progress commitment survives (drift to dropping path-filter would burn runner minutes building the Tauri Rust toolchain on every backend PR)", () => {
    expect(body).toMatch(/^name: GUI cross-platform build check$/m);
    expect(body).toMatch(/branches: \[main\]/);
    expect(body).toMatch(/- 'apps\/gui-client\/\*\*'/);
    expect(body).toMatch(/- 'packages\/sdk-typescript\/\*\*'/);
    expect(body).toMatch(/- '\.github\/workflows\/gui-build-check\.yml'/);
    expect(body).toMatch(
      /concurrency:\s*\n\s*group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}\s*\n\s*cancel-in-progress: true/,
    );
  });

  it("3-platform matrix + fail-fast:false framing pinned: 'strategy: fail-fast: false + matrix: platform: [macos-latest, ubuntu-22.04, windows-latest]' + 'runs-on: ${{ matrix.platform }}' — pinned so the 3-platform fan-out (macOS + Linux Ubuntu 22.04 + Windows) + fail-fast:false (other platforms keep running if one fails — fixes go in parallel) commitment survives (drift to dropping any platform would let regressions land silently for that target; drift to fail-fast:true would mask multi-platform failures behind the first failure)", () => {
    expect(body).toMatch(/strategy:\s*\n\s*fail-fast: false/);
    expect(body).toMatch(/matrix:\s*\n\s*platform:/);
    expect(body).toMatch(/- macos-latest/);
    expect(body).toMatch(/- ubuntu-22\.04/);
    expect(body).toMatch(/- windows-latest/);
    expect(body).toMatch(/runs-on: \$\{\{ matrix\.platform \}\}/);
  });

  it("Linux apt-deps + Rust-toolchain + cache framing pinned: 'if: matrix.platform == \\'ubuntu-22.04\\'' + 'sudo apt-get update' + 'sudo apt-get install -y libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev pkg-config' + 'Setup Rust (rust-toolchain.toml pinned per V-240)' + 'uses: dtolnay/rust-toolchain@stable' + 'uses: Swatinem/rust-cache@v2 with workspaces: apps/gui-client/src-tauri -> target' — pinned so the Linux-only-6-apt-dep (libwebkit2gtk-4.1-dev + libappindicator3-dev + librsvg2-dev + patchelf + libssl-dev + pkg-config) + V-240 rust-toolchain-pinned + Swatinem/rust-cache-v2 commitment survives (drift to dropping libwebkit2gtk would fail Tauri build with cryptic linker errors on Linux only)", () => {
    expect(body).toMatch(/if: matrix\.platform == 'ubuntu-22\.04'/);
    expect(body).toMatch(/sudo apt-get update/);
    expect(body).toMatch(
      /sudo apt-get install -y libwebkit2gtk-4\.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev pkg-config/,
    );
    expect(body).toMatch(/Setup Rust \(rust-toolchain\.toml pinned per V-240\)/);
    expect(body).toMatch(/uses: dtolnay\/rust-toolchain@stable/);
    expect(body).toMatch(/uses: Swatinem\/rust-cache@v2/);
    expect(body).toMatch(/workspaces: 'apps\/gui-client\/src-tauri -> target'/);
  });

  it("Build-step sequence framing pinned: 'uses: actions/checkout@v4' + 'actions/setup-node@v4 with node-version: 22 + cache: npm' + 'Install npm deps + npm ci' + 'Build SDK (transitive dep) + npm run build --workspace packages/sdk-typescript' + 'Typecheck gui-client (TS) + npm run typecheck --workspace apps/gui-client' + 'Build frontend bundle (Vite) + npm run build --workspace apps/gui-client' + 'Cargo check (Rust shell — fast, no codegen) + working-directory: apps/gui-client/src-tauri + cargo check --all-targets' + 'Cargo test (Rust unit tests — V-241 keyring tests) + cargo test --all-targets' — pinned so the SDK-built-first (transitive-dep) + typecheck-then-build + cargo-check-before-cargo-test + V-241-keyring-tests-anchor commitment survives (drift to dropping cargo test would let keyring-rs platform-specific regressions land silently)", () => {
    expect(body).toMatch(/uses: actions\/checkout@v4/);
    expect(body).toMatch(
      /uses: actions\/setup-node@v4\s*\n\s*with:\s*\n\s*node-version: '22'\s*\n\s*cache: 'npm'/,
    );
    expect(body).toMatch(/name: Install npm deps\s*\n\s*run: npm ci/);
    expect(body).toMatch(
      /name: Build SDK \(transitive dep\)\s*\n\s*run: npm run build --workspace packages\/sdk-typescript/,
    );
    expect(body).toMatch(
      /name: Typecheck gui-client \(TS\)\s*\n\s*run: npm run typecheck --workspace apps\/gui-client/,
    );
    expect(body).toMatch(
      /name: Build frontend bundle \(Vite\)\s*\n\s*run: npm run build --workspace apps\/gui-client/,
    );
    expect(body).toMatch(
      /name: Cargo check \(Rust shell — fast, no codegen\)\s*\n\s*working-directory: apps\/gui-client\/src-tauri\s*\n\s*run: cargo check --all-targets/,
    );
    expect(body).toMatch(
      /name: Cargo test \(Rust unit tests — V-241 keyring tests\)\s*\n\s*working-directory: apps\/gui-client\/src-tauri\s*\n\s*run: cargo test --all-targets/,
    );
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
