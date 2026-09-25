#!/usr/bin/env node
// Profiles-grid card GEOMETRY GATE (Phase A, 2026-09-11; Phase B and Phase C
// the same day) — the only proof that "nothing is outside the box". Rewritten
// from the 2026-06-15 screenshot-only self-review: a screenshot can be looked
// at; this MEASURES.
//
// Renders the visual harness (apps/gui-client/visual-harness.html → the real
// ProfilePhoneCard, every state in gallery.tsx STATES) with each card pinned
// to 178 / 240 / 260 px via the gallery's `?w=` query, and for EVERY card,
// plain, hovered and with its DETAILS SHEET open, asserts:
//   1. the phone screen (`[data-component="phone-screen"]`) and the body have
//      scrollWidth <= clientWidth AND scrollHeight <= clientHeight — nothing
//      inside wants to scroll in either axis (Phase B: the body no longer
//      scrolls; a fixed-height tile has no fold);
//   2. every `[data-component],[data-action],[data-udp],[data-region],
//      [data-fact]` inside the card article has a bounding box ⊆ the article's
//      box (±0.5px) on ALL FOUR sides — raw geometry, no scroll-container
//      allowance. The ONE exception is the sheet's body (Phase C), the only
//      scroller on the card: an element inside it must fit the article
//      horizontally and lie within the body's SCROLLABLE range vertically
//      (reachable by scrolling the sheet, never cut). An element hidden by
//      opacity 0 / visibility hidden is skipped and counted: invisible is not
//      "outside the box";
//   3. nothing is CUT AND UNREACHABLE: an overflow-hidden element whose content
//      exceeds its box is a violation unless it is a titled text clip
//      (truncate / line-clamp);
//   4. Phase B anatomy: the article is exactly CARD_HEIGHT (234px) tall at every
//      width, each `[data-region]` appears once in the order REGION_ORDER and
//      its clientHeight equals its budget, the dock (`[data-component=
//      "card-dock"]`) and the Launch button are outside the body;
//   5. the ⋯ menu, opened on the FIRST and the LAST card of every width: Phase C
//      PORTALS it to document.body (no descendant of the article), it stays
//      inside the viewport and the card's horizontal edges, flips DOWNWARD on
//      the top row (< 360px of room above the dock) and opens UPWARD further
//      down, and closes on Escape;
//   6. Phase C — the DETAILS SHEET (`[data-component="card-details-sheet"]`),
//      opened on EVERY card by clicking `[data-action="open-details"]`: a
//      role="dialog" labelled by the profile name, INSIDE the article, covering
//      the dock (whose box does not move — covered, not displaced), its body the
//      only scroller and never sideways, focus moved into it on open, Escape
//      closes it and focus RETURNS to the ⓘ glyph. States mounted with the sheet
//      open (`detailsInitiallyOpen`, the gallery's "sheet open ·" entries) are
//      measured as they stand;
//   7. Phase C — hover is INERT: hovering a card changes no probe count and no
//      class in the card reveals anything on hover (`group-hover:flex|block|
//      opacity-100|pointer-events-auto|visible`). Everything hover once showed
//      is in the sheet.
// Elements with a 0×0 box (display:none — an absent spinner) are skipped and
// COUNTED, and a card that yields fewer than MIN_PROBES measurable elements is
// itself a violation: an empty page must not pass as a clean one.
//
//   6b. The sheet's body is KEYBOARD-scrollable from the sheet's own focus: it
//      is a Tab stop (tabindex 0) and ArrowDown moves ITS scrollTop, never the
//      grid's (a browser's default scrolls the focused node's nearest scrolling
//      ancestor — the grid behind the sheet). At least one overflowing body per
//      width must have moved.
//   8. The SHORT viewport (600, tauri minHeight): the MAX card's 13-row menu
//      opening downward from the top row is capped to the viewport (inline
//      max-height), overflows its box, and every row is reachable by scrolling
//      INSIDE the menu — a fixed box cannot be scrolled into view by the grid.
//      `menu-short-<width>.png`.
//
// ─── PHASE D (2026-09-21) — THE AI VIEW AT THE WINDOWS A CUSTOMER REALLY RUNS ─
// A second, independent sweep in the same run, and the only MEASUREMENT of a
// claim three review rounds could only hold as stylesheet text: every
// `audit-agent-chat*` scene, at 960x600 (the Tauri minimum), 1024x640 (the
// tightest tier pair, reachable only through `--stage=` until now) and
// 1280x800 (the window the app opens at, and the THINNEST of the three — see
// AI_WINDOWS), in BOTH themes, asserting:
//   D1. the window itself never scrolls, in either axis;
//   D2. the four ROWS that have to hold their contents side by side —
//       `.ai-bar`, `.ai-hud`, `.ai-facts`, `.ai-cmd-foot` — do not overflow
//       sideways (a clipped number beside a live video is a WRONG number);
//   D3. THE FIRST SCREEN NEVER SCROLLS. Spec §3.8, verbatim: a gate card "takes
//       the three beats' place so the first screen never scrolls". Any scene
//       showing the idle hero (`.ai-hello`) must have `.ai-log` scrollHeight <=
//       clientHeight. Measured at the start of this stage, the gated screen was
//       52px over at 960x600 in both themes and cut its bottom row of template
//       cards; final QA recorded the number and could not close it.
//       ⛔ A scene with a DOCKED BANNER (`[data-component="ai-llm-banner"]`) is
//       held to a DIFFERENT promise, not to none. The banner takes ~120px out
//       of the log and §3.8 never promised to fit one, so the plain rule above
//       does not apply — but the bound that replaces it says what the banner
//       is allowed to cost: THE BANNER'S OWN HEIGHT, and no more. Overflow
//       beyond that is the hero being too tall, which IS §3.8's promise and
//       which the same hero's banner-less cells (`audit-agent-chat`) are
//       measured against at the same windows.
//       Measured on this tree, `audit-agent-chat-consent`, both themes:
//         960x600   over 83  · banner 121
//         1024x640  over 25  · banner 121
//         1280x800  over 113 · banner 121   ← the tightest, 8px of room
//         1600x1000 over 0   · banner 101
//       AI_BANNER_ALLOWANCE below is the documented tolerance on top of that
//       8px, and the reason it is not zero.
//       ⚠️ This replaced an UNBOUNDED exemption (added in review of the stage
//       that wrote this phase). Its defence was that the number is printed and
//       so cannot go quiet — but a printed number in a 78-cell log is quiet,
//       and a cell that can never fail is a cell nobody re-reads.
//   D4. a cell that measured fewer than MIN_AI_PROBES elements is itself a
//       violation: an empty page must not pass as a clean one.
//   D5. ⛔ THE FONT-STRESS PASS (2026-09-21) — D3 AGAIN, WITH THE RUNNER'S
//       TEXT WIDTHS. Everything above measures the fonts THIS MACHINE has, and
//       run 35567350180 proved that is not the measurement that matters:
//       `GUI render gates (Linux)` went red on main with six first-screen
//       violations that no Mac could see.
//       ⛔ THE MECHANISM, because a stress pass built on a guess emulates the
//       wrong thing. Nothing in this repo ships a font file: `tailwind.config
//       .ts` names `Geist Sans` and `Berkeley Mono` and there is no `@font-face`
//       and no woff2 anywhere in `apps/gui-client`, so BOTH stacks fall through
//       to whatever the OS has. On a maintainer's Mac that is `-apple-system`
//       → San Francisco. On the runner, `fc-list` (the workflow records it, and
//       the run's log has it) lists no Geist, no Roboto, no Segoe UI — so the
//       sans falls all the way to `sans-serif` → DEJAVU SANS, which sets ~9-12%
//       WIDER at the same px size. And every line-height on the first screen is
//       pinned in px (13/19, 11.5/16, 12.5/17 …), so none of the growth was
//       taller lines: ALL of it was PROSE TAKING ONE MORE LINE. Three blocks
//       did it, and the CI numbers are the sum of them, to the pixel:
//         the hero explainer  3 → 4 lines  +19px  (idle / preview / consent)
//         the API-key gate's body  3 → 4   +16px  (nokey)
//         both at once, at 1280x800        +35px  (nokey)
//       ⛔ THE EMULATION IS ADDITIVE LETTER-SPACING, NOT A BIGGER FONT. The two
//       obvious levers are both wrong here:
//         · a taller fallback family cannot be shared — the intersection of
//           this Mac's families and the runner's is empty (no DejaVu here, no
//           Verdana there), so the pass would measure a different thing per
//           host;
//         · `font-size-adjust` scales the USED FONT SIZE, and with it every
//           `ch`, `em` and `ex` length in the layout. The hero explainer is
//           `max-width: 54ch`: its column would grow by exactly the factor its
//           text grew by and the line count would not move — which is the
//           opposite of the runner, where the text is ~12% wider and `ch` (the
//           advance of "0") only ~1%. Measured: at the value that reproduces
//           the pre-fix CI numbers it matched 9 of 12 cells; after the fix it
//           reported the explainer STILL at three lines where DejaVu takes
//           four. An instrument that cannot see the block that caused the
//           outage is not the instrument.
//       Letter-spacing adds advance per character and touches NOTHING else —
//       not the font size, not the line-height, not `ch`. That is precisely how
//       the runner's font differs from this one. It is applied element by
//       element from a snapshot (`stressFirstScreenText` below) so a run that
//       already sets its own tracking — the headline's -0.022em, the guard
//       tags', the section labels' — gets the stress ON TOP of it rather than
//       instead of it.
//       ⛔ THE FACTOR IS DERIVED FROM THE CI RUN, NOT CHOSEN. Sweeping it
//       against the PRE-FIX tree (restored from HEAD, then restored back and
//       `cmp`-ed), `AI_FONT_STRESS_EM` reproduces run 35567350180's Phase D
//       numbers EXACTLY in 11 of the 12 first-screen cells, including all six
//       that failed and their over-by numbers:
//         idle    960x600  slack 38     | 1024x640 slack 78    | 1280x800 OVER 11
//         nokey   960x600  OVER 12      | 1024x640 slack 44.25 | 1280x800 OVER 21
//         preview 960x600  slack 42.25  | 1024x640 slack 82.25 | 1280x800 slack 35.25
//         consent 960x600  over 97 ✗    | 1024x640 over 43     | 1280x800 over 132
//       The one miss is `consent` at 960x600, where the emulation wraps the
//       DOCKED BANNER one line earlier than DejaVu does (banner 135 against
//       121) and so reports over 97 where CI reported 83. Both are inside the
//       banner budget, so the VERDICT agrees in 12 of 12 — but the number does
//       not, and that is what a per-character approximation of a proportional
//       face costs. Any value in 0.036em–0.050em reproduces the same twelve
//       verdicts; 0.045 is the middle of that band rather than an edge of it.
//       ⛔ ON THE RUNNER THIS PASS IS STRICTER THAN THE RUNNER, NEVER LAXER:
//       there the 0.045em lands on top of DejaVu, which is ~0.045em past San
//       Francisco already. Measured locally at 0.090em — the Mac equivalent of
//       the runner running this pass — every banner-less cell still fits, the
//       thinnest by 18px. So the workflow stays green and the pass keeps its
//       teeth on both hosts.
//       COST, MEASURED ON THIS MACHINE rather than estimated: the pass
//       re-renders ONLY the cells that reported a first screen in the plain
//       sweep — 24 of the 78 — and an AI cell costs 1.56s (two narrowed runs,
//       12 cells in 47s and 48 in 103s: 36 more cells for 56s). So the stress
//       pass is ~37s, and the whole gate went from ~200s to 237s.
// The scene list is READ FROM THE HARNESS (`ALL_SCENES`), like the text gate's,
// so an AI scene added to the gallery is measured by the next run with no edit
// here — and the run REFUSES a list with no AI scene in it.
//
// Output: `shot-<state>-<width>.png` per card, `shot-sheet-<width>.png` (the
// MAX card with its sheet open), `menu-<pos>-<width>.png`, `ai-<scene>-
// <W>x<H>-<theme>.png` for every Phase D cell that has a violation, and
// `report.json` in OUT_DIR. Exit 1 on any violation (each printed), exit 0 only
// on a full clean sweep.
//
// Usage (repo root): `node scripts/gui-visual-check.mjs`
//   HARNESS_URL  default http://127.0.0.1:5199/visual-harness.html — when it
//                does not answer, this script starts `vite --port 5199` from
//                apps/gui-client itself and stops it when done.
//   OUT_DIR      default <tmpdir>/driftstack-visual-check/run-<time>-<pid> — a
//                directory of THIS run's own. ⛔ It used to be the shared
//                <tmpdir>/driftstack-visual-check, and two runs on one machine
//                wrote into each other's report.json and screenshots — one of
//                them died reading back a report the other had replaced.
//   WIDTHS       default 178,240,260
//
// Playwright is a repo-root devDependency; run from the repo root.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HARNESS_PORT ?? 5199);
const URL = process.env.HARNESS_URL ?? `http://127.0.0.1:${PORT}/visual-harness.html`;
const OUT =
  process.env.OUT_DIR ??
  resolve(
    tmpdir(),
    'driftstack-visual-check',
    `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${String(process.pid)}`,
  );
