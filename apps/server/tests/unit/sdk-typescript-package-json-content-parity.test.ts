// W531.B — drift guard for packages/sdk-typescript/package.json.
// Public TypeScript SDK manifest (@driftstack/sdk). Drift here either
// breaks dual ESM+CJS exports (would lose consumers stuck on CJS, e.g.
// Node < 22 with require()) or reinstates a RUNTIME dependency on
// @driftstack/api-types, which is ESM-only and therefore cannot be
// loaded from the CJS entry point at all.
//
//   • Name: @driftstack/sdk + 'Official TypeScript SDK for the
//     Driftstack API' description.
//   • Dual exports: main:.cjs + module:.js + types:.d.ts, and the '.'
//     exports map gives EACH condition its own types file —
//     import -> .d.ts, require -> .d.cts.
//   • engines.node: >=18 (SDK supports older Node than the server's
//     >=22 to broaden consumer reach).
//   • 3 scripts: build (tsup + the sourcemap hardening step) +
//     typecheck (tsc --noEmit) + clean.
//   • Runtime dep: zod ^3.24.0 (only — the api-types schemas this
//     package bundles need it, and one SHARED copy is what keeps
//     `err instanceof z.ZodError` true across package boundaries).
//   • devDep: tsup (bundler) + @types/node + @driftstack/api-types
//     (bundled at build time, so a BUILD dependency, not a runtime
//     one — a consumer never resolves it).
//   • SEO keywords: driftstack + iphone + safari + automation +
//     stealth + browser.

