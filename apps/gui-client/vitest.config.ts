// V-288 — Vitest project config for jsdom-needing GUI client tests.
//
// Scoped to `apps/gui-client/tests/**/*.test.tsx` (the .tsx extension
// is the discriminator). Pure-function `.test.ts` files in this dir
// continue to run in the root project's node environment — no DOM
// overhead for tests that don't need it.
//
// Registered by the root `vitest.config.ts` project list.

import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    name: 'gui-jsdom',
    environment: 'jsdom',
    include: ['tests/**/*.test.tsx'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    setupFiles: ['./tests/setup.ts'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    // Don't measure coverage from this project — the root project's
    // coverage report is the load-bearing one. Component-level
    // coverage is informational; if a feature gap surfaces, write the
    // test, don't gate on a separate threshold.
    coverage: {
      enabled: false,
    },
  },
});