const WIDTHS = (process.env.WIDTHS ?? '178,240,260')
  .split(',')
  .map((w) => Number(w.trim()))
  .filter((w) => Number.isFinite(w) && w > 0);
const TOLERANCE = 0.5;
const PROBE_SELECTOR = '[data-component],[data-action],[data-udp],[data-region],[data-fact]';
// Phase B anatomy — the numbers the design panel judged. The article is
// border 2 + padding 12 + screen 220; the screen is body 173 + dock 47; the
// body is padding 12 + regions 142 + gaps 21.
const CARD_HEIGHT = 234;
const REGION_BUDGET = { identity: 38, status: 20, exit: 18, via: 16, caps: 20, when: 14, meta: 16 };
const REGION_ORDER = ['identity', 'status', 'exit', 'via', 'caps', 'when', 'meta'];
// The dock's bottom edge sits at the article's bottom minus border 1 + padding 6.
const DOCK_INSET_BOTTOM = 7;
const DOCK_HEIGHT = 47;
// The room above the dock (inside the scroller) below which the menu opens
// downward — mirrors MENU_FLIP_ROOM_PX in ProfilePhoneCard.tsx.
/** Rule 8 — the app's minimum window height (tauri.conf.json minHeight) and
 *  the menu's breathing room to the viewport edge (mirrors MENU_VIEWPORT_EDGE_PX
 *  in ProfilePhoneCard.tsx). */
const SHORT_VIEWPORT_HEIGHT = 600;
const MENU_VIEWPORT_EDGE_PX = 8;
const MENU_FLIP_ROOM_PX = 360; // polish: card grew to 360 with the menu open;
// select-indicator, phone-screen, card-body, seven regions, health-pill,
// card-dock, open-details — a real card always yields more than this.
const MIN_PROBES = 12;
const MIN_STATES = 8;
/** Phase C — the sheet pass must find at least this many probes INSIDE the
 *  sheet (exit-row + a handful of `data-fact` rows on the emptiest card). */
const MIN_SHEET_PROBES = 4;

// ─── Phase D constants ───────────────────────────────────────────────────────
/** The harness module the scene list comes from — the same one the text gate
 *  reads, so the two gates can never disagree about what exists. */
const HARNESS_MODULE = '/src/visual-harness/gallery.tsx';
/** Every scene whose name starts with this is the AI view in some state. */
const AI_SCENE_PREFIX = 'audit-agent-chat';
/** The instant every scene renders at (gallery.tsx's frozen clock). */
const FROZEN_NOW_ISO = '2026-06-15T06:42:00.000Z';
/** The windows. 960x600 is `tauri.conf.json`'s minimum — the smallest window a
 *  customer can make. 1024x640 was named "the tightest bar" by stage 6 and has
 *  been reachable only through `--stage=` ever since.
 *
 *  ⛔ AND 1280x800, THE ONE THE APP ACTUALLY OPENS AT (added in review of the
 *  stage that wrote this phase). Leaving it out looked safe — a wider, taller
 *  window is where everything has the most room — and the stage that built this
 *  sweep disproved it in its own diff: the no-key first screen was 7px OVER at
 *  1280x800 while fitting everywhere else, because the gated composer's caption
 *  wraps to a second line in a column that only gets WIDER on the way down. The
 *  overflow was found by hand, fixed, and then left to no instrument.
 *  It is also the THINNEST cell of the three, which is the opposite of the
 *  intuition: measured on this tree, the idle first screen has 8.0px of slack
 *  at 1280x800 against 38.0 at 960x600, and the no-key one 13.5 against 4.25.
 *  8px is inside the range this file's own header warns a CI runner's fonts can
 *  move, and until now nothing would have said so. */
const AI_WINDOWS = (process.env.AI_WINDOWS ?? '960x600,1024x640,1280x800')
  .split(',')
  .map((w) => w.trim().split('x').map(Number))
  .filter(([w, h]) => Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0);
const AI_THEMES = (process.env.AI_THEMES ?? 'dark,light').split(',').map((t) => t.trim());
/** `AI_SCENES=audit-agent-chat-nokey` narrows the sweep to those scenes while
 *  working (and for a negative control on one cell). Empty = every AI scene the
 *  harness lists. It can only NARROW: a name the harness does not list is an
 *  error, never a silently empty run. */
const AI_SCENE_FILTER = (process.env.AI_SCENES ?? '')
  .split(',')
  .map((x) => x.trim())
  .filter((x) => x !== '');
/** The rows that must hold their contents side by side. */
const AI_ROWS = ['.ai-bar', '.ai-hud', '.ai-facts', '.ai-cmd-foot'];
/** How much MORE than its own height a docked banner may push the first screen
 *  down (D3). Not zero, because the two numbers are measured off text laid out
 *  by the same fonts and move together but not in lockstep, and the tightest
 *  cell today leaves 8px: a CI runner whose fonts wrap the hero one line
 *  earlier than the banner would red on a difference that is not a regression.
 *  Not large either — at 24 the rule still catches an extra line of hero (~18px
 *  at this type scale) and everything bigger. */
const AI_BANNER_ALLOWANCE = 24;
/** A cell measuring fewer than this saw a page that had not rendered. */
const MIN_AI_PROBES = 3;
/** D5 — how much advance the font-stress pass adds PER CHARACTER, in em, on top
 *  of whatever tracking each run already carries. Derived from run
 *  35567350180 against the pre-fix tree, not chosen: see the D5 block in this
 *  file's header for the twelve cells it reproduces and the 0.036–0.050 band
 *  it is the middle of. Overridable so the band can be re-swept, and the value
 *  actually used is printed with the pass. */
const AI_FONT_STRESS_EM = Number(process.env.AI_FONT_STRESS_EM ?? '0.045');
/** A stress run that reached almost nothing measured the plain layout and said
 *  it was stressed. Every AI scene has hundreds of elements; 40 is far below
 *  the floor and far above "the selector matched nothing". */
const MIN_STRESSED_NODES = 40;

// ─── Phase E constants — "Bringing The Stage everywhere" stage 1 ─────────────
/** Every scene whose name starts with this is the simulator window in some
 *  session state (simulator-scenes.tsx). */
const SIMULATOR_SCENE_PREFIX = 'audit-simulator';
/** Themes to sweep, same knob shape as AI_THEMES. */
const SIMULATOR_THEMES = (process.env.SIMULATOR_THEMES ?? 'dark,light')
  .split(',')
  .map((t) => t.trim());
/**
 * ⛔ NOT the AI view's AI_WINDOWS (960x600 / 1024x640 / 1280x800), and that
 * omission is deliberate, not an oversight — measured, not assumed:
 * `SimulatorWindow.tsx`'s root is `h-screen w-screen`, a whole dedicated OS
 * window Rust always resizes to fit its content exactly (never wider than the
 * phone + drawer need) — there is no CSS cap on the bezel's width, because
 * production never needs one. Screenshotting this scene at 1280x800 proved
 * that directly: the phone stays phone-shaped and flush at the left edge,
 * with the REST of the 1280px width painted as a plain black void — not a
 * page error, not cut content, just a window size that never occurs on a
 * real desktop. Adding a max-width to fix the picture at a size nothing ever
 * requests would be exactly the "coordinate" change design brief §2 and this
 * repo's build instructions rule out for this stage. So this sweep runs the
 * scene at the ONE size that is real: `SIMULATOR_SCENE_SIZE` from
 * simulator-scenes.tsx (582x718 — the drawer-open width the real app already
 * resizes itself to; see that file's own comment on the arithmetic), read
 * off the DOM rather than duplicated as a literal here so the two can never
 * drift apart. A human wanting the 960x600/1280x800 pictures anyway can still
 * take them by hand (`&stage=960x600`) — this sweep's job is a real gate, not
 * every picture. */
const MIN_SIMULATOR_TEXT_LEAVES = 15;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Wait until `predicate(article)` holds in the page — up to `timeoutMs` — and
 * return whether it did. It NEVER throws: the measurement that follows reports
 * what is true either way. This replaces a fixed 150 ms sleep after the sheet's
 * open click and its Escape, which under a loaded machine read a frame that had
 * not landed yet as a defect ("sheet-did-not-close-on-escape",
 * "sheet-focus-not-returned") on a different card each run.
 */
