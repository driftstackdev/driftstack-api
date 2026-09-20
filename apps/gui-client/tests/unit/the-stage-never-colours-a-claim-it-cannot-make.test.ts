// Colour is a claim. Final QA of the AI-view redesign found the stage making
// two it could not support, and reserving space for a third that was never
// filled.
//
//   1. ⛔ THE RE-PLAN SEAM WAS PAINTED IN THE "READY" GREEN. `.ai-replan` is the
//      row that says "Looked at the page and updated the plan", and the server
//      only re-plans AFTER A STEP FAILED — so the rail segment this rule paints
//      runs from a red node down to the retry. In `--status-ready` it told the
//      customer the thing that had just gone wrong had gone fine. The mockup
//      draws it grey (final/running-dark.png, the segment under "Searched the
//      store"); the app did not.
//
//   2. ⛔ THE ROOM WENT NEUTRAL AND THE PHONE'S GLASS DID NOT. `trouble` lights
//      no aura disc, deliberately — the stylesheet's own note says a red room
//      would read as the brand rather than as a fault, because oxblood and
//      `--status-error` are neighbours on the wheel. But the placeholder glass
//      inside the device kept an accent glow rising from its bottom edge, so in
//      the one state that must colour nothing, an oxblood wash was the loudest
//      thing on the stage. `preview` is unlit for the same reason and had the
//      same wash.
//
//   3. THE FACTS ROW RESERVED 22px IT HAD NOTHING TO PUT IN. `min-height` keeps
//      the caption from jumping when a fact arrives; in the two states that have
//      no fact at all (a stopped turn on a closed session, an ended session) it
//      was a band of nothing under the phone — the one place `trouble` looked
//      unfinished.
//
// ⛔ WHY THE STYLESHEET AND NOT A RENDER. jsdom loads no stylesheet, so
// `getComputedStyle` in a jsdom test returns the initial value for every one of
// these and an arm written there would be green whatever the CSS said. The
// colours were verified in a real browser during final QA (the replan seam read
// `rgba(52, 211, 153, 0.5)` before and `ink-muted` after); what this file holds
// is that nobody puts them back.
//
// The DOM half of item 3 — that the stage marks the row empty only when it
// really is — lives in `the-stage-only-says-what-is-still-true.test.tsx`, with
// the positive control beside it.
//
// NEGATIVE CONTROL: put `--status-ready-rgb` back in `.ai-replan::before`, or
// delete the `[data-ai-phase='trouble']` glass rule, and the matching arm reds.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_SOURCE = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');
/** Comments stripped: the stylesheet's own notes name `status-ready` and the
 *  accent while explaining why they are gone, and a scan that read them could
 *  never go green. */
const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block of one rule, by its exact selector. Throws when the
 *  selector is gone, so a rename fails loudly instead of passing as "this rule
 *  no longer says the forbidden thing". */
function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]*'()+:]/g, (c) => `\\${c}`);
  const m = new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS);
  if (m === null) throw new Error(`no CSS rule for ${selector}`);
  return m[2] ?? '';
}

describe('the re-plan seam is a change of course, not a success', () => {
  it('⛔ does not paint its rail segment in the ready green', () => {
    const seam = rule('.ai-replan::before');
    expect(
      seam,
      'the seam runs under a step that FAILED — the server only re-plans after one',
    ).not.toContain('--status-ready-rgb');
    expect(seam).not.toContain('--status-error-rgb');
  });

  it('…and paints it in the same neutral the diamond on it already wears', () => {
    // Not merely "not green": a seam with no colour at all would be invisible on
    // a rail, and one in the error red would claim the opposite lie.
    expect(rule('.ai-replan::before')).toContain('--ink-muted-rgb');
    expect(rule('.ai-replan-node')).toContain('--ink-muted-rgb');
  });

  it('POSITIVE CONTROL — the rail around it still has the colours that mean something', () => {
    // If this arm ever goes red the file above is measuring a stylesheet where
    // status colours have moved wholesale, and "the seam is not green" would be
    // true for a reason that has nothing to do with the seam.
    expect(CSS).toContain('--status-ready-rgb');
    expect(CSS).toContain('--status-error-rgb');
  });
});

describe('when the room is unlit, so is the glass', () => {
  const UNLIT = [
    "[data-ai-phase='trouble'] .ai-screen-dark",
    "[data-ai-phase='trouble'] .ai-screen-off",
    '[data-ai-preview] .ai-screen-dark',
    '[data-ai-preview] .ai-screen-off',
  ] as const;

  it('⛔ names both unlit phases and both placeholder classes', () => {
    // Two phases × two placeholders: `trouble` reaches `.ai-screen-dark`
    // (the live view could not start) and `preview` reaches `.ai-screen-off`
    // (the phone is a product shot). Missing either pair leaves the wash where
    // it was, in a state no current scene renders.
    for (const selector of UNLIT) {
      expect(CSS, `${selector} is not scoped out of the accent glow`).toContain(selector);
    }
  });

  it('⛔ and the rule it shares replaces the accent with neutral ink', () => {
    // The selectors above share one block; reading the last of them reads it.
    const unlit = rule(
      "[data-ai-phase='trouble'] .ai-screen-dark,\n[data-ai-phase='trouble'] .ai-screen-off,\n[data-ai-preview] .ai-screen-dark,\n[data-ai-preview] .ai-screen-off",
    );
    expect(unlit).toContain('--ink-muted-rgb');
    expect(unlit).not.toContain('--accent-rgb');
  });

  it('POSITIVE CONTROL — a LIT room keeps the accent glow the mockup draws', () => {
    // The fix is keyed on the PHASE, never on the placeholder's own class: idle,
    // thinking, acting and done all still show the warm glass the mockup draws,
    // and this arm is what stops the fix being applied to all of them.
    expect(rule('.ai-screen-off')).toContain('--accent-rgb');
    expect(rule('.ai-screen-dark')).toContain('--accent-rgb');
  });
});

describe('the facts row under the phone reserves nothing when it has nothing', () => {
  it('⛔ gives the 22px back when the stage marked the row empty', () => {
    expect(rule('.ai-facts')).toContain('min-height: 22px;');
    expect(rule('.ai-facts[data-empty]')).toContain('min-height: 0;');
  });

  it('…and collapses it rather than removing it from the layout', () => {
    // `display: none` would take the row out of the stage's flex column, so a
    // state that later fills it would have to re-create a box under the phone.
    expect(rule('.ai-facts[data-empty]')).not.toContain('display: none');
  });
});
