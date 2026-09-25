// Security sweep E-10 (2026-09-24) — the GUI release job holds the updater signing
// key and a contents:write token, and the GitHub release it writes IS the updater
// endpoint: a signed build plus write access there reaches every installed client.
// It ran third-party actions pinned to movable refs (a branch and two major tags),
// and its checkout left the token in .git/config for every later step, including
// dependency install scripts. A tag or branch can be moved by its owner; a commit
// SHA cannot. Every `uses:` in the release workflow is pinned to a full SHA, and the
// checkout does not persist credentials (every step that needs the token takes it
// from env).
//
// ── the key never meets the build ─────────────────────────────────────────────
//
// Pinning bounds WHICH code runs; it does not bound what that code can reach. The
// key sat in the env of the tauri-action step, and that step runs every npm build
// plugin and every cargo build.rs the app depends on — hundreds of packages, any
// one of which could read `TAURI_SIGNING_PRIVATE_KEY` and sign whatever it liked.
// All steps of a job share one runner, so an earlier step could also tamper with a
// later one.
//
// So the key now lives in exactly ONE step: a run step in the `sign` job, which
// builds nothing. The arms below assert the property rather than the layout — no
// step, job or workflow-level env anywhere else may name the key; the step that
// holds it runs no build tool and no action; its job runs only first-party
// actions; and the build job holds neither the key nor a write token. Each checker
// is also run against a copy of the workflow with the defect put back, so a
// checker that stopped seeing anything cannot pass quietly.
//
// One step holding the key is not enough on its own: the runner holds every secret
// of the job for the whole job, so nothing the BUILD wrote may run anywhere in the
// sign job. That half is tested by running the steps against planted files, in
// the-sign-job-runs-nothing-the-build-left-beside-its-bundles.test.ts.
//
// ── a dry run can never publish ───────────────────────────────────────────────
//
// A manual dispatch builds and signs every platform and uploads workflow artifacts
// only. Every step that writes to a release sits in a job that runs on a tag push
// and nothing else, and no input can change that.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, '..', '..', '..', '..', '.github', 'workflows', 'gui-release.yml');
const body = readFileSync(WORKFLOW, 'utf8');

/** Either spelling of the signing key: the repo secret or the env name tauri reads. */
const KEY = /TAURI_UPDATER_PRIVKEY|TAURI_SIGNING_PRIVATE_KEY/g;
/** A command that builds, installs or runs project code. */
const BUILDS =
  /\b(npm (run|exec|start|test|rebuild)|npx|yarn|pnpm|bun|cargo|rustup|tauri build|make|pip3? install)\b/;
/** A step that writes to a GitHub release. */
const WRITES_RELEASE =
  /gh release (upload|edit|create|delete)|gh api\b[^\n]*(-X|--method)\s*(POST|PATCH|PUT|DELETE)/;

/** The text with comment-only lines removed: a comment naming the key holds nothing. */
const code = (text: string): string =>
  text
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

/** The lines that run something: an `echo` telling a person what to run runs nothing. */
const commands = (text: string): string =>
  code(text)
    .split('\n')
    .filter((l) => !/^\s*(echo|printf)\b/.test(l))
    .join('\n');

const count = (text: string, re: RegExp): number => [...text.matchAll(re)].length;

/** Each job's text, keyed by job id (the workflow's own two-space layout). */
function jobsOf(src: string): Map<string, string> {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const out = new Map<string, string>();
  if (start < 0) return out;
  let name: string | null = null;
  let buf: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const job = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (job) {
      if (name !== null) out.set(name, buf.join('\n'));
      name = job[1]!;
      buf = [];
      continue;
    }
    if (/^\S/.test(line) && !line.startsWith('#')) break;
    if (name !== null) buf.push(line);
  }
  if (name !== null) out.set(name, buf.join('\n'));
  return out;
}

/** A job's steps, each as its own text block. */
function stepsOf(job: string): string[] {
  const lines = job.split('\n');
  const at = lines.findIndex((l) => /^ {4}steps:\s*$/.test(l));
  const out: string[] = [];
  if (at < 0) return out;
  let buf: string[] | null = null;
  for (const line of lines.slice(at + 1)) {
    if (/^ {6}- /.test(line)) {
      if (buf) out.push(buf.join('\n'));
      buf = [line];
      continue;
    }
    if (/^ {0,5}\S/.test(line) && !/^\s*#/.test(line)) break;
    if (buf) buf.push(line);
  }
  if (buf) out.push(buf.join('\n'));
  return out;
}

const usesOf = (text: string): string[] =>
  [...code(text).matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]!);

