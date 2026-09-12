// On-screen iOS keyboard for the floating-iPhone simulator (founder 2026-06-25:
// "behave exactly like a real iPhone"). Pixel-faithful QWERTY with the three iOS
// layers (letters / numbers / symbols), one-shot + caps-lock shift, and the iOS
// key "pop-up" magnifier on press.
//
// WIRING / fingerprint note: this is pure GUI CHROME. Every key produces the
// SAME keyDown/keyUp InputEvents the host-keyboard path emits (lib/
// livekit-input-capture onKeyDown/onKeyUp) — a real keypress is down-then-up —
// so the page sees nothing beyond the keystrokes themselves (identical to host
// typing today). It does NOT touch the page's view: the keyboard-driven
// viewport resize (which WOULD change what the page sees) is intentionally
// deferred to A3's box-side focus/resize signals (W2992). The keyboard mounts
// BELOW the video as chrome, so it never moves the <video> on-screen rect the
// tap/scroll coordinate mapping reads (pointerToViewport maps against the video
// element's own bounding rect).
//
// Shift is GUI-LOCAL: it controls the CASE of the next character's `key` (so
// shift+a sends keyDown key:'A'); no modifier-only event is sent for the shift
// tap itself.
//
// ─────────────────────────────────────────────────────────────────────────────
// GEOMETRY (owner 2026-09-12: "imprpoved auto scaling more beautifully and look
// better like latest iphone"). Every length on this board is DERIVED from TWO
// inputs — the only px constants left are the REFERENCE table (the 1:1 iPhone
// geometry everything scales from) and the FLOORS that keep a very narrow board
// legible:
//   • the board's MEASURED rendered width (a ResizeObserver on the board), and
//   • `width`, the LOGICAL CSS width of the device the <video> above is showing.
//
// ⛔ Those are different numbers, and the second one alone is what this file
// used to reason about. SimulatorWindow passes `inputLogical.width` (the
// archetype's logical width — 402 for iphone-16-pro) while the keyboard's
// RENDERED width is (window width − rail − pane − bezel) and is a free
// variable: `fitWindow` preserves the operator's width and the screen clamp
// re-derives width from a clamped height. Measured on the harness 2026-09-12,
// driving the rendered width 212 → 874 moved every metric EXCEPT key width
// nowhere at all: key height 42, board 200, gap 6, radius 5, fonts 22/15/13 at
// every width. ⛔ Key WIDTH did track the render — it was a percentage
// (`calc((100% − 54px) * n / 10)`) — and the only PROP-derived value was the side
// padding. So the keys widened while nothing else ever moved, which is exactly
// the complaint: a 42px-tall key on a 212px board is 2.7× taller than it is
// wide; on an 874px board it is 1.9× wider than tall (measured aspect 0.37 →
// 1.94). That is the owner's complaint, quantified.
//
// THE RULE: measured/logical is the render's ZOOM (the video shows a
// `width`-logical-px page inside `measured` CSS px), so the keyboard is THE
// PREVIOUSLY SHIPPED 402 RENDER at that zoom — scale = min(1, measured /
// logical), see keyboardScale. It is capped at 1 on the reasoning that a real
// iPhone's keyboard height is set by the device's SHORT side and is ~constant
// across the portrait widths (390 / 393 / 402): what a wider board buys is key
// WIDTH, not key height. So past 1:1 — a landscape 874 board, or a window
// dragged wider than actual size — the keys get wider and the rows stay
// reference-height.
//
// ⛔ WHAT IS AND IS NOT DEVICE-VERIFIED — say it here, because "like the latest
// iPhone" is the request and half of this is a copy of our own previous render:
//   • DEVICE-CHECKABLE and checked: the HORIZONTAL grid. Ten columns of 34.2 + a
//     6px gap at 402 is the iPhone's 40.2pt key pitch, and the 1.5- / 2.5-column
//     flanks are the iOS key shapes.
//   • NOT verified against a device, inherited unchanged from the render this
//     replaces: the ROW PITCH (keyH 42 + gap 6 = 48), the BOARD HEIGHT (200 =
//     23% of the 874pt screen), the absence of a home-indicator bottom inset,
//     and the absence of the predictive row.
// Those four are "the 402 render at that zoom", not "the device". Do not restate
// them as iPhone fidelity without measuring a device first.
//
// At 1:1 the scale is exactly 1 and every metric IN REF_GEOMETRY is
// byte-identical to the 402 render this file shipped with — including the 200px
// board height SimulatorWindow's KEYBOARD_H comment measures. The 402 render is
// NOT unchanged overall: the flank widths (51.3 → 54.3), the row-3 and bottom-row
// fill, the glyph sizes (15 → 20) and the spacebar basis all change at 402 too,
// by design — that is the simulator.png capture diff. And KEYBOARD_H stays
// correct ONLY at 402: the board is 146px at a 300px render and 104px at 212. It
// is inert today (keyboardChromeOn() is always false, so this cannot move a
// window); any future consumer must call keyboardHeightPx(measured, device).
//
// THE GRID: every key spans a number of the 10 letter COLUMNS, where spanning
// `n` columns means `n` key widths plus the `n − 1` gaps it swallows
// (keyWidthPx). A row whose spans sum to 10 is therefore EXACTLY as wide as the
// board's content box, which is what makes row 3 (1.5 + 7 + 1.5) and the bottom
// row (1.5 + 1 + 5 + 2.5, or + a 1-column hide key with the spacebar at 4)
// flush with row 1 on a real iPhone; the 9-key row 2
// sums to 9 and is inset by exactly half a key pitch on each side. The old
// `calc((100% - 54px) * n / 10)` basis charged every key 9 gaps regardless of
// how many its row actually had, so row 3 and the bottom row rendered 6px
// narrower than row 1 — visible as two rows inset inside a keyboard whose
// outer rows were flush.

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
import { sendInputEvent, type Room } from '../lib/livekit';

/** The three iOS keyboard layers. `letters` re-renders upper/lower per the live
 *  shift state; `numbers` (123) and `symbols` (#+=) are fixed-glyph. */
export type KeyboardLayer = 'letters' | 'numbers' | 'symbols';

/** Shift state for the letters layer (founder "exactly like a real iPhone"):
 *   - off    — next letter is lowercase.
 *   - once   — next letter is uppercase, then reverts to off (one-shot, the
 *              single tap).
 *   - locked — caps-lock: every letter uppercase until shift is tapped again
 *              (the double-tap within DOUBLE_TAP_MS). */
export type ShiftState = 'off' | 'once' | 'locked';

/** Double-tap window (ms) for shift → caps-lock, matching iOS's ~300ms. */
export const DOUBLE_TAP_MS = 300;

/**
 * Press-and-hold key-repeat cadence, matching iOS. Real iOS repeats ONLY the
 * delete key on hold (letters show an accent picker, space activates the cursor
 * trackpad), so this is wired to the delete key exclusively via FnKey's
 * `repeatOnHold`. Hold ~0.4s, then repeat starting slow and accelerating to a
 * floor — the same "deletes faster the longer you hold" feel as the device.
 */
export const KEY_REPEAT_INITIAL_MS = 400;
export const KEY_REPEAT_START_MS = 120;
export const KEY_REPEAT_MIN_MS = 40;
export const KEY_REPEAT_ACCEL_MS = 12;

/** The letter rows (lowercase canonical). Re-cased per shift state at render. */
const LETTER_ROWS: readonly (readonly string[])[] = [
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
];

/** The 123 (numbers) layer character rows. */
const NUMBER_ROWS: readonly (readonly string[])[] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['-', '/', ':', ';', '(', ')', '$', '&', '@', '"'],
  ['.', ',', '?', '!', "'"],
];

/** The #+= (symbols) layer character rows. */
const SYMBOL_ROWS: readonly (readonly string[])[] = [
  ['[', ']', '{', '}', '#', '%', '^', '*', '+', '='],
  ['_', '\\', '|', '~', '<', '>', '$', '€', '£', '•'],
  ['.', ',', '?', '!', "'"],
];

