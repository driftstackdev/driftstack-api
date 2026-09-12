#!/usr/bin/env node
// Marketing screen captures (2026-09-11) — REAL renders of the desktop app's
// components for the marketing site (apps/marketing-site), replacing the
// hand-drawn GUI depictions that had drifted from the shipped app.
//
// What it captures: the visual harness (apps/gui-client/visual-harness.html →
// src/visual-harness/gallery.tsx) with `?scene=<name>`, which renders ONE
// composition inside the app's real window chrome (TitleBar + Sidebar, dark +
// oxblood) at a fixed stage (1280×800; the list view 1800×880 so its ~1490px
// table fits with the Actions column in frame and every row above the fold), from the same React components
// and the same CSS the Tauri app ships. Scenes:
//   profiles-grid    Profiles view framing around the real ProfilePhoneCard grid
//                    (8 curated states, ≥ 3 columns) — also cropped to a hero
//   profiles-list    the same framing around ProfilesTable (the grid's 8 profiles)
//   proxies          the Proxies view framing around the three ProxyForm editors
//   simulator        the desktop app window with the floating device window
//                    lifted over it: DeviceToolbar + the phone screen showing
//                    an example shop page under the on-screen iOS keyboard +
//                    the Egress readouts
//   billing          Usage & cost (CostPanel) in the Billing framing
//   command-center   the Command Center header band + KPI strip
//
// ⛔ PRIVACY: nothing here is a real session, proxy, exit or account — the
// scenes are fixtures (*.example.com hosts, RFC 5737 TEST-NET exits,
// ops@example.com). The jsdom guard tests/unit/marketing-scenes.test.tsx scans
// every scene's text for vendor hosts and non-TEST-NET IPv4s.
//
// DETERMINISM: the page clock is fixed at FROZEN_NOW_ISO (Playwright
// `page.clock.setFixedTime`, and the harness pins `Date.now` itself), the
// context asks for reduced motion (index.css then clamps every animation and
// transition to 0.01ms), the locale/timezone are pinned, and a macOS user
// agent is set so the TitleBar reserves the traffic-light clearance on any
// host. Fonts: the app does not bundle Geist / Berkeley Mono, so it renders
// with its fallback stack — on macOS that is the system font, which is what
// the shipped macOS app shows. Regenerate on macOS. `--verify` re-renders and
// compares pixel-for-pixel against the files on disk (exit 1 on any diff).
//
// Output (OUT_DIR, default apps/marketing-site/src/assets/screens):
//   <scene>.png + <scene>.webp     2560×1600 (1280×800 @2x); profiles-list 3600×1760
//   profiles-grid-hero.png/.webp   the card grid region of profiles-grid @2x
//   manifest.json                  every file with its pixel size
//
// Usage (repo root):  node scripts/marketing-screens.mjs [--verify]
//                     [--scenes=profiles-grid,proxies]
//   HARNESS_URL  default http://127.0.0.1:5199/visual-harness.html — when it
//                does not answer, this script starts `vite --port 5199` from
//                apps/gui-client itself and stops it when done.
//   OUT_DIR      default apps/marketing-site/src/assets/screens
//
// Playwright + sharp are repo-root devDependencies; run from the repo root.

import { chromium } from 'playwright';
import sharp from 'sharp';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HARNESS_PORT ?? 5199);
const URL = process.env.HARNESS_URL ?? `http://127.0.0.1:${PORT}/visual-harness.html`;
const OUT = resolve(REPO_ROOT, process.env.OUT_DIR ?? 'apps/marketing-site/src/assets/screens');

/** Mirrors FROZEN_NOW_ISO / sceneSize() in gallery.tsx. Not trusted blindly:
 *  every stage carries `data-frozen-now` / `data-stage-width` / `-height`, and
 *  renderScene fails when the harness and this table disagree — a drift on
 *  either side stops the capture instead of shipping a frame at the wrong
 *  instant or size. */
