// Security sweep E-9, remaining hardening (2026-09-24): the production deploy
// must not run unless CI passed on the same commit.
//
// .github/workflows/deploy.yml ran on every push to main. Its production job
// needed only source-map-upload and deploy-staging, main is not branch-protected,
// and so a commit whose CI was red — or still running — reached production
// minutes after the push. It now:
//
//   • triggers on the CI workflow COMPLETING on main (workflow_run), plus a
//     manual dispatch from main;
//   • proves, in a ci-gate job, that the run succeeded on a push to main in THIS
//     repository (a pull request's run also completes, and a fork's branch can be
//     called main), asks the API for that success on exactly this commit, and
//     checks the commit is on main;
//   • deploys that run's head_sha — every checkout pins it, since under
//     workflow_run the default checkout is the branch tip, which may be newer;
//   • deploys staging first, and production only when staging deployed the same
//     commit in the same run;
//   • refuses, per environment, to move to a commit older than the one it runs
//     (scripts/deploy-is-forward.mjs, exercised in scripts/tests);
//   • keeps deploy-bridge.sh — with its post-deploy verification and auto-revert —
//     as the only thing that touches a host.
//
// Parsed as YAML, not grepped: the properties are about which job needs which,
// and what each step's `if:` and `with:` say.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const DEPLOY_TEXT = readFileSync(resolve(REPO_ROOT, '.github/workflows/deploy.yml'), 'utf8');
const CI_TEXT = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
const BRIDGE = readFileSync(resolve(REPO_ROOT, 'scripts/deploy-bridge.sh'), 'utf8');

interface Step {
  id?: string;
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  with?: Record<string, unknown>;
  env?: Record<string, unknown>;
}
interface Job {
  name?: string;
  if?: string;
  needs?: string | string[];
  outputs?: Record<string, string>;
  permissions?: Record<string, string>;
  steps: Step[];
}
interface Workflow {
  name: string;
  on: Record<string, unknown>;
  concurrency: { group: string; 'cancel-in-progress': boolean; queue?: string };
  jobs: Record<string, Job>;
}

const deploy = parse(DEPLOY_TEXT) as Workflow;
const ci = parse(CI_TEXT) as Workflow;
const jobs = deploy.jobs;
const needsOf = (job: Job): string[] =>
  job.needs === undefined ? [] : Array.isArray(job.needs) ? job.needs : [job.needs];
const GATE_SHA = '${{ needs.ci-gate.outputs.sha }}';
const DEPLOY_JOBS = ['deploy-staging', 'deploy-production'] as const;
const BASE_URL: Record<(typeof DEPLOY_JOBS)[number], string> = {
  'deploy-staging': 'https://staging.driftstack.dev',
  'deploy-production': 'https://api.driftstack.dev',
};

/**
 * A small evaluator for the GitHub Actions expressions this workflow uses:
 * string/number/boolean/null literals, context paths (`github.event.x.y`), `==`,
 * `!=`, `!`, `&&`, `||`, parentheses and `format()`. Semantics follow GitHub's:
 * `&&`/`||` return an operand rather than a boolean, and string equality ignores
 * case. Anything else throws, so an expression this cannot read fails the test
 * instead of being evaluated wrongly.
 */
