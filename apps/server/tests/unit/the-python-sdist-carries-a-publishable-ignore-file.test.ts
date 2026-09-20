// The Python sdist carries a publishable ignore file.
//
// `python -m build` in `packages/sdk-python` produces the source distribution
// that PyPI serves next to the wheel, and its contents are NOT decided by the
// `[tool.hatch.build.targets.sdist] include` list alone. Hatchling FORCE-INCLUDES
// the nearest VCS ignore file at or above the package root, and a force-include
// is not overridden by `include` or by `exclude` — measured on hatchling 1.28,
// `hatchling/builders/sdist.py::get_default_build_data`, which copies every entry
// of `config.vcs_exclusion_files` straight into `force_include`.
//
// Built from inside this repository with no `.gitignore` beside `pyproject.toml`,
// the nearest one is the REPOSITORY ROOT's. That file is written for people who
// work here: it carries internal identifiers, names the private repository and
// the document in it that records where the guards are weak, and names a vendor.
// `driftstack_sdk-<version>.tar.gz` on PyPI carried a verbatim copy of it.
//
// The fix is a short, local, publishable `packages/sdk-python/.gitignore`, which
// hatchling finds first. It looks redundant — every pattern in it is already
// covered by the root file — so this guard exists to stop it being tidied away.
//
// WHAT IS CHECKED, and how. `nearestIgnoreAtOrAbove` re-derives hatchling's own
// search (`hatchling/utils/fs.py::locate_file`, boundary `.git`) rather than
// asserting that a path exists: the property that matters is "the file the sdist
// will carry", and only the search says which file that is. `internalMarkersIn`
// then reads that file and reports what makes a file unpublishable.
//
// `_helpers/code-only.ts` is deliberately not used here. It strips TypeScript
// comments, and the subjects are a `.gitignore` and a TOML file whose COMMENTS
// are exactly the content at issue — stripping them would hide the finding.

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SDK_PYTHON = resolve(REPO_ROOT, 'packages/sdk-python');

/**
 * The ignore file hatchling would force-include, searching from `startDir`
 * upward. Mirrors `locate_file(root, ".gitignore", boundary=".git")`: the file
 * in the current directory wins BEFORE the boundary is considered, so the
 * repository root's own `.gitignore` is returned when nothing nearer exists.
 * Returns null when the walk leaves the boundary without finding one.
 */
