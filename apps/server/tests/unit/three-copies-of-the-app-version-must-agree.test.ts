// `gui-v0.1.0` shipped assets called `Driftstack_0.0.1_x64-setup.exe`, and a
// `latest.json` advertising version `0.0.1`.
//
// The GUI version is declared in THREE files and the release tag is a fourth statement
// of the same fact:
//
//   apps/gui-client/package.json               "version"
//   apps/gui-client/src-tauri/tauri.conf.json  "version"   ← names the assets + latest.json
//   apps/gui-client/src-tauri/Cargo.toml       version
//   the git tag                                gui-v<version>
//
// Nothing required them to agree. The first release ever cut was tagged `gui-v0.1.0`
// against an app version of `0.0.1`, which is worse than cosmetic: the updater compares
// the RUNNING app's version against the version in `latest.json`, and both were `0.0.1`.
// So every install would have been told it was already current, forever — silently
// undoing the `createUpdaterArtifacts` fix that had just made auto-update possible at
// all. A dead updater that looks completely healthy.
//
// ── two guards, because they catch it at different moments ────────────────────
//
// This file asserts the three IN-REPO copies agree, which is checkable now and fails the
// moment someone bumps one and forgets the others.
//
// The tag is not in the repo at test time, so it cannot be checked here. That half lives
// in `gui-release.yml` as a "Tag must match the app version" step that fails the release
// rather than publishing something that can never update. An arm below pins that the
// step still exists — a release-time assertion nobody runs is the same as no assertion.
//
// ⚠️ Deliberately NOT asserting a specific version number. Pinning "0.1.1" here would
// make this a fourth copy of the fact it exists to protect, which is the failure mode
// the whole file is about.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const GUI = resolve(REPO, 'apps/gui-client');
const RELEASE = resolve(REPO, '.github/workflows/gui-release.yml');

const read = (p: string): string => readFileSync(p, 'utf8');

/** Every in-repo declaration of the GUI app version, with where it came from. */
function declaredVersions(): { source: string; version: string | undefined }[] {
  const pkg = JSON.parse(read(resolve(GUI, 'package.json'))) as { version?: string };
  const conf = JSON.parse(read(resolve(GUI, 'src-tauri/tauri.conf.json'))) as { version?: string };
  const cargo = /^version = "([^"]+)"$/m.exec(read(resolve(GUI, 'src-tauri/Cargo.toml')))?.[1];
  return [
    { source: 'apps/gui-client/package.json', version: pkg.version },
    { source: 'apps/gui-client/src-tauri/tauri.conf.json', version: conf.version },
    { source: 'apps/gui-client/src-tauri/Cargo.toml', version: cargo },
  ];
}

describe('three copies of the app version must agree', () => {
  it('CRITICAL all three declarations were actually FOUND. Every assertion below compares them, so a parse that silently returned undefined for two of the three would agree trivially and prove nothing — which is exactly how a fact stated in three places rots.', () => {
    const found = declaredVersions();
    expect(found.length).toBe(3);
    const missing = found.filter((d) => d.version === undefined).map((d) => d.source);
    expect(missing, `version could not be read from:\n  ${missing.join('\n  ')}`).toEqual([]);
    for (const d of found) {
      expect(d.version, `${d.source} has a non-semver version: ${String(d.version)}`).toMatch(
        /^\d+\.\d+\.\d+$/,
      );
    }
  });

  it('CRITICAL the three agree. tauri.conf.json is the one that names the installer and fills latest.json, so a drift between it and the others means the artifact a customer downloads is labelled differently from the app that built it.', () => {
    const found = declaredVersions();
    const distinct = [...new Set(found.map((d) => d.version))];
    expect(
      distinct.length,
      `the GUI version disagrees across its declarations:\n  ${found.map((d) => `${d.version ?? '?'}  ${d.source}`).join('\n  ')}`,
    ).toBe(1);
  });

  it('CRITICAL the release workflow still refuses a tag that disagrees with the app version. This is the half that cannot be checked from inside the repo — the tag does not exist at test time — so the check lives at release time, and its absence is what let gui-v0.1.0 publish 0.0.1 assets with a latest.json no install could ever act on.', () => {
    const workflow = read(RELEASE);
    expect(
      workflow,
      'the tag/version assertion is gone from gui-release.yml, so a mismatched tag would publish a dead updater again',
    ).toMatch(/Tag must match the app version/);
    // It has to READ the app version rather than restate it, and it has to FAIL.
    expect(
      /tauri\.conf\.json'\)\.version/.test(workflow),
      'the release step no longer derives the version from tauri.conf.json',
    ).toBe(true);
    expect(
      /GITHUB_REF_NAME.*!=.*expected|\$expected/s.test(workflow),
      'the release step no longer compares the tag against the derived version',
    ).toBe(true);
    expect(/exit 1/.test(workflow), 'the release step no longer fails the build').toBe(true);
  });

  it('CRITICAL that step runs BEFORE the expensive build, not after. A tag/version mismatch is knowable in a second; discovering it after a ten-minute cross-platform compile wastes the run and tempts whoever is waiting to just publish it anyway.', () => {
    const workflow = read(RELEASE);
    const assertAt = workflow.indexOf('Tag must match the app version');
    const buildAt = workflow.indexOf('Build + sign Tauri bundles');
    expect(assertAt, 'the tag assertion step is missing').toBeGreaterThan(-1);
    expect(buildAt, 'the build step is missing').toBeGreaterThan(-1);
    expect(
      assertAt,
      'the tag/version assertion runs after the build rather than before it',
    ).toBeLessThan(buildAt);
  });
});
