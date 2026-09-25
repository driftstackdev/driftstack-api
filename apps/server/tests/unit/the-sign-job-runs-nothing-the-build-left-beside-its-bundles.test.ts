// Security sweep E-10, second half: the build's OUTPUT must not run next to the key.
//
// The updater key is in one step of the `sign` job, and that job builds nothing. But
// it does read what the build job handed over, and the build job runs every npm build
// plugin and cargo build.rs the app depends on. Whatever that code wrote into
// release-assets/ reached the sign job, because upload-artifact uploads the whole
// directory and the collect step checked only the names it had copied itself.
//
// The manifest step ran `python3 -` INSIDE that directory, and Python puts its working
// directory first on sys.path. So a json.py planted beside the bundles ran on the sign
// runner. The key was not in that step's env, but it did not need to be: a
// GitHub-hosted runner has passwordless sudo, and the runner process holds every
// secret of the job in memory (the tj-actions/changed-files compromise, CVE-2025-30066,
// dumped secrets exactly that way). A planted module that erased itself and handed
// over to the real json left the run green and the log clean.
//
// So, and each part is tested by RUNNING the workflow's own step script:
//   • the sign job installs its signer BEFORE the build's bundles are on the runner,
//     and the step right after it fetches them refuses anything but the five bundles
//     (regular files, plain names, one of each kind): no module, no dotfile, no
//     directory, no symlink;
//   • every python3 in the workflow runs isolated (-I), so it imports nothing from
//     the directory it runs in, even if something slips past the check;
//   • the build job collects into an empty directory and refuses anything it did not
//     put there;
//   • the signer gets each bundle as ./<name>, so a name cannot be read as an option.

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW = resolve(HERE, '..', '..', '..', '..', '.github', 'workflows', 'gui-release.yml');
const body = readFileSync(WORKFLOW, 'utf8');

const scratch = mkdtempSync(join(tmpdir(), 'gui-release-handover-'));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

/** The five bundles a release carries, as the build job names them. */
const BUNDLES = [
  'Driftstack_0.1.71_universal.dmg',
  'Driftstack_universal.app.tar.gz',
  'Driftstack_0.1.71_x64-setup.exe',
  'Driftstack_0.1.71_amd64.AppImage',
  'Driftstack_0.1.71_amd64.deb',
];
/** The four the updater downloads, each signed. */
const UPDATER = BUNDLES.filter((n) => !n.endsWith('.dmg'));

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

/** The step's `working-directory:`, relative to the workspace ('' for the root). */
const workingDirOf = (step: string): string =>
  /^\s+working-directory:\s*(\S+)\s*$/m.exec(step)?.[1] ?? '';

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
/** A fresh workspace: the directory a job's steps run in, as on the runner. */
const freshWorkspace = (kind: string): string => {
  const dir = join(scratch, `${kind}-${++seq}`);
  mkdirSync(join(dir, 'workspace'), { recursive: true });
  return dir;
};

interface Ran {
  status: number | null;
  out: string;
}

/**
 * Run a workflow step the way `shell: bash` does, in the workspace directory the step
 * names, so a step that runs inside release-assets/ is run inside it here too.
 */
