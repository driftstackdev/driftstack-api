// The published SDK LOADS — both entry points, proved by loading them.
//
// ⛔ WHY THIS FILE EXISTS. Every other guard on @driftstack/sdk reads text.
// sdk-typescript-package-json-content-parity pins the exports map's shape,
// ci-workflow-parity pins the smoke step's wording, and the shipped-text scan
// reads the tarball as prose. None of them loads anything — and on 2026-09-20,
// with all of them green, `require('@driftstack/sdk')` threw
// ERR_PACKAGE_PATH_NOT_EXPORTED on a clean install of the packed tarballs.
// `dist/index.cjs` required `@driftstack/api-types`, which is ESM-only
// (`exports` offers `types` and `import`, no `require`, no `default`), so the
// file `main` and the `require` condition both point at could not be loaded at
// all. It was a REGRESSION: the published 0.1.6 bundle required api-types zero
// times, so CommonJS worked for customers and broke on upgrade.
//
// A test that reads cannot catch that. This one runs `require()` and
// `import()` in a CHILD PROCESS, against the real built artifact, and fails on
// the child's exit code.
//
// ⛔ AND IT CANNOT BE THE ONLY THING RUN IN CI. A child process here uses this
// repository's node_modules, where api-types is a workspace symlink; the
// customer's install has neither. The arms below therefore also assert the
// property that makes the two situations the same — the bundles name NO bare
// specifier except this package's declared runtime dependencies — so a green
// result here is not a statement about the workspace's luck.
//
// The second thing bundling api-types put at risk: api-types' `src/` is NOT
// swept customer-facing text (only its compiled `dist/` is), and it carries the
// unreleased pricing module. The first bundled build embedded six api-types
// sources in `sourcesContent` and took the SDK's shipped-text scan from 0/0 to
// 194 ticket ids + 320 internal-vocabulary hits. `scripts/sdk-typescript-harden-sourcemaps.mjs`
// de-embeds them; the last arms hold that closed, using the build step's own
// function and the publish step's own credits detector rather than re-derived
// copies of either.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { builtinModules } from 'node:module';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { creditsMentions } from '../../../../scripts/api-types-build-publish.mjs';
import {
  hardenMap,
  isOwnSource,
  publicSourceName,
} from '../../../../scripts/sdk-typescript-harden-sourcemaps.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const SDK = resolve(REPO_ROOT, 'packages/sdk-typescript');
const DIST = resolve(SDK, 'dist');
const CJS = resolve(DIST, 'index.cjs');
const ESM = resolve(DIST, 'index.js');

/** The files the tarball carries, so an arm cannot check a file that never ships. */
const SHIPPED = [
  'dist/index.js',
  'dist/index.cjs',
  'dist/index.d.ts',
  'dist/index.d.cts',
  'dist/index.js.map',
  'dist/index.cjs.map',
  'package.json',
  'README.md',
  'CHANGELOG.md',
  'LICENSE',
];

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

/** Node's own module names, so a builtin is recognised by being one. */
const BUILTINS = new Set(builtinModules);

/**
 * Every BARE package `text` reaches for at RUNTIME, reduced to the name npm
 * would have to install, builtins removed.
 *
 * ⛔ THE DYNAMIC `import()` IS PART OF THE POPULATION. A `require(…)`-and-`from
 * …` extractor is the obvious one and it is not enough: measured 2026-09-20,
 * BOTH bundles carry `await import("crypto")` — a real runtime resolution that
 * such an extractor never sees. Today that specifier is a builtin and harmless;
 * the day a lazily-loaded PACKAGE arrives the same blindness returns the empty
 * roster, which is also what a correctly hermetic bundle returns, and the
 * clean-install break this file exists for ships green.
 *
 * ⛔ AND A BUILTIN IS NOT "STARTS WITH node:". The bundle asks for bare
 * `crypto`, no prefix. A prefix test would hand `crypto` to the
 * is-it-a-declared-dependency check and fail on a module that is always there.
 */