async function settle(page, card, predicate, extra = {}, timeoutMs = 3000) {
  const handle = await card.elementHandle();
  if (handle === null) return false;
  try {
    await page.waitForFunction(
      predicate,
      { el: handle, ...extra },
      {
        timeout: timeoutMs,
        polling: 'raf',
      },
    );
    return true;
  } catch {
    return false;
  } finally {
    await handle.dispose();
  }
}

async function harnessUp(url) {
  try {
    const res = await fetch(url);
    return res.ok;
  } catch {
    return false;
  }
}

/** Start the gui-client dev server when nothing answers at URL. Returns the
 *  child to stop afterwards, or null when a server was already running. */
async function ensureHarness() {
  if (await harnessUp(URL)) return null;
  process.stdout.write(`harness not answering at ${URL} — starting vite on :${PORT}\n`);
  const child = spawn(
    resolve(REPO_ROOT, 'node_modules/.bin/vite'),
    ['--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
    { cwd: resolve(REPO_ROOT, 'apps/gui-client'), stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let log = '';
  child.stdout.on('data', (d) => {
    log += d;
  });
  child.stderr.on('data', (d) => {
    log += d;
  });
  for (let i = 0; i < 120; i += 1) {
    await sleep(500);
    if (child.exitCode !== null) {
      throw new Error(`vite exited (${child.exitCode}) before serving:\n${log}`);
    }
    if (await harnessUp(URL)) return child;
  }
  child.kill();
  throw new Error(`vite did not answer at ${URL} within 60s:\n${log}`);
}

/** Runs INSIDE the page against one card article.
 *
 *  Rules, each measuring a different way content leaves the box:
 *  • ESCAPED — a probe element's box past the article's, on any side. Raw
 *    geometry: Phase B has no scroll container inside the card, so there is no
 *    "below the fold but reachable" any more — except the details sheet's body
 *    (Phase C), the one deliberate scroller: an element inside it must fit the
 *    article sideways and lie inside the body's scrollable range. Elements
 *    hidden by opacity 0 / visibility hidden are skipped and counted as
 *    `invisible`.
 *  • CONTENT-LOST — an element that clips (overflow hidden/clip) but does not
 *    scroll, whose scrollHeight/scrollWidth exceeds its client box: something is
 *    cut and nothing can bring it back. Deliberate text clips (text-overflow:
 *    ellipsis, -webkit-line-clamp) are exempt from the size rule but must carry
 *    a title on themselves or an ancestor (CLAMPED-WITHOUT-TITLE otherwise).
 *  • SCROLLS — the screen or the body wants a scroll in either axis at all.
 *  • ANATOMY — article height, region presence/order/budgets, dock and Launch
 *    outside the body; the dock's box where the anatomy puts it (so an open
 *    sheet is proved to COVER it, not displace it).
 *  • SHEET (when open) — role/label, inside the article, covering the dock, its
 *    body never scrolling sideways, at least MIN_SHEET_PROBES facts inside.
 *  • HOVER-REVEAL — any class in the card that shows something on hover.
 */
function measureCard(article, opts) {
  const { tolerance, probeSelector, cardHeight, regionBudget, regionOrder } = opts;
  const round = (n) => Math.round(n * 100) / 100;
  const describe = (el) => {
    const marks = ['data-component', 'data-action', 'data-udp', 'data-region', 'data-fact']
      .map((a) => (el.hasAttribute(a) ? `${a}=${el.getAttribute(a)}` : null))
      .filter((x) => x !== null)
      .join(' ');
    const txt = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}[${marks}]${txt ? ` "${txt}"` : ''}`;
  };
  const invisible = (el) => {
    for (let n = el; n !== null && n !== article; n = n.parentElement) {
      const cs = getComputedStyle(n);
      if (cs.opacity === '0' || cs.visibility === 'hidden') return true;
    }
    return false;
  };
  const a = article.getBoundingClientRect();
  const violations = [];

  // ANATOMY — the fixed tile.
  if (Math.abs(a.height - cardHeight) > tolerance) {
    violations.push({ kind: 'card-height', height: round(a.height), expected: cardHeight });
  }
  const screen = article.querySelector('[data-component="phone-screen"]');
  const body = article.querySelector('[data-component="card-body"]');
  for (const [name, el] of [
    ['phone-screen', screen],
    ['card-body', body],
  ]) {
    if (el === null) {
      violations.push({ kind: 'missing', what: name });
      continue;
    }
    if (el.scrollWidth > el.clientWidth) {
      violations.push({
        kind: `${name}-scrolls-x`,
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
      });
    }
    if (el.scrollHeight > el.clientHeight) {
      violations.push({
        kind: `${name}-scrolls-y`,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
    }
  }
  const regions = Array.from(article.querySelectorAll('[data-region]'));
  const order = regions.map((r) => r.getAttribute('data-region'));
  if (order.join(',') !== regionOrder.join(',')) {
    violations.push({ kind: 'region-order', order, expected: regionOrder });
  }
  const regionHeights = {};
  for (const r of regions) {
    const name = r.getAttribute('data-region');
    regionHeights[name] = r.clientHeight;
    const budget = regionBudget[name];
    if (budget === undefined) {
      violations.push({ kind: 'region-unknown', region: name });
    } else if (r.clientHeight !== budget) {
      violations.push({ kind: 'region-height', region: name, height: r.clientHeight, budget });
    }
    if (body !== null && !body.contains(r)) {
      violations.push({ kind: 'region-outside-body', region: name });
    }
  }
  const dock = article.querySelector('[data-component="card-dock"]');
  let d = null;
  if (dock === null) {
    violations.push({ kind: 'missing', what: 'card-dock' });
  } else {
    if (body !== null && body.contains(dock)) violations.push({ kind: 'dock-inside-body' });
    d = dock.getBoundingClientRect();
    // The dock sits where the anatomy puts it whatever overlays the screen: an
    // open sheet COVERS it (rule below) and never pushes it.
    if (
      Math.abs(d.bottom - (a.bottom - opts.dockInsetBottom)) > tolerance ||
      Math.abs(d.height - opts.dockHeight) > tolerance
    ) {
      violations.push({
        kind: 'dock-displaced',
        dock: { top: round(d.top), bottom: round(d.bottom), h: round(d.height) },
        article: { bottom: round(a.bottom) },
      });
    }
  }
  const launch = Array.from(article.querySelectorAll('button')).find((b) =>
    /^(Launch|Launching…|Open session)$/.test((b.textContent ?? '').trim().replace(/^↻\s*/, '')),
  );
  if (launch === undefined) {
    violations.push({ kind: 'missing', what: 'launch-button' });
  } else if (body !== null && body.contains(launch)) {
    violations.push({ kind: 'launch-inside-body' });
  }

  // SHEET — Phase C. Present only while open (it unmounts on close).
  const sheet = article.querySelector('[data-component="card-details-sheet"]');
  const sheetBody =
    sheet === null ? null : sheet.querySelector('[data-component="card-details-body"]');
  let sheetInfo = null;
  if (sheet !== null) {
    const s = sheet.getBoundingClientRect();
    const name = (article.getAttribute('aria-label') ?? '').replace(/^Select /, '');
    const labelledBy = sheet.getAttribute('aria-labelledby');
    const title = labelledBy === null ? null : document.getElementById(labelledBy);
    if (sheet.getAttribute('role') !== 'dialog') violations.push({ kind: 'sheet-not-dialog' });
    if (title === null || (title.textContent ?? '').trim() !== name) {
      violations.push({
        kind: 'sheet-label',
        labelledBy,
        text: title === null ? null : (title.textContent ?? '').trim(),
        expected: name,
      });
    }
    if (!article.contains(sheet)) violations.push({ kind: 'sheet-outside-article' });
    const over = {
      left: round(a.left - s.left),
      right: round(s.right - a.right),
      top: round(a.top - s.top),
      bottom: round(s.bottom - a.bottom),
    };
    if (Math.max(over.left, over.right, over.top, over.bottom) > tolerance) {
      violations.push({ kind: 'sheet-escaped', over });
    }
    if (d !== null) {
      const uncovered = {
        left: round(s.left - d.left),
        right: round(d.right - s.right),
        top: round(s.top - d.top),
        bottom: round(d.bottom - s.bottom),
      };
      if (Math.max(uncovered.left, uncovered.right, uncovered.top, uncovered.bottom) > tolerance) {
        violations.push({ kind: 'sheet-does-not-cover-dock', uncovered });
      }
    }
    if (sheetBody === null) {
      violations.push({ kind: 'missing', what: 'card-details-body' });
    } else {
      if (sheetBody.scrollWidth > sheetBody.clientWidth) {
        violations.push({
          kind: 'sheet-body-scrolls-x',
          scrollWidth: sheetBody.scrollWidth,
          clientWidth: sheetBody.clientWidth,
        });
      }
      const csb = getComputedStyle(sheetBody);
      if (csb.overflowY !== 'auto' && csb.overflowY !== 'scroll') {
        violations.push({ kind: 'sheet-body-not-a-scroller', overflowY: csb.overflowY });
      }
    }
    const sheetProbes = sheet.querySelectorAll(probeSelector).length;
    if (sheetProbes < opts.minSheetProbes) {
      violations.push({ kind: 'too-few-sheet-probes', probed: sheetProbes });
    }
    sheetInfo = {
      box: { top: round(s.top), bottom: round(s.bottom), w: round(s.width), h: round(s.height) },
      probes: sheetProbes,
      bodyScrollHeight: sheetBody === null ? null : sheetBody.scrollHeight,
      bodyClientHeight: sheetBody === null ? null : sheetBody.clientHeight,
    };
  }

  // Rule 1 — ESCAPED, all four sides, raw geometry (sheet body: reachable range).
  let probed = 0;
  let skipped = 0;
  let invisibleCount = 0;
  const sb = sheetBody === null ? null : sheetBody.getBoundingClientRect();
  for (const el of article.querySelectorAll(probeSelector)) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) {
      skipped += 1;
      continue;
    }
    if (invisible(el)) {
      invisibleCount += 1;
      continue;
    }
    // The floor light under a lit card is decoration that lives OUTSIDE the
    // card on purpose (light pooled on the page, like the AI view's floor): no
    // text, aria-hidden, no pointer events, nothing a customer can lose. It is
    // the one element allowed past the card's edge; everything else still is not.
    if (el.getAttribute('data-component') === 'card-floor') {
      skipped += 1;
      continue;
    }
    probed += 1;
    const inScroller = sheetBody !== null && sheetBody !== el && sheetBody.contains(el);
    const reachTop = inScroller ? sb.top - sheetBody.scrollTop : a.top;
    const reachBottom = inScroller ? reachTop + sheetBody.scrollHeight : a.bottom;
    const over = {
      left: round(a.left - b.left),
      right: round(b.right - a.right),
      top: round(reachTop - b.top),
      bottom: round(b.bottom - reachBottom),
    };
    if (Math.max(over.left, over.right, over.top, over.bottom) > tolerance) {
      violations.push({ kind: 'escaped', el: describe(el), over, inSheet: inScroller });
    }
  }
  if (probed < opts.minProbes) {
    violations.push({ kind: 'too-few-probes', probed, minProbes: opts.minProbes });
  }

  // Rule 2 — CONTENT-LOST / CLAMPED-WITHOUT-TITLE, over EVERY visible descendant.
  // Rule 7 — HOVER-REVEAL over the same walk.
  const hoverReveal =
    /(^|\s)group-hover:(flex|block|inline|grid|opacity-100|pointer-events-auto|visible)(\s|$)/;
  for (const el of article.querySelectorAll('*')) {
    const cls = typeof el.className === 'string' ? el.className : '';
    if (hoverReveal.test(cls)) violations.push({ kind: 'hover-reveal', el: describe(el) });
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || invisible(el)) continue;
    const clipsX = cs.overflowX === 'hidden' || cs.overflowX === 'clip';
    const clipsY = cs.overflowY === 'hidden' || cs.overflowY === 'clip';
    const textClip =
      cs.textOverflow === 'ellipsis' ||
      (cs.webkitLineClamp !== undefined && cs.webkitLineClamp !== 'none');
    if (textClip) {
      if (el.closest('[title]') === null) {
        violations.push({ kind: 'clamped-without-title', el: describe(el) });
      }
      continue;
    }
    if (!clipsX && !clipsY) continue;
    const lostX = clipsX && el.scrollWidth > el.clientWidth + 1;
    const lostY = clipsY && el.scrollHeight > el.clientHeight + 1;
    if (!lostX && !lostY) continue;
    violations.push({
      kind: 'content-lost',
      el: describe(el),
      scroll: [el.scrollWidth, el.scrollHeight],
      client: [el.clientWidth, el.clientHeight],
    });
  }

  return {
    card: { w: round(a.width), h: round(a.height) },
    screen:
      screen === null
        ? null
        : {
            scrollWidth: screen.scrollWidth,
            clientWidth: screen.clientWidth,
            scrollHeight: screen.scrollHeight,
            clientHeight: screen.clientHeight,
          },
    body:
      body === null
        ? null
        : {
            scrollHeight: body.scrollHeight,
            clientHeight: body.clientHeight,
            scrollWidth: body.scrollWidth,
            clientWidth: body.clientWidth,
          },
    regionHeights,
    sheet: sheetInfo,
    focusInSheet: sheet !== null && sheet.contains(document.activeElement),
    probed,
    skipped,
    invisible: invisibleCount,
    violations,
  };
}

/** Runs INSIDE the page with the ⋯ menu OPEN on one card: the menu is a
 *  PORTAL (Phase C — reached through the toggle's aria-controls, never as a
 *  descendant of the article), allowed to leave the card but not the viewport
 *  nor the card's horizontal edges, and it must have flipped the way the room
 *  above the dock dictates. */
function measureOpenMenu(article, opts) {
  const round = (n) => Math.round(n * 100) / 100;
  const violations = [];
  const toggle = article.querySelector('[aria-label="More actions"]');
  const controls = toggle === null ? null : toggle.getAttribute('aria-controls');
  const menu = controls === null ? null : document.getElementById(controls);
  const dock = article.querySelector('[data-component="card-dock"]');
  if (menu === null || dock === null) {
    return { violations: [{ kind: 'missing', what: menu === null ? 'menu' : 'dock' }] };
  }
  if (menu.getAttribute('data-component') !== 'card-actions-menu') {
    violations.push({ kind: 'menu-not-the-actions-menu', controls });
  }
  if (article.contains(menu)) violations.push({ kind: 'menu-inside-article' });
  if (menu.parentElement !== document.body) violations.push({ kind: 'menu-not-portaled' });
  if (getComputedStyle(menu).position !== 'fixed') {
    violations.push({ kind: 'menu-not-fixed', position: getComputedStyle(menu).position });
  }
  if (menu.getAttribute('data-open') !== 'true') violations.push({ kind: 'menu-not-open' });
  if (getComputedStyle(menu).opacity !== '1') violations.push({ kind: 'menu-not-visible' });
  if (toggle !== null && toggle.getAttribute('aria-expanded') !== 'true') {
    violations.push({ kind: 'menu-toggle-not-expanded' });
  }
  const m = menu.getBoundingClientRect();
  const d = dock.getBoundingClientRect();
  const a = article.getBoundingClientRect();
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const over = {
    left: round(-m.left),
    right: round(m.right - vw),
    top: round(-m.top),
    bottom: round(m.bottom - vh),
  };
  if (Math.max(over.left, over.right, over.top, over.bottom) > opts.tolerance) {
    violations.push({ kind: 'menu-outside-viewport', over });
  }
  // Anchored to BOTH card edges (Phase A): never wider than the card.
  if (m.left < a.left - opts.tolerance || m.right > a.right + opts.tolerance) {
    violations.push({
      kind: 'menu-wider-than-card',
      menu: [round(m.left), round(m.right)],
      card: [round(a.left), round(a.right)],
    });
  }
  // The same room the component computed (nearest scroller, else the viewport).
  let scrollerTop = 0;
  for (let n = dock.parentElement; n !== null; n = n.parentElement) {
    const cs = getComputedStyle(n);
    if (cs.overflowY === 'auto' || cs.overflowY === 'scroll') {
      scrollerTop = n.getBoundingClientRect().top;
      break;
    }
  }
  const room = d.top - scrollerTop;
  const expected = room < opts.flipRoom ? 'below' : 'above';
  const placement = menu.getAttribute('data-placement');
  if (placement !== expected) {
    violations.push({ kind: 'menu-placement', placement, expected, room: round(room) });
  }
  if (expected === 'below' && m.top < d.bottom - opts.tolerance) {
    violations.push({
      kind: 'menu-below-overlaps-dock',
      menuTop: round(m.top),
      dockBottom: round(d.bottom),
    });
  }
  if (expected === 'above' && m.bottom > d.top + opts.tolerance) {
    violations.push({
      kind: 'menu-above-overlaps-dock',
      menuBottom: round(m.bottom),
      dockTop: round(d.top),
    });
  }
  if (menu.scrollWidth > menu.clientWidth) {
    violations.push({
      kind: 'menu-scrolls-x',
      scrollWidth: menu.scrollWidth,
      clientWidth: menu.clientWidth,
    });
  }
  return {
    placement,
    room: round(room),
    menu: { top: round(m.top), bottom: round(m.bottom), h: round(m.height) },
    violations,
  };
}

/** Runs INSIDE the page: is any ⋯ menu open anywhere (they are portaled)? */
function openMenuCount() {
  return document.querySelectorAll('[data-component="card-actions-menu"][data-open="true"]').length;
}

// ─── Phase D — the AI view at the windows a customer really runs ─────────────

/** Runs INSIDE the page: the harness's scene list, so an AI scene added to the
 *  gallery is measured here without anyone editing this file. */
async function readAiSceneNames({ modulePath, prefix }) {
  const m = await import(/* @vite-ignore */ modulePath);
  const names = m.ALL_SCENES;
  if (!Array.isArray(names)) return { error: `ALL_SCENES is not an array (${typeof names})` };
  return { names: names.filter((n) => typeof n === 'string' && n.startsWith(prefix)) };
}

/** Runs INSIDE the page, over one scene's stage root. Pure measurement: every
 *  number it reports is read off the browser's own layout, and every rule it
 *  applies is in the Phase D block of this file's header. */
function measureAiWindow(root, opts) {
  const { rows, minProbes } = opts;
  const round = (n) => Math.round(n * 100) / 100;
  const violations = [];
  const measured = [];
  let probed = 0;

  // D1 — the window itself.
  if (root.scrollWidth > root.clientWidth + 1) {
    violations.push({
      kind: 'window-scrolls-sideways',
      scrollWidth: root.scrollWidth,
      clientWidth: root.clientWidth,
    });
  }
  if (root.scrollHeight > root.clientHeight + 1) {
    violations.push({
      kind: 'window-scrolls-down',
      scrollHeight: root.scrollHeight,
      clientHeight: root.clientHeight,
    });
  }
  probed += 1;

  // D2 — the rows that hold their contents side by side.
  for (const sel of rows) {
    for (const el of root.querySelectorAll(sel)) {
      probed += 1;
      const over = el.scrollWidth - el.clientWidth;
      measured.push({ row: sel, over, width: round(el.getBoundingClientRect().width) });
      if (over > 1) {
        violations.push({
          kind: 'row-overflows-sideways',
          row: sel,
          over,
          scrollWidth: el.scrollWidth,
          clientWidth: el.clientWidth,
          text: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 60),
        });
      }
    }
  }

  // D3 — the first screen.
  const hero = root.querySelector('.ai-hello');
  const log = root.querySelector('.ai-log');
  const banner = root.querySelector('[data-component="ai-llm-banner"]');
  let firstScreen = null;
  if (hero !== null && log !== null) {
    probed += 1;
    const over = log.scrollHeight - log.clientHeight;
    // The room left under the last block, which is what a reviewer wants when
    // the answer is "it fits": a fit with 0.4px to spare is not the same
    // finding as one with 40px, and `scrollHeight` cannot tell them apart
    // (it never reports less than `clientHeight`).
    const last = log.lastElementChild;
    const padBottom = parseFloat(getComputedStyle(log).paddingBottom) || 0;
    const slack =
      last === null
        ? null
        : round(
            log.getBoundingClientRect().bottom - padBottom - last.getBoundingClientRect().bottom,
          );
    // What the docked banner itself occupies — the budget it is allowed to
    // cost the first screen, read off the banner rather than written down, so
    // a banner that grows a line brings its own allowance with it.
    const bannerHeight = banner === null ? null : round(banner.getBoundingClientRect().height);
    firstScreen = {
      over,
      slack,
      scrollHeight: log.scrollHeight,
      clientHeight: log.clientHeight,
      banner: banner !== null,
      bannerHeight,
    };
    if (banner === null) {
      if (over > 0) violations.push({ kind: 'first-screen-scrolls', over, slack });
    } else if (bannerHeight !== null && over > bannerHeight + opts.bannerAllowance) {
      // The hero is too tall on its own — the banner is not what did this.
      violations.push({
        kind: 'first-screen-scrolls-past-its-banner',
        over,
        bannerHeight,
        allowance: opts.bannerAllowance,
        excess: round(over - bannerHeight - opts.bannerAllowance),
      });
    }
  }

  // D4 — an empty page must not pass as a clean one.
  if (probed < minProbes) {
    violations.push({ kind: 'too-few-probes', probed, minProbes });
  }
  return { violations, measured, firstScreen, probed };
}

/** Runs INSIDE the page. Widens every text run in the document by `em` of
 *  advance per character — the one thing the runner's font does that this
 *  machine's does not (see D5).
 *
 *  ⛔ TWO PASSES, and the order is the whole correctness. `letter-spacing`
 *  INHERITS, so a single walk that reads `getComputedStyle(el).letterSpacing`
 *  and writes it back would read its own writes: a child of a node already
 *  stressed would inherit the stressed value, add the delta again, and the
 *  inflation would compound with depth — deep runs would get several times the
 *  stress and shallow ones once, which is not any font. Snapshot every
 *  element's own resolved value first, then write.
 *
 *  Returns what it touched so a cell that stressed nothing cannot pass as a
 *  cell that was stressed and still fitted. */
function stressFirstScreenText(em) {
  const snapshot = [];
  for (const el of document.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const own = cs.letterSpacing === 'normal' ? 0 : parseFloat(cs.letterSpacing) || 0;
    const size = parseFloat(cs.fontSize) || 0;
    snapshot.push([el, own + em * size]);
  }
  for (const [el, px] of snapshot) el.style.letterSpacing = `${String(px)}px`;
  return snapshot.length;
}

/** One Phase D cell: scene x window x theme. */
async function measureAiCell(context, scene, width, height, theme, stress = null) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  try {
    await page.setViewportSize({ width: width + 40, height: height + 40 });
    await page.clock.setFixedTime(new Date(FROZEN_NOW_ISO));
    await page.goto(`${URL}?scene=${scene}&stage=${width}x${height}`, {
      waitUntil: 'networkidle',
    });
    const stage = page.locator(`[data-scene="${scene}"][data-ready="1"]`);
    await stage.waitFor({ state: 'visible', timeout: 30_000 });
    // The stage is a FIXED box that ignores the viewport, so a run whose
    // `?stage=` was dropped would silently measure a 1280 layout and report it
    // as 960. Read the size back off the DOM rather than trusting the URL.
    const declared = await stage.evaluate((el) => ({
      width: Number(el.getAttribute('data-stage-width')),
      height: Number(el.getAttribute('data-stage-height')),
    }));
    if (declared.width !== width || declared.height !== height) {
      throw new Error(
        `${scene}: the stage declares ${declared.width}x${declared.height} but this cell asked for ${width}x${height} — the ?stage= override did not reach it`,
      );
    }
    await page.evaluate((mode) => {
      document.documentElement.dataset.mode = mode;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    const applied = await page.evaluate(() => document.documentElement.dataset.mode);
    if (applied !== theme) throw new Error(`${scene}: data-mode is ${applied}, wanted ${theme}`);
    let stressedNodes = null;
    if (stress !== null) {
      // D5. Applied after `document.fonts.ready` and the theme, so the values
      // snapshotted are the ones the cell was about to be measured with.
      stressedNodes = await page.evaluate(stressFirstScreenText, stress.em);
      if (!Number.isFinite(stressedNodes) || stressedNodes < MIN_STRESSED_NODES) {
        throw new Error(
          `${scene} [${String(width)}x${String(height)} ${theme}]: the font stress touched ${String(stressedNodes)} element(s), fewer than ${String(MIN_STRESSED_NODES)} — a page that was not stressed must not report as one that was`,
        );
      }
      await page.waitForTimeout(250);
    }
    const res = await stage.evaluate(measureAiWindow, {
      rows: AI_ROWS,
      minProbes: MIN_AI_PROBES,
      bannerAllowance: AI_BANNER_ALLOWANCE,
    });
    if (problems.length > 0) {
      throw new Error(
        `${scene} [${width}x${height} ${theme}]: the page reported errors:\n  ${problems.join('\n  ')}`,
      );
    }
    if (stress !== null) {
      res.stressEm = stress.em;
      res.stressedNodes = stressedNodes;
      // Same rule, a different reading of it — so a reader of the log or the
      // report can never mistake one for the other.
      for (const viol of res.violations) viol.kind = `${viol.kind}-under-font-stress`;
    }
    if (res.violations.length > 0) {
      const prefix = stress === null ? 'ai' : 'ai-stress';
      const shot = `${OUT}/${prefix}-${scene}-${width}x${height}-${theme}.png`;
      await page.screenshot({ path: shot });
      res.shot = shot;
    }
    return res;
  } finally {
    await page.close();
  }
}

/** The whole Phase D sweep. Returns the rows for the report and the violation
 *  count; throws rather than reporting clean when the list has no AI scene. */
async function runAiWindowSweep(browser, report) {
  const listPage = await browser.newPage();
  let names;
  try {
    await listPage.goto(`${URL}?scene=__list__`, { waitUntil: 'domcontentloaded' });
    const res = await listPage.evaluate(readAiSceneNames, {
      modulePath: HARNESS_MODULE,
      prefix: AI_SCENE_PREFIX,
    });
    if (res.error !== undefined) throw new Error(`AI scene list: ${res.error}`);
    names = res.names;
  } finally {
    await listPage.close();
  }
  if (names.length === 0) {
    throw new Error(
      `no scene in ${HARNESS_MODULE} starts with ${AI_SCENE_PREFIX} — refusing to report a clean AI sweep over nothing`,
    );
  }
  if (AI_SCENE_FILTER.length > 0) {
    const unknown = AI_SCENE_FILTER.filter((n) => !names.includes(n));
    if (unknown.length > 0) {
      throw new Error(
        `AI_SCENES names ${unknown.join(', ')}, which the harness does not list (has: ${names.join(', ')})`,
      );
    }
    names = names.filter((n) => AI_SCENE_FILTER.includes(n));
  }
  const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: 'reduce' });
  let violations = 0;
  /** The cells the stress pass re-renders: the ones that HAVE a first screen,
   *  found by measuring rather than by a list here, so a scene that grows one
   *  is stressed by the next run with no edit. */
  const firstScreenCells = [];
  try {
    for (const scene of names) {
      for (const [width, height] of AI_WINDOWS) {
        for (const theme of AI_THEMES) {
          const res = await measureAiCell(context, scene, width, height, theme);
          violations += res.violations.length;
          report.aiWindows.push({ scene, width, height, theme, ...res });
          if (res.firstScreen !== null) firstScreenCells.push({ scene, width, height, theme });
          const fs = res.firstScreen;
          const fit =
            fs === null
              ? 'no first screen'
              : `first screen ${fs.over > 0 ? `OVER by ${fs.over}` : `fits (${String(fs.slack)}px spare)`}` +
                (fs.banner
                  ? ` · banner docked (${String(fs.bannerHeight)}px, budget ${String((fs.bannerHeight ?? 0) + AI_BANNER_ALLOWANCE)})`
                  : '');
          process.stdout.write(
            `${scene.padEnd(30)} ${String(width)}x${String(height)} ${theme.padEnd(5)} → ` +
              `${fit} · ${res.violations.length} violation(s)${res.violations.length > 0 ? '  ✗' : ''}\n`,
          );
          for (const viol of res.violations) {
            process.stdout.write(`      ai: ${JSON.stringify(viol)}\n`);
          }
        }
      }
    }

    // D5 — the same cells again, with the runner's text widths.
    if (firstScreenCells.length === 0) {
      throw new Error(
        'no Phase D cell reported a first screen — refusing to report a clean font-stress pass over nothing',
      );
    }
    if (!Number.isFinite(AI_FONT_STRESS_EM) || AI_FONT_STRESS_EM <= 0) {
      throw new Error(
        `AI_FONT_STRESS_EM is ${String(process.env.AI_FONT_STRESS_EM)} — a stress of zero measures the plain layout twice`,
      );
    }
    process.stdout.write(
      `\nfont stress — +${String(AI_FONT_STRESS_EM)}em of advance per character ` +
        `(the ubuntu runner's DejaVu Sans, derived from run 35567350180; see D5), ` +
        `${String(firstScreenCells.length)} first-screen cell(s)\n`,
    );
    for (const cell of firstScreenCells) {
      const res = await measureAiCell(context, cell.scene, cell.width, cell.height, cell.theme, {
        em: AI_FONT_STRESS_EM,
      });
      violations += res.violations.length;
      report.aiFontStress.push({ ...cell, ...res });
      const fs = res.firstScreen;
      // A cell whose first screen disappeared under the stress is measuring
      // something else; the plain pass found one here.
      if (fs === null) {
        violations += 1;
        res.violations.push({ kind: 'first-screen-lost-under-font-stress' });
      }
      const fit =
        fs === null
          ? 'THE FIRST SCREEN VANISHED UNDER STRESS'
          : `first screen ${fs.over > 0 ? `OVER by ${String(fs.over)}` : `fits (${String(fs.slack)}px spare)`}` +
            (fs.banner ? ` · banner docked (${String(fs.bannerHeight)}px)` : '');
      process.stdout.write(
        `${cell.scene.padEnd(30)} ${String(cell.width)}x${String(cell.height)} ${cell.theme.padEnd(5)} ` +
          `stressed → ${fit} · ${String(res.violations.length)} violation(s)${res.violations.length > 0 ? '  ✗' : ''}\n`,
      );
      for (const viol of res.violations) {
        process.stdout.write(`      stress: ${JSON.stringify(viol)}\n`);
      }
    }
  } finally {
    await context.close();
  }
  return violations;
}

// ─── Phase E — the simulator window's own gallery scenes ─────────────────────
// (design brief §2, §5 stage 1). A REAL page load of `<SimulatorWindow>`, in
// both themes, at the one size that occurs in production (see
// SIMULATOR_SCENE_PREFIX's own comment for why not the AI view's three
// windows): no page error, the declared stage size actually reached the DOM
// (the `?stage=` mistake Phase D already guards against — the same class of
// silent-1280-measured-as-960 bug), the scene's own loaded-state marker
// (simulatorSceneLoadedMarker) on screen, `[data-sim-state]` set to exactly
// the state the scene names, and nothing scrolling in either axis (the same
// "nothing is CUT AND UNREACHABLE" rule this whole file polices elsewhere).

/** Runs INSIDE the page. Pure measurement, no DOM knowledge beyond the two
 *  attributes every audit scene already carries and the one this stage adds. */
function measureSimulatorWindow(root, opts) {
  const { expectedState, minLeaves } = opts;
  const shell = root.querySelector('[data-component="simulator-shell"]');
  const violations = [];
  if (shell === null) {
    violations.push({ kind: 'no-simulator-shell' });
    return { violations, simState: null, leaves: 0, overflow: null };
  }
  const simState = shell.getAttribute('data-sim-state');
  if (simState !== expectedState) {
    violations.push({ kind: 'wrong-sim-state', simState, expectedState });
  }
  // Nothing may scroll — the popped-out window has no scrollbar in the app.
  // "Clipped by an ANCESTOR" is not scrolling — CSS overflow clipping applies
  // to every descendant, not just direct children, so an element whose own
  // style is visible can still be invisible past a grandparent's
  // `overflow:hidden` (measured case: sim-drawer-status's close button
  // carries a deliberate `-mr-1` so its ✕ sits flush with the drawer's edge —
  // 4px of intentional negative-margin overhang, always contained by
  // `sim-drawer-panel`'s own `overflow-hidden` two levels up; nothing ever
  // scrolled or was cut, it just used to be double-clipped when these rows
  // were `truncate`, which also happens to set `overflow:hidden`).
  const clipsDescendants = (el) => {
    const s = getComputedStyle(el);
    return s.overflow === 'hidden' || s.overflowX === 'hidden' || s.overflowY === 'hidden';
  };
  const clippedByAncestor = (el) => {
    for (let n = el; n !== null && n !== root; n = n.parentElement) {
      if (clipsDescendants(n)) return true;
    }
    return false;
  };
  // A single-line text control is not "scrolling" when its value is longer
  // than its box: that is how an <input> shows a long value everywhere (the
  // caret moves the text; nothing is cut), and the address bar's URL is
  // exactly such a value. The first Linux run caught the degraded scene here
  // — a 307px URL in a 283px bar under DejaVu Sans — which is the control
  // doing its job, not a layout defect; the same value fits on a Mac by 24px.
  const isSingleLineTextControl = (el) =>
    el.tagName === 'TEXTAREA' ||
    (el.tagName === 'INPUT' &&
      !['checkbox', 'radio', 'range', 'color', 'file', 'submit', 'button'].includes(
        (el.getAttribute('type') ?? 'text').toLowerCase(),
      ));
  const overflowing = [];
  for (const el of root.querySelectorAll('*')) {
    if (el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1) {
      if (clippedByAncestor(el)) continue;
      if (isSingleLineTextControl(el) && el.scrollHeight <= el.clientHeight + 1) continue;
      overflowing.push({
        label: el.getAttribute('data-component') ?? el.tagName.toLowerCase(),
        className: typeof el.className === 'string' ? el.className.slice(0, 80) : '',
        scrollWidth: el.scrollWidth,
        clientWidth: el.clientWidth,
        scrollHeight: el.scrollHeight,
        clientHeight: el.clientHeight,
      });
    }
  }
  if (overflowing.length > 0) {
    violations.push({ kind: 'scrolls', elements: overflowing.slice(0, 8) });
  }
  const leaves = Array.from(root.querySelectorAll('*')).filter((el) =>
    Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== ''),
  ).length;
  if (leaves < minLeaves) {
    violations.push({ kind: 'too-few-text-leaves', leaves, minLeaves });
  }
  return { violations, simState, leaves, overflow: overflowing };
}

/** One Phase E cell: scene x theme, at the scene's own declared (native)
 *  size — never `?stage=`, which only accepts W>=640 and this scene's real
 *  width (582/842) is below that on purpose (the drawer-open width, not a
 *  marketing canvas). `size` is discovered PER SCENE by the caller (off the
 *  harness's own module's `simulatorSceneSize`, like `readAiSceneNames` does
 *  for the scene list) so the viewport this sets is never a second copy of a
 *  literal to drift from SIMULATOR_SCENE_SIZE/_WIDE.
 *
 *  round-2 stage B — `kind` (the scene name's own suffix) and `expectedSimState`
 *  (what `data-sim-state` should read) are now TWO arguments, not one: a
 *  mission-axis kind like `agent-running` names the scene's WORD, but its
 *  `data-sim-state` is `live` — the two axes NOTES.md §4 asks to reconcile
 *  explicitly rather than assume a scene's own name suffix IS its connectivity
 *  state. `kind` still keys `simulatorSceneLoadedMarker`; `expectedSimState`
 *  is what `measureSimulatorWindow` compares `data-sim-state` against.
 *  Mirrors measureAiCell's readiness protocol otherwise. */
async function measureSimulatorCell(context, scene, kind, expectedSimState, theme, size) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  try {
    const stage = page.locator(`[data-scene="${scene}"][data-ready="1"]`);
    await page.clock.setFixedTime(new Date(FROZEN_NOW_ISO));
    // Viewport EXACTLY `size`, no +40 margin (unlike measureAiCell's fixed-size
    // stage box) — SimulatorWindow.tsx's root is h-screen/w-screen, so it fills
    // the ACTUAL browser viewport, not the wrapper div's declared style width/
    // height. A +40 margin here made the vh/vw content overflow ITS OWN
    // wrapper by exactly 40px on both axes — a measurement-script artifact
    // (caught by this very "nothing scrolls" check), not a product defect: a
    // real customer's OS window IS the viewport, with no such margin either.
    // Before navigation — a resize after paint would not re-run the layout
    // this reads.
    await page.setViewportSize({ width: size.width, height: size.height });
    await page.goto(`${URL}?scene=${scene}`, { waitUntil: 'networkidle' });
    await stage.waitFor({ state: 'visible', timeout: 30_000 });
    const declared = await stage.evaluate((el) => ({
      width: Number(el.getAttribute('data-stage-width')),
      height: Number(el.getAttribute('data-stage-height')),
    }));
    if (declared.width !== size.width || declared.height !== size.height) {
      throw new Error(
        `${scene}: the stage declares ${declared.width}x${declared.height} but simulatorSceneSize(${kind}) is ${size.width}x${size.height}`,
      );
    }
    await page.evaluate((mode) => {
      document.documentElement.dataset.mode = mode;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(700);
    const applied = await page.evaluate(() => document.documentElement.dataset.mode);
    if (applied !== theme) throw new Error(`${scene}: data-mode is ${applied}, wanted ${theme}`);
    const res = await stage.evaluate(measureSimulatorWindow, {
      expectedState: expectedSimState,
      minLeaves: MIN_SIMULATOR_TEXT_LEAVES,
    });
    const marker = await page.evaluate(
      (name) =>
        import(/* @vite-ignore */ '/src/visual-harness/simulator-scenes.tsx').then((m) =>
          m.simulatorSceneLoadedMarker(name),
        ),
      kind,
    );
    const text = (await stage.evaluate((el) => el.textContent ?? '')) ?? '';
    if (!text.includes(marker)) {
      res.violations.push({ kind: 'marker-missing', marker });
    }
    if (problems.length > 0) {
      throw new Error(`${scene} [${theme}]: the page reported errors:\n  ${problems.join('\n  ')}`);
    }
    if (res.violations.length > 0) {
      const shot = `${OUT}/sim-${scene}-${theme}.png`;
      await page.screenshot({ path: shot });
      res.shot = shot;
    }
    return { ...res, declared };
  } finally {
    await page.close();
  }
}

/** The whole Phase E sweep. Returns the violation count; throws rather than
 *  reporting clean when the list has no simulator scene. */
async function runSimulatorSweep(browser, report) {
  const listPage = await browser.newPage();
  let names;
  let sizeOf;
  let simStateOf;
  try {
    await listPage.goto(`${URL}?scene=__list__`, { waitUntil: 'domcontentloaded' });
    const res = await listPage.evaluate(readAiSceneNames, {
      modulePath: HARNESS_MODULE,
      prefix: SIMULATOR_SCENE_PREFIX,
    });
    if (res.error !== undefined) throw new Error(`simulator scene list: ${res.error}`);
    names = res.names;
    // round-2 stage B — PER-KIND, not the single `SIMULATOR_SCENE_SIZE` this
    // sweep used to fetch once for every scene: a mission-axis kind's window
    // opens at the WIDE conversation width (`SIMULATOR_SCENE_SIZE_WIDE`), and
    // `simulatorSceneSize`/`simulatorSceneSimState` are the harness's own
    // single source for which size/connectivity-state a kind gets — see
    // simulator-scenes.tsx's own header on the two-axis reconciliation.
    const kinds = names.map((scene) => scene.slice(SIMULATOR_SCENE_PREFIX.length + 1));
    const fns = await listPage.evaluate(
      (ks) =>
        import(/* @vite-ignore */ '/src/visual-harness/simulator-scenes.tsx').then((m) => ({
          sizes: Object.fromEntries(ks.map((k) => [k, m.simulatorSceneSize(k)])),
          simStates: Object.fromEntries(ks.map((k) => [k, m.simulatorSceneSimState(k)])),
        })),
      kinds,
    );
    sizeOf = fns.sizes;
    simStateOf = fns.simStates;
  } finally {
    await listPage.close();
  }
  if (names.length === 0) {
    throw new Error(
      `no scene in ${HARNESS_MODULE} starts with ${SIMULATOR_SCENE_PREFIX} — refusing to report a clean simulator sweep over nothing`,
    );
  }
  for (const scene of names) {
    const kind = scene.slice(SIMULATOR_SCENE_PREFIX.length + 1);
    const size = sizeOf[kind];
    if (
      size === undefined ||
      !Number.isFinite(size.width) ||
      !Number.isFinite(size.height) ||
      size.width <= 0 ||
      size.height <= 0
    ) {
      throw new Error(
        `simulator-scenes.tsx simulatorSceneSize(${kind}) did not resolve to a real size (got ${JSON.stringify(size)})`,
      );
    }
  }
  const context = await browser.newContext({ deviceScaleFactor: 2, reducedMotion: 'reduce' });
  let violations = 0;
  try {
    for (const scene of names) {
      const kind = scene.slice(SIMULATOR_SCENE_PREFIX.length + 1);
      const expectedSimState = simStateOf[kind];
      const size = sizeOf[kind];
      for (const theme of SIMULATOR_THEMES) {
        const res = await measureSimulatorCell(context, scene, kind, expectedSimState, theme, size);
        violations += res.violations.length;
        report.simulatorWindows.push({ scene, theme, ...res });
        process.stdout.write(
          `${scene.padEnd(28)} ${theme.padEnd(5)} → state=${String(res.simState)} leaves=${String(res.leaves)} ` +
            `declared=${String(res.declared.width)}x${String(res.declared.height)} · ${res.violations.length} violation(s)${res.violations.length > 0 ? '  ✗' : ''}\n`,
        );
        for (const viol of res.violations) {
          process.stdout.write(`      sim: ${JSON.stringify(viol)}\n`);
        }
      }
    }
  } finally {
    await context.close();
  }
  return violations;
}

async function main() {
  if (WIDTHS.length === 0) throw new Error('WIDTHS resolved to nothing');
  await mkdir(OUT, { recursive: true });
  const started = await ensureHarness();
  const browser = await chromium.launch();
  const report = {
    url: URL,
    widths: WIDTHS,
    tolerance: TOLERANCE,
    cardHeight: CARD_HEIGHT,
    regionBudget: REGION_BUDGET,
    cards: [],
    menus: [],
    aiWindows: [],
    aiFontStressEm: AI_FONT_STRESS_EM,
    aiFontStress: [],
    simulatorWindows: [],
  };
  let violationCount = 0;
  const opts = {
    tolerance: TOLERANCE,
    probeSelector: PROBE_SELECTOR,
    minProbes: MIN_PROBES,
    minSheetProbes: MIN_SHEET_PROBES,
    cardHeight: CARD_HEIGHT,
    regionBudget: REGION_BUDGET,
    regionOrder: REGION_ORDER,
    dockInsetBottom: DOCK_INSET_BOTTOM,
    dockHeight: DOCK_HEIGHT,
    flipRoom: MENU_FLIP_ROOM_PX,
  };
  try {
    for (const width of WIDTHS) {
      const page = await browser.newPage({
        viewport: { width: 1200, height: 1400 },
        deviceScaleFactor: 2,
      });
      await page.goto(`${URL}?w=${width}`, { waitUntil: 'networkidle' });
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(300);
      const fixed = await page
        .locator('[data-harness="phone-cards"]')
        .getAttribute('data-fixed-width');
      if (fixed !== `w-[${width}px]`) {
        throw new Error(
          `gallery did not honour ?w=${width} (data-fixed-width=${String(fixed)}) — the wrappers are not pinned, so nothing below would measure the requested width`,
        );
      }
      const wrappers = page.locator('[data-harness="phone-cards"] > [data-state]');
      const n = await wrappers.count();
      if (n < MIN_STATES) {
        throw new Error(
          `harness rendered ${n} phone-card states (< ${MIN_STATES}) — nothing to measure`,
        );
      }
      const heights = new Set();
      let sheetShotTaken = false;
      let sheetsMeasured = 0;
      let mountedOpenSeen = 0;
      let keyboardScrolled = 0;
      // Sweep the mounted-open "sheet open ·" states FIRST: the first ⓘ click
      // of the sweep is an OUTSIDE pointer-down for every other open sheet and
      // closes them (that is the dismissal rule), so measured later they would
      // be ordinary closed tiles re-opened by click, not sheets "as they stand".
      const labels = [];
      for (let i = 0; i < n; i += 1) {
        labels.push((await wrappers.nth(i).getAttribute('data-state')) ?? `state-${i}`);
      }
      const order = [
        ...labels.map((l, i) => (/^sheet open\b/i.test(l) ? i : -1)).filter((i) => i >= 0),
        ...labels.map((l, i) => (/^sheet open\b/i.test(l) ? -1 : i)).filter((i) => i >= 0),
      ];
      for (const i of order) {
        const wrapper = wrappers.nth(i);
        const label = labels[i];
        const slug = label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 48);
        const card = wrapper.locator('article').first();
        await page.mouse.move(0, 0);
        const plain = await card.evaluate(measureCard, opts);
        await card.hover();
        await page.waitForTimeout(150);
        const hovered = await card.evaluate(measureCard, opts);
        // Rule 7 — hover is inert: it reveals nothing (probe count unchanged).
        if (hovered.probed !== plain.probed) {
          hovered.violations.push({
            kind: 'hover-changes-probes',
            plain: plain.probed,
            hovered: hovered.probed,
          });
        }
        const shot = `${OUT}/shot-${slug}-${width}.png`;
        await card.screenshot({ path: shot });
        await page.mouse.move(0, 0);
        heights.add(plain.card.h);

        // Rule 6 — the details sheet. Mounted-open states are measured as they
        // stand (the plain pass already contains the sheet); every other card
        // opens it by the ⓘ click, so the click path is proved on every state.
        const opener = card.locator('[data-action="open-details"]');
        const mountedOpen = plain.sheet !== null;
        if (mountedOpen) mountedOpenSeen += 1;
        let sheet;
        if (mountedOpen) {
          sheet = { ...plain, violations: [], mountedOpen };
        } else {
          if ((await opener.count()) !== 1) {
            sheet = {
              violations: [{ kind: 'missing', what: 'open-details', count: await opener.count() }],
            };
          } else {
            await opener.click();
            await settle(page, card, ({ el }) => {
              const sh = el.querySelector('[data-component="card-details-sheet"]');
              return sh !== null && sh.contains(document.activeElement);
            });
            sheet = await card.evaluate(measureCard, opts);
            if (sheet.sheet === null) sheet.violations.push({ kind: 'sheet-did-not-open' });
            if (!sheet.focusInSheet) sheet.violations.push({ kind: 'sheet-focus-not-inside' });
          }
        }
        if (sheet.sheet !== null && sheet.sheet !== undefined) {
          sheetsMeasured += 1;
          if (!sheetShotTaken && /^max\b/i.test(label)) {
            await card.screenshot({ path: `${OUT}/shot-sheet-${width}.png` });
            sheetShotTaken = true;
          }
          // Escape closes it; focus returns to the ⓘ glyph that opened it. A
          // mounted-open sheet was never clicked, so focus is wherever the last
          // mount put it: move it into THIS sheet by focus (not a pointer-down,
          // which would dismiss every other mounted-open sheet as "outside")
          // so the Escape is the sheet's own.
          if (mountedOpen) {
            await card.evaluate((el) => {
              el.querySelector('[data-component="card-details-sheet"]')?.focus();
            });
          }
          // Rule 6b — the body is KEYBOARD-scrollable from the sheet's own focus
          // (the dialog node, where open puts it): ArrowDown moves the body's
          // scrollTop, not the grid's. Every state overflows the 192px body, so
          // a sheet whose ArrowDown leaves scrollTop at 0 (the browser default
          // scrolls the nearest scrollable ANCESTOR of the focused node — the
          // grid) hides everything under the fold from a keyboard user. The
          // body is also a Tab stop (tabindex 0). Vacuity: the arm demands the
          // body to overflow, so a body that does not is itself a violation.
          const beforeKey = await card.evaluate((el) => {
            const sheet = el.querySelector('[data-component="card-details-sheet"]');
            const body = sheet?.querySelector('[data-component="card-details-body"]') ?? null;
            const active = document.activeElement;
            return {
              focusInSheet: sheet !== null && active !== null && sheet.contains(active),
              bodyTabIndex: body?.getAttribute('tabindex') ?? null,
              scrollTop: body?.scrollTop ?? null,
              overflow: body !== null && body.scrollHeight > body.clientHeight,
              gridScrollY: window.scrollY,
            };
          });
          await page.keyboard.press('ArrowDown');
          await page.waitForTimeout(80);
          const afterKey = await card.evaluate((el) => {
            const body = el.querySelector('[data-component="card-details-body"]');
            return { scrollTop: body?.scrollTop ?? null, gridScrollY: window.scrollY };
          });
          if (!beforeKey.focusInSheet) {
            sheet.violations.push({ kind: 'sheet-focus-not-inside-before-keys' });
          }
          if (beforeKey.bodyTabIndex !== '0') {
            sheet.violations.push({
              kind: 'sheet-body-not-a-tab-stop',
              tabindex: beforeKey.bodyTabIndex,
            });
          }
          // A body that fits (the emptiest fills at 240/260) has nothing to
          // scroll; the width-level control below demands that at least one
          // overflowing body WAS scrolled, so the arm can never pass vacuously.
          if (beforeKey.overflow && (afterKey.scrollTop ?? 0) > (beforeKey.scrollTop ?? 0)) {
            keyboardScrolled += 1;
          }
          if (
            beforeKey.overflow &&
            beforeKey.focusInSheet &&
            !((afterKey.scrollTop ?? 0) > (beforeKey.scrollTop ?? 0))
          ) {
            sheet.violations.push({
              kind: 'sheet-body-not-keyboard-scrollable',
              before: beforeKey.scrollTop,
              after: afterKey.scrollTop,
            });
          }
          if (afterKey.gridScrollY !== beforeKey.gridScrollY) {
            sheet.violations.push({
              kind: 'sheet-arrow-scrolled-the-grid',
              before: beforeKey.gridScrollY,
              after: afterKey.gridScrollY,
            });
          }
          sheet.keyboardScroll = { before: beforeKey.scrollTop, after: afterKey.scrollTop };
          await page.keyboard.press('Escape');
          await settle(
            page,
            card,
            ({ el, needFocus }) =>
              el.querySelector('[data-component="card-details-sheet"]') === null &&
              el.querySelector('[data-action="open-details"]')?.getAttribute('aria-expanded') ===
                'false' &&
              (!needFocus ||
                (document.activeElement !== null &&
                  document.activeElement.getAttribute('data-action') === 'open-details' &&
                  el.contains(document.activeElement))),
            { needFocus: !mountedOpen },
          );
          const after = await card.evaluate((el) => ({
            sheetOpen: el.querySelector('[data-component="card-details-sheet"]') !== null,
            focusOnOpener:
              document.activeElement !== null &&
              document.activeElement.getAttribute('data-action') === 'open-details' &&
              el.contains(document.activeElement),
            openerExpanded: el
              .querySelector('[data-action="open-details"]')
              ?.getAttribute('aria-expanded'),
          }));
          if (after.sheetOpen) sheet.violations.push({ kind: 'sheet-did-not-close-on-escape' });
          if (!mountedOpen && !after.focusOnOpener) {
            sheet.violations.push({ kind: 'sheet-focus-not-returned' });
          }
          if (after.openerExpanded !== 'false') {
            sheet.violations.push({ kind: 'opener-aria-expanded', value: after.openerExpanded });
          }
        }
        await page.mouse.move(0, 0);

        const entry = { width, index: i, label, shot, plain, hovered, sheet };
        report.cards.push(entry);
        const v = plain.violations.length + hovered.violations.length + sheet.violations.length;
        violationCount += v;
        process.stdout.write(
          `${String(width).padStart(3)}px ${plain.card.w}x${plain.card.h} [${label}] ` +
            `plain ${plain.violations.length} (probed ${plain.probed}, skipped ${plain.skipped}` +
            `, invisible ${plain.invisible}) · hover ${hovered.violations.length}` +
            ` · sheet ${sheet.violations.length}${
              sheet.sheet
                ? ` (probed ${sheet.sheet.probes}, scroll ${sheet.sheet.bodyScrollHeight}/${sheet.sheet.bodyClientHeight})`
                : ''
            }${v > 0 ? '  ✗' : ''}\n`,
        );
        for (const pass of ['plain', 'hovered', 'sheet']) {
          for (const viol of entry[pass].violations) {
            process.stdout.write(`      ${pass}: ${JSON.stringify(viol)}\n`);
          }
        }
      }
      if (heights.size !== 1) {
        violationCount += 1;
        process.stdout.write(
          `${String(width).padStart(3)}px ✗ card heights differ across states: ${[...heights].join(', ')}\n`,
        );
        report.menus.push({ width, kind: 'heights-differ', heights: [...heights] });
      }
      if (sheetsMeasured < n) {
        violationCount += 1;
        process.stdout.write(
          `${String(width).padStart(3)}px ✗ the sheet was measured on ${sheetsMeasured} of ${n} cards\n`,
        );
        report.menus.push({ width, kind: 'sheet-pass-incomplete', sheetsMeasured, states: n });
      }
      // Vacuity control for rule 6's "as they stand" arm: the gallery mounts
      // sheet-open states, so at least one must have been measured open at rest.
      if (mountedOpenSeen === 0) {
        violationCount += 1;
        process.stdout.write(
          `${String(width).padStart(3)}px ✗ no state was measured with its sheet mounted open (the gallery's "sheet open ·" entries)\n`,
        );
        report.menus.push({ width, kind: 'no-mounted-open-sheet' });
      }
      // Vacuity control for rule 6b: at least one overflowing body must have
      // moved under ArrowDown, else the keyboard-scroll arm measured nothing.
      if (keyboardScrolled === 0) {
        violationCount += 1;
        process.stdout.write(
          `${String(width).padStart(3)}px ✗ no sheet body was scrolled by ArrowDown (rule 6b measured nothing)\n`,
        );
        report.menus.push({ width, kind: 'sheet-keyboard-scroll-not-exercised' });
      }
      if (!sheetShotTaken) {
        violationCount += 1;
        process.stdout.write(
          `${String(width).padStart(3)}px ✗ no MAX state carried the shot-sheet-${width}.png close-up\n`,
        );
        report.menus.push({ width, kind: 'sheet-shot-missing' });
      }

      // Rule 5 — the ⋯ menu on the top row scrolled to the top of the viewport
      // (< 360px above the dock → opens downward) and on the last card scrolled
      // into view at the bottom (opens upward). Both placements must be SEEN:
      // a flip that never flips would pass every per-card arm.
      const placements = new Set();
      for (const which of ['first', 'last']) {
        const idx = which === 'first' ? 0 : n - 1;
        const wrapper = wrappers.nth(idx);
        const card = wrapper.locator('article').first();
        if (which === 'first') {
          await card.evaluate((el) => {
            window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 24));
          });
        } else {
          await card.scrollIntoViewIfNeeded();
        }
        await page.waitForTimeout(100);
        await card.getByRole('button', { name: 'More actions' }).click();
        // The menu fades in over 150 ms. The rule is that it BECOMES fully
        // visible, not that it does so inside a fixed delay: on the Linux
        // runner, with the lit cards' animations sharing the paint budget, a
        // 200 ms wait measured the fade mid-way and reported the menu as
        // invisible. Wait for the transition itself, bounded, then measure.
        await page
          .waitForFunction(
            () => {
              const open = document.querySelector(
                '[data-component="card-actions-menu"][data-open="true"]',
              );
              return open !== null && getComputedStyle(open).opacity === '1';
            },
            undefined,
            { timeout: 2000 },
          )
          .catch(() => undefined);
        await page.waitForTimeout(50);
        const measured = await card.evaluate(measureOpenMenu, opts);
        const shot = `${OUT}/menu-${which}-${width}.png`;
        await page.screenshot({ path: shot, fullPage: false });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(200);
        const stillOpen = await page.evaluate(openMenuCount);
        if (stillOpen !== 0)
          measured.violations.push({ kind: 'menu-did-not-close-on-escape', open: stillOpen });
        if (measured.placement !== undefined) placements.add(measured.placement);
        violationCount += measured.violations.length;
        report.menus.push({ width, which, shot, ...measured });
        process.stdout.write(
          `${String(width).padStart(3)}px menu ${which} → ${measured.placement ?? '?'} (room ${measured.room ?? '?'}) ` +
            `${measured.violations.length} violation(s)${measured.violations.length > 0 ? '  ✗' : ''}\n`,
        );
        for (const viol of measured.violations) {
          process.stdout.write(`      menu: ${JSON.stringify(viol)}\n`);
        }
        await page.evaluate(() => window.scrollTo(0, 0));
      }
      if (!(placements.has('below') && placements.has('above'))) {
        violationCount += 1;
        report.menus.push({ width, kind: 'menu-flip-not-exercised', placements: [...placements] });
        process.stdout.write(
          `${String(width).padStart(3)}px ✗ the menu flip was not exercised both ways (saw: ${[...placements].join(', ') || 'nothing'})\n`,
        );
      }

      // Rule 8 — the SHORT viewport (the app's minimum window height, tauri
      // minHeight 600): a top-row card's fullest menu (the MAX state: Clear…
      // expanded, 13 rows ≈ 344px) opens DOWNWARD into less room than its 350
      // cap. A fixed box cannot be scrolled into view by the grid (a grid
      // scroll CLOSES it), so the box must be capped to the viewport and every
      // row must be reachable by scrolling INSIDE the menu. Vacuity: the menu
      // must actually overflow its capped box — a short menu proves nothing.
      {
        const maxIdx = labels.findIndex((l) => /^max\b/i.test(l));
        if (maxIdx < 0) {
          violationCount += 1;
          report.menus.push({ width, kind: 'short-viewport-no-max-state' });
          process.stdout.write(
            `${String(width).padStart(3)}px ✗ no MAX state for the short-viewport menu pass\n`,
          );
        } else {
          await page.setViewportSize({ width: 1200, height: SHORT_VIEWPORT_HEIGHT });
          await page.waitForTimeout(100);
          const card = wrappers.nth(maxIdx).locator('article').first();
          await card.evaluate((el) => {
            window.scrollTo(0, Math.max(0, el.getBoundingClientRect().top + window.scrollY - 24));
          });
          await page.waitForTimeout(100);
          await card.getByRole('button', { name: 'More actions' }).click();
          await page.waitForTimeout(150);
          const group = page.locator(
            '[data-component="card-actions-menu"][data-open="true"] [aria-label^="Clearing options"]',
          );
          if ((await group.count()) === 1) {
            await group.click();
            await page.waitForTimeout(150);
          }
          const measured = await card.evaluate(measureOpenMenu, opts);
          const reach = await card.evaluate((el, edge) => {
            const toggle = el.querySelector('[aria-label="More actions"]');
            const menu = document.getElementById(toggle?.getAttribute('aria-controls') ?? '');
            if (menu === null) return { kind: 'missing' };
            const vh = document.documentElement.clientHeight;
            const m = menu.getBoundingClientRect();
            const rows = Array.from(menu.querySelectorAll('button')).filter((b) => !b.disabled);
            const unreachable = [];
            for (const row of rows) {
              row.scrollIntoView({ block: 'nearest' });
              const r = row.getBoundingClientRect();
              if (
                r.top < -0.5 ||
                r.bottom > vh + 0.5 ||
                r.top < m.top - 0.5 ||
                r.bottom > m.bottom + 0.5
              ) {
                unreachable.push({
                  label: row.getAttribute('aria-label'),
                  top: r.top,
                  bottom: r.bottom,
                });
              }
            }
            return {
              rows: rows.length,
              overflows: menu.scrollHeight > menu.clientHeight + 0.5,
              styleMaxHeight: menu.style.maxHeight,
              box: { top: m.top, bottom: m.bottom, h: m.height },
              vh,
              edge,
              unreachable,
            };
          }, MENU_VIEWPORT_EDGE_PX);
          if (reach.kind === 'missing') measured.violations.push({ kind: 'missing', what: 'menu' });
          else {
            if (!reach.overflows) {
              measured.violations.push({
                kind: 'short-viewport-menu-does-not-overflow',
                rows: reach.rows,
                box: reach.box,
              });
            }
            if (reach.styleMaxHeight === '') {
              measured.violations.push({ kind: 'short-viewport-menu-no-height-cap' });
            }
            if (reach.box.bottom > reach.vh - reach.edge + opts.tolerance) {
              measured.violations.push({
                kind: 'short-viewport-menu-past-edge',
                bottom: reach.box.bottom,
                vh: reach.vh,
              });
            }
            if (reach.unreachable.length > 0) {
              measured.violations.push({
                kind: 'short-viewport-rows-unreachable',
                rows: reach.unreachable,
              });
            }
          }
          const shot = `${OUT}/menu-short-${width}.png`;
          await page.screenshot({ path: shot, fullPage: false });
          await page.keyboard.press('Escape');
          await page.waitForTimeout(150);
          violationCount += measured.violations.length;
          report.menus.push({
            width,
            which: 'short',
            viewportHeight: SHORT_VIEWPORT_HEIGHT,
            shot,
            ...measured,
            reach,
          });
          process.stdout.write(
            `${String(width).padStart(3)}px menu short(${SHORT_VIEWPORT_HEIGHT}) → ${measured.placement ?? '?'} rows ${reach.rows ?? '?'} box ${reach.box ? `${Math.round(reach.box.top)}..${Math.round(reach.box.bottom)}` : '?'} ` +
              `${measured.violations.length} violation(s)${measured.violations.length > 0 ? '  ✗' : ''}\n`,
          );
          for (const viol of measured.violations) {
            process.stdout.write(`      menu: ${JSON.stringify(viol)}\n`);
          }
        }
      }
      await page.close();
    }
    // Phase D — the AI view at the windows a customer really runs. Same run,
    // same browser, its own contexts; see the block in this file's header.
    process.stdout.write(
      `\nAI view — ${AI_WINDOWS.map(([w, h]) => `${String(w)}x${String(h)}`).join(' / ')} in ${AI_THEMES.join(' + ')}\n`,
    );
    violationCount += await runAiWindowSweep(browser, report);
    // Phase E — the simulator window's own gallery scenes. Same run, same
    // browser; see the block above runSimulatorSweep for why its windows
    // differ from Phase D's.
    process.stdout.write(`\nSimulator window — ${SIMULATOR_THEMES.join(' + ')}\n`);
    violationCount += await runSimulatorSweep(browser, report);
  } finally {
    await browser.close();
    if (started !== null) started.kill();
  }
  report.violations = violationCount;
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  process.stdout.write(
    `\n${report.cards.length} card measurements across ${WIDTHS.join('/')}px and ` +
      `${report.aiWindows.length} AI-view cells (+${report.aiFontStress.length} re-measured at ` +
      `+${String(AI_FONT_STRESS_EM)}em of font stress) and ${report.simulatorWindows.length} ` +
      `simulator-window cells → ${violationCount} violation(s); report ${OUT}/report.json\n`,
  );
  if (violationCount > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