/** Every way the signing key could reach code other than the signer. */
function keyIsolationProblems(src: string): string[] {
  const problems: string[] = [];
  const jobs = jobsOf(src);
  const holders: { job: string; step: string }[] = [];
  let inSteps = 0;
  for (const [job, text] of jobs) {
    for (const step of stepsOf(text)) {
      const n = count(code(step), KEY);
      inSteps += n;
      if (n > 0) holders.push({ job, step });
    }
  }
  const everywhere = count(code(src), KEY);
  if (everywhere > inSteps) {
    problems.push(
      `the key is named ${everywhere - inSteps} time(s) outside any step — a workflow- or job-level env hands it to every step`,
    );
  }
  if (/toJSON\(\s*secrets\s*\)|secrets\[|secrets:\s*inherit/.test(code(src))) {
    problems.push(
      'the workflow reads secrets dynamically, which can reach the key by another name',
    );
  }
  if (holders.length !== 1 || holders[0]!.job !== 'sign') {
    problems.push(
      `the key must be in exactly one step, in the sign job; it is in: ${holders.map((h) => h.job).join(', ') || 'none'}`,
    );
  }
  for (const { job, step } of holders) {
    if (usesOf(step).length > 0) {
      problems.push(`${job}: the step holding the key runs an action (${usesOf(step).join(', ')})`);
    }
    if (BUILDS.test(code(step))) {
      problems.push(`${job}: the step holding the key runs a build or install command`);
    }
    if (!/signer sign/.test(code(step))) {
      problems.push(`${job}: the step holding the key does not sign with \`tauri signer sign\``);
    }
  }
  const sign = jobs.get('sign') ?? '';
  const foreign = usesOf(sign).filter(
    (u) =>
      !/^actions\/(checkout|setup-node|download-artifact|upload-artifact)@[0-9a-f]{40}$/.test(u),
  );
  if (foreign.length > 0) {
    problems.push(`the sign job runs a non-first-party action: ${foreign.join(', ')}`);
  }
  if (BUILDS.test(code(sign))) {
    problems.push('the sign job runs a build command');
  }
  const installs = [...code(sign).matchAll(/npm (ci|install|i)\b[^\n]*/g)].map((m) => m[0]);
  if (installs.some((l) => !l.includes('--ignore-scripts'))) {
    problems.push('the sign job installs packages with their install scripts enabled');
  }
  if (!/sparse-checkout:/.test(sign)) {
    problems.push('the sign job checks out the whole repo rather than only the lockfile it needs');
  }
  const build = jobs.get('build') ?? '';
  if (count(code(build), KEY) > 0) problems.push('the build job names the key');
  if (
    !/permissions:\s*\n\s+contents:\s*read\b/.test(build) ||
    /contents:\s*write/.test(code(build))
  ) {
    problems.push('the build job does not hold a read-only token');
  }
  if (/secrets\.GITHUB_TOKEN/.test(code(build))) problems.push('the build job takes the token');
  if (!/--no-sign\b/.test(code(build))) {
    problems.push('the build does not pass --no-sign, so tauri demands the key it must not have');
  }
  for (const [job, text] of jobs) {
    if (!/contents:\s*write/.test(code(text))) continue;
    const actions = usesOf(text).filter((u) => !/^actions\//.test(u));
    if (
      actions.length > 0 ||
      BUILDS.test(code(text)) ||
      /\bnpm (ci|install|i)\b/.test(code(text))
    ) {
      problems.push(`${job} holds a write token and runs third-party or build code`);
    }
  }
  return problems;
}

/** Every way a manual dry run could reach a release. */
function dryRunProblems(src: string): string[] {
  const problems: string[] = [];
  const on = /^on:\s*\n([\s\S]*?)^\S/m.exec(src)?.[1] ?? '';
  const triggers = [...code(on).matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  if (JSON.stringify(triggers) !== JSON.stringify(['push', 'workflow_dispatch'])) {
    problems.push(`triggers are ${triggers.join(', ')}; expected a tag push and a manual dry run`);
  }
  if (/inputs:/.test(code(on))) {
    problems.push('the manual dispatch takes inputs — none may be able to turn publishing on');
  }
  let writers = 0;
  for (const [job, text] of jobsOf(src)) {
    const writes = stepsOf(text).filter((s) => WRITES_RELEASE.test(commands(s)));
    writers += writes.length;
    if (writes.length > 0 && !/^ {4}if:\s*github\.event_name == 'push'\s*$/m.test(text)) {
      problems.push(`${job} writes to a release but is not confined to a tag push`);
    }
  }
  if (writers === 0)
    problems.push('no step writes to a release at all — this checker sees nothing');
  return problems;
}

describe('the release job pins every action to a commit and keeps no token on disk', () => {
  const uses = [...body.matchAll(/^\s*(?:-\s+)?uses:\s*(\S+)/gm)].map((m) => m[1]!);

  it('reads the workflow it guards — at least the five actions the job runs', () => {
    expect(uses.length).toBeGreaterThanOrEqual(5);
  });

  it('CRITICAL every action is pinned to a full 40-hex commit SHA, never a tag or branch', () => {
    const movable = uses.filter((u) => !u.startsWith('./') && !/@[0-9a-f]{40}$/.test(u));
    expect(movable).toEqual([]);
  });

  it('CRITICAL the checkout does not persist the token for later steps', () => {
    expect(body).toMatch(
      /uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n\s+with:\n\s+persist-credentials:\s*false/,
    );
    // Every checkout, not only the first one.
    const checkouts = [
      ...body.matchAll(/uses:\s*actions\/checkout@[0-9a-f]{40}[^\n]*\n((?:\s+[^\n]*\n){1,4})/g),
    ];
    expect(checkouts.length).toBeGreaterThan(0);
    for (const c of checkouts) expect(c[1]).toMatch(/persist-credentials:\s*false/);
  });
});

describe('the updater signing key is held by one signing step and never by a build', () => {
  it('reads the jobs and steps it guards', () => {
    const jobs = jobsOf(body);
    expect([...jobs.keys()]).toEqual(
      expect.arrayContaining(['preflight', 'build', 'sign', 'publish-manifest']),
    );
    expect(stepsOf(jobs.get('build') ?? '').length).toBeGreaterThanOrEqual(10);
    expect(stepsOf(jobs.get('sign') ?? '').length).toBeGreaterThanOrEqual(4);
  });

  it('CRITICAL the key reaches exactly one step: a run step in the sign job that builds nothing, in a job that runs only first-party actions; the build job holds neither the key nor a write token', () => {
    expect(keyIsolationProblems(body)).toEqual([]);
  });

  it('CONTROL the checker sees the key put back into the build step', () => {
    const leaked = body.replace(
      /(uses: tauri-apps\/tauri-action@[0-9a-f]{40}[^\n]*\n\s+env:\n)/,
      '$1          TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_UPDATER_PRIVKEY }}\n',
    );
    expect(leaked).not.toBe(body);
    expect(keyIsolationProblems(leaked).join('\n')).toMatch(/build job names the key/);
  });

  it('CONTROL the checker sees the key lifted to job-level env, where every step of the job would get it', () => {
    const lifted = body.replace(
      /^( {2}sign:\n)/m,
      '$1    env:\n      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_UPDATER_PRIVKEY }}\n',
    );
    expect(lifted).not.toBe(body);
    expect(keyIsolationProblems(lifted).join('\n')).toMatch(/outside any step/);
  });

  it('CONTROL the checker sees a build command added to the signing step', () => {
    const building = body.replace(/(\n\s+)(.*signer sign)/, '$1npm run build$1$2');
    expect(building).not.toBe(body);
    expect(keyIsolationProblems(building).join('\n')).toMatch(/runs a build or install command/);
  });
});

describe('a manual dry run builds and signs but can never publish', () => {
  it('CRITICAL the only triggers are a gui-v* tag push and an input-less manual dispatch, and every step that writes to a release runs on a tag push only', () => {
    expect(dryRunProblems(body)).toEqual([]);
  });

  it('CRITICAL the dry run still signs: the sign job is not confined to tag pushes, and it keeps the signed set as a workflow artifact', () => {
    const sign = jobsOf(body).get('sign') ?? '';
    expect(sign).not.toMatch(/^ {4}if:/m);
    expect(sign).toMatch(/uses: actions\/upload-artifact@[0-9a-f]{40}/);
  });

  it('CONTROL the checker sees the publish job lose its tag-push guard', () => {
    const unguarded = body.replace(/^ {4}if:\s*github\.event_name == 'push'\s*\n/m, '');
    expect(unguarded).not.toBe(body);
    expect(dryRunProblems(unguarded).join('\n')).toMatch(/not confined to a tag push/);
  });
});
