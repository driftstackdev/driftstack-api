// A guard's own regex must not be able to hang the suite.
//
// V-1630 removed 20,733 occurrences of `\s*\n?\s*` from 799 guards. `\n` is
// itself `\s`, so that construct is EXACTLY `\s*` — written in a form that lets
// any whitespace run be divided across three parts in many ways. A match that
// SUCCEEDS finds a division immediately; a match that FAILS must try every one,
// and the cost is exponential in the number of chained groups. Measured, with
// literals that match deeply and failure at the end:
//
//     groups      \s*\n?\s*        \s*
//       4            0.4ms       0.0ms
//       8         2630.4ms       0.1ms
//      10       221154.4ms       0.3ms
//
// One guard chaining fifteen of them held a worker at 100% CPU for 27 minutes
// while the other 3,200 files finished. RSS stayed flat to the byte throughout,
// because a backtracking regex allocates nothing — which is why every
// memory-based signal was blind to it.
//
// ⛔ The failure direction is the reason this file exists. The construct is
// harmless while the pinned text still matches, and fatal the moment it stops —
// which is precisely when a parity guard is supposed to speak. The one that
// surfaced this had been pinning a BUG: it asserted a response shape that never
// existed on the wire, passed for exactly as long as the defect was present, and
// when the source was corrected it hung instead of reporting the drift. Silent
// while wrong, fatal when right.
//
// The sweep fixed 20,733 sites and nothing stopped the 20,734th. This does.
//
// SCOPE — every `*.test.ts`/`*.test.tsx` under `apps/` and `packages/`, which is
// where parity guards live. Source files are out of scope on purpose: a
// deliberate ReDoS example belongs in `services/task-refusal.ts`, whose comment
// documents `(a+)+` and friends as the shapes its own detector refuses.

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { codeOnly } from './_helpers/code-only.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..', '..');

const WS = String.raw`\s*`;

const ANY = '[' + String.raw`\s` + String.raw`\S` + ']';

/**
 * Redundant whitespace constructs: in each, two adjacent quantified atoms range
 * over overlapping characters, so one run of whitespace can be divided between
 * them many ways. A match that succeeds takes the first division; a match that
 * FAILS tries every one.
 *
 * Six spellings, because the first sweep removed a TOKEN when the defect is a
 * SHAPE — taking `\s*` + `\n?` + `\s*` out of 799 files left the doubled form
 * standing in a seventh, and this guard found it on its first run. Measured, with
 * literals matching deeply and failure at the end, at ten chained groups:
 *
 *     \s* \n? \s*      484,949ms
 *     \s* [\s\S]*?      81,471ms
 *     \s*                    0.3ms
 *
 * Assembled from fragments rather than written out, so this file does not contain
 * the constructs it forbids and flag itself. A name-keyed self-exemption would
 * also have worked and would have been worse — it keeps passing the day someone
 * adds a real occurrence to this very file.
 */
const AMBIGUOUS: readonly { readonly pattern: string; readonly equivalent: string }[] = [
  { pattern: WS + String.raw`\n?` + WS, equivalent: WS },
  { pattern: WS + WS, equivalent: WS },
  { pattern: '(' + String.raw`\s` + '|' + String.raw`\n` + ')*', equivalent: WS },
  { pattern: WS + String.raw`\s+`, equivalent: String.raw`\s+` },
  { pattern: WS + ANY + '*?', equivalent: ANY + '*?' },
  { pattern: WS + ANY + '+?', equivalent: ANY + '+?' },
];

function testFiles(): string[] {
  return execFileSync(
    'git',
    ['ls-files', 'apps/**/*.test.ts', 'apps/**/*.test.tsx', 'packages/**/*.test.ts'],
    {
      cwd: REPO,
      encoding: 'utf-8',
    },
  )
    .split('\n')
    .filter((f) => f.length > 0);
}

describe('a parity regex may not be ambiguous about whitespace', () => {
  const files = testFiles();

  it('CRITICAL the scan reaches the guards, so a clean result is a real one rather than an empty one', () => {
    expect(files.length, 'test files enumerated from git').toBeGreaterThan(2000);
    const sampled = files.filter((f) =>
      codeOnly(readFileSync(resolve(REPO, f), 'utf-8')).includes('toMatch('),
    );
    expect(sampled.length, 'files that actually assert with a regex').toBeGreaterThan(500);
  });

  it('CRITICAL the detector detects — it flags the construct in a fixture, so "none found" means none rather than a matcher that stopped working', () => {
    const fixture = 'expect(body).toMatch(/a' + WS + String.raw`\n?` + WS + 'b/);';
    const found = AMBIGUOUS.filter((a) => fixture.includes(a.pattern));
    expect(
      found.map((a) => a.pattern),
      'the fixture is recognised',
    ).toEqual([WS + String.raw`\n?` + WS]);
  });

  it('CRITICAL no test file contains a redundant ambiguous-whitespace construct. Each accepts exactly what `\\s*` accepts, so removing it cannot broaden a guard — and leaving it in place makes the guard a suite-killer on the day its pinned text legitimately changes.', () => {
    const offenders: string[] = [];
    for (const f of files) {
      const src = codeOnly(readFileSync(resolve(REPO, f), 'utf-8'));
      for (const { pattern, equivalent } of AMBIGUOUS) {
        const n = src.split(pattern).length - 1;
        if (n > 0) offenders.push(`${f}: ${String(n)}x ${pattern} — write ${equivalent}`);
      }
    }
    expect(
      offenders.sort(),
      'these guards carry a redundant ambiguous-whitespace construct; it is identical to `\\s*` and hangs the suite when the match fails:',
    ).toEqual([]);
  });
});
