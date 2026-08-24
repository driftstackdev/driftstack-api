// `errors-site` was never built by the build.
//
// It had a `build.mjs` and a gitignored `dist/`, but NO package.json — so it
// was not an npm workspace, and `build:apps` ("npm run build -w apps
// --if-present") iterates workspaces. Nothing else invoked it either: no
// script, no workflow. The only reference anywhere was
// check-rendered-product-status.mjs, which READS its dist.
//
// Locally that is invisible: dist/ is gitignored, so whoever ran `node
// build.mjs` once keeps a stale copy forever and every guard passes. On a fresh
// CI checkout there is no dist, and the guard failed with "errors-site: missing
// dist/ (build the app before running this guard)" — which reads as a guard
// ordering problem rather than what it was: an application the build does not
// build.
//
// This matters beyond CI. Every RFC-9457 problem the API emits carries
// `type: https://errors.driftstack.dev/<slug>`, so this site is the
// destination of every error link we hand a developer. An app nothing builds is
// an app nothing can keep current.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

const guard = readFileSync(resolve(REPO_ROOT, 'scripts/check-rendered-product-status.mjs'), 'utf8');

/** The app directories the rendered guard walks. */
function appsTheGuardReads(): string[] {
  const block = /const APPS = \[([\s\S]*?)\]/.exec(guard);
  expect(
    block,
    'could not find the guard APPS list — this test is reading the wrong shape',
  ).not.toBeNull();
  return [...(block?.[1] ?? '').matchAll(/'([a-z0-9-]+)'/g)].map((m) => m[1]!);
}

describe('every app the guards read is actually built', () => {
  it('CRITICAL each app the rendered guard reads is an npm workspace with a build script. Without one, `build:apps` skips it silently and only a stale local dist hides that.', () => {
    const apps = appsTheGuardReads();
    expect(
      apps.length,
      'the guard app list came back empty — the arm below would prove nothing',
    ).toBeGreaterThan(3);

    const unbuildable = apps.filter((app) => {
      const pkgPath = resolve(REPO_ROOT, 'apps', app, 'package.json');
      if (!existsSync(pkgPath)) return true;
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { scripts?: Record<string, string> };
      return typeof pkg.scripts?.build !== 'string';
    });
    expect(
      unbuildable,
      'these apps are READ by the rendered guard but are not workspaces with a build script, so `npm run build -w apps --if-present` skips them',
    ).toEqual([]);
  });

  it('every app directory carrying a build entrypoint is reachable from the workspace build', () => {
    // The inverse of the arm above: an app can also acquire a build.mjs without
    // ever being wired in. Anything with a build entrypoint must be a workspace.
    const appsDir = resolve(REPO_ROOT, 'apps');
    const orphans = readdirSync(appsDir, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .filter((e) => existsSync(resolve(appsDir, e.name, 'build.mjs')))
      .filter((e) => !existsSync(resolve(appsDir, e.name, 'package.json')))
      .map((e) => e.name);
    expect(orphans, 'these have a build.mjs but no package.json, so nothing runs it').toEqual([]);
  });
});
