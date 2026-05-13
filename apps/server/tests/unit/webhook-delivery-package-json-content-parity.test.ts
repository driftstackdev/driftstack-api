// W533.C — drift guard for packages/webhook-delivery/package.json.
// Internal webhook-delivery interface + mock package. Drift here
// either flips license:UNLICENSED to MIT (would risk accidentally
// publishing the internal interface — confusing for consumers because
// @driftstack/sdk handles outbound webhooks differently) or breaks
// the out-of-scope-domain-logic framing (the implementation lives in
// apps/server's webhook delivery worker, not in this package).
//
//   • Name: @driftstack/webhook-delivery.
//   • description: 'Webhook delivery system interface + mock
//     implementation. Out-of-scope domain logic ships separately and
//     slots into the same interface.'.
//   • license: UNLICENSED + private: true + type: module.
//   • Standard interface-package shape.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/webhook-delivery/package.json');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W533.C packages/webhook-delivery/package.json content parity', () => {
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

  it("Identity + out-of-scope-domain-logic framing pinned: 'name: @driftstack/webhook-delivery' + 'description: \"Webhook delivery system interface + mock implementation. Out-of-scope domain logic ships separately and slots into the same interface.\"' + 'license: UNLICENSED' + 'private: true' + 'type: module' — pinned so the webhook-delivery-interface + out-of-scope-domain-logic-ships-separately + UNLICENSED-internal posture survives (drift to MIT would flag the package as publishable; consumers might wrongly assume this is the outbound-webhook SDK surface)", () => {
    expect(pkg.name).toBe('@driftstack/webhook-delivery');
    expect(pkg.description).toBe(
      'Webhook delivery system interface + mock implementation. Out-of-scope domain logic ships separately and slots into the same interface.',
    );
    expect(pkg.license).toBe('UNLICENSED');
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe('module');
  });

  it("Standard interface-package shape framing pinned: 'main: dist/index.js' + 'types: dist/index.d.ts' + 'exports.\".\".types: ./dist/index.d.ts + .import: ./dist/index.js' + 'files: [\"dist\", \"README.md\"]' + 2-script tsc--build pipeline + typescript-only devDep + zero runtime deps — pinned so the standard internal-interface-package shape (parity with @driftstack/behavioural-simulation + @driftstack/recapture-automation) commitment survives", () => {
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
