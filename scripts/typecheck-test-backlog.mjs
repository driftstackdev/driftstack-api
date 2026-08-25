#!/usr/bin/env node
// W-12 — typecheck the test files that no tsconfig used to cover, and ratchet
// the inherited backlog downward.
//
// ⛔ WHY THIS IS A SCRIPT AND NOT A VITEST GUARD. It was a vitest guard first,
// and that was wrong: it spawns a FULL COMPILER inside a runner that is already
// saturating every core. Standalone the compile is ~5s; inside the suite it
// took 31s, blew the 10s default timeout, and — once given a longer budget —
// held the CPU long enough to push a NEIGHBOURING guard
// (`a-workspace-declares-what-its-source-imports`) past its own default. Suite
// duration went 254s -> 507s. A check that makes unrelated tests fail is not a
// check, it is a source of noise that teaches people to ignore red.
//
// Typechecking belongs in the typecheck step. pre-push already exists for
// exactly this class of project-wide check, and its own header names
// `tsconfig.test.json`.

import { execFileSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Workspaces whose tests are typechecked, and the backlog each still carries.
 *
 * ⛔ A RATCHET, not a target: it fails in BOTH directions. Upward means new type
 * errors were added to tests. DOWNWARD means someone fixed some and must lower
 * the number in the same change — so the pin cannot quietly drift away from
 * reality the way a one-sided `<=` does.
 *
 * The gui-client 257 are not 257 distinct defects. Measured by class:
 *   ~137  untyped `vi.fn()` mocks — `.mock.calls` is `[][]`, so indexing it is
 *         TS2493/TS2352. One root cause; a typing artifact, not a bug.
 *    ~31  fixtures omitting a REQUIRED property (TS2741/TS2739). Some are real
 *         (`can_route`, which `isProxyUsable` reads, so the "healthy" fixture
 *         silently tested the UNHEALTHY path) and some are benign
 *         (`profiles-meta` omits `icon`; the code defaults it). ⚠️ The class
 *         cannot be judged from the error code — each needs its call site read.
 *    ~89  argument/assignment mismatches.
 */
const BACKLOG = [{ project: 'apps/gui-client/tsconfig.test.json', pinned: 167 }];

const TSC = resolve(REPO_ROOT, 'node_modules/.bin/tsc');
let failed = false;

for (const { project, pinned } of BACKLOG) {
  let out = '';
  try {
    execFileSync(TSC, ['--noEmit', '-p', project], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    });
  } catch (err) {
    out = `${err.stdout ?? ''}${err.stderr ?? ''}`;
    // ⛔ An empty output on a non-zero exit means tsc did not RUN. Counting that
    // as zero errors would report the healthiest possible result at the exact
    // moment the instrument is broken.
    if (out.trim() === '') {
      console.error(`✗ ${project}: tsc produced no output — it did not run`);
      process.exit(1);
    }
  }
  const actual = [...out.matchAll(/error TS\d+/g)].length;
  if (actual === pinned) {
    console.log(`→ ${project}: ${String(actual)} known type errors (pinned)`);
    continue;
  }
  failed = true;
  console.error(
    actual > pinned
      ? `✗ ${project}: type errors rose to ${String(actual)} (pinned ${String(pinned)}).\n  npx tsc --noEmit -p ${project}`
      : `✗ ${project}: type errors fell to ${String(actual)} (pinned ${String(pinned)}).\n  Lower the pin in scripts/typecheck-test-backlog.mjs in this same change.`,
  );
}

process.exit(failed ? 1 : 0);
