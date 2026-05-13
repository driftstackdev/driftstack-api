// W530.B — drift guard for apps/server/tsconfig.json.
// Inherits from /tsconfig.base.json — pins server-specific overrides
// + project-reference wiring to @driftstack/api-types. Drift here
// either breaks the project-reference build chain (would force api-
// types re-compilation on every server tsc invocation) or changes the
// rootDir/outDir layout (would break tsc-built dist artefact paths).
//
//   • extends: ../../tsconfig.base.json (inherits strict-mode + Node-
//     ESM compat).
//   • rootDir: src + outDir: dist.
//   • composite: true (project-reference mode).
//   • tsBuildInfoFile: dist/.tsbuildinfo (incremental build cache).
//   • include: src/**/* + exclude: dist + node_modules + tests.
//   • references: ../../packages/api-types (consumes api-types via
//     project references so cross-package tsc --build works).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'apps/server/tsconfig.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W530.B apps/server/tsconfig.json content parity', () => {
  const body = read(LIB);
  const json = JSON.parse(body) as {
    extends: string;
    compilerOptions: Record<string, unknown>;
    include: string[];
    exclude: string[];
    references: Array<{ path: string }>;
  };

  it("extends + composite-build framing pinned: 'extends: \"../../tsconfig.base.json\"' (inherits strict-mode + 8-flag suite + Node-ESM compat from workspace base) + 'composite: true' (enables project-reference build) + 'tsBuildInfoFile: \"dist/.tsbuildinfo\"' (incremental build cache location) — pinned so the inherits-base + project-reference-composite + incremental-build-cache commitment survives (drift to dropping composite would break `tsc --build` propagation from api-types)", () => {
    expect(json.extends).toBe('../../tsconfig.base.json');
    expect(json.compilerOptions.composite).toBe(true);
    expect(json.compilerOptions.tsBuildInfoFile).toBe('dist/.tsbuildinfo');
  });

  it('rootDir + outDir layout framing pinned: \'rootDir: "src"\' + \'outDir: "dist"\' + \'include: ["src/**/*"]\' + \'exclude: ["dist", "node_modules", "tests"]\' — pinned so the src→dist compile layout + 3-exclude (dist + node_modules + tests-out-of-scope-for-build) commitment survives (drift to including tests in build output would bloat the prod dist; drift to a different outDir would break main:dist/index.js wiring in package.json)', () => {
    expect(json.compilerOptions.rootDir).toBe('src');
    expect(json.compilerOptions.outDir).toBe('dist');
    expect(json.include).toEqual(['src/**/*']);
    expect(json.exclude).toEqual(['dist', 'node_modules', 'tests']);
  });

  it('references → api-types framing pinned: \'references: [{ path: "../../packages/api-types" }]\' — pinned so the project-reference dependency on @driftstack/api-types (lets tsc --build propagate api-types changes before recompiling server) commitment survives (drift to dropping this reference would let server tsc skip api-types rebuild on dirty cache, leaking stale generated types into the server)', () => {
    expect(json.references).toEqual([{ path: '../../packages/api-types' }]);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
