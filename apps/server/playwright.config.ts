import { defineConfig } from '@playwright/test';

const isCi = !!process.env.CI;

export default defineConfig({
  testDir: './tests/e2e',
  testMatch: '**/*.spec.ts',
  // Single shared Postgres DB with truncate-between-tests; workers=1 to
  // serialise. Postgres enum types aren't schema-scoped, so per-worker
  // schema isolation doesn't work without per-worker databases (V-009).
  workers: 1,
  fullyParallel: false,
  retries: isCi ? 1 : 0,
  reporter: isCi ? [['list'], ['html', { open: 'never' }]] : 'list',
  timeout: 30_000,
  expect: { timeout: 5_000 },
  use: {
    extraHTTPHeaders: {
      'x-driftstack-test-suite': 'phase-8-e2e',
    },
  },
});
