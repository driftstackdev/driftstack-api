#!/usr/bin/env node
// Marketing screen captures (2026-09-11) — REAL renders of the desktop app's
// components for the marketing site (apps/marketing-site), replacing the
// hand-drawn GUI depictions that had drifted from the shipped app.
//
// What it captures: the visual harness (apps/gui-client/visual-harness.html →
// src/visual-harness/gallery.tsx) with `?scene=<name>`, which renders ONE
// composition inside the app's real window chrome (TitleBar + Sidebar, dark +
// oxblood) at a fixed stage (1280×800; the list view 1800×800 so its ~1490px
// table fits with the Actions column in frame), from the same React components
// and the same CSS the Tauri app ships. Scenes:
//   profiles-grid    Profiles view framing around the real ProfilePhoneCard grid
//                    (8 curated states, ≥ 3 columns) — also cropped to a hero
//   profiles-list    the same framing around ProfilesTable (the grid's 8 profiles)
//   proxies          the Proxies view framing around the three ProxyForm editors
//   simulator        the simulator window: DeviceToolbar + phone screen host +
//                    on-screen iOS keyboard + the Egress readouts
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
//   <scene>.png + <scene>.webp     2560×1600 (1280×800 @2x); profiles-list 3600×1600
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
const LIST_STAGE = { width: 1800, height: 800 };
const DPR = 2;
const WEBP_QUALITY = 90;
/** CSS px of breathing room around the grid in the hero crop. */
const HERO_PAD = 12;
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
    guard: {
      selector:
        '[data-component="simulator-toolbar"], [data-component="sim-exit-ip-chip"][data-state="observed"], [data-component="sim-quic-readout"][data-state="observed"], [data-component="sim-os-readout"][data-state="observed"]',
      count: 4,
    },
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
/** Runs INSIDE the page: does the element's content fit without horizontal
 *  scrolling (what a screenshot can show)? */
function measureFits(selector) {
  const el = document.querySelector(selector);
  if (el === null) return null;
  return { scrollWidth: el.scrollWidth, clientWidth: el.clientWidth };
}
/** Runs INSIDE the page: the values of every matched textarea/input. */
function readValues(selector) {
  return Array.from(document.querySelectorAll(selector)).map((el) => el.value ?? '');
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
    for (const extra of scene.also ?? []) {
      if (extra.count !== undefined) {
        const em = await page.evaluate(measureGuard, extra.selector);
        if (em.count !== extra.count) {
          throw new Error(
            `${scene.name}: guard "${extra.selector}" matched ${em.count}, expected ${extra.count}`,
          );
        }
      }
      if (extra.minValueMatch !== undefined) {
        const values = await page.evaluate(readValues, extra.selector);
        if (!values.some((v) => extra.minValueMatch.test(v))) {
          throw new Error(
            `${scene.name}: no "${extra.selector}" value matches ${String(extra.minValueMatch)} (values: ${JSON.stringify(values.map((v) => v.slice(0, 40)))})`,
          );
        }
      }
    }
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
