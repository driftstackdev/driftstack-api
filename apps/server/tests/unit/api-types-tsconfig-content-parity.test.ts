// W532.A — drift guard for packages/api-types/tsconfig.json.
// Inherits workspace tsconfig.base.json + adds project-reference build
// settings. Identical structure to apps/server/tsconfig.json but with
// no references array (api-types has no upstream deps in the monorepo
// — it's a leaf of the dep graph).
//
//   • extends: ../../tsconfig.base.json.
//   • rootDir: src + outDir: dist.
//   • composite: true (other packages reference this via project refs).
//   • tsBuildInfoFile: dist/.tsbuildinfo.
//   • include: src/**/* + exclude: dist + node_modules.
//   • NO references array (api-types is a leaf dep — drift to adding
//     references would imply api-types depends on another monorepo
//     package, which would create a cycle).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/api-types/tsconfig.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W532.A packages/api-types/tsconfig.json content parity', () => {
  const body = read(LIB);
  const json = JSON.parse(body) as {
    extends: string;
    compilerOptions: Record<string, unknown>;
    include: string[];
    exclude: string[];
    references?: unknown[];
  };

  it("extends + composite framing pinned: 'extends: \"../../tsconfig.base.json\"' (inherits workspace strict-mode + Node-ESM compat) + 'composite: true' (other packages reference this via project refs — required so tsc --build can include this in the chain) + 'tsBuildInfoFile: \"dist/.tsbuildinfo\"' — pinned so the inherits-base + composite-for-project-refs + incremental-cache commitment survives", () => {
    expect(json.extends).toBe('../../tsconfig.base.json');
    expect(json.compilerOptions.composite).toBe(true);
    expect(json.compilerOptions.tsBuildInfoFile).toBe('dist/.tsbuildinfo');
  });

  it('rootDir + outDir + include + exclude framing pinned: \'rootDir: "src"\' + \'outDir: "dist"\' + \'include: ["src/**/*"]\' + \'exclude: ["dist", "node_modules"]\' (NO tests in exclude — api-types tests live in tests/ but the published shape is src/-only, so tests aren\'t in include either) — pinned so the src→dist compile layout commitment survives', () => {
    expect(json.compilerOptions.rootDir).toBe('src');
    expect(json.compilerOptions.outDir).toBe('dist');
    expect(json.include).toEqual(['src/**/*']);
    expect(json.exclude).toEqual(['dist', 'node_modules']);
  });

  it('Leaf-dep posture (no references) framing pinned: api-types is a leaf of the monorepo dep graph — drift to adding a `references` array would imply api-types depends on another monorepo package, creating a circular ref (server + SDK both depend on api-types, not vice versa) — pinned so the leaf-dep posture survives', () => {
    expect(json.references).toBeUndefined();
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