/** Keys per letter row on an iPhone: the unit EVERY key is measured in. */
export const KEY_COLUMNS = 10;

/** The device width the reference geometry below was measured at: the launch
 *  archetype's logical width (iphone-16-pro, SimulatorWindow DEVICE_LOGICAL_WIDTH). */
export const REF_DEVICE_WIDTH = 402;

/**
 * The reference geometry — the shipped 1:1 render at REF_DEVICE_WIDTH, read off
 * the file this replaces.
 *
 * ⛔ PROVENANCE, precisely, because the first version of this comment named a
 * vantage that cannot produce these numbers: the 402px-board figures (key
 * 34.39 × 42, gap 6, radius 5, fonts 22/15/13, board 200) were measured
 * 2026-09-12 in a 402px-wide TEST MOUNT of this component, NOT in the harness
 * scene. That scene renders a 300px board at a `width` prop of 300
 * (visual-harness/gallery.tsx), where the old rule gave a 24.2px key with a 2px
 * side padding — re-measured on the live harness 2026-09-12: data-kb-device 300,
 * scale 1.0000, key 24 × 42. 34.39 is the old basis at a 402px box with that 2px
 * padding; with this table's padX of 3 the same rule gives 34.2, which is what a
 * 402px board now renders. Every metric is this table × keyboardScale, so
 * `scale === 1` reproduces the reference exactly and a future correction to the
 * reference lands everywhere at once. It is OUR OWN previous render, not a
 * device measurement — see the header's "what is and is not device-verified".
 *
 * `glyphFont` is new: ⇧ / ⌫ / ⌄ / 😀 rendered at the 15px LABEL size, which on
 * iOS they are not — the shift and delete glyphs are drawn near the letter size.
 */
export const REF_GEOMETRY = {
  gap: 6,
  keyH: 42,
  radius: 5,
  padX: 3,
  padTop: 8,
  padBottom: 6,
  charFont: 22,
  glyphFont: 20,
  fnFont: 15,
  spaceFont: 13,
  bevel: 1,
} as const;

/**
 * Floors, in px, for the scaled metrics. ⛔ The font floors are a GATE
 * contract, not taste: scripts/gui-text-quality.mjs refuses any readable text
 * below MIN_PX = 9 and the simulator scene already has 50 leaves sitting exactly
 * on that floor, so there is zero headroom. A proportional 15px label is 7.9px
 * at a 212px board and a 13px one is 6.9px — both gate findings. MIN_TEXT_PX
 * keeps a 1px margin above the gate's floor, and ios-keyboard.test.tsx pins that
 * every font floor is ≥ MIN_TEXT_PX and that MIN_TEXT_PX > the gate's 9.
 */
export const MIN_TEXT_PX = 10;
export const MIN_GEOMETRY = {
  gap: 3,
  keyH: 18,
  radius: 2,
  padX: 1,
  padTop: 3,
  padBottom: 2,
  charFont: 12,
  glyphFont: 11,
  fnFont: MIN_TEXT_PX,
  spaceFont: MIN_TEXT_PX,
  bevel: 1,
} as const;

/** Scale clamp. The ceiling is the design rule (never larger than the real
 *  device's own keyboard — see the header); the floor only stops an absurd
 *  prop (a zero/stale logical width) from collapsing the board. */
export const SCALE_MIN = 0.3;
export const SCALE_MAX = 1;

/** Column spans. Sum to KEY_COLUMNS per row → the row is flush with the board's
 *  content box (see the header's GRID note). `flank` is shift/delete/#+=/123 on
 *  the last character row; iOS draws them at 1.5 letters. */
export const SPAN = {
  flank: 1.5,
  layerSwitch: 1.5,
  emoji: 1,
  dismiss: 1,
  return: 2.5,
} as const;

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);
const positive = (v: number | undefined, fallback: number): number =>
  v !== undefined && Number.isFinite(v) && v > 0 ? v : fallback;

/**
 * The render's zoom, capped at 1:1 — the single scalar every metric derives
 * from. `rendered` is the board's measured CSS width; `logical` is the device
 * width the video above is showing (the `width` prop).
 */
export function keyboardScale(rendered: number, logical = REF_DEVICE_WIDTH): number {
  const r = positive(rendered, REF_DEVICE_WIDTH);
  const l = positive(logical, REF_DEVICE_WIDTH);
  return clamp(r / l, SCALE_MIN, SCALE_MAX);
}

/** Every derived length on the board, in px. Pure — the guard measures this. */
export interface KeyboardMetrics {
  /** The board's width these metrics were derived for (border box, px). */
  width: number;
  /** The device's logical width the render is showing. */
  device: number;
  /** keyboardScale(width, device). */
  scale: number;
  gap: number;
  keyH: number;
  radius: number;
  padX: number;
  padTop: number;
  padBottom: number;
  charFont: number;
  glyphFont: number;
  fnFont: number;
  spaceFont: number;
  bevel: number;
  /** width − 2·padX: the box every row fills. */
  contentWidth: number;
  /** One column's key width (the 1-unit letter key). */
  unit: number;
  /** The board's total height: 4 rows + 3 row gaps + the two paddings. */
  height: number;
  /** Pop-up magnifier: height, corner radius, glyph size, and how far it
   *  overlaps the pressed key's top edge (its width is per-key — see KeyPlan). */
  popHeight: number;
  popRadius: number;
  popFont: number;
  popOverlap: number;
}

/** Ratios the pop-up balloon keeps to the KEY it rises from (iOS draws it wider
 *  and taller than the key, overlapping its top edge). Chosen so the reference
 *  render reproduces the shipped 44×48 balloon at 26px with its −44px top
 *  exactly — 34.39 is the measured key width that produced the shipped 44. */
const POP_W_RATIO = 44 / 34.39;
const POP_H_RATIO = 48 / 42;
const POP_FONT_RATIO = 26 / 22;
const POP_RADIUS_RATIO = 10 / 5;
const POP_OVERLAP_RATIO = 4 / 42;

const scaled = (ref: number, floor: number, scale: number): number =>
  Math.max(floor, Math.round(ref * scale));

/**
 * A glyph key's label may not exceed this share of its key's width — a
 * DEFENSIVE bound, and this comment states exactly how defensive it is.
 *
 * ⛔ Re-measured 2026-09-12, because the first version of this comment credited
 * the cap with preventing a clip it cannot prevent. The cap is INERT at every
 * (rendered, device) pair the APP mounts — every real archetype width, 390 / 393
 * / 402 / 874 — because glyphFont ≈ 0.0498 × board while 0.78 × unit ≈ 0.0667 ×
 * board, so it sits ABOVE the value it caps everywhere (212 → cap 14 vs glyph 11
 * · 300 → 20 vs 15 · 402 → 26 vs 20), and the browser-measured 😀 advance fits
 * its key with margin at each (14.0 in 18.1 · 21.0 in 24.0 · 22.0 in 34.2). What
 * actually keeps the emoji inside its key there is the BOARD FLOOR: the narrowest
 * box the simulator can mount is 212px (Tauri min_inner_size 280 − rail 48 −
 * bezel 20), whose 18.1px column carries the 11px floored glyph.
 *
 * It binds where the ZOOM is 1:1 on a board narrower than ~316px (unit < 25.6),
 * which no real iPhone is — and there is exactly one such render today, measured
 * on the live harness: the simulator SCENE, which declares a fictional 300pt
 * device at 1:1 (visual-harness/gallery.tsx `width={phoneW}`, phoneW = 300) and
 * so draws 😀 at 18px instead of 20. That is the scene's configuration, not the
 * app's. The cap is kept so a future narrower mount degrades by SHRINKING the
 * glyph instead of clipping it, and ios-keyboard.test.tsx renders it at a
 * sub-reachable width so the constant cannot rot back into a no-op.
 */
const GLYPH_FIT_RATIO = 0.78;

/** Derive every length from the board's rendered width + the device's logical
 *  width. `width` is the BORDER-BOX width of the board (padding included). */
