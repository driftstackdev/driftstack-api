// The public-surface sweeps must cover every app that actually deploys.
//
// `errors-site` is deployed to errors.driftstack.dev, and every RFC-9457
// problem+json the API emits carries a `type` URI pointing at it — so a
// developer hitting any error is sent there directly. It is as customer-facing
// as the marketing site.
//
// It was outside both the V-211 personal-name sweep and the V-205 attribution
// sweep, each of which listed five app directories inline while describing
// itself as covering "public-visible apps". Nothing was wrong inside it, and
// that is the point: the sweeps were not reporting it clean, they were not
// looking. The seventh app would have been missed identically.
//
// TWO roots had to move, and the second is the one worth remembering: adding
// the directory alone would have scanned ZERO new files, because the extension
// list did not include `.mjs` and errors-site generates every page from a single
// dependency-free `build.mjs`. A widening that reports success while matching
// nothing is worse than the gap, since it also retires the suspicion. Both were
// confirmed load-bearing by planting a violation in `build.mjs` and removing
// each widening in turn — with the directory dropped the sweeps went green, and
// with `.mjs` dropped they went green, while the violation sat there.
//
// This guard pins the derivation itself so neither root can quietly narrow.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PUBLIC_APP_EXTS, REPO_ROOT, publicAppDirs, publicApps } from './_helpers/public-apps';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The sweeps whose stated scope is "every public app". */
const PUBLIC_SWEEPS: readonly string[] = [
  'public-app-v211-personal-name-sweep.test.ts',
  'public-app-v205-attribution-sweep.test.ts',
];

function sweepSource(name: string): string {
  return readFileSync(resolve(HERE, name), 'utf8');
}

/** Files a sweep would actually read for one app, under the shared extensions. */
function scannableFileCount(dir: string): number {
  let n = 0;
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '.astro')
        continue;
      const full = resolve(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (PUBLIC_APP_EXTS.some((e) => entry.name.endsWith(e))) n += 1;
    }
  };
  walk(dir);
  return n;
}

describe('public-surface sweeps cover every deployed app', () => {
  it('CRITICAL the roster derives from the deploy script and is not empty. Every case below asserts an absence, so a derivation that silently returned nothing would report all of them clean.', () => {
    const apps = publicApps();
    expect(apps.length, 'apps parsed from deploy-frontend.sh').toBeGreaterThanOrEqual(6);
    expect(apps, 'the app this guard exists for').toContain('errors-site');
    expect(apps, 'and a long-standing one').toContain('marketing-site');
  });

  it('CRITICAL every derived app directory exists. A roster naming a directory that is not there would shrink the scan back to the apps that happen to remain, which is the original defect wearing a derivation.', () => {
    const missing = publicAppDirs().filter((d) => !existsSync(d));
    expect(missing, 'derived app dir(s) that do not exist:').toEqual([]);
  });

  it('CRITICAL every derived app has files the shared extension list can actually read. Adding errors-site without .mjs would have scanned zero of its files — a widening that reports success and checks nothing.', () => {
    const empty = publicAppDirs()
      .filter((d) => scannableFileCount(d) === 0)
      .map((d) => d.slice(REPO_ROOT.length + 1));
    expect(
      empty,
      'deployed app(s) contributing no scannable files — the extension roster is too narrow for them:',
    ).toEqual([]);
  });

  it('CRITICAL no public sweep hardcodes its own app list. An inline roster cannot follow the deploy script, and that divergence is precisely how errors-site went unchecked while both sweeps claimed to cover the public apps.', () => {
    const offenders: string[] = [];
    for (const sweep of PUBLIC_SWEEPS) {
      const src = sweepSource(sweep);
      if (!src.includes('publicAppDirs')) {
        offenders.push(`${sweep} — does not use the derived roster`);
      }
      // A sweep may name ONE app for a targeted extra case — v211 reads
      // gui-client's README on purpose. What it may not do is REBUILD the
      // roster inline, and naming several public apps at once is that rebuild.
      // Checked independently of the clause above: an earlier draft made this
      // conditional on the sweep NOT using the derived roster, which the first
      // check already covers, so the branch could never run. A predicate whose
      // sibling condition already excludes every case is untested no matter how
      // it reads.
      const namedApps = publicApps().filter((app) => new RegExp(`apps/${app}(?![\\w-])`).test(src));
      if (namedApps.length > 1) {
        offenders.push(`${sweep} — inline roster naming ${namedApps.join(', ')}`);
      }
    }
    expect(offenders.sort(), 'sweep(s) not driven by the derived roster:').toEqual([]);
  });

  it('CRITICAL each sweep still names the derived roster in its own scope text, so a reader is not told it covers five apps while covering six. A guard that misdescribes its reach is how the next person concludes a surface is checked.', () => {
    const lying = PUBLIC_SWEEPS.filter((s) =>
      /marketing-site \+ docs \+ customer-dashboard/.test(sweepSource(s)),
    );
    expect(lying, 'sweep(s) whose prose still enumerates the old five-app roster:').toEqual([]);
  });
});
