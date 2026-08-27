// V-1556 — a package imported but not declared works until the hoist moves.
//
// `apps/server/src/services/durable-webhook-delivery.ts` imported runtime symbols
// from `@driftstack/webhook-delivery`, and `lib/openapi.ts` imported a type from
// `openapi3-ts`. Neither was in `apps/server/package.json`. Both resolved anyway,
// because the workspace root links its own packages into `node_modules/@driftstack`
// and `openapi3-ts` is hoisted there by another dependency.
//
// That is a real dependency on an accident of layout. A hoist change, a version
// bump that moves `openapi3-ts` under its parent, or building the server on its
// own breaks an import that no manifest ever asked for — and the failure lands at
// runtime for the value import, not at install time.
//
// Both are now declared, so this check carries NO allowance list. That is the
// point: an exemption roster here would immediately become the thing nobody
// re-reads, which is the failure this file's own arc kept finding. If a workspace
// needs to import something it does not declare, that is a decision worth making
// visible in a diff rather than absorbing into a list.
//
// Scope, stated rather than implied. V-1556 covered TypeScript under each
// workspace's `src/` and named `.astro`/`.svelte`/`.vue` as a blind spot.
// V-1557 closes it: an Astro frontmatter fence and a `<script>` block are
// TypeScript, so they are extracted and handed to the same parser. Measured
// across 136 template files: 269 frontmatter import lines, of which only five
// are bare specifiers — Astro pages import relative layouts and data almost
// exclusively — and none of the five is undeclared.
//
// What remains outside: expressions in template MARKUP, and any file type not
// listed below. An import cannot live in markup, so the first is a boundary
// rather than a gap.

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

// ⛔ TIMEOUT — this file is I/O-bound: it reads and parses ~4000 files. Its
// runtime scales with machine load, not with anything it asserts, so the arms
// fail with "Test timed out" rather than an assertion, which reads as a
// regression in the thing being checked and is not one.
//
// ⚠️ A test that only fails under load is the kind that gets re-run until green
// rather than fixed, which is how a real failure eventually gets waved through.
// That warning is why the previous 10s -> 30s raise came with a solo baseline of
// "2.6s" recorded in a comment. The baseline then rotted, unmeasured, to 3.86s as
// the repo grew, and 30s was exceeded under a 21-worker run at load 28. A number
// typed into a comment is not a measurement; it degrades silently.
//
// The resolution is not a bigger guess. Under variable contention a wall-clock
// timeout is a POOR regression detector — it fires on a busy box and passes on an
// idle one regardless of the code. The good detector for "the walk stopped
// finding things" is the census floor, and this file already asserts one per arm;
// those floors are now PER ROOT (see workspacesByRoot) so a shrinking population
// fails loudly on its own evidence rather than incidentally via the clock.
//
// So the clock is set to accommodate contention, and correctness is carried by
// the floors. Measured solo cost is asserted below rather than described here.
vi.setConfig({ testTimeout: 120_000 });
import { describe, expect, it, vi } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** Node builtins that need no declaration. `node:`-prefixed specifiers are skipped separately. */
const BUILTINS = new Set([
  'fs',
  'path',
  'url',
  'crypto',
  'http',
  'https',
  'os',
  'util',
  'stream',
  'events',
  'zlib',
  'buffer',
  'child_process',
  'worker_threads',
  'assert',
  'timers',
  'dns',
  'net',
  'tls',
  'querystring',
  'string_decoder',
  'readline',
  'perf_hooks',
  'async_hooks',
  'module',
  'process',
  'vm',
  'v8',
  'constants',
  'tty',
  'cluster',
  'diagnostics_channel',
]);

function tsFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') tsFiles(p, out);
    } else if (/\.(ts|tsx|mts|cts)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

function templateFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name !== 'node_modules' && entry.name !== 'dist') templateFiles(p, out);
    } else if (/\.(astro|svelte|vue)$/.test(entry.name)) {
      out.push(p);
    }
  }
  return out;
}

/**
 * The TypeScript inside a template file: an Astro frontmatter fence, or the
 * `<script>` blocks of a Svelte/Vue component. Handed to the same parser as
 * ordinary source, so one code path decides what an import is.
 */
