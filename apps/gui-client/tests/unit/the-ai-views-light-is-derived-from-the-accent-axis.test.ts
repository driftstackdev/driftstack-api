// The AI view's light is DERIVED, never typed (spec §2, the wow juror's must_fix).
//
// "The Stage" lights a room around a phone, and the colour of that light is the
// whole message: brand = acting, amber = waiting for you, green = finished, dim
// = trouble. Three ways that message breaks, and each one is an arm below.
//
//  1. A HUE TYPED INTO THE ROOM. `box-shadow: 0 0 28px #a83b4d` looks identical
//     today and stops following the accent the moment a second accent exists —
//     which is exactly what a brand axis is for. Every aura, glow, hairline and
//     light token must resolve through `rgb(var(--…-rgb) / a)`.
//  2. AN ACCENT THAT COLLIDES WITH A STATUS HUE. If an accent were added within
//     25° of `--status-busy-rgb` or `--status-ready-rgb`, "the AI is acting"
//     would be painted the same colour as "waiting for your approval" or
//     "finished" — the room would lie, and no contrast gate would notice,
//     because both readings pass AA. Only oxblood ships today; the arm is here
//     so the NEXT accent is measured before it is merged, not after.
//  3. MOTION THAT COSTS A LAYOUT OR HAS NO STILL. Every keyframe animates
//     `transform`/`opacity` only, and every infinite loop either rests on its
//     legible still at 0%/100% or is switched off under reduced motion — the
//     app's global clamp stops an animation on its LAST frame, so a loop whose
//     last frame is mid-sweep freezes as a bright band parked at a row's edge.
//
// ⛔ EVERY POPULATION BELOW IS DERIVED FROM THE STYLESHEET, and each refuses an
// empty or near-empty derivation. A guard that hand-lists the four tokens it
// knows about reads exactly like a clean run on the fifth one somebody adds.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const CSS_PATH = join(__dirname, '..', '..', 'src', 'styles', 'index.css');
const RAW = readFileSync(CSS_PATH, 'utf8');

/** The stylesheet with comments removed — a hex in a prose comment explaining
 *  what a token replaced is not a hue typed into the room. */
function withoutComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, ' ');
}
const CSS = withoutComments(RAW);

interface Rule {
  selector: string;
  body: string;
}

/** Top-level rules, by brace depth. Regex alone cannot do this: `@keyframes`
 *  and `@media` nest, and `[^}]*` would cut every rule at the first inner
 *  brace. Returns at-rules too, selector first (`@keyframes ds-ai-calm`). */
function topLevelRules(css: string): Rule[] {
  const out: Rule[] = [];
  let depth = 0;
  let start = 0;
  let selectorStart = 0;
  for (let i = 0; i < css.length; i += 1) {
    const ch = css[i];
    if (ch === '{') {
      depth += 1;
      if (depth === 1) start = i + 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        out.push({
          selector: css.slice(selectorStart, start - 1).trim(),
          body: css.slice(start, i),
        });
        selectorStart = i + 1;
      }
    }
  }
  return out;
}
const RULES = topLevelRules(CSS);

/** Declarations of `--ai-*` custom properties, anywhere in the file (they are
 *  declared in four blocks and a fifth would be missed by a per-block read). */
function aiTokenDeclarations(): ReadonlyArray<{ name: string; value: string }> {
  const out: { name: string; value: string }[] = [];
  const re = /(--ai-[a-z0-9-]+)\s*:\s*([^;]+);/g;
  for (let m = re.exec(CSS); m !== null; m = re.exec(CSS)) {
    out.push({ name: m[1] ?? '', value: (m[2] ?? '').replace(/\s+/g, ' ').trim() });
  }
  return out;
}
const AI_TOKENS = aiTokenDeclarations();

/** Every rule that paints a piece of the AI view: its selector names an `.ai-`
 *  class or a `data-ai-` attribute. Media queries are flattened in, so a rule
 *  hidden inside the reduced-motion block is scanned too. */
