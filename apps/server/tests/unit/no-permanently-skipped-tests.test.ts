// No test is skipped unconditionally.
//
// A conditional skip is fine and this repo uses ~63 of them: `describe.skipIf`
// on a missing DATABASE_URL means "this needs Postgres", which is a real,
// re-evaluated condition. An UNCONDITIONAL `it.skip` is different — it never
// runs again, on any machine, ever, and the suite reports it as a skip rather
// than a failure, so nothing ever surfaces it.
//
// Eight of them were found here, in two customer-facing content-parity files,
// with no comment explaining any of them. Un-skipping showed what they were:
//
//   3 passed immediately — coverage that had been sitting idle
//   5 failed because the page copy had been rewritten into plain customer
//     language with the internal V-numbers stripped, and the pins were skipped
//     instead of updated
//
// Of the five, four properties were still true on the page and their pins were
// re-anchored on the claim rather than the sentence. One was genuinely obsolete:
// it pinned "Delivery counts coming soon" and the counts had since shipped, so
// un-skipping it would have re-pinned a claim the product had outgrown.
//
// That is the real cost of the pattern. A skipped test is not a paused test; it
// is a decision to stop checking something, recorded nowhere, and it decays
// silently into a claim about the product that is no longer true.
//
// The exemption list is empty and should stay that way. If a case genuinely
// cannot run, delete it and say why in the commit — a deleted test is visible in
// the diff, and a skipped one is invisible forever.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { REPO_ROOT } from './_helpers/public-apps';

/** Directories that hold test files, across every workspace package. */
const TEST_ROOTS = ['apps', 'packages'];

/**
 * Unconditional skips that are permitted, each with the reason it cannot run.
 *
 * Deliberately empty. An entry here is a standing decision to stop checking
 * something, so it should be rare enough to argue about in review.
 */
const ALLOWED_PERMANENT_SKIPS: ReadonlyMap<string, string> = new Map();

function testFiles(dir: string): string[] {
  const out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry === 'node_modules' || entry === 'dist' || entry === '.astro') continue;
    const full = resolve(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (entry.endsWith('.test.ts') || entry.endsWith('.spec.ts')) out.push(full);
  }
  return out;
}

function allTestFiles(): string[] {
  return TEST_ROOTS.flatMap((r) => testFiles(resolve(REPO_ROOT, r))).sort();
}

/** `it.skip(` / `describe.skip(` / `test.skip(` at the start of a line. */
const PERMANENT_SKIP = /^\s*(?:it|describe|test)\.skip\s*\(/;

interface Skip {
  readonly where: string;
  readonly line: number;
}

function permanentSkips(): Skip[] {
  const out: Skip[] = [];
  for (const file of allTestFiles()) {
    const rel = relative(REPO_ROOT, file);
    readFileSync(file, 'utf8')
      .split('\n')
      .forEach((line, i) => {
        if (PERMANENT_SKIP.test(line)) out.push({ where: rel, line: i + 1 });
      });
  }
  return out;
}

describe('no test is skipped unconditionally', () => {
  it('CRITICAL the scan reaches real test files across every workspace. This case asserts an absence, so a scan that reached nothing would report the repo clean — and an earlier version of this very sweep was scoped to apps/server/tests and missed all eight offenders, which lived in two other apps.', () => {
    const files = allTestFiles();
    expect(files.length, 'test files found').toBeGreaterThan(1500);
    for (const app of ['apps/server', 'apps/customer-dashboard', 'apps/marketing-site']) {
      expect(
        files.some((f) => relative(REPO_ROOT, f).startsWith(app)),
        `${app} must be in scope — the offenders were outside apps/server`,
      ).toBe(true);
    }
  });

  it('CRITICAL the skip pattern still matches a real skip, so "none found" means none rather than a regex that stopped working.', () => {
    const sample = ["  it.skip('x', () => {});", "describe.skip('y', () => {});", '  test.skip(('];
    for (const line of sample) {
      expect(PERMANENT_SKIP.test(line), `must match: ${line}`).toBe(true);
    }
    // A conditional skip is legitimate and must NOT be caught.
    for (const line of ['  describe.skipIf(!process.env.CI)(', '  it.skipIf(x)(']) {
      expect(PERMANENT_SKIP.test(line), `must not match: ${line}`).toBe(false);
    }
  });

  it('CRITICAL no test is permanently skipped. A skipped test is not a paused test — it is a decision to stop checking something, recorded nowhere, that decays into a claim about the product nobody is verifying. Delete it and say why in the commit instead; a deleted test is visible in the diff.', () => {
    const offenders = permanentSkips()
      .filter((s) => !ALLOWED_PERMANENT_SKIPS.has(s.where))
      .map((s) => `${s.where}:${s.line}`)
      .sort();
    expect(
      offenders,
      'unconditionally skipped test(s) — fix, delete, or make the skip conditional on a real re-evaluated condition:',
    ).toEqual([]);
  });

  it('CRITICAL the exemption list may only shrink. An entry for a file that no longer skips anything stops meaning "agreed" and starts meaning "nobody looked".', () => {
    const skipping = new Set(permanentSkips().map((s) => s.where));
    const stale = [...ALLOWED_PERMANENT_SKIPS.keys()].filter((f) => !skipping.has(f)).sort();
    expect(stale, 'exemption(s) for files that no longer skip anything:').toEqual([]);
  });
});