const FROZEN_NOW_ISO = '2026-06-15T06:42:00.000Z';
const STAGE = { width: 1280, height: 800 };
const LIST_STAGE = { width: 1800, height: 880 };
const DPR = 2;
const WEBP_QUALITY = 90;
/** CSS px of breathing room around the grid in the hero crop. */
const HERO_PAD = 12;
/** CSS px of slack the `above` geometry fact allows at a shared edge between
 *  two flush siblings — a fractional layout boundary is not an overlay. */
const SEAM_PX = 1;
const MAC_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Every scene, with the guard that proves the capture is the composition it
 *  claims to be (an empty stage screenshots just fine — the guard is what
 *  makes a blank page fail instead of shipping). */
const SCENES = [
  {
    name: 'profiles-grid',
    hero: 'profiles-grid-hero',
    guard: {
      selector: '[data-scene-region="grid"] article',
      count: 8,
      minColumns: 3,
    },
  },
  {
    name: 'profiles-list',
    stage: LIST_STAGE,
    // 8 rows (the grid's profiles) AND the table fits its shell: the shell is
    // the app's own overflow-x-auto, so a table wider than the window scrolls
    // in the app but is simply cut off in a screenshot — the first capture
    // shipped that way (no Launch button in frame). scrollWidth must equal
    // clientWidth on the shell.
    guard: { selector: '[data-scene-region="list"] tbody tr', count: 8 },
    fits: '[data-scene-region="list"] .ds-table-shell',
    // …and vertically: the window's main pane must not scroll either, or the
    // last rows are cut at the frame (a six-tag row wrapped to four lines
    // once the Actions column widened, and the eighth row fell off at 800).
    fitsY: '[data-scene="profiles-list"] main',
  },
  {
    name: 'proxies',
    // 3 editors, AND both tunnel editors show their saved config (the
    // WireGuard summary line; the OpenVPN box holds the blob) — an edit-mode
    // editor without one is a state the app cannot produce.
    guard: { selector: '[data-scene-region="proxy-forms"] form', count: 3 },
    also: [
      { selector: '[data-component="wg-saved-summary"]', count: 1 },
      { selector: '[data-scene-region="proxy-forms"] textarea', minValueMatch: /^client\n/ },
    ],
  },
  {
    name: 'simulator',
    // 2026-09-12 — the scene is now TWO windows: the desktop app's own window
    // filling the stage, with the floating device window lifted over it.
    // ⚠️ The guard this replaces was ONE 4-selector union with `count: 4`, a
    // sum: two toolbars plus a missing readout also totals 4, and the failure
    // message could only name the whole union. Every fact below is its own
    // selector with its own count, so a red says which half went.
    guard: { selector: '[data-component="scene-simulator-window"]', count: 1 },
    also: [
      // The desktop app itself — the same chrome every other scene wears —
      // with a real view behind, not an empty frame around the device window.
      { selector: '[data-scene="simulator"] aside nav[aria-label="Primary"]', count: 1 },
      { selector: '[data-scene="simulator"] main', count: 1, minText: 120 },
      // …and the view inside that pane is really the profiles grid. `main`'s
      // minText is NOT that fact: measured on the live harness, main renders
      // 1203 characters of which the grid is 1017 — delete every card and the
      // ProfilesFrame header alone still leaves 186, so an EMPTY grid clears a
      // 120 floor. This count is the "the app half was not emptied" assertion.
      { selector: '[data-scene="simulator"] [data-scene-region="grid"] article', count: 8 },
      // The floating window's own parts, unchanged by the recomposition.
      { selector: '[data-component="simulator-toolbar"]', count: 1 },
      { selector: '[data-component="simulator-running-indicator"]', count: 1 },
      { selector: '[data-component="ios-keyboard"]', count: 1 },
      // ⛔ The phone screen shows a PAGE. The capture that shipped 2026-09-11
      // had `simulator-screen-host` empty and `bg-black`, which on the
      // marketing page read as a broken app — "present" is not enough, so
      // minText measures what it renders (and that the box is painted at all).
      // The floor is set from the DEGRADED state, not from zero: measured, the
      // page renders 205 characters, of which the four product tiles are 151 —
      // its chrome alone (the address bar, the search term, the store name and
      // the result count) is 54, so a 40 floor passed with NO products on the
      // page, which is the one thing the alt text and S2 promise it shows.
      // (The tiles themselves — four, priced, in one currency, exactly what
      // SIMULATOR_ALT reads aloud — are counted in marketing-scenes.test.tsx.)
      {
        selector:
          '[data-component="simulator-screen-host"] [data-component="simulator-screen-page"]',
        count: 1,
        minText: 150,
      },
      // The Egress readouts, one assertion each.
      { selector: '[data-component="sim-exit-ip-chip"][data-state="observed"]', count: 1 },
      { selector: '[data-component="sim-webrtc-candidates"][data-leak="false"]', count: 1 },
      { selector: '[data-component="sim-quic-readout"][data-state="observed"]', count: 1 },
      { selector: '[data-component="sim-os-readout"][data-state="observed"]', count: 1 },
    ],
    // The app window's pane must not scroll on either axis: what scrolls in
    // the app is simply CUT OFF in a screenshot (this is how the profiles-list
    // clipping was caught).
    fits: '[data-scene="simulator"] main',
    fitsY: '[data-scene="simulator"] main',
    geometry: [
      // The device window sits OVER the app window — the fact that separates
      // this composition from the old one (a lone window on empty ground).
      // ⚠️ It does NOT also prove the app half survived: `b` is the app's
      // pane, whose rect is fixed by flex layout and identical whether it
      // holds the grid or nothing. "Not replaced" is the 8-article count above.
      {
        kind: 'overlaps',
        a: '[data-component="scene-simulator-window"]',
        b: '[data-scene="simulator"] main',
        minPx: 80,
      },
      // …and does not SWALLOW it. `overlaps` is only a lower bound: a window
      // grown to fill the stage overlaps by 1056×764 and still passes every
      // count, minText and overflow guard here, because none of them can see
      // what is painted over. The section's picture is both halves at once.
      // Measured today: 600×728 of main's 1056×764 = 54.1% (it was 47.5% at
      // 552×694, before the window grew by the drawer rail — which is why the
      // ceiling is not pinned tight to today's number: the regression it
      // exists to catch is a window filling the pane, at ~100%).
      {
        kind: 'maxCover',
        a: '[data-component="scene-simulator-window"]',
        b: '[data-scene="simulator"] main',
        maxPct: 70,
      },
      // …and wholly inside the stage. The stage clips (overflow-hidden) and
      // `fits`/`fitsY` measure scroll extent, which only ever grows right and
      // down — a window pushed off the TOP or LEFT edge is cropped in the
      // frame and no scroll measurement ever sees it.
      {
        kind: 'inside',
        a: '[data-component="scene-simulator-window"]',
        b: '[data-scene="simulator"]',
      },
      // The SAME hazard one level in: the floating window is overflow-hidden
      // around a fixed-height body, so a drawer that outgrows it is cropped at
      // the window edge — and a cropped element still matches its `count`
      // guard above. The last readout in the drawer stands for the column.
      // (Measured: it ends at y674, the window at y776 — 102px of slack.)
      {
        kind: 'inside',
        a: '[data-component="sim-os-readout"]',
        b: '[data-component="scene-simulator-window"]',
      },
      // The drawn page sits UNDER the keyboard exactly as the real video host
      // does — the keyboard is the host's sibling, never a layer over it.
      // ORDERED on purpose: "they do not overlap" is also true of a keyboard
      // moved ABOVE the screen, which is not what this sentence claims.
      {
        kind: 'above',
        a: '[data-component="simulator-screen-host"]',
        b: '[data-component="ios-keyboard"]',
      },
      // …and the seam between the two windows lands BETWEEN the app's
      // controls, never through one. This is the guard the composition was
      // missing: every fact above is about the two window rects, and a
      // half-covered Launch button satisfies all of them. The minCount is the
      // vacuity control — a selector that stops matching would otherwise
      // report "no sliced controls" with perfect confidence.
      {
        kind: 'noPartialCover',
        a: '[data-component="scene-simulator-window"]',
        b: '[data-scene="simulator"] main button',
        minCount: 12,
      },
    ],
  },
  {
    name: 'billing',
    guard: { selector: '[data-scene="billing"] table, [data-scene="billing"] h2', min: 1 },
  },
  {
    name: 'command-center',
    guard: { selector: '[data-scene="command-center"] h1', count: 1 },
  },
];

