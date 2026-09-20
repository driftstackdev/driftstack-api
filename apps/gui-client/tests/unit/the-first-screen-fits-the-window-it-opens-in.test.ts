// The idle hero has to FIT. Final QA of the AI-view redesign found that it did
// not, at the two window sizes customers actually run.
//
// ⛔ WHAT WAS WRONG, MEASURED ON THE REAL VIEW IN A BROWSER. The first screen —
// headline, one sentence, three beats, four starter templates — was 14px taller
// than its column at a 960x600 window and 22px taller at 1280x800. The log
// opens at scrollTop 0 there (it is not a transcript; there is nothing to
// follow), macOS hides its overlay scrollbar until you scroll, and the fold
// landed 4–6px inside the BOTTOM ROW OF CARDS. Not "there is more below": two
// cards with no bottom edge, touching the composer. The same screen with a gate
// card above it (no API key) was 156px over at 960x600 and sliced its FIRST
// row through the title.
//
// And a band nothing had ever rendered: `short` ends at a view 620px tall and
// `tall` does not begin until 700, so a window dragged into the ~80px between
// them lost every saving the short tier makes while gaining ~60px of room. The
// hero went back over by 41px at 1120x700 and 81px at 1124x660.
//
// ⛔ WHY THIS FILE READS THE STYLESHEET INSTEAD OF MEASURING. jsdom has no
// layout engine: every `getBoundingClientRect()` in it is 0x0, so the fit
// itself cannot be asserted here and a test that tried would be green whatever
// the CSS said. What CAN be held is the BUDGET — the specific declarations the
// measurement bought the space with, and the tier rules that decide where they
// apply. If one of them is edited away the hero silently goes back over the
// fold at 960 and 1280, and no other test in this repo would notice.
// The measurements themselves are in the final-QA report; the numbers above are
// what they said before and the reason each rule below exists.
//
// NEGATIVE CONTROL for this file: restore any one budget value in
// `src/styles/index.css` to the value named in its `was` field below (e.g.
// `.ai-tpl-h { margin: 18px 0 8px }`) and the matching arm reds.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_SOURCE = readFileSync(resolve(__dirname, '../../src/styles/index.css'), 'utf8');
/** The stylesheet with its comments removed — the CSS sibling of the repo's
 *  `codeOnly` rule. Every value this file forbids is WRITTEN in the stylesheet's
 *  own comments (they say what the old value was), so a scan that read comments
 *  could never go green. */
const CSS = CSS_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '');

/** The declaration block of one rule, by its exact selector. Throws rather than
 *  returning empty: a renamed selector must fail as "gone", never pass as "has
 *  no such declaration". */
