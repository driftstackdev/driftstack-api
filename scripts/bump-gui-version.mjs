#!/usr/bin/env node
// Bump the desktop client (apps/gui-client) version in the four files that carry it,
// each edit SCOPED to the field that names the app — never a blanket replace.
//
// Why a script: the 0.1.45 release replaced every `version = "0.1.44"` line in
// Cargo.lock, which hit the `tracing` crate (it happened to sit at 0.1.44) and left
// the app's own lock entry untouched (it had been stale at 0.1.36 since that release,
// because no later bump matched it). All three release builds failed at dependency
// resolution, and the asset-less release became the "latest" release the updater
// fetches its manifest from. A scoped edit cannot do either.
//
// Usage: node scripts/bump-gui-version.mjs <x.y.z> [--root <repo>] [--no-validate]
//   Writes package.json, src-tauri/tauri.conf.json, src-tauri/Cargo.toml and
//   src-tauri/Cargo.lock, then validates the lock with
//   `cargo update -w --locked --offline` (falling back to the network when the
//   offline index cannot answer). Exit 1 on any refusal; nothing is written unless
//   every edit resolves.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEMVER_RE = /^\d+\.\d+\.\d+$/;

/** Files (relative to apps/gui-client) that carry the version, and their editors. */
export const GUI_VERSION_FILES = Object.freeze([
  'package.json',
  'src-tauri/tauri.conf.json',
  'src-tauri/Cargo.toml',
  'src-tauri/Cargo.lock',
]);

function replaceExactlyOnce(text, re, replacement, what) {
  const matches = text.match(
    new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`),
  );
  const count = matches === null ? 0 : matches.length;
  if (count !== 1) {
    throw new Error(
      `${what}: expected exactly one match, found ${String(count)} — refusing to edit`,
    );
  }
  return text.replace(re, replacement);
}

/** The top-level `"version"` of a JSON file: two-space indent, first key at depth 1. */
export function bumpJsonVersion(text, version, what = 'package.json') {
  return replaceExactlyOnce(
    text,
    /^ {2}"version": "\d+\.\d+\.\d+"/m,
    `  "version": "${version}"`,
    what,
  );
}

/** The `[package]` section's `version` of Cargo.toml — never a dependency's. The
 *  section is scanned line by line (header to the next `[...]` header) and must hold
 *  exactly one version line. */
export function bumpCargoToml(text, version) {
  const lines = text.split('\n');
  const headers = lines.map((l, i) => (l.trim() === '[package]' ? i : -1)).filter((i) => i !== -1);
  if (headers.length !== 1) {
    throw new Error(
      `Cargo.toml [package]: expected exactly one section, found ${String(headers.length)} — refusing to edit`,
    );
  }
  const start = headers[0];
  let end = lines.findIndex((l, i) => i > start && /^\s*\[/.test(l));
  if (end === -1) end = lines.length;
  const hits = [];
  for (let i = start + 1; i < end; i += 1)
    if (/^version\s*=\s*"\d+\.\d+\.\d+"\s*$/.test(lines[i])) hits.push(i);
  if (hits.length !== 1) {
    throw new Error(
      `Cargo.toml [package] version: expected exactly one match, found ${String(hits.length)} — refusing to edit`,
    );
  }
  lines[hits[0]] = `version = "${version}"`;
  return lines.join('\n');
}

/** The app's OWN `[[package]]` entry of Cargo.lock, whatever it currently says: the
 *  version line directly after `name = "<crate>"`. Any other crate at the same number
 *  is left alone — that is the whole point. */
export function bumpCargoLock(text, version, crate = 'driftstack-gui') {
  const header = `[[package]]\nname = "${crate}"\n`;
  const count = text.split(header).length - 1;
  if (count !== 1) {
    throw new Error(
      `Cargo.lock [[package]] ${crate}: expected exactly one match, found ${String(count)} — refusing to edit`,
    );
  }
  const at = text.indexOf(header) + header.length;
  const m = /^version = "[^"\n]+"\n/.exec(text.slice(at));
  if (m === null)
    throw new Error(
      `Cargo.lock [[package]] ${crate}: no version line after the name — refusing to edit`,
    );
  return `${text.slice(0, at)}version = "${version}"\n${text.slice(at + m[0].length)}`;
}

/** Every edit, computed before anything is written — one refusal writes nothing. */
export function planBump(files, version) {
  if (!SEMVER_RE.test(version)) throw new Error(`not a version: ${JSON.stringify(version)}`);
  return {
    'package.json': bumpJsonVersion(files['package.json'], version, 'package.json'),
    'src-tauri/tauri.conf.json': bumpJsonVersion(
      files['src-tauri/tauri.conf.json'],
      version,
      'tauri.conf.json',
    ),
    'src-tauri/Cargo.toml': bumpCargoToml(files['src-tauri/Cargo.toml'], version),
    'src-tauri/Cargo.lock': bumpCargoLock(files['src-tauri/Cargo.lock'], version),
  };
}

/** `cargo update -w --locked` proves the lock is consistent with Cargo.toml AND the
 *  registry: it fails on a stale app entry and on a crate pinned to a version that
 *  does not exist. Offline first (instant); the network variant when the offline
 *  index cannot answer. */
export function validateCargoLock(srcTauriDir) {
  const run = (extra) =>
    spawnSync('cargo', ['update', '-w', '--locked', ...extra], {
      cwd: srcTauriDir,
      encoding: 'utf8',
    });
  const offline = run(['--offline']);
  if (offline.status === 0) return { ok: true, output: offline.stderr };
  const online = run([]);
  return { ok: online.status === 0, output: `${offline.stderr}\n${online.stderr}` };
}

export function main(argv) {
  const args = [...argv];
  const noValidate = args.includes('--no-validate');
  const rootIdx = args.indexOf('--root');
  const root = rootIdx === -1 ? process.cwd() : args[rootIdx + 1];
  const positional = args.filter(
    (a, i) => !a.startsWith('--') && (rootIdx === -1 || i !== rootIdx + 1),
  );
  const version = positional[0];
  if (version === undefined) {
    process.stderr.write('usage: bump-gui-version.mjs <x.y.z> [--root <repo>] [--no-validate]\n');
    return 2;
  }
  const gui = resolve(root, 'apps', 'gui-client');
  const files = Object.fromEntries(
    GUI_VERSION_FILES.map((f) => [f, readFileSync(resolve(gui, f), 'utf8')]),
  );
  let plan;
  try {
    plan = planBump(files, version);
  } catch (err) {
    process.stderr.write(`✗ ${err instanceof Error ? err.message : String(err)}\n`);
    return 1;
  }
  for (const f of GUI_VERSION_FILES) writeFileSync(resolve(gui, f), plan[f]);
  process.stdout.write(`→ gui-client version → ${version} (${GUI_VERSION_FILES.join(', ')})\n`);
  if (noValidate) return 0;
  const v = validateCargoLock(resolve(gui, 'src-tauri'));
  if (!v.ok) {
    process.stderr.write(`✗ Cargo.lock is not consistent after the bump:\n${v.output}\n`);
    return 1;
  }
  process.stdout.write('→ Cargo.lock consistent (cargo update -w --locked)\n');
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