const args = process.argv.slice(2);
const VERIFY = args.includes('--verify');
const only = args.find((a) => a.startsWith('--scenes='))?.slice('--scenes='.length);
const selected =
  only === undefined
    ? SCENES
    : SCENES.filter((s) =>
        only
          .split(',')
          .map((x) => x.trim())
          .includes(s.name),
      );
if (selected.length === 0) {
  throw new Error(`--scenes matched nothing; known: ${SCENES.map((s) => s.name).join(', ')}`);
}

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

/** Runs INSIDE the page: the guard's element count and the distinct column
 *  x-offsets (for the grid's "≥ 3 columns" claim). */
function measureGuard(selector) {
  const els = Array.from(document.querySelectorAll(selector));
  const xs = new Set(els.map((el) => Math.round(el.getBoundingClientRect().x)));
  return { count: els.length, columns: xs.size };
}
/** Runs INSIDE the page: does the element's content fit without scrolling
 *  (what a screenshot can show), on both axes? */
function measureFits(selector) {
  const el = document.querySelector(selector);
  if (el === null) return null;
  return {
    scrollWidth: el.scrollWidth,
    clientWidth: el.clientWidth,
    scrollHeight: el.scrollHeight,
    clientHeight: el.clientHeight,
  };
}
/** Runs INSIDE the page: the values of every matched textarea/input. */
function readValues(selector) {
  return Array.from(document.querySelectorAll(selector)).map((el) => el.value ?? '');
}
/** Runs INSIDE the page: what each match actually RENDERS — its text and its
 *  painted box. "Present" is not "painted": an element that is empty, 0×0 or
 *  display:none screenshots exactly like the empty ground it was meant to
 *  replace, and a `count` guard on it passes either way. */
