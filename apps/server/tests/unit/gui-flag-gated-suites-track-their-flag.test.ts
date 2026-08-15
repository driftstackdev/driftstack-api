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
// SUPERSEDED MECHANISM, 2026-08-16. The original form was `describe.skip` plus
// this guard reporting "remove the .skip" when a flag flipped — correct, but it
// still needed a human to act on the instruction. The suite now reads the flags
// out of the view and uses `describe.skipIf(!FLAG)`, so flipping a flag runs the
// tests on the next pass with nobody in the loop. That is the repo's stated
// preference: a conditional skip re-evaluates, an unconditional one never comes
// back.
//
// This guard keeps its job and gets a stricter one. Rather than checking that
// skip-state and flag-state agree — a correspondence that can only be checked
// after someone edits both — it now requires the binding itself, so the two
// cannot disagree at all. The bidirectional arms are gone because the state they
// compared can no longer exist.
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

/**
 * The flag a describe block binds its skip to, or null when it is not bound.
 *
 * `describe.skipIf(!CLONE_ENABLED)('Clone', …)` returns 'CLONE_ENABLED'. A bare
 * `describe.skip` or a live `describe` returns null, which the arms below treat
 * as a failure — those are precisely the two states this file exists to prevent.
 */
function blockBoundFlag(source: string, block: string): string | null {
  const m = new RegExp(`describe\\.skipIf\\(!([A-Z_]+)\\)\\(\\s*'${block}'`).exec(source);
  return m?.[1] ?? null;
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
        blockBoundFlag(suiteSource, block),
        `${feature}: describe('${block}') located and bound to a flag`,
      ).not.toBeNull();
    }

    // The detector must actually distinguish the two states it exists to tell
    // apart — otherwise the correspondence below is satisfied by a matcher that
    // always answers the same way.
    expect(flagLiteral('const X_ENABLED = true;', 'X_ENABLED'), 'reads an enabled flag').toBe(true);
    expect(flagLiteral('const X_ENABLED = false;', 'X_ENABLED'), 'reads a disabled flag').toBe(
      false,
    );
    expect(
      blockBoundFlag("describe.skipIf(!X_ENABLED)('Clone', () => {", 'Clone'),
      'reads the bound flag',
    ).toBe('X_ENABLED');
    expect(
      blockBoundFlag("describe.skip('Clone', () => {", 'Clone'),
      'an unconditional skip is NOT bound',
    ).toBeNull();
    expect(
      blockBoundFlag("describe('Clone', () => {", 'Clone'),
      'a live block is NOT bound',
    ).toBeNull();
  });

  it('CRITICAL every gated suite binds its skip to the flag that hides it. The previous form was `describe.skip` plus a comment asking whoever flips the flag to re-enable the block, and this guard reporting it afterwards — both of which still needed a human to act. Binding the skip to the flag removes the step: flip it and the tests run on the next pass.', () => {
    const unbound = GATED.filter(
      ({ flag, block }) => blockBoundFlag(suiteSource, block) !== flag,
    ).map(
      ({ feature, flag, block }) =>
        `${feature}: describe('${block}') must be describe.skipIf(!${flag})(…), found ` +
        `${String(blockBoundFlag(suiteSource, block))}`,
    );
    expect(unbound, 'gated suite(s) whose skip is not bound to its flag:').toEqual([]);
  });

  it('CRITICAL the suite reads the flags from the view rather than restating them. A local copy of `false` would satisfy the binding above and never change when the view does — the failure mode the binding is meant to close.', () => {
    expect(suiteSource, 'the suite reads ProfilesView.tsx').toMatch(
      /ProfilesView\.tsx|'ProfilesView'/,
    );
    expect(suiteSource, 'and derives each flag from it').toMatch(/viewFlag\(/);
    for (const { flag } of GATED) {
      expect(suiteSource, `${flag} is derived, not hard-coded`).not.toMatch(
        new RegExp(`const ${flag} = (true|false);`),
      );
    }
  });
});