export function keyboardMetrics(width: number, device = REF_DEVICE_WIDTH): KeyboardMetrics {
  const w = positive(width, REF_DEVICE_WIDTH);
  const d = positive(device, REF_DEVICE_WIDTH);
  const scale = keyboardScale(w, d);
  const gap = scaled(REF_GEOMETRY.gap, MIN_GEOMETRY.gap, scale);
  const keyH = scaled(REF_GEOMETRY.keyH, MIN_GEOMETRY.keyH, scale);
  const padX = scaled(REF_GEOMETRY.padX, MIN_GEOMETRY.padX, scale);
  const padTop = scaled(REF_GEOMETRY.padTop, MIN_GEOMETRY.padTop, scale);
  const padBottom = scaled(REF_GEOMETRY.padBottom, MIN_GEOMETRY.padBottom, scale);
  const charFont = scaled(REF_GEOMETRY.charFont, MIN_GEOMETRY.charFont, scale);
  // The content box can be driven negative by a pathological prop; a row of
  // zero-width keys is still a legal render, a NaN one is not.
  const contentWidth = Math.max(0, w - padX * 2);
  const unit = Math.max(0, (contentWidth - gap * (KEY_COLUMNS - 1)) / KEY_COLUMNS);
  return {
    width: w,
    device: d,
    scale,
    gap,
    keyH,
    radius: scaled(REF_GEOMETRY.radius, MIN_GEOMETRY.radius, scale),
    padX,
    padTop,
    padBottom,
    charFont,
    glyphFont: scaled(REF_GEOMETRY.glyphFont, MIN_GEOMETRY.glyphFont, scale),
    fnFont: scaled(REF_GEOMETRY.fnFont, MIN_GEOMETRY.fnFont, scale),
    spaceFont: scaled(REF_GEOMETRY.spaceFont, MIN_GEOMETRY.spaceFont, scale),
    bevel: scaled(REF_GEOMETRY.bevel, MIN_GEOMETRY.bevel, scale),
    contentWidth,
    unit,
    height: padTop + keyH * 4 + gap * 3 + padBottom,
    popHeight: Math.round(keyH * POP_H_RATIO),
    popRadius: Math.round(
      scaled(REF_GEOMETRY.radius, MIN_GEOMETRY.radius, scale) * POP_RADIUS_RATIO,
    ),
    popFont: Math.round(charFont * POP_FONT_RATIO),
    popOverlap: Math.round(keyH * POP_OVERLAP_RATIO),
  };
}

/** The board's total height for a given width — the same number KEYBOARD_H
 *  hard-codes for the reference width. Exported so a sizing site can ask. */
export function keyboardHeightPx(width: number, device = REF_DEVICE_WIDTH): number {
  return keyboardMetrics(width, device).height;
}

/**
 * The px width of a key spanning `span` of the 10 letter columns: `span` key
 * widths PLUS the `span − 1` gaps the key swallows. This is what makes a row
 * whose spans sum to 10 exactly `contentWidth` wide, whatever its key count.
 */
export function keyWidthPx(span: number, m: KeyboardMetrics): number {
  return Math.max(0, m.unit * span + m.gap * (span - 1));
}

export type KeyKind = 'char' | 'fn' | 'space' | 'return';

/** One key's geometry, in px, relative to the board's left edge. */
export interface KeyPlan {
  /** The PLAN's key identity: lowercase-canonical, stable across shift, and the
   *  key `keyboardPlan.byId` is keyed by. ⛔ It is NOT what the rendered
   *  `data-key` attribute holds for a character key — CharKey renders
   *  `data-key={label}`, the shift-CASED glyph, so a shifted board publishes
   *  `data-key="A"` (the test file resolves it exactly that way). `data-key-id`
   *  publishes THIS value: resolve by that in any instrument that may run with
   *  shift on, or it will miss every letter. */
  id: string;
  kind: KeyKind;
  span: number;
  width: number;
  left: number;
  /** Pop-up balloon width (char keys only, else 0). */
  popWidth: number;
  /** Horizontal nudge, px, that keeps this key's balloon inside the board. 0 for
   *  every interior key; positive at the left edge, negative at the right. */
  popDx: number;
}

export interface RowPlan {
  keys: KeyPlan[];
  /** Sum of the row's key widths + its gaps. */
  width: number;
  /** The row's left edge inside the board (justify-center). */
  left: number;
  /** Sum of the row's spans — 10 for a flush row, 9 for the inset `asdf` row. */
  spans: number;
}

export interface KeyboardPlan {
  metrics: KeyboardMetrics;
  rows: RowPlan[];
  byId: Map<string, KeyPlan>;
}

/**
 * A key's rendered flex basis, in px.
 *
 * ⛔ The fallback for an UNPLANNED key is one column, never 0. It used to be 0:
 * `plan?.width ?? 0` with `flexShrink: 1` meant a key the plan somehow had no
 * entry for rendered as an invisible zero-width key while the rest of the row
 * absorbed its space — nothing overflowed, so a board missing a key looked
 * exactly like a correct one (the old percentage basis at least always produced
 * a visible 1-unit key). One column is wrong in the LOUD direction instead: the
 * row over-fills, the fill invariant in ios-keyboard.test.tsx fails, and the
 * key's `data-key-span` attribute is absent — which the rendered-board arm
 * asserts is never the case for any key on any row.
 */
export function keyBasisPx(plan: KeyPlan | undefined, m: KeyboardMetrics): number {
  return plan === undefined ? m.unit : plan.width;
}

/**
 * The character span for one row. ⛔ V-2168: a row with NO flanks keeps every
 * key at ONE column (a real iPhone renders 10, 9 and 7 keys at the same width
 * and insets the short rows — stretching them was the clearest tell that this
 * was a web keyboard). A row WITH flanks stretches its characters to fill what
 * the flanks leave, which is what iOS does on the 123/#+= layers: their `. , ?
 * ! '` row is five visibly WIDER keys, not five letter-width keys floating in
 * the middle. For the letters layer this is (10 − 3)/7 = exactly 1, so the
 * uniform letter width is unchanged.
 */
export function charSpanForRow(count: number, flanks: number): number {
  if (count <= 0) return 1;
  if (flanks === 0) return 1;
  return (KEY_COLUMNS - flanks * SPAN.flank) / count;
}

/** The flank on a layer's last character row: shift on letters, the other
 *  layer switch on numbers/symbols (iOS puts #+= / 123 exactly there). */
export function flankId(layer: KeyboardLayer): string {
  return layer === 'letters' ? '⇧' : layer === 'numbers' ? '#+=' : '123';
}

const charRowsFor = (layer: KeyboardLayer): readonly (readonly string[])[] =>
  layer === 'letters' ? LETTER_ROWS : layer === 'numbers' ? NUMBER_ROWS : SYMBOL_ROWS;

/**
 * The whole board's geometry: every key of every row with its px width, its px
 * left edge and its balloon nudge. One pure function, so the unit guard measures
 * exactly what renders (the old basis string and the `gap-[6px]` class were two
 * unlinked copies of the same 6, and nothing pinned that they agreed).
 */
