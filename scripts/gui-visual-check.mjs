#!/usr/bin/env node
// Profiles-grid card GEOMETRY GATE (Phase A, 2026-09-11; Phase B the same day)
// — the only proof that "nothing is outside the box". Rewritten from the
// 2026-06-15 screenshot-only self-review: a screenshot can be looked at; this
// MEASURES.
//
// Renders the visual harness (apps/gui-client/visual-harness.html → the real
// ProfilePhoneCard, every state in gallery.tsx STATES) with each card pinned
// to 178 / 240 / 260 px via the gallery's `?w=` query, and for EVERY card,
// plain and hovered, asserts:
//   1. the phone screen (`[data-component="phone-screen"]`) and the body have
//      scrollWidth <= clientWidth AND scrollHeight <= clientHeight — nothing
//      inside wants to scroll in either axis (Phase B: the body no longer
//      scrolls; a fixed-height tile has no fold);
//   2. every `[data-component],[data-action],[data-udp],[data-region]` inside
//      the card article has a bounding box ⊆ the article's box (±0.5px) on ALL
//      FOUR sides — raw geometry, no scroll-container allowance any more. An
//      element hidden by opacity 0 (the closed ⋯ menu and its rows) is skipped
//      and counted: invisible is not "outside the box";
//   3. nothing is CUT AND UNREACHABLE: an overflow-hidden element whose content
//      exceeds its box is a violation unless it is a titled text clip
//      (truncate / line-clamp);
//   4. Phase B anatomy: the article is exactly CARD_HEIGHT (234px) tall at every
//      width, each `[data-region]` appears once in the order REGION_ORDER and
//      its clientHeight equals its budget, the dock (`[data-component=
//      "card-dock"]`) and the Launch button are outside the body;
//   5. the ⋯ menu, opened on the FIRST and the LAST card of every width: it
//      stays inside the viewport, flips DOWNWARD on the top row (< 320px of room
//      above the dock) and opens UPWARD further down, and closes on Escape.
// Elements with a 0×0 box (display:none — an absent spinner) are skipped and
// COUNTED, and a card that yields fewer than MIN_PROBES measurable elements is
// itself a violation: an empty page must not pass as a clean one.
//
// Output: `shot-<state>-<width>.png` per card (plus `menu-<pos>-<width>.png`)
// and `report.json` in OUT_DIR. Exit 1 on any violation (each printed), exit 0
// only on a full clean sweep.
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
const PROBE_SELECTOR = '[data-component],[data-action],[data-udp],[data-region]';
// Phase B anatomy — the numbers the design panel judged. The article is
// border 2 + padding 12 + screen 220; the screen is body 173 + dock 47; the
// body is padding 12 + regions 142 + gaps 21.
const CARD_HEIGHT = 234;
const REGION_BUDGET = { identity: 38, status: 20, exit: 18, via: 16, caps: 20, when: 14, meta: 16 };
const REGION_ORDER = ['identity', 'status', 'exit', 'via', 'caps', 'when', 'meta'];
// The room above the dock (inside the scroller) below which the menu opens
// downward — mirrors MENU_FLIP_ROOM_PX in ProfilePhoneCard.tsx.
const MENU_FLIP_ROOM_PX = 360; // polish: card grew to 360 with the menu open;
// select-indicator, phone-screen, card-body, seven regions, health-pill,
// card-dock, card-actions-menu — a real card always yields more than this.
const MIN_PROBES = 12;
const MIN_STATES = 8;

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
 *    "below the fold but reachable" any more. Elements hidden by opacity 0 (the
 *    closed ⋯ menu) are skipped and counted as `invisible`.
 *  • CONTENT-LOST — an element that clips (overflow hidden/clip) but does not
 *    scroll, whose scrollHeight/scrollWidth exceeds its client box: something is
 *    cut and nothing can bring it back. Deliberate text clips (text-overflow:
 *    ellipsis, -webkit-line-clamp) are exempt from the size rule but must carry
 *    a title on themselves or an ancestor (CLAMPED-WITHOUT-TITLE otherwise).
 *  • SCROLLS — the screen or the body wants a scroll in either axis at all.
 *  • ANATOMY — article height, region presence/order/budgets, dock and Launch
 *    outside the body.
 */
