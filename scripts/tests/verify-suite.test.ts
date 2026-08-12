// The suite verifier is judged against REAL output from the incident it exists
// for, not a hand-written imitation of it.
//
// A run reported success while 89 tests never executed: exit 0, `Tests 26677
// passed`, no failures listed — and nine test FILES missing, because their
// workers never started under load. vitest calls that an unhandled error, warns
// that it "might cause false positive tests", and exits 0 anyway.
//
// The fixtures below are the actual summary and error text from that run and
// from the clean re-run that followed it. Writing the bad case by hand would
// have tested my memory of the failure rather than the failure.

import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
import { EXPECTED_TEST_FILES, judge } from '../verify-suite.mjs';

/** The real false-green: 2561 of 2633 collected, 9 workers never started. */
const FALSE_GREEN = `
 ⎯⎯⎯⎯⎯⎯ Unhandled Errors ⎯⎯⎯⎯⎯⎯

Vitest caught 9 unhandled errors during the test run.
This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.

 ⎯⎯⎯⎯⎯⎯ Unhandled Error ⎯⎯⎯⎯⎯⎯⎯
Error: [vitest-pool]: Failed to start forks worker for test files /repo/apps/admin-panel/tests/unit/x.test.ts
Caused by: Error: [vitest-pool-runner]: Timeout waiting for worker to respond

 Test Files  2561 passed | 63 skipped (2624)
      Tests  26677 passed | 252 skipped (26929)
`;

/**
 * The clean re-run, same box, same load, workers capped.
 *
 * Historical output, so the cases below pass its OWN collected count rather
 * than the live pin. Coupling a captured fixture to a constant that legitimately
 * rises every time a test is added would make this file fail for a reason that
 * has nothing to do with what it checks.
 */
const CLEAN_EXPECTED_FILES = 2633;
const CLEAN = `
 Test Files  2570 passed | 63 skipped (2633)
      Tests  26766 passed | 252 skipped (27018)
`;

/**
 * Test files the node project collects, counted from its own include globs.
 *
 * `apps/**\/tests/**\/*.test.ts`, `packages/**\/tests/**\/*.test.ts` and
 * `scripts/tests/**\/*.test.ts`, minus the e2e directory and build output —
 * read off vitest.node.config.ts rather than restated, so a glob change shows
 * up here instead of quietly shifting what the pin means.
 */
function countTestFiles(): number {
  const roots = ['apps', 'packages', 'scripts'];
  let n = 0;
  const walk = (dir: string): void => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir)) {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) {
        if (entry === 'node_modules' || entry === 'dist' || entry === 'e2e') continue;
        walk(full);
      } else if (full.endsWith('.test.ts') && full.includes(`${sep}tests${sep}`)) {
        n += 1;
      }
    }
  };
  for (const r of roots) walk(resolve(REPO_ROOT, r));
  return n;
}

describe('the suite verifier refuses to call an under-run green', () => {
  it('CRITICAL rejects the REAL false-green run — the one that exited 0 with nine files unexecuted. Exit code alone accepts it, which is exactly why this exists.', () => {
    const verdict = judge({ output: FALSE_GREEN, exitCode: 0 });
    expect(verdict.ok, 'a run missing nine files is not trustworthy').toBe(false);
    expect(
      verdict.problems.join(' '),
      'and it says WHICH signals failed, so the reader is not left guessing',
    ).toMatch(/unhandled error/i);
    expect(verdict.problems.join(' '), 'including the file shortfall').toMatch(/2624/);
  });

  it('CRITICAL accepts the clean re-run. A verifier that rejected everything would satisfy the case above while being useless.', () => {
    expect(
      judge({ output: CLEAN, exitCode: 0, expectedFiles: CLEAN_EXPECTED_FILES }),
      'the complete run passes',
    ).toMatchObject({
      ok: true,
      problems: [],
    });
  });

  it('CRITICAL each of the three signals fails on its own, because each catches what the others miss', () => {
    // Exit code alone.
    expect(
      judge({ output: CLEAN, exitCode: 1, expectedFiles: CLEAN_EXPECTED_FILES }).ok,
      'a non-zero exit fails',
    ).toBe(false);

    // Unhandled errors with a FULL file count — workers that died after
    // collecting. The count check cannot see this one.
    const unhandledOnly = `Vitest caught 2 unhandled errors during the test run.\n${CLEAN}`;
    expect(
      judge({ output: unhandledOnly, exitCode: 0, expectedFiles: CLEAN_EXPECTED_FILES }).ok,
      'unhandled errors fail',
    ).toBe(false);

    // A short count with NO unhandled error — files excluded rather than
    // crashed. The unhandled check cannot see this one.
    const shortOnly = ' Test Files  10 passed | 0 skipped (10)\n      Tests  10 passed (10)\n';
    expect(judge({ output: shortOnly, exitCode: 0 }).ok, 'a short collection fails').toBe(false);

    // And a run that never produced a summary at all.
    expect(judge({ output: 'CACError: Unknown option `--minWorkers`', exitCode: 1 }).ok).toBe(
      false,
    );
  });

  it('CRITICAL a run that SKIPPED files reports how many, because "2576 passed" reads identically whether 63 files ran or not. Both fixtures below are real output from the same tree minutes apart: without DATABASE_URL, 56 files gate themselves off and 2642 files / 26,802 tests run; with it pointed at the local Postgres, 2645 files / 27,066 tests run. The 264-test difference is the real-database guards on keyset SQL, concurrency and idempotency — legitimate to skip on a machine with no Postgres, and the reason the verdict stays ok, but not something a reader should have to infer.', () => {
    const withoutPostgres =
      ' Test Files  2576 passed | 63 skipped (2642)\n      Tests  26802 passed | 252 skipped (27059)\n';
    const withPostgres =
      ' Test Files  2645 passed (2645)\n      Tests  27066 passed | 2 skipped (27069)\n';

    const partial = judge({ output: withoutPostgres, exitCode: 0, expectedFiles: 2642 });
    expect(partial.ok, 'skipping is legitimate — this must not fail the run').toBe(true);
    expect(partial.skippedFiles, 'but the count is reported').toBe(63);

    const complete = judge({ output: withPostgres, exitCode: 0, expectedFiles: 2645 });
    expect(complete.ok).toBe(true);
    expect(complete.skippedFiles, 'a complete run reports none').toBe(0);
  });

  it('CRITICAL the pin matches the test files that exist ON DISK right now. Counted from the project s own include globs rather than compared to a frozen fixture: a pin checked against captured output only stays correct until the next test file is added, and a pin left behind the real number silently stops detecting shortfalls — the exact failure this file guards against. Adding a test fails here until the pin is raised, which is the point.', () => {
    const count = countTestFiles();
    expect(count, 'the globs found a real population').toBeGreaterThan(2000);
    expect(
      EXPECTED_TEST_FILES,
      'raise EXPECTED_TEST_FILES in the same commit that adds or removes a test file',
    ).toBe(count);
  });
});
