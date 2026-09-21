// The first screen has to fit on a machine that does not have this one's fonts.
//
// ⛔ WHAT WAS WRONG, MEASURED ON CI, NOT REASONED. `GUI render gates (Linux)`
// went red on main (run 35567350180) with six Phase D violations that no
// maintainer's Mac could see, identical in both themes:
//     audit-agent-chat        1280x800 → first screen OVER by 11
//     audit-agent-chat-nokey   960x600 → OVER by 12
//     audit-agent-chat-nokey  1280x800 → OVER by 21
// On this Mac the same three cells fitted with 8, 4.25 and 13.5px of slack —
// so the layout fitted only with macOS font metrics, and a Linux customer got
// a first screen that scrolled, with the bottom row of template cards sliced.
//
// ⛔ THE MECHANISM. Nothing in this repo ships a font file. `tailwind.config.ts`
// names `Geist Sans` and `Berkeley Mono`, there is no `@font-face` and no woff2
// under `apps/gui-client`, so both stacks fall through to whatever the OS has:
// `-apple-system` → San Francisco on a Mac, and on the runner (whose `fc-list`
// the workflow records — no Geist, no Roboto, no Segoe UI) all the way to
// `sans-serif` → DejaVu Sans, which sets ~9-12% WIDER at the same px size.
// Every line-height on the first screen is pinned in px, so NONE of the growth
// was taller lines. All of it was prose taking one more line, in three blocks,
// and the CI numbers are their sum to the pixel:
//     the hero explainer      3 → 4 lines  +19px
//     the API-key gate's body 3 → 4 lines  +16px
//     both at once, 1280x800               +35px
//
// ⛔ WHAT THIS FILE HOLDS, AND WHAT IT CANNOT. jsdom has no layout engine —
// every `getBoundingClientRect()` here is 0x0 — so the fit itself is measured by
// `scripts/gui-visual-check.mjs` (Phase D, plus the font-stress pass D5 added
// for exactly this defect) and NOT here. What this file holds is the two halves
// that a stylesheet edit or a script edit could take away with the measurement
// still green on a Mac:
//   1. the CONSTRUCTION — the room the mission column was given and the two
//      line boxes it was given back, which is where the ~45px of new slack came
//      from;
//   2. the INSTRUMENT — that the gate still carries a font-stress pass, with
//      the factor derived from the CI run, applied in the one way that is not
//      self-compounding, and refusing to report clean over nothing.
//
// The budget this file's sibling `the-first-screen-fits-the-window-it-opens-in`
// holds is the other half: the spacing values themselves.

import { readFileSync } from 'node:fs';
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const GUI_ROOT = resolve(REPO_ROOT, 'apps/gui-client');

/** Comments stripped, the CSS sibling of the repo's `codeOnly` rule: every old
 *  value this file forbids is WRITTEN in the stylesheet's own comments, so a
 *  scan that read them could never go red. */
const CSS = readFileSync(resolve(GUI_ROOT, 'src/styles/index.css'), 'utf8').replace(
  /\/\*[\s\S]*?\*\//g,
  '',
);
/** The gate, as source. Its header quotes the pre-fix numbers and the old
 *  values, so the same stripping applies before anything is asserted about it. */
const GATE_SOURCE = readFileSync(resolve(REPO_ROOT, 'scripts/gui-visual-check.mjs'), 'utf8');
const GATE = GATE_SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const WORKFLOW = readFileSync(resolve(REPO_ROOT, '.github/workflows/gui-gates.yml'), 'utf8');
const TAILWIND = readFileSync(resolve(GUI_ROOT, 'tailwind.config.ts'), 'utf8');

/** The declaration block of one rule, by its exact selector. Throws rather than
 *  returning empty: a renamed selector must fail as "gone", never pass as "has
 *  no such declaration", which every `not.toContain` arm would read as a pass. */
