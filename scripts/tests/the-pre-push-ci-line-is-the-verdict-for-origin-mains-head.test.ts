// W-34, follow-up (gui-v0.1.72 release, 2026-09-25): the pre-push hook printed
// "→ CI on origin/main: green (7172d0cc5)" — the verdict of a run from 09-22 —
// while origin/main was at c2be2354b and its own CI run had no verdict yet.
//
// The mechanism: the hook asked for the eight most recent CI runs on main and
// printed the first one that carried a verdict. Pushes supersede in-flight runs
// (they end `cancelled`), and the head's own run is still going while the next
// push lands, so "the newest run with a verdict" is routinely a run for some
// OLDER commit — reported, under the label "CI on origin/main", as if it were
// the head's.
//
// The line now answers for ONE commit: the one at the head of origin/main, read
// from GitHub at the moment of the push. Its run's verdict, or — when it has
// none yet, was cancelled, or does not exist — a plain "no verdict" that is
// never a green. Advisory as before: every state exits 0.
//
// Exercised by running the hook's own CI block (sliced out of .husky/pre-push,
// so the test follows whatever the hook actually runs) with a stand-in `gh` on
// PATH. Nothing leaves the machine.

import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const HOOK = readFileSync(resolve(REPO_ROOT, '.husky', 'pre-push'), 'utf8');
/** The hook's CI block, from its W-34 marker to (not including) the final line. */
const BLOCK = HOOK.slice(HOOK.indexOf('# W-34'), HOOK.indexOf('echo "✓ pre-push gate clean"'));

const HEAD = 'c2be2354b8f1e4d7a0c3b6e9f2a5d8c1b4e7f0a3';
const OLDER = '7172d0cc5a1b2c3d4e5f60718293a4b5c6d7e8f9';
const PARENT = '0b0b6badd0e1f2a3b4c5d6e7f8091a2b3c4d5e6f';

interface Run {
  headSha: string;
  status: string;
  conclusion: string;
  createdAt: string;
  databaseId: number;
}

/** The runs on main, newest first, as `gh run list` returns them. */
function runs(head: Pick<Run, 'status' | 'conclusion'> | null): Run[] {
  const list: Run[] = [];
  if (head !== null) {
    list.push({ headSha: HEAD, createdAt: '2026-09-25T04:20:00Z', databaseId: 900, ...head });
  }
  list.push(
    {
      headSha: PARENT,
      status: 'completed',
      conclusion: 'cancelled',
      createdAt: '2026-09-25T03:10:00Z',
      databaseId: 899,
    },
    {
      headSha: OLDER,
      status: 'completed',
      conclusion: 'success',
      createdAt: '2026-09-22T11:00:00Z',
      databaseId: 850,
    },
  );
  return list;
}

let stubDir: string;

beforeAll(() => {
  stubDir = mkdtempSync(join(tmpdir(), 'ds-ci-line-'));
  // A stand-in `gh`. It answers the two reads a CI check can make — the head of
  // main, and the CI runs on main (filtered by `--commit` and cut to `--limit`
  // the way gh does) — from STUB_* variables, and runs `--jq` through the real
  // jq when one is asked for, so the block is exercised as written whichever
  // form it takes.
  const gh = join(stubDir, 'gh');
  writeFileSync(
    gh,
    `#!/usr/bin/env node
const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (process.env.STUB_GH_FAIL === '1') { process.stderr.write('gh: offline\\n'); process.exit(1); }
const flag = (name) => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1]; };
let out;
if (args[0] === 'api') {
  if (!/repos\\/[^/]+\\/[^/]+\\/commits\\/main$/.test(args[1] ?? '')) { process.stderr.write('unexpected api path ' + args[1]); process.exit(2); }
  out = process.env.STUB_API_BODY ?? JSON.stringify({ sha: process.env.STUB_HEAD });
} else if (args[0] === 'run' && args[1] === 'list') {
  let list = JSON.parse(process.env.STUB_RUNS ?? '[]');
  const commit = flag('--commit') ?? flag('-c');
  if (commit !== undefined) list = list.filter((r) => r.headSha === commit);
  list = list.slice(0, Number(flag('--limit') ?? flag('-L') ?? 20));
  out = JSON.stringify(list);
} else { process.stderr.write('unexpected gh call: ' + args.join(' ')); process.exit(2); }
const jq = flag('--jq') ?? flag('-q');
if (jq !== undefined) out = execFileSync('jq', ['-r', jq], { input: out, encoding: 'utf8' });
process.stdout.write(out.endsWith('\\n') ? out : out + '\\n');
`,
  );
  chmodSync(gh, 0o755);
});