export function keyboardPlan(opts: {
  layer: KeyboardLayer;
  width: number;
  device?: number;
  hasDismiss?: boolean;
}): KeyboardPlan {
  const m = keyboardMetrics(opts.width, opts.device);
  const charRows = charRowsFor(opts.layer);
  const rowSpecs: { id: string; kind: KeyKind; span: number }[][] = [];

  charRows.forEach((row, rowIndex) => {
    const isLast = rowIndex === charRows.length - 1;
    const flanks = isLast ? 2 : 0;
    const span = charSpanForRow(row.length, flanks);
    const keys: { id: string; kind: KeyKind; span: number }[] = row.map((ch) => ({
      id: ch,
      kind: 'char',
      span,
    }));
    if (isLast) {
      keys.unshift({ id: flankId(opts.layer), kind: 'fn', span: SPAN.flank });
      keys.push({ id: '⌫', kind: 'fn', span: SPAN.flank });
    }
    rowSpecs.push(keys);
  });

  // Bottom row: layer switch · emoji · (hide) · space · return. The spans sum to
  // KEY_COLUMNS, so space simply takes what the others leave — the spacebar is
  // ON the grid rather than a flexGrow:5 share of a remainder that changed with
  // the width (measured drift before this: space/letter 2.74u → 4.47u, +63%,
  // across 874 → 212 while return/letter held at ~2.45u).
  const dismiss = opts.hasDismiss === true;
  const spaceSpan =
    KEY_COLUMNS - SPAN.layerSwitch - SPAN.emoji - SPAN.return - (dismiss ? SPAN.dismiss : 0);
  const bottom: { id: string; kind: KeyKind; span: number }[] = [
    { id: opts.layer === 'letters' ? '123' : 'ABC', kind: 'fn', span: SPAN.layerSwitch },
    { id: '😀', kind: 'fn', span: SPAN.emoji },
  ];
  if (dismiss) bottom.push({ id: '⌄', kind: 'fn', span: SPAN.dismiss });
  bottom.push({ id: 'space', kind: 'space', span: spaceSpan });
  bottom.push({ id: 'return', kind: 'return', span: SPAN.return });
  rowSpecs.push(bottom);

  const rows: RowPlan[] = rowSpecs.map((specs) => {
    const widths = specs.map((s) => keyWidthPx(s.span, m));
    const rowWidth = widths.reduce((a, b) => a + b, 0) + m.gap * Math.max(0, specs.length - 1);
    const rowLeft = m.padX + (m.contentWidth - rowWidth) / 2;
    let x = rowLeft;
    const keys: KeyPlan[] = specs.map((s, i) => {
      const width = widths[i] ?? 0;
      const popWidth = s.kind === 'char' ? Math.round(width * POP_W_RATIO) : 0;
      // Edge clamp — the balloon is centred on the key and is WIDER than it, so
      // on the first/last key of a row it hung off the board (measured: 2.8px
      // over the left edge even at the default 402, 12.3px at 212). Real iOS
      // shifts the row-end balloons inward; this is that shift, and it is 0 for
      // every interior key.
      const desiredLeft = x + width / 2 - popWidth / 2;
      const clampedLeft = clamp(desiredLeft, 0, Math.max(0, m.width - popWidth));
      const key: KeyPlan = {
        id: s.id,
        kind: s.kind,
        span: s.span,
        width,
        left: x,
        popWidth,
        popDx: s.kind === 'char' ? clampedLeft - desiredLeft : 0,
      };
      x += width + m.gap;
      return key;
    });
    return {
      keys,
      width: rowWidth,
      left: rowLeft,
      spans: specs.reduce((a, s) => a + s.span, 0),
    };
  });

  const byId = new Map<string, KeyPlan>();
  for (const row of rows) for (const key of row.keys) byId.set(key.id, key);
  return { metrics: m, rows, byId };
}

/** Apply the live shift state to a letter (numbers/symbols pass through). */
export function applyShift(ch: string, shift: ShiftState): string {
  if (shift === 'off') return ch;
  // Uppercase only affects letters; iOS numbers/symbols don't shift-case.
  return ch.toUpperCase();
}

/** Resolve the `key` string an on-screen key sends, given the live shift state.
 *  Letters honor shift (a→A); every other character is verbatim. Exported so the
 *  unit tests can pin the cased-key contract without a DOM. */
export function keyForChar(ch: string, shift: ShiftState): string {
  return applyShift(ch, shift);
}

/**
 * The two palettes, as CSS custom properties on the board.
 *
 * ⛔ LIGHT IS THE DEFAULT AND IS NOT A THEME. Device-screen content uses FIXED
 * colours, never the app's theme tokens (the rule is written at
 * visual-harness/gallery.tsx ~1953): a web page inside a device looks the same
 * whichever theme the desktop app is in, and the text-quality gate measures both
 * themes. A real iPhone keyboard follows the PAGE's colour scheme — which is a
 * fact we do not have: `PageState` (ControlClient.swift) carries no page or
 * device colour scheme, so there is nothing on the wire to drive it. Painting
 * this keyboard dark because the desktop app is dark would be an
 * iPhone-INFIDELITY dressed as a fix. So the dark palette exists, is correct,
 * and is reachable ONLY through the explicit `colorScheme` prop — the day the
 * harness publishes a scheme, SimulatorWindow passes it and nothing else here
 * changes. There is deliberately no Tailwind `dark:` variant in this file
 * (ios-keyboard.test.tsx pins that, because a `dark:` class is exactly how this
 * would silently start following the app theme).
 *
 * Light is the shipped iOS-light palette, unchanged. Dark approximates the iOS
 * dark keyboard: a near-black board, mid-grey character keys, darker function
 * keys, white ink.
 *
 * ⛔ PRESS DIRECTION, stated per key CLASS, because the one-line rule "a pressed
 * function key goes LIGHTER" was wrong for one of them. A key darker than the
 * board (every grey function key) flashes LIGHTER; a key at or near WHITE
 * cannot, and flashes slightly DARKER instead — which is what charBg →
 * charPressed already did on the light keyboard. With ONE pressed colour serving
 * both classes the caps-LOCKED shift read wrong in both schemes: light gave no
 * feedback at all (fnLocked and fnPressed were both #ffffff) and dark went
 * markedly darker (#f2f2f7 pressed to #6e6e73, leaving dark ink on mid grey),
 * because `.active\:bg-…:active` outranks the locked fill. Hence
 * fnLockedPressed, and ios-keyboard.test.tsx pins the DIRECTION by relative
 * luminance — `not.toBe(fnBg)`, which is what it pinned before, passes happily
 * on a value that goes the wrong way.
 */
export interface KeyboardPalette {
  board: string;
  charBg: string;
  charPressed: string;
  charInk: string;
  fnBg: string;
  fnPressed: string;
  fnActive: string;
  fnLocked: string;
  /** The pressed colour for the caps-LOCKED shift only. It is a near-white key,
   *  so it darkens on press; every grey function key lightens. */
  fnLockedPressed: string;
  fnInk: string;
  fnLockedInk: string;
  accent: string;
  accentInk: string;
  bevel: string;
  popBg: string;
  popInk: string;
  popShadow: string;
}

export const KEYBOARD_PALETTES: Record<'light' | 'dark', KeyboardPalette> = {
  light: {
    board: '#d1d4db',
    charBg: '#ffffff',
    charPressed: '#e6e7ea',
    charInk: '#1c1c1e',
    fnBg: '#aeb3bd',
    fnPressed: '#ffffff',
    fnActive: '#e9ebef',
    fnLocked: '#ffffff',
    // The white-key press iOS shows — the same grey charPressed uses, because
    // the locked shift IS a white key.
    fnLockedPressed: '#e6e7ea',
    fnInk: '#1c1c1e',
    fnLockedInk: '#1c1c1e',
    accent: '#0a84ff',
    accentInk: '#ffffff',
    bevel: 'rgba(0,0,0,0.3)',
    popBg: '#ffffff',
    popInk: '#1c1c1e',
    popShadow: 'rgba(0,0,0,0.35)',
  },
  dark: {
    board: '#1c1c1e',
    charBg: '#6e6e73',
    charPressed: '#8e8e93',
    charInk: '#ffffff',
    fnBg: '#48484a',
    fnPressed: '#6e6e73',
    fnActive: '#5a5a5e',
    fnLocked: '#f2f2f7',
    fnLockedPressed: '#d1d1d6',
    fnInk: '#ffffff',
    fnLockedInk: '#1c1c1e',
    accent: '#0a84ff',
    accentInk: '#ffffff',
    bevel: 'rgba(0,0,0,0.45)',
    popBg: '#6e6e73',
    popInk: '#ffffff',
    popShadow: 'rgba(0,0,0,0.5)',
  },
};

