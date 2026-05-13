// W531.B — drift guard for packages/sdk-typescript/package.json.
// Public TypeScript SDK manifest (@driftstack/sdk). Drift here either
// breaks dual ESM+CJS exports (would lose consumers stuck on CJS, e.g.
// Node < 22 with require()) or drops the api-types runtime dep (would
// break every typed API call).
//
//   • Name: @driftstack/sdk + 'Official TypeScript SDK for the
//     Driftstack API' description.
//   • Dual exports: main:.cjs + module:.js + types:.d.ts with .'
//     exports map for types+import+require triple.
//   • engines.node: >=18 (SDK supports older Node than the server's
//     >=22 to broaden consumer reach).
//   • 3 scripts: build (tsup) + typecheck (tsc --noEmit) + clean.
//   • Runtime dep: @driftstack/api-types ^0.1.0 (only — SDK re-uses
//     api-types Zod schemas verbatim).
//   • devDep: tsup (bundler) + @types/node.
//   • SEO keywords: driftstack + iphone + safari + automation +
//     stealth + browser.

import { existsSync, readFileSync } from 'node:fs';
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

  it('exports triple-form (types+import+require) framing pinned: \'exports.".".types: ./dist/index.d.ts + .import: ./dist/index.js + .require: ./dist/index.cjs\' — pinned so the modern exports-map (types-first for TS resolution, import for ESM, require for CJS) commitment survives (drift to dropping require: would break CJS consumers despite main:.cjs still being there — exports map takes precedence)', () => {
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
      require: './dist/index.cjs',
    });
  });

  it("engines + 3-script pipeline framing pinned: 'engines.node: >=18' (SDK supports older Node than server's >=22 to broaden consumer reach) + 'build: tsup' (tsup bundles dual ESM+CJS) + 'typecheck: tsc --noEmit -p tsconfig.json' + 'clean: rm -rf dist' — pinned so the Node-18-minimum (NOT 22 — SDK consumers may be on older runtimes) + 3-script pipeline commitment survives", () => {
    expect(pkg.engines.node).toBe('>=18');
    expect(pkg.scripts.build).toBe('tsup');
    expect(pkg.scripts.typecheck).toBe('tsc --noEmit -p tsconfig.json');
    expect(pkg.scripts.clean).toBe('rm -rf dist');
  });

  it('Single-runtime-dep + devDep + files-allowlist framing pinned: \'dependencies: { "@driftstack/api-types": "^0.1.0" }\' (SDK re-uses api-types verbatim — drift to adding zod or fetch as direct deps would duplicate api-types\' transitive zod) + \'devDependencies: tsup + @types/node\' + \'files: ["dist", "README.md"]\' (publish-clean) — pinned so the single-runtime-dep commitment survives', () => {
    expect(pkg.dependencies).toEqual({ '@driftstack/api-types': '^0.1.0' });
    expect(pkg.devDependencies).toHaveProperty('tsup');
    expect(pkg.devDependencies).toHaveProperty('@types/node');
    expect(pkg.files).toEqual(['dist', 'README.md']);
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
});
