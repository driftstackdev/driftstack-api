import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: 'node',
    globals: false,
    environment: 'node',
    include: [
      'apps/**/tests/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
      'scripts/tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', '**/tests/e2e/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
  benchmark: {
    // V-120: bench files run via `npm run bench`. Excluded from the
    // standard `npm test` `include` glob above so unit tests stay fast.
    include: ['apps/**/tests/bench/**/*.bench.ts', 'packages/**/tests/bench/**/*.bench.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
  },
});
