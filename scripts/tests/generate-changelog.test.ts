// V-664 — regression tests for scripts/generate-changelog.sh.
//
// V-544 shipped the script without tests; this slice adds them. The
// script walks `git log` between two refs and emits a markdown or
// plain-text bullet list. We invoke it via spawnSync against a
// temporary git repo so the tests are hermetic + deterministic.
//
// Test design: each test creates a fresh disposable git repo in
// $tmpdir, commits a known sequence of subjects, then invokes the
// script and asserts on its stdout.

import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const SCRIPT_PATH = resolve(__dirname, '..', 'generate-changelog.sh');

interface Repo {
  dir: string;
  cleanup: () => void;
  commit: (subject: string) => string;
  ref: (revspec: string) => string;
}

function makeRepo(): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'v664-changelog-test-'));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  execFileSync('git', ['config', 'user.email', 'dev@driftstack.dev'], { cwd: dir });
  execFileSync('git', ['config', 'user.name', 'Driftstack'], { cwd: dir });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: dir });
  // Seed commit so we have a base to range against.
  writeFileSync(join(dir, 'README.md'), 'seed\n');
  execFileSync('git', ['add', 'README.md'], { cwd: dir });
  execFileSync('git', ['commit', '-q', '-m', 'seed'], { cwd: dir });

  let counter = 0;
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    commit(subject: string) {
      counter += 1;
      writeFileSync(join(dir, `file-${String(counter)}.txt`), String(counter));
      execFileSync('git', ['add', `file-${String(counter)}.txt`], { cwd: dir });
      execFileSync('git', ['commit', '-q', '-m', subject], { cwd: dir });
      return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim();
    },
    ref(revspec: string) {
      return execFileSync('git', ['rev-parse', revspec], { cwd: dir }).toString().trim();
    },
  };
}

function runScript(
  repo: Repo,
  args: readonly string[],
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync('bash', [SCRIPT_PATH, ...args], { cwd: repo.dir, encoding: 'utf8' });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? -1,
  };
}

describe('V-664 generate-changelog.sh — basic argument handling', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('exits non-zero without arguments', () => {
    const r = runScript(repo, []);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('Usage');
  });

  it('exits non-zero with one argument', () => {
    const r = runScript(repo, ['HEAD']);
    expect(r.status).not.toBe(0);
  });

  it('exits non-zero when --format is invalid', () => {
    const r = runScript(repo, ['HEAD~0', 'HEAD', '--format', 'banana']);
    expect(r.status).not.toBe(0);
  });

  it('exits non-zero when from-ref does not resolve', () => {
    const r = runScript(repo, ['no-such-ref', 'HEAD']);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('does not resolve');
  });
});

describe('V-664 generate-changelog.sh — md output format', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('emits markdown header with short SHA + ISO date', () => {
    const base = repo.ref('HEAD');
    repo.commit('plain commit');
    const r = runScript(repo, [base, 'HEAD']);
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^## [0-9a-f]{7,12} \(\d{4}-\d{2}-\d{2}\)/);
  });

  it('emits one bullet per non-wave commit', () => {
    const base = repo.ref('HEAD');
    repo.commit('docs: tweak README');
    repo.commit('chore: bump dep');
    const r = runScript(repo, [base, 'HEAD']);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('-'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('docs: tweak README');
    expect(lines[1]).toContain('chore: bump dep');
  });

  it('splits a wave-commit subject into one bullet per V-NNN', () => {
    const base = repo.ref('HEAD');
    repo.commit('V-100 / V-200: wave 5 — example slice combo');
    const r = runScript(repo, [base, 'HEAD']);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('-'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('V-100');
    expect(lines[0]).toContain('example slice combo');
    expect(lines[1]).toContain('V-200');
    expect(lines[1]).toContain('example slice combo');
  });

  it('respects sub-slice suffixes (V-NNN.X) in wave commits', () => {
    const base = repo.ref('HEAD');
    repo.commit('V-530.A / V-531.B: wave 7 — sub-slice combo');
    const r = runScript(repo, [base, 'HEAD']);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('-'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('V-530.A');
    expect(lines[1]).toContain('V-531.B');
  });

  it('outputs the "no commits in range" line when range is empty', () => {
    const base = repo.ref('HEAD');
    const r = runScript(repo, [base, 'HEAD']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('No commits in range');
  });

  it('preserves chronological ordering (oldest first)', () => {
    const base = repo.ref('HEAD');
    repo.commit('first commit');
    repo.commit('second commit');
    repo.commit('third commit');
    const r = runScript(repo, [base, 'HEAD']);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('-'));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('first commit');
    expect(lines[1]).toContain('second commit');
    expect(lines[2]).toContain('third commit');
  });
});

describe('V-664 generate-changelog.sh — plain output format', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('skips the markdown header in plain format', () => {
    const base = repo.ref('HEAD');
    repo.commit('plain commit');
    const r = runScript(repo, [base, 'HEAD', '--format', 'plain']);
    expect(r.status).toBe(0);
    expect(r.stdout.startsWith('##')).toBe(false);
  });

  it('emits one line per V-NNN with --format=plain', () => {
    const base = repo.ref('HEAD');
    repo.commit('V-300 / V-400: wave 1 — plain slice');
    const r = runScript(repo, [base, 'HEAD', '--format=plain']);
    const lines = r.stdout.trim().split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('V-300');
    expect(lines[0]).toContain('plain slice');
  });
});

describe('V-664 generate-changelog.sh — merge-commit handling', () => {
  let repo: Repo;

  beforeEach(() => {
    repo = makeRepo();
  });
  afterEach(() => {
    repo.cleanup();
  });

  it('skips merge commits', () => {
    const base = repo.ref('HEAD');
    repo.commit('linear commit on main');
    // Create a side branch with a commit, then merge with --no-ff to
    // force a merge commit.
    execFileSync('git', ['checkout', '-q', '-b', 'feature'], { cwd: repo.dir });
    repo.commit('feature commit');
    execFileSync('git', ['checkout', '-q', 'main'], { cwd: repo.dir });
    execFileSync('git', ['merge', '-q', '--no-ff', '--no-edit', 'feature'], { cwd: repo.dir });

    const r = runScript(repo, [base, 'HEAD']);
    const lines = r.stdout.split('\n').filter((l) => l.startsWith('-'));
    // Linear + feature commit are real; merge commit must NOT appear.
    expect(lines.some((l) => l.includes('Merge branch'))).toBe(false);
    expect(lines.some((l) => l.includes('linear commit'))).toBe(true);
    expect(lines.some((l) => l.includes('feature commit'))).toBe(true);
  });
});
