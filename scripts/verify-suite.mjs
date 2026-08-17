#!/usr/bin/env node
// Runs the node test project and judges the RESULT, not just the exit code.
//
// Written because a suite run reported success while 89 tests never executed.
// It exited 0, printed `Tests 26677 passed`, and listed no failures — but nine
// test FILES were missing from the run, because their workers never started:
//
//   Error: [vitest-pool]: Failed to start forks worker for test files ...
//   Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond
//
// vitest reports that as an unhandled error, warns "This might cause false
// positive tests", and still exits 0. Under load — another agent on the same
// box had it at load average 32 — that is a green nobody should trust, and the
// usual check of "exit code plus the Tests line" cannot see it.
//
// Three things are checked, because each catches what the others miss:
//
//   1. exit code            — ordinary failures
//   2. unhandled errors     — workers that died or never started
//   3. FILE COUNT vs a pin  — files that silently did not run
//
// The file count is pinned rather than floored, deliberately, and follows the
// PATTERN_DIGEST convention already used for the commit-msg hook: a loose floor
// would not have caught this incident at all, because 2561 of 2570 files is a
// perfectly healthy-looking number. Fewer files than the pin is a failure;
// adding tests means raising the pin in the same commit, which is a one-line
// deliberate edit rather than a silent drift.

import { spawn, spawnSync } from 'node:child_process';

/** Files the node project is expected to collect. Raise when adding tests. */
export const EXPECTED_TEST_FILES = 2810;

/**
 * Files the ROOT config collects — every project, which is what CI runs.
 *
 * CI ran `npx vitest run --coverage` directly, so it inherited NONE of the
 * judgement below: vitest exits 0 on a run whose workers died, which is the
 * exact incident this file was written for. The count differs from the node
 * project's because the root config also collects the gui-client and app
 * projects. Raise when adding tests, same as the other pin.
 */
export const EXPECTED_TEST_FILES_ALL = 2972;

/**
 * Judge a completed vitest run.
 *
 * Pure so it can be tested against REAL captured output from a known-bad run
 * rather than a hand-written imitation of one.
 */
export function judge({ output, exitCode, expectedFiles = EXPECTED_TEST_FILES }) {
  const problems = [];

  if (exitCode !== 0) problems.push(`vitest exited ${String(exitCode)}`);

  const unhandled = /caught (\d+) unhandled error/i.exec(output);
  if (unhandled !== null) {
    problems.push(
      `${unhandled[1]} unhandled error(s) — workers that died or never started. ` +
        'vitest warns these "might cause false positive tests" and still exits 0.',
    );
  }

  // `Test Files  2570 passed | 63 skipped (2633)` — the parenthesised total is
  // the number COLLECTED, which is the number that drops when a worker fails.
  const files = /Test Files\s+.*\((\d+)\)/.exec(output);
  if (files === null) {
    problems.push('no "Test Files" summary line — the run did not complete');
  } else {
    const collected = Number(files[1]);
    if (collected < expectedFiles) {
      problems.push(
        `only ${String(collected)} test files collected, expected ${String(expectedFiles)} — ` +
          `${String(expectedFiles - collected)} file(s) did not run. A green run that ` +
          'skipped files reports the same "passed" line as a complete one.',
      );
    }
  }

  // Files vitest COLLECTED but did not execute. Legitimate — 56 files gate
  // themselves on `!process.env.CI && !process.env.DATABASE_URL` so a checkout
  // without Postgres still runs — but invisible in a way that matters: the
  // summary reports "2571 passed" either way, and a reader takes that as the
  // whole suite. Measured: with DATABASE_URL pointing at the local Postgres,
  // the same tree runs 2645 files and 27,066 tests instead of 2642 and 26,802.
  // That is 264 tests, and they are the ones locking the shipped keyset SQL,
  // concurrency semantics and idempotency uniqueness against a real database.
  //
  // NOT a problem — refusing a green on a machine with no Postgres would make
  // this tool unusable there — but it is reported, because the one thing this
  // file exists to prevent is a partial run reading as a complete one.
  const skipped = /Test Files\s+.*?(\d+) skipped/.exec(output);
  const skippedFiles = skipped === null ? 0 : Number(skipped[1]);

  return { ok: problems.length === 0, problems, skippedFiles };
}

/* c8 ignore start — CLI wiring; the judgement above is what the tests drive. */
if (process.argv[1]?.endsWith('verify-suite.mjs') === true) {
  // The workspace packages are consumed through their BUILT entry points
  // (`@driftstack/api-types` declares `main: dist/index.js`, and there is no
  // vitest alias), so an edit under `packages/*/src` is invisible to every test
  // that imports the package until it is rebuilt. `npm test` handles this with a
  // root `pretest`, and CI builds before testing — but this gate spawns vitest
  // directly, so it inherited neither. Every commit was therefore validated
  // against whatever `dist/` happened to hold.
  //
  // `tsc --build` is incremental: measured at 2.0s across all packages when the
  // artifact is already current, against a multi-minute suite. That cost is why
  // this is the right place to fix it rather than aliasing the package to src —
  // aliasing would change what 253 server test files actually assert, and would
  // leave the artifact CI publishes behaviourally untested everywhere.
  const build = spawnSync('npm', ['run', 'build:packages'], { encoding: 'utf8' });
  if (build.status !== 0) {
    process.stdout.write(build.stdout ?? '');
    process.stderr.write(build.stderr ?? '');
    console.error(
      '\nverify-suite: NOT TRUSTWORTHY — the workspace packages failed to build, so the ' +
        'suite would have run against a stale artifact.',
    );
    process.exit(1);
  }
  // `--all` judges the FULL root-config run with coverage — the shape CI runs.
  // Without it this defaults to the node project, which is the fast local loop.
  const passthrough = process.argv.slice(2).filter((a) => a !== '--all');
  const runAll = process.argv.includes('--all');
  const expectedFiles = runAll ? EXPECTED_TEST_FILES_ALL : EXPECTED_TEST_FILES;
  const args = runAll
    ? ['vitest', 'run', '--coverage', ...passthrough]
    : ['vitest', 'run', '--config', 'vitest.node.config.ts', ...passthrough];
  const child = spawn('npx', args, { encoding: 'utf8' });
  let output = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    output += c;
    process.stdout.write(c);
  });
  child.stderr.on('data', (c) => {
    output += c;
    process.stderr.write(c);
  });
  child.on('close', (code) => {
    const verdict = judge({ output, exitCode: code ?? 1, expectedFiles });
    if (verdict.ok) {
      console.log('\nverify-suite: OK — exit 0, no unhandled errors, full file count');
      if (verdict.skippedFiles > 0) {
        console.log(
          `verify-suite: NOTE — ${String(verdict.skippedFiles)} test file(s) were collected but ` +
            'never executed. Most gate on DATABASE_URL; set it to the local Postgres to run them.',
        );
      }
      process.exit(0);
    }
    console.error('\nverify-suite: NOT TRUSTWORTHY');
    for (const p of verdict.problems) console.error(`  - ${p}`);
    process.exit(1);
  });
}
/* c8 ignore stop */
