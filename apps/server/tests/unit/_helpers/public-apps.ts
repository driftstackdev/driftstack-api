// The set of apps that actually ship to the public internet.
//
// Derived from `scripts/deploy-frontend.sh`, which is the authority: its case
// statement maps each app to a Cloudflare Pages project slug, and an app not in
// it cannot be deployed by any supported path.
//
// It is derived rather than listed because a hand-listed roster is how
// `errors-site` came to sit outside the V-211 and V-205 sweeps. Those sweeps
// each named five app directories inline and claimed to cover "public-visible
// apps"; errors-site is the sixth, is deployed to errors.driftstack.dev, and is
// linked from EVERY RFC-9457 problem response the API emits — so developers
// reach it directly from errors. Nothing was wrong in it, but nothing was
// checking either, and the next app added would have been missed the same way.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..', '..', '..', '..');

const DEPLOY_SCRIPT = resolve(REPO_ROOT, 'scripts', 'deploy-frontend.sh');

/**
 * App directory names deployed to Cloudflare Pages, from the deploy script's
 * case statement.
 *
 * Matches `  <app>) SLUG="..."` and nothing else, so the usage comment above it
 * — which lists the same names in prose — cannot contribute and cannot mask a
 * name that was dropped from the case statement itself.
 */
export function publicApps(): string[] {
  const src = readFileSync(DEPLOY_SCRIPT, 'utf8');
  const names = new Set<string>();
  for (const m of src.matchAll(/^\s*([a-z][a-z0-9-]*)\)\s*SLUG="/gm)) names.add(m[1]!);
  return [...names].sort();
}

/** Absolute paths to those app directories. */
export function publicAppDirs(): string[] {
  return publicApps().map((a) => resolve(REPO_ROOT, 'apps', a));
}

/**
 * Source extensions a public app can ship customer-visible text in.
 *
 * `.mjs` is here for a reason worth keeping: errors-site is dependency-free and
 * generates every page from `build.mjs`, so its entire customer-facing content
 * is in a single `.mjs` file. Adding the directory without the extension would
 * have widened the scan onto a file set of zero — a fix that reports success and
 * checks nothing, which is worse than the gap it replaced.
 */
export const PUBLIC_APP_EXTS: readonly string[] = [
  '.md',
  '.astro',
  '.ts',
  '.tsx',
  '.css',
  '.html',
  '.mjs',
];
