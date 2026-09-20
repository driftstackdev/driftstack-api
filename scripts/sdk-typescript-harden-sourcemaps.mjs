#!/usr/bin/env node
// The published sourcemaps carry OUR source text and nobody else's.
//
// ⛔ WHY THIS EXISTS. The SDK bundles `@driftstack/api-types` into both outputs
// so `require('@driftstack/sdk')` works (see tsup.config.ts). esbuild follows
// api-types' own sourcemaps back to its TypeScript and embeds that text in
// `sourcesContent`, and api-types' src/ is NOT customer-facing text: only its
// compiled dist/ is swept. Measured 2026-09-20, the first bundled build took
// the SDK's shipped-text scan from 0/0 to 194 ticket ids + 320 internal
// vocabulary hits, every single one inside `sourcesContent` for an
// `api-types/src/*.ts` entry, and none anywhere else in the tarball.
//
// The fix is not to drop sourcemaps. dist/*.map is how a customer's debugger
// reads a stack trace, the tarball does not ship src/, so `sourcesContent` is
// the only copy of our source a customer ever gets. This step keeps OUR
// entries and drops everyone else's:
//
//   · a source under packages/sdk-typescript → text kept, path untouched
//   · any other source            → `sourcesContent[i] = null` (the sourcemap
//     spec's "no text available") and the path rewritten to its package-
//     qualified form, so a map names `@driftstack/api-types/src/common.ts`
//     rather than a relative walk through this repository's layout
//
// Line and column `mappings` are untouched, so a trace still resolves to a
// file and a line; only the embedded copy of somebody else's file goes away.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// Lives in the repo-root `scripts/` directory, like
// `api-types-build-publish.mjs`, and is invoked from the package's own build
// script as `node ../../scripts/…`. So the package it acts on is named, not
// inferred from this file's location.
export const PACKAGE_DIR = resolve(HERE, '..', 'packages', 'sdk-typescript');
export const MAPS = ['dist/index.js.map', 'dist/index.cjs.map'];

/**
 * Whether `source` (as it appears in a map next to `mapPath`) is a file of THIS
 * package — the only text this package may publish.
 */
export function isOwnSource(source, mapDir) {
  if (typeof source !== 'string' || source.startsWith('<')) return false;
  const rel = relative(PACKAGE_DIR, resolve(mapDir, source));
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith(sep);
}

/**
 * The package-qualified name for a foreign source, derived from the path it
 * already has. `../../api-types/src/common.ts` in this monorepo is
 * `@driftstack/api-types/src/common.ts` on npm; anything the pattern does not
 * recognise keeps only its basename, which cannot describe a repository layout.
 *
 * ⛔ NOT a lookup table of package names. A table goes stale silently the first
 * time a second dependency is bundled, and a stale table here does not fail —
 * it publishes the repo-relative path it could not translate.
 */
export function publicSourceName(source) {
  const m =
    /(?:^|\/)packages\/([^/]+)\/(.*)$/u.exec(source) ?? /\.\.\/([^./][^/]*)\/(.*)$/u.exec(source);
  if (m === null) return `<${source.split('/').pop()}>`;
  const [, pkgDir, rest] = m;
  return `@driftstack/${pkgDir === 'sdk-typescript' ? 'sdk' : pkgDir}/${rest}`;
}

/**
 * `map` with every foreign source's embedded text removed. Pure: returns a new
 * object and reports what it changed, so the guard can assert on the report
 * rather than on a side effect.
 */
export function hardenMap(map, mapDir) {
  const sources = [...(map.sources ?? [])];
  const contents = map.sourcesContent === undefined ? undefined : [...map.sourcesContent];
  const dropped = [];
  for (let i = 0; i < sources.length; i++) {
    if (isOwnSource(sources[i], mapDir)) continue;
    dropped.push(sources[i]);
    sources[i] = publicSourceName(sources[i]);
    if (contents !== undefined) contents[i] = null;
  }
  const out = { ...map, sources };
  if (contents !== undefined) out.sourcesContent = contents;
  return { map: out, dropped };
}

function main() {
  let total = 0;
  for (const relPath of MAPS) {
    const file = resolve(PACKAGE_DIR, relPath);
    const map = JSON.parse(readFileSync(file, 'utf8'));
    const before = (map.sources ?? []).length;
    const { map: hardened, dropped } = hardenMap(map, dirname(file));
    // A step that quietly rewrote nothing because it misread the shape is the
    // failure this guards against, so the invariant is asserted, not assumed.
    if ((hardened.sources ?? []).length !== before) {
      process.stderr.write(`harden-sourcemaps: ${relPath} changed length — refusing to write.\n`);
      return 1;
    }
    writeFileSync(file, JSON.stringify(hardened));
    total += dropped.length;
    process.stdout.write(
      `harden-sourcemaps: ${relPath} — ${dropped.length} foreign source(s) de-embedded of ${before}.\n`,
    );
  }
  if (total === 0) {
    process.stdout.write('harden-sourcemaps: nothing foreign was embedded.\n');
  }
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