function measureRendered(selector) {
  return Array.from(document.querySelectorAll(selector)).map((el) => {
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return {
      chars: (el.textContent ?? '').replace(/\s+/g, ' ').trim().length,
      width: Math.round(r.width),
      height: Math.round(r.height),
      hidden: cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0,
    };
  });
}
/** Runs INSIDE the page: one element's rectangle in CSS px (null when the
 *  selector matches nothing — the caller fails loudly rather than comparing
 *  against a default). */
function measureRect(selector) {
  const el = document.querySelector(selector);
  if (el === null) return null;
  const r = el.getBoundingClientRect();
  return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height };
}
/** Runs INSIDE the page: EVERY match, not the first. `noPartialCover` asks a
 *  question about a whole set of controls, and a set read as one element is
 *  the guard silently narrowing to whichever button happens to come first. */
function measureAllRects(selector) {
  return Array.from(document.querySelectorAll(selector)).map((el) => {
    const r = el.getBoundingClientRect();
    return {
      x: r.x,
      y: r.y,
      right: r.right,
      bottom: r.bottom,
      width: r.width,
      height: r.height,
      label: (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 32),
    };
  });
}

/** Runs INSIDE the page: what the stage says about itself. */
function readStageAttrs(selector) {
  const el = document.querySelector(selector);
  if (el === null) return null;
  return {
    frozenNow: el.getAttribute('data-frozen-now'),
    width: Number(el.getAttribute('data-stage-width')),
    height: Number(el.getAttribute('data-stage-height')),
  };
}

/** The geometry a screenshot cannot prove about itself, and jsdom cannot
 *  measure at all (tests/unit/marketing-scenes.test.tsx has no layout): which
 *  box sits over which, and whether anything is about to be cropped at the
 *  frame edge. Each fact names ONE pair and fails with its own message. */
