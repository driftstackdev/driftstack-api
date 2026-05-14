// W726 — server-deploy.yml + gui-release.yml + gui-build-check.yml
// + dependabot-auto-merge.yml workflow parity. Fifty-third in the
// cross-SDK drift-guard series (W649 + W675-W726). Closes the
// `.github/workflows/*.yml` parity coverage.
//
// 4 workflow files pinned as authoritative:
//
//   server-deploy.yml (V-278) — tag-triggered production-only
//     deploy with V-549.A pre-deploy smoke + V-549.B auto-rollback.
//
//   gui-release.yml (V-243 / D-2026-05-06-03) — gui-v* tag triggers
//     macOS + Linux + Windows GUI release with Tauri Updater signing.
//
//   gui-build-check.yml (V-245) — every PR + main commit touching
//     apps/gui-client/** runs a 3-platform debug build (no signing).
//
//   dependabot-auto-merge.yml (V-148) — auto-approve + auto-merge
//     PATCH bumps; minor/major get a "needs manual review" comment.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

const SERVER_DEPLOY = resolve(REPO_ROOT, '.github/workflows/server-deploy.yml');
const GUI_RELEASE = resolve(REPO_ROOT, '.github/workflows/gui-release.yml');
const GUI_BUILD_CHECK = resolve(REPO_ROOT, '.github/workflows/gui-build-check.yml');
const DEPENDABOT = resolve(REPO_ROOT, '.github/workflows/dependabot-auto-merge.yml');

