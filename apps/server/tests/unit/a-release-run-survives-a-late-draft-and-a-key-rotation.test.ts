// Two ways the E-10 release workflow could fail a release the runbook tells you to cut.
// Both are tested by RUNNING the step's own script, taken from the workflow file, with
// a stub `gh` on PATH. A test that matched the text of a comparison could not show that
// the comparison works.
//
// ── the draft is created AFTER the tag push ────────────────────────────────────
//
// The runbook's order is load-bearing: push the annotated tag (step 3), THEN create the
// draft against it (step 4). `gh release create` against a missing tag makes a
// lightweight one, which the policy forbids. The push starts the workflow, so for a
// short while after it the tag has no release, and that is correct.
//
// preflight used to fail on "no release" ~30 s after the push. Before E-10 the same
// check ran minutes later, after the toolchain, `npm ci` and the package builds, which
// gave the operator time for step 4. An operator writing notes after the push would
// have got a red run on a tag that can never be pushed again. So preflight now WARNS
// on no release, and says how to finish. publish-manifest, which runs after every
// platform is built and signed, is the gate: it needs exactly one release. When the
// draft is still missing there, it fails without touching anything. The signed set is
// kept as a workflow artifact, so `gh run rerun <run-id> --failed` re-runs only the
// publish.
//
// Two or more releases for the tag still fail preflight at once. Waiting never fixes
// that; a person has to delete one (the gui-v0.1.62/0.1.63 orphan-draft state).
//
// ── a key rotation signs with the OLD key and compiles in the NEW one ─────────
//
// docs/founder-actions/v243-tauri-updater-keys.md: a rotation ships ONE release that is
// signed with the old private key and carries the new public key, so installed clients
// (which trust the old key) accept it. The verify step checked every signature against
// TAURI_UPDATER_PUBKEY, the key compiled INTO the build, so it would refuse that
// release, during an emergency rotation after a key compromise. It now verifies
// against the key installed clients trust: TAURI_UPDATER_TRUSTED_PUBKEY (a repository
// variable, set only for a rotation) when set, else TAURI_UPDATER_PUBKEY. It warns
// loudly whenever the two differ.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  readdirSync,
} from 'node:fs';
import { createHash, generateKeyPairSync, randomBytes, sign, type KeyObject } from 'node:crypto';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, '..', '..', '..', '..', '.github', 'workflows', 'gui-release.yml');
const body = readFileSync(WORKFLOW, 'utf8');

