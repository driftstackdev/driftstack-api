// The personal names the V-211 guards reject are read from outside the
// repository, and a missing list is announced rather than passed off as coverage.
//
// A guard that spells the names out publishes them in every clone, and a
// guard that hashes them publishes them too: a digest of a first name or a
// surname is reversed in seconds by hashing a public name list. So
// scripts/personal-names.mjs holds only the matcher and a made-up canary; the
// list comes from DRIFTSTACK_PERSONAL_NAMES (CI, from a repository secret) or
// from the file DRIFTSTACK_PERSONAL_NAMES_FILE names (default
// ~/.config/driftstack/personal-names.txt).
//
// Every list used here is made up. None of these tests needs, reads or prints
// the real one.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  CANARY_WORD,
  DEFAULT_LIST_PATH,
  loadPersonalNames,
  parseList,
  personalNameHits,
} from '../personal-names.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..');
const MODULE = resolve(REPO, 'scripts', 'personal-names.mjs');

let dir: string;
let missing: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ds-names-'));
  missing = join(dir, 'absent.txt');
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Run the CLI on `text` with only the environment a test supplies. */
function cli(text: string, env: Record<string, string>) {
  const file = join(dir, 'message.txt');
  writeFileSync(file, text);
  const base: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME };
  const run = spawnSync(process.execPath, [MODULE, file], {
    encoding: 'utf8',
    env: { ...base, ...env },
  });
  return { status: run.status, stdout: run.stdout, stderr: run.stderr };
}

describe('the personal-name list is read from outside the repository', () => {
  it('CRITICAL the module holds no names and no digests of names — only the matcher and the canary. A 64-hex string in it would be a hashed name, which a public name list reverses.', () => {
    const source = readFileSync(MODULE, 'utf8');
    expect(source).not.toMatch(/[0-9a-f]{64}/i);
    expect(source).not.toMatch(/createHash/);
    expect(CANARY_WORD).toBe('personalnamecanary');
    expect(DEFAULT_LIST_PATH).toMatch(/\.config[\\/]driftstack[\\/]personal-names\.txt$/);
  });

  it('parses one entry per line, trimming, and skips blank lines and # comments', () => {
    expect(
      parseList('# header\n\n  zorbulonix  \nquendrav42\r\n#later\nqu.endrav@example.org\n'),
    ).toEqual(['zorbulonix', 'quendrav42', 'qu.endrav@example.org']);
  });

  it('CRITICAL DRIFTSTACK_PERSONAL_NAMES wins over the file, the file is used when the variable is unset, and the canary is on the list either way', () => {
    const listFile = join(dir, 'names.txt');
    writeFileSync(listFile, 'fromfileword\n');

    const viaEnv = loadPersonalNames({
      env: { DRIFTSTACK_PERSONAL_NAMES: 'fromenvword\n', DRIFTSTACK_PERSONAL_NAMES_FILE: listFile },
      announce: false,
    });
    expect(viaEnv).toEqual({
      entries: ['fromenvword', CANARY_WORD],
      configured: true,
      source: 'env',
    });

    const viaFile = loadPersonalNames({
      env: { DRIFTSTACK_PERSONAL_NAMES_FILE: listFile },
      announce: false,
    });
    expect(viaFile).toEqual({
      entries: ['fromfileword', CANARY_WORD],
      configured: true,
      source: listFile,
    });

    const none = loadPersonalNames({
      env: { DRIFTSTACK_PERSONAL_NAMES: '\n', DRIFTSTACK_PERSONAL_NAMES_FILE: missing },
      announce: false,
    });
    expect(none).toEqual({ entries: [CANARY_WORD], configured: false, source: 'none' });
  });

  it('CRITICAL a listed entry is found in every shape it takes in prose, and only there: a name in any case or accent, beside digits or an @, never inside a longer word; a handle or address only whole', () => {
    const list = ['zorbulonix', 'quendrav42', 'qu.endrav@example.org'];
    expect(personalNameHits('Thanks Zorbulonix.', list)).toEqual([
      { index: 7, word: 'Zorbulonix' },
    ]);
    expect(personalNameHits('zórbulonix', list)).toHaveLength(1);
    expect(personalNameHits('zorbulonix99', list)).toHaveLength(1);
    expect(personalNameHits('zorbulonixes', list)).toEqual([]);
    expect(personalNameHits('ping QUENDRAV42', list)).toHaveLength(1);
    expect(personalNameHits('quendrav420', list)).toEqual([]);
    expect(personalNameHits('<qu.endrav@example.org>', list)).toEqual([
      { index: 1, word: 'qu.endrav@example.org' },
    ]);
  });

  it('CRITICAL the CLI rejects a listed entry supplied the way CI supplies the secret, and reports where it is', () => {
    const run = cli('line one\nsigned zorbulonix\n', { DRIFTSTACK_PERSONAL_NAMES: 'zorbulonix' });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe('2:8 zorbulonix\n');
  });

  it('CRITICAL with no list under GitHub Actions the CLI emits one ::warning:: annotation and does not fail a clean message — the owner must add the secret for real coverage, and the run must say so rather than look covered', () => {
    const run = cli('nothing to see\n', {
      GITHUB_ACTIONS: 'true',
      DRIFTSTACK_PERSONAL_NAMES_FILE: missing,
    });
    expect(run.status).toBe(0);
    const warnings = run.stdout.split('\n').filter((l) => l.startsWith('::warning'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/DRIFTSTACK_PERSONAL_NAMES/);
  });

  it('CRITICAL with no list locally the CLI prints one notice on stderr, still checks the canary, and keeps stdout for hits only', () => {
    const clean = cli('nothing to see\n', { DRIFTSTACK_PERSONAL_NAMES_FILE: missing });
    expect(clean.status).toBe(0);
    expect(clean.stdout).toBe('');
    expect(clean.stderr.match(/no personal-name list configured/g)).toHaveLength(1);

    const canary = cli(`${CANARY_WORD}\n`, { DRIFTSTACK_PERSONAL_NAMES_FILE: missing });
    expect(canary.status).toBe(1);
    expect(canary.stdout).toBe(`1:1 ${CANARY_WORD}\n`);
  });

  it('CRITICAL the CI step that runs the suite passes the secret through, so the sweeps see the real list there', () => {
    const ci = readFileSync(resolve(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    expect(ci).toMatch(
      /env:\s*\n\s+DRIFTSTACK_PERSONAL_NAMES: \$\{\{ secrets\.DRIFTSTACK_PERSONAL_NAMES \}\}\s*\n\s+run: node scripts\/verify-suite\.mjs --all/,
    );
  });
});
