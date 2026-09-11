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
// Output: `shot-<state>-<width>.png` per card, `shot-sheet-<width>.png` (the
// MAX card with its sheet open), `menu-<pos>-<width>.png`, and `report.json`
// in OUT_DIR. Exit 1 on any violation (each printed), exit 0 only on a full
// clean sweep.
//
// Usage (repo root): `node scripts/gui-visual-check.mjs`
//   HARNESS_URL  default http://127.0.0.1:5199/visual-harness.html — when it
//                does not answer, this script starts `vite --port 5199` from
//                apps/gui-client itself and stops it when done.
//   OUT_DIR      default <tmpdir>/driftstack-visual-check
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
const OUT = process.env.OUT_DIR ?? resolve(tmpdir(), 'driftstack-visual-check');
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
            await page.waitForTimeout(150);
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
          await page.waitForTimeout(150);
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
        await page.waitForTimeout(200);
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
  } finally {
    await browser.close();
    if (started !== null) started.kill();
  }
  report.violations = violationCount;
  await writeFile(`${OUT}/report.json`, JSON.stringify(report, null, 1));
  process.stdout.write(
    `\n${report.cards.length} card measurements across ${WIDTHS.join('/')}px → ${violationCount} violation(s); report ${OUT}/report.json\n`,
  );
  if (violationCount > 0) process.exit(1);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exit(1);
});