afterAll(() => {
  rmSync(stubDir, { recursive: true, force: true });
});

function ciBlock(env: Record<string, string>): { status: number; output: string } {
  const r = spawnSync('sh', ['-c', BLOCK], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: 30_000,
    env: {
      PATH: `${stubDir}:${process.env.PATH ?? ''}`,
      HOME: process.env.HOME ?? stubDir,
      STUB_HEAD: HEAD,
      ...env,
    },
  });
  return { status: r.status ?? -1, output: `${r.stdout}${r.stderr}` };
}

describe('the pre-push CI line is the verdict for the head of origin/main', () => {
  it('VACUITY CONTROL — the block was found in the real hook', () => {
    expect(BLOCK.length).toBeGreaterThan(200);
    expect(BLOCK).toContain('DRIFTSTACK_SKIP_CI_CHECK');
  });

  it("CRITICAL the head's run is still going: it says there is no verdict yet — never an older run's green under origin/main's name", () => {
    const { status, output } = ciBlock({
      STUB_RUNS: JSON.stringify(runs({ status: 'in_progress', conclusion: '' })),
    });
    expect(status, output).toBe(0);
    expect(output).toContain(HEAD.slice(0, 9));
    expect(output).toMatch(/no verdict yet/i);
    expect(output).toMatch(/Not a green/);
    expect(output).not.toMatch(/green \(/);
    expect(output, 'an older commit was reported as origin/main').not.toContain(OLDER.slice(0, 9));
  });

  it("the head's run passed: green, naming the head", () => {
    const { status, output } = ciBlock({
      STUB_RUNS: JSON.stringify(runs({ status: 'completed', conclusion: 'success' })),
    });
    expect(status, output).toBe(0);
    expect(output).toContain(`→ CI on origin/main: green (${HEAD.slice(0, 9)})`);
  });

  it("CRITICAL the head's run failed: the red warning, naming the head, and still never blocking", () => {
    for (const conclusion of ['failure', 'timed_out']) {
      const { status, output } = ciBlock({
        STUB_RUNS: JSON.stringify(runs({ status: 'completed', conclusion })),
      });
      expect(status, output).toBe(0);
      expect(output).toContain(`CI on origin/main is currently: ${conclusion}`);
      expect(output).toContain(HEAD.slice(0, 9));
      expect(output).toMatch(/verify-suite/);
    }
  });

  it("the head's run was cancelled (a newer push superseded it): no verdict, said plainly", () => {
    const { status, output } = ciBlock({
      STUB_RUNS: JSON.stringify(runs({ status: 'completed', conclusion: 'cancelled' })),
    });
    expect(status, output).toBe(0);
    expect(output).toContain(HEAD.slice(0, 9));
    expect(output).toMatch(/no verdict/i);
    expect(output).toMatch(/cancelled/);
    expect(output).toMatch(/Not a green/);
    expect(output).not.toContain(OLDER.slice(0, 9));
  });

  it('the head has no CI run at all yet: no verdict, said plainly', () => {
    const { status, output } = ciBlock({ STUB_RUNS: JSON.stringify(runs(null)) });
    expect(status, output).toBe(0);
    expect(output).toContain(HEAD.slice(0, 9));
    expect(output).toMatch(/no CI run/i);
    expect(output).toMatch(/Not a green/);
    expect(output).not.toContain(OLDER.slice(0, 9));
  });

  it('CRITICAL gh unavailable, or the head unreadable: COULD NOT CHECK, never silent, never green', () => {
    const unreadable: ReadonlyArray<Record<string, string>> = [
      { STUB_GH_FAIL: '1' },
      { STUB_API_BODY: '{"message":"Not Found"}' },
      { STUB_API_BODY: 'not json at all' },
    ];
    for (const env of unreadable) {
      const { status, output } = ciBlock({
        ...env,
        STUB_RUNS: JSON.stringify(runs({ status: 'completed', conclusion: 'success' })),
      });
      expect(status, output).toBe(0);
      expect(output).toMatch(/COULD NOT CHECK/);
      expect(output).toMatch(/Not a green/);
      expect(output).not.toMatch(/: green/);
    }
  });

  it('DRIFTSTACK_SKIP_CI_CHECK=1 skips the check entirely', () => {
    const { status, output } = ciBlock({
      DRIFTSTACK_SKIP_CI_CHECK: '1',
      STUB_RUNS: JSON.stringify(runs({ status: 'completed', conclusion: 'failure' })),
    });
    expect(status, output).toBe(0);
    expect(output.trim()).toBe('');
  });
});