function evaluate(source: string, ctx: Record<string, unknown>): unknown {
  const m = /^\s*\$\{\{([\s\S]*)\}\}\s*$/.exec(source);
  const text = m ? m[1]! : source;
  const tokens: string[] = [];
  const re = /\s*('(?:[^']|'')*'|==|!=|&&|\|\||[()!,]|[A-Za-z_][A-Za-z0-9_.-]*|\d+)/y;
  let at = 0;
  while (at < text.length) {
    if (/^\s*$/.test(text.slice(at))) break;
    re.lastIndex = at;
    const t = re.exec(text);
    if (!t) throw new Error(`cannot read expression at: ${text.slice(at, at + 30)}`);
    tokens.push(t[1]!);
    at = re.lastIndex;
  }
  let i = 0;
  const peek = (): string | undefined => tokens[i];
  const take = (want?: string): string => {
    const t = tokens[i++];
    if (t === undefined || (want !== undefined && t !== want)) {
      throw new Error(`expected ${want ?? 'a token'}, got ${t ?? 'the end'}`);
    }
    return t;
  };
  const truthy = (v: unknown): boolean => v !== false && v !== 0 && v !== '' && v != null;
  const equal = (a: unknown, b: unknown): boolean =>
    typeof a === 'string' && typeof b === 'string'
      ? a.toLowerCase() === b.toLowerCase()
      : (a ?? null) === (b ?? null);
  const lookup = (path: string): unknown =>
    path
      .split('.')
      .reduce<unknown>(
        (v, k) => (v !== null && typeof v === 'object' ? (v as Record<string, unknown>)[k] : null),
        ctx,
      ) ?? null;
  const primary = (): unknown => {
    const t = take();
    if (t === '(') {
      const v = or();
      take(')');
      return v;
    }
    if (t === '!') return !truthy(primary());
    if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
    if (/^\d+$/.test(t)) return Number(t);
    if (t === 'true' || t === 'false') return t === 'true';
    if (t === 'null') return null;
    if (t === 'format' && peek() === '(') {
      take('(');
      const args: unknown[] = [or()];
      while (peek() === ',') {
        take(',');
        args.push(or());
      }
      take(')');
      const text = (v: unknown): string =>
        typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' ? `${v}` : '';
      return text(args[0]).replace(/\{(\d+)\}/g, (_, n: string) => text(args[Number(n) + 1]));
    }
    if (/^[A-Za-z_]/.test(t)) return lookup(t);
    throw new Error(`unexpected token ${t}`);
  };
  const comparison = (): unknown => {
    const left = primary();
    const op = peek();
    if (op === '==' || op === '!=') {
      take();
      const right = primary();
      return op === '==' ? equal(left, right) : !equal(left, right);
    }
    return left;
  };
  const and = (): unknown => {
    let v = comparison();
    while (peek() === '&&') {
      take();
      const r = comparison();
      v = truthy(v) ? r : v;
    }
    return v;
  };
  const or = (): unknown => {
    let v = and();
    while (peek() === '||') {
      take();
      const r = and();
      v = truthy(v) ? v : r;
    }
    return v;
  };
  const value = or();
  if (i !== tokens.length) throw new Error(`unread tokens from: ${tokens.slice(i).join(' ')}`);
  return value;
}

