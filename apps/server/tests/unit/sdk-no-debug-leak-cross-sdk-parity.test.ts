// W839 — cross-SDK no debug-leak parity. One-hundred-sixty-fifth in
// the drift-guard series. Pins that no SDK runtime source has
// console.log / print( debugging-leaks. Examples are exempt (they
// intentionally print). Production SDK code must use the logger
// framework or stay silent — drift to leaving debug prints in
// would spam customer stdout, leak sensitive data, or impact
// performance.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readdirSync, statSync } from 'node:fs';

import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** Recursively list files matching extension under dir. */
function listFiles(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = resolve(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      out.push(...listFiles(full, ext));
    } else if (entry.endsWith(ext)) {
      out.push(full);
    }
  }
  return out;
}

/**
 * Strip TS/JS comments. Strings are NOT stripped, despite what this function was
 * called until V-1013 — nothing here ever removed them.
 *
 * The removed implementation ran the block-comment pass first, so the `/*` in a
 * line comment naming a wildcard route path opened a comment that closed at the
 * next `*\/`. `resources/account.ts` opens with exactly that, and the resulting
 * span swallowed its first 24 lines — imports included. A `console.log` placed in
 * that span was NOT reported: the shipped guard passed 7/7 with one planted
 * there, and the shared scanner fails on it by name.
 */
function stripComments(src: string): string {
  return codeOnly(src);
}