const TAG = 'gui-v0.1.71';
const RUN_ID = '4242';
const scratch = mkdtempSync(join(tmpdir(), 'gui-release-steps-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** Each job's text, keyed by job id (the workflow's own two-space layout). */
function jobsOf(src: string): Map<string, string> {
  const lines = src.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  const out = new Map<string, string>();
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

const indentOf = (l: string): number => /^ */.exec(l)![0].length;

/** The `run: |` block of a step, de-indented exactly as YAML hands it to the shell. */
function runBlock(step: string): string {
  const lines = step.split('\n');
  const at = lines.findIndex((l) => /^\s+run: \|\s*$/.test(l));
  if (at < 0) return '';
  const key = indentOf(lines[at]!);
  const block: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() !== '' && indentOf(l) <= key) break;
    block.push(l);
  }
  while (block.length > 0 && block[block.length - 1]!.trim() === '') block.pop();
  const cut = Math.min(...block.filter((l) => l.trim() !== '').map(indentOf));
  return `${block.map((l) => l.slice(cut)).join('\n')}\n`;
}

/** The one step of `job` whose script contains `marker`: found by what it does, not its name. */
function scriptOf(job: string, marker: string): { step: string; script: string } {
  const hits = stepsOf(jobsOf(body).get(job) ?? '').filter((s) => runBlock(s).includes(marker));
  expect(hits.length, `${job}: expected one step running ${marker}`).toBe(1);
  const script = runBlock(hits[0]!);
  // GitHub substitutes ${{ }} before the shell sees the script; these run it as-is.
  expect(script).not.toContain('${{');
  return { step: hits[0]!, script };
}

let seq = 0;
/** A fresh directory under the scratch root. */
const freshDir = (kind: string): string => {
  const dir = join(scratch, `${kind}-${++seq}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/**
 * A stand-in for `gh`: it logs every call and answers the three reads the workflow
 * makes from files the arm writes. It never reaches GitHub.
 */
function stubGh(dir: string): string {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  const gh = join(bin, 'gh');
  writeFileSync(
    gh,
    [
      '#!/usr/bin/env bash',
      'printf "%s\\n" "$*" >> "$STUB_LOG"',
      'case "$1 $2" in',
      '  "api "*) cat "$STUB_RELEASES" ;;',
      '  "release view") case "$*" in *"--json assets"*) cat "$STUB_ASSETS" ;; *) cat "$STUB_BODY" ;; esac ;;',
      '  "release upload"|"release edit") : ;;',
      '  *) echo "stub gh: unexpected call: $*" >&2; exit 2 ;;',
      'esac',
      '',
    ].join('\n'),
  );
  chmodSync(gh, 0o755);
  return bin;
}

interface Ran {
  status: number | null;
  out: string;
  calls: string[];
}

/** Run a workflow script the way `shell: bash` does, with a stub gh first on PATH. */
function runStep(script: string, cwd: string, dir: string, env: Record<string, string>): Ran {
  const bin = stubGh(dir);
  const log = join(dir, 'gh-calls.log');
  writeFileSync(log, '');
  const file = join(dir, 'step.sh');
  writeFileSync(file, script);
  const runnerTemp = join(dir, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
    cwd,
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${bin}:${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      HOME: dir,
      GH_TOKEN: 'stub-token-not-a-credential',
      GITHUB_REPOSITORY: 'example-org/example-repo',
      GITHUB_RUN_ID: RUN_ID,
      RUNNER_TEMP: runnerTemp,
      STUB_LOG: log,
      STUB_RELEASES: join(dir, 'releases.tsv'),
      STUB_ASSETS: join(dir, 'assets.txt'),
      STUB_BODY: join(dir, 'body.md'),
      ...env,
    },
  });
  const calls = readFileSync(log, 'utf8').split('\n').filter(Boolean);
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}`, calls };
}

/** The release list as the workflow's `--jq` renders it: id, tag, draft. */
const releases = (dir: string, rows: [number, string, boolean][]): void =>
  writeFileSync(join(dir, 'releases.tsv'), rows.map((r) => `${r.join('\t')}\n`).join(''));

// A tag that starts with ours must never count as ours.
const NEIGHBOUR: [number, string, boolean] = [7, 'gui-v0.1.710', false];

describe('a release run survives a draft created after the tag push', () => {
  const preflight = scriptOf('preflight', '/releases?per_page=100').script;
  const runPreflight = (rows: [number, string, boolean][]): Ran => {
    const dir = freshDir('preflight');
    releases(dir, rows);
    return runStep(preflight, dir, dir, { TAG });
  };

  it('CRITICAL no release yet — the state right after runbook step 3 pushes the tag — does NOT fail preflight: it warns and says how to finish (create the draft; if publish gets there first, re-run the failed job)', () => {
    const r = runPreflight([NEIGHBOUR]);
    expect(
      r.calls.some((c) => c.startsWith('api ')),
      'the stub gh was never asked',
    ).toBe(true);
    expect(r.out).not.toMatch(/::error::/);
    expect(r.status, r.out).toBe(0);
    expect(r.out).toMatch(/::warning::/);
    expect(r.out).toContain(`gh release create ${TAG} --draft`);
    expect(r.out).toContain(`gh run rerun ${RUN_ID} --failed`);
  });

  it('exactly one release (the draft) passes preflight quietly', () => {
    const r = runPreflight([NEIGHBOUR, [11, TAG, true]]);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/::(warning|error)::/);
  });

  it('CRITICAL two releases for the tag still fail preflight at once — waiting never cures the orphan-draft state, a person has to keep one', () => {
    const r = runPreflight([NEIGHBOUR, [11, TAG, true], [12, TAG, false]]);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::2 releases carry the tag/);
  });

  describe('publish-manifest is the gate, and a late draft costs only a re-run of it', () => {
    const publish = scriptOf('publish-manifest', 'gh release edit').script;

    /** A signed set as the sign job leaves it, and the release as the stub reports it. */
    function signedSet(dir: string): string {
      const assets = join(dir, 'release-assets');
      mkdirSync(assets);
      writeFileSync(join(assets, 'Driftstack_0.1.71_universal.dmg'), 'dmg');
      writeFileSync(join(assets, 'Driftstack_universal.app.tar.gz'), 'tarball');
      writeFileSync(join(assets, 'Driftstack_universal.app.tar.gz.sig'), 'sig');
      writeFileSync(join(assets, 'latest.json'), JSON.stringify({ version: '0.1.71' }));
      const sizes = readdirSync(assets)
        .map((n) => `${n} ${statSync(join(assets, n)).size}`)
        .sort()
        .join('\n');
      writeFileSync(join(dir, 'assets.txt'), `${sizes}\n`);
      writeFileSync(join(dir, 'body.md'), '**Install**\nalready here\n');
      return assets;
    }
    const runPublish = (rows: [number, string, boolean][]): Ran => {
      const dir = freshDir('publish');
      releases(dir, rows);
      return runStep(publish, signedSet(dir), dir, { TAG });
    };
    const writes = (r: Ran): string[] => r.calls.filter((c) => /^release (upload|edit)/.test(c));

    it('CRITICAL no release when the publish runs: it fails before writing anything, and the error says exactly how to finish — create the draft, then re-run the failed job', () => {
      const r = runPublish([NEIGHBOUR]);
      expect(
        r.calls.some((c) => c.startsWith('api ')),
        'the stub gh was never asked',
      ).toBe(true);
      expect(r.status).toBe(1);
      expect(writes(r)).toEqual([]);
      expect(r.out).toContain(`gh release create ${TAG} --draft`);
      expect(r.out).toContain(`gh run rerun ${RUN_ID} --failed`);
    });

    it('two releases when the publish runs: it fails before writing anything and says to keep one, then re-run the failed job', () => {
      const r = runPublish([NEIGHBOUR, [11, TAG, true], [12, TAG, true]]);
      expect(r.status).toBe(1);
      expect(writes(r)).toEqual([]);
      expect(r.out).toContain(`gh run rerun ${RUN_ID} --failed`);
    });

    it('CONTROL exactly one draft: every asset is uploaded, latest.json last, and the draft is published after the check — the script the arms above stop really does publish', () => {
      const r = runPublish([NEIGHBOUR, [11, TAG, true]]);
      expect(r.status, r.out).toBe(0);
      const w = writes(r);
      expect(w).toHaveLength(3);
      expect(w[0]).toMatch(/^release upload gui-v0\.1\.71 .*Driftstack_0\.1\.71_universal\.dmg/);
      expect(w[0]).not.toContain('latest.json');
      expect(w[1]).toMatch(/^release upload gui-v0\.1\.71 latest\.json /);
      expect(w[2]).toMatch(/^release edit gui-v0\.1\.71 .*--draft=false/);
    });

    it('the re-run the errors point at can find its input: both artifact uploads overwrite a same-named artifact from an earlier attempt instead of failing on it', () => {
      const uploads = [
        ...body.matchAll(
          /uses: actions\/upload-artifact@[0-9a-f]{40}[^\n]*\n((?:\s+[^\n]*\n){1,8})/g,
        ),
      ];
      expect(uploads.length).toBe(2);
      for (const u of uploads) expect(u[1]).toMatch(/^\s+overwrite: true$/m);
    });
  });
});