function rule(selector: string): string {
  const escaped = selector.replace(/[.[\]*'()+]/g, (c) => `\\${c}`);
  const m = new RegExp(`(^|\\n)${escaped} \\{([^}]*)\\}`).exec(CSS);
  if (m === null) throw new Error(`no CSS rule for ${selector}`);
  return m[2] ?? '';
}

/** The `width` of a rule, in px, as a number — so the arms below can assert the
 *  RELATIONSHIP between two of them rather than two literals that could drift
 *  apart while both stayed "a number someone wrote". */
function widthPx(selector: string): number {
  const m = /width: (-?[\d.]+)px;/.exec(rule(selector));
  if (m === null) throw new Error(`${selector} declares no px width`);
  return Number(m[1]);
}

/** Every file under a directory, recursively. Used to prove a NEGATIVE (no font
 *  file is bundled), so it walks rather than globbing: a glob that matched
 *  nothing and a tree that contains nothing look identical. */
function everyFile(dir: string, skip: ReadonlyArray<string>): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skip.includes(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...everyFile(full, skip));
    else out.push(full);
  }
  return out;
}

describe('the root cause: this app ships no font, so the OS picks one', () => {
  it('⛔ both stacks end in a GENERIC family — which is the fallback CI landed on', () => {
    // This is the fact the whole stress pass rests on. `sans-serif` resolves to
    // San Francisco here and DejaVu Sans on the runner, and those two are ~12%
    // apart in advance width. An arm on the stack is the only thing that makes
    // that dependency visible from inside the repo.
    expect(TAILWIND).toContain("'Geist Sans'");
    expect(TAILWIND).toMatch(/sans: \[[^\]]*'sans-serif',?\s*\]/);
    expect(TAILWIND).toMatch(/mono: \[[^\]]*'monospace',?\s*\]/);
  });

  it('⛔ …and nothing self-hosts them, which is WHY the fallback is reached', () => {
    // If a font is ever bundled — a woff2 plus an `@font-face` — the runner
    // stops falling through, the defect this stage fixed changes shape, and
    // `AI_FONT_STRESS_EM` has to be re-derived against a fresh CI run rather
    // than inherited. This arm is what forces that to be a decision.
    const fonts = everyFile(resolve(GUI_ROOT, 'src'), ['node_modules']).filter((f) =>
      /\.(woff2?|ttf|otf|eot)$/i.test(f),
    );
    expect(fonts, 'a bundled font changes the mechanism — re-derive AI_FONT_STRESS_EM').toEqual([]);
    expect(CSS).not.toContain('@font-face');
  });
});

