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
      //   - Drizzle repos (`apps/server/src/db/`). The V-086 audit recorded
      //     this as "exercised by e2e against real Postgres, not by vitest",
      //     and that is NO LONGER TRUE: 66 integration files under
      //     apps/server/tests/integration import from `src/db/`, including the
      //     repos directly, and they run under vitest whenever DATABASE_URL is
      //     set. 53 source files are therefore excluded from the gate on a
      //     justification that has expired.
      //     Left in place rather than removed, because including them changes
      //     what the thresholds below mean and the new number is unmeasured —
      //     see A2-PRODUCTION-READINESS-ASSESSMENT item 5e. Correcting the
      //     reason is not the same as making the decision.
      //   - api-types schemas — Zod runtime, no .test.ts imports.
      //   - Astro apps (marketing-site, customer-dashboard) — typechecked
      //     by `astro check`, not under vitest scope.
      //   - GUI client (Tauri) — not in scope.
      //   - Generated code (sdk-python's _generated/, sdk-go).
      include: ['apps/server/src/**/*.ts', 'packages/sdk-typescript/src/**/*.ts'],
      exclude: [
        '**/*.test.ts',
        '**/tests/**',
        'apps/server/src/db/**', // Drizzle repos — justification expired, see note
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
      // Ratcheted 2026-08-10 to restore the policy stated above. Measured on
      // the full suite: lines 89.87, statements 88.16, functions 88.98,
      // branches 79.30. The old 80/80/80 sat 8-10 points below actual, so
      // coverage could fall by that much and still report green — a gate that
      // far under its baseline cannot fail on anything short of a collapse.
      // Each value is ~5 points under its own measurement, the margin this
      // file asks for. `branches: 75` was already at policy against 79.30.
      // The comment sits ABOVE the block because the content-parity pin
      // requires the four values consecutive.
      thresholds: {
        lines: 85,
        statements: 83,
        functions: 84,
        branches: 75,
      },
    },
  },
});
