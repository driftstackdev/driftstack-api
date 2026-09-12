#!/usr/bin/env node
// GUI TEXT-QUALITY GATE (2026-09-12) — every leaf text element of EVERY
// harness scene (the six marketing scenes — the REAL Proxies / Simulator /
// Billing / Command Center views and both Profiles views — plus one audit scene
// per remaining view, all rendered by apps/gui-client/visual-harness.html →
// src/visual-harness/gallery.tsx inside the app's own window chrome), in BOTH
// themes, measured for:
//   • contrast   — WCAG 2.1 ratio of the text colour (its own alpha × the
//                  effective `opacity` up the tree, composited) against the
//                  element's effective background (alpha-composited up the
//                  tree): ≥ 4.5 for normal text, ≥ 3.0 for large text (≥ 24px,
//                  or ≥ 18.66px at weight ≥ 700). An element under an
//                  `aria-hidden="true"` or `data-contrast-decorative` ancestor is
//                  exempt (the wordmark's accent half is a brand mark, not copy),
//                  and so is text inside a `[disabled]` / `aria-disabled` control
//                  (§1.4.3 inactive components — counted as inactive, not measured);
//                  a MIXED-CONTENT element's own text (`<span><i aria-hidden/>
//                  Live</span>`) is measured like a leaf;
//   • size       — no readable text below MIN_PX (glyph-only spans skipped);
//   • truncation — an element that clips its text (text-overflow: ellipsis +
//                  scrollWidth > clientWidth) must carry a `title` or
//                  `aria-label` on itself or within six ancestors.
//
// Findings cluster by TOKEN (this gate found the light `--ink-muted-rgb` at
// 2.6–3.3:1 on every surface, the dark `.btn-primary` at 2.9:1 and the accent
// used as small text on slate at 2.4:1), so the fix is at the token in
// styles/index.css — and this is the proof the token change closed them.
//
// POSITIVE CONTROL (`--control`): a 7px, 1.3:1 span, a clipped untitled span and
// a mixed-content span faded to 2.46:1 by `opacity` are injected into every
// scene, and the run PASSES only when every scene in every theme reports exactly
// those four findings (one SMALL, two CONTRAST, one CUT-NO-TITLE, all attributed
// to data-component="scene-quality-control").
// An instrument that cannot see its own control is not measuring, and a clean
// run from such an instrument would be the best-looking failure there is.
//
// SCENE LIST — not hand-typed here. The gate imports the harness module through
// the dev server it is already talking to (`import('/src/visual-harness/
// gallery.tsx')` inside the page — vite serves the transformed module, the
// browser dedupes it against the one the page mounted) and reads `ALL_SCENES`
// + `sceneSize(name)` from it: ONE source, and a scene added to the harness is
// measured by the next run without anyone editing this file. ⛔ The first
// version carried its own six-name list, so the ten views the 2026-09-12 token
// sweep touched (Sessions, Fleet, Recordings, Logs, Connectivity, Settings,
// FirstRun, Recipes, AgentChat, Team) were never rendered and their light-theme
// ink went unmeasured while the run reported clean. The list is REFUSED when it
// is empty, is not an array of names, or lacks any of the six marketing scenes
// (KNOWN_SCENES — the positive control: a harness that stopped exporting its
// list, or exported a truncated one, must not produce a clean run), and every
// rendered stage's `data-stage-width/height` must equal the list's size.
//
// Output: `<out>/report.json` (per theme → per scene: leaf count, the size
// histogram, every finding with its measured ratio / fg / bg), the findings on
// stdout, exit 1 on any finding (or, under --control, on any scene that misses
// its control). Not in pre-push — it needs the dev server and a browser; it is
// the runbook's sibling of scripts/gui-visual-check.mjs.
//
// Usage (repo root):  node scripts/gui-text-quality.mjs [<out-dir>] [--control]
//                     [--themes=dark,light] [--scenes=proxies,simulator]
//   HARNESS_URL  default http://127.0.0.1:5199/visual-harness.html — when it
//                does not answer, this script starts `vite --port 5199` from
//                apps/gui-client itself (as scripts/marketing-screens.mjs does)
//                and stops it when done.

