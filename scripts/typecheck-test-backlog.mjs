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
import { readdirSync, existsSync } from 'node:fs';
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
  // W-12, 2026-08-26 (second pass) — the packages sweep fixed the family in front
  // of it and never asked the same question one directory up. FIVE apps drive
  // their typecheck through `astro check`, whose tsconfig `include` is
  // `src/**/*`: a blatant type error in a test file does NOT fail
  // `npm run typecheck` for that workspace. Proved by mutation rather than by
  // reading config — baseline exit 0, mutated exit 0 — because a config can look
  // like it covers tests and not.
  //
  // 290 errors across 502 test files, pinned where they stand so the debt is
  // visible and two-sided rather than drained in one sitting.
  //
  // ⚠️ The floors below were FIRST set from a grep of `--listFiles` for
  // `apps/X/tests` — no leading slash — which counts 151 for admin-panel where
  // 57 files exist. The floor arm rejected its own author's numbers, which is
  // the best evidence it works. They are now the on-disk counts with margin:
  // 57 / 146 / 96 / 191 / 12.
  { project: 'apps/admin-panel/tsconfig.test.json', pinned: 94, minTestFiles: 50 },
  { project: 'apps/customer-dashboard/tsconfig.test.json', pinned: 168, minTestFiles: 140 },
  { project: 'apps/docs/tsconfig.test.json', pinned: 12, minTestFiles: 90 },
  { project: 'apps/marketing-site/tsconfig.test.json', pinned: 16, minTestFiles: 180 },
  { project: 'apps/status-site/tsconfig.test.json', pinned: 0, minTestFiles: 10 },
];

/**
 * Workspaces with tests that BACKLOG deliberately omits, and why.
 *
 * ⛔ Exists because a hand-written project list cannot report what is missing
 * from it. The packages sweep listed six projects, was correct about all six,
 * and was blind to five apps carrying 290 errors — the list had no way to say
 * "and there is a whole family I never considered". The derivation below closes
 * that; this map is what keeps the derivation honest instead of noisy.
 */
const NOT_IN_BACKLOG = new Map([
  [
    'apps/server',
    'covered by `the-server-source-type-checks`, which runs tsconfig.test.json inside the suite and asserts the program actually loaded',
  ],
  [
    'apps/gui-client',
    'IS in BACKLOG — listed here only so the derivation below can assert this map and BACKLOG are disjoint',
  ],
  [
    'packages/sdk-typescript',
    'its own tsconfig.json already includes tests/**/* and it declares a `typecheck` script, so `npm run typecheck --workspaces` covers it in pre-push. Proved at the GATE: a type error in tests/unit/errors.test.ts takes `npm run typecheck` from exit 0 to exit 2',
  ],
  ['packages/sdk-python', 'Python. mypy/pytest territory, not tsc'],
]);

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

// ⛔ DERIVE the population, do not trust the list above to be complete.
//
// A workspace with tests and no entry anywhere is exactly the shape that hid
// five apps: every listed project passed, and nothing was able to say that a
// whole family was unlisted. A new workspace joins BELOW every threshold this
// script enforces — it has no pin to exceed and no floor to fall under — so no
// existing arm can see it. This is the arm that can.
// ⛔ NO try/catch AROUND THE ROOT READ, and no `continue` on failure.
//
// This originally swallowed a missing root and moved on, which is the shape that
// turns a broken checkout into a SMALLER census that passes. `apps/` and
// `packages/` are structural: if either cannot be read, the honest outcome is a
// loud failure, not a derivation that quietly covers half the repo and reports
// "all pinned or exempted". The per-workspace `tests/` check below IS optional
// and stays a `continue` — that one is a real absence, not a broken root.
//
// A per-root floor rather than a combined one, and the distinction matters: with
// ~7 workspaces under `apps` and ~8 under `packages`, a COMBINED floor still
// clears if one root vanishes entirely, because the survivor alone exceeds any
// threshold worth setting. The likelier accident is exactly that — one root
// renamed or unmounted — so the floor has to be per root to see it.
const workspacesWithTests = [];
const perRoot = {};
for (const root of ['apps', 'packages']) {
  const entries = readdirSync(resolve(REPO_ROOT, root), { withFileTypes: true });
  perRoot[root] = 0;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!existsSync(resolve(REPO_ROOT, root, e.name, 'tests'))) continue;
    workspacesWithTests.push(`${root}/${e.name}`);
    perRoot[root] += 1;
  }
  if (perRoot[root] === 0) {
    console.error(
      `✗ ${root}/ yielded ZERO workspaces with tests. That is a broken checkout, ` +
        `not a clean repo — the census below would otherwise report the survivors ` +
        `as the whole population.`,
    );
    failed = true;
  }
}

const backlogWorkspaces = new Set(BACKLOG.map(({ project }) => dirname(project)));
const unaccounted = workspacesWithTests
  .filter((w) => !backlogWorkspaces.has(w) && !NOT_IN_BACKLOG.has(w))
  .sort();

if (unaccounted.length > 0) {
  failed = true;
  console.error(
    `✗ ${String(unaccounted.length)} workspace(s) have tests and are neither pinned nor ` +
      `exempted, so nothing typechecks them and nothing says so:\n` +
      unaccounted.map((w) => `    ${w}`).join('\n') +
      `\n  Add a tsconfig.test.json + a BACKLOG entry, or a NOT_IN_BACKLOG reason.`,
  );
} else {
  console.log(
    `→ ${String(workspacesWithTests.length)} workspaces with tests: all pinned or exempted`,
  );
}

process.exit(failed ? 1 : 0);
