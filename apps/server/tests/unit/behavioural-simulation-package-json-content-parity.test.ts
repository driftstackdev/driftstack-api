// W533.A — drift guard for packages/behavioural-simulation/package.json.
// Internal Phase-3 behavioural-simulation interface + mock package.
// Drift here either flips license:UNLICENSED to MIT (would risk
// accidentally publishing what's currently an internal-only interface)
// or breaks the interface-vs-implementation separation framing
// (Phase-3 ships the implementation separately, slotting into the
// same interface — the mock here is intentionally permanent for
// other packages to test against).
//
//   • Name: @driftstack/behavioural-simulation.
//   • description: 'Behavioural simulation interface + mock
//     implementation. Phase 3 domain logic ships separately and slots
//     into the same interface.'.
//   • license: UNLICENSED (internal — drift to MIT would flag the
//     package as publishable).
//   • private: true + type: module.
//   • main: dist/index.js + types: dist/index.d.ts.
//   • exports.': ESM with types.
//   • files: dist + README.md.
//   • 2 scripts: build + typecheck (both tsc --build).
//   • Sole devDep: typescript (no runtime deps — pure interface).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/behavioural-simulation/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W533.A packages/behavioural-simulation/package.json content parity', () => {
  const body = read(LIB);
  const pkg = JSON.parse(body) as {
    name: string;
    description: string;
    license: string;
    private: boolean;
    type: string;
    main: string;
    types: string;
    exports: Record<string, Record<string, string>>;
    files: string[];
    scripts: Record<string, string>;
    devDependencies: Record<string, string>;
    dependencies?: Record<string, string>;
  };

  it("Package identity + UNLICENSED-internal framing pinned: 'name: @driftstack/behavioural-simulation' + 'description: \"Behavioural simulation interface + mock implementation. Phase 3 domain logic ships separately and slots into the same interface.\"' + 'license: UNLICENSED' (internal — drift to MIT would flag the package as publishable) + 'private: true' + 'type: module' — pinned so the internal-Phase-3-interface + UNLICENSED + private commitment survives", () => {
    expect(pkg.name).toBe('@driftstack/behavioural-simulation');
    expect(pkg.description).toBe(
      'Behavioural simulation interface + mock implementation. Phase 3 domain logic ships separately and slots into the same interface.',
    );
    expect(pkg.license).toBe('UNLICENSED');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });

  it("dist-entry + exports + files framing pinned: 'main: dist/index.js' + 'types: dist/index.d.ts' + 'exports.\".\".types: ./dist/index.d.ts + .import: ./dist/index.js' (pure ESM, no require — internal package, no CJS consumers to worry about) + 'files: [\"dist\", \"README.md\"]' — pinned so the dist-entry + pure-ESM-exports + 2-file publish-allowlist commitment survives", () => {
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
    expect(pkg.files).toEqual(['dist', 'README.md']);
  });

  it("Scripts + zero-runtime-dep framing pinned: 'build: tsc --build' (project-references aware) + 'typecheck: tsc --build' (same — build IS typecheck for a pure-interface package) + devDependencies: typescript only + NO runtime dependencies (pure-interface package — drift to adding any runtime dep would imply the interface needs runtime code, breaking the interface-only contract) — pinned so the 2-script tsc-build pipeline + pure-interface zero-runtime-dep commitment survives", () => {
    expect(pkg.scripts.build).toBe('tsc --build');
    expect(pkg.scripts.typecheck).toBe('tsc --build');
    expect(pkg.devDependencies).toEqual({ typescript: '^5.7.0' });
    expect(pkg.dependencies).toBeUndefined();
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