import { chromium } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.HARNESS_PORT ?? 5199);
const URL = process.env.HARNESS_URL ?? `http://127.0.0.1:${PORT}/visual-harness.html`;
/** The vite-served path of the harness module (apps/gui-client is the dev
 *  server's root; visual-harness.html mounts `/src/visual-harness/main.tsx`,
 *  which imports this). */
const HARNESS_MODULE = '/src/visual-harness/gallery.tsx';
/** POSITIVE CONTROL for the scene list, not the list: the six marketing scenes
 *  that have been in the harness since 2026-09-11. A loaded list missing any of
 *  them is refused — see loadSceneList. */
const KNOWN_SCENES = [
  'profiles-grid',
  'profiles-list',
  'proxies',
  'simulator',
  'billing',
  'command-center',
];
const ALL_THEMES = ['dark', 'light'];
const MIN_PX = 9;
const FROZEN_NOW_ISO = '2026-06-15T06:42:00.000Z';
const CONTROL_COMPONENT = 'scene-quality-control';

const args = process.argv.slice(2);
const CONTROL = args.includes('--control');
const listArg = (name, all) => {
  const raw = args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  if (raw === undefined) return all;
  const picked = raw
    .split(',')
    .map((x) => x.trim())
    .filter((x) => x !== '');
  const unknown = picked.filter((x) => !all.includes(x));
  if (picked.length === 0 || unknown.length > 0) {
    throw new Error(`--${name} matched nothing usable (${raw}); known: ${all.join(', ')}`);
  }
  return picked;
};
const THEMES = listArg('themes', ALL_THEMES);
const OUT = resolve(
  REPO_ROOT,
  args.find((a) => !a.startsWith('--')) ?? 'apps/gui-client/visual-out/text-quality',
);

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

/** Runs INSIDE the page: import the harness module through vite and hand back
 *  its scene list with each scene's stage size. Plain data out — a module
 *  namespace does not serialise. `sceneSize` throwing (a name it does not
 *  size) or returning non-numbers is reported per name, not swallowed. */