// ── minisign, as `tauri signer` writes it ─────────────────────────────────────

interface Key {
  id: Buffer;
  priv: KeyObject;
  /** The TAURI_UPDATER_PUBKEY form: base64 of the two-line minisign public key file. */
  pub: string;
}

/** A key id as minisign prints it: the little-endian u64 in hex, no leading zeros. */
const label = (id: Buffer): string =>
  Buffer.from(id)
    .reverse()
    .toString('hex')
    .toUpperCase()
    .replace(/^0+(?=.)/, '');

function newKey(): Key {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const id = randomBytes(8);
  const raw = Buffer.from(publicKey.export({ format: 'jwk' }).x!, 'base64url');
  const blob = Buffer.concat([Buffer.from('Ed', 'latin1'), id, raw]).toString('base64');
  const file = `untrusted comment: minisign public key: ${label(id)}\n${blob}\n`;
  return { id, priv: privateKey, pub: Buffer.from(file).toString('base64') };
}

/** Write `<name>` and `<name>.sig` (prehashed "ED", as tauri 2 signs) into `dir`. */
function signFile(dir: string, name: string, key: Key): void {
  const data = Buffer.from(`bundle bytes of ${name}`);
  writeFileSync(join(dir, name), data);
  const sig = sign(null, createHash('blake2b512').update(data).digest(), key.priv);
  const trusted = `timestamp:1700000000\tfile:${name}`;
  const global = sign(null, Buffer.concat([sig, Buffer.from(trusted)]), key.priv);
  const box = [
    'untrusted comment: signature from tauri secret key',
    Buffer.concat([Buffer.from('ED', 'latin1'), key.id, sig]).toString('base64'),
    `trusted comment: ${trusted}`,
    global.toString('base64'),
    '',
  ].join('\n');
  writeFileSync(join(dir, `${name}.sig`), Buffer.from(box).toString('base64'));
}

