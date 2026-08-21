// V-1260 — the guard for the class fixed by hand six times: V-1238, V-1240, V-1241, V-1244 through
// V-1247, and V-1259.
//
// Every instance had the same shape. A policy value — a page size, a throttle window, a storage
// scale, a lock-staleness threshold — written once in the Drizzle repo and again in the in-memory
// double. The two agreed, so nothing was wrong on the day it was written, and nothing would have
// reported the day they stopped agreeing: production would serve the new value while every test
// standing on the double went on asserting the old one, agreeing with itself.
//
// The fix each time was the same too: name it, export it from the repo, import it in the double.
// After which the literal appears in the repo and NOT in the double, which is exactly what this
// guard checks.
//
// WHAT IT DOES NOT MODEL, stated because the gap is real. It only sees NUMBERS. V-1238 was a set of
// STRINGS — `['active', 'trialing']` in the repo, restated as `s.status === 'active' || s.status ===
// 'trialing'` in the double — and this guard would have walked straight past it. String literals
// are shared between a repo and its double constantly and legitimately ('id', 'active', column
// names), so a string rule would be noise rather than signal. Five of the six historical instances
// are covered; the sixth is named here so nobody reads a green run as more than it is.

import { readFileSync, existsSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HELPERS = resolve(import.meta.dirname, '../integration/_helpers');
const REPOS = resolve(import.meta.dirname, '../../src/db');

/**
 * Numbers a double may share with its repo, each with the reason. The list may only shrink.
 *
 * A value earns a place here by being a UNIT, not a policy: two sides computing the number of
 * milliseconds in a day cannot drift, because the day cannot. Anything that encodes a decision —
 * how many rows a page holds, how long a lock may go stale — does not belong here.
 */
const SHARED_UNITS = new Map<string, string>([
  ['stripe-webhooks-repo.ts::1000', 'milliseconds per second, inside a day-length computation'],
  ['validation-schedules-repo.ts::1000', 'milliseconds per second, converting a cadence'],
  ['webhooks-repo.ts::1000', 'milliseconds per second, inside MS_PER_DAY'],
]);

/** Three digits or more, or grouped with underscores — the shape a policy value is written in. */
const POLICY_NUMBER = /\b\d+_[\d_]+\b|\b\d{3,}\b/g;

function numbersIn(path: string): Set<string> {
  return new Set(codeOnly(readFileSync(path, 'utf8')).match(POLICY_NUMBER) ?? []);
}

interface Pair {
  base: string;
  repo: string;
  double: string;
}

/** Doubles that have a Drizzle counterpart of the same name. */
function pairs(): Pair[] {
  return readdirSync(HELPERS)
    .filter((f) => f.startsWith('in-memory-') && f.endsWith('-repo.ts'))
    .map((f) => ({
      base: f.slice('in-memory-'.length),
      double: resolve(HELPERS, f),
      repo: resolve(REPOS, f.slice('in-memory-'.length)),
    }))
    .filter((p) => existsSync(p.repo));
}

/**
 * The comparison, over SOURCE rather than paths, so the arms below can drive it with synthetic
 * inputs. The first version of this file compared two sets built inside the test and never called
 * the real function at all — an arm that could not fail whatever the code did, which is the exact
 * defect this campaign keeps finding by mutation.
 */
function restatedBetween(doubleSrc: string, repoSrc: string, base: string): string[] {
  const inRepo = new Set(codeOnly(repoSrc).match(POLICY_NUMBER) ?? []);
  return [...new Set(codeOnly(doubleSrc).match(POLICY_NUMBER) ?? [])]
    .filter((n) => inRepo.has(n))
    .filter((n) => !SHARED_UNITS.has(`${base}::${n}`))
    .sort();
}

function restated(p: Pair): string[] {
  return restatedBetween(readFileSync(p.double, 'utf8'), readFileSync(p.repo, 'utf8'), p.base);
}

describe('no in-memory double restates a number its repo owns', () => {
  it('CRITICAL the scan pairs doubles with their repos and still recognises a restated number. A guard reporting zero because it paired nothing reads exactly like one reporting zero because the class is gone.', () => {
    const found = pairs();
    expect(found.length, 'no double/repo pairs were resolved').toBeGreaterThan(15);

    // Every pair this campaign fixed must still resolve, or the guard silently stops
    // watching the very files that taught it what to look for.
    for (const base of ['auth-repo.ts', 'incidents-repo.ts', 'admin-accounts-repo.ts']) {
      expect(
        found.some((p) => p.base === base),
        `${base} no longer pairs — the guard stopped watching a file it was written for`,
      ).toBe(true);
    }
  });

  it('CRITICAL the comparison flags a number both files carry, and does NOT flag one only the repo carries. The second half is what makes the fix distinguishable from the defect: after centralising, the repo still holds the literal and the double holds an import, and a guard that could not tell those apart would fire on every pair this campaign repaired.', () => {
    const repoSrc = 'export const THROTTLE_MS = 30_000;\nconst other = 1;';

    // Before the fix: the double carries its own copy.
    expect(
      restatedBetween('const THROTTLE_MS = 30_000;', repoSrc, 'x-repo.ts'),
      'a number carried by BOTH files was not flagged',
    ).toEqual(['30_000']);

    // After the fix: the double imports it and no longer spells it out.
    expect(
      restatedBetween(
        "import { THROTTLE_MS } from '../../../src/db/x-repo.js';",
        repoSrc,
        'x-repo.ts',
      ),
      'a number the repo alone carries was treated as a restatement',
    ).toEqual([]);
  });

  it('CRITICAL comments are stripped before comparing, so a number quoted in prose is not a restatement. Every repaired double now explains the value it used to carry, and several name it — a raw scan would report all of them and re-flag the very fixes it is guarding.', () => {
    const prose = ['// it used to be its own `30_000`, the same window twice over', 'const x = 1;'];
    expect(
      (codeOnly(prose.join('\n')).match(POLICY_NUMBER) ?? []).filter((n) => n === '30_000'),
      'a number mentioned in a comment was counted as code',
    ).toEqual([]);
  });

  it('CRITICAL no double restates a policy number its repo also carries. Name it, export it from the repo, and import it — after which the value has one home and moving it moves both sides at once.', () => {
    const flagged = pairs().flatMap((p) => restated(p).map((n) => `${p.base}  restates ${n}`));
    expect(
      flagged,
      'restated policy number — export it from the repo and import it in the double, or add it ' +
        'to SHARED_UNITS with the reason it is a unit rather than a decision',
    ).toEqual([]);
  });

  it('CRITICAL every SHARED_UNITS entry still names a number both files carry. An exemption for a value that has since been centralised, renamed or deleted is a licence nobody is using, and it hides the next one that needs looking at.', () => {
    const live = new Set(
      pairs().flatMap((p) => {
        const inRepo = numbersIn(p.repo);
        return [...numbersIn(p.double)].filter((n) => inRepo.has(n)).map((n) => `${p.base}::${n}`);
      }),
    );
    const stale = [...SHARED_UNITS.keys()].filter((k) => !live.has(k)).sort();
    expect(stale, 'stale unit exemption(s) — remove them').toEqual([]);
  });
});
