import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  // `resolve: true` INLINES the @driftstack/api-types declarations into
  // dist/index.d.ts and dist/index.d.cts, so the published types stand alone.
  // Without it the emitted `.d.ts` says `from '@driftstack/api-types'`, which
  // makes the SDK's types only as good as whatever api-types a consumer's
  // install resolves — the failure docs/runbooks/sdk-release.md records (166
  // tsc errors naming 110 missing types, from a stale api-types on npm).
  // Only `zod` is left external in the declarations, and it is a declared
  // runtime dependency, so it is always there.
  dts: { resolve: true },
  splitting: false,
  sourcemap: true,
  clean: true,
  target: 'node18',
  // ⛔ THE SDK IS HERMETIC AT RUNTIME. @driftstack/api-types is BUNDLED into
  // both outputs — `noExternal`, not `external`.
  //
  // Why: api-types is ESM-only (its exports map offers `types` and `import`
  // and nothing else). Leaving it external emitted
  // `require("@driftstack/api-types")` into dist/index.cjs, and on a clean
  // install `require('@driftstack/sdk')` then threw
  // ERR_PACKAGE_PATH_NOT_EXPORTED — measured on the packed tarballs, and a
  // REGRESSION: the published 0.1.6 bundle required api-types zero times.
  // Adding `"require": "./dist/index.js"` to api-types would NOT fix it: that
  // package is `type: module`, so require() of it throws ERR_REQUIRE_ESM on
  // Node 18 and 20, which this SDK's engines field still supports.
  //
  // Bundling it also means a customer never resolves api-types at all, so the
  // "publish api-types first" ordering can no longer break an SDK install.
  noExternal: ['@driftstack/api-types'],
  // ⛔ zod STAYS EXTERNAL and is a declared runtime `dependency`. Measured:
  // zod 3.25.x ships BOTH conditions (`import: ./index.js`,
  // `require: ./index.cjs`) and declares no `engines`, so both SDK formats
  // load it on Node 18, 20 and 22. Bundling it instead cost +132 KB (ESM) and
  // +120 KB (CJS) and gave every consumer a second zod instance, under which
  // `err instanceof z.ZodError` is false across the boundary.
  //
  // ⚠️ AND THE LIMIT OF THAT, measured on the packed tarball 2026-09-20: zod 3
  // is ITSELF a dual package — `zod/index.js` and `zod/index.cjs` are separate
  // builds with separate classes, so `(await import('zod')).ZodError !==
  // require('zod').ZodError` on 18, 20, 22 and 25 with one copy installed.
  // Externalising zod makes identity hold for a consumer who loads the SDK and
  // zod THE SAME WAY, which is every ordinary consumer; it cannot make it hold
  // for one who mixes `import` and `require`. Bundling zod would break the
  // ordinary case too, so this is still the better of the two — just not a
  // guarantee that survives mixed-mode loading.
  external: ['zod'],
});
