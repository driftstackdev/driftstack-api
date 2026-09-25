// CI runs on main that finish out of order never deploy an older commit over a
// newer one, and the newest green commit is what each environment ends on.
//
// CI no longer cancels a run on main when a newer push lands (see
// a-burst-of-pushes-to-main-never-cancels-the-ci-run-a-deploy-waits-on), so a
// burst of pushes now produces one CI completion per commit, in whatever order
// the runs happen to finish. Each completion starts .github/workflows/deploy.yml,
// whose runs queue one at a time in arrival order. The ci-gate deploys the
// commit its run tested, not "the newest green", so the newest-wins property
// rests on each deploy job's forward-only step: a run whose commit is older than
// what the environment already serves must skip.
//
// The pieces are pinned one at a time elsewhere (the gate script, the step's
// exit-code wiring, deploy-is-forward.mjs against a real history). This file
// runs them TOGETHER, as a sequence: the workflow's own `run:` text for the
// ci-gate and both forward-only steps, the real scripts/deploy-is-forward.mjs
// against a real git history and a local /version, and the jobs' own `if:`
// expressions deciding which job runs. Only `gh` is stubbed, and deploy-bridge
// is replaced by "the environment now serves this commit".

import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { evaluate } from './_helpers/github-expression.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

interface Step {
  id?: string;
  run?: string;
}
interface Job {
  if?: string;
  steps: Step[];
}
const deploy = parse(readFileSync(resolve(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8')) as {
  jobs: Record<string, Job>;
};
const stepRun = (job: string, id: string): string => {
  const run = deploy.jobs[job]?.steps.find((s) => s.id === id)?.run;
  if (run === undefined) throw new Error(`${job} has no step ${id}`);
  return run;
};
const GATE = stepRun('ci-gate', 'pick');
const FORWARD = {
  staging: stepRun('deploy-staging', 'forward'),
  production: stepRun('deploy-production', 'forward'),
};

let dir: string;
let repo: string;
let bin: string;
let server: Server;
let local: string;
/** What each environment's /version reports. */
const live: Record<'staging' | 'production', string> = { staging: '', production: '' };
const commits: Record<string, string> = {};

function git(...args: string[]): string {
  return spawnSync(
    'git',
    [
      '-c',
      'core.hooksPath=/dev/null',
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=test',
      '-c',
      'user.email=test@example.invalid',
      ...args,
    ],
    { cwd: repo, encoding: 'utf8', env: { PATH: process.env.PATH ?? '', HOME: repo } },
  ).stdout.trim();
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ds-out-of-order-'));
  repo = join(dir, 'repo');
  bin = join(dir, 'bin');
  mkdirSync(repo);
  mkdirSync(bin);
  git('init', '-q', '-b', 'main');
  for (const label of ['O', 'A', 'B', 'C']) {
    git('commit', '--allow-empty', '--no-verify', '-q', '-m', label);
    commits[label] = git('rev-parse', 'HEAD');
  }
  // The deploy checkout's view of main: the script's default --main-ref.
  git('update-ref', 'refs/remotes/origin/main', commits.C!);
  // The workflow runs `node scripts/deploy-is-forward.mjs` from the checkout.
  mkdirSync(join(repo, 'scripts'));
  copyFileSync(
    resolve(REPO_ROOT, 'scripts/deploy-is-forward.mjs'),
    join(repo, 'scripts/deploy-is-forward.mjs'),
  );

  server = createServer((req, res) => {
    const env = req.url === '/staging/version' ? 'staging' : 'production';
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ version: '1.0.0', git_sha: live[env].slice(0, 7) }));
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  local = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;

  // gh answers the gate's two questions from the test; every other command
  // is the real one. `node` runs the REAL script, pointed at the local /version
  // in place of the two public hosts.
  writeFileSync(
    join(bin, 'gh'),
    '#!/bin/sh\ncase "$*" in\n  *compare*) echo "$STUB_COMPARE" ;;\n  *) echo "$STUB_RUNS" ;;\nesac\n',
  );
  writeFileSync(
    join(bin, 'node'),
    [
      '#!/bin/bash',
      'args=()',
      'for a in "$@"; do',
      '  case "$a" in',
      '    https://staging.driftstack.dev) args+=("$LOCAL/staging") ;;',
      '    https://api.driftstack.dev) args+=("$LOCAL/production") ;;',
      '    *) args+=("$a") ;;',
      '  esac',
      'done',
      'exec "$REAL_NODE" "${args[@]}" --attempts 1',
      '',
    ].join('\n'),
  );
  chmodSync(join(bin, 'gh'), 0o755);
  chmodSync(join(bin, 'node'), 0o755);
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
  rmSync(dir, { recursive: true, force: true });
});

