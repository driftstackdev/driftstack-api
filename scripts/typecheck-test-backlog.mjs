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
const BACKLOG = [
  { project: 'apps/gui-client/tsconfig.test.json', pinned: 96, minTestFiles: 200 },
  // W-12, 2026-08-26 — every `packages/*` suite was transpiled by vitest and
  // typechecked by NOTHING: each package's `tsconfig.json` includes only
  // `src/**/*`, and five of them additionally `exclude` tests. Measured at 50
  // errors across six packages, all inside test files, and drained to 0 before
  // these pins landed — so they are pinned at zero, which is the only pin that
  // cannot rot: any regression is a rise, and there is no downward drift to miss.
  { project: 'packages/api-types/tsconfig.test.json', pinned: 0, minTestFiles: 4 },
  { project: 'packages/behavioural-simulation/tsconfig.test.json', pinned: 0, minTestFiles: 10 },
  { project: 'packages/recapture-automation/tsconfig.test.json', pinned: 0, minTestFiles: 4 },
  { project: 'packages/recipe-library/tsconfig.test.json', pinned: 0, minTestFiles: 6 },
  { project: 'packages/webhook-delivery/tsconfig.test.json', pinned: 0, minTestFiles: 3 },
  { project: 'packages/webrtc-streaming/tsconfig.test.json', pinned: 0, minTestFiles: 4 },
];

const TSC = resolve(REPO_ROOT, 'node_modules/.bin/tsc');
let failed = false;

for (const { project, pinned, minTestFiles } of BACKLOG) {
  let out = '';
  try {
    // `--listFiles` on the SAME run, so the file census and the error count can
    // never describe different compilations. Captured on success too: a project
    // with zero errors exits 0, and the old code only read stdout from a throw.
    out = execFileSync(TSC, ['--noEmit', '--listFiles', '-p', project], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 64 * 1024 * 1024,
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
  // ⛔ A ZERO FROM A PROJECT THAT OPENED NO TEST FILE IS THE BEST-LOOKING
  // FAILURE THERE IS. `extends` inherits `exclude`, and an `include` cannot win
  // it back — so a test config that extends its sibling BUILD config inherits
  // `exclude: [... "tests"]`, compiles only `src`, and reports a confident 0.
  // That exact mistake produced a clean sweep across seven packages while
  // opening not one test file. The floor is what makes the 0 above mean
  // something.
  const dir = dirname(project);
  const testFiles = out.split('\n').filter((l) => l.includes(`/${dir}/tests/`)).length;
  if (minTestFiles !== undefined && testFiles < minTestFiles) {
    console.error(
      `✗ ${project}: compiled ${String(testFiles)} test files, expected at least ` +
        `${String(minTestFiles)}. The project is not reading its tests, so its ` +
        `error count describes nothing.`,
    );
    failed = true;
    continue;
  }

  const actual = [...out.matchAll(/error TS\d+/g)].length;
  if (actual === pinned) {
    console.log(
      `→ ${project}: ${String(actual)} type errors (pinned), ${String(testFiles)} test files compiled`,
    );
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