async function readSceneList(modulePath) {
  const m = await import(/* @vite-ignore */ modulePath);
  const names = m.ALL_SCENES;
  if (!Array.isArray(names))
    return { error: `ALL_SCENES is not exported as an array (got ${typeof names})` };
  const scenes = [];
  for (const name of names) {
    if (typeof name !== 'string' || name === '')
      return { error: `ALL_SCENES holds a non-name: ${JSON.stringify(name)}` };
    let size;
    try {
      size = typeof m.sceneSize === 'function' ? m.sceneSize(name) : undefined;
    } catch (e) {
      return {
        error: `sceneSize(${JSON.stringify(name)}) threw: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
    const width = Number(size?.width);
    const height = Number(size?.height);
    if (!(width > 0) || !(height > 0))
      return {
        error: `sceneSize(${JSON.stringify(name)}) → ${JSON.stringify(size)} — not a stage size`,
      };
    scenes.push({ name, width, height });
  }
  return { scenes };
}

/** The harness's scene list — names + stage sizes — read from the running
 *  harness (see the SCENE LIST note in the header). Refuses an empty list,
 *  a duplicate, or one that lacks any KNOWN_SCENES name. */
async function loadSceneList(browser) {
  const page = await browser.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  try {
    // Any `?scene=` value the harness does not know renders the plain state
    // gallery; the import below is what this page is for.
    await page.goto(`${URL}?scene=__list__`, { waitUntil: 'domcontentloaded' });
    const res = await page.evaluate(readSceneList, HARNESS_MODULE);
    if (res.error !== undefined) {
      throw new Error(`scene list from ${HARNESS_MODULE}: ${res.error}`);
    }
    if (problems.length > 0) {
      throw new Error(`scene list: the harness page reported errors:\n  ${problems.join('\n  ')}`);
    }
    const { scenes } = res;
    if (scenes.length === 0)
      throw new Error(`scene list from ${HARNESS_MODULE} is EMPTY — refusing to run`);
    const names = scenes.map((s) => s.name);
    const dup = names.find((n, i) => names.indexOf(n) !== i);
    if (dup !== undefined) throw new Error(`scene list names ${JSON.stringify(dup)} twice`);
    const missing = KNOWN_SCENES.filter((n) => !names.includes(n));
    if (missing.length > 0) {
      throw new Error(
        `scene list from ${HARNESS_MODULE} lacks the known scene(s) ${missing.join(', ')} (got: ${names.join(', ')}) — refusing to run on a truncated list`,
      );
    }
    return scenes;
  } finally {
    await page.close();
  }
}

/** Runs INSIDE the page, over the scene's stage root. */
function measureStage(root, opts) {
  const { MIN_PX, CONTROL_COMPONENT } = opts;
  const lum = (r, g, bl) => {
    const f = (c) => {
      c /= 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(bl);
  };
  const parse = (s) => {
    const m = s.match(/rgba?\(([\d.]+),\s*([\d.]+),\s*([\d.]+)(?:,\s*([\d.]+))?\)/);
    return m ? [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : +m[4]] : null;
  };
  // Effective background: walk up from the element compositing every
  // translucent layer FRONT-TO-BACK (the nearer layer stays in front — a
  // `bg-accent/20` badge on a `bg-accent-subtle` row on the slate base is the
  // badge wash over the row wash over the base) until an opaque layer closes
  // the stack. ⛔ The scratchpad draft composited the OUTER layer over the
  // inner one and closed the stack at the first opaque ancestor, which threw
  // every translucent wash away: a status pill's `bg-status-ready/15` tint and
  // the active sidebar badge both measured against the bare card/base colour.
  // Below the stage the harness body is opaque (bg-surface-base).
  const bgOf = (el) => {
    let e = el;
    let acc = null; // [r, g, b, alpha] of the stack so far, front-most first
    while (e) {
      const c = parse(getComputedStyle(e).backgroundColor);
      if (c && c[3] > 0) {
        if (!acc) acc = c;
        else {
          const fa = acc[3];
          const ba = c[3];
          const na = fa + ba * (1 - fa);
          acc = [
            (acc[0] * fa + c[0] * ba * (1 - fa)) / na,
            (acc[1] * fa + c[1] * ba * (1 - fa)) / na,
            (acc[2] * fa + c[2] * ba * (1 - fa)) / na,
            na,
          ];
        }
        if (acc[3] >= 0.999) break;
      }
      e = e.parentElement;
    }
    if (acc === null) return null;
    // A translucent stack that never reached an opaque layer sits on the
    // canvas: composite over the body's colour, else white.
    if (acc[3] < 0.999) {
      const body = parse(getComputedStyle(document.body).backgroundColor) ?? [255, 255, 255, 1];
      const a = acc[3];
      acc = [
        acc[0] * a + body[0] * (1 - a),
        acc[1] * a + body[1] * (1 - a),
        acc[2] * a + body[2] * (1 - a),
        1,
      ];
    }
    return acc;
  };
  const ratio = (fg, bg) => {
    const a = lum(fg[0], fg[1], fg[2]);
    const b = lum(bg[0], bg[1], bg[2]);
    return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  };
  const decorative = (el) => {
    let e = el;
    while (e) {
      if (
        e.getAttribute &&
        (e.getAttribute('aria-hidden') === 'true' || e.hasAttribute('data-contrast-decorative'))
      )
        return true;
      e = e.parentElement;
    }
    return false;
  };
  const titled = (el) => {
    let e = el;
    for (let i = 0; i < 6 && e; i += 1) {
      if (e.getAttribute && (e.getAttribute('title') || e.getAttribute('aria-label'))) return true;
      e = e.parentElement;
    }
    return false;
  };
  const describe = (el) => {
    const dc = el.closest('[data-component]')?.getAttribute('data-component') ?? '';
    const tag = el.tagName.toLowerCase();
    const txt = (el.textContent ?? '').trim().replace(/\s+/g, ' ').slice(0, 48);
    return `${dc ? dc + ' ' : ''}<${tag}> "${txt}"`;
  };
  const isControl = (el) => el.closest(`[data-component="${CONTROL_COMPONENT}"]`) !== null;
  const clips = (el, cs) =>
    cs.textOverflow === 'ellipsis' &&
    cs.overflow !== 'visible' &&
    el.scrollWidth > el.clientWidth + 1;
  const hex = (c) =>
    '#' +
    c
      .slice(0, 3)
      .map((v) => Math.round(v).toString(16).padStart(2, '0'))
      .join('');
  const out = {
    leafCount: 0,
    mixedCount: 0,
    inactive: 0,
    unmeasured: 0,
    small: [],
    contrast: [],
    truncatedNoTitle: [],
    sizes: {},
  };
  const isGlyphOnly = (t) => /^[^\p{L}\p{N}]{1,3}$/u.test(t);
  // The element's OWN text — the direct text nodes, not the descendants'. A
  // mixed-content element (`<span><i aria-hidden/> Live</span>`, `<label><span>⤓
  // </span> Upload…</label>`) paints that text in its own colour, so it is a
  // text leaf for contrast and size even though it has element children.
  // ⛔ The first version measured only childless elements, so every label of
  // that shape — the simulator toolbar's "Live" among them, 2.49:1 in a light
  // theme — went unmeasured while the run reported clean.
  const ownText = (el) =>
    Array.from(el.childNodes)
      .filter((n) => n.nodeType === Node.TEXT_NODE)
      .map((n) => n.textContent ?? '')
      .join('')
      .trim();
  // Effective opacity: the product of every `opacity` from the element up to
  // the document. A faded element is painted as its colour AT that alpha over
  // what is behind it, so the text's own alpha is multiplied by it below.
  // ⛔ The first version skipped only opacity === 0 and read every other value
  // as fully painted: the sidebar's `opacity-70` shortcut hint measured 4.66
  // and was painted at 3.02. (A faded GROUP with an opaque background of its
  // own is approximated — its text is composited over the group's background
  // rather than over what is behind the group — which errs on the strict side
  // for the disabled-control case, and those are exempt anyway.)
  const fade = (el) => {
    let o = 1;
    for (let e = el; e; e = e.parentElement) o *= parseFloat(getComputedStyle(e).opacity);
    return Number.isFinite(o) ? o : 1;
  };
  // WCAG 2.1 §1.4.3 exempts text that is part of an INACTIVE UI component
  // (a disabled button at `disabled:opacity-50`). Counted, never measured.
  const inactive = (el) => el.closest('[disabled], [aria-disabled="true"]') !== null;
  for (const el of root.querySelectorAll('*')) {
    const cs = getComputedStyle(el);
    const mixed = el.children.length !== 0;
    if (mixed && clips(el, cs) && !titled(el)) {
      // truncation applies to containers too (a clipped row of spans)
      out.truncatedNoTitle.push({
        el: describe(el),
        over: el.scrollWidth - el.clientWidth,
        control: isControl(el),
      });
    }
    const text = mixed ? ownText(el) : (el.textContent ?? '').trim();
    if (!text) continue;
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const alpha = fade(el);
    if (alpha === 0) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    out.leafCount += 1;
    if (mixed) out.mixedCount += 1;
    const size = parseFloat(cs.fontSize);
    out.sizes[size] = (out.sizes[size] ?? 0) + 1;
    const control = isControl(el);
    if (!isGlyphOnly(text)) {
      if (size < MIN_PX) out.small.push({ el: describe(el), size, control });
      if (inactive(el)) {
        out.inactive += 1;
      } else if (!decorative(el)) {
        const fg = parse(cs.color);
        const bg = fg === null ? null : bgOf(el);
        if (fg === null || bg === null) {
          // ⛔ Counted, never skipped silently: an unparseable colour or a
          // background the walk could not resolve is a hole in the measurement.
          out.unmeasured += 1;
        } else {
          const fa = fg[3] * alpha;
          const fgc = [
            fg[0] * fa + bg[0] * (1 - fa),
            fg[1] * fa + bg[1] * (1 - fa),
            fg[2] * fa + bg[2] * (1 - fa),
          ];
          const bold = parseInt(cs.fontWeight, 10) >= 700;
          const large = size >= 24 || (bold && size >= 18.66);
          const need = large ? 3 : 4.5;
          const rr = ratio(fgc, bg);
          if (rr < need) {
            out.contrast.push({
              el: describe(el),
              ratio: +rr.toFixed(2),
              need,
              size,
              fg: hex(fgc),
              fgRaw: cs.color,
              opacity: +alpha.toFixed(3),
              bg: hex(bg),
              placeholder: el.tagName === 'INPUT' || el.tagName === 'TEXTAREA',
              mixed,
              control,
            });
          }
        }
      }
    }
    if (!mixed && clips(el, cs) && !titled(el)) {
      out.truncatedNoTitle.push({
        el: describe(el),
        over: el.scrollWidth - el.clientWidth,
        control,
      });
    }
  }
  return out;
}

/** Runs INSIDE the page: the positive control — one 7px 1.3:1 span (SMALL +
 *  CONTRAST), one clipped untitled span (CUT-NO-TITLE), and one MIXED-CONTENT
 *  span (an aria-hidden glyph child + its own text) painted white on black at
 *  opacity .3 (2.46:1 — CONTRAST). The third is the control for the two holes
 *  the first instrument had: skip mixed-content text, or read opacity as fully
 *  painted, and it measures 21:1 and goes unreported — the control is MISSED. */
function injectControl(root, component) {
  const c = document.createElement('div');
  c.setAttribute('data-component', component);
  c.innerHTML =
    '<span style="font-size:7px;color:#1a1f2e;background:#111827">control small+dim</span>' +
    '<span style="display:inline-block;width:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#fff;background:#000">control clipped text that overflows</span>' +
    '<span style="display:inline-block;background:#000"><span style="opacity:0.3;color:#fff"><i aria-hidden="true">•</i> control faded mixed</span></span>';
  root.appendChild(c);
}

async function measureScene(context, entry, theme) {
  const scene = entry.name;
  const page = await context.newPage();
  const problems = [];
  page.on('pageerror', (e) => problems.push(`pageerror: ${e.message}`));
  try {
    // The viewport is the stage's own size (from the list) plus a margin, so a
    // taller audit scene is never clipped by a viewport sized for the default.
    await page.setViewportSize({ width: entry.width + 40, height: entry.height + 40 });
    await page.clock.setFixedTime(new Date(FROZEN_NOW_ISO));
    await page.goto(`${URL}?scene=${scene}`, { waitUntil: 'networkidle' });
    const stage = page.locator(`[data-scene="${scene}"][data-ready="1"]`);
    await stage.waitFor({ state: 'visible', timeout: 30_000 });
    const declared = await stage.evaluate((el) => ({
      width: Number(el.getAttribute('data-stage-width')),
      height: Number(el.getAttribute('data-stage-height')),
    }));
    if (declared.width !== entry.width || declared.height !== entry.height) {
      throw new Error(
        `${scene}: the stage declares ${declared.width}×${declared.height} but the scene list says ${entry.width}×${entry.height}`,
      );
    }
    await page.evaluate((mode) => {
      document.documentElement.dataset.mode = mode;
    }, theme);
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    const applied = await page.evaluate(() => document.documentElement.dataset.mode);
    if (applied !== theme) throw new Error(`${scene}: data-mode is ${applied}, wanted ${theme}`);
    if (CONTROL) await stage.evaluate(injectControl, CONTROL_COMPONENT);
    const res = await stage.evaluate(measureStage, { MIN_PX, CONTROL_COMPONENT });
    if (problems.length > 0) {
      throw new Error(`${scene}: the page reported errors:\n  ${problems.join('\n  ')}`);
    }
    if (res.leafCount < 20) {
      throw new Error(
        `${scene} [${theme}]: only ${res.leafCount} text leaves measured — an empty stage must not pass as a clean one`,
      );
    }
    return res;
  } finally {
    await page.close();
  }
}

async function main() {
  await mkdir(OUT, { recursive: true });
  const started = await ensureHarness();
  const browser = await chromium.launch();
  const report = {
    generatedBy: 'scripts/gui-text-quality.mjs',
    control: CONTROL,
    minPx: MIN_PX,
    sceneSource: HARNESS_MODULE,
    scenes: [],
    themes: {},
  };
  let findings = 0;
  let controlMisses = 0;
  let SCENES = [];
  try {
    const listed = await loadSceneList(browser);
    const picked = listArg(
      'scenes',
      listed.map((s) => s.name),
    );
    SCENES = listed.filter((s) => picked.includes(s.name));
    report.scenes = SCENES;
    console.log(
      `scene list: ${listed.length} scene(s) from ${HARNESS_MODULE} (${listed.map((s) => s.name).join(', ')}); measuring ${SCENES.length}`,
    );
    for (const theme of THEMES) {
      const context = await browser.newContext({
        viewport: { width: 1840, height: 940 },
        deviceScaleFactor: 1,
        colorScheme: theme,
        reducedMotion: 'reduce',
        locale: 'en-US',
        timezoneId: 'UTC',
      });
      report.themes[theme] = {};
      for (const entry of SCENES) {
        const scene = entry.name;
        const res = await measureScene(context, entry, theme);
        report.themes[theme][scene] = res;
        const sizes = Object.entries(res.sizes)
          .sort((a, b) => +a[0] - +b[0])
          .map(([s, n]) => `${s}px×${n}`)
          .join(' ');
        const real = (list) => list.filter((x) => !x.control);
        const ctl = (list) => list.filter((x) => x.control);
        console.log(
          `\n== ${scene} [${theme}]: ${res.leafCount} text leaves (${res.mixedCount} mixed-content, ${res.inactive} inactive-exempt, ${res.unmeasured} unmeasured) · sizes ${sizes}`,
        );
        for (const s of real(res.small)) console.log(`  SMALL   ${s.size}px  ${s.el}`);
        for (const c of real(res.contrast))
          console.log(
            `  CONTRAST ${c.ratio} (need ${c.need}, ${c.size}px) fg ${c.fg} [${c.fgRaw}${
              c.opacity < 1 ? ` × opacity ${c.opacity}` : ''
            }] on ${c.bg}  ${c.el}${c.mixed ? ' (own text of a mixed-content element)' : ''}`,
          );
        for (const t of real(res.truncatedNoTitle))
          console.log(`  CUT-NO-TITLE (+${t.over}px)  ${t.el}`);
        findings +=
          real(res.small).length +
          real(res.contrast).length +
          real(res.truncatedNoTitle).length +
          res.unmeasured;
        if (CONTROL) {
          const seen = {
            small: ctl(res.small).length,
            contrast: ctl(res.contrast).length,
            cut: ctl(res.truncatedNoTitle).length,
          };
          const ok = seen.small === 1 && seen.contrast === 2 && seen.cut === 1;
          res.controlDetected = seen;
          res.controlOk = ok;
          if (!ok) controlMisses += 1;
          console.log(
            `  CONTROL ${ok ? 'detected' : 'MISSED'} — small ${seen.small}/1 contrast ${seen.contrast}/2 cut ${seen.cut}/1`,
          );
        }
      }
      await context.close();
    }
  } finally {
    await browser.close();
    if (started !== null) started.kill();
  }
  report.findings = findings;
  report.controlMisses = controlMisses;
  await writeFile(resolve(OUT, 'report.json'), `${JSON.stringify(report, null, 2)}\n`);
  const cells = THEMES.length * SCENES.length;
  console.log(`\n${findings} finding(s) across ${cells} scene×theme cells → ${OUT}/report.json`);
  if (CONTROL) {
    console.log(
      `control: ${cells - controlMisses}/${cells} cells detected all four injected findings`,
    );
    process.exitCode = controlMisses > 0 ? 1 : 0;
    return;
  }
  process.exitCode = findings > 0 ? 1 : 0;
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`);
  process.exitCode = 1;
});