/**
 * A `run:` step as GitHub runs it, returning its exit status and outputs.
 * Asynchronous on purpose: the step's node child asks this process's /version
 * server, which cannot answer while a synchronous spawn blocks the event loop.
 */
function step(
  script: string,
  env: Record<string, string>,
): Promise<{ status: number; outputs: Record<string, string>; text: string }> {
  const file = join(dir, 'step.sh');
  const out = join(dir, 'github_output');
  writeFileSync(file, script);
  writeFileSync(out, '');
  return new Promise((done) => {
    const child = spawn('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      cwd: repo,
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        GITHUB_OUTPUT: out,
        GITHUB_REPOSITORY: 'owner/repo',
        REAL_NODE: process.execPath,
        LOCAL: local,
        HOME: repo,
        ...env,
      },
    });
    let text = '';
    child.stdout.on('data', (d: Buffer) => (text += d.toString()));
    child.stderr.on('data', (d: Buffer) => (text += d.toString()));
    child.on('close', (code) => {
      const outputs = Object.fromEntries(
        readFileSync(out, 'utf8')
          .split('\n')
          .filter((l) => l.includes('='))
          .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
      );
      done({ status: code ?? -1, outputs, text });
    });
  });
}

type Label = 'A' | 'B' | 'C';
interface Completion {
  commit: Label;
  green: boolean;
  /** The CI run's conclusion when it is not green; `failure` by default. */
  conclusion?: 'failure' | 'cancelled';
}

/**
 * One deploy.yml run for one CI completion: the gate, then staging, then
 * production, each job admitted by its own `if:`; a deploy that proceeds makes
 * the environment serve the commit. `forward` swaps the forward-only step, for
 * the negative control. Returns what happened, for the assertions.
 */
async function deployRun(
  c: Completion,
  forward = FORWARD,
): Promise<{ gateFailed: boolean; moved: string[] }> {
  const sha = commits[c.commit]!;
  const gate = await step(GATE, {
    EVENT_NAME: 'workflow_run',
    RUN_SHA: sha,
    RUN_CONCLUSION: c.green ? 'success' : (c.conclusion ?? 'failure'),
    STUB_RUNS: c.green ? '1' : '0',
    STUB_COMPARE: sha === commits.C ? 'identical' : 'ahead',
  });
  if (gate.status !== 0) return { gateFailed: true, moved: [] };
  const needs: Record<string, { outputs: Record<string, string> }> = {
    'ci-gate': { outputs: gate.outputs },
  };
  const moved: string[] = [];

  if (!evaluate(deploy.jobs['deploy-staging']!.if!, { needs })) return { gateFailed: false, moved };
  const staging = await step(forward.staging, { SHA: sha });
  expect(staging.status, staging.text).toBe(0);
  if (staging.outputs.proceed === 'true') {
    live.staging = sha;
    moved.push(`staging→${c.commit}`);
  }
  needs['deploy-staging'] = { outputs: { deployed: staging.outputs.proceed ?? '' } };

  if (!evaluate(deploy.jobs['deploy-production']!.if!, { needs })) {
    return { gateFailed: false, moved };
  }
  const production = await step(forward.production, { SHA: sha });
  expect(production.status, production.text).toBe(0);
  if (production.outputs.proceed === 'true') {
    live.production = sha;
    moved.push(`production→${c.commit}`);
  }
  return { gateFailed: false, moved };
}

const isAncestor = (older: string, newer: string): boolean =>
  spawnSync('git', ['merge-base', '--is-ancestor', older, newer], { cwd: repo }).status === 0;

/** Plays the completions in order from a fresh state; returns each environment's history. */
async function play(order: Completion[], forward = FORWARD) {
  live.staging = commits.O!;
  live.production = commits.O!;
  const history = { staging: [commits.O!], production: [commits.O!] };
  const gateFailures: Label[] = [];
  for (const c of order) {
    const r = await deployRun(c, forward);
    if (r.gateFailed) gateFailures.push(c.commit);
    for (const env of ['staging', 'production'] as const) {
      if (history[env].at(-1) !== live[env]) history[env].push(live[env]);
    }
  }
  return { history, gateFailures };
}

