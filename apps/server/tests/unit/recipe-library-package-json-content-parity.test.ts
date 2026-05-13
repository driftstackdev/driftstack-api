// W534.A — drift guard for packages/recipe-library/package.json.
// Internal Phase-3 recipe-catalogue interface + mock-runner package.
// Drift here either flips license:UNLICENSED to MIT (would risk
// accidentally publishing the internal interface) or breaks the
// recipe-catalogue + real-runner-behind-same-interface framing.
//
//   • Name: @driftstack/recipe-library.
//   • description: 'Recipe interface + mock runner. Phase 3 ships
//     the recipe catalogue + real runner behind the same interface.'.
//   • license: UNLICENSED + private: true + type: module.
//   • Standard internal-interface-package shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recipe-library/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W534.A packages/recipe-library/package.json content parity', () => {
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

  it("Identity + Phase-3 recipe-catalogue framing pinned: 'name: @driftstack/recipe-library' + 'description: \"Recipe interface + mock runner. Phase 3 ships the recipe catalogue + real runner behind the same interface.\"' + 'license: UNLICENSED' + 'private: true' + 'type: module' — pinned so the recipe-library-interface + Phase-3-ships-catalogue-and-real-runner-behind-same-interface + UNLICENSED-internal posture survives", () => {
    expect(pkg.name).toBe('@driftstack/recipe-library');
    expect(pkg.description).toBe(
      'Recipe interface + mock runner. Phase 3 ships the recipe catalogue + real runner behind the same interface.',
    );
    expect(pkg.license).toBe('UNLICENSED');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });

  it("Standard interface-package shape framing pinned: 'main: dist/index.js' + 'types: dist/index.d.ts' + 'exports.\".\".types: ./dist/index.d.ts + .import: ./dist/index.js' (pure ESM) + 'files: [\"dist\", \"README.md\"]' + 2-script tsc--build pipeline + typescript-only devDep + zero runtime deps — pinned so the standard internal-interface-package shape (parity with @driftstack/behavioural-simulation + @driftstack/recapture-automation + @driftstack/webhook-delivery + @driftstack/webrtc-streaming) commitment survives", () => {
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
    expect(pkg.files).toEqual(['dist', 'README.md']);
    expect(pkg.scripts.build).toBe('tsc --build');
    expect(pkg.scripts.typecheck).toBe('tsc --build');
    expect(pkg.devDependencies).toEqual({ typescript: '^5.7.0' });
    expect(pkg.dependencies).toBeUndefined();
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
