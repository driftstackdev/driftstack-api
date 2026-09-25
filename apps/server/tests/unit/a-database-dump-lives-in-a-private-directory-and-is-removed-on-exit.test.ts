// Security sweep E-27 (2026-09-24). scripts/v278k-neon-split-cutover.sh, in
// --execute mode, pg_dumps the whole shared database — every account, every
// session, every stored credential ciphertext — to the FIXED path
// /tmp/v278k-snapshot.sql. Under the default umask that file is 0644, readable
// by every other local account on the operator's machine, and nothing ever
// removed it: the dump outlived the cutover indefinitely.
//
// The dump now goes into a private directory (umask 077 + mktemp -d) that the
// script removes on every exit path, including an operator answering "n" part
// way through, and dry-run creates nothing at all.
//
// This runs the REAL script with every external tool stubbed (neonctl, pg_dump,
// psql, jq, ssh, curl): nothing leaves the machine and no database is touched.
// The psql stub is the witness — it runs while the dump exists, so it records
// where the dump is and what its permissions are at the moment it is read.

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
const CUTOVER = resolve(REPO_ROOT, 'scripts/v278k-neon-split-cutover.sh');

interface PsqlWitness {
  stdin: string;
  entries: Array<{ name: string; dirMode: string; files: Array<{ name: string; mode: string }> }>;
}

let root: string;
let stubs: string;
let scratch: string;
let records: string;

function stub(name: string, body: string): void {
  const path = join(stubs, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}

function run(args: string[], answers: string): { status: number; output: string } {
  const r = spawnSync('bash', [CUTOVER, ...args], {
    encoding: 'utf8',
    input: answers,
    cwd: root,
    env: {
      // Step 1 names the shared project; execute mode refuses to guess it.
      CURRENT_SHARED_PROJECT: 'proj-under-test',
      // Stubs first, so no real neonctl / pg_dump / psql / ssh can run.
      PATH: `${stubs}:/usr/bin:/bin`,
      HOME: root,
      TMPDIR: scratch,
      RECORDS: records,
    },
  });
  return { status: r.status ?? -1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function witnesses(): PsqlWitness[] {
  return readdirSync(records)
    .filter((f) => f.startsWith('psql-'))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(records, f), 'utf8')) as PsqlWitness);
}

describe(
  'the cutover dump lives in a private directory and is removed on exit',
  { timeout: 30_000 },
  () => {
    beforeEach(() => {
      root = mkdtempSync(join(tmpdir(), 'ds-cutover-'));
      stubs = join(root, 'bin');
      scratch = join(root, 'tmp');
      records = join(root, 'records');
      for (const d of [stubs, scratch, records]) mkdirSync(d);
      stub('neonctl', '#!/bin/sh\necho "[]"\n');
      stub('jq', '#!/bin/sh\ncat\n');
      stub('pg_dump', '#!/bin/sh\necho "-- the whole database"\n');
      for (const refused of ['ssh', 'scp', 'curl']) {
        stub(refused, `#!/bin/sh\necho "${refused} must not run in this test" >&2\nexit 99\n`);
      }
      // psql reads the dump on stdin. It records the dump and every v278k entry
      // under TMPDIR, with modes, while the dump still exists.
      stub(
        'psql',
        `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const stdin = fs.readFileSync(0, 'utf8');
const tmp = process.env.TMPDIR;
const entries = fs.readdirSync(tmp).filter((n) => n.startsWith('v278k')).map((name) => {
  const p = path.join(tmp, name);
  const st = fs.statSync(p);
  const files = st.isDirectory()
    ? fs.readdirSync(p).map((f) => ({ name: f, mode: (fs.statSync(path.join(p, f)).mode & 0o777).toString(8) }))
    : [];
  return { name, dirMode: (st.mode & 0o777).toString(8), files };
});
const n = fs.readdirSync(process.env.RECORDS).length;
fs.writeFileSync(path.join(process.env.RECORDS, 'psql-' + n + '.json'), JSON.stringify({ stdin, entries }));
`,
      );
    });

    afterEach(() => {
      rmSync(root, { recursive: true, force: true });
    });

    it('CRITICAL in --execute mode the dump is written inside a 0700 directory under TMPDIR, as a 0600 file, and never to the fixed world-readable /tmp path', () => {
      // Steps 1-6 approved (discover, provision x2, dump, restore x2); step 7 (the
      // DATABASE_URL swap over SSH) refused, so nothing reaches a server.
      const { status, output } = run(['--execute'], 'y\ny\ny\ny\ny\ny\nn\n');
      expect(status, output).toBe(1);
      expect(output).toContain('aborted at step 7');

      const seen = witnesses();
      expect(seen, 'psql ran for both restores').toHaveLength(2);
      for (const w of seen) {
        expect(w.stdin, 'psql read the dump pg_dump wrote').toContain('the whole database');
        expect(w.entries, `the dump is not under TMPDIR: ${output}`).toHaveLength(1);
        const [entry] = w.entries;
        expect(entry?.dirMode, 'the dump directory is private').toBe('700');
        expect(
          entry?.files.map((f) => f.mode),
          'the dump file is private',
        ).toEqual(['600']);
      }
      expect(output).not.toContain('/tmp/v278k-snapshot.sql');
    });

    it('CRITICAL the dump is removed when the operator aborts part way through', () => {
      const { status } = run(['--execute'], 'y\ny\ny\ny\ny\ny\nn\n');
      expect(status).toBe(1);
      // Non-vacuity: the dump existed while psql ran.
      expect(witnesses().length).toBeGreaterThan(0);
      expect(readdirSync(scratch), 'nothing of the dump survives the exit').toEqual([]);
    });

    it('the dump is removed when a step itself fails', () => {
      stub('psql', '#!/bin/sh\nexit 3\n');
      const { status } = run(['--execute'], 'y\ny\ny\ny\ny\ny\nn\n');
      expect(status).not.toBe(0);
      expect(readdirSync(scratch)).toEqual([]);
    });

    it('dry-run creates nothing and prints no fixed dump path', () => {
      const { status, output } = run(['--dry-run'], '');
      expect(status, output).toBe(0);
      expect(output).toContain('DRY: pg_dump');
      expect(readdirSync(scratch)).toEqual([]);
      expect(witnesses()).toEqual([]);
      expect(output).not.toContain('/tmp/v278k-snapshot.sql');
    });
  },
);