function runStep(step: string, script: string, dir: string, env: Record<string, string>): Ran {
  const file = join(dir, 'step.sh');
  writeFileSync(file, script);
  const runnerTemp = join(dir, 'runner-temp');
  mkdirSync(runnerTemp, { recursive: true });
  const r = spawnSync('bash', ['--noprofile', '--norc', '-eo', 'pipefail', file], {
    cwd: join(dir, 'workspace', workingDirOf(step)),
    encoding: 'utf8',
    timeout: 60_000,
    env: {
      PATH: `${dirname(process.execPath)}:${process.env.PATH ?? ''}`,
      HOME: dir,
      GITHUB_REPOSITORY: 'example-org/example-repo',
      RUNNER_TEMP: runnerTemp,
      ...env,
    },
  });
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

/** release-assets/ in `dir`'s workspace, holding the five bundles. */
function handover(dir: string, names: string[] = BUNDLES): string {
  const assets = join(dir, 'workspace', 'release-assets');
  mkdirSync(assets, { recursive: true });
  for (const n of names) writeFileSync(join(assets, n), `bundle bytes of ${n}`);
  return assets;
}

/** A module that records it ran, so a test can see code execute that must never run. */
const planted = (marker: string, name: string): string =>
  `import os\nopen(${JSON.stringify(marker)}, 'a').write(${JSON.stringify(`${name} ran\n`)})\n`;

/**
 * The quiet variant: records it ran, deletes itself and hands over to the real
 * module, so the step it ran in sees nothing wrong.
 */
const plantedQuiet = (marker: string): string =>
  [
    'import os, sys, importlib',
    `open(${JSON.stringify(marker)}, 'a').write('json ran\\n')`,
    'os.remove(os.path.abspath(__file__))',
    "del sys.modules['json']",
    "sys.path[:] = [p for p in sys.path if p not in ('', '.', os.getcwd())]",
    "sys.modules['json'] = importlib.import_module('json')",
    '',
  ].join('\n');

const signJob = (): string => jobsOf(body).get('sign') ?? '';

describe('the sign job checks what the build handed over before anything reads it', () => {
  const steps = stepsOf(signJob());
  const fetchAt = steps.findIndex(
    (s) => /uses: actions\/download-artifact@/.test(s) && /pattern: unsigned-\*/.test(s),
  );
  const keyAt = steps.findIndex((s) => /TAURI_SIGNING_PRIVATE_KEY:/.test(s));
  const installAt = steps.findIndex((s) => /npm ci --ignore-scripts/.test(runBlock(s)));
  const check = steps[fetchAt + 1] ?? '';

  it('reads the steps it guards: the fetch of the unsigned bundles, the signer install and the key step', () => {
    expect(fetchAt).toBeGreaterThanOrEqual(0);
    expect(installAt).toBeGreaterThanOrEqual(0);
    expect(keyAt).toBeGreaterThan(fetchAt);
  });

  it('CRITICAL the signer is installed before the build’s bundles are on the runner, so nothing the build made can touch the install', () => {
    expect(installAt).toBeLessThan(fetchAt);
  });

  it('CRITICAL the step right after the fetch is the check, it runs from the workspace root rather than inside the directory it checks, and it comes before the key step', () => {
    expect(runBlock(check), 'the step after the fetch runs no script').not.toBe('');
    expect(runBlock(check), 'the step after the fetch does not look at the bundles').toContain(
      'release-assets',
    );
    expect(check).not.toMatch(/uses:/);
    expect(workingDirOf(check)).toBe('');
    expect(fetchAt + 1).toBeLessThan(keyAt);
  });

  const runCheck = (build: (assets: string) => void): Ran => {
    const dir = freshWorkspace('check');
    build(handover(dir));
    return runStep(check, runBlock(check), dir, {});
  };

  it('CONTROL exactly the five bundles pass, and the log names them', () => {
    const r = runCheck(() => undefined);
    expect(r.status, r.out).toBe(0);
    expect(r.out).not.toMatch(/::error::/);
    for (const n of BUNDLES) expect(r.out).toContain(n);
  });

  const refused: [string, (assets: string) => void, RegExp][] = [
    [
      'a json.py beside the bundles (what `python3 -` would import)',
      (a) => writeFileSync(join(a, 'json.py'), 'x = 1\n'),
      /json\.py/,
    ],
    [
      'a pathlib.py beside the bundles',
      (a) => writeFileSync(join(a, 'pathlib.py'), 'x = 1\n'),
      /pathlib\.py/,
    ],
    [
      'a .git directory (git would run its hooks and fsmonitor)',
      (a) => {
        mkdirSync(join(a, '.git'));
        writeFileSync(join(a, '.git', 'config'), '[core]\n\tfsmonitor = /bin/true\n');
      },
      /\.git/,
    ],
    ['a dotfile such as .npmrc', (a) => writeFileSync(join(a, '.npmrc'), 'x=1\n'), /\.npmrc/],
    [
      'a package directory named like a module',
      (a) => {
        mkdirSync(join(a, 'json'));
        writeFileSync(join(a, 'json', '__init__.py'), 'x = 1\n');
      },
      /"json"/,
    ],
    [
      'a bundle that is a symlink, not a file',
      (a) => {
        rmSync(join(a, 'Driftstack_0.1.71_amd64.deb'));
        symlinkSync('/etc/hosts', join(a, 'Driftstack_0.1.71_amd64.deb'));
      },
      /Driftstack_0\.1\.71_amd64\.deb/,
    ],
    [
      'a bundle whose name starts with "-" (a signer would read it as an option)',
      (a) => {
        rmSync(join(a, 'Driftstack_0.1.71_amd64.AppImage'));
        writeFileSync(join(a, '--private-key-path=x.AppImage'), 'bytes');
      },
      /--private-key-path=x\.AppImage/,
    ],
    [
      'two disk images',
      (a) => writeFileSync(join(a, 'Driftstack_0.1.70_universal.dmg'), 'bytes'),
      /2 \*\.dmg/,
    ],
    ['a missing .deb', (a) => rmSync(join(a, 'Driftstack_0.1.71_amd64.deb')), /0 \*\.deb/],
  ];

  for (const [what, plant, names] of refused) {
    it(`CRITICAL refuses ${what}, before the key step can run, and names it`, () => {
      const r = runCheck(plant);
      expect(r.status, r.out).toBe(1);
      expect(r.out).toMatch(/::error::/);
      expect(r.out).toMatch(names);
    });
  }
});

describe('no Python in the release workflow imports from the directory it runs in', () => {
  const python = (): boolean => spawnSync('python3', ['-c', 'pass']).status === 0;

  it('every python3 the workflow runs is isolated (-I): the working directory is not on its import path', () => {
    const calls = body
      .split('\n')
      .filter((l) => !/^\s*#/.test(l))
      .flatMap((l) => [...l.matchAll(/\bpython3?\b(?!\.)(\s+\S+)?/g)].map((m) => m[0]));
    expect(calls.length, 'the checker sees the python3 calls it guards').toBeGreaterThanOrEqual(2);
    expect(calls.filter((c) => !/^python3? -I$/.test(c))).toEqual([]);
  });

  /** release-assets as the sign step leaves it: the five bundles and four signatures. */
  function signed(dir: string): string {
    const assets = handover(dir);
    for (const n of UPDATER) writeFileSync(join(assets, `${n}.sig`), `c2lnbmF0dXJlIG9mICR7bn0=`);
    return assets;
  }

  const manifest = scriptOf('sign', 'json.dump');
  const env = { TAG: 'gui-v0.1.71', VERSION: '0.1.71' };

  it('CONTROL with nothing planted, the manifest step writes latest.json with nine keys, every one signed', () => {
    expect(python(), 'python3 must be on PATH: the step under test runs it').toBe(true);
    const dir = freshWorkspace('manifest');
    const assets = signed(dir);
    const r = runStep(manifest.step, manifest.script, dir, env);
    expect(r.status, r.out).toBe(0);
    const out = JSON.parse(readFileSync(join(assets, 'latest.json'), 'utf8')) as {
      version: string;
      platforms: Record<string, { signature: string; url: string }>;
    };
    expect(out.version).toBe('0.1.71');
    expect(Object.keys(out.platforms)).toHaveLength(9);
    for (const p of Object.values(out.platforms)) expect(p.signature).not.toBe('');
  });

  /** Plant json.py and pathlib.py in a signed set and run the manifest step's `script`. */
  function withPlanted(script: string, quiet: boolean): { r: Ran; marker: string } {
    const dir = freshWorkspace('planted');
    const assets = signed(dir);
    const marker = join(dir, 'planted-code-ran');
    if (quiet) {
      writeFileSync(join(assets, 'json.py'), plantedQuiet(marker));
    } else {
      writeFileSync(join(assets, 'json.py'), planted(marker, 'json'));
      writeFileSync(join(assets, 'pathlib.py'), planted(marker, 'pathlib'));
    }
    return { r: runStep(manifest.step, script, dir, env), marker };
  }

  it('CRITICAL a json.py and pathlib.py planted beside the bundles never run, and the step refuses them by name', () => {
    expect(python(), 'python3 must be on PATH: the step under test runs it').toBe(true);
    const { r, marker } = withPlanted(manifest.script, false);
    expect(
      existsSync(marker),
      `planted code ran:\n${existsSync(marker) ? readFileSync(marker, 'utf8') : ''}`,
    ).toBe(false);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::refusing to write a manifest[^\n]*json\.py/);
  });

  it('CRITICAL the quiet variant — erases itself and hands over to the real json — never runs either, so it cannot leave the run green', () => {
    const { r, marker } = withPlanted(manifest.script, true);
    expect(existsSync(marker)).toBe(false);
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/json\.py/);
  });

  it('CONTROL without -I the same planted modules DO run, and the quiet one leaves the step green: the arms above are not passing because Python never looked', () => {
    const exposed = manifest.script.replace(/\bpython3 -I -/, 'python3 -');
    expect(exposed).not.toBe(manifest.script);
    const loud = withPlanted(exposed, false);
    expect(readFileSync(loud.marker, 'utf8')).toMatch(/json ran/);
    const quiet = withPlanted(exposed, true);
    expect(readFileSync(quiet.marker, 'utf8')).toMatch(/json ran/);
    expect(quiet.r.status, quiet.r.out).toBe(0);
  });
});

