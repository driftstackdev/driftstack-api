// Types for `verify-suite.mjs`, so a TypeScript test can import the REAL exported
// values instead of re-typing them.
//
// Added because the blind-spot census under `apps/server/tests/unit` failed
// `the-server-source-type-checks` with TS7016 — that tsconfig is strict and this
// module had no declarations. `scripts/tests/verify-suite.test.ts` has imported it
// for months without complaint because `scripts/` sits outside that tsconfig, so
// the gap only appears the moment a server test consumes it.
//
// Parsing the constants out of the file as text would have avoided this and been
// worse: a census of CI jobs has to compare against the values the gate ACTUALLY
// exports, or it is checking a copy of them.

/** Files the node project is expected to collect. */
export const EXPECTED_TEST_FILES: number;

/** Files the root config collects — both vitest projects, i.e. CI's `build-test`. */
export const EXPECTED_TEST_FILES_ALL: number;

/** A CI job this gate does not run, with how to run it locally. */
export interface UncoveredSuite {
  /** Job id in `.github/workflows/ci.yml`. */
  readonly job: string;
  /** What that job runs, in a sentence. */
  readonly what: string;
  /** A command that runs it on a developer machine. */
  readonly local: string;
}

export const NOT_COVERED_BY_THIS_GATE: readonly UncoveredSuite[];

/** The CI job this gate IS, so a census can tell it apart from a gap. */
export const THIS_GATE_IS_CI_JOB: string;

export interface SuiteVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
  /** Files vitest collected but never executed (most gate on DATABASE_URL). */
  readonly skippedFiles: number;
}

export function judge(args: {
  output: string;
  exitCode: number;
  expectedFiles?: number;
}): SuiteVerdict;
