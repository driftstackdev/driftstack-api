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
    // ⛔ Coverage is measured by NOTHING today, and the previous note here said
    // otherwise. It read "the root project's coverage report is the load-bearing
    // one" — but the root config's include is
    // `['apps/server/src/**', 'packages/sdk-typescript/src/**']`, with its own
    // comment listing "GUI client (Tauri) — not in scope". This app deferred to a
    // report that names it as excluded. Neither file was wrong alone; together
    // they left 177 source files measured by no gate while the config a reader
    // would check said it was handled elsewhere.
    //
    // Leaving `enabled: false` rather than switching it on: turning this into a
    // gate means thresholds to maintain and CI time to pay, which is a decision
    // somebody makes rather than one this comment makes for them. What changes is
    // that the reason is now true.
    //
    // ⚠️ Measured 2026-08-28 (first time): lines 84.71%, statements 81.62%,
    // functions 77.56%, branches 76.07%, over 258 test files / 2432 tests.
    //
    // ⛔ To reproduce, run from the REPO ROOT and name the test path:
    //     npx vitest run apps/gui-client/tests --coverage.enabled=true \
    //       --coverage.provider=v8 --coverage.include='apps/gui-client/src/**'
    // Running `vitest --coverage` from inside apps/gui-client collects only 176
    // files — this project's include is `.test.tsx` ONLY, and the 82 `.test.ts`
    // files run in the node project. That measures the whole source against
    // two-thirds of the tests and reports ~11 points low, which manufactures a
    // zero-coverage list of files whose tests simply did not run. It read
    // `lib/sanitize-ui-diagnostic.ts` — a credential redactor with its own
    // dedicated test file — as 0%.
    coverage: {
      enabled: false,
    },
  },
});