/** Props for the on-screen keyboard. */
export interface IOSKeyboardProps {
  /** The LiveKit room — null until connected. Key events are a no-op without it
   *  (mirrors the host-keyboard path, which sends nothing without a room). */
  room: Room | null;
  /** The archetype's logical CSS-px width (e.g. iphone16pro = 402). NOT the
   *  width this board renders at — see the header: it is the DEVICE width the
   *  video above is showing, and the ratio between it and the board's measured
   *  width is the render's zoom, which is what every metric scales by. Defaults
   *  to 402. */
  width?: number;
  /** Hide affordance — a "dismiss keyboard" control inside the keyboard (the iOS
   *  keyboard has no close button, but the simulator's toggle owns show/hide; we
   *  expose an optional collapse so the panel can wire its toolbar toggle to it).
   *  Optional — when omitted, no dismiss row is rendered. */
  onDismiss?: () => void;
  /** Captured manual-control epoch; changes cancel any held repeat chain. */
  authorityEpoch?: number;
  /** Exact invocation-time Room/epoch proof. Omission is fail-closed. */
  canSendInput?: (room: Room, authorityEpoch: number) => boolean;
  /** The PAGE's colour scheme, when we ever learn it. Defaults to light and must
   *  NEVER be wired to the desktop app's theme — see KEYBOARD_PALETTES. */
  colorScheme?: 'light' | 'dark';
}

/** Fire a real keypress: keyDown then keyUp with the SAME `key` (mirrors the
 *  host path — a keypress is down-then-up). Fire-and-forget. No-op without a room.
 *
 *  MUST .catch every send: sendInputEvent only swallows BENIGN teardown races
 *  (isBenignTeardownError — "PC manager is closed" etc.), but a keypress landing
 *  mid-RECONNECT rejects with "Publisher connection not set" / "could not
 *  establish Publisher connection" which are NOT benign-matched → re-thrown. An
 *  uncaught reject on this `void` call reaches the global unhandledrejection
 *  backstop, which (its regex is narrower still) paints the fatal overlay over
 *  the borderless simulator → undraggable black box → force-quit (the exact
 *  2026-06-18 incident). A dropped keystroke during a reconnect is acceptable
 *  (the founder retypes; the input-capture path owns the dead-channel badge), so
 *  swallow here rather than widening the shared benign-teardown allowlist (which
 *  input-capture relies on re-throwing to surface a genuinely dead channel). */
function pressKey(
  room: Room | null,
  key: string,
  authorityEpoch: number,
  canSendInput?: (room: Room, authorityEpoch: number) => boolean,
): void {
  if (room === null || canSendInput === undefined || !canSendInput(room, authorityEpoch)) return;
  // Promise.resolve wraps the call so .catch is safe even if sendInputEvent is
  // mocked to return a non-Promise (matches livekit-latency-ping's guard).
  void Promise.resolve(sendInputEvent(room, { type: 'keyDown', key })).catch(() => undefined);
  if (!canSendInput(room, authorityEpoch)) return;
  void Promise.resolve(sendInputEvent(room, { type: 'keyUp', key })).catch(() => undefined);
}

/**
 * The on-screen iOS keyboard. Renders the active layer, manages GUI-local shift
 * state, and emits keyDown/keyUp InputEvents over the LiveKit room exactly like
 * the host-keyboard path.
 */