describe('the build job hands over only what it collected', () => {
  const collect = scriptOf('build', 'ARTIFACT_PATHS');

  /** A macOS build's outputs, as tauri-action reports them in artifactPaths. */
  function macBuild(dir: string, dmg = 'Driftstack_0.1.71_universal.dmg'): string[] {
    const bundle = join(dir, 'target', 'universal-apple-darwin', 'release', 'bundle');
    mkdirSync(join(bundle, 'dmg'), { recursive: true });
    mkdirSync(join(bundle, 'macos', 'Driftstack.app'), { recursive: true });
    writeFileSync(join(bundle, 'dmg', dmg), 'dmg bytes');
    writeFileSync(join(bundle, 'macos', 'Driftstack.app.tar.gz'), 'tarball bytes');
    return [
      join(bundle, 'dmg', dmg),
      join(bundle, 'macos', 'Driftstack.app'),
      join(bundle, 'macos', 'Driftstack.app.tar.gz'),
    ];
  }
  const run = (dir: string, paths: string[]): Ran =>
    runStep(collect.step, collect.script, dir, {
      ARTIFACT_PATHS: JSON.stringify(paths),
      PLATFORM: 'macos-latest',
    });

  it('CONTROL a clean build hands over its two macOS bundles under their release names', () => {
    const dir = freshWorkspace('collect');
    const r = run(dir, macBuild(dir));
    expect(r.status, r.out).toBe(0);
    expect(readdirSync(join(dir, 'workspace', 'release-assets')).sort()).toEqual([
      'Driftstack_0.1.71_universal.dmg',
      'Driftstack_universal.app.tar.gz',
    ]);
  });

  it('CRITICAL a file the build wrote into release-assets/ before the collect is not handed over', () => {
    const dir = freshWorkspace('collect');
    const assets = join(dir, 'workspace', 'release-assets');
    mkdirSync(join(assets, '.git'), { recursive: true });
    writeFileSync(join(assets, 'json.py'), 'x = 1\n');
    const r = run(dir, macBuild(dir));
    expect(r.status, r.out).toBe(0);
    expect(readdirSync(assets).sort()).toEqual([
      'Driftstack_0.1.71_universal.dmg',
      'Driftstack_universal.app.tar.gz',
    ]);
  });

  it('a bundle name that is not a plain file name fails the build', () => {
    const dir = freshWorkspace('collect');
    const r = run(dir, macBuild(dir, 'Driftstack GUI_0.1.71_universal.dmg'));
    expect(r.status).toBe(1);
    expect(r.out).toMatch(/::error::[^\n]*Driftstack GUI_0\.1\.71_universal\.dmg/);
  });
});

