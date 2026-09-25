// Security sweep E-22 (2026-09-24). scripts/deploy-bridge.sh runs its remote
// half as ROOT on the host that holds every production secret, and it trusted
// things the service account (driftstack) could write:
//
//   • root `source`d /opt/driftstack/api/.env — a driftstack-owned file — as
//     shell, so anyone able to write it ran code as root at the next deploy;
//   • root read .last-good-sha (driftstack-owned) and spliced it, unvalidated,
//     into a root shell command (the deploy-history write here, and
//     `git checkout '$SHA'` via revert-bridge.sh);
//   • root built in the predictable /tmp/driftstack-deploy-<unix-time> and wrote
//     fixed /tmp/deploy-*.log paths;
//   • root chowned/appended through paths inside a driftstack-owned directory,
//     where a planted symlink redirects the write.
//
// This runs the REAL scripts with ssh, scp, node, curl, git and python3
// stubbed. The ssh stub records the remote command it was handed and never
// connects anywhere, so the assertions read exactly what root would have run.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const BRIDGE = resolve(REPO_ROOT, 'scripts/deploy-bridge.sh');
const REVERT = resolve(REPO_ROOT, 'scripts/revert-bridge.sh');

const GOOD_SHA = '0123456789abcdef0123456789abcdef01234567';
/** What a driftstack foothold would plant in .last-good-sha. */
const HOSTILE = "abc1234'; touch /root/owned; echo '";

let root: string;
let stubs: string;
let records: string;

function stub(name: string, body: string): void {
  const path = join(stubs, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

/** Every remote command root was handed, in order (the last ssh argument). */
function remoteCommands(): string[] {
  return readdirSync(records)
    .filter((f) => f.startsWith('ssh-'))
    .sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)))
    .map((f) => (JSON.parse(readFileSync(join(records, f), 'utf8')) as string[]).at(-1) ?? '');
}

