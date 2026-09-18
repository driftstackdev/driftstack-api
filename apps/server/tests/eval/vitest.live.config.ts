// The ONLY way the live tier's entry file is ever collected.
//
// ⛔ WHY THE LIVE TIER HAS ITS OWN CONFIG. It calls a real model and spends real
// money. While its entry file was named `*.test.ts` the default suite, the push
// gate and every broad `vitest run <filter>` COLLECTED it, and the only thing
// between those and a paid run was environment state — one half of which (the
// key) is already exported in an ordinary developer shell. That is not a
// hypothetical: a run meant to confirm the skip path made 43 provider calls.
// A README warning is prose, and prose does not stop a sweep.
//
// So the entry file is named `agent-eval-live.live.ts`, which no default include
// glob matches (`*.test.ts` everywhere), and this config is the one place that
// names it. Reaching it takes an explicit `--config` on the command line — a
// run-scoped act that a stale `export` cannot perform. `EVAL_LIVE_ENTRY` below is
// the belt to that pair of braces: `readLiveConfig` refuses without it, so even a
// config that one day collected the file by accident could not start a run.
//
// Run it with (the key already exported in the variable the product reads):
//   EVAL_LIVE=1 TMPDIR=/private/tmp/ds-gate npx vitest run --config apps/server/tests/eval/vitest.live.config.ts

import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Anchored to the repository root so the command works from any directory and
  // resolves workspace packages exactly as the default suite does.
  root: fileURLToPath(new URL('../../../..', import.meta.url)),
  test: {
    name: 'agent-eval-live',
    globals: false,
    environment: 'node',
    include: ['apps/server/tests/eval/agent-eval-live.live.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    // Must equal LIVE_ENTRY_MARKER in `_lib/live-config.ts`; the plumbing test
    // pins the two against each other.
    env: { EVAL_LIVE_ENTRY: 'vitest.live.config' },
    // The entry file sets its own (long) timeout; the spend cap bounds the run.
    testTimeout: 10_000,
    hookTimeout: 10_000,
  },
});