describe('a key-rotation release verifies against the key installed clients trust', () => {
  const { step, script } = scriptOf('sign', 'crypto.verify');
  const OLD = newKey();
  const NEW = newKey();

  /** Sign two updater artifacts with `signer`, then run the verify step. */
  function verify(signer: Key, env: Record<string, string>): Ran {
    const dir = freshDir('verify');
    const assets = join(dir, 'release-assets');
    mkdirSync(assets);
    signFile(assets, 'Driftstack_universal.app.tar.gz', signer);
    signFile(assets, 'Driftstack_0.1.71_amd64.AppImage', signer);
    return runStep(script, assets, dir, env);
  }

  it('the step receives the optional trusted key from a repository variable, beside the compiled one', () => {
    expect(step).toMatch(/TAURI_UPDATER_PUBKEY: \$\{\{ secrets\.TAURI_UPDATER_PUBKEY \}\}/);
    expect(step).toMatch(
      /TAURI_UPDATER_TRUSTED_PUBKEY: \$\{\{ vars\.TAURI_UPDATER_TRUSTED_PUBKEY \}\}/,
    );
  });

  it('CONTROL an ordinary release — signed with the key it compiles in, no trusted key set (GitHub passes an unset variable as "") — verifies', () => {
    const r = verify(NEW, { TAURI_UPDATER_PUBKEY: NEW.pub, TAURI_UPDATER_TRUSTED_PUBKEY: '' });
    expect(r.status, r.out).toBe(0);
    expect(r.out.match(/^verified /gm)).toHaveLength(2);
    expect(r.out).not.toMatch(/::(warning|error)::/);
  });

  it('CRITICAL a mismatched key with no rotation declared still fails: signed with one key, compiling in another, is an update no install can apply', () => {
    const r = verify(OLD, { TAURI_UPDATER_PUBKEY: NEW.pub, TAURI_UPDATER_TRUSTED_PUBKEY: '' });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::/);
  });

  it('CRITICAL the rotation release — signed with the OLD key, compiling in the NEW one, the OLD one declared trusted — verifies, and says loudly that a rotation is in progress', () => {
    const r = verify(OLD, { TAURI_UPDATER_PUBKEY: NEW.pub, TAURI_UPDATER_TRUSTED_PUBKEY: OLD.pub });
    expect(r.status, r.out).toBe(0);
    expect(r.out.match(/^verified /gm)).toHaveLength(2);
    expect(r.out).toMatch(/::warning::[^\n]*rotation/i);
    expect(r.out).toContain(label(OLD.id));
    expect(r.out).toContain(label(NEW.id));
  });

  it('CRITICAL a trusted key left set after the rotation fails the next release, and the error names the variable to clear', () => {
    const r = verify(NEW, { TAURI_UPDATER_PUBKEY: NEW.pub, TAURI_UPDATER_TRUSTED_PUBKEY: OLD.pub });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::[^\n]*TAURI_UPDATER_TRUSTED_PUBKEY/);
  });

  it('a trusted key that is not a public key fails, rather than falling back to the compiled one', () => {
    const r = verify(NEW, {
      TAURI_UPDATER_PUBKEY: NEW.pub,
      TAURI_UPDATER_TRUSTED_PUBKEY: 'bm90IGEga2V5',
    });
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::[^\n]*TAURI_UPDATER_TRUSTED_PUBKEY/);
  });
});