export function IOSKeyboard({
  room,
  width = REF_DEVICE_WIDTH,
  onDismiss,
  authorityEpoch = 0,
  canSendInput,
  colorScheme = 'light',
}: IOSKeyboardProps): JSX.Element {
  const [layer, setLayer] = useState<KeyboardLayer>('letters');
  const [shift, setShift] = useState<ShiftState>('off');
  // The currently-pressed CHARACTER key for the iOS pop-up magnifier: its stable
  // button IDENTITY (`ch`, layer-relative, shift-independent) + the cased GLYPH to
  // show in the balloon, both captured at press. Keyed by identity — NOT the
  // shift-cased `sent` value — because a one-shot-shift press consumes the shift
  // in the same render, so a sent-value match ('Q' set at press vs a recomputed
  // 'q' at render) went false and the balloon never appeared for a shifted
  // letter. The frozen glyph keeps the balloon showing the UPPERCASE letter even
  // after the shift reverts. Function keys get a press highlight, not a pop-up.
  const [poppedKey, setPoppedKey] = useState<{ id: string; glyph: string } | null>(null);
  // Last shift-tap timestamp, for the double-tap → caps-lock detection.
  const lastShiftTap = useRef(0);
  // ⛔ The board's own RENDERED width, which is NOT the `width` prop (header).
  // null until measured — then every metric follows the box the customer is
  // actually looking at, which is what makes the scaling correct at a window
  // width the archetype never mentions. `data-kb-source` reports which of the
  // two is in force, so a run where the measurement never happened is visible
  // rather than silently falling back to the prop forever.
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [measuredWidth, setMeasuredWidth] = useState<number | null>(null);
  useLayoutEffect(() => {
    const node = boardRef.current;
    if (node === null || typeof ResizeObserver === 'undefined') return undefined;
    // ⛔ BORDER box, never contentRect: contentRect excludes the padding, and the
    // padding is itself derived from the width — feeding contentRect back in
    // would converge on a board 2·padX too narrow, every frame.
    const readWidth = (entry?: ResizeObserverEntry): number => {
      const sizes = entry === undefined ? undefined : entry.borderBoxSize;
      const box = sizes !== undefined && sizes.length > 0 ? sizes[0]?.inlineSize : undefined;
      return box !== undefined && box > 0 ? box : node.getBoundingClientRect().width;
    };
    const apply = (next: number): void => {
      if (!Number.isFinite(next) || next <= 0) return;
      const rounded = Math.round(next);
      setMeasuredWidth((prev) => (prev === rounded ? prev : rounded));
    };
    apply(readWidth());
    const observer = new ResizeObserver((entries) => {
      apply(readWidth(entries[0]));
    });
    observer.observe(node);
    return () => {
      observer.disconnect();
    };
  }, []);

  const ownsAuthority = useCallback(
    (): boolean =>
      room !== null && canSendInput !== undefined && canSendInput(room, authorityEpoch),
    [room, canSendInput, authorityEpoch],
  );
  useEffect(() => {
    // Layer/shift/popover state belongs to one exact control epoch. An old local-only
    // Shift/123 handler must not influence the next valid key under a new owner.
    setLayer('letters');
    setShift('off');
    setPoppedKey(null);
    lastShiftTap.current = 0;
  }, [authorityEpoch, room]);

  // Send a character keypress, honoring shift, then consume a one-shot shift.
  const onCharPress = useCallback(
    (ch: string): void => {
      if (!ownsAuthority()) return;
      const key = keyForChar(ch, layer === 'letters' ? shift : 'off');
      pressKey(room, key, authorityEpoch, canSendInput);
      // A non-shift keypress BREAKS the shift double-tap sequence: caps-lock is
      // "two shift taps IN A ROW". Without clearing this, fast-typing an acronym
      // like "AB" (shift → a → shift, all within 300ms) had the second shift see
      // the FIRST shift's timestamp still within the window and falsely engage
      // caps-lock. Reset it so only two CONSECUTIVE shift taps lock. (Fable GUI
      // re-audit 2026-07-02.)
      lastShiftTap.current = 0;
      // One-shot shift reverts after a single letter (iOS); caps-lock persists.
      if (layer === 'letters' && shift === 'once') setShift('off');
    },
    [room, layer, shift, authorityEpoch, canSendInput, ownsAuthority],
  );

  // Shift: single tap toggles one-shot on/off; a second tap within DOUBLE_TAP_MS
  // engages caps-lock; tapping while locked releases it. GUI-local — no event is
  // sent for the shift tap itself.
  const onShiftTap = useCallback((): void => {
    if (!ownsAuthority()) return;
    const now = Date.now();
    const isDouble = now - lastShiftTap.current <= DOUBLE_TAP_MS;
    setShift((prev) => {
      // A tap that RELEASES caps-lock must NOT seed the double-tap window: it is
      // the end of a sequence, not the start of one. Otherwise unlock → quick
      // shift tap (intending one-shot) sees this timestamp within 300ms and
      // isDouble re-engages caps-lock. Mirror onCharPress's reset-to-0. (Fable
      // GUI re-audit fix.)
      lastShiftTap.current = prev === 'locked' ? 0 : now;
      if (prev === 'locked') return 'off';
      if (isDouble) return 'locked';
      return prev === 'once' ? 'off' : 'once';
    });
  }, [ownsAuthority]);

  // Named keys mirror the host path's `e.key` values exactly. Each is a NON-shift
  // keypress, so it must BREAK the shift double-tap sequence (mirror onCharPress's
  // `lastShiftTap.current = 0`): without this reset, a fast
  // shift → space/return/delete → shift within DOUBLE_TAP_MS lets the SECOND shift see
  // the FIRST shift's timestamp still inside the window and falsely engage caps-lock
  // (e.g. shift → space → shift wrongly LOCKS instead of arming a one-shot). Only
  // char presses reset it before; these named keys did not. (Keyboard audit w8cp0yp5d
  // 2026-07-11.)
  const onReturn = useCallback((): void => {
    if (!ownsAuthority()) return;
    lastShiftTap.current = 0;
    pressKey(room, 'Enter', authorityEpoch, canSendInput);
  }, [room, authorityEpoch, canSendInput, ownsAuthority]);
  const onDelete = useCallback((): void => {
    if (!ownsAuthority()) return;
    lastShiftTap.current = 0;
    pressKey(room, 'Backspace', authorityEpoch, canSendInput);
  }, [room, authorityEpoch, canSendInput, ownsAuthority]);
  const onSpace = useCallback((): void => {
    if (!ownsAuthority()) return;
    lastShiftTap.current = 0;
    pressKey(room, ' ', authorityEpoch, canSendInput);
  }, [room, authorityEpoch, canSendInput, ownsAuthority]);
  const selectLayer = useCallback(
    (next: KeyboardLayer): void => {
      if (ownsAuthority()) setLayer(next);
    },
    [ownsAuthority],
  );

  const charRows = charRowsFor(layer);
  const hasDismiss = onDismiss !== undefined;
  const plan = keyboardPlan({
    layer,
    width: measuredWidth ?? width,
    device: width,
    hasDismiss,
  });
  const m = plan.metrics;
  const palette = KEYBOARD_PALETTES[colorScheme];
  // Geometry AND palette as CSS custom properties: one source for both, and the
  // press states stay real CSS `:active` rules (a React "pressed" state would
  // lag the finger) without a single hard-coded colour in a class string.
  const boardStyle: CSSProperties & Record<string, string | number> = {
    paddingLeft: m.padX,
    paddingRight: m.padX,
    paddingTop: m.padTop,
    paddingBottom: m.padBottom,
    rowGap: m.gap,
    background: 'var(--kb-board)',
    '--kb-board': palette.board,
    '--kb-char-bg': palette.charBg,
    '--kb-char-press': palette.charPressed,
    '--kb-char-ink': palette.charInk,
    '--kb-fn-bg': palette.fnBg,
    '--kb-fn-press': palette.fnPressed,
    '--kb-fn-active': palette.fnActive,
    '--kb-fn-locked': palette.fnLocked,
    '--kb-fn-locked-press': palette.fnLockedPressed,
    '--kb-fn-ink': palette.fnInk,
    '--kb-fn-locked-ink': palette.fnLockedInk,
    '--kb-accent': palette.accent,
    '--kb-accent-ink': palette.accentInk,
    '--kb-pop-bg': palette.popBg,
    '--kb-pop-ink': palette.popInk,
  };
  const bevel = `0 ${String(m.bevel)}px 0 ${palette.bevel}`;
  const keyOf = (id: string): KeyPlan | undefined => plan.byId.get(id);
  /** The bottom row is the last row of the plan, after the character rows. */
  const bottomSpans = plan.rows[charRows.length]?.spans;

  return (
    <div
      ref={boardRef}
      data-component="ios-keyboard"
      data-layer={layer}
      data-shift={shift}
      data-kb-scheme={colorScheme}
      // The geometry this render committed to, so the browser-side gate can
      // check the RENDERED box against the number the pure function produced
      // (a derived value nobody measures is just a comment).
      data-kb-width={String(m.width)}
      data-kb-device={String(m.device)}
      data-kb-scale={m.scale.toFixed(4)}
      data-kb-height={String(m.height)}
      data-kb-source={measuredWidth === null ? 'prop' : 'measured'}
      // Light iOS keyboard background. pointer-events stay on (it's the keyboard);
      // it sits BELOW the video as chrome, so it doesn't intercept video taps.
      className="flex w-full select-none flex-col"
      style={boardStyle}
      // Keep window-drag off the keyboard (its keys must receive presses).
      data-tauri-drag-region="false"
    >
      {/* Character rows.
          ⛔ V-2168 — the letter keys are a UNIFORM WIDTH across every row, and
          short rows are INSET by the leftover space. A real iPhone keeps one
          key size and centres the shorter rows; `justify-center` + a fixed
          per-span width reproduces the real inset without hand-positioning
          anything. Row 3 is flanked by shift (left) and delete (right) at the
          iOS 1.5-unit width, and its spans sum to 10 — so unlike before it is
          FLUSH with row 1 instead of 6px narrower. */}
      {charRows.map((row, rowIndex) => {
        const isLastCharRow = rowIndex === charRows.length - 1;
        const rowPlan = plan.rows[rowIndex];
        return (
          <div
            key={rowIndex}
            data-kb-row={String(rowIndex)}
            data-kb-row-spans={rowPlan === undefined ? undefined : String(rowPlan.spans)}
            className="flex w-full items-stretch justify-center"
            style={{ columnGap: m.gap }}
          >
            {/* Row 3 left flank: shift (letters) / #+= (numbers) / 123 (symbols). */}
            {isLastCharRow && layer === 'letters' && (
              <FnKey
                label="⇧"
                ariaLabel={shift === 'locked' ? 'Caps lock on' : 'Shift'}
                plan={keyOf('⇧')}
                metrics={m}
                bevel={bevel}
                glyph
                active={shift !== 'off'}
                locked={shift === 'locked'}
                onPress={onShiftTap}
              />
            )}
            {isLastCharRow && layer === 'numbers' && (
              <FnKey
                label="#+="
                ariaLabel="Symbols"
                plan={keyOf('#+=')}
                metrics={m}
                bevel={bevel}
                onPress={() => selectLayer('symbols')}
              />
            )}
            {isLastCharRow && layer === 'symbols' && (
              <FnKey
                label="123"
                ariaLabel="Numbers"
                plan={keyOf('123')}
                metrics={m}
                bevel={bevel}
                onPress={() => selectLayer('numbers')}
              />
            )}

            {row.map((ch) => {
              const shown = layer === 'letters' ? applyShift(ch, shift) : ch;
              return (
                <CharKey
                  key={ch}
                  label={shown}
                  plan={keyOf(ch)}
                  metrics={m}
                  bevel={bevel}
                  popShadow={palette.popShadow}
                  popped={poppedKey?.id === ch}
                  popLabel={poppedKey?.id === ch ? poppedKey.glyph : shown}
                  onDown={() => {
                    if (!ownsAuthority()) return;
                    setPoppedKey({ id: ch, glyph: shown });
                    onCharPress(ch);
                  }}
                  onUp={() => {
                    if (ownsAuthority()) setPoppedKey(null);
                  }}
                />
              );
            })}

            {/* Row 3 right flank: delete on every layer's last char row. */}
            {isLastCharRow && (
              <FnKey
                label="⌫"
                ariaLabel="Delete"
                plan={keyOf('⌫')}
                metrics={m}
                bevel={bevel}
                glyph
                onPress={onDelete}
                repeatOnHold
                authorityEpoch={authorityEpoch}
                canRepeat={ownsAuthority}
              />
            )}
          </div>
        );
      })}

      {/* Bottom row: 123/ABC layer switch · 😀 emoji · space (widest) · return.
          Every key is on the same column grid as the letters above (spans summing
          to 10), so the row is flush and the space/return ratio no longer drifts
          with the board width. */}
      <div
        data-kb-row={String(charRows.length)}
        data-kb-row-spans={bottomSpans === undefined ? undefined : String(bottomSpans)}
        className="flex w-full items-stretch justify-center"
        style={{ columnGap: m.gap }}
      >
        {layer === 'letters' ? (
          <FnKey
            label="123"
            ariaLabel="Numbers and symbols"
            plan={keyOf('123')}
            metrics={m}
            bevel={bevel}
            onPress={() => selectLayer('numbers')}
          />
        ) : (
          <FnKey
            label="ABC"
            ariaLabel="Letters"
            plan={keyOf('ABC')}
            metrics={m}
            bevel={bevel}
            onPress={() => selectLayer('letters')}
          />
        )}
        {/* iOS bottom-row emoji key, left of the spacebar. The default single-
            keyboard iPhone shows 😀 here (the 🌐 globe appears only with ≥2
            keyboards installed). There is no emoji panel and inserting an emoji
            via a synthetic `key` event isn't how iOS does it (it would be a
            fingerprint divergence), so this stays a no-op. Rendered `disabled`
            so it reads as inactive (dimmed, no press flash) instead of a working
            key that flashes but does nothing — a dead key that invites a tap is
            worse than an obviously-inert one. */}
        <FnKey
          label="😀"
          ariaLabel="Emoji"
          plan={keyOf('😀')}
          metrics={m}
          bevel={bevel}
          glyph
          onPress={() => {}}
          disabled
        />
        {onDismiss !== undefined && (
          <FnKey
            label="⌄"
            ariaLabel="Hide keyboard"
            plan={keyOf('⌄')}
            metrics={m}
            bevel={bevel}
            glyph
            onPress={() => {
              if (ownsAuthority()) onDismiss();
            }}
          />
        )}
        <button
          type="button"
          aria-label="Space"
          data-key="space"
          data-key-kind="space"
          data-key-span={keyOf('space')?.span.toString()}
          onPointerDown={(e) => {
            e.preventDefault();
            onSpace();
          }}
          // min-w-0 + a span width, like every other key: the spacebar used to be
          // the ONE key with `flexBasis: auto` and no min-width, so at a narrow
          // board its min-content ("space" at 13px) refused to shrink and the
          // whole bottom row overflowed (measured at 212: scrollW 210 > clientW
          // 208). shrink absorbs a stale measured width instead of overflowing.
          className="min-w-0 shrink bg-[var(--kb-char-bg)] leading-none text-[color:var(--kb-char-ink)] transition-colors active:bg-[var(--kb-char-press)]"
          style={{
            height: m.keyH,
            flexGrow: 0,
            flexShrink: 1,
            flexBasis: `${String(keyBasisPx(keyOf('space'), m))}px`,
            borderRadius: m.radius,
            fontSize: m.spaceFont,
            boxShadow: bevel,
          }}
        >
          space
        </button>
        <FnKey
          label="return"
          ariaLabel="Return"
          plan={keyOf('return')}
          metrics={m}
          bevel={bevel}
          onPress={onReturn}
        />
      </div>
    </div>
  );
}

