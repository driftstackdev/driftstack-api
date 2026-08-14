// The suite is the gate, so the gate has to type-check.
//
// On 2026-08-14 I committed server source that fails `tsc`. The full suite was
// green — 2,678 files, 26,982 tests, exit 0 — because vitest transpiles without
// checking types. `verify-suite` runs vitest and judges its result, so a type
// error in `src/` passes every gate anyone actually runs before committing. The
// build and `npm run typecheck` catch it; neither is part of the suite, and the
// commit landed with a broken build.
//
// That is the specific hole this closes: not "types are good practice", but that
// the one command used as the pre-commit gate could not see a non-compiling
// program. A guard belongs where the mistake is made, and the mistake is made at
// `npm test`.
//
// WHY IT IS CHEAP ENOUGH TO SIT IN THE SUITE. Measured at ~1.2s. The project is
// `composite` with a `tsBuildInfoFile`, so the check reuses prior work rather
// than rebuilding the program from scratch. It was verified to still CATCH
// things at that speed, rather than assumed: a deliberate
// `const x: number = 'not a number'` in `src/lib/errors.ts` was reported as
// TS2322 on the right line, and the file restored to a clean exit 0. A fast
// checker that has stopped checking looks exactly like a fast checker.
//
// ANTI-VACUITY IS THE HARD PART HERE. `tsc` exits 0 on an empty project, a
// mis-resolved tsconfig, or a `--project` path that matched nothing — every one
// of which reads identically to "the source compiles". So the file graph is
// asserted too: the check must have loaded a few hundred files from
// `apps/server/src` including a named one. Exit 0 over nothing is the failure
// mode this guard exists to avoid in itself.
//
// SCOPE, stated rather than implied: `tsconfig.json` (the SERVER SOURCE) only.
// `tsconfig.test.json` is deliberately excluded because it has pre-existing
// errors — an in-flight billing fixture and an `Ajv` namespace import — that
// belong to work I do not own. Extending this file to cover tests today would
// red for reasons unrelated to whatever change is being made, which is how a
// guard gets disabled. The last assertion is self-obsoleting: it asserts that
// exclusion is STILL justified, so when those errors are fixed this fails and
// says to widen rather than quietly guarding half of what it names.

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = resolve(HERE, '..', '..');
const REPO = resolve(SERVER, '..', '..');
const TSC = resolve(REPO, 'node_modules', '.bin', 'tsc');

/** Runs tsc against one project and returns its exit code plus diagnostics. */
function typeCheck(project: string, extraArgs: string[] = []): { code: number; out: string } {
  const run = spawnSync(TSC, ['--noEmit', '-p', project, ...extraArgs], {
    cwd: SERVER,
    encoding: 'utf8',
    timeout: 300_000,
  });
  return { code: run.status ?? 1, out: `${run.stdout ?? ''}${run.stderr ?? ''}` };
}

describe('the server source type-checks', () => {
  it('CRITICAL the checker loaded the real program. tsc exits 0 on an empty project, a mis-resolved tsconfig, or a --project path that matched nothing, and all three read exactly like "the source compiles" — so the pass below means nothing without knowing a few hundred source files were actually in the graph.', () => {
    const listed = typeCheck('tsconfig.json', ['--listFilesOnly']);
    expect(listed.code, 'listing the program succeeded').toBe(0);

    const files = listed.out.split('\n').filter((l) => l.trim() !== '');
    const projectSources = files.filter((f) => f.includes('/apps/server/src/'));
    // MEASURED: 328 files under apps/server/src, 2494 including dependencies.
    expect(projectSources.length, 'source files in the checked program').toBeGreaterThan(250);
    expect(
      projectSources.some((f) => f.endsWith('/src/lib/errors.ts')),
      'and a known source file is among them',
    ).toBe(true);
  }, 300_000);

  it('CRITICAL the server source compiles. vitest transpiles without type-checking, so every other test in this suite passes on a program that does not build — which is how a type error reached main behind a green 26,982-test run.', () => {
    const result = typeCheck('tsconfig.json');
    expect(result.code, `tsc reported:\n${result.out}`).toBe(0);
  }, 300_000);

  it('CRITICAL the reason tests are excluded still holds. This is the caveat asserting itself: tsconfig.test.json has pre-existing errors outside my scope, so it is not covered here — and when someone fixes them this fails, which is the signal to widen this guard rather than leave it silently narrower than its name.', () => {
    const result = typeCheck('tsconfig.test.json');
    expect(
      result.code,
      'tsconfig.test.json still has pre-existing errors — if this passes, widen the guard above to cover tests too',
    ).not.toBe(0);
  }, 300_000);
});