function measureCard(article, opts) {
  const { tolerance, probeSelector, cardHeight, regionBudget, regionOrder } = opts;
  const round = (n) => Math.round(n * 100) / 100;
  const describe = (el) => {
    const marks = ['data-component', 'data-action', 'data-udp', 'data-region']
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
  if (dock === null) {
    violations.push({ kind: 'missing', what: 'card-dock' });
  } else if (body !== null && body.contains(dock)) {
    violations.push({ kind: 'dock-inside-body' });
  }
  const launch = Array.from(article.querySelectorAll('button')).find((b) =>
    /^(Launch|Launching…|Open session)$/.test((b.textContent ?? '').trim().replace(/^↻\s*/, '')),
  );
  if (launch === undefined) {
    violations.push({ kind: 'missing', what: 'launch-button' });
  } else if (body !== null && body.contains(launch)) {
    violations.push({ kind: 'launch-inside-body' });
  }

  // Rule 1 — ESCAPED, all four sides, raw geometry.
  let probed = 0;
  let skipped = 0;
  let invisibleCount = 0;
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
    const over = {
      left: round(a.left - b.left),
      right: round(b.right - a.right),
      top: round(a.top - b.top),
      bottom: round(b.bottom - a.bottom),
    };
    if (Math.max(over.left, over.right, over.top, over.bottom) > tolerance) {
      violations.push({ kind: 'escaped', el: describe(el), over });
    }
  }
  if (probed < opts.minProbes) {
    violations.push({ kind: 'too-few-probes', probed, minProbes: opts.minProbes });
  }

  // Rule 2 — CONTENT-LOST / CLAMPED-WITHOUT-TITLE, over EVERY visible descendant.
  for (const el of article.querySelectorAll('*')) {
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
    probed,
    skipped,
    invisible: invisibleCount,
    violations,
  };
}

/** Runs INSIDE the page with the ⋯ menu OPEN on one card: the menu is allowed
 *  to leave the card (it is a popover) but not the viewport, and it must have
 *  flipped the way the room above the dock dictates. */
function measureOpenMenu(article, opts) {
  const round = (n) => Math.round(n * 100) / 100;
  const violations = [];
  const menu = article.querySelector('[data-component="card-actions-menu"]');
  const dock = article.querySelector('[data-component="card-dock"]');
  if (menu === null || dock === null) {
    return { violations: [{ kind: 'missing', what: menu === null ? 'menu' : 'dock' }] };
  }
  if (menu.getAttribute('data-open') !== 'true') violations.push({ kind: 'menu-not-open' });
  if (getComputedStyle(menu).opacity !== '1') violations.push({ kind: 'menu-not-visible' });
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
    cardHeight: CARD_HEIGHT,
    regionBudget: REGION_BUDGET,
    regionOrder: REGION_ORDER,
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
      for (let i = 0; i < n; i += 1) {
        const wrapper = wrappers.nth(i);
        const label = (await wrapper.getAttribute('data-state')) ?? `state-${i}`;
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
        const shot = `${OUT}/shot-${slug}-${width}.png`;
        await card.screenshot({ path: shot });
        await page.mouse.move(0, 0);
        heights.add(plain.card.h);
        const entry = { width, index: i, label, shot, plain, hovered };
        report.cards.push(entry);
        const v = plain.violations.length + hovered.violations.length;
        violationCount += v;
        process.stdout.write(
          `${String(width).padStart(3)}px ${plain.card.w}x${plain.card.h} [${label}] ` +
            `plain ${plain.violations.length} (probed ${plain.probed}, skipped ${plain.skipped}` +
            `, invisible ${plain.invisible}) · hover ${hovered.violations.length}${v > 0 ? '  ✗' : ''}\n`,
        );
        for (const pass of ['plain', 'hovered']) {
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

      // Rule 5 — the ⋯ menu on the top row scrolled to the top of the viewport
      // (< 320px above the dock → opens downward) and on the last card scrolled
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
        const stillOpen = await card
          .locator('[data-component="card-actions-menu"]')
          .getAttribute('data-open');
        if (stillOpen !== 'false')
          measured.violations.push({ kind: 'menu-did-not-close-on-escape' });
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