/** A white character key with the iOS press pop-up magnifier. pointerdown drives
 *  the keypress (iOS registers on press, not release) + shows the pop-up; release
 *  dismisses it. */
function CharKey({
  label,
  plan,
  metrics,
  bevel,
  popShadow,
  popped,
  popLabel,
  onDown,
  onUp,
}: {
  label: string;
  /** This key's geometry from keyboardPlan — width, and the balloon's edge nudge. */
  plan: KeyPlan | undefined;
  metrics: KeyboardMetrics;
  bevel: string;
  popShadow: string;
  popped: boolean;
  /** Glyph shown in the pop-up balloon — frozen at press so a one-shot-shift
   *  letter's balloon stays uppercase after the shift reverts. Defaults to label. */
  popLabel?: string;
  onDown: () => void;
  onUp: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      data-key={label}
      // The stable, shift-independent identity beside the CASED glyph `data-key`
      // publishes (a shifted board renders data-key="A") — see KeyPlan.id.
      data-key-id={plan?.id}
      data-key-kind="char"
      data-key-span={plan?.span.toString()}
      // The balloon's own box, published on the KEY: the pop-up only exists in
      // the DOM while a key is held under confirmed manual authority, so a
      // browser-side gate can never measure one (room=null ⇒ no press state).
      // These two let it check the balloon's geometry against the rendered key
      // rect without the press — the same method the 2026-09-12 measurement used
      // to find it hanging off the board at every width, except the numbers now
      // come from the component instead of from the gate's own copy of the CSS.
      data-pop-dx={plan === undefined ? undefined : plan.popDx.toFixed(2)}
      data-pop-w={plan === undefined ? undefined : String(plan.popWidth)}
      aria-label={label}
      onPointerDown={(e) => {
        // Prevent the press from stealing focus / starting a window drag.
        e.preventDefault();
        onDown();
      }}
      onPointerUp={onUp}
      onPointerLeave={onUp}
      onPointerCancel={onUp}
      className="relative min-w-0 shrink bg-[var(--kb-char-bg)] font-normal leading-none text-[color:var(--kb-char-ink)] transition-colors active:bg-[var(--kb-char-press)]"
      // One column of the 10-column grid — see keyboardPlan. The glyph is the
      // reference 22px at 1:1 (17px read as a compact web keyboard rather than
      // the device's) and scales with the render's zoom, floored at
      // MIN_GEOMETRY.charFont so it can never sink under the text-quality gate.
      style={{
        flexGrow: 0,
        flexShrink: 1,
        flexBasis: `${String(keyBasisPx(plan, metrics))}px`,
        height: metrics.keyH,
        borderRadius: metrics.radius,
        fontSize: metrics.charFont,
        boxShadow: bevel,
      }}
    >
      {label}
      {/* iOS key pop-up magnifier — the enlarged glyph balloon above the pressed
          key. Character keys only (no pop-up for function keys), matching iOS.
          `popDx` shifts the row-end balloons back inside the board (they used to
          hang off it at EVERY width, 2.8px even at the default 402). */}
      {popped && (
        <span
          data-component="key-popup"
          aria-hidden="true"
          className="pointer-events-none absolute left-1/2 z-30 flex items-center justify-center bg-[var(--kb-pop-bg)] leading-none text-[color:var(--kb-pop-ink)]"
          style={{
            width: plan?.popWidth ?? metrics.unit,
            height: metrics.popHeight,
            top: -(metrics.popHeight - metrics.popOverlap),
            borderRadius: metrics.popRadius,
            fontSize: metrics.popFont,
            transform: `translateX(calc(-50% + ${String(plan?.popDx ?? 0)}px))`,
            boxShadow: `0 ${String(Math.max(1, metrics.bevel * 3))}px ${String(
              Math.max(2, metrics.bevel * 8),
            )}px ${popShadow}`,
          }}
        >
          {popLabel ?? label}
        </span>
      )}
    </button>
  );
}

/** A grey function key (shift/delete/123/ABC/#+=/emoji/hide/return). No pop-up
 *  magnifier (iOS shows it for character keys only). `glyph` picks the larger
 *  glyph size iOS draws ⇧ / ⌫ / 😀 at, rather than the label size. `accent`
 *  paints a key blue — currently unused (return is grey by default like real iOS
 *  on a generic field); reserved for the future enterkeyhint Go/Search/Send
 *  signal that re-enables the blue return. */