describe('the signer is handed each bundle as a path, never as an argument it could parse', () => {
  const signStep = scriptOf('sign', 'signer sign');

  it('CRITICAL every bundle reaches `tauri signer sign` as ./<name>, so a name starting with "-" is a file, not an option', () => {
    const dir = freshWorkspace('sign');
    const names = BUNDLES.map((n) =>
      n.endsWith('.AppImage') ? '--private-key-path=x.AppImage' : n,
    );
    handover(dir, names);
    // A stand-in signer: logs its argv, one argument per line, and writes <file>.sig.
    const modules = join(dir, 'runner-temp', 'updater-signer', 'node_modules');
    mkdirSync(join(modules, '.bin'), { recursive: true });
    mkdirSync(join(modules, '@tauri-apps', 'cli-linux-x64-gnu'), { recursive: true });
    writeFileSync(join(modules, '@tauri-apps', 'cli-linux-x64-gnu', 'cli.linux-x64-gnu.node'), '');
    const log = join(dir, 'signer-argv.log');
    const tauri = join(modules, '.bin', 'tauri');
    writeFileSync(
      tauri,
      [
        '#!/usr/bin/env bash',
        'printf "%s\\n" "$@" "@@end-of-call@@" >> "$SIGNER_LOG"',
        'printf "sig" > "${!#}.sig"',
        '',
      ].join('\n'),
    );
    chmodSync(tauri, 0o755);
    const r = runStep(signStep.step, signStep.script, dir, {
      TAURI_SIGNING_PRIVATE_KEY: 'not-a-key',
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: '',
      SIGNER_LOG: log,
    });
    expect(r.status, r.out).toBe(0);
    const calls = readFileSync(log, 'utf8')
      .split('@@end-of-call@@\n')
      .filter(Boolean)
      .map((c) => c.split('\n').filter(Boolean));
    expect(calls).toHaveLength(4);
    for (const argv of calls) {
      expect(argv.slice(0, 2)).toEqual(['signer', 'sign']);
      expect(argv).toHaveLength(3);
      expect(argv[2]).toMatch(/^\.\//);
    }
    expect(calls.map((c) => c[2])).toContain('./--private-key-path=x.AppImage');
  });
});