function runtimePackagesOf(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/(?:require\(|import\(|from\s*)\s*["']([^"']+)["']/gu)) {
    const spec = m[1];
    if (spec === undefined || spec.startsWith('.') || spec.startsWith('/')) continue;
    const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (root === undefined) continue;
    if (BUILTINS.has(root) || root.startsWith('node:')) continue;
    names.add(root);
  }
  return [...names].sort();
}

/**
 * Run `code` in a fresh node process and return what happened.
 *
 * ⛔ `status` is the CHILD's exit code, and it is the verdict. An in-process
 * `await import()` would be resolved by vitest's own loader, which applies
 * conditions this file has no business testing; the customer's `node` is the
 * only resolver whose answer counts.
 */
function runInNode(
  code: string,
  cwd: string,
): { status: number | null; stderr: string; stdout: string } {
  const r = spawnSync(process.execPath, ['-e', code], { cwd, encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr ?? '', stdout: r.stdout ?? '' };
}

const built = existsSync(CJS) && existsSync(ESM);
const UNBUILT =
  'packages/sdk-typescript/dist is not built, and an unbuilt dist makes these arms vacuous ' +
  'rather than failing. Run `npm run build -w packages/sdk-typescript`.';

const temps: string[] = [];
afterAll(() => {
  for (const t of temps) rmSync(t, { recursive: true, force: true });
});
function temp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  temps.push(d);
  return d;
}

