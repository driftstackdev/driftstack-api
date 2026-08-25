// A suite that executes a BUILT page is only as truthful as the last build.
//
// 48 test files execute a page out of a gitignored `dist/`. That artifact is
// not rebuilt by `vitest run`, so those suites assert against whatever markup
// happens to be on disk — and it is wrong in BOTH directions:
//
//   • stale dist ⇒ tests pass against markup the source no longer produces.
//     Measured 2026-07-30 on admin-panel: 10 tests were falsely GREEN and only
//     became honest failures after a rebuild.
//   • missing dist ⇒ a wall of raw ENOENTs. Observed 2026-08-02: a workspace
//     build rewrote `dist/` mid-run and select-tier-page.test.ts produced seven
//     of them, none of which named the actual problem.
//
// `admin-cost-page.test.ts` already carries a BUILD PRECONDITION for exactly
// this (871b8b355), scoped to its own app. That was one file out of 48. This
// generalises it: the app list is DERIVED from the dist paths suites actually
// read, so a new page-executing suite is covered without anyone remembering.
//
// CI is unaffected — `npm run build` runs `build:apps` across every app
// workspace before `vitest run`, so CI always has a fresh artifact. This exists
// for the local runs that agents gate their commits on.
//
// Whole-app `src` granularity is deliberate and matches the precedent: a
// changed shared Layout restales every page while no page source moved, which
// is precisely the false-green case worth catching.
//
// V-954 — `packages/*/dist` is OUT of scope, measured rather than assumed, and the
// reason is asserted below rather than left as prose.
//
// The question is a fair one: `@driftstack/api-types` resolves to `dist/index.js`,
// 274 test files import it, and V-951 was bitten by exactly that — a source edit to
// `packages/api-types/src/auth.ts` did not reach the assertion reading the built
// package, so a mutation proof came back clean when it should have failed.
//
// Two measurements say an mtime rule is the wrong instrument here. First, all three
// packages whose `src` mtime currently exceeds their `dist` mtime are false alarms:
// a fresh `tsc` build of `api-types` into a scratch directory reproduces the `dist`
// ON DISK, and the newest `src` mtime is a `cp` that restored a mutation to its
// original bytes. On disk rather than committed: `dist/` is gitignored and carries
// zero tracked files, so what the server loads is whatever the last local build
// left, which is exactly why the comparison is worth making.
//
// V-1594 — RE-MEASURED, and the word "byte-identical" this note used to carry does
// not survive the re-measurement. It is true of the thing that matters and false of
// the artefact as a whole, which is worth stating precisely because someone
// repeating the check and seeing fourteen differing files would read drift that is
// not there. Today, building into a scratch `--outDir`:
//
//   • emitted `.js`   — 0 differences. The code the server executes is identical.
//   • emitted `.d.ts` — 24 files, 14 of them differing in BYTES and none in meaning.
//     Every difference is ordering: properties emitted in a different sequence, and
//     union members likewise (`admin.d.ts` moves `webhook_delivery.replayed` to the
//     front of a 32-member union whose membership is unchanged). Verified as a token
//     multiset per file rather than by reading the diffs, because a reordered union
//     is indistinguishable from an edited one at a glance.
//   • `.map` and `.tsbuildinfo` — expected to differ. Sourcemaps embed the output
//     path, so a scratch `outDir` guarantees it; the buildinfo is incremental state.
//
// So the scope decision stands on "semantically identical", not on byte equality.
//
// V-1595 — a third hazard belongs here, distinct from the two above because it bites
// the person checking rather than the test. Both of those are about assertions
// reading a stale artefact. This one is about MUTATION PROOFS: editing
// `packages/api-types/src` and re-running proves nothing, because the running server
// and every e2e spec load the built package. It cost two inert mutations that each
// looked like a guard correctly holding, and the only tell was an error message
// returning with identical text. A mutation aimed at a package must rebuild it or
// aim at the server source instead. `behavioural-simulation` and
// `recipe-library` are the same shape — a checkout or touch, with `dist` built after
// the last real source commit. An mtime guard over packages would have opened this
// session red, three times, with nothing wrong.
//
// Second, the thing that actually protects the package layer is `pretest`, which
// runs `npm run build --workspaces` before `vitest run` — so the canonical `npm test`
// path cannot read a stale package at all. That is a real invariant, so it is pinned
// below: if `pretest` stops building the workspaces, this scope decision stops being
// safe and the guard says so instead of silently continuing to skip packages.
//
// What remains is the direct `npx vitest run` path, which skips `pretest` — and the
// mitigation that works there is not an mtime check. It is asserting against source
// text when the claim is about source, which is what V-951 did once it knew.