function rule(selector: string): string {
  // `(`, `)` and `:` are escaped for the `:not([data-ai-tall])` selectors —
  // unescaped parentheses would become a capture group and the lookup would
  // silently miss, which every `not.toContain` arm would read as a pass.
  const escaped = selector.replace(/[.[\]*'()+]/g, (c) => `\\${c}`);
  const m = new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS);
  if (m === null) throw new Error(`no CSS rule for ${selector}`);
  return m[2] ?? '';
}

/** One line of the budget: the selector, the property, what it must say now,
 *  and what it said before final QA measured the overflow. */
interface Budget {
  selector: string;
  now: string;
  was: string;
}

/** The space the hero gave back so that 960x600 and 1280x800 fit. Every value
 *  here is SPACING BETWEEN BLOCKS — no font size, no line count, no word.
 *
 *  ⚠️ THE BUDGET IS COLLECTIVE, AND SAYING SO IS THE POINT OF THE LIST. Measured
 *  in the browser during the review: at 1280x800 the hero fits with 8px of
 *  slack, so putting ANY SINGLE line below back to its `was` value still fits —
 *  two do not. No arm here may therefore be read as "this declaration is what
 *  makes it fit"; what each one says is "this is one of the nine the fit was
 *  bought with, and it was not given back quietly". A stage that wants one of
 *  them back has to re-measure the whole hero, which is exactly the decision the
 *  file exists to force.
 */
const HERO_BUDGET: ReadonlyArray<Budget> = [
  { selector: '.ai-hello', now: 'padding: 2px 2px 0;', was: 'padding: 8px 2px 0;' },
  { selector: '.ai-hello > h1', now: 'margin-top: 6px;', was: 'margin-top: 8px;' },
  { selector: '.ai-beats', now: 'margin-top: 13px;', was: 'margin-top: 16px;' },
  {
    selector: '.ai-beats li',
    now: 'padding: 7px 10px 8px 0;',
    was: 'padding: 9px 10px 10px 0;',
  },
  { selector: '.ai-beats .ai-beat-n', now: 'margin-bottom: 2px;', was: 'margin-bottom: 3px;' },
  { selector: '.ai-tpl-h', now: 'margin: 13px 0 7px;', was: 'margin: 18px 0 8px;' },
  { selector: '.ai-tpl-guard', now: 'margin-top: 5px;', was: 'margin-top: 6px;' },
  // ⛔ ADDED IN REVIEW — the two the builder's report counted in the nine and
  // the table did not hold. The card padding is worth 4px of the 1280 budget
  // (two rows × 2px) and the explainer's top margin 1px; both were free to
  // drift back with every arm in this file green, which is the one thing a
  // budget guard may not allow.
  { selector: '.ai-tpl > button', now: 'padding: 9px 11px;', was: 'padding: 10px 11px;' },
  { selector: '.ai-hello > p', now: 'margin-top: 9px;', was: 'margin-top: 10px;' },
];

describe('the first screen fits the window it opens in', () => {
  // The name says "one of the nine", not "the one that overflowed": the budget
  // is collective (see HERO_BUDGET's note — 8px of slack at 1280 means no single
  // line below is the overflow on its own) and a name that blamed one
  // declaration would be a claim the measurement does not support.
  it.each(HERO_BUDGET)(
    'holds $now on $selector — one of the nine the 960/1280 fit was bought with, not the $was before it',
    ({ selector, now, was }: Budget) => {
      const block = rule(selector);
      expect(block, `${selector} lost the value the 960/1280 fit was measured with`).toContain(now);
      expect(block, `${selector} is back at its pre-QA value`).not.toContain(was);
    },
  );

  it('⛔ the explainer is one step tighter too — 19px of leading, not 20', () => {
    // 3 lines at 1280 and 4 at 960: a pixel of leading is 3–4px of the deficit,
    // and it costs no word and no line break.
    const block = rule('.ai-hello > p');
    expect(block).toContain('line-height: 19px;');
    expect(block).toContain('font-size: 13px;');
  });

  it('⛔ POSITIVE CONTROL — the 1600 window gives every one of them back', () => {
    // The large tier had 88px to spare when this was measured, so the tightening
    // is a fix for small windows and must not become the new baseline: the airy
    // rhythm the mockup draws is what a big window still shows. Each arm above
    // has its counterpart here, so an edit that tightens the base without
    // restoring it at `large` fails on THIS side.
    expect(rule('[data-ai-large] .ai-hello')).toContain('padding-top: 8px;');
    expect(rule('[data-ai-large] .ai-hello > h1')).toContain('margin-top: 8px;');
    expect(rule('[data-ai-large] .ai-beats')).toContain('margin-top: 16px;');
    expect(rule('[data-ai-large] .ai-beats li')).toContain('padding-top: 12px;');
    expect(rule('[data-ai-large] .ai-beats .ai-beat-n')).toContain('margin-bottom: 3px;');
    expect(rule('[data-ai-large] .ai-tpl-h')).toContain('margin: 18px 0 8px;');
    expect(rule('[data-ai-large] .ai-tpl-guard')).toContain('margin-top: 6px;');
    expect(rule('[data-ai-large] .ai-hello > p')).toContain('margin-top: 10px;');
    // The card's counterpart is not the base's old 10px but the large tier's
    // own 13px, which pre-dates final QA — measured at 1600x1000, the computed
    // padding really is 13px, so the base tightening never reached this window.
    // Held here anyway: without an arm, deleting the large rule would make the
    // base 9px the value a 1600 window shows, and no other arm would notice.
    expect(rule('[data-ai-large] .ai-tpl > button')).toContain('padding: 13px 14px;');
  });
});

describe('the band between short and tall drops what it cannot hold', () => {
  it('⛔ hides the beats when the view is narrow AND NOT tall', () => {
    // 1120x700 and 1124x660 are in this band, and both overflowed by 41–81px
    // before this rule existed — with `short` off, the label, the beats and the
    // guard tags all came back at once in a window only ~60px taller.
    expect(rule('[data-ai-narrow]:not([data-ai-tall]) .ai-beats')).toContain('display: none;');
    expect(rule('[data-ai-narrow]:not([data-ai-tall]) .ai-tpl-guard')).toContain('display: none;');
  });

  it('⛔ and `:not([data-ai-tall])` is the load-bearing half, not a flourish', () => {
    // At 1120x780 the view is narrow AND tall: the log has room for the whole
    // hero, and an unqualified `[data-ai-narrow]` rule would take the beats away
    // there for nothing. The selector is asserted with its qualifier attached —
    // if a later edit simplifies it, this arm is what says why it cannot.
    expect(CSS).toContain('[data-ai-narrow]:not([data-ai-tall]) .ai-beats');
    expect(CSS).not.toMatch(/\n\[data-ai-narrow\] \.ai-beats \{/);
  });
});

describe('a gate card takes the explainer’s place rather than pushing the templates off', () => {
  it('⛔ drops the explainer in both bands where the gated hero cannot fit', () => {
    // Spec §3.8 already made this trade once: the gate card takes the BEATS'
    // place, because it answers "what do I do next", which is the beats' job.
    // In `short` the beats are already gone, so the card is pure addition — 128
    // px of it — and at 960x600 it sliced the FIRST row of templates through the
    // title. The gate's own body ("You can explore templates and draft a task
    // now") is the orientation sentence for this one state.
    expect(rule('[data-ai-short] .ai-hello[data-gated] > p')).toContain('display: none;');
    expect(rule('[data-ai-narrow]:not([data-ai-tall]) .ai-hello[data-gated] > p')).toContain(
      'display: none;',
    );
  });

  it('⛔ and the hero really renders the attribute those two rules hang off', () => {
    // A CSS selector with no counterpart in the JSX is a rule that never
    // matches, and every arm above would still be green. `IdleHero` is read as
    // SOURCE with its comments stripped — the same rule this file applies to the
    // stylesheet — because its own prose says `data-gated` while explaining it.
    const hero = readFileSync(resolve(__dirname, '../../src/views/agent-chat/IdleHero.tsx'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    expect(hero).toContain('data-gated=');
    // Valueless-or-absent, the view's rule: `data-gated={false}` renders the
    // STRING "false", which `[data-gated]` matches — every hero would then be
    // treated as gated and the explainer would vanish from the small window for
    // customers who have a key.
    expect(hero).toMatch(/data-gated=\{gated \? '' : undefined\}/);
  });

  it('…and only when there IS a gate — the explainer is the ungated hero’s own sentence', () => {
    // The rules above are keyed on `[data-gated]`, which IdleHero renders only
    // when a gate card stands above it. An unqualified `[data-ai-short]
    // .ai-hello > p { display: none }` would delete the product's one-sentence
    // pitch from the smallest window for everybody.
    expect(CSS).not.toMatch(/\n\[data-ai-short\] \.ai-hello > p \{[^}]*display: none/);
    // …and the tier still shrinks it, which is the saving the UNGATED hero made.
    expect(rule('[data-ai-short] .ai-hello > p')).toContain('font-size: 12.5px;');
  });
});