describe('the construction: the stage gives way before the words do', () => {
  it('⛔ the base stage is 344px, the width at which the drawing still does not shrink', () => {
    // `.ai-center` sizes the phone as
    //   min(100cqw - var(--ai-fit-gx), (100cqh - var(--ai-fit-gy)) / 2.0943)
    // and at 1280x800 the SECOND term wins: 275px out of a 584px-tall
    // container. Measured in a browser: the phone stays 275px for every stage
    // width down to 344 (312px of container, 312 - 36 = 276 > 275). So the 36px
    // this handed the mission column came out of the empty room BESIDE the
    // device, not out of the device — and below 344 the first term would start
    // winning and the iPhone, which is the feature, would be what pays.
    expect(widthPx('.ai-stage')).toBe(344);
    expect(rule('.ai-fit')).toContain('--ai-fit-gx: 36px;');
    expect(rule('.ai-center')).toContain('100cqw - var(--ai-fit-gx)');
  });

  it('⛔ and the narrow stage is 238px, by the same measurement at the 960x600 minimum', () => {
    // There the phone is 214px wide and height-bound too ((452 - 4) / 2.0943),
    // and 238 - 16 - 8 = 214 exactly: this is the floor, not a round number.
    expect(widthPx('[data-ai-narrow] .ai-stage')).toBe(238);
    expect(rule('[data-ai-narrow] .ai-fit')).toContain('--ai-fit-gx: 8px;');
  });

  it('⛔ the light well keeps the same FOOTPRINT, or one theme fits and the other does not', () => {
    // The light stage is inset by its own margin, so its `width` has to be the
    // dark one MINUS that margin — otherwise the mission column is a different
    // size per theme and Phase D's two theme arms measure two layouts. They were
    // 380/370 and 252/246 before this stage and 344/334 and 238/232 after; what
    // is held is the arithmetic, not the pair of literals.
    expect(widthPx("[data-mode='light'] .ai-stage")).toBe(widthPx('.ai-stage') - 10);
    expect(rule("[data-mode='light'] .ai-stage")).toContain('margin: 10px 0 10px 10px;');
    expect(widthPx("[data-mode='light'] [data-ai-narrow] .ai-stage")).toBe(
      widthPx('[data-ai-narrow] .ai-stage') - 6,
    );
    expect(rule("[data-mode='light'] [data-ai-narrow] .ai-stage")).toContain(
      'margin: 6px 0 6px 6px;',
    );
  });

  it('⛔ and the two 10px labels stop carrying a 24px line box', () => {
    // `.section-label` is an inline span: in the hero it inherited the column's
    // 24px leading and drew nothing in 12px of it. As a block it is its own
    // 14px. Two labels, ~22px, and no word or size moved. The large tier puts
    // both back — that arm lives with the rest of the restores, in
    // `the-first-screen-fits-the-window-it-opens-in`.
    expect(rule('.ai-hello > .section-label')).toContain('display: block;');
    expect(rule('.ai-tpl-h')).toContain('line-height: 14px;');
  });
});

describe('the instrument: the gate can see a Linux font from a Mac', () => {
  it('⛔ carries a font-stress factor DERIVED from the CI run, inside its measured band', () => {
    // 0.045em/character reproduces run 35567350180's Phase D numbers exactly in
    // 11 of the 12 first-screen cells, including all six that failed and their
    // over-by numbers (11 / 12 / 21). Any value in 0.036–0.050 reproduces the
    // same twelve verdicts; 0.045 is the middle of that band, not an edge of it.
    const m =
      /const AI_FONT_STRESS_EM = Number\(process\.env\.AI_FONT_STRESS_EM \?\? '([\d.]+)'\)/.exec(
        GATE,
      );
    expect(m, 'the gate no longer declares a font-stress factor').not.toBeNull();
    const em = Number(m?.[1]);
    expect(em).toBeGreaterThanOrEqual(0.036);
    expect(em).toBeLessThanOrEqual(0.05);
  });

  it('⛔ applies it as letter-spacing — the one lever that does not move `ch` with the text', () => {
    // `font-size-adjust` was tried and rejected, and the rejection is the
    // finding: it scales the USED FONT SIZE, so `max-width: 54ch` on the hero
    // explainer grows by exactly the factor its text grew by and the line count
    // never moves. On the runner the text is ~12% wider and `ch` (the advance of
    // "0") only ~1%. Measured after the fix, the font-size-adjust emulation
    // reported the explainer still at three lines where DejaVu takes four — an
    // instrument blind to the block that caused the outage.
    expect(GATE).toContain('letterSpacing');
    expect(GATE).not.toContain('fontSizeAdjust');
    expect(GATE).not.toContain('font-size-adjust');
  });

  it('⛔ and snapshots before it writes, or the stress compounds with depth', () => {
    // `letter-spacing` INHERITS. A single walk that reads
    // `getComputedStyle(el).letterSpacing` and writes it back reads its own
    // writes: a child of an already-stressed node inherits the stressed value,
    // adds the delta again, and deep runs end up several times more stressed
    // than shallow ones — which is not any font, and would red cells that are
    // fine while missing cells that are not.
    const fn = /function stressFirstScreenText\(em\) \{([\s\S]*?)\n\}/.exec(GATE);
    expect(fn, 'the gate no longer defines stressFirstScreenText').not.toBeNull();
    const body = fn?.[1] ?? '';
    const read = body.indexOf('snapshot.push(');
    const write = body.indexOf('el.style.letterSpacing');
    expect(read).toBeGreaterThan(-1);
    expect(write).toBeGreaterThan(-1);
    expect(write, 'the write must come after the whole snapshot, in its own loop').toBeGreaterThan(
      read,
    );
    // …and the write loop iterates the snapshot, not the document again.
    expect(body).toContain('for (const [el, px] of snapshot)');
  });

  it('⛔ refuses to report a clean stress pass over nothing', () => {
    // Two ways this pass could go quiet and green: no cell had a first screen
    // (the scene list changed shape), or the injection reached nothing (the
    // evaluate silently failed). Both are the same failure — a measurement that
    // did not happen, reported as one that passed.
    expect(GATE).toContain('refusing to report a clean font-stress pass over nothing');
    // ⛔ THE VALUE AND THE COMPARISON, not the name. Written as
    // `toContain('const MIN_STRESSED_NODES')` this arm survived renaming the
    // constant to `MIN_STRESSED_NODES_UNUSED` — a prefix match reported a guard
    // that nothing read any more as a guard that was in place.
    expect(GATE).toMatch(/const MIN_STRESSED_NODES = \d+;/);
    expect(GATE).toContain('stressedNodes < MIN_STRESSED_NODES');
    expect(GATE).toContain('a page that was not stressed must not report as one that was');
  });

  it('⛔ and a stressed violation can never be read as a plain one', () => {
    // The two passes apply the SAME rule to different text widths; a log line or
    // a report row that did not say which would make the six CI cells and six
    // local cells indistinguishable.
    // ⛔ THE STATEMENT, not the suffix. Written as `toContain('-under-font-
    // stress')` this arm survived DELETING the rename outright, because the
    // `first-screen-lost-under-font-stress` kind a few lines below still
    // contained the substring — a second use of the same text reporting a rule
    // nobody applied.
    expect(GATE).toContain('for (const viol of res.violations) viol.kind =');
    expect(GATE).toContain('-under-font-stress`');
    expect(GATE).toContain("const prefix = stress === null ? 'ai' : 'ai-stress';");
    expect(GATE).toContain('report.aiFontStress.push(');
  });
});