function run(script: string, args: string[]): { status: number; output: string } {
  const r = spawnSync('bash', [script, ...args], {
    encoding: 'utf8',
    cwd: root,
    env: {
      PATH: `${stubs}:/usr/bin:/bin`,
      HOME: root,
      RECORDS: records,
      LAST_GOOD_REPLY: HOSTILE,
    },
  });
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Each case spawns bash (and, for the revert cases, bash again); generous on a loaded runner.
describe(
  'the root deploy trusts nothing the service account can write',
  { timeout: 30_000 },
  () => {
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'ds-bridge-'));
      stubs = join(root, 'bin');
      records = join(root, 'records');
      mkdirSync(stubs);
      mkdirSync(records);
      // ssh: record argv; answer the .last-good-sha read with the hostile value.
      stub(
        'ssh',
        `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const argv = process.argv.slice(2);
const n = fs.readdirSync(process.env.RECORDS).filter((f) => f.startsWith('ssh-')).length;
fs.writeFileSync(path.join(process.env.RECORDS, 'ssh-' + n), JSON.stringify(argv));
const cmd = argv.at(-1) ?? '';
if (/cat \\/opt\\/driftstack\\/api\\/\\.last-good-sha/.test(cmd)) process.stdout.write(process.env.LAST_GOOD_REPLY + '\\n');
`,
      );
      stub('scp', '#!/bin/sh\necho "scp must not run in this test" >&2\nexit 99\n');
      stub('git', '#!/bin/sh\necho "git must not run in this test" >&2\nexit 99\n');
      // node: the post-deploy verifier. It must not reach the public origin.
      stub('node', '#!/bin/sh\nexit 0\n');
      stub('curl', '#!/bin/sh\necho \'{"git_sha":"fedcba9"}\'\n');
      stub('python3', '#!/bin/sh\necho fedcba9\n');
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('CRITICAL a deploy target that is not "main" or a hex sha is refused before any connection', () => {
      const { status, output } = run(BRIDGE, ['prod', "abc1234'; id; '"]);
      expect(status, output).toBe(2);
      expect(remoteCommands()).toEqual([]);
    });

    it('CRITICAL a hostile .last-good-sha never reaches a root shell', () => {
      const { status, output } = run(BRIDGE, ['prod', GOOD_SHA]);
      expect(status, output).toBe(0);
      const cmds = remoteCommands();
      // Non-vacuity: the read, the build, the last-good write and the history write.
      expect(cmds.length).toBeGreaterThanOrEqual(4);
      expect(cmds.filter((c) => c.includes('touch /root/owned'))).toEqual([]);
    });

    it('CRITICAL root never evaluates the service-owned .env: every `source` of it runs as the service account', () => {
      run(BRIDGE, ['prod', GOOD_SHA]);
      const build = remoteCommands().find((c) => c.includes('npm ci'));
      expect(build, 'the build command was not captured').toBeDefined();
      const sourcing = build!
        .split('\n')
        .filter((line) => !/^\s*#/.test(line))
        .filter((line) => /(source|\.) \/opt\/driftstack\/api\/\.env/.test(line));
      expect(sourcing.length, 'non-vacuity: the pre-gate and migrate lines').toBeGreaterThanOrEqual(
        2,
      );
      for (const line of sourcing) expect(line).toMatch(/sudo -u driftstack bash -c '/);
    });

    it('CRITICAL the build works in a mktemp -d directory with its logs inside it, never a predictable /tmp path', () => {
      run(BRIDGE, ['prod', GOOD_SHA]);
      const build = remoteCommands().find((c) => c.includes('npm ci'))!;
      expect(build).toMatch(/WORK_DIR=\$\(mktemp -d \/tmp\/driftstack-deploy\.X{6,}\)/);
      expect(build).not.toMatch(/\/tmp\/driftstack-deploy-\$STAMP/);
      expect(build).not.toMatch(/\/tmp\/deploy-(install|build|mig-check|migrate)\.log/);
    });

    it('CRITICAL root takes ownership of the deploy directories before it moves anything inside them, and refuses a symlinked .env', () => {
      run(BRIDGE, ['prod', GOOD_SHA]);
      const build = remoteCommands().find((c) => c.includes('npm ci'))!;
      const own = build.indexOf('chown root:root "$d"');
      const firstMove = build.indexOf('mv "$d" "$d.bak.$STAMP"');
      expect(own).toBeGreaterThan(-1);
      expect(firstMove).toBeGreaterThan(-1);
      expect(own).toBeLessThan(firstMove);
      expect(build).toMatch(/for d in \/opt\/driftstack \/opt\/driftstack\/api; do/);
      expect(build).toMatch(/\[ -L \/opt\/driftstack\/api\/\.env \]/);
    });

    it('CRITICAL .last-good-sha and the deploy history are written root-owned, never handed to the service account', () => {
      run(BRIDGE, ['prod', GOOD_SHA]);
      // The two small writes after a verified deploy — not the read, not the build.
      const cmds = remoteCommands().filter((c) => !c.includes('npm ci') && !c.includes('cat /opt'));
      const lastGood = cmds.find((c) => c.includes('.last-good-sha'));
      const history = cmds.find((c) => c.includes('.deploy-history.log'));
      expect(lastGood).toBeDefined();
      expect(history).toBeDefined();
      for (const c of [lastGood!, history!]) {
        expect(c).not.toMatch(/chown driftstack/);
        expect(c).toMatch(/\[ -L /);
      }
      // Written beside the target and renamed over it, so a planted link is replaced, not followed.
      expect(lastGood).toMatch(/mv -f "\$t" \.last-good-sha/);
    });

    it('CRITICAL revert-bridge refuses a hostile .last-good-sha instead of deploying it', () => {
      const { status, output } = run(REVERT, ['prod']);
      expect(status, output).not.toBe(0);
      expect(remoteCommands().filter((c) => c.includes('npm ci'))).toEqual([]);
      expect(remoteCommands().filter((c) => c.includes('touch /root/owned'))).toEqual([]);
    });

    it('revert-bridge refuses a malformed --to-sha', () => {
      const { status } = run(REVERT, ['--to-sha', 'HEAD~1; id', 'prod']);
      expect(status).not.toBe(0);
      expect(remoteCommands().filter((c) => c.includes('npm ci'))).toEqual([]);
    });
  },
);

// The deploy stopped evaluating the service-owned .env as root, and the reason
// the file may stay driftstack-owned is that nothing root runs evaluates it. An
// operator following a runbook is root too: every command given anywhere in the
// repository that `source`s or `.`s the env must run as driftstack, either on
// the same line (`sudo -u driftstack bash -c '…'`) or inside a code block that
// first switches to that user (`sudo -u driftstack bash`).
describe('no runbook or script has root evaluate the service-owned env', () => {
  const SOURCES_ENV = /(?:^|[\s;"'(])(?:source|\.)\s+"?\/opt\/driftstack\/api\/\.env\b/;
  const AS_SERVICE_INLINE = /sudo\s+-u\s+driftstack\s+bash\s+-c\b/;
  const SWITCH_TO_SERVICE = /^\s*sudo\s+-u\s+driftstack\s+(?:bash|-i|-s)\s*$/;

  function files(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
      const p = join(dir, entry.name);
      if (entry.isDirectory()) files(p, keep, out);
      else if (keep(entry.name)) out.push(p);
    }
    return out;
  }

  /** `file:line` for every line that sources the env as whoever runs it. */
  function asRoot(path: string): string[] {
    const found: string[] = [];
    let switched = false;
    readFileSync(path, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (/^\s*(?:```|~~~)/.test(line)) switched = false;
        if (SWITCH_TO_SERVICE.test(line)) switched = true;
        if (SOURCES_ENV.test(line) && !switched && !AS_SERVICE_INLINE.test(line)) {
          found.push(`${path.slice(REPO_ROOT.length + 1)}:${i + 1}`);
        }
      });
    return found;
  }

  const scanned = [
    ...files(resolve(REPO_ROOT, 'docs'), (n) => n.endsWith('.md')),
    ...files(resolve(REPO_ROOT, 'scripts'), (n) => n.endsWith('.sh') || n.endsWith('.md')),
    ...files(resolve(REPO_ROOT, 'infra'), (n) => /\.(?:sh|md)$/.test(n)),
  ];

  it('POSITIVE CONTROL the scanner finds a root `source`, and accepts both service-user forms', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ds-env-scan-'));
    try {
      const p = join(dir, 'x.md');
      writeFileSync(
        p,
        [
          '```sh',
          'ssh root@host "set -a; source /opt/driftstack/api/.env; set +a; psql"',
          'ssh root@host \'sudo -u driftstack bash -c "set -a; source /opt/driftstack/api/.env"\'',
          'set -a; . /opt/driftstack/api/.env; set +a',
          '```',
          '```sh',
          'sudo -u driftstack bash',
          'set -a; source /opt/driftstack/api/.env; set +a',
          '```',
        ].join('\n'),
      );
      expect(asRoot(p).map((f) => f.split(':').at(-1))).toEqual(['2', '4']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('CRITICAL every command that sources /opt/driftstack/api/.env runs as driftstack, not root', () => {
    expect(
      scanned.length,
      'non-vacuity: the docs, scripts and infra trees were walked',
    ).toBeGreaterThan(100);
    expect(scanned.flatMap(asRoot)).toEqual([]);
  });
});
