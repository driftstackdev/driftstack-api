// W531.C — drift guard for packages/sdk-typescript/tsup.config.ts.
// SDK bundler config. Drift here either changes the dual ESM+CJS
// output format (would break the package.json exports map promised in
// W531.B) or bundles api-types into the SDK output (would duplicate
// the api-types Zod runtime in consumers who depend on both packages
// directly, causing instanceof-mismatch bugs).
//
//   • entry: ['src/index.ts'] (single barrel entry).
//   • format: ['esm', 'cjs'] (dual output to match package.json
//     exports map).
//   • dts: true (emit .d.ts).
//   • splitting: false (single bundle per format — no chunk
//     fragmentation in published artefact).
//   • sourcemap: true.
//   • clean: true (clean dist before each build).
//   • target: node18 (matches package.json engines.node>=18).
//   • external: ['@driftstack/api-types'] (peer dep — emit imports
//     as-is so consumers resolve their own copy, prevents Zod-instance
//     duplication).

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const LIB = resolve(REPO_ROOT, 'packages/sdk-typescript/tsup.config.ts');

function read(p: string): string {
  return readFileSync(p, 'utf8');
}

describe('W531.C packages/sdk-typescript/tsup.config.ts content parity', () => {
  const body = read(LIB);

  it('Tsup import + entry + dual-format framing pinned: \'import { defineConfig } from "tsup"\' + \'entry: ["src/index.ts"]\' (single barrel) + \'format: ["esm", "cjs"]\' — pinned so the tsup-driven build + single-entry-barrel + dual ESM+CJS output (matches package.json exports map) commitment survives (drift to dropping cjs format would break Node-CJS require() consumers; drift to multiple entry points would fragment the published surface)', () => {
    expect(body).toMatch(/import \{ defineConfig \} from 'tsup';/);
    expect(body).toMatch(/entry: \['src\/index\.ts'\],/);
    expect(body).toMatch(/format: \['esm', 'cjs'\],/);
  });

  it("dts + splitting + sourcemap + clean framing pinned: 'dts: true' (emit .d.ts so package.json types: works) + 'splitting: false' (single bundle per format, no chunk fragmentation) + 'sourcemap: true' (consumers get debuggable maps) + 'clean: true' (clean dist before each build, prevents stale-output leakage) — pinned so the .d.ts emission + no-splitting + sourcemap + pre-build-clean commitment survives", () => {
    expect(body).toMatch(/dts: true,/);
    expect(body).toMatch(/splitting: false,/);
    expect(body).toMatch(/sourcemap: true,/);
    expect(body).toMatch(/clean: true,/);
  });

  it("target + external framing pinned: 'target: \"node18\"' (matches package.json engines.node>=18) + 'Don't bundle peer / runtime deps — emit imports as-is so consumers can resolve their own copies (relevant for @driftstack/api-types when this package is published).' framing comment + 'external: [\"@driftstack/api-types\"]' — pinned so the node18-target + api-types-external-not-bundled (prevents Zod-instance duplication when both SDK + api-types are direct deps in a consumer) commitment survives (drift to bundling api-types would create instanceof-mismatch bugs in consumers who also depend on @driftstack/api-types directly)", () => {
    expect(body).toMatch(/target: 'node18',/);
    expect(body).toMatch(
      /\/\/ Don't bundle peer \/ runtime deps — emit imports as-is so consumers can\s*\/\/ resolve their own copies \(relevant for @driftstack\/api-types when this\s*\/\/ package is published\)\./,
    );
    expect(body).toMatch(/external: \['@driftstack\/api-types'\],/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