import { existsSync, readFileSync } from 'node:fs';
import { builtinModules } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W531.B packages/sdk-typescript/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    description: string;
    type: string;
    main: string;
    module: string;
    types: string;
    exports: Record<string, Record<string, string>>;
    files: string[];
    engines: Record<string, string>;
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
    devDependencies: Record<string, string>;
    keywords: string[];
    license: string;
    publishConfig: { access: string };
    repository: { directory: string };
  };

  it("Identity + ESM/CJS dual-entry framing pinned: 'name: @driftstack/sdk' (the SDK package, distinct from @driftstack/api-types) + 'description: \"Official TypeScript SDK for the Driftstack API\"' + 'type: module' + 'main: ./dist/index.cjs' (CJS fallback for require()) + 'module: ./dist/index.js' (ESM main) + 'types: ./dist/index.d.ts' — pinned so the ESM+CJS dual-build commitment survives (drift to dropping main:.cjs would break Node-CJS require() consumers)", () => {
    expect(pkg.name).toBe('@driftstack/sdk');
    expect(pkg.description).toBe('Official TypeScript SDK for the Driftstack API');
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('./dist/index.cjs');
    expect(pkg.module).toBe('./dist/index.js');
    expect(pkg.types).toBe('./dist/index.d.ts');
  });

  it('exports CONDITION-SCOPED types framing pinned: \'exports.".".import: { types: ./dist/index.d.ts, default: ./dist/index.js }\' + \'.require: { types: ./dist/index.d.cts, default: ./dist/index.cjs }\' — pinned so the modern exports-map commitment survives (drift to dropping require: would break CJS consumers despite main:.cjs still being there — the exports map takes precedence). ⛔ NOT the flat types+import+require triple this replaced: ONE top-level `types` is read under BOTH conditions, so a CommonJS TypeScript consumer was handed dist/index.d.ts — an ESM declaration, because package.json says type: module — and tsc refused it with TS1479, "the referenced file is an ECMAScript module and cannot be imported with require". dist/index.d.cts was built and unreachable. Measured 2026-09-20 against the packed tarball under moduleResolution node16', () => {
    expect(pkg.exports['.']).toEqual({
      import: { types: './dist/index.d.ts', default: './dist/index.js' },
      require: { types: './dist/index.d.cts', default: './dist/index.cjs' },
    });
    // Order is load-bearing inside an exports map: `types` has to come before
    // the code entry in each condition, or a resolver taking the first match
    // returns the .js and never looks for a declaration file.
    for (const cond of ['import', 'require'] as const) {
      expect(Object.keys(pkg.exports['.']?.[cond] as unknown as object)).toEqual([
        'types',
        'default',
      ]);
    }
  });

  it("engines + 3-script pipeline framing pinned: 'engines.node: >=18' (SDK supports older Node than server's >=22 to broaden consumer reach) + 'build: tsup && node ../../scripts/sdk-typescript-harden-sourcemaps.mjs' (tsup bundles dual ESM+CJS; the second half de-embeds the bundled api-types source text from the published sourcemaps — without it the shipped-text scan went from 0/0 to 194 ticket ids + 320 internal-vocabulary hits, every one inside sourcesContent) + 'typecheck: tsc --noEmit -p tsconfig.json' + 'clean: rm -rf dist' — pinned so the Node-18-minimum (NOT 22 — SDK consumers may be on older runtimes) + 3-script pipeline commitment survives", () => {
    expect(pkg.engines.node).toBe('>=18');
    expect(pkg.scripts.build).toBe(
      'tsup && node ../../scripts/sdk-typescript-harden-sourcemaps.mjs',
    );
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit -p tsconfig.json');
    expect(pkg.scripts.clean).toBe('rm -rf dist');
  });

  it('Runtime-dep + devDep + files-allowlist framing pinned: \'dependencies: { "zod": "^3.24.0" }\' — the ONLY runtime dependency, and NOT @driftstack/api-types, which moved to devDependencies on 2026-09-20 because the build now BUNDLES it (packages/sdk-typescript/tsup.config.ts, `noExternal`). Three things follow and each is the point of a different pin below: a consumer never resolves api-types, so "publish api-types first" can no longer break an SDK install; the bundled schemas still need zod, and it is shared rather than duplicated so `err instanceof z.ZodError` holds across the boundary; and the range matches api-types\' own ^3.24.0 so npm dedupes to one copy. + \'devDependencies: tsup + @types/node + @driftstack/api-types\' + \'files: ["dist", "README.md", "CHANGELOG.md", "LICENSE"]\' (publish-clean — the 2026-09-20 release added the CHANGELOG and the licence text, which npm had been serving without; `scripts/` is deliberately absent, the sourcemap hardening step is a repo tool and must not ship) — pinned so the one-runtime-dep commitment survives', () => {
    expect(pkg.dependencies).toEqual({ zod: '^3.24.0' });
    expect(
      pkg.dependencies,
      'api-types is BUNDLED — as a runtime dependency it is ESM-only and unloadable from dist/index.cjs',
    ).not.toHaveProperty('@driftstack/api-types');
    expect(pkg.devDependencies).toHaveProperty('tsup');
    expect(pkg.devDependencies).toHaveProperty('@types/node');
    expect(pkg.devDependencies).toHaveProperty('@driftstack/api-types');
    expect(pkg.files).toEqual(['dist', 'README.md', 'CHANGELOG.md', 'LICENSE']);
  });

  it("publish + 6-keyword SEO + repository framing pinned: 'publishConfig.access: \"public\"' + 'license: MIT' + 6 keywords: driftstack + iphone + safari + automation + stealth + browser (npm-search positioning around iPhone Safari automation) + 'repository.directory: \"packages/sdk-typescript\"' — pinned so the public-access + 6-keyword positioning + monorepo-subdir publish commitment survives", () => {
    expect(pkg.publishConfig.access).toBe('public');
    expect(pkg.license).toBe('MIT');
    expect(pkg.keywords).toEqual([
      'driftstack',
      'iphone',
      'safari',
      'automation',
      'stealth',
      'browser',
    ]);
    expect(pkg.repository.directory).toBe('packages/sdk-typescript');
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });

  // ── the CJS entry has to RESOLVE, not just be spelled correctly ────────────
  //
  // Every arm above pins the SHAPE of the exports map. None of them loads
  // anything, so all of them stayed green while `require('@driftstack/sdk')` —
  // the path `main` and the `require` condition both point at — threw on a
  // clean install. That was not hypothetical: measured 2026-09-20 against the
  // packed tarballs, `require('@driftstack/sdk')` failed with
  // ERR_PACKAGE_PATH_NOT_EXPORTED, because `dist/index.cjs` required
  // `@driftstack/api-types` at runtime and that package's exports map offers
  // only `types` and `import`.
  //
  // It was a REGRESSION, which is why nobody was watching for it: the
  // published 0.1.6 bundle required api-types ZERO times at runtime (the SDK
  // used only its types), so CJS worked for customers. The first 0.2.0 build
  // pulled real VALUES across — schemas and constants — and had five requires.
  //
  // ✅ CLOSED by bundling api-types into both outputs (tsup `noExternal`), so
  // the only bare specifier either bundle names at runtime is `zod`, which
  // ships a real `require` condition. This arm stays because it is the thing
  // that would notice the next time a runtime dependency arrives without one.
  //
  // It is a STATIC arm and it is deliberately not the only one: reading the
  // bundle cannot prove the file loads. `the-published-sdk-loads-under-
  // require-and-import` runs the real `require()` in a child process.
  it('CRITICAL every runtime dependency of the CJS bundle can actually be resolved by require(), so the .cjs entry point is loadable and not merely declared', () => {
    const cjs = resolve(REPO_ROOT, 'packages/sdk-typescript/dist/index.cjs');
    expect(
      existsSync(cjs),
      'packages/sdk-typescript/dist is not built, and an unbuilt dist makes this arm ' +
        'vacuous rather than failing. Run `npm run build -w packages/sdk-typescript`.',
    ).toBe(true);

    const required = bareRequiresOf(read(cjs));
    // A floor, so an extraction that silently matched nothing cannot pass as
    // "every dependency resolves".
    expect(
      required.length,
      'no bare require() was extracted from dist/index.cjs — the regex, not the bundle',
    ).toBeGreaterThan(0);

    // Every bare specifier the bundle requires is a declared dependency, so its
    // manifest is THERE. Skipping a missing one would hide the case this arm is
    // for — a dependency that cannot be resolved at all reads as "nothing to
    // check" — which is what a-walk-that-swallows-a-missing-root-does-not-spread
    // holds to zero.
    for (const spec of required) {
      if (spec.startsWith('node:')) continue;
      const depManifest = resolve(REPO_ROOT, 'node_modules', spec, 'package.json');
      expect(
        existsSync(depManifest),
        `packages/sdk-typescript/dist/index.cjs reaches for "${spec}" at runtime (require or import), ` +
          `but ${spec} is not installed — require('@driftstack/sdk') cannot resolve it either.`,
      ).toBe(true);
      const dep = JSON.parse(read(depManifest)) as {
        exports?: Record<string, Record<string, string>> | string;
      };
      expect(
        requireConditionFor(dep.exports),
        `packages/sdk-typescript/dist/index.cjs reaches for "${spec}" at runtime (require or import), ` +
          `but ${spec}'s exports map has no \`require\` (or \`default\`) condition for ".", so ` +
          `\`require("@driftstack/sdk")\` throws ERR_PACKAGE_PATH_NOT_EXPORTED on a clean ` +
          `install. Either give ${spec} a CJS entry, or stop pulling runtime VALUES from it ` +
          `into the bundle, or drop the CJS build and the \`require\` condition with it.`,
      ).toBe(true);
    }
  });

  // Without this, the arm above is satisfied by a helper that returns true for
  // everything — and "every dependency resolves" is exactly the claim that also
  // passes when nothing is ever checked.
  it('NEGATIVE CONTROL the require-condition check tells a dual-entry exports map from an import-only one, and the roster it walks is not empty', () => {
    expect(requireConditionFor({ '.': { types: './d.ts', import: './i.js' } })).toBe(false);
    expect(
      requireConditionFor({ '.': { types: './d.ts', import: './i.js', require: './r.cjs' } }),
    ).toBe(true);
    expect(requireConditionFor({ '.': { default: './i.js' } })).toBe(true);
    expect(requireConditionFor('./index.js')).toBe(true);
    expect(requireConditionFor(undefined)).toBe(true);

    // ⛔ THE HALF THAT MATTERS NOW. The arm above went green by making the
    // bundle hermetic, and "every bare require resolves" is also what an EMPTY
    // roster reports. So the roster is asserted here: the CJS bundle really
    // does require something, and that something is the declared dependency.
    const cjs = resolve(REPO_ROOT, 'packages/sdk-typescript/dist/index.cjs');
    expect(existsSync(cjs), 'packages/sdk-typescript/dist is not built').toBe(true);
    const bare = bareRequiresOf(read(cjs));
    expect(
      bare,
      'the CJS bundle requires nothing at all — the arm above walks an empty list',
    ).toEqual(['zod']);

    // ...and the reader that produced that roster can SEE the forms a bundle
    // uses. A require-only reader returned ['zod'] here too, while missing the
    // `await import("crypto")` that is really in this file — so ['zod'] on its
    // own does not establish that the roster is complete.
    expect(
      bareRequiresOf('const m = await import("left-pad");'),
      'a lazily-imported package is invisible to bareRequiresOf',
    ).toEqual(['left-pad']);
    expect(
      bareRequiresOf('await import("crypto"); require("node:fs"); require("./x.js");'),
      'bareRequiresOf reports a builtin or a relative path as a package to install',
    ).toEqual([]);

    // And the check is still capable of returning false for a REAL package:
    // api-types is import-only, so if it ever came back into the bundle as a
    // runtime require, the arm above would fail rather than pass quietly.
    const apiTypes = JSON.parse(read(resolve(REPO_ROOT, 'packages/api-types/package.json'))) as {
      exports?: Record<string, Record<string, string>>;
    };
    expect(
      requireConditionFor(apiTypes.exports),
      'api-types grew a require condition — this half no longer proves the check can return false; point it at another import-only package or delete it',
    ).toBe(false);
    const zod = JSON.parse(read(resolve(REPO_ROOT, 'node_modules/zod/package.json'))) as {
      exports?: Record<string, Record<string, string>>;
    };
    expect(requireConditionFor(zod.exports), 'zod lost its require condition').toBe(true);
  });
});