async function checkGeometry(page, scene) {
  for (const fact of scene.geometry ?? []) {
    const [a, b] = await Promise.all([
      page.evaluate(measureRect, fact.a),
      page.evaluate(measureRect, fact.b),
    ]);
    if (a === null) {
      throw new Error(`${scene.name}: nothing matches "${fact.a}" (${fact.kind} guard)`);
    }
    if (b === null) {
      throw new Error(`${scene.name}: nothing matches "${fact.b}" (${fact.kind} guard)`);
    }
    const overlapX = Math.round(Math.min(a.right, b.right) - Math.max(a.x, b.x));
    const overlapY = Math.round(Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y));
    if (fact.kind === 'overlaps') {
      const min = fact.minPx ?? 1;
      if (overlapX < min || overlapY < min) {
        throw new Error(
          `${scene.name}: "${fact.a}" overlaps "${fact.b}" by ${overlapX}×${overlapY}px, expected ≥ ${min}px on both axes — it is meant to sit OVER it, not beside it`,
        );
      }
    } else if (fact.kind === 'maxCover') {
      // The upper bound `overlaps` cannot express: how much of b the overlay
      // HIDES. b's own area, not the intersection of the two rects, is the
      // denominator — a 0-area b means the measurement is broken, so it reads
      // as fully covered and fails rather than dividing to a quiet 0%.
      const area = Math.round(b.width) * Math.round(b.height);
      const covered = Math.max(0, overlapX) * Math.max(0, overlapY);
      const pct = area === 0 ? 100 : Math.round((covered / area) * 1000) / 10;
      if (pct > fact.maxPct) {
        throw new Error(
          `${scene.name}: "${fact.a}" covers ${pct}% of "${fact.b}" (${overlapX}×${overlapY}px of ${Math.round(b.width)}×${Math.round(b.height)}), more than the ${fact.maxPct}% this composition allows — the frame is meant to show BOTH, and a count guard cannot see what is painted over`,
        );
      }
    } else if (fact.kind === 'above') {
      // Ordered, not merely disjoint. SEAM_PX of tolerance because flush
      // siblings can land on a fractional boundary (the two boxes measured
      // here share an edge exactly today, y576); anything actually painting
      // over the other does so by hundreds of px, never by one.
      if (a.bottom > b.y + SEAM_PX) {
        throw new Error(
          `${scene.name}: "${fact.a}" ends at y${Math.round(a.bottom)} but "${fact.b}" starts at y${Math.round(b.y)} (overlap ${overlapX}×${overlapY}px) — the first is meant to sit entirely ABOVE the second, not over or under it`,
        );
      }
    } else if (fact.kind === 'inside') {
      const outside = [
        ['left', Math.round(b.x - a.x)],
        ['top', Math.round(b.y - a.y)],
        ['right', Math.round(a.right - b.right)],
        ['bottom', Math.round(a.bottom - b.bottom)],
      ].filter(([, px]) => px > 0);
      if (outside.length > 0) {
        throw new Error(
          `${scene.name}: "${fact.a}" hangs ${outside.map(([side, px]) => `${px}px off the ${side}`).join(', ')} of "${fact.b}" — that container is overflow-hidden, so it is cropped out of the frame, not scrolled`,
        );
      }
    } else if (fact.kind === 'noPartialCover') {
      // A window laid over an app either covers a control or it does not.
      // HALF a control is the one state the app itself can never produce, and
      // it is what every other guard here is blind to: `inside`, `overlaps`
      // and `maxCover` all measure the two WINDOW rects and say nothing about
      // where the seam between them lands. Shrink the floating window by 34px
      // and its top edge slices the Import / New profile buttons clean in
      // half; counts, minText, fits, fitsY and all three geometry facts above
      // stay green (measured 2026-09-12 by mutating bodyH 694 → 660).
      const controls = await page.evaluate(measureAllRects, fact.b);
      if (controls.length < (fact.minCount ?? 1)) {
        throw new Error(
          `${scene.name}: "${fact.b}" matched ${controls.length} element(s), fewer than the ${fact.minCount ?? 1} this guard is meant to be watching — it cannot report a sliced control it never measured`,
        );
      }
      const sliced = controls
        .map((c) => {
          const ox = Math.min(a.right, c.right) - Math.max(a.x, c.x);
          const oy = Math.min(a.bottom, c.bottom) - Math.max(a.y, c.y);
          if (ox <= SEAM_PX || oy <= SEAM_PX) return null; // clear of the window
          const whole = ox >= c.width - SEAM_PX && oy >= c.height - SEAM_PX;
          return whole ? null : { c, ox: Math.round(ox), oy: Math.round(oy) };
        })
        .filter((x) => x !== null);
      if (sliced.length > 0) {
        throw new Error(
          `${scene.name}: "${fact.a}" cuts ${String(sliced.length)} control(s) of "${fact.b}" in half — ` +
            sliced
              .map(
                ({ c, ox, oy }) =>
                  `"${c.label}" (${Math.round(c.width)}×${Math.round(c.height)}, ${ox}×${oy}px covered)`,
              )
              .join(', ') +
            ' — a window over an app covers a control or clears it; half of one is a state the app cannot produce',
        );
      }
    } else {
      // An unknown kind is a typo in the table above; it must not read as "no
      // geometry to check".
      throw new Error(`${scene.name}: unknown geometry guard kind "${String(fact.kind)}"`);
    }
  }
}

