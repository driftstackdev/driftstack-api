// W533.B — drift guard for packages/recapture-automation/package.json.
// Internal Phase-3+ recapture-automation interface + mock package.
// V-115 anchored. Drift here either changes the V-115 anchor + iOS-
// minor-version trigger framing (would create runbook divergence on
// when recapture fires) or breaks the interface-vs-implementation
// separation (Phase-3+ ships the implementation separately).
//
//   • Name: @driftstack/recapture-automation.
//   • description: 'Recapture automation interface + mock implementation.
//     Triggers fingerprint-reference-set revalidation when iOS minor
//     version bumps. Phase 3+ workstream (file 115).'.
//   • license: UNLICENSED (internal — drift to MIT would flag the
//     package as publishable).
//   • private: true + type: module.
//   • Standard interface-package shape: dist/index.js + .d.ts + ESM-
//     only exports + 2-file publish-allowlist + 2 tsc-build scripts +
//     typescript-only devDep, zero runtime deps.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/recapture-automation/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W533.B packages/recapture-automation/package.json content parity', () => {
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

  it("Identity + V-115 iOS-minor-version trigger framing pinned: 'name: @driftstack/recapture-automation' + 'description: \"Recapture automation interface + mock implementation. Triggers fingerprint-reference-set revalidation when iOS minor version bumps. Phase 3+ workstream (file 115).\"' + 'license: UNLICENSED' + 'private: true' + 'type: module' — pinned so the iOS-minor-version-trigger + fingerprint-reference-set-revalidation + Phase-3+-workstream-file-115 anchor + UNLICENSED-internal commitment survives (drift to changing the trigger from iOS-minor-bump to any other event would break the recapture runbook commitment)", () => {
    expect(pkg.name).toBe('@driftstack/recapture-automation');
    expect(pkg.description).toBe(
      'Recapture automation interface + mock implementation. Triggers fingerprint-reference-set revalidation when iOS minor version bumps. Phase 3+ workstream (file 115).',
    );
    expect(pkg.license).toBe('UNLICENSED');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });

  it("Standard interface-package dist+exports+files framing pinned: 'main: dist/index.js' + 'types: dist/index.d.ts' + 'exports.\".\".types: ./dist/index.d.ts + .import: ./dist/index.js' (pure ESM) + 'files: [\"dist\", \"README.md\"]' — pinned so the standard internal-interface-package shape commitment survives (parity with @driftstack/behavioural-simulation + @driftstack/webhook-delivery)", () => {
    expect(pkg.main).toBe('dist/index.js');
    expect(pkg.types).toBe('dist/index.d.ts');
    expect(pkg.exports['.']).toEqual({
      types: './dist/index.d.ts',
      import: './dist/index.js',
    });
    expect(pkg.files).toEqual(['dist', 'README.md']);
  });

  it("Scripts + zero-runtime-dep framing pinned: 'build: tsc --build' + 'typecheck: tsc --build' + devDependencies typescript only + NO runtime dependencies (pure-interface package) — pinned so the 2-script tsc-build pipeline + zero-runtime-dep commitment survives (parity with the other internal-interface packages)", () => {
    expect(pkg.scripts.build).toBe('tsc --build');
    expect(pkg.scripts.typecheck).toBe('tsc --build');
    expect(pkg.devDependencies).toEqual({ typescript: '^5.7.0' });
    expect(pkg.dependencies).toBeUndefined();
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