function permutations<T>(xs: T[]): T[][] {
  if (xs.length <= 1) return [xs];
  return xs.flatMap((x, i) =>
    permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((rest) => [x, ...rest]),
  );
}

const label = (sha: string): string =>
  Object.entries(commits).find(([, s]) => s === sha)?.[0] ?? sha;

describe(
  'CI runs on main finishing out of order never deploy an older commit',
  { timeout: 120_000 },
  () => {
    it('POSITIVE CONTROL in order, every green commit deploys to both environments, staging first', async () => {
      const { history } = await play([
        { commit: 'A', green: true },
        { commit: 'B', green: true },
        { commit: 'C', green: true },
      ]);
      expect(history.staging.map(label)).toEqual(['O', 'A', 'B', 'C']);
      expect(history.production.map(label)).toEqual(['O', 'A', 'B', 'C']);
    });

    it('NEGATIVE CONTROL without the forward-only check the same steps DO move an environment backwards, so the arms below can fail', async () => {
      const alwaysProceed = (script: string): string =>
        script.replace(/node scripts\/deploy-is-forward\.mjs[^\n]*/, 'true');
      const { history } = await play(
        [
          { commit: 'C', green: true },
          { commit: 'A', green: true },
        ],
        { staging: alwaysProceed(FORWARD.staging), production: alwaysProceed(FORWARD.production) },
      );
      expect(history.production.map(label)).toEqual(['O', 'C', 'A']);
    });

    it.each(
      permutations<Label>(['A', 'B', 'C']).map((order) => [order.join(' then '), order] as const),
    )(
      'CRITICAL all three green, finishing %s: each environment only ever moves forward and ends on the newest',
      async (_name, order) => {
        const { history, gateFailures } = await play(
          order.map((commit) => ({ commit, green: true })),
        );
        expect(gateFailures).toEqual([]);
        for (const env of ['staging', 'production'] as const) {
          const h = history[env];
          for (let i = 1; i < h.length; i += 1) {
            expect(
              isAncestor(h[i - 1]!, h[i]!),
              `${env} moved from ${label(h[i - 1]!)} to ${label(h[i]!)}`,
            ).toBe(true);
          }
          expect(label(h.at(-1)!), env).toBe('C');
        }
      },
    );

    it.each(
      permutations<Label>(['A', 'B', 'C']).map((order) => [order.join(' then '), order] as const),
    )(
      'CRITICAL the newest commit red, finishing %s: production ends on the newest GREEN commit, and the red run raises the alert',
      async (_name, order) => {
        const { history, gateFailures } = await play(
          order.map((commit) => ({ commit, green: commit !== 'C' })),
        );
        expect(
          gateFailures,
          'the red run fails the gate, which raises the deploy-failure issue',
        ).toEqual(['C']);
        expect(label(history.production.at(-1)!)).toBe('B');
        expect(label(history.staging.at(-1)!)).toBe('B');
      },
    );

    // A run on main is no longer cancelled by CI's own concurrency, but one can
    // still be cancelled by hand or cut off at a job's timeout. When it is the
    // newest commit's run, production stays on the newest green commit, and
    // that has to be said: the gate fails, so the deploy-failure issue opens.
    it.each(
      permutations<Label>(['A', 'B', 'C']).map((order) => [order.join(' then '), order] as const),
    )(
      "CRITICAL the newest commit's CI cancelled, finishing %s: production ends on the newest green commit, and the cancelled run raises the alert",
      async (_name, order) => {
        const { history, gateFailures } = await play(
          order.map(
            (commit): Completion =>
              commit === 'C'
                ? { commit, green: false, conclusion: 'cancelled' }
                : { commit, green: true },
          ),
        );
        expect(
          gateFailures,
          'the cancelled run fails the gate, which raises the deploy-failure issue',
        ).toEqual(['C']);
        expect(label(history.production.at(-1)!)).toBe('B');
        expect(label(history.staging.at(-1)!)).toBe('B');
      },
    );

    it('a re-run of an old CI run finishing long after a newer commit went live changes nothing', async () => {
      const { history } = await play([
        { commit: 'C', green: true },
        { commit: 'A', green: true },
        { commit: 'B', green: true },
      ]);
      expect(history.staging.map(label)).toEqual(['O', 'C']);
      expect(history.production.map(label)).toEqual(['O', 'C']);
    });
  },
);
