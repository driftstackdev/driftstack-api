// A burst of pushes to main never cancels the CI run a deploy waits on.
//
// .github/workflows/deploy.yml deploys a commit only after a GREEN CI run on
// that same commit, and a cancelled run deploys nothing (until 2026-09-25 it
// raised nothing either; its ci-gate now fails, so the deploy-failure issue
// opens).
// ci.yml used to put every run of a ref in one concurrency group with
// `cancel-in-progress: true`, so each push to main cancelled the run before it.
// During a burst every run but the last was cancelled: production stayed where
// it was with no alert, and when the last run failed nothing deployed at all,
// although an earlier commit in the burst may have been green.
//
// GitHub's concurrency cancels in TWO ways, and turning off only the obvious one
// is not enough:
//   • `cancel-in-progress: true` cancels the RUNNING run of the group when a new
//     one joins it;
//   • whatever `cancel-in-progress` says, a group holds at most ONE pending run,
//     and a newer arrival cancels the pending one.
// So `cancel-in-progress: false` with a group per ref still cancels every middle
// commit of a burst of three. On main each run gets a group of its own; pull
// requests keep one group per ref and keep cancelling superseded runs, which is
// what that setting is for.
//
// Parsed and EVALUATED, not grepped: the group and cancel-in-progress are
// expressions, and what matters is what they come to for each kind of run.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { interpolate } from './_helpers/github-expression.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8');

interface Concurrency {
  group: string;
  'cancel-in-progress': boolean | string;
}
const ci = parse(read('.github/workflows/ci.yml')) as {
  name: string;
  on: Record<string, unknown>;
  concurrency: Concurrency;
};

interface RunContext {
  event_name: 'push' | 'pull_request';
  ref: string;
  run_id: number;
}
const pushToMain = (run_id: number): RunContext => ({
  event_name: 'push',
  ref: 'refs/heads/main',
  run_id,
});
const pullRequest = (n: number, run_id: number): RunContext => ({
  event_name: 'pull_request',
  ref: `refs/pull/${String(n)}/merge`,
  run_id,
});

/** What a workflow's concurrency block comes to for one run. */
function resolveFor(
  concurrency: Concurrency,
  github: RunContext,
): { group: string; cancelInProgress: boolean } {
  const ctx = { github: { ...github, workflow: ci.name } };
  const group = interpolate(concurrency.group, ctx);
  const raw = concurrency['cancel-in-progress'];
  const cancel = typeof raw === 'boolean' ? raw : interpolate(raw, ctx);
  expect(typeof group, 'the group resolves to a string').toBe('string');
  expect(typeof cancel, 'cancel-in-progress resolves to a boolean').toBe('boolean');
  return { group: group as string, cancelInProgress: cancel as boolean };
}

/**
 * GitHub's rules for runs that arrive while earlier ones in their group have not
 * finished: a group holds one running and at most one pending run; an arrival
 * cancels the pending run, and also the running one when the ARRIVAL has
 * cancel-in-progress set. Returns the run ids that end up cancelled.
 */
function cancelledIn(concurrency: Concurrency, burst: RunContext[]): number[] {
  const groups = new Map<string, { running?: number; pending?: number }>();
  const cancelled: number[] = [];
  for (const run of burst) {
    const { group, cancelInProgress } = resolveFor(concurrency, run);
    const g = groups.get(group) ?? {};
    if (g.pending !== undefined) {
      cancelled.push(g.pending);
      g.pending = undefined;
    }
    if (g.running === undefined) g.running = run.run_id;
    else if (cancelInProgress) {
      cancelled.push(g.running);
      g.running = run.run_id;
    } else g.pending = run.run_id;
    groups.set(group, g);
  }
  return cancelled.sort((a, b) => a - b);
}

const THE_OLD_BLOCK: Concurrency = {
  group: '${{ github.workflow }}-${{ github.ref }}',
  'cancel-in-progress': true,
};

describe('a burst of pushes to main never cancels the CI run a deploy waits on', () => {
  it('POSITIVE CONTROL the model reproduces the defect: the old block cancels every run of a burst on main but the last, and turning off cancel-in-progress alone still loses the middle one', () => {
    const burst = [pushToMain(101), pushToMain(102), pushToMain(103)];
    expect(cancelledIn(THE_OLD_BLOCK, burst)).toEqual([101, 102]);
    expect(cancelledIn({ ...THE_OLD_BLOCK, 'cancel-in-progress': false }, burst)).toEqual([102]);
  });

  it('CI still runs on every push to main and on pull requests to main (the deploy is triggered by its completion on main)', () => {
    expect(ci.name).toBe('CI');
    expect(ci.on).toEqual({
      push: { branches: ['main'] },
      pull_request: { branches: ['main'] },
    });
  });

  it('CRITICAL no run on main is cancelled by a later push: a burst of five leaves all five to finish', () => {
    const burst = [101, 102, 103, 104, 105].map(pushToMain);
    expect(cancelledIn(ci.concurrency, burst)).toEqual([]);
    for (const run of burst) {
      expect(resolveFor(ci.concurrency, run).cancelInProgress, `run ${String(run.run_id)}`).toBe(
        false,
      );
    }
  });

  it('CRITICAL each run on main has a group of its own, so the one-pending-run rule cannot cancel it either', () => {
    const groups = [101, 102, 103].map((id) => resolveFor(ci.concurrency, pushToMain(id)).group);
    expect(new Set(groups).size).toBe(3);
  });

  it('CRITICAL a pull request still cancels its own superseded run, and only its own', () => {
    expect(cancelledIn(ci.concurrency, [pullRequest(7, 201), pullRequest(7, 202)])).toEqual([201]);
    expect(resolveFor(ci.concurrency, pullRequest(7, 201)).cancelInProgress).toBe(true);
    // Another pull request, and main, are untouched by it.
    expect(
      cancelledIn(ci.concurrency, [pullRequest(7, 201), pullRequest(8, 301), pushToMain(401)]),
    ).toEqual([]);
    expect(
      cancelledIn(ci.concurrency, [pushToMain(401), pullRequest(7, 201), pullRequest(7, 202)]),
    ).toEqual([201]);
  });

  it('a pull request never shares a group with a run on main', () => {
    const main = resolveFor(ci.concurrency, pushToMain(101)).group;
    const pr = resolveFor(ci.concurrency, pullRequest(7, 101)).group;
    expect(pr).not.toBe(main);
  });

  it('the group is one line: a folded expression that kept a newline would be a different group string', () => {
    expect(ci.concurrency.group).not.toContain('\n');
  });

  it('nothing still tells an operator that CI cancels a superseded run on main', () => {
    const CANCELS_ON_MAIN =
      /CI (?:on main )?cancels (?:a|an|the) (?:superseded|in-flight|in-progress|older)|CI on main cancels/i;
    for (const p of [
      '.github/workflows/deploy.yml',
      '.github/workflows/ci.yml',
      'docs/runbooks/deploy-bridge.md',
    ]) {
      const text = read(p).replace(/\s*\n\s*#?\s*/g, ' ');
      expect(text, p).not.toMatch(CANCELS_ON_MAIN);
    }
  });
});
