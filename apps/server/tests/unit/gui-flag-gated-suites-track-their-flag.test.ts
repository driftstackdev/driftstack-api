// A suite skipped because a feature is hidden must un-skip when it stops being
// hidden.
//
// `profiles-lifecycle-actions.test.tsx` skips its Clone and Import blocks, and
// both skips are correct today — each names the flag that hides the affordance:
//
//   • Clone   — CLONE_ENABLED = false        ("clone is currently useless")
//   • Import  — IMPORT_EXPORT_ENABLED = false ("profile-cheat abuse vector")
//
// Both comments end with "re-enable these when the flag flips", which is the
// whole problem: nothing enforces it. Flipping a flag ships the affordance and
// leaves six tests dormant, and the suite still reports green — a skipped test
// and a passing test are indistinguishable in the summary line. The Import
// block is the one that matters most, because the reason it was hidden was an
// abuse vector rather than a half-built feature.
//
// So this does not report a problem. It ties the skip to its stated
// justification, so flipping a flag fails here with instructions rather than
// silently shipping an untested affordance.
//
// Reading gui-client source from the server suite follows the existing
// convention (see gui-client-index-html-and-test-setup-content-parity).

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..', '..', '..');
const VIEW = resolve(REPO_ROOT, 'apps/gui-client/src/views/ProfilesView.tsx');
const SUITE = resolve(REPO_ROOT, 'apps/gui-client/tests/unit/profiles-lifecycle-actions.test.tsx');

/** Each gated affordance: the flag that hides it and the suite that covers it. */
const GATED = [
  { feature: 'Clone', flag: 'CLONE_ENABLED', block: 'Clone' },
  { feature: 'Import', flag: 'IMPORT_EXPORT_ENABLED', block: 'Import' },
] as const;

const viewSource = existsSync(VIEW) ? readFileSync(VIEW, 'utf8') : '';
const suiteSource = existsSync(SUITE) ? readFileSync(SUITE, 'utf8') : '';

/**
 * The literal a flag is declared with, or null when it is not a plain literal.
 *
 * Deliberately narrow: the point is to notice a flip, and a flag that stops
 * being a literal (`const X = someCondition`) is a change this guard cannot
 * reason about — it reports null so the arms below fail loudly rather than
 * quietly reading `false` off something dynamic.
 */
function flagLiteral(source: string, flag: string): boolean | null {
  const m = source.match(new RegExp(`const ${flag}\\s*=\\s*(true|false)\\s*;`));
  if (m?.[1] === 'true') return true;
  if (m?.[1] === 'false') return false;
  return null;
}

/** Whether a describe block is skipped. */
function blockIsSkipped(source: string, block: string): boolean | null {
  if (new RegExp(`describe\\.skip\\(\\s*'${block}'`).test(source)) return true;
  if (new RegExp(`describe\\(\\s*'${block}'`).test(source)) return false;
  return null;
}

describe('a suite skipped for a hidden affordance tracks the flag that hides it', () => {
  it('CRITICAL both source files were found and both flags and blocks parsed. Every assertion below is a correspondence between two files, so a moved file or a renamed flag would satisfy them having compared nothing.', () => {
    expect(existsSync(VIEW), 'ProfilesView.tsx at the canonical path').toBe(true);
    expect(existsSync(SUITE), 'profiles-lifecycle-actions.test.tsx at the canonical path').toBe(
      true,
    );
    for (const { feature, flag, block } of GATED) {
      expect(
        flagLiteral(viewSource, flag),
        `${feature}: ${flag} declared as a literal`,
      ).not.toBeNull();
      expect(
        blockIsSkipped(suiteSource, block),
        `${feature}: describe('${block}') located`,
      ).not.toBeNull();
    }

    // The detector must actually distinguish the two states it exists to tell
    // apart — otherwise the correspondence below is satisfied by a matcher that
    // always answers the same way.
    expect(flagLiteral('const X_ENABLED = true;', 'X_ENABLED'), 'reads an enabled flag').toBe(true);
    expect(flagLiteral('const X_ENABLED = false;', 'X_ENABLED'), 'reads a disabled flag').toBe(
      false,
    );
    expect(blockIsSkipped("describe.skip('Clone', () => {", 'Clone'), 'reads a skipped block').toBe(
      true,
    );
    expect(blockIsSkipped("describe('Clone', () => {", 'Clone'), 'reads a live block').toBe(false);
  });

  it('CRITICAL no affordance is enabled while the suite covering it is still skipped. Flipping the flag ships the feature; the tests stay dormant and the summary line reads exactly the same as if they had run.', () => {
    const shipped = GATED.filter(
      ({ flag, block }) =>
        flagLiteral(viewSource, flag) === true && blockIsSkipped(suiteSource, block) === true,
    ).map(
      ({ feature, flag, block }) =>
        `${feature}: ${flag} is now true but describe.skip('${block}') is still skipped — remove the .skip`,
    );
    expect(shipped, 'enabled affordance(s) whose coverage is still skipped:').toEqual([]);
  });

  it('CRITICAL no suite is running against an affordance that is still hidden. The reverse direction, so the pair cannot be satisfied by un-skipping alone — those tests would be driving UI the view never renders.', () => {
    const orphaned = GATED.filter(
      ({ flag, block }) =>
        flagLiteral(viewSource, flag) === false && blockIsSkipped(suiteSource, block) === false,
    ).map(
      ({ feature, flag, block }) =>
        `${feature}: describe('${block}') is live but ${flag} is still false — flip the flag or restore the .skip`,
    );
    expect(orphaned, 'un-skipped suite(s) for a hidden affordance:').toEqual([]);
  });
});