describe('W726 server-deploy + gui + dependabot workflow parity', () => {
  it('all 4 workflow files exist', () => {
    expect(existsSync(SERVER_DEPLOY)).toBe(true);
    expect(existsSync(GUI_RELEASE)).toBe(true);
    expect(existsSync(GUI_BUILD_CHECK)).toBe(true);
    expect(existsSync(DEPENDABOT)).toBe(true);
  });

  // --- server-deploy.yml ------------------------------------------

  it('CRITICAL server-deploy.yml V-278 anchor + tag-trigger framing pinned. The sister-workflow-to-deploy.yml shape is what gives the founder an explicit-release-cut path.', () => {
    const w = read(SERVER_DEPLOY);
    expect(w).toMatch(/V-278 — Tag-triggered production deploy for the API server/);
    expect(w).toMatch(/Sister workflow to \.github\/workflows\/deploy\.yml/);
  });

  it('CRITICAL server-deploy.yml triggers on tag push matching `server-v*` + workflow_dispatch with `tag` input. The tag-based trigger keeps production cuts deliberate; drift to push:[main] would couple production deploy timing to main merges.', () => {
    const w = read(SERVER_DEPLOY);
    expect(w).toMatch(/tags:\s*\n\s*- 'server-v\*'/);
    expect(w).toMatch(
      /workflow_dispatch:\s*\n\s*inputs:\s*\n\s*tag:\s*\n\s*description: 'Tag to deploy/,
    );
  });

  it("CRITICAL server-deploy.yml V-549.A pre-deploy production smoke pinned. The pre-deploy smoke aborts if production is ALREADY broken (don't layer a new deploy on top of a broken one).", () => {
    const w = read(SERVER_DEPLOY);
    expect(w).toMatch(/V-549\.A \/ V-660 — pre-deploy smoke against the live target/);
    expect(w).toMatch(
      /If production is already broken, abort instead of layering a\s*\n\s*#\s*new deploy on top\./,
    );

    // Smoke does 2 checks: /health and /openapi.json (3.1 version match).
    expect(w).toMatch(/https:\/\/api\.driftstack\.dev\/health/);
    expect(w).toMatch(/https:\/\/api\.driftstack\.dev\/openapi\.json/);
    expect(w).toMatch(/jq -e '\.openapi \| startswith\("3\.1"\)'/);
  });

  it('CRITICAL server-deploy.yml V-549.B auto-rollback pinned. The rollback captures the previous image tag BEFORE deploy, then re-deploys it if the post-deploy /health check fails. Drift to dropping would leave production stuck in a broken state.', () => {
    const w = read(SERVER_DEPLOY);

    expect(w).toMatch(/V-549\.B — capture the currently-running image tag so we can/);
    expect(w).toMatch(/roll back to it if the post-deploy health-check fails/);

    // Rollback logic.
    expect(w).toMatch(/PREV_TAG=\$\(docker compose images --quiet driftstack-api/);
    expect(w).toMatch(
      /if \[ "\$HEALTHY" -ne 1 \]; then\s*\n\s*echo "Post-deploy \/health failed\. Initiating V-549\.B rollback\."/,
    );
    expect(w).toMatch(/export IMAGE_TAG="\$PREV_TAG"\s*\n\s*docker compose up -d --remove-orphans/);
  });

  it('CRITICAL server-deploy.yml /health smoke loop 10×3s (same as deploy.yml). Drift would break the consistent health-gate behavior across both deploy paths.', () => {
    const w = read(SERVER_DEPLOY);
    expect(w).toMatch(/for i in 1 2 3 4 5 6 7 8 9 10; do/);
    expect(w).toMatch(/curl -fsS http:\/\/127\.0\.0\.1:7780\/health/);
    expect(w).toMatch(/sleep 3/);
  });

  it('CRITICAL server-deploy.yml image tag = the git tag name (e.g. server-v0.2.1) — NOT short-SHA. The tag-as-image-tag is what makes server-v* tag deploys idempotent (re-firing the same tag produces the same image identity).', () => {
    const w = read(SERVER_DEPLOY);

    expect(w).toMatch(/REF="\$\{GITHUB_REF##\*\/\}"/);
    expect(w).toMatch(/INPUT_TAG="\$\{\{ github\.event\.inputs\.tag \}\}"/);
    expect(w).toMatch(/TAG_NAME="\$\{INPUT_TAG:-\$REF\}"/);
    expect(w).toMatch(
      /IMAGE="ghcr\.io\/\$\{\{ github\.repository_owner \}\}\/driftstack-api:\$\{TAG_NAME\}"/,
    );
  });

  // --- gui-release.yml --------------------------------------------

  it('CRITICAL gui-release.yml V-243 / D-2026-05-06-03 anchor pinned. The decision-record + V-anchor threads the GUI release provenance + the "no OS-level binary signing pre-launch" stance.', () => {
    const w = read(GUI_RELEASE);
    expect(w).toMatch(/V-243 \/ D-2026-05-06-03 — GUI client cross-platform release/);
    expect(w).toMatch(/Pre-launch posture: NO OS-level binary signing/);
  });

  it('CRITICAL gui-release.yml triggers on `gui-v*` tag (only — no push/PR/dispatch). The tag-only trigger keeps GUI releases explicit; drift to push:[main] would auto-publish every commit.', () => {
    const w = read(GUI_RELEASE);
    expect(w).toMatch(/on:\s*\n\s*push:\s*\n\s*tags:\s*\n\s*- 'gui-v\*'/);
    // No pull_request trigger.
    expect(w).not.toMatch(/^on:[\s\S]{0,200}pull_request:/m);
  });

  it('CRITICAL gui-release.yml 3-platform matrix pinned — macos-latest + ubuntu-22.04 + windows-latest. macOS gets `--target universal-apple-darwin` for fat binaries.', () => {
    const w = read(GUI_RELEASE);

    expect(w).toMatch(/platform: 'macos-latest'\s*\n\s*args: '--target universal-apple-darwin'/);
    expect(w).toMatch(/platform: 'ubuntu-22\.04'\s*\n\s*args: ''/);
    expect(w).toMatch(/platform: 'windows-latest'\s*\n\s*args: ''/);
    expect(w).toMatch(/fail-fast: false/);
  });

  it('CRITICAL gui-release.yml 3 Tauri Updater secrets pinned — PUBKEY embedded in tauri.conf.json + PRIVKEY for signing + PRIVKEY_PASSWORD. Drift to dropping the pubkey-replacement step would let unsigned bundles ship.', () => {
    const w = read(GUI_RELEASE);

    expect(w).toMatch(/TAURI_UPDATER_PUBKEY — public key embedded in tauri\.conf\.json/);
    expect(w).toMatch(/TAURI_UPDATER_PRIVKEY — private key for signing update bundles/);
    expect(w).toMatch(/TAURI_UPDATER_PRIVKEY_PASSWORD — password protecting the private/);

    // Pubkey replacement step.
    expect(w).toMatch(/Replace the literal placeholder in tauri\.conf\.json with the secret/);
    expect(w).toMatch(/cfg\.plugins\.updater\.pubkey = process\.env\.TAURI_UPDATER_PUBKEY/);
  });

  it('CRITICAL gui-release.yml tauri-action invocation with TAURI_SIGNING_PRIVATE_KEY + TAURI_SIGNING_PRIVATE_KEY_PASSWORD env. The signing env names match the tauri-action contract; drift would silently disable signing.', () => {
    const w = read(GUI_RELEASE);

    expect(w).toMatch(/uses: tauri-apps\/tauri-action@v0/);
    expect(w).toMatch(/TAURI_SIGNING_PRIVATE_KEY: \$\{\{ secrets\.TAURI_UPDATER_PRIVKEY \}\}/);
    expect(w).toMatch(
      /TAURI_SIGNING_PRIVATE_KEY_PASSWORD: \$\{\{ secrets\.TAURI_UPDATER_PRIVKEY_PASSWORD \}\}/,
    );
    expect(w).toMatch(/tagName: \$\{\{ github\.ref_name \}\}/);
    expect(w).toMatch(/releaseName: 'Driftstack GUI \$\{\{ github\.ref_name \}\}'/);
  });

  it('CRITICAL gui-release.yml V-242 Sentry DSN gate framing pinned — "Empty when unset; gate in telemetry.ts short-circuits cleanly so no event leaves the customer". Drift to dropping the empty-default would let unset VITE_SENTRY_DSN crash at runtime.', () => {
    const w = read(GUI_RELEASE);
    expect(w).toMatch(/V-242 — Sentry DSN\. Empty when unset; gate in telemetry\.ts/);
    expect(w).toMatch(/short-circuits cleanly so no event leaves the customer/);
    expect(w).toMatch(/VITE_SENTRY_DSN: \$\{\{ secrets\.VITE_SENTRY_DSN \}\}/);
  });

  // --- gui-build-check.yml ----------------------------------------

  it('CRITICAL gui-build-check.yml V-245 anchor + "every push/PR touching apps/gui-client" framing pinned. Drift to running on every push (regardless of paths) would 3× run time per backend commit.', () => {
    const w = read(GUI_BUILD_CHECK);
    expect(w).toMatch(/V-245 — cross-platform GUI build verification/);
    expect(w).toMatch(/Does NOT produce signed artifacts — debug build, no signing key/);
    expect(w).toMatch(/Pure "does it compile\?" check/);
  });

  it('CRITICAL gui-build-check.yml path-filter triggers on apps/gui-client/** + packages/sdk-typescript/** (transitive dep) + the workflow file itself. Drift to dropping sdk-typescript would let SDK changes break the GUI build silently.', () => {
    const w = read(GUI_BUILD_CHECK);

    // Path-filters appear on both push + pull_request.
    const guiFilters = (w.match(/'apps\/gui-client\/\*\*'/g) ?? []).length;
    expect(guiFilters, 'apps/gui-client/** filter count').toBe(2);

    const sdkFilters = (w.match(/'packages\/sdk-typescript\/\*\*'/g) ?? []).length;
    expect(sdkFilters, 'packages/sdk-typescript/** filter count').toBe(2);

    const workflowFilters = (w.match(/'\.github\/workflows\/gui-build-check\.yml'/g) ?? []).length;
    expect(workflowFilters, 'workflow-self filter count').toBe(2);
  });

  it('CRITICAL gui-build-check.yml 3-platform matrix + fail-fast: false. Same matrix as gui-release.yml but with the cheaper ubuntu-22.04 build deps (libssl-dev + pkg-config added beyond what gui-release.yml uses).', () => {
    const w = read(GUI_BUILD_CHECK);

    expect(w).toMatch(/fail-fast: false/);
    expect(w).toMatch(/- macos-latest/);
    expect(w).toMatch(/- ubuntu-22\.04/);
    expect(w).toMatch(/- windows-latest/);

    // Linux build deps.
    expect(w).toMatch(
      /libwebkit2gtk-4\.1-dev libappindicator3-dev librsvg2-dev patchelf libssl-dev pkg-config/,
    );
  });

  it('CRITICAL gui-build-check.yml 5-step build verification pinned — npm ci + sdk-typescript build + gui-client typecheck + Vite frontend bundle + cargo check + cargo test. The cargo test step catches V-241 keyring tests; drift to dropping would let keyring-rs platform regressions land.', () => {
    const w = read(GUI_BUILD_CHECK);

    expect(w).toMatch(/run: npm ci/);
    expect(w).toMatch(/Build SDK \(transitive dep\)/);
    expect(w).toMatch(/run: npm run build --workspace packages\/sdk-typescript/);
    expect(w).toMatch(/Typecheck gui-client \(TS\)/);
    expect(w).toMatch(/run: npm run typecheck --workspace apps\/gui-client/);
    expect(w).toMatch(/Build frontend bundle \(Vite\)/);
    expect(w).toMatch(/Cargo check \(Rust shell — fast, no codegen\)/);
    expect(w).toMatch(/run: cargo check --all-targets/);
    expect(w).toMatch(/Cargo test \(Rust unit tests — V-241 keyring tests\)/);
    expect(w).toMatch(/run: cargo test --all-targets/);
  });

  it('CRITICAL gui-build-check.yml + gui-release.yml share Rust toolchain pin via dtolnay/rust-toolchain@stable + V-240 rust-toolchain.toml framing. Drift to different toolchain versions across the two workflows would let "compiles in release but breaks in build-check" regressions land.', () => {
    const check = read(GUI_BUILD_CHECK);
    const release = read(GUI_RELEASE);

    expect(check).toMatch(/dtolnay\/rust-toolchain@stable/);
    expect(release).toMatch(/dtolnay\/rust-toolchain@stable/);
    expect(check).toMatch(/V-240/);
    expect(release).toMatch(/V-240/);
  });

  // --- dependabot-auto-merge.yml ----------------------------------

  it('CRITICAL dependabot-auto-merge.yml V-148 anchor + PATCH-only-auto-merge framing pinned. Drift to auto-merging minor bumps would let "Sentry SDK 8.x → 8.1.0 changed default sample rate" class regressions land silently.', () => {
    const w = read(DEPENDABOT);
    expect(w).toMatch(/V-148 — Dependabot auto-merge for patch updates/);
    expect(w).toMatch(/Why patch-only auto-merge:/);
    expect(w).toMatch(/Patch bumps are by SemVer convention bug-fix only — low blast radius/);
    expect(w).toMatch(/Major bumps are always API-breaking; never auto-merge/);
  });

  it('CRITICAL dependabot job-level actor gate — `if: github.actor == "dependabot[bot]"`. The actor-gate is what prevents human PRs from accidentally going through the auto-merge path.', () => {
    const w = read(DEPENDABOT);
    expect(w).toMatch(/if: github\.actor == 'dependabot\[bot\]'/);
  });

  it('CRITICAL dependabot uses dependabot/fetch-metadata@v2 to detect update-type. Drift to dropping the metadata step would force the workflow to parse PR titles (fragile).', () => {
    const w = read(DEPENDABOT);
    expect(w).toMatch(/uses: dependabot\/fetch-metadata@v2/);
    expect(w).toMatch(/github-token: '\$\{\{ secrets\.GITHUB_TOKEN \}\}'/);
  });

  it('CRITICAL dependabot 3-step decision logic — approve + auto-merge (patch only) + comment on minor/major. The 3-step shape covers every Dependabot PR with a clear next-action.', () => {
    const w = read(DEPENDABOT);

    // Approve step.
    expect(w).toMatch(
      /if: steps\.metadata\.outputs\.update-type == 'version-update:semver-patch'\s*\n\s*run: gh pr review --approve "\$PR_URL"/,
    );

    // Auto-merge step.
    expect(w).toMatch(
      /if: steps\.metadata\.outputs\.update-type == 'version-update:semver-patch'\s*\n\s*run: gh pr merge --auto --squash "\$PR_URL"/,
    );

    // Comment on non-patch.
    expect(w).toMatch(/if: steps\.metadata\.outputs\.update-type != 'version-update:semver-patch'/);
    expect(w).toMatch(/Dependabot bump type: .*Auto-merge applies to patch bumps only/);
  });

  it('CRITICAL dependabot uses `--squash` merge strategy. Drift to `--merge` would let dependabot commits show as a merge commit on main (noisier history); drift to `--rebase` would re-author the commit (loses dependabot[bot] author).', () => {
    const w = read(DEPENDABOT);
    expect(w).toMatch(/gh pr merge --auto --squash "\$PR_URL"/);
  });

  it('CRITICAL dependabot-auto-merge.yml permissions narrowed to contents:write + pull-requests:write. Drift to wider permissions would over-scope the auto-merge token.', () => {
    const w = read(DEPENDABOT);
    expect(w).toMatch(/permissions:\s*\n\s*contents: write\s*\n\s*pull-requests: write/);
  });

  it('CRITICAL "Allow auto-merge" repo-setting framing pinned. The doc note tells operators the workflow alone is not enough — repo settings must enable auto-merge. Drift to dropping would force the workflow to crash silently on a fresh fork.', () => {
    const w = read(DEPENDABOT);
    expect(w).toMatch(
      /Repo settings → "Allow auto-merge" must be enabled for the auto-merge\s*\n#\s*call to succeed/,
    );
  });

  it('Server-deploy + GUI + Dependabot 7-invariant cluster — V-278/V-549.A/V-549.B server tag deploy + V-243/D-2026-05-06-03 GUI release + V-245 GUI build-check + V-148 dependabot + V-242 Sentry framing + V-241 keyring tests + 3-platform matrix.', () => {
    const sd = read(SERVER_DEPLOY);
    const gr = read(GUI_RELEASE);
    const gbc = read(GUI_BUILD_CHECK);
    const db = read(DEPENDABOT);

    expect(sd).toMatch(/V-278/);
    expect(sd).toMatch(/V-549\.A/);
    expect(sd).toMatch(/V-549\.B/);
    expect(gr).toMatch(/V-243/);
    expect(gr).toMatch(/V-242/);
    expect(gbc).toMatch(/V-245/);
    expect(gbc).toMatch(/V-241/);
    expect(db).toMatch(/V-148/);
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(
          REPO_ROOT,
          'apps/server/tests/unit/server-deploy-gui-dependabot-workflows-parity.test.ts',
        ),
      ),
    ).toBe(true);
  });
});
