// Every test file on disk is collected by some vitest project.
//
// The suite is split in two. `vitest.node.config.ts` takes
// `apps/**/tests/**/*.test.ts` (plus packages and scripts), and
// `apps/gui-client/vitest.config.ts` takes `tests/**/*.test.tsx` under that one
// app. Between them they currently collect 2,862 files, which is exactly what a
// full run reports — reconciled, not assumed.
//
// The gap those two globs leave is narrow and easy to fall into: the node
// project matches `.test.ts` ONLY, and the jsdom project is rooted at
// `apps/gui-client`. So a `.test.tsx` written anywhere else — a component test
// under `apps/customer-dashboard/tests` or `apps/admin-panel/tests` — is
// collected by neither. It does not error, it does not skip, it does not appear
// in the count. It simply never runs, and the author has no way to notice
// except by looking for their test in the output of 2,862.
//
// That is the failure this file exists for, and it is worth a guard precisely
// because the current state is CLEAN. There are no orphans today, so nothing
// would announce the first one.
//
// DERIVED FROM THE CONFIGS. The globs are read out of the two vitest configs
// rather than restated here, so adding a third project, or widening the node
// project to `.tsx`, is picked up without editing this file. Restating them
// would mean this guard could agree with itself while disagreeing with the
// runner — which is the same class of bug it is written to catch.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const PROJECT_CONFIGS = [
  { config: 'vitest.node.config.ts', base: '.' },
  { config: 'apps/gui-client/vitest.config.ts', base: 'apps/gui-client' },
] as const;

/**
 * The `exclude:` globs declared by a vitest config.
 *
 * Takes the array that sits nearest the TEST `include:`, not simply the first
 * one in the file. `vitest.node.config.ts` carries two of each — one pair for
 * tests, one for benchmarks — and reading the first blindly is the fall-through
 * that already left an anti-vacuity arm green while it parsed bench globs.
 */
function excludeGlobs(configPath: string): string[] {
  const source = readFileSync(resolve(REPO_ROOT, configPath), 'utf8');
  const anchor = source.indexOf("'*.test.");
  const from = anchor === -1 ? 0 : anchor;
  const block = /exclude:\s*\[([\s\S]*?)\]/.exec(source.slice(from))?.[1];
  if (block === undefined) return [];
  return [...block.matchAll(/'([^']+)'/g)].map(([, g]) => g).filter((g) => g !== undefined);
}

/** The `include:` globs declared by a vitest config, in declaration order. */
function includeGlobs(configPath: string): string[] {
  const source = readFileSync(resolve(REPO_ROOT, configPath), 'utf8');
  // The first `include:` array is the test one; a later one belongs to the
  // benchmark block, which `npm test` does not run.
  const block = /include:\s*\[([\s\S]*?)\]/.exec(source)?.[1];
  if (block === undefined) return [];
  return [...block.matchAll(/'([^']+)'/g)].map(([, g]) => g).filter((g) => g !== undefined);
}

/**
 * Minimal glob → RegExp for the `**` / `*` patterns these configs use.
 *
 * Order matters: the two-star forms are converted to named placeholders before
 * the single-star rule runs, or `**` would be eaten as two `*` and stop matching
 * across directory boundaries. The placeholders are words no path contains.
 */
function globToRegExp(glob: string): RegExp {
  const ANY_DIRS = '\u0000ANYDIRS\u0000';
  const ANY_CHARS = '\u0000ANYCHARS\u0000';
  const source = glob
    .replace(/\*\*\//g, ANY_DIRS)
    .replace(/\*\*/g, ANY_CHARS)
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '[^/]*')
    .split(ANY_DIRS)
    .join('(?:.*/)?')
    .split(ANY_CHARS)
    .join('.*');
  return new RegExp(`^${source}$`);
}

/** Every test file on disk, repo-relative. */
function testFilesOnDisk(): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue;
      const full = resolve(dir, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
        continue;
      }
      if (/\.test\.tsx?$/.test(entry)) out.push(relative(REPO_ROOT, full));
    }
  };
  for (const top of ['apps', 'packages', 'scripts']) walk(resolve(REPO_ROOT, top));
  return out.sort();
}

// NOTE ON E2E: the playwright specs under `tests/e2e/` are named `*.spec.ts`,
// so a walk for `*.test.ts(x)` never sees them. The node config nevertheless
// excludes `**/tests/e2e/**`, and that exclusion is honoured below — a file
// named `.test.ts` placed there would match the include glob, be dropped by the
// runner, and run nowhere. Reading include without exclude would have called it
// collected.

/** Whether any project's globs collect this file. */
function collectedBy(file: string): string[] {
  return PROJECT_CONFIGS.filter(({ config, base }) => {
    const rel = base === '.' ? file : relative(base, file);
    if (rel.startsWith('..')) return false;
    // Exclude wins over include, exactly as vitest resolves it. Reading only
    // `include:` would call a file collected that the runner then drops — the
    // node project excludes `**/tests/e2e/**`, so a `.test.ts` placed there
    // matches the include glob and still runs nowhere.
    if (excludeGlobs(config).some((g) => globToRegExp(g).test(rel))) return false;
    return includeGlobs(config).some((g) => globToRegExp(g).test(rel));
  }).map(({ config }) => config);
}

describe('no test file runs in no project', () => {
  it('CRITICAL the walk and the globs both produced something. The arm below asks "which files are collected by nothing", and an empty file list has none — while a config whose globs failed to parse would report every file orphaned. Both directions are silent, so both are measured.', () => {
    const files = testFilesOnDisk();
    // MEASURED: 2,891 test files on disk, of which 29 are e2e (playwright).
    expect(files.length, 'test files found on disk').toBeGreaterThan(2500);
    for (const { config } of PROJECT_CONFIGS) {
      const globs = includeGlobs(config);
      expect(globs.length, `include globs parsed from ${config}`).toBeGreaterThan(0);
      // And they are the TEST globs. `vitest.node.config.ts` carries a second
      // `include:` for the benchmark block, and this parser takes the first
      // array it finds — so deleting or renaming the test one makes it fall
      // through to `*.bench.ts` and report globs that collect no tests at all.
      // Observed: a mutation renaming `include:` left this arm green while the
      // orphan arms did the work.
      expect(
        globs.every((g) => g.includes('.test.')),
        `globs parsed from ${config} are test globs, not bench globs: ${globs.join(', ')}`,
      ).toBe(true);
    }
  });

  it('CRITICAL every test file is collected by at least one project. A file matched by none does not error, skip, or appear in the count — it silently never runs, and nothing distinguishes that from a test that passes. The concrete trap is a `.test.tsx` outside apps/gui-client: the node project takes `.test.ts` only and the jsdom project is rooted at that one app.', () => {
    const orphans = testFilesOnDisk().filter((f) => collectedBy(f).length === 0);
    expect(orphans, 'test file(s) no vitest project collects:').toEqual([]);
  });

  it('CRITICAL every test file is collected exactly once. Per-file matching can be right about every file and still wrong in aggregate: a file collected twice runs twice and inflates the count, which reads as more coverage rather than less. Stated as an identity against the files on disk rather than a pinned total, so it needs no bumping and cannot drift from the tree it describes.', () => {
    const files = testFilesOnDisk();
    const doubleCounted = files.filter((f) => collectedBy(f).length > 1);
    expect(doubleCounted, 'file(s) collected by more than one project:').toEqual([]);

    const collectedOnce = files.filter((f) => collectedBy(f).length === 1).length;
    expect(collectedOnce, 'files collected exactly once vs test files on disk').toBe(files.length);
  });
});
