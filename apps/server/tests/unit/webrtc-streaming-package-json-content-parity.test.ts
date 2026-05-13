// W534.B — drift guard for packages/webrtc-streaming/package.json.
// Internal WebRTC-streaming interface + mock package. Drift here
// either flips license:UNLICENSED to MIT (would risk accidentally
// publishing the internal interface) or breaks the v1-polling-vs-
// WebRTC scope framing (out-of-scope-for-first-iteration; may land
// inside the GUI workstream if scope allows, otherwise polling-based
// screenshots).
//
//   • Name: @driftstack/webrtc-streaming.
//   • description: 'WebRTC streaming layer interface + mock
//     implementation. Out-of-scope for the first iteration; may land
//     inside the GUI workstream if scope allows, otherwise polling-
//     based screenshots for v1.'.
//   • license: UNLICENSED + private: true + type: module.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webrtc-streaming/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W534.B packages/webrtc-streaming/package.json content parity', () => {
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

  it("Identity + v1-polling-vs-WebRTC scope framing pinned: 'name: @driftstack/webrtc-streaming' + 'description: \"WebRTC streaming layer interface + mock implementation. Out-of-scope for the first iteration; may land inside the GUI workstream if scope allows, otherwise polling-based screenshots for v1.\"' + 'license: UNLICENSED' + 'private: true' + 'type: module' — pinned so the WebRTC-out-of-scope-for-v1 + GUI-workstream-if-scope-allows + polling-fallback-otherwise + UNLICENSED-internal posture survives (drift to dropping the scope-fallback framing would lose the v1-shipping decision rationale)", () => {
    expect(pkg.name).toBe('@driftstack/webrtc-streaming');
    expect(pkg.description).toBe(
      'WebRTC streaming layer interface + mock implementation. Out-of-scope for the first iteration; may land inside the GUI workstream if scope allows, otherwise polling-based screenshots for v1.',
    );
    expect(pkg.license).toBe('UNLICENSED');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });

  it("Standard interface-package shape framing pinned: 'main: dist/index.js' + 'types: dist/index.d.ts' + 'exports.\".\".types: ./dist/index.d.ts + .import: ./dist/index.js' + 'files: [\"dist\", \"README.md\"]' + 2-script tsc--build pipeline + typescript-only devDep + zero runtime deps — pinned so the standard internal-interface-package shape (parity with the 4 other internal interface packages) commitment survives", () => {
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
