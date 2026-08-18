// `verify-suite --all` is ONE CI job, and its own comment called it CI.
//
// The comment on EXPECTED_TEST_FILES_ALL read "every project, which is what CI
// runs". That is true of the two vitest projects and false of the pipeline: CI has
// five jobs, and this gate is `build-test`. The other four — Playwright e2e,
// Python SDK, Go SDK, bench — are never touched by it.
//
// It matters because of how the green is quoted. Every commit message in this
// repo that says "verified at the CI bar" is citing this gate, so a claim about
// the whole pipeline gets made from a run covering a fifth of it. Measured
// 2026-08-18, all green and none of it by this gate: 199 Playwright tests over 29
// spec files, 362 Python tests, and the Go suite.
//
// The e2e omission is the one with teeth. Those 29 spec files are the ONLY tests
// that exercise `apps/server/src/db/**` against a real Postgres — the same
// directory `vitest.config.ts` excludes from coverage, on the stated grounds that
// it is "exercised by e2e, not by vitest". So the layer the coverage gate declines
// to measure is also the layer this gate never executes. Both statements are
// individually defensible; together they leave the repo's database layer measured
// by neither, and neither file said so.
//
// So the dispositions are derived against the workflow rather than remembered.
// Every job in ci.yml must be either the job this gate IS, or listed as not
// covered with a way to run it locally. A new CI job fails this until someone
// says which it is — the same reason the cross-account censuses exist: "not run
// here" and "not a test job" must never look identical from a green run.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  NOT_COVERED_BY_THIS_GATE,
  THIS_GATE_IS_CI_JOB,
} from '../../../../scripts/verify-suite.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (rel: string): string => readFileSync(resolve(REPO_ROOT, rel), 'utf8');

/**
 * Job ids from the workflow: two-space-indented keys under `jobs:`.
 *
 * `on:` triggers (`push:`, `pull_request:`) sit at the same indent, so they are
 * excluded by name — and asserted absent below, because a filter that silently
 * stopped matching would shrink the census rather than fail it.
 */
function ciJobIds(yaml: string): string[] {
  const ids = [...yaml.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9_-]*):$/gm)].map((m) => m[1] as string);
  return ids.filter((id) => id !== 'push' && id !== 'pull_request').sort();
}

describe('a gate that does not name its blind spot reads as total', () => {
  it('CRITICAL every CI job is either this gate or named as not covered by it. A green from one job is quoted as "the CI bar"; the only thing that keeps that honest is an enumeration nobody can forget to update, because forgetting produces a passing run rather than a failing one.', () => {
    const jobs = ciJobIds(read('.github/workflows/ci.yml'));
    expect(
      jobs.length,
      'the ci.yml job census parsed as empty — the regex, not the workflow',
    ).toBeGreaterThan(3);
    expect(jobs, 'the parser picked up a workflow trigger as a job').not.toContain('push');

    const accounted = new Set([THIS_GATE_IS_CI_JOB, ...NOT_COVERED_BY_THIS_GATE.map((s) => s.job)]);
    const unaccounted = jobs.filter((j) => !accounted.has(j));
    expect(
      unaccounted,
      `these CI jobs are neither this gate nor listed as outside it:\n  ${unaccounted.join('\n  ')}`,
    ).toEqual([]);
  });

  it('the not-covered list cannot rot — every job it names must still exist in ci.yml. An entry for a deleted job excuses nothing while making the blind spot look wider than it is, and the next real gap hides behind the noise.', () => {
    const jobs = new Set(ciJobIds(read('.github/workflows/ci.yml')));
    const gone = NOT_COVERED_BY_THIS_GATE.filter((s) => !jobs.has(s.job)).map((s) => s.job);
    expect(gone, `named as not covered but no longer a CI job:\n  ${gone.join('\n  ')}`).toEqual(
      [],
    );
    expect(jobs.has(THIS_GATE_IS_CI_JOB), 'the job this gate claims to be no longer exists').toBe(
      true,
    );
  });

  it('CRITICAL each not-covered entry carries a way to RUN it. A blind spot you cannot act on is a disclaimer; the whole value of naming these is that someone reading a green can go and close one in a minute.', () => {
    for (const s of NOT_COVERED_BY_THIS_GATE) {
      expect(s.what, `${s.job} has no description`).toBeTruthy();
      expect(s.local, `${s.job} has no local command`).toBeTruthy();
      expect(s.local.length, `${s.job}'s local command is too short to be one`).toBeGreaterThan(10);
    }
  });

  it('CRITICAL the e2e specs really are outside the vitest projects, so naming them is not paranoia. `vitest.node.config.ts` excludes `**/tests/e2e/**` and the gui-client project only collects .tsx under its own tests dir — if e2e were ever folded in, this file would be describing a blind spot that had closed, which is its own kind of wrong.', () => {
    expect(read('vitest.node.config.ts'), 'the node project no longer excludes tests/e2e').toMatch(
      /exclude:\s*\[[^\]]*'\*\*\/tests\/e2e\/\*\*'/,
    );
    expect(
      NOT_COVERED_BY_THIS_GATE.some((s) => s.job === 'e2e'),
      'e2e must stay named while it stays excluded',
    ).toBe(true);
  });
});