async function renderScene(context, scene) {
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console.error: ${m.text()}`);
  });
  try {
    await page.clock.setFixedTime(new Date(FROZEN_NOW_ISO));
    await page.goto(`${URL}?scene=${scene.name}`, { waitUntil: 'networkidle' });
    const stage = page.locator(`[data-scene="${scene.name}"][data-ready="1"]`);
    await stage.waitFor({ state: 'visible', timeout: 30_000 });
    await page.evaluate(() => document.fonts.ready);
    // Let the Sidebar's mount effects (proxy count / recordings index, both
    // no-ops headless) settle before the frame is read.
    await page.waitForTimeout(400);

    const size = scene.stage ?? STAGE;
    const said = await page.evaluate(readStageAttrs, `[data-scene="${scene.name}"]`);
    if (said === null || said.frozenNow !== FROZEN_NOW_ISO) {
      throw new Error(
        `${scene.name}: the harness renders at ${said?.frozenNow ?? 'no data-frozen-now'}, this script mirrors ${FROZEN_NOW_ISO} — update whichever drifted`,
      );
    }
    if (said.width !== size.width || said.height !== size.height) {
      throw new Error(
        `${scene.name}: the harness declares a ${said.width}×${said.height} stage, this script expects ${size.width}×${size.height} — update whichever drifted`,
      );
    }
    const box = await stage.boundingBox();
    if (
      box === null ||
      Math.round(box.width) !== size.width ||
      Math.round(box.height) !== size.height
    ) {
      throw new Error(
        `${scene.name}: stage is ${JSON.stringify(box)}, expected ${size.width}×${size.height}`,
      );
    }
    const g = scene.guard;
    // …and the same on the scene's own guard: `{ selector, cont: 8 }` would
    // run the query below and compare nothing.
    if (g.count === undefined && g.min === undefined && g.minColumns === undefined) {
      throw new Error(
        `${scene.name}: guard "${String(g.selector)}" asserts nothing (keys: ${Object.keys(g).join(', ')})`,
      );
    }
    const m = await page.evaluate(measureGuard, g.selector);
    if (g.count !== undefined && m.count !== g.count) {
      throw new Error(
        `${scene.name}: guard "${g.selector}" matched ${m.count}, expected ${g.count}`,
      );
    }
    if (g.min !== undefined && m.count < g.min) {
      throw new Error(
        `${scene.name}: guard "${g.selector}" matched ${m.count}, expected ≥ ${g.min}`,
      );
    }
    if (g.minColumns !== undefined && m.columns < g.minColumns) {
      throw new Error(
        `${scene.name}: grid renders ${m.columns} column(s), the brief wants ≥ ${g.minColumns}`,
      );
    }
    if (scene.fits !== undefined) {
      const f = await page.evaluate(measureFits, scene.fits);
      if (f === null) throw new Error(`${scene.name}: nothing matches fits guard "${scene.fits}"`);
      if (f.scrollWidth > f.clientWidth) {
        throw new Error(
          `${scene.name}: "${scene.fits}" is ${f.scrollWidth}px wide inside ${f.clientWidth}px — the right ${f.scrollWidth - f.clientWidth}px would be cut off the capture`,
        );
      }
    }
    if (scene.fitsY !== undefined) {
      const f = await page.evaluate(measureFits, scene.fitsY);
      if (f === null)
        throw new Error(`${scene.name}: nothing matches fitsY guard "${scene.fitsY}"`);
      if (f.scrollHeight > f.clientHeight) {
        throw new Error(
          `${scene.name}: "${scene.fitsY}" is ${f.scrollHeight}px tall inside ${f.clientHeight}px — the bottom ${f.scrollHeight - f.clientHeight}px would be cut off the capture`,
        );
      }
    }
    for (const extra of scene.also ?? []) {
      // A typo'd key ( minChars for minText, cout for count ) would otherwise
      // fall through all three branches and read as "checked, fine" — the same
      // hazard the unknown-`kind` throw in checkGeometry closes.
      let asserted = false;
      if (extra.count !== undefined) {
        asserted = true;
        const em = await page.evaluate(measureGuard, extra.selector);
        if (em.count !== extra.count) {
          throw new Error(
            `${scene.name}: guard "${extra.selector}" matched ${em.count}, expected ${extra.count}`,
          );
        }
      }
      if (extra.minValueMatch !== undefined) {
        asserted = true;
        const values = await page.evaluate(readValues, extra.selector);
        if (!values.some((v) => extra.minValueMatch.test(v))) {
          throw new Error(
            `${scene.name}: no "${extra.selector}" value matches ${String(extra.minValueMatch)} (values: ${JSON.stringify(values.map((v) => v.slice(0, 40)))})`,
          );
        }
      }
      if (extra.minText !== undefined) {
        asserted = true;
        const rendered = await page.evaluate(measureRendered, extra.selector);
        if (rendered.length === 0) {
          throw new Error(`${scene.name}: nothing matches minText guard "${extra.selector}"`);
        }
        const painted = rendered.filter((r) => !r.hidden && r.width > 0 && r.height > 0);
        if (painted.length === 0) {
          throw new Error(
            `${scene.name}: "${extra.selector}" is in the DOM but paints nothing (${JSON.stringify(rendered)}) — a 0×0 or hidden box screenshots as empty ground`,
          );
        }
        const chars = Math.max(...painted.map((r) => r.chars));
        if (chars < extra.minText) {
          throw new Error(
            `${scene.name}: "${extra.selector}" renders ${chars} character(s) of text, expected ≥ ${extra.minText} — an empty box screenshots just fine`,
          );
        }
      }
      if (!asserted) {
        throw new Error(
          `${scene.name}: also entry "${String(extra.selector)}" asserts nothing (keys: ${Object.keys(extra).join(', ')})`,
        );
      }
    }
    await checkGeometry(page, scene);
    if (problems.length > 0) {
      throw new Error(`${scene.name}: the page reported errors:\n  ${problems.join('\n  ')}`);
    }

    const png = await stage.screenshot({ type: 'png', animations: 'disabled', caret: 'hide' });
    const meta = await sharp(png).metadata();
    if (meta.width !== size.width * DPR || meta.height !== size.height * DPR) {
      throw new Error(
        `${scene.name}: PNG is ${meta.width}×${meta.height}, expected ${size.width * DPR}×${size.height * DPR}`,
      );
    }
    const outputs = [{ file: scene.name, png, width: meta.width, height: meta.height }];

    if (scene.hero !== undefined) {
      const region = await page.locator('[data-scene-region="grid"]').boundingBox();
      if (region === null) throw new Error(`${scene.name}: no [data-scene-region="grid"] to crop`);
      // Crop rectangle in CSS px relative to the stage, padded, clamped to it.
      const left = Math.max(0, Math.floor(region.x - box.x - HERO_PAD));
      const top = Math.max(0, Math.floor(region.y - box.y - HERO_PAD));
      const right = Math.min(size.width, Math.ceil(region.x - box.x + region.width + HERO_PAD));
      const bottom = Math.min(size.height, Math.ceil(region.y - box.y + region.height + HERO_PAD));
      const crop = await sharp(png)
        .extract({
          left: left * DPR,
          top: top * DPR,
          width: (right - left) * DPR,
          height: (bottom - top) * DPR,
        })
        .png()
        .toBuffer();
      const cm = await sharp(crop).metadata();
      outputs.push({ file: scene.hero, png: crop, width: cm.width, height: cm.height });
    }
    return outputs;
  } finally {
    await page.close();
  }
}

/** Pixel-for-pixel comparison of two PNG buffers; the number of differing
 *  pixels (Infinity when the sizes differ). */
async function diffPixels(a, b) {
  const [ra, rb] = await Promise.all([
    sharp(a).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    sharp(b).ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
  ]);
  if (ra.info.width !== rb.info.width || ra.info.height !== rb.info.height) return Infinity;
  let n = 0;
  const px = ra.data.length / 4;
  for (let i = 0; i < px; i += 1) {
    const o = i * 4;
    if (
      ra.data[o] !== rb.data[o] ||
      ra.data[o + 1] !== rb.data[o + 1] ||
      ra.data[o + 2] !== rb.data[o + 2] ||
      ra.data[o + 3] !== rb.data[o + 3]
    ) {
      n += 1;
    }
  }
  return n;
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const started = await ensureHarness();
  const browser = await chromium.launch();
  let failures = 0;
  const manifest = {
    generatedBy: 'scripts/marketing-screens.mjs',
    harness: 'apps/gui-client/visual-harness.html?scene=<name>',
    frozenNow: FROZEN_NOW_ISO,
    stage: { ...STAGE, deviceScaleFactor: DPR, 'profiles-list': { ...LIST_STAGE } },
    files: [],
  };
  try {
    const context = await browser.newContext({
      viewport: { width: LIST_STAGE.width + 40, height: STAGE.height + 40 },
      deviceScaleFactor: DPR,
      reducedMotion: 'reduce',
      colorScheme: 'dark',
      locale: 'en-US',
      timezoneId: 'UTC',
      userAgent: MAC_UA,
    });
    for (const scene of selected) {
      const outputs = await renderScene(context, scene);
      for (const o of outputs) {
        const pngPath = resolve(OUT, `${o.file}.png`);
        const webpPath = resolve(OUT, `${o.file}.webp`);
        if (VERIFY) {
          let existing;
          try {
            existing = await readFile(pngPath);
          } catch {
            failures += 1;
            process.stdout.write(`✗ ${o.file}.png — missing on disk\n`);
            continue;
          }
          const n = await diffPixels(existing, o.png);
          if (n === 0) {
            process.stdout.write(`✓ ${o.file}.png — identical (${o.width}×${o.height})\n`);
          } else {
            failures += 1;
            process.stdout.write(`✗ ${o.file}.png — ${String(n)} pixel(s) differ\n`);
          }
          continue;
        }
        await writeFile(pngPath, o.png);
        await writeFile(webpPath, await sharp(o.png).webp({ quality: WEBP_QUALITY }).toBuffer());
        manifest.files.push({
          scene: o.file,
          png: `${o.file}.png`,
          webp: `${o.file}.webp`,
          width: o.width,
          height: o.height,
          cssWidth: o.width / DPR,
          cssHeight: o.height / DPR,
        });
        process.stdout.write(`wrote ${o.file}.png + .webp (${o.width}×${o.height})\n`);
      }
    }
    if (!VERIFY && only === undefined) {
      await writeFile(resolve(OUT, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      process.stdout.write(`wrote manifest.json (${manifest.files.length} files)\n`);
    }
  } finally {
    await browser.close();
    if (started !== null) started.kill();
  }
  if (failures > 0) {
    process.stdout.write(`${String(failures)} file(s) differ from disk\n`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
