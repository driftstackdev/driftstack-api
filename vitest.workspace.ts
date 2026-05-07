// V-288 — Vitest workspace entry point.
//
// Two projects:
//   1. Root `vitest.config.ts` — node environment, covers
//      `apps/**/tests/**/*.test.ts` + `packages/**/tests/**/*.test.ts`.
//      Existing scope; unchanged.
//   2. `apps/gui-client/vitest.config.ts` — jsdom environment, covers
//      ONLY `apps/gui-client/tests/**/*.test.tsx`. Component +
//      hook-lifecycle tests live here; pure-function `.test.ts` files
//      in the same dir keep running in the node project.
//
// The .ts vs .tsx extension is the discriminator. No double-runs.

import { defineWorkspace } from 'vitest/config';

export default defineWorkspace(['./vitest.config.ts', './apps/gui-client/vitest.config.ts']);
