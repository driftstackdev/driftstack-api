#!/usr/bin/env node
// Profiles-grid card GEOMETRY GATE (Phase A, 2026-09-11) — the only proof that
// "nothing is outside the box". Rewritten from the 2026-06-15 screenshot-only
// self-review: a screenshot can be looked at; this MEASURES.
//
// Renders the visual harness (apps/gui-client/visual-harness.html → the real
// ProfilePhoneCard, every state in gallery.tsx STATES) with each card pinned
// to 178 / 240 / 260 px via the gallery's `?w=` query, and for EVERY card,
// plain and hovered, asserts:
//   1. the phone screen (`[data-component="phone-screen"]`) and the body have
//      scrollWidth <= clientWidth — nothing inside wants to scroll sideways;
//   2. every `[data-component],[data-action],[data-udp],[data-region]` inside
//      the card article has a bounding box ⊆ the article's box (±0.5px) —
//      horizontally as raw geometry; vertically, an element inside a SCROLL
//      container (the body, the ⋯ menu) is judged against that container's
//      reachable content and counted as `belowFold` when it is under the fold
//      (see measureCard for why that is the honest reading of Phase A);
//   3. nothing is CUT AND UNREACHABLE: an overflow-hidden element whose content
//      exceeds its box is a violation unless it is a titled text clip
//      (truncate / line-clamp) or the tags row, which is reported as
//      clippedByDesign rather than passed in silence.
// Elements with a 0×0 box (display:none — the hidden hover row, an absent
// spinner) are skipped and COUNTED, and a card that yields fewer than
// MIN_PROBES measurable elements is itself a violation: an empty page must
// not pass as a clean one.
//
// Output: `shot-<state>-<width>.png` per card plus `report.json` in OUT_DIR.
// Exit 1 on any violation (each printed), exit 0 only on a full clean sweep.
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
// select-indicator, phone-screen, card-body, egress-widget (or the no-proxy
// row's absence), card-actions-menu — a real card always yields more than this.
const MIN_PROBES = 4;
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
 *  Three rules, each measuring a different way content leaves the box:
 *  • ESCAPED — a probe element's box past the article's. Horizontally this is
 *    raw geometry: nothing may be wider than the card, clipped or not. Vertically
 *    an element inside a SCROLL container (overflow-y auto/scroll — the body, the
 *    ⋯ menu) is judged against that container's scrollable content, because
 *    "below the fold but reachable" is the design Phase A keeps (R1: the aspect
 *    ratio stays; R2: the body scrolls) — those are COUNTED as belowFold so the
 *    report says so, and Phase B's card-grows-to-fit is measured by that number.
 *  • CONTENT-LOST — an element that clips (overflow hidden/clip) but does not
 *    scroll, whose scrollHeight/scrollWidth exceeds its client box: something is
 *    cut and nothing can bring it back. Deliberate text clips (text-overflow:
 *    ellipsis, -webkit-line-clamp) are exempt from the size rule but must carry
 *    a title on themselves or an ancestor (CLAMPED-WITHOUT-TITLE otherwise). The
 *    tags row is the ONE whole-element clip kept in Phase A (its "+N" tail is
 *    Phase B's); it is reported as clippedByDesign, never as a pass by silence.
 *  • SCROLLS-X — the screen or the body wants a horizontal scroll at all.
 */
function measureCard(article, opts) {
  const { tolerance, probeSelector } = opts;
  const round = (n) => Math.round(n * 100) / 100;
  const describe = (el) => {
    const marks = ['data-component', 'data-action', 'data-udp', 'data-region']
      .map((a) => (el.hasAttribute(a) ? `${a}=${el.getAttribute(a)}` : null))
      .filter((x) => x !== null)
      .join(' ');
    const txt = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 40);
    return `${el.tagName.toLowerCase()}[${marks}]${txt ? ` "${txt}"` : ''}`;
  };
  const scrolls = (cs) => cs.overflowY === 'auto' || cs.overflowY === 'scroll';
  const nearestScroller = (el) => {
    for (let n = el.parentElement; n !== null && n !== article; n = n.parentElement) {
      if (scrolls(getComputedStyle(n))) return n;
    }
    return null;
  };
  const a = article.getBoundingClientRect();
  const violations = [];
  const clippedByDesign = [];
  let belowFold = 0;

  const screen = article.querySelector('[data-component="phone-screen"]');
  if (screen === null) {
    violations.push({ kind: 'missing', what: 'phone-screen' });
  } else if (screen.scrollWidth > screen.clientWidth) {
    violations.push({
      kind: 'screen-scrolls-x',
      scrollWidth: screen.scrollWidth,
      clientWidth: screen.clientWidth,
    });
  }
  const body = article.querySelector('[data-component="card-body"]');
  if (body === null) {
    violations.push({ kind: 'missing', what: 'card-body' });
  } else if (body.scrollWidth > body.clientWidth) {
    violations.push({
      kind: 'body-scrolls-x',
      scrollWidth: body.scrollWidth,
      clientWidth: body.clientWidth,
    });
  }

  // Rule 1 — ESCAPED.
  let probed = 0;
  let skipped = 0;
  for (const el of article.querySelectorAll(probeSelector)) {
    const b = el.getBoundingClientRect();
    if (b.width === 0 && b.height === 0) {
      skipped += 1;
      continue;
    }
    probed += 1;
    const over = { left: round(a.left - b.left), right: round(b.right - a.right) };
    const scroller = nearestScroller(el);
    if (scroller === null) {
      over.top = round(a.top - b.top);
      over.bottom = round(b.bottom - a.bottom);
    } else {
      // Reachable = inside the scroller's CONTENT box (its top, minus what is
      // already scrolled, down to its full scrollHeight).
      const s = scroller.getBoundingClientRect();
      const contentTop = s.top - scroller.scrollTop;
      over.top = round(contentTop - b.top);
      over.bottom = round(b.bottom - (contentTop + scroller.scrollHeight));
      if (b.bottom > s.bottom + tolerance) belowFold += 1;
    }
    if (Math.max(over.left, over.right, over.top, over.bottom) > tolerance) {
      violations.push({ kind: 'escaped', el: describe(el), over });
    }
  }
  if (probed < opts.minProbes) {
    violations.push({ kind: 'too-few-probes', probed, minProbes: opts.minProbes });
  }

  // Rule 2 — CONTENT-LOST / CLAMPED-WITHOUT-TITLE, over EVERY descendant.
  for (const el of article.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none') continue;
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
    const entry = {
      el: describe(el),
      scroll: [el.scrollWidth, el.scrollHeight],
      client: [el.clientWidth, el.clientHeight],
    };
    if (el.getAttribute('data-component') === 'tags-row' && !lostX) {
      clippedByDesign.push(entry);
    } else {
      violations.push({ kind: 'content-lost', ...entry });
    }
  }

  return {
    card: { w: round(a.width), h: round(a.height) },
    screen:
      screen === null ? null : { scrollWidth: screen.scrollWidth, clientWidth: screen.clientWidth },
    body:
      body === null
        ? null
        : {
            scrollHeight: body.scrollHeight,
            clientHeight: body.clientHeight,
            scrollWidth: body.scrollWidth,
            clientWidth: body.clientWidth,
          },
    probed,
    skipped,
    belowFold,
    clippedByDesign,
    violations,
  };
}

