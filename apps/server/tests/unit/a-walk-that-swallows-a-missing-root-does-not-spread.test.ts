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

// Measured 2026-08-27. Ceiling, not a pin: shrinking is the goal.
const CEILING = 89;

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

function scan(): { swallowers: string[]; filesScanned: number } {
  const swallowers: string[] = [];
  let filesScanned = 0;
  for (const base of ['apps', 'packages']) {
    for (const file of testFiles(resolve(REPO_ROOT, base))) {
      if (file === SELF) continue;
      filesScanned += 1;
      const src = readFileSync(file, 'utf8');
      if (SWALLOWS.test(src) && src.includes('readdirSync')) {
        swallowers.push(file.slice(REPO_ROOT.length + 1));
      }
    }
  }
  return { swallowers, filesScanned };
}

describe('a walk helper that swallows a missing root does not spread', () => {
  it('CRITICAL the swallowing-walk population does not grow', () => {
    const { swallowers } = scan();
    expect(
      swallowers.length,
      `walk helpers that return [] for a missing directory: ${swallowers.length} (ceiling ${CEILING}).\n` +
        `A new one makes another sweep pass silently when its source tree moves.\n` +
        `Fix by throwing on a missing root, not by adding a floor.`,
    ).toBeLessThanOrEqual(CEILING);
  });

  it('CRITICAL the scan enumerated the test corpus, so the ceiling is not vacuous', () => {
    // Without this, a broken walker scans zero files, finds zero swallowers, and
    // the ceiling above passes for the same reason the guards it polices do.
    const { filesScanned } = scan();
    expect(filesScanned).toBeGreaterThan(2500);
  });

  it('the matcher fires on the swallowing shape and not on a throwing one', () => {
    expect(SWALLOWS.test('if (!existsSync(dir)) return out;')).toBe(true);
    expect(SWALLOWS.test('  if ( ! existsSync( PAGES ) ) return [];')).toBe(true);
    expect(SWALLOWS.test('if (!existsSync(dir)) throw new Error("missing root");')).toBe(false);
    expect(SWALLOWS.test('const files = readdirSync(dir);')).toBe(false);
  });
});
