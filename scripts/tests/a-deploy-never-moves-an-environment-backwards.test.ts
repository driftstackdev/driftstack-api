// Security sweep E-9, remaining hardening (2026-09-24): "an older sha can never
// be deployed over a newer one".
//
// The deploy workflow now runs when CI completes on main, and CI completions do
// not arrive in commit order: a re-run of an old CI run finishes long after a
// newer commit went live, and would otherwise deploy the old commit over it.
// scripts/deploy-is-forward.mjs is the check each deploy job runs before it
// touches a host: read the commit the environment is serving from its public
// /version, and allow the deploy only when the candidate is that commit or a
// descendant of it — and is on main at all.
//
//   exit 0  forward (or the same commit again)   → deploy
//   exit 3  the environment already runs a newer commit → skip, not a failure
//   exit 1  anything it cannot prove safe (not on main, diverged, a live commit
//           outside this history, or an unreadable / unknown live commit
//           for anything but the tip of main)      → fail loudly
//
// Exercised against a real throwaway git repository and a local /version
// server; nothing leaves the machine.

import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const SCRIPT = resolve(REPO_ROOT, 'scripts/deploy-is-forward.mjs');

let repo: string;
let server: Server;
let baseUrl: string;
/** What /version reports; `null` makes it answer 503. */
let live: string | null = null;
const commits: Record<string, string> = {};

function git(...args: string[]): string {
  return execFileSync(
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
  ).trim();
}

function commit(label: string): string {
  git('commit', '--allow-empty', '--no-verify', '-q', '-m', label);
  const sha = git('rev-parse', 'HEAD');
  commits[label] = sha;
  return sha;
}

function run(args: string[]): Promise<{ status: number; output: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, [SCRIPT, ...args], { cwd: repo });
    let output = '';
    child.stdout.on('data', (d: Buffer) => (output += d.toString()));
    child.stderr.on('data', (d: Buffer) => (output += d.toString()));
    child.on('close', (code) => done({ status: code ?? -1, output }));
  });
}

const check = (candidate: string): Promise<{ status: number; output: string }> =>
  run(['--base-url', baseUrl, '--sha', candidate, '--main-ref', 'main', '--attempts', '1']);

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), 'ds-forward-'));
  git('init', '-q', '-b', 'main');
  commit('A');
  commit('B');
  commit('C');
  git('checkout', '-q', '-b', 'side', commits.A!);
  commit('S');
  git('checkout', '-q', 'main');

  server = createServer((req, res) => {
    if (req.url === '/version' && live !== null) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ version: '1.0.0', git_sha: live }));
      return;
    }
    res.writeHead(503);
    res.end();
  });
  await new Promise<void>((ready) => server.listen(0, '127.0.0.1', ready));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((closed) => server.close(() => closed()));
  rmSync(repo, { recursive: true, force: true });
});

describe('a deploy never moves an environment backwards', { timeout: 30_000 }, () => {
  it('POSITIVE CONTROL a newer commit on main deploys over the one that is live (short sha on /version, as production reports it)', async () => {
    live = commits.A!.slice(0, 7);
    const { status, output } = await check(commits.C!);
    expect(status, output).toBe(0);
  });

  it('the same commit again is allowed — a re-run of a deploy that failed half way must be able to finish', async () => {
    live = commits.C!.slice(0, 7);
    const { status, output } = await check(commits.C!);
    expect(status, output).toBe(0);
  });

  it('CRITICAL an older commit is never deployed over a newer one: exit 3, a skip the workflow reports as a notice', async () => {
    live = commits.C!.slice(0, 7);
    const { status, output } = await check(commits.B!);
    expect(status, output).toBe(3);
    expect(output).toMatch(/older/i);
  });

  it('CRITICAL a commit that is not on main is refused', async () => {
    live = commits.A!.slice(0, 7);
    const { status, output } = await check(commits.S!);
    expect(status, output).toBe(1);
    expect(output).toMatch(/not on main/i);
  });

  it('CRITICAL a live commit that is neither an ancestor nor a descendant (history rewritten, or a hand deploy) is refused rather than guessed', async () => {
    live = commits.S!.slice(0, 7);
    const { status, output } = await check(commits.C!);
    expect(status, output).toBe(1);
    expect(output).toMatch(/diverged/i);
  });

  it('CRITICAL an environment that cannot say what it runs is refused for anything but the tip of main: unreadable or "unknown"', async () => {
    // B is on main but not its tip; it may well be older than what is running.
    live = null;
    expect((await check(commits.B!)).status).toBe(1);
    live = 'unknown';
    expect((await check(commits.B!)).status).toBe(1);
  });

  it('CRITICAL an environment that cannot say what it runs still takes the TIP of main: nothing on main is newer, and this is the automatic fix-forward for a broken environment (dr-runbook Scenario 7)', async () => {
    live = null;
    const down = await check(commits.C!);
    expect(down.status, down.output).toBe(0);
    expect(down.output).toMatch(/tip of main/i);
    live = 'unknown';
    const unknown = await check(commits.C!);
    expect(unknown.status, unknown.output).toBe(0);
  });

  it('CRITICAL a live commit this history does not contain is refused even for the tip: somebody deployed it by hand, and a person decides', async () => {
    live = 'deadbee';
    const { status, output } = await check(commits.C!);
    expect(status, output).toBe(1);
    expect(output).toMatch(/not in this repository's history/);
  });

  it('a candidate that is not a commit id is refused before anything else runs', async () => {
    live = commits.A!.slice(0, 7);
    const { status } = await check('main; id');
    expect(status).toBe(1);
  });
});

// When the check refuses, a person deploys by hand; the runbooks must say how,
// and must not send them to a workflow that no longer deploys production.
describe('the runbooks say what to do when the forward-only check refuses', () => {
  const read = (p: string): string => readFileSync(resolve(REPO_ROOT, p), 'utf8');
  const scenario7 = (): string => {
    const dr = read('docs/deployment/dr-runbook.md');
    const start = dr.indexOf('### Scenario 7');
    return dr.slice(start, dr.indexOf('### Scenario 8', start));
  };

  it('dr-runbook Scenario 7: the revert goes out through deploy.yml after CI, and by hand when that is too slow', () => {
    const s = scenario7().replace(/\s+/g, ' ');
    expect(s).toContain('`.github/workflows/deploy.yml`');
    expect(s).toContain('It waits for that CI run');
    expect(s).toContain('DEPLOY_VIA_BUNDLE=1 bash scripts/deploy-bridge.sh prod <revert-sha>');
    expect(s).toContain('bash scripts/revert-bridge.sh prod');
    // server-deploy.yml is the dormant tag workflow; it deploys nothing on a push.
    expect(s).not.toMatch(/server-deploy\.yml` runs on the push/);
    expect(s).not.toContain('git checkout <revert-sha>');
  });

  it('the deploy-bridge runbook names the manual deploy for a commit the workflow refused', () => {
    const s = read('docs/runbooks/deploy-bridge.md').replace(/\s+/g, ' ');
    expect(s).toContain('only the current tip of main deploys automatically');
    expect(s).toContain('DEPLOY_VIA_BUNDLE=1 bash scripts/deploy-bridge.sh prod <sha>');
  });
});