/** Strip Python comments + docstrings naively. */
function stripPythonCommentsAndDocstrings(src: string): string {
  // Remove triple-quoted strings (docstrings).
  let s = src.replace(/"""[\s\S]*?"""/g, '');
  s = s.replace(/'''[\s\S]*?'''/g, '');
  // Remove line comments.
  s = s.replace(/^\s*#.*$/gm, '');
  return s;
}

/** Strip Go comments naively. */
function stripGoComments(src: string): string {
  // Same as TS — Go uses //+/* */ syntax.
  return stripComments(src);
}

// The three detectors, named once and used both by the sweeps below and by the
// reachability check. A floor that re-implemented these would prove its own
// copy works, which is not the question being asked of it.

/** Bare `console.*` calls in TS source, ignoring comments. */
function tsDebugLeaks(src: string): string[] {
  // Allow logger.debug(...) but flag bare console.*.
  return stripComments(src).match(/\bconsole\.(log|debug|info|warn|error)\s*\(/g) ?? [];
}

/** Bare `print(` calls in Python source, ignoring comments and docstrings. */
function pyDebugLeaks(src: string): string[] {
  // bare `print(` (not preceded by . — to allow self.print or similar method names).
  return stripPythonCommentsAndDocstrings(src).match(/(?<![a-zA-Z_.])print\s*\(/g) ?? [];
}

/** Bare print/log calls in Go source, ignoring comments. */
function goDebugLeaks(src: string): string[] {
  return (
    stripGoComments(src).match(/\b(fmt\.Println|log\.Println|fmt\.Printf|log\.Printf)\s*\(/g) ?? []
  );
}

/** Top-level, non-test Go sources — the runtime surface customers compile. */
function goRuntimeFiles(): string[] {
  const goSrcDir = resolve(REPO_ROOT, 'packages/sdk-go');
  // Only scan top-level Go files; skip examples/ + tests/.
  return readdirSync(goSrcDir)
    .filter((f) => f.endsWith('.go') && !f.endsWith('_test.go'))
    .map((f) => resolve(goSrcDir, f));
}

describe('W839 cross-SDK no debug-leak parity', () => {
  it('CRITICAL each language scan read real files, and each detector can still see a leak. Every assertion in this file runs INSIDE a `for (const f of files)` loop, so a scan that collected nothing makes all three vacuously true — reporting all three SDKs clean because it read none. Neutralising the directory read left this file green, which is how the gap was found rather than guessed.', () => {
    expect(
      listFiles(resolve(REPO_ROOT, 'packages/sdk-typescript/src'), '.ts').length,
      'TypeScript runtime sources scanned',
    ).toBeGreaterThan(15);
    expect(
      listFiles(resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack'), '.py').length,
      'Python runtime sources scanned',
    ).toBeGreaterThan(15);
    expect(goRuntimeFiles().length, 'Go runtime sources scanned').toBeGreaterThan(15);

    // Each detector against input it must catch, and input it must ignore. The
    // strippers are naive by design, and one that over-stripped would silence
    // its sweep completely while still looking like it ran.
    expect(tsDebugLeaks('console.log(x);'), 'TS detector sees a bare console.log').toHaveLength(1);
    expect(tsDebugLeaks('// console.log(x);'), 'and not one inside a comment').toEqual([]);
    expect(pyDebugLeaks('print(x)'), 'Python detector sees a bare print()').toHaveLength(1);
    expect(pyDebugLeaks('"""\nprint(x)\n"""'), 'and not one inside a docstring').toEqual([]);
    expect(goDebugLeaks('fmt.Println(x)'), 'Go detector sees a bare fmt.Println').toHaveLength(1);
    expect(goDebugLeaks('// fmt.Println(x)'), 'and not one inside a comment').toEqual([]);
  });

  // ─── TS runtime source: no console.log outside docstrings ─────

  it('CRITICAL TS runtime sources have NO console.log / console.debug / console.info / console.warn / console.error outside comments + docstring examples. Drift would let production SDK code spam customer stdout. Resource-method docstrings DO use console.log to show example usage — those are stripped before the assertion.', () => {
    const tsSrcDir = resolve(REPO_ROOT, 'packages/sdk-typescript/src');
    const files = listFiles(tsSrcDir, '.ts');
    for (const f of files) {
      const matches = tsDebugLeaks(read(f));
      expect(matches.length, `${f} has debug-leak: ${matches.join(', ')}`).toBe(0);
    }
  });

  // ─── Python runtime source: no bare print() outside docstrings ─

  it('CRITICAL Python runtime sources have NO bare print() calls outside docstrings. Drift would spam customer stdout when the SDK is used in production (e.g. inside a long-running daemon). Docstring examples with print() are stripped before the assertion.', () => {
    const pySrcDir = resolve(REPO_ROOT, 'packages/sdk-python/src/driftstack');
    const files = listFiles(pySrcDir, '.py');
    for (const f of files) {
      const matches = pyDebugLeaks(read(f));
      expect(matches.length, `${f} has print()-leak: ${matches.length} occurrences`).toBe(0);
    }
  });

  // ─── Go runtime source: no fmt.Println / log.Println in non-example ─

  it('CRITICAL Go runtime sources (client.go + resource .go files; NOT examples/) have NO fmt.Println or log.Println outside comments. Drift would let SDK code spam customer stdout. examples/ folder is exempt by definition (examples MUST print to be useful).', () => {
    for (const f of goRuntimeFiles()) {
      const matches = goDebugLeaks(read(f));
      expect(matches.length, `${f} has print-leak: ${matches.join(', ')}`).toBe(0);
    }
  });

  // ─── Examples ARE allowed to use console.log / print / fmt ────

  it("CRITICAL examples/ folders DO use console.log / print() / fmt.Println — that's how they demonstrate API responses. Drift to silencing examples would hide demo output (which is the point). This pin asserts the exemption is intentional.", () => {
    const tsQs = read(resolve(REPO_ROOT, 'packages/sdk-typescript/examples/quickstart.ts'));
    const pyQs = read(resolve(REPO_ROOT, 'packages/sdk-python/examples/quickstart.py'));
    const goQs = read(resolve(REPO_ROOT, 'packages/sdk-go/examples/quickstart/main.go'));

    expect(tsQs).toMatch(/console\.log\(/);
    expect(pyQs).toMatch(/print\(/);
    expect(goQs).toMatch(/fmt\.Print/);
  });

  // ─── TS uses /* eslint-disable no-console */ in examples ──────

  it("CRITICAL TS examples explicitly /* eslint-disable no-console */ to permit demo output. This is the canonical 'this is a script, not library code' marker — drift to dropping it would either re-enable lint noise or hide intentional output.", () => {
    const files = [
      'packages/sdk-typescript/examples/quickstart.ts',
      'packages/sdk-typescript/examples/error-handling.ts',
      'packages/sdk-typescript/examples/pagination.ts',
    ];
    for (const f of files) {
      const p = read(resolve(REPO_ROOT, f));
      expect(p, `${f} must have /* eslint-disable no-console */`).toMatch(
        /\/\* eslint-disable no-console \*\//,
      );
    }
  });

  it('test file metadata — file exists at canonical path', () => {
    expect(
      existsSync(
        resolve(REPO_ROOT, 'apps/server/tests/unit/sdk-no-debug-leak-cross-sdk-parity.test.ts'),
      ),
    ).toBe(true);
  });
});