async function main() {
  if (WIDTHS.length === 0) throw new Error('WIDTHS resolved to nothing');
  await mkdir(OUT, { recursive: true });
  const started = await ensureHarness();
  const browser = await chromium.launch();
  const report = { url: URL, widths: WIDTHS, tolerance: TOLERANCE, cards: [] };
  let violationCount = 0;
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
      for (let i = 0; i < n; i += 1) {
        const wrapper = wrappers.nth(i);
        const label = (await wrapper.getAttribute('data-state')) ?? `state-${i}`;
        const slug = label
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-|-$/g, '')
          .slice(0, 48);
        const card = wrapper.locator('article').first();
        const opts = { tolerance: TOLERANCE, probeSelector: PROBE_SELECTOR, minProbes: MIN_PROBES };
        await page.mouse.move(0, 0);
        const plain = await card.evaluate(measureCard, opts);
        await card.hover();
        await page.waitForTimeout(150);
        const hovered = await card.evaluate(measureCard, opts);
        const shot = `${OUT}/shot-${slug}-${width}.png`;
        await card.screenshot({ path: shot });
        await page.mouse.move(0, 0);
        const entry = { width, index: i, label, shot, plain, hovered };
        report.cards.push(entry);
        const v = plain.violations.length + hovered.violations.length;
        violationCount += v;
        process.stdout.write(
          `${String(width).padStart(3)}px ${plain.card.w}x${plain.card.h} [${label}] ` +
            `plain ${plain.violations.length} (probed ${plain.probed}, skipped ${plain.skipped}` +
            `, belowFold ${plain.belowFold}, clippedByDesign ${plain.clippedByDesign.length}) · ` +
            `hover ${hovered.violations.length} (belowFold ${hovered.belowFold})${v > 0 ? '  ✗' : ''}\n`,
        );
        for (const pass of ['plain', 'hovered']) {
          for (const viol of entry[pass].violations) {
            process.stdout.write(`      ${pass}: ${JSON.stringify(viol)}\n`);
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