describe('production deploys only a commit CI passed', () => {
  it('CRITICAL the workflow runs when CI COMPLETES on main, not on the push itself', () => {
    expect(Object.keys(deploy.on).sort()).toEqual(['workflow_dispatch', 'workflow_run']);
    expect(deploy.on.workflow_run).toEqual({
      workflows: [ci.name],
      types: ['completed'],
      branches: ['main'],
    });
    // workflow_run matches by workflow NAME: pin it to CI's real name, and CI
    // must itself run on pushes to main or this never fires.
    expect(ci.name).toBe('CI');
    expect(ci.on).toMatchObject({ push: { branches: ['main'] } });
  });

  it('CRITICAL the ci-gate admits only a SUCCESSFUL run on a PUSH to main in THIS repository', () => {
    const gate = jobs['ci-gate'];
    expect(gate, 'no ci-gate job').toBeDefined();
    const cond = (gate!.if ?? '').replace(/\s+/g, ' ');
    expect(cond).toContain("github.event.workflow_run.event == 'push'");
    expect(cond).toContain("github.event.workflow_run.head_branch == 'main'");
    expect(cond).toContain(
      'github.event.workflow_run.head_repository.full_name == github.repository',
    );
    expect(gate!.permissions).toEqual({ actions: 'read', contents: 'read' });

    const pick = gate!.steps.find((s) => s.id === 'pick');
    const script = pick?.run ?? '';
    expect(pick?.env?.RUN_SHA).toBe('${{ github.event.workflow_run.head_sha }}');
    expect(pick?.env?.RUN_CONCLUSION).toBe('${{ github.event.workflow_run.conclusion }}');
    // success proceeds; a superseded (cancelled) run deploys nothing quietly;
    // anything else FAILS, so a red CI on main raises the deploy-failure alert
    // instead of leaving production silently behind.
    expect(script).toMatch(/case "\$RUN_CONCLUSION" in\s*\n\s*success\) ;;/);
    expect(script).toMatch(/cancelled\|skipped\)[\s\S]*?deploy=false[\s\S]*?exit 0/);
    expect(script).toMatch(/\*\)[\s\S]*?::error::CI concluded[^\n]*\n\s*exit 1/);
    // A dispatch deploys main only.
    expect(script).toMatch(/"\$DISPATCH_REF" != "refs\/heads\/main"/);
    // Proven through the API for exactly this commit, and the commit is on main.
    expect(script).toMatch(
      /actions\/workflows\/ci\.yml\/runs"[\s\S]*?-f head_sha="\$SHA" -f event=push -f branch=main -f status=success/,
    );
    expect(script).toMatch(/compare\/\$\{SHA\}\.\.\.main/);
    expect(script).toMatch(/ahead\|identical\) ;;/);
    expect(gate!.outputs).toEqual({
      sha: '${{ steps.pick.outputs.sha }}',
      deploy: '${{ steps.pick.outputs.deploy }}',
    });
  });

  it('CRITICAL every later job waits for the gate, and staging goes before production', () => {
    expect(needsOf(jobs['source-map-upload']!)).toContain('ci-gate');
    expect(jobs['source-map-upload']!.if).toBe("needs.ci-gate.outputs.deploy == 'true'");
    expect(needsOf(jobs['deploy-staging']!)).toEqual(['ci-gate', 'source-map-upload']);
    expect(jobs['deploy-staging']!.if).toBe("needs.ci-gate.outputs.deploy == 'true'");
    expect(needsOf(jobs['deploy-production']!)).toEqual([
      'ci-gate',
      'source-map-upload',
      'deploy-staging',
    ]);
    // Production only when staging deployed THIS commit in THIS run.
    expect(jobs['deploy-production']!.if).toBe("needs.deploy-staging.outputs.deployed == 'true'");
    expect(jobs['deploy-staging']!.outputs).toEqual({
      deployed: '${{ steps.forward.outputs.proceed }}',
    });
  });

  it('CRITICAL every checkout pins the commit the gate proved, never the default ref', () => {
    const checkouts = Object.entries(jobs)
      .filter(([name]) => name !== 'ci-gate')
      .flatMap(([name, job]) =>
        job.steps.filter((s) => s.uses?.startsWith('actions/checkout@')).map((s) => ({ name, s })),
      );
    expect(checkouts.length, 'non-vacuity: source maps, staging, production').toBe(3);
    for (const { name, s } of checkouts) expect(s.with?.ref, name).toBe(GATE_SHA);
    // Under workflow_run, github.sha is the default branch tip, not the tested
    // commit. Nothing that builds or deploys may read it (the gate reads it for
    // a dispatch; the failure alert only as a last-resort label).
    for (const name of ['source-map-upload', ...DEPLOY_JOBS]) {
      expect(JSON.stringify(jobs[name]), name).not.toContain('github.sha');
    }
    expect(
      jobs['source-map-upload']!.steps.find((s) => s.env?.SENTRY_RELEASE !== undefined)?.env
        ?.SENTRY_RELEASE,
    ).toBe(GATE_SHA);
  });

  it.each(DEPLOY_JOBS)(
    'CRITICAL %s refuses to move its environment to an older commit before deploy-bridge.sh runs',
    (jobName) => {
      const steps = jobs[jobName]!.steps;
      const forward = steps.findIndex((s) => s.id === 'forward');
      const bridge = steps.findIndex((s) => /bash scripts\/deploy-bridge\.sh/.test(s.run ?? ''));
      expect(forward, 'no forward-only step').toBeGreaterThan(-1);
      expect(bridge, 'no deploy-bridge step').toBeGreaterThan(forward);
      const check = steps[forward]!;
      expect(check.run).toContain(
        `node scripts/deploy-is-forward.mjs --base-url ${BASE_URL[jobName]} --sha "$SHA"`,
      );
      expect(check.env?.SHA).toBe(GATE_SHA);
      // 0 deploys, 3 (already newer) skips, anything else fails the job.
      expect(check.run).toMatch(/0\) echo "proceed=true"/);
      expect(check.run).toMatch(/3\)[\s\S]*?proceed=false/);
      expect(check.run).toMatch(/\*\) exit "\$rc"/);
      expect(steps[bridge]!.if).toBe("steps.forward.outputs.proceed == 'true'");
      expect(steps[bridge]!.env?.SHA).toBe(GATE_SHA);
      expect(steps[bridge]!.run).toMatch(
        /^bash scripts\/deploy-bridge\.sh (staging|prod) "\$SHA"$/,
      );
    },
  );

  it('the forward-only check exists where the workflow calls it', () => {
    expect(existsSync(resolve(REPO_ROOT, 'scripts/deploy-is-forward.mjs'))).toBe(true);
  });

  it('CRITICAL post-deploy verification and auto-revert are kept: the bridge still verifies and reverts, and the workflow does not switch the revert off', () => {
    expect(BRIDGE).toMatch(/node scripts\/post-deploy-verify\.mjs --base-url "\$PUBLIC_URL"/);
    expect(BRIDGE).toMatch(/AUTO_REVERT=0 bash "\$SCRIPT_DIR\/revert-bridge\.sh" "\$ENV"/);
    for (const jobName of DEPLOY_JOBS) {
      for (const step of jobs[jobName]!.steps) {
        expect(step.env?.AUTO_REVERT, `${jobName}: ${step.name ?? '?'}`).toBeUndefined();
      }
    }
  });

  it('CRITICAL one deploy at a time, never cancelled mid-rollout, and QUEUED in arrival order rather than replaced', () => {
    expect(deploy.concurrency['cancel-in-progress']).toBe(false);
    // GitHub's default keeps ONE pending run per group and cancels it when the
    // next one queues. Every run used to be a newer push, so that was harmless;
    // CI completions are not, and a later arrival (a re-run of an old CI run that
    // then skips as older) silently cancelled the pending deploy of a newer green
    // commit. `max` queues them; deploy-is-forward makes an older one a no-op.
    expect(deploy.concurrency.queue).toBe('max');
    // The group expression is folded onto one line (a deeper-indented line in a
    // `>-` block keeps its newline).
    expect(deploy.concurrency.group).not.toContain('\n');
  });

  // The group is an expression, so it is EVALUATED here for each kind of event
  // that can start this workflow, alongside the ci-gate's own `if`.
  describe('a run that cannot deploy never joins the deploy queue', () => {
    const REPO = 'driftstack/driftstack-api';
    const runEvent = (over: Record<string, unknown>) => ({
      event_name: 'workflow_run',
      repository: REPO,
      ref: 'refs/heads/main',
      event: {
        workflow_run: {
          event: 'push',
          head_branch: 'main',
          head_repository: { full_name: REPO },
          conclusion: 'success',
          head_sha: 'a'.repeat(40),
          ...over,
        },
      },
    });
    const cases: Array<{ name: string; github: Record<string, unknown>; deploys: boolean }> = [
      { name: 'green CI on a push to main', github: runEvent({}), deploys: true },
      {
        name: 'a manual dispatch',
        github: { event_name: 'workflow_dispatch', repository: REPO, ref: 'refs/heads/main' },
        deploys: true,
      },
      { name: 'red CI on main', github: runEvent({ conclusion: 'failure' }), deploys: false },
      {
        name: 'cancelled (superseded) CI on main',
        github: runEvent({ conclusion: 'cancelled' }),
        deploys: false,
      },
      {
        name: "a fork's pull request from a branch it called main",
        github: runEvent({
          event: 'pull_request',
          head_repository: { full_name: 'someone/driftstack-api' },
        }),
        deploys: false,
      },
      {
        name: 'a pull request in this repository',
        github: runEvent({ event: 'pull_request', head_branch: 'feature' }),
        deploys: false,
      },
      {
        name: 'a push to main in a fork',
        github: runEvent({ head_repository: { full_name: 'someone/driftstack-api' } }),
        deploys: false,
      },
    ];

    it('POSITIVE CONTROL the evaluator reads these expressions as GitHub does', () => {
      const ctx = { github: { event_name: 'push', run_id: 5, event: { a: { b: 'Main' } } } };
      expect(evaluate("${{ github.event.a.b == 'main' }}", ctx)).toBe(true);
      expect(evaluate("github.event_name == 'push' && 'x' || 'y'", ctx)).toBe('x');
      expect(evaluate("github.event_name != 'push' && 'x' || 'y'", ctx)).toBe('y');
      expect(evaluate("format('g-{0}', github.run_id)", ctx)).toBe('g-5');
      expect(evaluate('github.event.missing.deeper', ctx)).toBeNull();
      expect(() => evaluate("contains(github.event_name, 'p')", ctx)).toThrow();
    });

    it.each(cases)('$name', ({ github, deploys }) => {
      const one = evaluate(deploy.concurrency.group, { github: { ...github, run_id: 101 } });
      const two = evaluate(deploy.concurrency.group, { github: { ...github, run_id: 102 } });
      if (deploys) {
        expect(one).toBe('deploy-api');
        expect(two).toBe('deploy-api');
      } else {
        // Its own group, unique to the run: it can neither wait behind a deploy
        // nor displace one.
        expect(one).not.toBe('deploy-api');
        expect(one).not.toBe(two);
        expect(String(one)).toContain('101');
      }
    });

    it('CRITICAL every run the ci-gate would let deploy is in the queue — the group never lets a deployable run out of it', () => {
      for (const { name, github } of cases) {
        const ctx = { github: { ...github, run_id: 7 } };
        const admitted = Boolean(evaluate(jobs['ci-gate']!.if!, ctx));
        const conclusion = (github.event as { workflow_run?: { conclusion?: string } } | undefined)
          ?.workflow_run?.conclusion;
        const canDeploy =
          admitted && (github.event_name === 'workflow_dispatch' || conclusion === 'success');
        expect(evaluate(deploy.concurrency.group, ctx) === 'deploy-api', name).toBe(canDeploy);
      }
    });
  });

  it('every needs.<job> and steps.<id> expression resolves inside its own job — a typo there evaluates to an empty string, not an error, and an empty sha or output silently skips the deploy', () => {
    for (const [name, job] of Object.entries(jobs)) {
      const text = JSON.stringify(job);
      for (const m of text.matchAll(/needs\.([a-z0-9-]+)\.outputs\.([a-z0-9_-]+)/g)) {
        expect(needsOf(job), `${name} reads needs.${m[1]} without needing it`).toContain(m[1]);
        expect(Object.keys(jobs[m[1]!]?.outputs ?? {}), `${m[1]} has no output ${m[2]}`).toContain(
          m[2],
        );
      }
      const ids = new Set(job.steps.map((s) => s.id).filter(Boolean));
      const outputs = JSON.stringify(job.outputs ?? {});
      for (const m of `${text}${outputs}`.matchAll(/steps\.([a-z0-9_-]+)\.outputs/g)) {
        expect(ids.has(m[1]), `${name} reads steps.${m[1]}, which is not a step id in it`).toBe(
          true,
        );
      }
    }
  });

  it('a red CI run on main raises the same deploy-failure alert as a failed deploy', () => {
    const notify = jobs['notify-on-failure']!;
    expect(notify.if).toBe('failure()');
    expect(needsOf(notify)).toEqual([
      'ci-gate',
      'source-map-upload',
      'deploy-staging',
      'deploy-production',
    ]);
  });
});

