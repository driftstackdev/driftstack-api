// A walk helper that opens `if (!existsSync(dir)) return out;` swallows a missing
// root and returns an empty list. Every emptiness assertion downstream —
// `expect(offenders).toEqual([])` — treats empty as PASS. So the moment a source
// tree is renamed or deleted, every sweep pointed at it goes quiet and green
// together, which is precisely when they were supposed to speak up.
//
// This is not theoretical in this repo: `apps/customer-dashboard/src/pages` lost
// its whole operational surface in one commit, and `routes/saved-proxies.ts` was
// retired outright. Nothing has drifted today — a sweep of 3300 test-declared
// roots found zero missing directories — so this is debt, not a live defect.
//
// Rather than rewrite 89 helpers (the right fix is to THROW, not to add a floor,
// because throwing removes the failure mode instead of detecting it), this holds
// the line: the population may SHRINK freely as helpers are fixed, and may not
// grow. A ceiling, deliberately, not an equality — an equality would break the
// moment someone fixes one, which would punish exactly the change we want.
//
// ⚠️ The count is a DEBT MARKER, not a defect list. Some members are correct:
// a helper reading `dist/` SHOULD tolerate absence, because dist is gitignored
// and legitimately missing on a fresh checkout, and one member returns `true`
// with unrelated semantics. The judgement per site is source-tree (must throw)
// versus build-output (skip is right), so do not "fix" a member without making
// that call. Lowering the ceiling is what records the judgement having been made.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/** `if (!existsSync(x)) return ...` — the shape that turns a missing root into []. */
const SWALLOWS = /if\s*\(\s*!\s*existsSync\([^)]*\)\s*\)\s*return\b/;
/** Global twin of SWALLOWS — `match` needs /g to count every site in a file. */
const SWALLOWS_G = /if\s*\(\s*!\s*existsSync\([^)]*\)\s*\)\s*return\b/g;

// Measured 2026-08-27: 92 occurrences across 89 files. Ceiling, not a pin —
// shrinking is the goal.
//
// The unit is OCCURRENCES, not files, and that distinction is load-bearing: two
// files carry more than one swallow site (3 and 2). A file-count ceiling cannot
// see a file it already counts gaining another occurrence, so the population
// could grow with the number unchanged — a population expressed in one unit and
// enforced in another.
const CEILING = 92;

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist' || entry === 'coverage') continue;
    const full = resolve(dir, entry);
    // NOTE: no existsSync guard here, deliberately — this walker must throw if
    // its own root disappears rather than demonstrate the bug it is guarding.
    if (statSync(full).isDirectory()) testFiles(full, out);
    else if (/\.(test|spec)\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/**
 * This file is excluded from its own scan. Its matcher-control arm below carries
 * `if (!existsSync(dir)) return out;` as a literal fixture, and the header quotes
 * the shape — so without this, the guard counts itself and reports 90. A fixture
 * demonstrating the pattern is not an instance of the debt.
 */
const SELF = fileURLToPath(import.meta.url);

/**
 * Occurrences that are CODE, not prose. A file that DOCUMENTS the shape — quoting
 * `if (!existsSync(dir)) return out;` in a JSDoc block to explain why it asserts its
 * walk roots — carries no debt, and counting it turned this ceiling red on a commit
 * that added no swallow site at all (V-2000).
 *
 * The guard already made exactly this judgement once, for itself: SELF is excluded
 * because "a fixture demonstrating the pattern is not an instance of the debt". That
 * reasoning was never generalised, so it held for one file and no other. This is the
 * general form; SELF stays, because its fixture is a STRING literal, which no comment
 * filter removes.
 *
 * Filtering by the line each match STARTS on, rather than stripping comments from the
 * source: a block-comment stripper mishandles a regex literal containing a slash-star
 * and silently eats REAL sites — mine ate `docs-anchor-link-integrity`'s before I
 * tested it against a known member. Matching still runs over the whole file, so a site
 * wrapped across lines is counted exactly as before.
 */
function codeSites(src: string): number {
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineAt = (idx: number): string => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((lineStarts[mid] as number) <= idx) lo = mid;
      else hi = mid - 1;
    }
    const start = lineStarts[lo] as number;
    const end = src.indexOf('\n', start);
    return src.slice(start, end === -1 ? src.length : end);
  };
  let hits = 0;
  for (const m of src.matchAll(SWALLOWS_G)) {
    if (m.index === undefined) continue;
    // A statement's own line opens with the `if`; a prose mention opens with a
    // JSDoc continuation `*` or a `//`.
    if (/^\s*(\*|\/\/)/.test(lineAt(m.index))) continue;
    hits += 1;
  }
  return hits;
}

function scan(): { occurrences: number; files: string[]; filesScanned: number } {
  const files: string[] = [];
  let occurrences = 0;
  let filesScanned = 0;
  for (const base of ['apps', 'packages']) {
    for (const file of testFiles(resolve(REPO_ROOT, base))) {
      if (file === SELF) continue;
      filesScanned += 1;
      const src = readFileSync(file, 'utf8');
      if (src.includes('readdirSync')) {
        const hits = codeSites(src);
        if (hits > 0) {
          occurrences += hits;
          files.push(file.slice(REPO_ROOT.length + 1));
        }
      }
    }
  }
  return { occurrences, files, filesScanned };
}

describe('a walk helper that swallows a missing root does not spread', () => {
  it('CRITICAL the swallowing-walk population does not grow', () => {
    const { occurrences, files } = scan();
    expect(
      occurrences,
      `walk sites that return [] for a missing directory: ${occurrences} across ${files.length} files (ceiling ${CEILING}).\n` +
        `A new one makes another sweep pass silently when its source tree moves.\n` +
        `Fix by throwing on a missing root, not by adding a floor.`,
    ).toBeLessThanOrEqual(CEILING);
  });

  it('CRITICAL the scan enumerated the test corpus, so the ceiling is not vacuous', () => {
    // Without this, a broken walker scans zero files, finds zero swallowers, and
    // the ceiling above passes for the same reason the guards it polices do.
    const { filesScanned } = scan();
    // V-1992 — floor raised to just under the measured 3272. It stood at 2500
    // (mine, set the same day this guard landed), so the walk could have lost
    // 24% of the corpus and still called the ceiling non-vacuous.
    expect(filesScanned).toBeGreaterThan(2900);
  });

  it('the matcher fires on the swallowing shape and not on a throwing one', () => {
    expect(SWALLOWS.test('if (!existsSync(dir)) return out;')).toBe(true);
    expect(SWALLOWS.test('  if ( ! existsSync( PAGES ) ) return [];')).toBe(true);
    expect(SWALLOWS.test('if (!existsSync(dir)) throw new Error("missing root");')).toBe(false);
    expect(SWALLOWS.test('const files = readdirSync(dir);')).toBe(false);
  });
});
