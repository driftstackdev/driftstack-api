import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Vitest resolves plain project strings against process.cwd(), which is
    // apps/server when invoked through that workspace. Anchor both configs to
    // this file so root, workspace, IDE, and CI entry points run the same suite.
    projects: [
      fileURLToPath(new URL('./vitest.node.config.ts', import.meta.url)),
      fileURLToPath(new URL('./apps/gui-client/vitest.config.ts', import.meta.url)),
    ],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'html'],
      // Coverage scope: the meaningfully unit-/integration-tested
      // surfaces only. Excludes:
      //   - Drizzle repos (`apps/server/src/db/`) — exercised by e2e
      //     against real Postgres, not by vitest. V-086 audit captures
      //     this architectural choice.
      //   - api-types schemas — Zod runtime, no .test.ts imports.
      //   - Astro apps (marketing-site, customer-dashboard) — typechecked
      //     by `astro check`, not under vitest scope.
      //   - GUI client (Tauri) — not in scope.
      //   - Generated code (sdk-python's _generated/, sdk-go).
      include: ['apps/server/src/**/*.ts', 'packages/sdk-typescript/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/tests/**',
        'apps/server/src/db/**', // Drizzle repos — e2e only
        'apps/server/src/index.ts', // bootstrap entry
        'apps/server/src/lib/dump-openapi.ts', // CLI tool
      ],
      // Vitest 4's V8 provider remaps instrumented paths after the initial
      // include/exclude pass. Re-apply exclusions so generated/bootstrap
      // sources cannot leak back into the report after source-map remapping.
      excludeAfterRemap: true,
      // V-107: regression gate, not aspirational target. Thresholds are
      // set ~5% below current baseline so a meaningful drop fails CI but
      // small noise doesn't false-positive. Ratchet upward as coverage
      // improves; never ratchet downward to mask a regression.
      thresholds: {
        lines: 80,
        statements: 80,
        functions: 80,
        branches: 75,
      },
    },
  },
});