function FnKey({
  label,
  ariaLabel,
  plan,
  metrics,
  bevel,
  onPress,
  glyph,
  accent,
  active,
  locked,
  disabled,
  repeatOnHold,
  authorityEpoch = 0,
  canRepeat,
}: {
  label: string;
  ariaLabel: string;
  /** This key's geometry from keyboardPlan. */
  plan: KeyPlan | undefined;
  metrics: KeyboardMetrics;
  bevel: string;
  onPress: () => void;
  /** Draw the label at the iOS glyph size (⇧ ⌫ ⌄ 😀) instead of the label size. */
  glyph?: boolean;
  accent?: boolean;
  active?: boolean;
  locked?: boolean;
  /** Render the key inert: dimmed, no press flash, not interactive. Used for
   *  keys present for iPhone-faithful layout that have no backing action yet
   *  (the bottom-row emoji key) so they don't invite a tap that does nothing. */
  disabled?: boolean;
  /** iPhone-faithful press-and-hold repeat. Only the delete key sets this: hold
   *  fires onPress once immediately, then repeats at an accelerating cadence
   *  until pointer up/leave/cancel (or unmount). Letters/space must NOT set it
   *  (real iOS shows an accent picker / cursor trackpad there instead). */
  repeatOnHold?: boolean;
  /** Cancels a repeat admitted under a replaced manual-control epoch. */
  authorityEpoch?: number;
  /** Exact epoch predicate captured by the pointerdown that owns this repeat. */
  canRepeat?: () => boolean;
}): JSX.Element {
  // Held-repeat timer. Kept in a ref so pointer up/leave/cancel and unmount can
  // all cancel the same in-flight timeout chain.
  const repeatTimerRef = useRef<number | null>(null);
  const stopRepeat = useCallback((): void => {
    if (repeatTimerRef.current !== null) {
      window.clearTimeout(repeatTimerRef.current);
      repeatTimerRef.current = null;
    }
  }, []);

  const beginRepeat = useCallback((): void => {
    // Cancel any in-flight repeat chain before arming a new one. A second
    // pointerdown without an intervening pointerup (stray second pointer, pen+
    // touch, synthetic replay) would otherwise leave the FIRST tick() chain
    // orphaned: repeatTimerRef only tracks the latest timeout, so the eventual
    // stopRepeat cancels only the second chain and the first keeps firing
    // Backspace forever. Exactly one live chain per key. (Fable GUI re-audit fix.)
    stopRepeat();
    let interval = KEY_REPEAT_START_MS;
    const tick = (): void => {
      if (canRepeat === undefined || !canRepeat()) {
        stopRepeat();
        return;
      }
      // Capture the exact epoch's handler. A newer render must never lend its
      // Room/authority to an older retained pointerdown timer.
      onPress();
      if (!canRepeat()) {
        stopRepeat();
        return;
      }
      interval = Math.max(KEY_REPEAT_MIN_MS, interval - KEY_REPEAT_ACCEL_MS);
      repeatTimerRef.current = window.setTimeout(tick, interval);
    };
    repeatTimerRef.current = window.setTimeout(tick, KEY_REPEAT_INITIAL_MS);
  }, [stopRepeat, onPress, canRepeat]);

  // Cancel any pending repeat if the key unmounts mid-hold (e.g. layout swaps to
  // the symbols page) so it can't keep firing Backspace into a torn-down view.
  useEffect(() => {
    stopRepeat();
    return stopRepeat;
  }, [stopRepeat, authorityEpoch]);
  // Grey function keys; accent → blue is reserved (return is grey by default like
  // real iOS). Caps-locked shift gets the white highlight iOS lights it with, and
  // a one-shot shift a lighter grey. ⛔ A pressed GREY function key goes LIGHTER,
  // not darker: on the iOS light keyboard a held 123/return flashes white. The
  // old `active:brightness-95` darkened it, which is the one press animation the
  // device does not do. The caps-LOCKED shift is the exception and carries its
  // OWN pressed colour: it is already near-white, so it flashes slightly darker
  // like a character key (see KEYBOARD_PALETTES' press-direction note — one
  // pressed colour for both classes gave no feedback in light and a markedly
  // DARKER caps-lock in dark).
  //
  // A glyph key draws its label at the iOS glyph size, capped so a narrow key
  // cannot clip it (GLYPH_FIT_RATIO). A label key draws at fnFont, which is
  // floored above the text-quality gate.
  //
  // ⛔ PRECEDENCE — it was inverted, and that made the cap unable to do the one
  // thing it exists for. The floor used to sit OUTSIDE the cap
  // (`max(MIN_GEOMETRY.glyphFont, min(glyph, cap))`), so on a key narrower than
  // that 11px floor the cap could not lower the glyph at all: the rendered glyph
  // exceeded its key's whole width in 672 of 16080 enumerated
  // (render, device, key) cases. The cap now applies FIRST and MIN_TEXT_PX is the
  // final backstop, because a label under the text-quality gate's 9px is a GATE
  // FINDING while a 1px overflow is cosmetic. The two can only disagree on a key
  // narrower than MIN_TEXT_PX / GLYPH_FIT_RATIO ≈ 13px, and the narrowest key the
  // app can mount is ~18px (the 212px board floor) — so at every reachable width
  // neither binds and this is the reference glyph size (see GLYPH_FIT_RATIO).
  const fontSize =
    glyph === true
      ? Math.max(
          MIN_TEXT_PX,
          Math.min(metrics.glyphFont, Math.floor(keyBasisPx(plan, metrics) * GLYPH_FIT_RATIO)),
        )
      : metrics.fnFont;
  const fill = accent
    ? 'bg-[var(--kb-accent)] text-[color:var(--kb-accent-ink)]'
    : locked
      ? 'bg-[var(--kb-fn-locked)] text-[color:var(--kb-fn-locked-ink)]'
      : active
        ? 'bg-[var(--kb-fn-active)] text-[color:var(--kb-fn-ink)]'
        : 'bg-[var(--kb-fn-bg)] text-[color:var(--kb-fn-ink)]';
  return (
    <button
      type="button"
      data-key={label}
      // Keep the return key semantically "return" even though it now renders grey
      // (real iOS shows grey 'return' on a generic field; accent/blue is reserved
      // for a future enterkeyhint Go/Search/Send signal). Color and kind are
      // decoupled: ariaLabel pins the kind, accent only paints.
      data-key-kind={ariaLabel === 'Return' ? 'return' : accent ? 'return' : 'fn'}
      data-key-span={plan?.span.toString()}
      data-active={active ? 'true' : undefined}
      data-locked={locked ? 'true' : undefined}
      data-disabled={disabled ? 'true' : undefined}
      aria-label={ariaLabel}
      aria-disabled={disabled ? 'true' : undefined}
      disabled={disabled}
      onPointerDown={(e) => {
        e.preventDefault();
        if (disabled === true) return;
        if (repeatOnHold === true && (canRepeat === undefined || !canRepeat())) return;
        onPress();
        if (repeatOnHold === true) beginRepeat();
      }}
      onPointerUp={repeatOnHold === true ? stopRepeat : undefined}
      onPointerLeave={repeatOnHold === true ? stopRepeat : undefined}
      onPointerCancel={repeatOnHold === true ? stopRepeat : undefined}
      // A disabled key is dimmed and drops the press flash so it visibly reads as
      // inert rather than a working key that flashes.
      className={`flex min-w-0 items-center justify-center leading-none transition-colors ${
        disabled === true
          ? 'cursor-default opacity-40'
          : locked === true
            ? 'active:bg-[var(--kb-fn-locked-press)]'
            : 'active:bg-[var(--kb-fn-press)]'
      } ${fill}`}
      // Sized in KEY COLUMNS off the same grid the character keys use, so
      // shift/delete are 1.5 real keys wide (plus the gap they swallow) rather
      // than 1.5 shares of a remainder that changed with the row's key count.
      style={{
        flexGrow: 0,
        flexShrink: 1,
        flexBasis: `${String(keyBasisPx(plan, metrics))}px`,
        height: metrics.keyH,
        borderRadius: metrics.radius,
        fontSize,
        boxShadow: bevel,
      }}
    >
      {label}
    </button>
  );
}