import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const APPS = resolve(REPO_ROOT, 'apps');
const SELF = fileURLToPath(import.meta.url);

/** A suite that executes a built page names the page file. */
const EXECUTES_A_PAGE = /index\.html/;

/** `apps/<name>/dist` — an artifact addressed by repo-relative path. */
const DIST_BY_PATH = /['"]apps\/([a-z0-9-]+)\/dist\b/g;

/** `resolve(HERE, '..', '..', 'dist', …)` — the suite's OWN app's artifact. */
const DIST_BY_RELATIVE =
  /(?:readFileSync|existsSync|resolve)\([^;]{0,200}?['"]\.\.['"][^;]{0,160}?['"]dist['"]|resolve\(\s*HERE[^;]{0,160}?['"]dist['"]/;

interface AppFreshness {
  /** Newest mtime among built pages, or null when nothing is built. */
  builtMs: number | null;
  /** Newest mtime under the app's source, or null when it has no `src`. */
  sourceMs: number | null;
}

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = resolve(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function newestMtimeMs(files: string[]): number | null {
  let newest: number | null = null;
  for (const f of files) {
    const m = statSync(f).mtimeMs;
    if (newest === null || m > newest) newest = m;
  }
  return newest;
}

/**
 * Apps whose built pages some suite executes.
 *
 * Attributed by the dist PATH, not by where the test lives: a suite under
 * apps/server reads apps/errors-site/dist, and the app that needs rebuilding is
 * the one named in the path. Attributing by test location blamed `server`,
 * whose `dist` is compiled TypeScript containing no pages at all.
 */
function appsWithPageExecutingSuites(): string[] {
  const found = new Set<string>();
  for (const entry of readdirSync(APPS, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const owner = entry.name;
    for (const f of walk(resolve(APPS, owner, 'tests'))) {
      if (!/\.test\.tsx?$/.test(f)) continue;
      // A guard that scans test sources for these patterns contains them, so
      // without this it discovers itself.
      if (f === SELF) continue;
      const src = readFileSync(f, 'utf8');
      if (!EXECUTES_A_PAGE.test(src)) continue;
      for (const m of src.matchAll(DIST_BY_PATH)) {
        if (m[1] !== undefined) found.add(m[1]);
      }
      if (DIST_BY_RELATIVE.test(src)) found.add(owner);
    }
  }
  return [...found].sort();
}

function freshnessOf(app: string): AppFreshness {
  const built = walk(resolve(APPS, app, 'dist')).filter((f) => f.endsWith('index.html'));
  return {
    builtMs: newestMtimeMs(built),
    sourceMs: newestMtimeMs(walk(resolve(APPS, app, 'src'))),
  };
}

/**
 * The verdict, as a pure function of the measurements.
 *
 * Separated from the filesystem so the arm below can feed it a known-bad
 * reading — a comparator that silently stopped comparing would otherwise report
 * the same clean result as a fully-rebuilt tree.
 *
 * `sourceMs === null` means the app has no `src` (errors-site ships prebuilt
 * assets). Freshness is not assessable there, so only existence is checked.
 */
function classify(f: AppFreshness): 'missing' | 'stale' | 'fresh' {
  if (f.builtMs === null) return 'missing';
  if (f.sourceMs === null) return 'fresh';
  return f.builtMs >= f.sourceMs ? 'fresh' : 'stale';
}

const apps = appsWithPageExecutingSuites();

describe('every suite that executes a built page has a fresh artifact to execute', () => {
  it('CRITICAL the app list is derived from real page-executing suites and the comparator still distinguishes fresh from stale. Both assertions below report an absence, so a discovery that found nothing, or a comparator that always answers "fresh", would satisfy them having checked nothing.', () => {
    expect(apps.length, 'apps whose built pages some suite executes').toBeGreaterThanOrEqual(5);
    // admin-panel produced the 2026-07-30 stale-artifact incident and
    // customer-dashboard the ENOENT wall; errors-site is the one attributed
    // from a path rather than from the reading test's own location.
    for (const expected of ['admin-panel', 'customer-dashboard', 'errors-site']) {
      expect(apps, `${expected} is discovered`).toContain(expected);
    }

    // Both path styles must be recognised. Requiring a literal `dist/` missed
    // all 27 customer-dashboard suites; requiring index.html to FOLLOW the
    // quoted dist string missed every single-path suite, because the filename
    // sits inside that same string.
    expect(
      DIST_BY_RELATIVE.test("const P = resolve(HERE, '..', '..', 'dist', 'cost', 'index.html');"),
      'segmented relative form',
    ).toBe(true);
    expect(
      [...`const P = resolve(REPO_ROOT, 'apps/docs/dist/index.html');`.matchAll(DIST_BY_PATH)].map(
        (m) => m[1],
      ),
      'single-path form names its app',
    ).toEqual(['docs']);

    // The comparator, on readings whose verdict is not in doubt.
    expect(classify({ builtMs: null, sourceMs: 10 }), 'nothing built').toBe('missing');
    expect(classify({ builtMs: 5, sourceMs: 10 }), 'built before the source changed').toBe('stale');
    expect(classify({ builtMs: 10, sourceMs: 5 }), 'built after the source changed').toBe('fresh');
    expect(classify({ builtMs: 10, sourceMs: 10 }), 'built in the same instant').toBe('fresh');
    expect(classify({ builtMs: 1, sourceMs: null }), 'no src to compare against').toBe('fresh');
  });

  it('CRITICAL the reason packages/*/dist is out of scope still holds: pretest builds every workspace before vitest runs, so the canonical npm test path cannot read a stale package. 274 test files import @driftstack/api-types from its dist, and V-951 was bitten by a source edit that did not reach the built package — so this scope decision is only safe while that build step exists. If it goes, packages need covering here and this fails rather than quietly continuing to skip them.', () => {
    const scripts = JSON.parse(readFileSync(resolve(REPO_ROOT, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>;
    };
    const pretest = scripts.scripts?.['pretest'];
    expect(pretest, 'the repo still has a pretest step').toBeDefined();
    expect(
      pretest ?? '',
      'pretest no longer builds the workspaces, so `npm test` can now read a stale packages/*/dist — ' +
        'either restore the build or extend this guard to cover packages',
    ).toContain('npm run build --workspaces');
  });

  it('CRITICAL every app with page-executing suites has a built artifact. Without one those suites do not fail with a reason — they emit a wall of raw ENOENTs naming a missing file rather than a missing build.', () => {
    const missing = apps
      .filter((app) => classify(freshnessOf(app)) === 'missing')
      .map(
        (app) =>
          `${app}: nothing built under apps/${app}/dist —\n` +
          `  npm run build --workspace @driftstack/${app}`,
      );
    expect(missing, 'app(s) whose suites execute a page that has not been built:').toEqual([]);
  });

  it('CRITICAL no app is asserting against markup its source no longer produces. This is the direction that PASSES: a stale artifact makes the suite green against the previous build, so nothing else in the run can reveal it.', () => {
    const stale = apps
      .filter((app) => classify(freshnessOf(app)) === 'stale')
      .map((app) => {
        const f = freshnessOf(app);
        return (
          `${app}: built ${new Date(f.builtMs ?? 0).toISOString()} but source changed ` +
          `${new Date(f.sourceMs ?? 0).toISOString()} — REBUILD, do not repin assertions onto ` +
          `stale markup:\n  npm run build --workspace @driftstack/${app}`
        );
      });
    expect(stale, 'app(s) whose built artifact predates their source:').toEqual([]);
  });
});
