// W531.C — drift guard for packages/sdk-typescript/tsup.config.ts.
// SDK bundler config. Drift here either changes the dual ESM+CJS output
// format (would break the package.json exports map promised in W531.B) or
// un-bundles @driftstack/api-types (which is what broke
// `require('@driftstack/sdk')` in the 0.2.0 preparation).
//
//   • entry: ['src/index.ts'] (single barrel entry).
//   • format: ['esm', 'cjs'] (dual output to match package.json
//     exports map).
//   • dts: { resolve: true } — INLINE the api-types declarations, so the
//     published types stand alone and do not depend on whichever api-types
//     a consumer's install resolves.
//   • splitting: false (single bundle per format — no chunk
//     fragmentation in published artefact).
//   • sourcemap: true.
//   • clean: true (clean dist before each build).
//   • target: node18 (matches package.json engines.node>=18).
//   • noExternal: ['@driftstack/api-types'] — BUNDLED, deliberately.
//   • external: ['zod'] — a declared runtime dependency, shared.
//
// ⛔ THIS GUARD USED TO PIN THE OPPOSITE, and the reason it gave was real but
// incomplete. It pinned `external: ['@driftstack/api-types']` "so consumers
// resolve their own copy, prevents Zod-instance duplication". api-types is
// ESM-only — its exports map offers `types` and `import` and nothing else — so
// leaving it external put `require("@driftstack/api-types")` into
// dist/index.cjs, and on a clean install `require('@driftstack/sdk')` threw
// ERR_PACKAGE_PATH_NOT_EXPORTED. Measured 2026-09-20 on the packed tarballs,
// and a REGRESSION: the published 0.1.6 bundle required api-types zero times.
//
// The instanceof concern the old header named is answered by `external:
// ['zod']`, not by keeping api-types external: zod is the package whose
// identity `instanceof` tests. One shared zod means a schema this bundle
// carries and a schema from a consumer's own @driftstack/api-types both
// produce the same ZodError class, so `err instanceof z.ZodError` still holds
// across the boundary. Duplicate COPIES of the schema objects themselves are
// value-equal and are not compared by identity anywhere in the public surface.

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

  it("dts-resolve + splitting + sourcemap + clean framing pinned: 'dts: { resolve: true }' (INLINE the api-types declarations so the published .d.ts stands alone — `dts: true` emits `from '@driftstack/api-types'` instead, which makes the SDK's types only as good as whatever api-types a consumer resolves) + 'splitting: false' (single bundle per format, no chunk fragmentation) + 'sourcemap: true' (consumers get debuggable maps) + 'clean: true' (clean dist before each build, prevents stale-output leakage) — pinned so the standalone-types + no-splitting + sourcemap + pre-build-clean commitment survives", () => {
    expect(body).toMatch(/dts: \{ resolve: true \},/);
    expect(body).toMatch(/splitting: false,/);
    expect(body).toMatch(/sourcemap: true,/);
    expect(body).toMatch(/clean: true,/);
  });

  it('target + noExternal framing pinned: \'target: "node18"\' (matches package.json engines.node>=18) + the ⛔ THE SDK IS HERMETIC AT RUNTIME framing comment naming ERR_PACKAGE_PATH_NOT_EXPORTED + \'noExternal: ["@driftstack/api-types"]\' — pinned so the api-types-is-BUNDLED commitment survives. Drift back to `external` reinstates `require("@driftstack/api-types")` in dist/index.cjs, and api-types being ESM-only makes `require(\'@driftstack/sdk\')` throw on a clean install — the 0.2.0 regression this replaced', () => {
    expect(body).toMatch(/target: 'node18',/);
    expect(body).toMatch(/⛔ THE SDK IS HERMETIC AT RUNTIME\./);
    expect(body).toMatch(/ERR_PACKAGE_PATH_NOT_EXPORTED/);
    expect(body).toMatch(/noExternal: \['@driftstack\/api-types'\],/);
    expect(body, 'api-types is bundled — it must not also be listed as external').not.toMatch(
      /external: \[[^\]]*@driftstack\/api-types/,
    );
  });

  it('zod-stays-external framing pinned: \'external: ["zod"]\' plus the measured reason — zod 3.25.x ships BOTH an `import` and a `require` condition and declares no `engines`, so one shared copy loads in both formats on Node 18, 20 and 22, and `err instanceof z.ZodError` keeps holding across the SDK/api-types boundary. Bundling it instead measured +132 KB (ESM) and +120 KB (CJS) and gave every consumer a second zod instance — pinned so the shared-zod commitment survives', () => {
    expect(body).toMatch(/⛔ zod STAYS EXTERNAL and is a declared runtime `dependency`\./);
    expect(body).toMatch(/require: \.\/index\.cjs/);
    expect(body).toMatch(/external: \['zod'\],/);
  });

  it('file exists at canonical path', () => {
    expect(existsSync(LIB)).toBe(true);
  });
});
