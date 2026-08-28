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
// Rather than rewrite ~90 helpers (the right fix is to THROW, not to add a floor,
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
//
// V-2128 — the SAME swallow has a second home that the first version of this
// guard could not see: a single-subject test whose `it()` body opens with
// `if (!existsSync(subject)) return;`. No walker, no `readdirSync`, but the
// identical failure mode — the day the subject file is retired the test passes
// silently instead of saying so. Those are held to ZERO below, not to a ceiling:
// there is no build-output case for a test whose one subject is a tracked source
// file. The one legitimate reason to not run — a toolchain absent locally that
// CI does have — is written `ctx.skip('…')`, which REPORTS the skip; a bare
// `return` there reads as a pass, and a local green then says "verified in every
// SDK" about arms that never ran.

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');

/**
 * The shape family, not the token: an `if` whose condition (group 1, kept to one
 * line — prettier prints every member that way) tests `!existsSync(…)` anywhere
 * in it, and whose consequent is a bare `return` — inline, or first in a block.
 * The first version matched only `if (!existsSync(x)) return`, which missed an
 * `||`-joined pair of subjects outright and could not tell a walker's swallow
 * from a single-subject one.
 */
const SWALLOWS =
  /if\s*\(([^\n]*?!\s*existsSync\([^\n]*?)\)\s*(?:return\b|continue\b|\{\s*(?:return|continue)\b)/;
/** Global twin of SWALLOWS — `matchAll` needs /g to count every site in a file. */
const SWALLOWS_G = new RegExp(SWALLOWS.source, 'g');

// Measured 2026-08-28 (V-2134): 87 walker occurrences across 85 files, scanning
// apps, packages AND scripts, with the family widened to the `continue` form.
// Earlier the same day: 94 / 90 before apps/server's 17 source-tree sites were
// converted to throws (V-2134), and 92 / 89 before the scan reached `scripts/`
// (V-2128 — a guard scoped narrower than the suite it polices leaves a place
// for the population to grow unseen). Of the 87, 7 are `continue` sites in
// root-list loops, most of them legitimately optional (a workspace's `tests/`
// dir). Ceiling, not a pin — shrinking is the goal.
//
// The unit is OCCURRENCES, not files, and that distinction is load-bearing: two
// files carry more than one swallow site (3 and 2). A file-count ceiling cannot
// see a file it already counts gaining another occurrence, so the population
// could grow with the number unchanged — a population expressed in one unit and
// enforced in another.
const CEILING = 87;

/** The suite's own roots — vitest.node.config.ts `include` names all three. */
const ROOTS = ['apps', 'packages', 'scripts'] as const;

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
 * the shape — so without this, the guard counts itself. A fixture demonstrating
 * the pattern is not an instance of the debt.
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
function codeSites(src: string): number[] {
  const lineStarts: number[] = [0];
  for (let i = 0; i < src.length; i += 1) if (src[i] === '\n') lineStarts.push(i + 1);
  const lineIndexAt = (idx: number): number => {
    let lo = 0;
    let hi = lineStarts.length - 1;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if ((lineStarts[mid] as number) <= idx) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineText = (li: number): string => {
    const start = lineStarts[li] as number;
    const end = src.indexOf('\n', start);
    return src.slice(start, end === -1 ? src.length : end);
  };
  const lines: number[] = [];
  for (const m of src.matchAll(SWALLOWS_G)) {
    if (m.index === undefined) continue;
    const li = lineIndexAt(m.index);
    // A statement's own line opens with the `if`; a prose mention opens with a
    // JSDoc continuation `*` or a `//`.
    if (/^\s*(\*|\/\/)/.test(lineText(li))) continue;
    lines.push(li + 1);
  }
  return lines;
}

interface Scan {
  /** Sites in files that walk a tree (`readdirSync`) — the ceilinged debt. */
  walkerOccurrences: number;
  walkerFiles: string[];
  /** Sites in files that read ONE subject — held to zero. `file:line`. */
  singleSubject: string[];
  filesScanned: number;
}

function scan(): Scan {
  const out: Scan = {
    walkerOccurrences: 0,
    walkerFiles: [],
    singleSubject: [],
    filesScanned: 0,
  };
  for (const base of ROOTS) {
    for (const file of testFiles(resolve(REPO_ROOT, base))) {
      if (file === SELF) continue;
      out.filesScanned += 1;
      const src = readFileSync(file, 'utf8');
      const sites = codeSites(src);
      if (sites.length === 0) continue;
      const rel = file.slice(REPO_ROOT.length + 1);
      if (src.includes('readdirSync')) {
        out.walkerOccurrences += sites.length;
        out.walkerFiles.push(rel);
        continue;
      }
      for (const line of sites) out.singleSubject.push(`${rel}:${line.toString()}`);
    }
  }
  return out;
}

describe('a walk helper that swallows a missing root does not spread', () => {
  it('CRITICAL the swallowing-walk population does not grow', () => {
    const { walkerOccurrences, walkerFiles } = scan();
    expect(
      walkerOccurrences,
      `walk sites that return [] for a missing directory: ${walkerOccurrences} across ${walkerFiles.length} files (ceiling ${CEILING}).\n` +
        `A new one makes another sweep pass silently when its source tree moves.\n` +
        `Fix by throwing on a missing root, not by adding a floor.`,
    ).toBeLessThanOrEqual(CEILING);
  });

  it('CRITICAL no single-subject test returns silently when its subject file is missing', () => {
    // V-2128 — four of these existed, invisible to the ceiling above because the
    // scan looked only at files that walk. One pointed at
    // apps/customer-dashboard/src/pages, the tree the header cites as having
    // been gutted once already. Every subject they read is a git-tracked source
    // file, so absence is a broken test or a retired subject — either way the
    // test must say so, not pass.
    const { singleSubject } = scan();
    expect(
      singleSubject,
      `single-subject tests that return instead of failing when the subject is missing:\n  ${singleSubject.join('\n  ')}\n` +
        `Throw (or expect(existsSync(…)).toBe(true)) so a retired subject fails the test instead of skipping it;\n` +
        `a toolchain that is legitimately absent locally is ctx.skip('why'), which the reporter shows.`,
    ).toEqual([]);
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

  it('the matcher fires on every member of the swallowing shape and not on a throwing one', () => {
    expect(SWALLOWS.test('if (!existsSync(dir)) return out;')).toBe(true);
    expect(SWALLOWS.test('  if ( ! existsSync( PAGES ) ) return [];')).toBe(true);
    // The two shapes the token-matcher missed (V-2128): a joined condition, and a
    // block whose first statement is the return.
    expect(SWALLOWS.test('if (!existsSync(a) || !existsSync(b)) return;')).toBe(true);
    expect(SWALLOWS.test('if (!existsSync(dir)) {\n    return out;\n  }')).toBe(true);
    // V-2134 — the loop form: a missing entry in a list of roots is skipped, and
    // the sweep over the remaining roots reads as complete.
    expect(SWALLOWS.test('if (!existsSync(base)) continue;')).toBe(true);
    expect(SWALLOWS.test('if (!existsSync(d)) {\n      continue;\n    }')).toBe(true);
    expect(SWALLOWS.test('if (!existsSync(dir)) throw new Error("missing root");')).toBe(false);
    expect(SWALLOWS.test('if (existsSync(dir)) return out;')).toBe(false);
    expect(SWALLOWS.test('const files = readdirSync(dir);')).toBe(false);
    // A joined toolchain gate is still a member when it returns …
    expect(SWALLOWS.test('if (!process.env.CI && !existsSync(PYTHON)) return;')).toBe(true);
    // … and stops being one when it reports the skip instead.
    expect(SWALLOWS.test("if (!process.env.CI && !existsSync(PYTHON)) ctx.skip('no venv');")).toBe(
      false,
    );
  });
});