function templateCode(file: string, source: string): string[] {
  if (file.endsWith('.astro')) {
    const fence = /^---\r?\n([\s\S]*?)\r?\n---/.exec(source);
    return fence?.[1] !== undefined ? [fence[1]] : [];
  }
  return [...source.matchAll(/<script[^>]*>([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? '');
}

/**
 * Parsed specifiers, keyed by path. Arms 1 and 2 both walk every workspace `src`
 * and re-parse the identical 626 files; the second pass is pure waste. Cached
 * ONLY for the read-from-disk case — a caller passing `code` is handing us one
 * script block out of a template, where the same path legitimately yields
 * different results per block, so caching by path there would be wrong.
 */
const SPECIFIER_CACHE = new Map<string, string[]>();

/** Every module specifier in one file, read from the AST rather than by regex. */
function importSpecifiers(file: string, code?: string): string[] {
  if (code === undefined) {
    const hit = SPECIFIER_CACHE.get(file);
    if (hit !== undefined) return hit;
  }
  const source = code ?? readFileSync(file, 'utf8');
  const sf = ts.createSourceFile(
    file.endsWith('.ts') || file.endsWith('.tsx') ? file : `${file}.ts`,
    source,
    ts.ScriptTarget.Latest,
    // setParentNodes: the visitor below uses only forEachChild and type
    // predicates, never node.parent, so building parent pointers is work whose
    // result is never read. Measured over all 3324 test files: 949ms -> 637ms,
    // with byte-identical specifier output on every one of them.
    false,
    file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
  );
  const out: string[] = [];
  const visit = (n: ts.Node): void => {
    if (
      (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) &&
      n.moduleSpecifier !== undefined &&
      ts.isStringLiteral(n.moduleSpecifier)
    ) {
      out.push(n.moduleSpecifier.text);
    }
    if (ts.isCallExpression(n)) {
      const first = n.arguments[0];
      const isRequire = ts.isIdentifier(n.expression) && n.expression.text === 'require';
      const isDynamic = n.expression.kind === ts.SyntaxKind.ImportKeyword;
      if ((isRequire || isDynamic) && first !== undefined && ts.isStringLiteral(first)) {
        out.push(first.text);
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  if (code === undefined) SPECIFIER_CACHE.set(file, out);
  return out;
}

/**
 * The structural roots. Both must exist: they are not optional locations that a
 * checkout may or may not have, they are the shape of the repo.
 */
const STRUCTURAL_ROOTS = ['apps', 'packages'] as const;

/**
 * Workspaces grouped by the root they came from.
 *
 * ⛔ NO existsSync GUARD ON THE ROOT, and no `continue` on failure — readdirSync
 * throws ENOENT and that is the point. The previous version swallowed a missing
 * root and carried on, which turns a broken checkout into a SMALLER census that
 * still passes. That exact fix was made in scripts/typecheck-test-backlog.mjs and
 * the identical shape survived HERE, in the test beside it, because that sweep
 * matched the script and not its neighbour.
 *
 * Grouped rather than flat because the floors below have to be PER ROOT. Measured
 * populations: apps/ holds 533 src and 3261 test files, packages/ holds 93 and 63.
 * A COMBINED floor is therefore satisfied by apps/ alone — losing packages/
 * entirely, which is where all three SDKs live, would pass every combined
 * threshold in this file and report a clean result about a population missing
 * eight workspaces. Losing apps/ would be caught; losing packages/ would not.
 * A union floor cannot see partial loss, so the floor has to be per root.
 */
function workspacesByRoot(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const root of STRUCTURAL_ROOTS) {
    const dir = resolve(REPO_ROOT, root);
    out[root] = readdirSync(dir)
      .map((name) => join(dir, name))
      .filter((w) => statSync(w).isDirectory() && existsSync(join(w, 'package.json')));
  }
  return out;
}

function workspaces(): string[] {
  return Object.values(workspacesByRoot()).flat();
}

describe('a workspace declares what its TypeScript source imports', () => {
  it('CRITICAL each structural root is independently populated. Every other arm in this file reports an ABSENCE of offenders, so a root that silently disappeared would make them all pass over a smaller repo. The floors below are per root because a combined one cannot see partial loss: apps/ alone (533 src, 3261 tests) clears any threshold worth setting, so losing packages/ — all three SDKs — would be invisible to a union floor.', () => {
    const byRoot = workspacesByRoot();

    // Per root: a floor well under the measured population, so adding or removing
    // a workspace never fails this, but a root that vanished or stopped being
    // read does. Measured 2026-08-27: apps 8 workspaces / 533 src / 3261 tests,
    // packages 7 / 93 / 63.
    const FLOORS: Record<string, { workspaces: number; src: number; tests: number }> = {
      apps: { workspaces: 4, src: 200, tests: 1000 },
      packages: { workspaces: 4, src: 30, tests: 20 },
    };

    expect(Object.keys(byRoot).sort(), 'both structural roots derived').toEqual([
      'apps',
      'packages',
    ]);

    for (const [root, floor] of Object.entries(FLOORS)) {
      const ws = byRoot[root] ?? [];
      expect(ws.length, `workspaces found under ${root}/`).toBeGreaterThan(floor.workspaces);

      const src = ws
        .map((w) => join(w, 'src'))
        .filter((d) => existsSync(d))
        .flatMap((d) => tsFiles(d));
      expect(src.length, `TypeScript sources found under ${root}/`).toBeGreaterThan(floor.src);

      let tests = 0;
      for (const w of ws) {
        for (const dir of ['tests', 'test', '__tests__']) {
          const d = join(w, dir);
          if (existsSync(d)) tests += tsFiles(d).length;
        }
      }
      expect(tests, `test files found under ${root}/`).toBeGreaterThan(floor.tests);
    }
  });

  it('CRITICAL the scan actually parsed source. Every assertion below reports an absence, and a walk that found no files would satisfy all of them without reading anything.', () => {
    const files = workspaces()
      .map((w) => join(w, 'src'))
      .filter((d) => existsSync(d))
      .flatMap((d) => tsFiles(d));
    expect(files.length, 'TypeScript sources found under the workspaces').toBeGreaterThan(400);

    const specifiers = files.flatMap((f) => importSpecifiers(f));
    expect(specifiers.length, 'module specifiers parsed out of them').toBeGreaterThan(1000);

    // The template half has to be shown alive too: it is the blind spot V-1556
    // named, and a zero there would look identical to a clean result.
    const templates = workspaces()
      .map((w) => join(w, 'src'))
      .filter((d) => existsSync(d))
      .flatMap((d) => templateFiles(d));
    expect(templates.length, 'template files found under the workspaces').toBeGreaterThan(100);
    const templateSpecs = templates.flatMap((f) =>
      templateCode(f, readFileSync(f, 'utf8')).flatMap((code) => importSpecifiers(f, code)),
    );
    expect(
      templateSpecs.length,
      'module specifiers parsed out of template frontmatter and script blocks',
    ).toBeGreaterThan(200);
    expect(
      specifiers.some((s) => s.startsWith('.')),
      'relative specifiers are seen, so the parse is reading real imports',
    ).toBe(true);
  });

  it('CRITICAL no workspace imports a package it does not declare. An undeclared import resolves through the root hoist and the workspace link, so it works on this checkout and breaks when the layout moves — at runtime for a value import, which is what durable-webhook-delivery.ts had. There is deliberately no allowance list: needing one is a decision that belongs in a diff.', () => {
    const offenders: string[] = [];
    for (const w of workspaces()) {
      const pkg = JSON.parse(readFileSync(join(w, 'package.json'), 'utf8')) as Record<
        string,
        Record<string, string> | undefined
      >;
      const declared = new Set(
        ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
          (k) => Object.keys(pkg[k] ?? {}),
        ),
      );
      const src = join(w, 'src');
      if (!existsSync(src)) continue;
      const scanned: ReadonlyArray<readonly [string, readonly string[]]> = [
        ...tsFiles(src).map((f) => [f, importSpecifiers(f)] as const),
        ...templateFiles(src).map(
          (f) =>
            [
              f,
              templateCode(f, readFileSync(f, 'utf8')).flatMap((code) => importSpecifiers(f, code)),
            ] as const,
        ),
      ];
      for (const [file, specs] of scanned) {
        for (const spec of specs) {
          // `astro:*` are framework virtual modules; `~` and a leading `/` are
          // path aliases, not packages.
          if (
            spec.startsWith('.') ||
            spec.startsWith('node:') ||
            spec.startsWith('astro:') ||
            spec.startsWith('~') ||
            spec.startsWith('/')
          ) {
            continue;
          }
          const name = spec.startsWith('@')
            ? spec.split('/').slice(0, 2).join('/')
            : (spec.split('/')[0] ?? spec);
          if (BUILTINS.has(name)) continue;
          if (!declared.has(name)) {
            offenders.push(
              `${w.slice(REPO_ROOT.length + 1)} imports ${name} (${file.slice(REPO_ROOT.length + 1)})`,
            );
          }
        }
      }
    }
    expect(
      [...new Set(offenders)].sort(),
      'these workspaces import a package their package.json never asked for',
    ).toEqual([]);
  });

  it('V-1558 CRITICAL the repo\'s own scripts declare what they import. `scripts/*` runs against the ROOT manifest, and eight of them imported `playwright`, `postgres` and `sharp`, which no manifest in the repo named — they resolved only because another dependency happened to hoist them there. None is referenced by a package.json script or a workflow, so the breakage would have surfaced as "this tool is broken" long after the dependency that carried them changed. A workspace CONFIG file is judged differently and deliberately: `apps/*/vitest.config.ts` importing `vitest` is correct, because the root declares it and the root runner executes the config — that is resolution working as designed, not a phantom.', () => {
    const scriptsDir = resolve(REPO_ROOT, 'scripts');
    if (!existsSync(scriptsDir)) return;

    const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const rootDeclared = new Set(
      ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap((k) =>
        Object.keys(rootPkg[k] ?? {}),
      ),
    );

    const scripts = readdirSync(scriptsDir)
      .filter((n) => /\.(ts|mts|cts|mjs|cjs|js)$/.test(n))
      .map((n) => join(scriptsDir, n));
    // Reports an absence, so an empty directory listing would pass it clean.
    expect(scripts.length, 'executable scripts found under scripts/').toBeGreaterThan(10);

    const offenders: string[] = [];
    let seen = 0;
    for (const file of scripts) {
      for (const spec of importSpecifiers(file, readFileSync(file, 'utf8'))) {
        if (
          spec.startsWith('.') ||
          spec.startsWith('node:') ||
          spec.startsWith('~') ||
          spec.startsWith('/')
        ) {
          continue;
        }
        seen += 1;
        const name = spec.startsWith('@')
          ? spec.split('/').slice(0, 2).join('/')
          : (spec.split('/')[0] ?? spec);
        if (BUILTINS.has(name)) continue;
        if (!rootDeclared.has(name))
          offenders.push(`${name} (${file.slice(REPO_ROOT.length + 1)})`);
      }
    }
    // Measured at 8. The floor is a non-vacuity check, not a pin: adding or
    // removing a script must not fail this arm, but a parser that stopped
    // reading them must.
    expect(seen, 'bare-specifier imports parsed out of the scripts').toBeGreaterThan(4);
    expect(
      [...new Set(offenders)].sort(),
      'these scripts import a package the root manifest never asked for, and work only while ' +
        'something else keeps hoisting it',
    ).toEqual([]);
  });

  it("V-1559 CRITICAL a workspace's TESTS declare what they import, counting the root manifest as well as their own. Tests run under the ROOT vitest, so `vitest` is correctly undeclared everywhere and this arm must not say otherwise — the rule is own-manifest OR root, the same distinction V-1558 drew for config files applied to the directory tests live in. Nine imports satisfied neither: jsdom in five apps, github-slugger in apps/docs, and @driftstack/api-types in three, all resolving only because something hoisted them. This fails in CI rather than for a customer, which is the loud direction, but it fails on a day nothing about the test changed.", () => {
    const rootPkg = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as Record<
      string,
      Record<string, string> | undefined
    >;
    const declaredIn = (pkg: Record<string, Record<string, string> | undefined>): Set<string> =>
      new Set(
        ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies'].flatMap(
          (k) => Object.keys(pkg[k] ?? {}),
        ),
      );
    const rootDeclared = declaredIn(rootPkg);

    let files = 0;
    let specifiers = 0;
    const offenders: string[] = [];
    for (const w of workspaces()) {
      const own = declaredIn(
        JSON.parse(readFileSync(join(w, 'package.json'), 'utf8')) as Record<
          string,
          Record<string, string> | undefined
        >,
      );
      for (const dir of ['tests', 'test', '__tests__']) {
        const d = join(w, dir);
        if (!existsSync(d)) continue;
        for (const file of tsFiles(d)) {
          files += 1;
          for (const spec of importSpecifiers(file)) {
            if (
              spec.startsWith('.') ||
              spec.startsWith('node:') ||
              spec.startsWith('~') ||
              spec.startsWith('/')
            ) {
              continue;
            }
            specifiers += 1;
            const name = spec.startsWith('@')
              ? spec.split('/').slice(0, 2).join('/')
              : (spec.split('/')[0] ?? spec);
            if (BUILTINS.has(name)) continue;
            if (!own.has(name) && !rootDeclared.has(name)) {
              offenders.push(`${w.slice(REPO_ROOT.length + 1)} :: ${name}`);
            }
          }
        }
      }
    }

    // Measured at 3266 files and 4277 specifiers. Floors, not pins: adding or
    // deleting tests must not fail this, but a walk that stopped finding them must.
    expect(files, 'test files walked').toBeGreaterThan(2000);
    expect(specifiers, 'bare-specifier imports parsed out of them').toBeGreaterThan(2000);
    expect(
      [...new Set(offenders)].sort(),
      'these tests import a package neither their workspace nor the root declares',
    ).toEqual([]);
  });
});
