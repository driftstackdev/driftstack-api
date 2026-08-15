// The formatter is pinned to one exact version.
//
// A formatter is not an ordinary dependency. Its minor releases change OUTPUT,
// and `format:check` is a gate — `.husky/pre-push` runs the verify chain, and CI
// runs it too. So a caret range on Prettier means an ordinary `npm install` can
// reformat the entire repository and turn the gate red without anyone changing
// a line of code.
//
// This is not hypothetical here. Prettier was declared `^3.4.0`; the installed
// copy caught up to 3.8.3 on 2026-07-31 and the format gate went red on 24 files
// that had been formatted under the older version. The next push would have
// failed for a reason unrelated to anything in it.
//
// The fix is to pin exactly, and the reason it needs a guard rather than just a
// commit is that `^` is the default. `npm install --save-dev prettier` writes a
// caret; nothing warns; and the repo is one routine dependency bump away from
// the same red gate. The property has to be asserted or it decays back.
//
// DERIVED from the format scripts rather than naming Prettier. If a second
// formatter is ever added to `format` / `format:check`, it inherits the same
// hazard for the same reason, and it is covered here without anyone editing
// this file to remember it.
//
// The version-agreement arm is the other half. A pin that has drifted from the
// lockfile is not a pin: the declaration would say one thing, the installed
// tree another, and the gate would follow the tree.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

interface RootManifest {
  scripts?: Record<string, string>;
  devDependencies?: Record<string, string>;
  dependencies?: Record<string, string>;
}

function rootManifest(): RootManifest {
  return JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as RootManifest;
}

/**
 * Every declared dependency the `format*` scripts actually invoke.
 *
 * Matched through `node_modules/<name>/…`, which is how these scripts reach the
 * binary, and then confirmed to be a declared dependency — so a stray word in a
 * script does not become a phantom "formatter" this guard then reports on.
 */
function formattersInvokedByFormatScripts(): string[] {
  const manifest = rootManifest();
  const declared = {
    ...(manifest.dependencies ?? {}),
    ...(manifest.devDependencies ?? {}),
  };

  const found = new Set<string>();
  for (const [name, script] of Object.entries(manifest.scripts ?? {})) {
    if (!name.startsWith('format')) continue;
    for (const match of script.matchAll(/node_modules\/((?:@[^/\s]+\/)?[^/\s]+)/g)) {
      const pkg = match[1];
      if (pkg !== undefined && pkg in declared) found.add(pkg);
    }
  }
  return [...found].sort();
}

/** The version actually resolved in the lockfile for a top-level package. */
function lockedVersion(pkg: string): string | undefined {
  const lock = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package-lock.json'), 'utf8')) as {
    packages?: Record<string, { version?: string }>;
  };
  return lock.packages?.[`node_modules/${pkg}`]?.version;
}

/** True for a declaration that permits more than one version. */
function isRange(declaration: string): boolean {
  return /[\^~*x]|\s-\s|\|\||>|</.test(declaration);
}

describe('the formatter cannot change under us', () => {
  it('CRITICAL the format scripts were read and the formatter identified. The arm below asks "is every formatter pinned", and an empty list has none unpinned — a scan that matched nothing would report the repo safe having found no formatter to check.', () => {
    const formatters = formattersInvokedByFormatScripts();
    // MEASURED: prettier, invoked by both `format` and `format:check`.
    expect(formatters, 'formatters invoked by the format scripts').toEqual(['prettier']);
  });

  it('CRITICAL every formatter the format scripts invoke is pinned to an exact version. A range lets a routine `npm install` reformat the repository and red the `format:check` gate with no code change behind it — which is exactly what a caret on Prettier did on 2026-07-31, across 24 files.', () => {
    const manifest = rootManifest();
    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    const ranged = formattersInvokedByFormatScripts()
      .map((pkg) => ({ pkg, declaration: declared[pkg] ?? '' }))
      .filter((entry) => isRange(entry.declaration))
      .map((entry) => `${entry.pkg}@${entry.declaration}`);

    expect(ranged, 'formatter(s) declared with a version RANGE rather than an exact pin:').toEqual(
      [],
    );
  });

  it('CRITICAL the pin agrees with the lockfile. A declaration that has drifted from the resolved tree is not a pin — the gate runs whatever is installed, so the two disagreeing means the exact version above is describing something nobody runs.', () => {
    const manifest = rootManifest();
    const declared = {
      ...(manifest.dependencies ?? {}),
      ...(manifest.devDependencies ?? {}),
    };
    const disagreements = formattersInvokedByFormatScripts()
      .map((pkg) => ({ pkg, declaration: declared[pkg] ?? '', locked: lockedVersion(pkg) }))
      .filter((entry) => entry.declaration !== entry.locked)
      .map(
        (entry) =>
          `${entry.pkg}: package.json ${entry.declaration} vs lockfile ${String(entry.locked)}`,
      );

    expect(disagreements, 'formatter(s) whose declared version is not the locked version:').toEqual(
      [],
    );
  });

  it('CRITICAL `format` and `format:check` run the SAME binary. If writing and checking ever resolve to different formatters, the repo can be formatted into a state its own gate rejects — and the failure appears at push time, in files the pusher never touched.', () => {
    const scripts = rootManifest().scripts ?? {};
    const write = scripts.format ?? '';
    const check = scripts['format:check'] ?? '';
    expect(write, 'a `format` script exists').not.toBe('');
    expect(check, 'a `format:check` script exists').not.toBe('');

    const binary = (script: string): string => /node_modules\/\S+/.exec(script)?.[0] ?? '';
    expect(binary(check), 'check and write resolve to the same binary path').toBe(binary(write));
  });
});
