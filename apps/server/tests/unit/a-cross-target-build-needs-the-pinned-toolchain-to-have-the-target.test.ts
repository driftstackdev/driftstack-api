// The first GUI release ever cut failed on macOS, and the workflow looked correct.
//
//   failed to build x86_64-apple-darwin binary: Target x86_64-apple-darwin is not
//   installed (installed targets: aarch64-apple-darwin)
//
// `gui-release.yml` asked for both Apple targets in the right place — as the `targets:`
// input to `dtolnay/rust-toolchain@stable`. That action installs targets onto the
// toolchain IT installs, which is `stable`. But `src-tauri/rust-toolchain.toml` pins
// `channel = "1.95.0"`, and a toolchain file overrides every cargo invocation under its
// directory. So the targets were added to stable, the build ran on 1.95.0, and 1.95.0
// had only the host target.
//
// Nothing caught it because the two facts live in different files and neither is wrong
// on its own. The pin is correct. The `targets:` input is correct-looking. Only their
// COMBINATION is broken, and only on the leg that cross-compiles.
//
// ── the invariant ─────────────────────────────────────────────────────────────
//
// If the release workflow builds for a `--target` the host does not natively produce,
// then that target must be installed onto the PINNED toolchain — i.e. by a `rustup
// target add` that runs where `rust-toolchain.toml` governs, not by an action input that
// resolves against a different toolchain.
//
// Derived from both files rather than restated: the target list comes from the
// workflow's own `--target` arguments, so adding a new cross-target to the matrix
// without wiring its install fails here.
//
// ⚠️ This cannot prove the macOS build succeeds. It proves the toolchain that runs it
// has been told about the targets it is asked to emit. A linker error, a missing SDK or
// a Tauri bundling fault are all still possible and all still invisible to a unit test.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');
const RELEASE = resolve(REPO, '.github/workflows/gui-release.yml');
const TOOLCHAIN = resolve(REPO, 'apps/gui-client/src-tauri/rust-toolchain.toml');

const read = (p: string): string => readFileSync(p, 'utf8');

/** Every `--target <triple>` the release matrix asks tauri to build. */
function requestedTargets(workflow: string): string[] {
  return [...workflow.matchAll(/--target\s+([a-z0-9_]+-[a-z0-9-]+)/g)]
    .map((m) => m[1])
    .filter((t): t is string => t !== undefined);
}

/** Triples a `universal-apple-darwin` build fans out into. */
const UNIVERSAL_APPLE_COMPONENTS = ['aarch64-apple-darwin', 'x86_64-apple-darwin'];

describe('a cross-target build needs the pinned toolchain to have the target', () => {
  it('CRITICAL the release workflow really does ask for a cross-target build. Every assertion below is conditioned on that, so a workflow that stopped cross-compiling would make them vacuous rather than satisfied — and this file would be quietly guarding nothing.', () => {
    const targets = requestedTargets(read(RELEASE));
    expect(
      targets.length,
      'the release workflow no longer passes any --target; re-derive whether this guard still applies',
    ).toBeGreaterThan(0);
    expect(targets, 'the universal macOS build is gone from the matrix').toContain(
      'universal-apple-darwin',
    );
  });

  it('CRITICAL the src-tauri toolchain really is PINNED, which is the whole reason the action input was not enough. Without a rust-toolchain.toml the action would install stable and its `targets:` input would work — so this pin is the premise of the defect.', () => {
    const toolchain = read(TOOLCHAIN);
    expect(toolchain, 'rust-toolchain.toml no longer pins a channel').toMatch(
      /channel\s*=\s*"[\d.]+"/,
    );
  });

  it('CRITICAL both universal-apple-darwin components are installed onto the pinned toolchain by a rustup step. The action input cannot do this: it resolves against the toolchain the action installed, not the one rust-toolchain.toml forces for every cargo call under src-tauri.', () => {
    const workflow = read(RELEASE);
    const addSteps = [...workflow.matchAll(/rustup target add ([^\n]+)/g)]
      .map((m) => m[1] ?? '')
      .join(' ');
    expect(
      addSteps,
      'no `rustup target add` step exists, so the pinned toolchain gets only the host target',
    ).not.toBe('');
    const missing = UNIVERSAL_APPLE_COMPONENTS.filter((t) => !addSteps.includes(t));
    expect(
      missing,
      `universal-apple-darwin fans out into both triples; not installed on the pinned toolchain:\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('CRITICAL the rustup step runs where the pin GOVERNS. `rustup target add` applies to whichever toolchain resolves in the current directory — run it from the repo root and it targets the default toolchain, leaving the pinned one exactly as bare as before while appearing to fix the problem.', () => {
    const workflow = read(RELEASE);
    const at = workflow.indexOf('rustup target add');
    expect(at, 'no rustup target add step to locate').toBeGreaterThan(-1);
    const stepStart = workflow.lastIndexOf('- name:', at);
    const step = workflow.slice(stepStart, at);
    expect(
      /working-directory:\s*apps\/gui-client\/src-tauri/.test(step),
      'the rustup target add step does not run inside apps/gui-client/src-tauri, so it resolves a different toolchain than the build will',
    ).toBe(true);
  });

  it('the Apple targets are deliberately NOT in rust-toolchain.toml. Putting them there would also work, but it would make the Windows and Linux legs download macOS std libs they never link — so the choice is recorded here rather than left for someone to "tidy up" later.', () => {
    const toolchain = read(TOOLCHAIN);
    const declared = /targets\s*=\s*\[([^\]]*)\]/.exec(toolchain)?.[1] ?? '';
    for (const t of UNIVERSAL_APPLE_COMPONENTS) {
      expect(
        declared.includes(t),
        `${t} moved into rust-toolchain.toml; if that is intentional, delete the workflow rustup step and update this arm — do not leave both`,
      ).toBe(false);
    }
  });
});
