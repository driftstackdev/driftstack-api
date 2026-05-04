import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: false,
    environment: 'node',
    include: ['apps/**/tests/**/*.test.ts', 'packages/**/tests/**/*.test.ts'],
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/e2e/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
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
        'apps/server/src/dump-openapi.ts', // CLI tool
      ],
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
  benchmark: {
    // V-120: bench files run via `npm run bench`. Excluded from the
    // standard `npm test` `include` glob above so unit tests stay fast.
    include: ['apps/**/tests/bench/**/*.bench.ts', 'packages/**/tests/bench/**/*.bench.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