describe('the pass EXTENDS Phase D — it does not replace what was already held', () => {
  it('⛔ the 78-cell coverage is intact: three windows, both themes, every AI scene', () => {
    expect(GATE).toContain("process.env.AI_WINDOWS ?? '960x600,1024x640,1280x800'");
    expect(GATE).toContain("process.env.AI_THEMES ?? 'dark,light'");
    // The scene list is still READ FROM THE HARNESS, so a new AI scene is
    // measured with no edit to the gate — and an empty list is still refused.
    expect(GATE).toContain('ALL_SCENES');
    expect(GATE).toContain('refusing to report a clean AI sweep over nothing');
  });

  it('⛔ the banner-bounded rule is still the rule for a docked banner', () => {
    // A scene with a docked banner is held to a DIFFERENT promise, not to none:
    // the banner may cost the first screen its own height and no more. The
    // stress pass inherits that rule rather than carrying a second one.
    expect(GATE).toContain('const AI_BANNER_ALLOWANCE = 24;');
    expect(GATE).toContain('first-screen-scrolls-past-its-banner');
  });

  it('⛔ and the workflow still runs the gate the same way, so the pass reaches CI', () => {
    // The stress pass is inside the existing entry point on purpose: nothing in
    // `.github/workflows` has to learn a new command, and there is no second
    // invocation that could be added on a Mac and forgotten on the runner.
    expect(WORKFLOW).toContain('node scripts/gui-visual-check.mjs');
    expect(WORKFLOW).toContain('fc-list');
    // The gate takes no new required argument or env var — the factor has a
    // default and the env is an override, so an unchanged workflow step is a
    // complete run.
    expect(GATE).toContain("process.env.AI_FONT_STRESS_EM ?? '0.045'");
  });
});