/**
 * Every BARE specifier `text` resolves at runtime, deduplicated, node builtins
 * excluded. Bare means "resolved from node_modules" — a relative or absolute
 * path is the bundle's own business.
 *
 * ⛔ `import(…)` COUNTS, not just `require(…)`. A CJS bundle reaches for a
 * package either way, and both hit the customer's node_modules. Measured
 * 2026-09-20: dist/index.cjs contains `await import("crypto")`, which a
 * require-only reader does not see at all — so the roster it returns for a
 * bundle with a lazily-loaded dependency is the same empty list it returns for
 * a hermetic one, and the arms below would walk it and pass.
 *
 * ⛔ A BUILTIN IS ONE OF `builtinModules`, not a `node:` prefix — the bare
 * `crypto` above carries no prefix and npm cannot install it.
 */
function bareRequiresOf(text: string): string[] {
  const builtins = new Set(builtinModules);
  const out = new Set<string>();
  for (const m of text.matchAll(/(?:require\(|import\(|from\s*)\s*["']([^"']+)["']/gu)) {
    const spec = m[1];
    if (spec === undefined || spec.startsWith('.') || spec.startsWith('/')) continue;
    const root = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0];
    if (root === undefined || builtins.has(root) || root.startsWith('node:')) continue;
    out.add(root);
  }
  return [...out].sort();
}

/**
 * Whether `require()` can resolve this package's "." entry.
 *
 * No `exports` at all, or a string `exports`, means the legacy `main` field
 * decides and require works. An object map must offer `require` or `default`
 * for "." — `import` alone is invisible to require() and resolution fails
 * outright rather than falling back.
 */
function requireConditionFor(
  exports: Record<string, Record<string, string>> | string | undefined,
): boolean {
  if (exports === undefined || typeof exports === 'string') return true;
  const dot = exports['.'];
  if (dot === undefined || typeof dot === 'string') return true;
  return 'require' in dot || 'default' in dot;
}
