#!/usr/bin/env node
// Self-heal the vitest dependency cache before a run.
//
// Vite persists a cache under `node_modules/.vite`, and entries in it can embed
// absolute paths into the OS temp root (`os.tmpdir()`, which on macOS is a
// per-user directory under /var/folders). macOS reaps that directory on a
// schedule and on reboot, so a cache written in one session can point at paths
// that no longer exist in the next. Vitest then fails to COLLECT the affected
// files rather than failing a test:
//
//   Error: ENOENT: no such file or directory, open
//   '/var/folders/.../T/<id>/ssr/.tmp-...'
//
// The visible symptom is a collapsed suite — A3 measured a run drop from 26,400
// tests to 645 — reported as collection errors rather than as an obviously
// stale cache. The remedy (`rm -rf node_modules/.vite`) is trivial once you
// know it; the cost is the hour spent not knowing. It has now cost time in at
// least two agents' runs.
//
// This removes ONLY cache directories that actually reference a missing temp
// path, so a healthy cache is left alone and the usual warm-start speed is
// kept. The cache is regenerated on demand, so deleting it can lose nothing but
// time.

import { existsSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
/** Absolute temp-root references are the ones that go stale. */
const TEMP_ROOT = tmpdir();

function cacheDirs() {
  const roots = [join(REPO_ROOT, 'node_modules', '.vite')];
  const appsDir = join(REPO_ROOT, 'apps');
  if (existsSync(appsDir)) {
    for (const app of readdirSync(appsDir)) {
      roots.push(join(appsDir, app, 'node_modules', '.vite'));
    }
  }
  return roots.filter((d) => existsSync(d));
}

/** Every absolute temp path this cache file refers to. */
function referencedTempPaths(file) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const pattern = new RegExp(
    `${TEMP_ROOT.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[^"'\\s\\\\]*`,
    'g',
  );
  return [...new Set(text.match(pattern) ?? [])];
}

function filesUnder(dir, depth = 0) {
  if (depth > 4) return [];
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    try {
      if (statSync(full).isDirectory()) out.push(...filesUnder(full, depth + 1));
      else out.push(full);
    } catch {
      /* raced with another writer; skip */
    }
  }
  return out;
}

let cleared = 0;
for (const dir of cacheDirs()) {
  const stale = filesUnder(dir).some((f) =>
    referencedTempPaths(f).some((p) => !existsSync(p.split(/[?#]/)[0])),
  );
  if (!stale) continue;
  rmSync(dir, { recursive: true, force: true });
  cleared += 1;
  // Deliberately loud: a silently-healed cache teaches nobody why the suite
  // was about to collapse.
  console.warn(
    `[vite-cache] removed ${dir.replace(`${REPO_ROOT}/`, '')} — it referenced a temp path the OS has reaped. ` +
      `This is the cause of "ENOENT .../ssr/.tmp-*" collection errors and a suddenly tiny test count.`,
  );
}

if (process.argv.includes('--report') && cleared === 0) {
  console.log('[vite-cache] no stale cache found');
}