function nearestIgnoreAtOrAbove(startDir: string, fileName = '.gitignore'): string | null {
  let dir = startDir;
  for (;;) {
    const candidate = join(dir, fileName);
    if (existsSync(candidate)) return candidate;
    if (existsSync(join(dir, '.git'))) return null;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** What makes a file unfit to serve from a public registry. */
function internalMarkersIn(body: string): string[] {
  const found: string[] = [];
  const patterns: [string, RegExp][] = [
    ['an internal ticket identifier', /\bV-\d+\b/],
    ['a reference to the private repository', /\bPRIVATE repo\b|docs\/internal\//],
    ['internal vocabulary', /\bharness\b|\bcontrol[- ]plane\b|\bfleet\b/i],
    ['an agent/ticket working note', /\bBUG-\d+\b|\bcross-agent\b/i],
  ];
  for (const [what, re] of patterns) if (re.test(body)) found.push(what);
  return found;
}

describe('the Python sdist carries a publishable ignore file', () => {
  it('CRITICAL the ignore file hatchling force-includes is the package-local one, not the repository root', () => {
    const nearest = nearestIgnoreAtOrAbove(SDK_PYTHON);

    expect(nearest, 'no .gitignore was found at or above packages/sdk-python').not.toBeNull();
    expect(
      nearest,
      `the sdist would carry ${String(nearest)}. Hatchling force-includes the NEAREST ignore ` +
        'file, and only a .gitignore beside pyproject.toml keeps the repository root out of a ' +
        'file served from PyPI. Restore packages/sdk-python/.gitignore.',
    ).toBe(join(SDK_PYTHON, '.gitignore'));
  });

  it('CRITICAL the file the sdist will carry says nothing a public registry should not serve', () => {
    const nearest = nearestIgnoreAtOrAbove(SDK_PYTHON);
    expect(nearest).not.toBeNull();
    const markers = internalMarkersIn(readFileSync(nearest!, 'utf8'));

    expect(markers, `${String(nearest)} ships on PyPI and carries ${markers.join(', ')}`).toEqual(
      [],
    );
  });

  it('CRITICAL it stays covered by a pattern set that changes nothing about what git tracks', () => {
    const local = readFileSync(join(SDK_PYTHON, '.gitignore'), 'utf8');

    // Build and tool output only. A negation here would un-ignore something the
    // root file ignores, which is a change to the repository, not to the sdist.
    expect(local, 'a negation pattern changes what git tracks').not.toMatch(/^\s*!/m);
    for (const pattern of ['.venv/', '__pycache__/', 'dist/']) {
      expect(local, `the local ignore file no longer covers ${pattern}`).toContain(pattern);
    }
  });

  it('CRITICAL pyproject records why the local ignore file cannot be deleted', () => {
    const toml = readFileSync(join(SDK_PYTHON, 'pyproject.toml'), 'utf8');

    expect(toml).toMatch(/FORCE-INCLUDES/);
    expect(toml).toMatch(/packages\/sdk-python\/\.gitignore/);
    expect(toml).toMatch(/Do not delete it\./);
  });

  // ─── Negative controls ────────────────────────────────────────
  //
  // Both checks above are satisfied by an instrument that cannot fail: a
  // locator that always returned the local path, and a marker scan that always
  // returned []. These run each one over inputs built to produce the other
  // answer, so a green above means they discriminate.

  describe('the locator itself: it walks up, and it stops at the boundary', () => {
    const root = join(tmpdir(), `sdist-ignore-guard-${String(process.pid)}`);
    const pkg = join(root, 'packages', 'sdk-python');

    /** A repository-shaped tree, with or without the package-local ignore file. */
    function build(withLocal: boolean): void {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(pkg, { recursive: true });
      // A file named `.git` is what a worktree has, and is what the boundary
      // check must accept — `existsSync` is true for a file as for a directory.
      writeFileSync(join(root, '.git'), 'gitdir: elsewhere');
      writeFileSync(join(root, '.gitignore'), '# root\nnode_modules/\n');
      if (withLocal) writeFileSync(join(pkg, '.gitignore'), '# local\ndist/\n');
    }

    it('with no local file it reports the ROOT one — which is the defect this guard exists for', () => {
      build(false);
      expect(nearestIgnoreAtOrAbove(pkg)).toBe(join(root, '.gitignore'));
    });

    it('with a local file it reports THAT one, so the two outcomes are distinguishable', () => {
      build(true);
      expect(nearestIgnoreAtOrAbove(pkg)).toBe(join(pkg, '.gitignore'));
    });

    it('it returns null rather than walking past the repository boundary', () => {
      build(true);
      expect(nearestIgnoreAtOrAbove(pkg, '.hgignore')).toBeNull();
      rmSync(root, { recursive: true, force: true });
    });
  });

  describe('the marker scan itself: it reports a file like the repository root one', () => {
    it('an ignore file carrying a ticket id and the private-repo pointer is reported', () => {
      const rootShaped = [
        '# V-278 deploy .env files (REAL secrets; never committed).',
        '/infra/env-templates/*.env',
        '# The internal ledger lives in the PRIVATE repo at docs/internal/OPEN-ITEMS.md',
        'docs/internal/OPEN-ITEMS.md',
        '# Generated by the live-scroll E2E harness build',
        'scripts/scroll-e2e/harness.iife.js',
      ].join('\n');
      const markers = internalMarkersIn(rootShaped);

      expect(markers).toContain('an internal ticket identifier');
      expect(markers).toContain('a reference to the private repository');
      expect(markers).toContain('internal vocabulary');
    });

    it('a build-output-only ignore file is reported clean, so the scan is not simply always red', () => {
      expect(internalMarkersIn('# caches\n.venv/\n__pycache__/\ndist/\nbuild/\n')).toEqual([]);
    });
  });
});
