// W531.A — drift guard for packages/api-types/package.json.
// Public API contract types — Zod schemas shared across server +
// SDK + Astro apps. Drift here either changes the published API
// surface (would create cross-package version mismatches in
// consumers) or breaks the dist/index.js + .d.ts emission paths
// (would break import resolution in every consumer).
//
//   • Name: @driftstack/api-types.
//   • description: 'Public API contract types (Zod schemas) for the
//     Driftstack API.'.
//   • license: MIT, type: module.
//   • main: dist/index.js + types: dist/index.d.ts.
//   • exports.': dual types+import (ESM with TS types).
//   • files: dist + README.md (publish-clean — no source, no tests).
//   • publishConfig.access: public.
//   • repository.directory: packages/api-types (monorepo-aware npm
//     publish).
//   • 2 scripts: build (tsc --build) + typecheck (tsc --build).
//   • Single runtime dep: zod ^3.24.0 (Zod is the schema runtime).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W531.A packages/api-types/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    description: string;
    license: string;
    type: string;
    main: string;
    types: string;
    exports: Record<string, Record<string, string>>;
    files: string[];
    publishConfig: { access: string };
    repository: { type: string; url: string; directory: string };
    scripts: Record<string, string>;
    dependencies: Record<string, string>;
  };

  it("Package identity + dist-entry framing pinned: 'name: @driftstack/api-types' + 'description: \"Public API contract types (Zod schemas) for the Driftstack API.\"' + 'license: MIT' + 'type: module' + 'main: dist/index.js' + 'types: dist/index.d.ts' — pinned so the package-name + canonical Zod-schemas description + MIT license + ESM + dist-entry commitment survives", () => {
    expect(pkg.name).toBe('@driftstack/api-types');
    expect(pkg.description).toBe('Public API contract types (Zod schemas) for the Driftstack API.');
    expect(pkg.license).toBe('MIT');
    expect(pkg.type).toBe('module');
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
  });

  it('exports map + files publish framing pinned: \'exports.".".types: ./dist/index.d.ts + .import: ./dist/index.js\' (dual types+ESM, NO require-form — pure ESM publication) + \'files: ["dist", "README.md"]\' (publish-clean: no src, no tests, no tsconfig) — pinned so the pure-ESM exports + 2-file publish-allowlist commitment survives (drift to including src in files would publish source code; drift to adding a require: form would imply CJS support not actually built)', () => {
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
    expect(pkg.files).toEqual(['dist', 'README.md']);
  });

  it('publishConfig + repository.directory framing pinned: \'publishConfig.access: "public"\' + \'repository.type: "git"\' + \'repository.url: "git+https://github.com/driftstackdev/driftstack-api.git"\' + \'repository.directory: "packages/api-types"\' (monorepo-aware npm publish — npmjs.com points to the subdir, not the repo root) — pinned so the public-access + monorepo-directory commitment survives (drift to dropping publishConfig.access would default to private + 402 on publish; drift to dropping repository.directory would point npmjs.com to the repo root instead of this subdir)', () => {
    expect(pkg.publishConfig.access).toBe('public');
    expect(pkg.repository.type).toBe('git');
    expect(pkg.repository.url).toBe('git+https://github.com/driftstackdev/driftstack-api.git');
    expect(pkg.repository.directory).toBe('packages/api-types');
  });

  it("Scripts + single-dep framing pinned: 'build: tsc --build' (project-references aware) + 'typecheck: tsc --build' (same — build IS the typecheck for a Zod-schemas package) + dependencies.zod (only runtime dep — Zod IS the schema runtime, drift to adding any other runtime dep would bloat consumers) — pinned so the 2-script tsc--build pipeline + Zod-only-runtime-dep commitment survives", () => {
    expect(pkg.scripts.build).toBe('tsc --build');
    expect(pkg.scripts.typecheck).toBe('tsc --build');
    expect(pkg.dependencies).toHaveProperty('zod');
    expect(Object.keys(pkg.dependencies)).toEqual(['zod']);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