// The two scripts the gating rests on, EXECUTED — as GitHub runs a `run:` step
// (bash -eo pipefail) — with `gh` and `node` stubbed. A text pin can be satisfied
// by a script whose branches are wired to the wrong outputs; these cannot.
describe('the gate and forward-only steps, executed', { timeout: 30_000 }, () => {
  const SHA = 'a'.repeat(40);
  let dir: string;
  let bin: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ds-ci-gate-'));
    bin = join(dir, 'bin');
    mkdirSync(bin);
    // gh: answers the runs query with $STUB_RUNS and the compare with
    // $STUB_COMPARE, and records every call.
    writeFileSync(
      join(bin, 'gh'),
      '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$STUB_LOG"\ncase "$*" in\n  *compare*) echo "$STUB_COMPARE" ;;\n  *) echo "$STUB_RUNS" ;;\nesac\n',
    );
    // node: stands in for deploy-is-forward.mjs, exiting with $STUB_RC.
    writeFileSync(join(bin, 'node'), '#!/bin/sh\nexit "$STUB_RC"\n');
    chmodSync(join(bin, 'gh'), 0o755);
    chmodSync(join(bin, 'node'), 0o755);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function exec(
    script: string,
    env: Record<string, string>,
  ): { status: number; outputs: Record<string, string>; log: string; text: string } {
    const file = join(dir, 'step.sh');
    const out = join(dir, 'github_output');
    const log = join(dir, 'gh.log');
    writeFileSync(file, script);
    writeFileSync(out, '');
    writeFileSync(log, '');
    const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:/usr/bin:/bin`,
        GITHUB_OUTPUT: out,
        GITHUB_REPOSITORY: 'owner/repo',
        STUB_LOG: log,
        ...env,
      },
    });
    const outputs = Object.fromEntries(
      readFileSync(out, 'utf8')
        .split('\n')
        .filter((l) => l.includes('='))
        .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
    );
    return {
      status: r.status ?? -1,
      outputs,
      log: readFileSync(log, 'utf8'),
      text: `${r.stdout ?? ''}${r.stderr ?? ''}`,
    };
  }

  const gate = (env: Record<string, string>) =>
    exec(jobs['ci-gate']!.steps.find((s) => s.id === 'pick')!.run!, {
      STUB_RUNS: '1',
      STUB_COMPARE: 'ahead',
      ...env,
    });
  const run = (env: Record<string, string>) => ({
    EVENT_NAME: 'workflow_run',
    RUN_SHA: SHA,
    ...env,
  });

  it('POSITIVE CONTROL a successful CI run on main, confirmed by the API and on main, deploys exactly its commit', () => {
    const r = gate(run({ RUN_CONCLUSION: 'success' }));
    expect(r.status, r.text).toBe(0);
    expect(r.outputs).toEqual({ sha: SHA, deploy: 'true' });
    expect(r.log).toContain(`head_sha=${SHA} -f event=push -f branch=main -f status=success`);
    expect(r.log).toContain(`compare/${SHA}...main`);
  });

  it('CRITICAL a failed CI run FAILS the gate (so the alert fires) and names no commit', () => {
    for (const conclusion of ['failure', 'timed_out', 'startup_failure', 'action_required']) {
      const r = gate(run({ RUN_CONCLUSION: conclusion }));
      expect(r.status, conclusion).toBe(1);
      expect(r.outputs.deploy, conclusion).toBeUndefined();
      expect(r.outputs.sha, conclusion).toBeUndefined();
    }
  });

  it('a cancelled (superseded) CI run deploys nothing and does not fail', () => {
    const r = gate(run({ RUN_CONCLUSION: 'cancelled' }));
    expect(r.status).toBe(0);
    expect(r.outputs).toEqual({ deploy: 'false' });
  });

  it('CRITICAL the event alone is not trusted: no successful run on record for the commit refuses — and so does an answer that is not a number', () => {
    for (const answer of ['0', 'null', '', '{"message":"Not Found"}']) {
      const r = gate(run({ RUN_CONCLUSION: 'success', STUB_RUNS: answer }));
      expect(r.status, JSON.stringify(answer)).toBe(1);
      expect(r.outputs.deploy, JSON.stringify(answer)).toBeUndefined();
    }
  });

  it('CRITICAL a commit that is not on main is refused', () => {
    for (const relation of ['behind', 'diverged', '']) {
      const r = gate(run({ RUN_CONCLUSION: 'success', STUB_COMPARE: relation }));
      expect(r.status, relation).toBe(1);
      expect(r.outputs.deploy, relation).toBeUndefined();
    }
  });

  it('a manual dispatch deploys only from main, and only a commit with a green CI run', () => {
    const other = gate({
      EVENT_NAME: 'workflow_dispatch',
      DISPATCH_REF: 'refs/heads/feature',
      DISPATCH_SHA: SHA,
    });
    expect(other.status).toBe(1);
    expect(other.log).toBe('');

    const main = gate({
      EVENT_NAME: 'workflow_dispatch',
      DISPATCH_REF: 'refs/heads/main',
      DISPATCH_SHA: SHA,
      STUB_COMPARE: 'identical',
    });
    expect(main.status, main.text).toBe(0);
    expect(main.outputs).toEqual({ sha: SHA, deploy: 'true' });

    const red = gate({
      EVENT_NAME: 'workflow_dispatch',
      DISPATCH_REF: 'refs/heads/main',
      DISPATCH_SHA: SHA,
      STUB_RUNS: '0',
    });
    expect(red.status).toBe(1);
  });

  it.each(DEPLOY_JOBS)(
    '%s: forward deploys, already-newer skips cleanly, anything else fails',
    (jobName) => {
      const script = jobs[jobName]!.steps.find((s) => s.id === 'forward')!.run!;
      const forward = exec(script, { SHA, STUB_RC: '0' });
      expect(forward.status).toBe(0);
      expect(forward.outputs).toEqual({ proceed: 'true' });

      const older = exec(script, { SHA, STUB_RC: '3' });
      expect(older.status).toBe(0);
      expect(older.outputs).toEqual({ proceed: 'false' });

      const refused = exec(script, { SHA, STUB_RC: '1' });
      expect(refused.status).toBe(1);
      expect(refused.outputs).toEqual({});
    },
  );
});