function aiRules(): ReadonlyArray<Rule> {
  const out: Rule[] = [];
  for (const rule of RULES) {
    const inner = rule.selector.startsWith('@media') ? topLevelRules(rule.body) : [rule];
    for (const r of inner) {
      if (/\.ai-|\[data-ai-/.test(r.selector)) out.push(r);
    }
  }
  return out;
}
const AI_RULES = aiRules();

const KEYFRAMES = RULES.filter((r) => /^@keyframes\s+ds-ai-/.test(r.selector)).map((r) => ({
  name: r.selector.replace(/^@keyframes\s+/, '').trim(),
  body: r.body,
}));

// ─── colour maths ────────────────────────────────────────────────────────────

/** A numeric colour a CSS value can carry: `#rrggbb`, `#rgb`, or an `rgb()` /
 *  `rgba()` whose channels are literal numbers rather than a `var()`. */
const HEX = /#[0-9a-f]{3,8}\b/gi;
const NUMERIC_RGB = /\brgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/gi;

function literalColours(value: string): string[] {
  const out = [...(value.match(HEX) ?? [])];
  for (let m = NUMERIC_RGB.exec(value); m !== null; m = NUMERIC_RGB.exec(value)) {
    out.push(`rgb(${m[1] ?? ''} ${m[2] ?? ''} ${m[3] ?? ''})`);
  }
  NUMERIC_RGB.lastIndex = 0;
  return out;
}
/** Pure black and pure white carry no hue, so a shadow written with them
 *  cannot contradict the accent. Everything else is a hue. */
function isAchromatic(colour: string): boolean {
  return colour === 'rgb(0 0 0)' || colour === 'rgb(255 255 255)';
}

function hueOf([r, g, b]: readonly [number, number, number]): number {
  const [rn, gn, bn] = [r / 255, g / 255, b / 255];
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const d = max - min;
  if (d === 0) return 0;
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}
/** Degrees apart on the wheel, the short way round (0–180). */
function hueDistance(a: number, b: number): number {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

function blockOf(selector: string): string {
  const rule = RULES.find((r) => r.selector === selector);
  if (rule === undefined) throw new Error(`no rule for selector ${selector} in index.css`);
  return rule.body;
}
function tripleIn(body: string, name: string): readonly [number, number, number] {
  const m = new RegExp(`--${name}:\\s*(\\d+)\\s+(\\d+)\\s+(\\d+)\\s*;`).exec(body);
  if (m === null) throw new Error(`--${name} is not a plain rgb triple in that block`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

// ─── 1. nothing in the room's light is a typed hue ───────────────────────────

/** The tokens that carry the room's LIGHT rather than its geometry or its
 *  shadow: anything whose name says aura, glow, hairline or light. Derived from
 *  the names actually declared, so a `--ai-aura-error` added tomorrow is
 *  scanned by the next run without touching this file. */
const LIGHT_TOKENS = AI_TOKENS.filter((t) => /aura|glow|hairline|light/.test(t.name));

/** The one literal triple the layer is allowed: the room's own SURFACE. It is a
 *  surface token like `--surface-inset-rgb` — the ground other tokens are read
 *  against, not a light cast on anything — and the light theme's value is
 *  deliberately the dark theme's `--surface-base-rgb` (spec D2: the stage is a
 *  dark room in both themes). Everything else must resolve through a var(). */
const SURFACE_TOKEN = '--ai-stage-rgb';

describe("the AI view's room light is derived from the accent axis, never typed", () => {
  it('every aura, glow, hairline and light token resolves through a token var(), with no hue of its own', () => {
    expect(
      LIGHT_TOKENS.length,
      'the light-token sweep derived nothing to scan — the §2 tokens are missing or renamed',
    ).toBeGreaterThanOrEqual(6);
    for (const t of LIGHT_TOKENS) {
      const typed = literalColours(t.value).filter((c) => !isAchromatic(c));
      expect(typed, `${t.name} paints with a typed hue: ${typed.join(', ')}`).toEqual([]);
      expect(t.value, `${t.name} references no token`).toMatch(/var\(--[a-z-]+\)/);
    }
  });

  it('every other --ai-* token is geometry, a duration, or a shadow in pure black or white', () => {
    const others = AI_TOKENS.filter((t) => !/aura|glow|hairline|light/.test(t.name));
    expect(others.length, 'the non-light --ai-* sweep derived nothing').toBeGreaterThanOrEqual(10);
    for (const t of others) {
      const typed = literalColours(t.value).filter((c) => !isAchromatic(c));
      const allowed = t.name === SURFACE_TOKEN ? typed.length <= 1 : typed.length === 0;
      expect(
        allowed,
        `${t.name} = "${t.value}" types a hue (${typed.join(', ')}); only ${SURFACE_TOKEN}, the room's own surface, may`,
      ).toBe(true);
    }
  });

  it('every .ai-* rule paints through a token too — no hex, no numeric hue', () => {
    expect(
      AI_RULES.length,
      'the .ai-* rule sweep derived nothing to scan — the motion layer is missing',
    ).toBeGreaterThanOrEqual(20);
    for (const rule of AI_RULES) {
      const typed = literalColours(rule.body).filter((c) => !isAchromatic(c));
      expect(typed, `${rule.selector} paints with a typed hue: ${typed.join(', ')}`).toEqual([]);
    }
  });

  it('a token that reads a MODE variable is declared per mode, so the pinned-dark stage re-resolves it', () => {
    // ⛔ The defect this prevents, measured in a browser on this build: with the
    // page in LIGHT mode, `--ai-aura-busy` resolves to the light amber
    // (rgb(123 84 11)) at the root and to the DARK amber (rgb(251 191 36))
    // inside a nested [data-mode="dark"] element — which is what the stage is
    // (spec D2: a dark room in both themes). A custom property resolves its
    // var() references WHERE IT IS DECLARED, so one declaration on <html> would
    // hand the dark room the light theme's status hues: the amber "waiting for
    // you" room would be a dim olive in the light theme, and nobody reviewing in
    // dark mode would ever see it.
    const modeBlocks = RULES.filter((r) => r.selector === '[data-mode]');
    expect(modeBlocks.length, 'no [data-mode] block — the composites have no per-mode home').toBe(
      1,
    );
    const perMode = modeBlocks[0]?.body ?? '';
    const accentAxis = blockOf('[data-accent]');
    for (const token of LIGHT_TOKENS) {
      // Every token that reads a status or ink variable must live in the
      // per-mode block, never on the accent axis (which is mode-independent).
      if (/var\(--(status|ink|surface)-/.test(token.value)) {
        expect(perMode, `${token.name} reads a mode variable`).toContain(token.name);
        expect(accentAxis, `${token.name} is on the accent axis`).not.toContain(token.name);
      }
    }
    // …and the motion/voice tokens, which read nothing, stay on the accent axis
    // where a second accent would inherit them unchanged.
    expect(accentAxis).toContain('--ai-ease');
    expect(accentAxis).toContain('--ai-voice-weight');
  });

  it('the room light is actually PAINTED somewhere — --ai-light-rgb is read, not just declared', () => {
    // Vacuity control for the three arms above: they are negatives, and a layer
    // that declared the tokens and used none of them would satisfy all three.
    const readers = AI_RULES.filter((r) => r.body.includes('var(--ai-light-rgb)'));
    expect(readers.map((r) => r.selector).length).toBeGreaterThanOrEqual(1);
    const auraDiscs = AI_RULES.filter((r) => /var\(--ai-aura-(accent|busy|ready)\)/.test(r.body));
    expect(auraDiscs).toHaveLength(3);
  });
});

// ─── 2. an accent can never be mistaken for a status ─────────────────────────

/** Minimum degrees between the accent and a status hue. Below this the room's
 *  "acting" light and its "waiting"/"finished" light are the same colour to a
 *  customer, and every contrast gate still passes. */
const MIN_HUE_SEPARATION_DEG = 25;

describe('an accent is never within 25° of a status hue', () => {
  const accentBlocks = RULES.filter((r) => /^\[data-accent='[a-z-]+'\]$/.test(r.selector));

  it('every accent in the file is measured — and there is at least one to measure', () => {
    expect(
      accentBlocks.length,
      'no [data-accent=<name>] block was found: the sweep would pass by scanning nothing',
    ).toBeGreaterThanOrEqual(1);
  });

  for (const mode of ['light', 'dark'] as const) {
    it(`${mode}: no accent collides with --status-busy-rgb or --status-ready-rgb`, () => {
      const modeBlock = blockOf(`[data-mode='${mode}']`);
      const busy = hueOf(tripleIn(modeBlock, 'status-busy-rgb'));
      const ready = hueOf(tripleIn(modeBlock, 'status-ready-rgb'));
      for (const block of accentBlocks) {
        const accent = hueOf(tripleIn(block.body, 'accent-rgb'));
        expect(
          hueDistance(accent, busy),
          `${block.selector} is the same colour as "waiting for your approval" in ${mode} mode`,
        ).toBeGreaterThanOrEqual(MIN_HUE_SEPARATION_DEG);
        expect(
          hueDistance(accent, ready),
          `${block.selector} is the same colour as "finished" in ${mode} mode`,
        ).toBeGreaterThanOrEqual(MIN_HUE_SEPARATION_DEG);
      }
    });
  }

  it('CONTROL — the same measurement rejects an amber accent and accepts oxblood', () => {
    // The instrument, exercised on a value the file does not contain: an accent
    // at the dark theme's own busy hue is 0° away and must fail, while the
    // shipped oxblood clears the bar by a wide margin. Without this, an arm that
    // computed 0 for everything would read as a clean run.
    const dark = blockOf("[data-mode='dark']");
    const busy = tripleIn(dark, 'status-busy-rgb');
    expect(hueDistance(hueOf(busy), hueOf(busy))).toBe(0);
    const oxblood = tripleIn(blockOf("[data-accent='oxblood']"), 'accent-rgb');
    expect(oxblood).toEqual([168, 59, 77]);
    expect(hueDistance(hueOf(oxblood), hueOf(busy))).toBeGreaterThan(MIN_HUE_SEPARATION_DEG);
    expect(hueDistance(hueOf(oxblood), hueOf(tripleIn(dark, 'status-ready-rgb')))).toBeGreaterThan(
      MIN_HUE_SEPARATION_DEG,
    );
  });
});

// ─── 3. the motion vocabulary ────────────────────────────────────────────────

/** The only properties a `ds-ai-*` keyframe may animate. Anything else costs a
 *  layout or a paint per frame, and the running stage already carries one
 *  full-size compositor layer. */
const ANIMATABLE = new Set(['transform', 'opacity']);

/** The classes switched off under reduced motion — read OUT of the stylesheet's
 *  own reduced-motion block, so a piece added to it is honoured here and a
 *  piece removed from it has to satisfy the "rests on its still" rule instead. */
function reducedMotionHiddenSelectors(): ReadonlyArray<string> {
  const media = RULES.filter((r) => /prefers-reduced-motion/.test(r.selector));
  const hidden: string[] = [];
  for (const block of media) {
    for (const rule of topLevelRules(block.body)) {
      if (/display:\s*none/.test(rule.body)) {
        hidden.push(...rule.selector.split(',').map((s) => s.trim()));
      }
    }
  }
  return hidden;
}

describe('every ds-ai-* animation is cheap to run and has a still to rest on', () => {
  it('the keyframe sweep found the motion vocabulary', () => {
    expect(
      KEYFRAMES.map((k) => k.name).length,
      'no ds-ai-* keyframes were found: every arm below would pass by scanning nothing',
    ).toBeGreaterThanOrEqual(15);
    expect(new Set(KEYFRAMES.map((k) => k.name)).size).toBe(KEYFRAMES.length);
  });

  it('they animate transform and opacity ONLY — never a layout or a colour', () => {
    for (const frame of KEYFRAMES) {
      const props = [...frame.body.matchAll(/([a-z-]+)\s*:/g)].map((m) => m[1] ?? '');
      expect(props.length, `${frame.name} declares nothing`).toBeGreaterThan(0);
      for (const prop of props) {
        expect(ANIMATABLE.has(prop), `${frame.name} animates "${prop}"`).toBe(true);
      }
    }
  });

  it('every INFINITE loop rests on its legible still, or is removed under reduced motion', () => {
    // The app's global clamp ends an animation on its LAST frame. A loop whose
    // 0% and 100% frames agree therefore freezes exactly where it started — the
    // still is the same rule read at a different time, not a second set of
    // declarations to keep in step. A loop that does NOT agree has to be taken
    // off the screen instead, or the clamp parks it mid-gesture.
    const hidden = reducedMotionHiddenSelectors();
    expect(
      hidden.length,
      'the reduced-motion block hides fewer pieces than the four whose clamped last frame is wrong',
    ).toBeGreaterThanOrEqual(4);
    const infinite = AI_RULES.filter((r) => /animation:[^;]*infinite/.test(r.body));
    expect(infinite.length, 'no infinite animation was found to check').toBeGreaterThanOrEqual(6);
    for (const rule of infinite) {
      const name = /animation:\s*(ds-ai-[a-z-]+)/.exec(rule.body)?.[1] ?? '';
      const frame = KEYFRAMES.find((k) => k.name === name);
      expect(
        frame,
        `${rule.selector} runs "${name}", which is not a ds-ai-* keyframe`,
      ).toBeDefined();
      if (frame === undefined) continue;
      // `ds-ai-spin` is the one exemption, and it is an identity: its last frame
      // is rotate(360deg), which IS its first frame.
      if (name === 'ds-ai-spin') continue;
      // ⛔ THE `0%` HAS TO BE A WHOLE PERCENTAGE, not the tail of another one.
      // `/0%,\s*100%\s*\{/` reads the `0%,` inside `60%,` and calls
      // `60% , 100% { … }` a rest at 0%/100% — which is exactly the shape of
      // ds-ai-sweep, the loop that parks a bright band at a row's right edge.
      // It passes today only because .ai-sweep is ALSO in the reduced-motion
      // block, so the next `40%, 100%` loop somebody adds would be waved
      // through. The lookbehind refuses a digit or a decimal point before it.
      const rests = /(?<![\d.])0%\s*,\s*100%\s*\{/.test(frame.body);
      const removed = hidden.some((sel) => rule.selector.split(',').some((s) => s.trim() === sel));
      expect(
        rests || removed,
        `${name} (on ${rule.selector}) neither rests at 0%/100% nor is removed under reduced motion — ` +
          `the clamp will freeze it on its last frame, mid-gesture`,
      ).toBe(true);
    }
  });

  it('the pieces whose clamped last frame would be wrong are removed, not frozen', () => {
    const hidden = reducedMotionHiddenSelectors();
    // Named because each one's WRONG still is a specific picture: a bright wash
    // parked at a row's right edge, a pulse ring stopped at full spread, a halo
    // frozen mid-flash, an outgoing caption sitting on the words that replaced it.
    for (const sel of ['.ai-sweep', '.ai-pulse', '.ai-halo', '.ai-tense-out']) {
      expect(hidden, `${sel} is not removed under reduced motion`).toContain(sel);
    }
  });

  it('nothing is permanently promoted to its own layer', () => {
    // Read the VALUE, do not negative-lookahead it: `\s*(?!auto)` backtracks to
    // zero width and then matches the space before "auto", so the arm reported
    // the reduced-motion release as a promotion.
    const promoted = AI_RULES.filter((r) => {
      const value = /will-change:\s*([^;]+);/.exec(r.body)?.[1]?.trim();
      return value !== undefined && value !== 'auto';
    });
    // Exactly one, and it is the 800ms device turn — a class the view adds when
    // the rig flips and removes on transitionend.
    expect(promoted.map((r) => r.selector)).toEqual(['.ai-rig.is-turning']);
  });
});