describe('the published SDK loads under require() and import()', () => {
  it('the built artifact is present, so every arm below is about the real bundle', () => {
    expect(existsSync(CJS), UNBUILT).toBe(true);
    expect(existsSync(ESM), UNBUILT).toBe(true);
  });

  it('CRITICAL require() of dist/index.cjs loads in a real node process and yields the client. This is the arm the 0.2.0 blocker would have failed: main and the exports `require` condition both point here, and a bundle that cannot be required makes the package unusable for every CommonJS consumer', () => {
    expect(built, UNBUILT).toBe(true);
    const r = runInNode(
      `const sdk = require(${JSON.stringify(CJS)});
       if (typeof sdk.Driftstack !== 'function') throw new Error('no Driftstack export');
       new sdk.Driftstack({ apiKey: 'ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
       process.stdout.write('ok');`,
      SDK,
    );
    expect(
      r.status,
      `require('${CJS}') failed:\n${r.stderr.split('\n').slice(0, 6).join('\n')}`,
    ).toBe(0);
    expect(r.stdout).toBe('ok');
  });

  it('CRITICAL import() of dist/index.js loads in a real node process and yields the client — the ESM half of the same promise', () => {
    expect(built, UNBUILT).toBe(true);
    const r = runInNode(
      `import(${JSON.stringify(ESM)}).then((sdk) => {
         if (typeof sdk.Driftstack !== 'function') throw new Error('no Driftstack export');
         new sdk.Driftstack({ apiKey: 'ds_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
         process.stdout.write('ok');
       }).catch((e) => { console.error(e); process.exit(1); });`,
      SDK,
    );
    expect(
      r.status,
      `import('${ESM}') failed:\n${r.stderr.split('\n').slice(0, 6).join('\n')}`,
    ).toBe(0);
    expect(r.stdout).toBe('ok');
  });

  // Without this, "the child exited 0" is also what a harness reports when it
  // never ran the code, mis-spelled the path, or swallowed the throw — and the
  // exact failure being guarded against (an import-only package required from
  // CJS) is the one that has to come back RED.
  it('NEGATIVE CONTROL the child-process harness reports ERR_PACKAGE_PATH_NOT_EXPORTED when a CJS file requires an import-only package — the precise shape of the 0.2.0 blocker, reconstructed', () => {
    const root = temp('sdk-loads-control-');
    const pkgDir = join(root, 'node_modules', 'import-only');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: 'import-only',
        version: '1.0.0',
        type: 'module',
        exports: { '.': { types: './i.d.ts', import: './i.js' } },
      }),
    );
    writeFileSync(join(pkgDir, 'i.js'), 'export const x = 1;\n');
    writeFileSync(join(root, 'consumer.cjs'), 'require("import-only");\n');

    const bad = runInNode(`require(${JSON.stringify(join(root, 'consumer.cjs'))});`, root);
    expect(bad.status, 'the harness did not surface the failure').not.toBe(0);
    expect(bad.stderr).toContain('ERR_PACKAGE_PATH_NOT_EXPORTED');

    // And the same harness returns 0 for a file that does load, so a non-zero
    // status is a statement about the subject and not about the harness.
    writeFileSync(join(root, 'fine.cjs'), 'process.stdout.write("ok");\n');
    const good = runInNode(`require(${JSON.stringify(join(root, 'fine.cjs'))});`, root);
    expect(good.status).toBe(0);
    expect(good.stdout).toBe('ok');
  });

  it("CRITICAL neither bundle names @driftstack/api-types at runtime. The arms above run inside this repository, where api-types is a workspace symlink and would resolve even if the bundle asked for it; a customer's install has no such file. This is what makes the two the same", () => {
    expect(built, UNBUILT).toBe(true);
    for (const f of ['dist/index.js', 'dist/index.cjs']) {
      expect(
        read(resolve(SDK, f)),
        `${f} still names @driftstack/api-types as a module specifier — it must be BUNDLED, ` +
          'not imported (packages/sdk-typescript/tsup.config.ts, noExternal)',
      ).not.toMatch(/(?:require|from)\s*\(?\s*["']@driftstack\/api-types["']/u);
    }
  });

  it('CRITICAL every bare specifier either bundle names at runtime is a declared runtime dependency of this package. A bundle that reaches for anything else is broken on a clean install in exactly the way the 0.2.0 blocker was, whatever the exports map says', () => {
    expect(built, UNBUILT).toBe(true);
    const pkg = JSON.parse(read(resolve(SDK, 'package.json'))) as {
      dependencies?: Record<string, string>;
    };
    const declared = new Set(Object.keys(pkg.dependencies ?? {}));
    const packages = new Set<string>();
    for (const f of ['dist/index.js', 'dist/index.cjs'])
      for (const name of runtimePackagesOf(read(resolve(SDK, f)))) packages.add(name);

    expect(
      [...packages].sort(),
      'no bare package was extracted from either bundle — the regex, not the bundles',
    ).not.toEqual([]);
    for (const name of packages) {
      expect(
        declared.has(name),
        `the bundles reach for "${name}" at runtime but it is not in dependencies — ` +
          'a consumer installing @driftstack/sdk would not get it',
      ).toBe(true);
    }
  });

  // The arm above is a "nothing unexpected is here" claim over a roster the
  // extractor builds, so the extractor is what has to be shown to work — on the
  // two forms the previous one missed, and on the builtin it must not report.
  it('NEGATIVE CONTROL the runtime-package extractor sees a DYNAMIC import() and a deep subpath, leaves relative paths alone, and does not report a node builtin — the three ways the roster above goes quietly empty', () => {
    expect(
      runtimePackagesOf('const x = await import("left-pad");'),
      'a lazily-loaded package is invisible to the extractor — the exact hole that let ' +
        '`await import("crypto")` sit in both bundles unread',
    ).toEqual(['left-pad']);
    expect(runtimePackagesOf('require("@scope/pkg/deep/file.js")')).toEqual(['@scope/pkg']);
    expect(runtimePackagesOf('import { z } from "zod";')).toEqual(['zod']);
    expect(
      runtimePackagesOf('require("./local.js"); import("../other.js"); from "/abs.js"'),
    ).toEqual([]);
    expect(
      runtimePackagesOf('await import("crypto"); require("node:fs");'),
      'a builtin is being reported as a package npm must install',
    ).toEqual([]);
    // And the real bundles are exactly one package, so the arm above is not
    // walking a list padded by a regex that matches prose.
    if (built)
      expect(runtimePackagesOf(read(CJS)), 'the CJS bundle reaches for something new').toEqual([
        'zod',
      ]);
  });

  it("CRITICAL nothing the tarball ships names the unreleased credits feature. Bundling api-types pulls its dist through esbuild, and the barrel re-exports the pricing module: measured 2026-09-20, the first bundled build carried MICROCREDITS_PER_CREDIT and the whole rate card into dist/index.cjs, and api-types' src/ai-credits.ts into the sourcemaps. What keeps it out is `sideEffects: false` on api-types, which lets the bundler drop the modules the SDK does not use — a silent lever, so its effect is asserted here rather than assumed", () => {
    expect(built, UNBUILT).toBe(true);
    const offenders: string[] = [];
    for (const f of SHIPPED) {
      const p = resolve(SDK, f);
      expect(existsSync(p), `${f} is in the published file list but not on disk`).toBe(true);
      for (const hit of creditsMentions(read(p)))
        offenders.push(`${f}:${hit.line}  ${hit.text.slice(0, 120)}`);
    }
    expect(offenders, offenders.slice(0, 5).join('\n')).toEqual([]);
  });

  it("NEGATIVE CONTROL the credits detector used above is the publish step's own, and it reports — a check that matches nothing would pass the arm above on any bundle at all", () => {
    expect(creditsMentions('const MICROCREDITS_PER_CREDIT = 1e6;').length).toBe(1);
    expect(creditsMentions('monthly_credits: z.number()').length).toBe(1);
    expect(creditsMentions('the credit card on file').length).toBe(1);
    expect(creditsMentions('an accredited partner, credentials included').length).toBe(0);
  });

  it("CRITICAL the published sourcemaps embed this package's source text and nobody else's. dist/ is the only copy of our source a customer gets, so the maps keep sourcesContent — but api-types' src/ is not customer-facing text, and six of its files arrived in sourcesContent the first time the bundle included it", () => {
    expect(built, UNBUILT).toBe(true);
    for (const f of ['dist/index.js.map', 'dist/index.cjs.map']) {
      const file = resolve(SDK, f);
      const map = JSON.parse(read(file)) as {
        sources: string[];
        sourcesContent: (string | null)[];
      };
      expect(map.sources.length, `${f} lists no sources`).toBeGreaterThan(0);
      expect(map.sourcesContent.length, `${f}: sourcesContent is not aligned with sources`).toBe(
        map.sources.length,
      );
      for (let i = 0; i < map.sources.length; i++) {
        if (isOwnSource(map.sources[i], dirname(file))) continue;
        expect(
          map.sourcesContent[i],
          `${f} embeds the text of ${map.sources[i]}, which is not this package's source`,
        ).toBeNull();
      }
      // Our own source is still there — this arm must not be satisfiable by
      // stripping sourcesContent entirely, which is the cheap way to pass it.
      const ours = map.sources.filter(
        (s, i) => isOwnSource(s, dirname(file)) && map.sourcesContent[i] !== null,
      );
      expect(ours.length, `${f} no longer embeds any of this package's own source`).toBeGreaterThan(
        5,
      );
    }
  });

  it('NEGATIVE CONTROL the hardening step drops a foreign source and keeps an own one, and renames without losing alignment', () => {
    const mapDir = resolve(SDK, 'dist');
    const input = {
      version: 3,
      sources: ['../src/client.ts', '../../api-types/src/common.ts'],
      sourcesContent: ['export class A {}', 'export const V_073 = 1;'],
      mappings: 'AAAA',
    };
    const { map, dropped } = hardenMap(input, mapDir);
    expect(dropped).toEqual(['../../api-types/src/common.ts']);
    expect(map.sources).toEqual(['../src/client.ts', '@driftstack/api-types/src/common.ts']);
    expect(map.sourcesContent).toEqual(['export class A {}', null]);
    expect(map.mappings).toBe('AAAA');
    // And it is not a function that nulls everything.
    expect(isOwnSource('../src/client.ts', mapDir)).toBe(true);
    expect(isOwnSource('../../api-types/src/common.ts', mapDir)).toBe(false);
    expect(publicSourceName('../../api-types/src/common.ts')).toBe(
      '@driftstack/api-types/src/common.ts',
    );
  });
});
