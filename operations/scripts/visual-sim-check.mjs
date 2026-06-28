// Visual self-test for the simulator window — renders the REAL built GUI in a
// headless browser, screenshots it, and MEASURES the layout so a fix can be
// verified without a human looking at the app. Founder 2026-06-28: "prepare
// something to always be able to test it and see for yourself."
//
// Catches the layout bugs unit tests miss: a bottom black band (the phone
// screen is taller than the <video>), a cropped/oversized on-screen keyboard,
// the keyboard pushing content out of view.
//
// Usage: node operations/visual-sim-check.mjs            (keyboard hidden)
//        KEYBOARD=1 node operations/visual-sim-check.mjs (keyboard shown)
// Requires a built dist (npm run build). Serves it via vite preview, drives it
// with Playwright, writes scratchpad PNGs + a measured JSON verdict to stdout.

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const GUI = resolve(HERE, '..', '..', 'apps', 'gui-client');
const OUT = resolve(GUI, 'visual-out');
mkdirSync(OUT, { recursive: true });
const PORT = 4319;
const WANT_KEYBOARD = process.env.KEYBOARD === '1';

async function waitForServer(url, ms = 30000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    try {
      const r = await fetch(url);
      if (r.ok) return true;
    } catch {
      /* not up yet */
    }
    await sleep(400);
  }
  throw new Error('preview server did not come up');
}

const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: GUI,
  stdio: 'ignore',
});
let browser;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  browser = await chromium.launch();
  // Render at a REALISTIC phone-window size (founder's real window is ~iPhone
  // width, not a roomy desktop) so a too-wide/cropped keyboard + a content/window
  // mismatch actually show. Override with PHONE_W / PHONE_H.
  const W = Number(process.env.PHONE_W ?? 462);
  const H = Number(process.env.PHONE_H ?? 956);
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(
    `http://localhost:${PORT}/?window=simulator&ws=wss://example.invalid&token=tok&session=agt_visualtest`,
    { waitUntil: 'domcontentloaded' },
  );
  // Tint the <video> bright magenta so its real bounds are visible against the
  // page's black — without a live stream the whole screen is black, hiding a
  // layout black-band. This reveals exactly where the video ends and chrome/band
  // begins.
  await page.addStyleTag({
    content:
      'video{background:#ff00ff !important;opacity:1 !important;visibility:visible !important}',
  });
  await sleep(3500); // let it render the phone chrome (LiveKit won't connect; chrome still renders)

  if (WANT_KEYBOARD) {
    const toggle = page.locator('[data-component="simulator-keyboard-toggle"]');
    if ((await toggle.count()) > 0) {
      await toggle.first().click();
      await sleep(800);
    }
  }

  await page.screenshot({ path: resolve(OUT, WANT_KEYBOARD ? 'sim-keyboard.png' : 'sim.png') });

  // Measure: the phone "screen" (where the video lives), the <video> rect, and
  // the keyboard rect. A black band = screen bottom extends well past the video
  // bottom. A cropped keyboard = its rect overflows the screen width/bottom.
  const m = await page.evaluate(() => {
    const r = (sel) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
    };
    const pick = (...sels) => {
      for (const s of sels) {
        const got = r(s);
        if (got) return { sel: s, ...got };
      }
      return null;
    };
    return {
      screen: pick('[data-component="simulator-screen"]', '.simulator-screen', '[class*="screen"]'),
      video: pick('video'),
      keyboard: pick('[data-component="ios-keyboard"]', '[class*="keyboard"]'),
      toggle: pick('[data-component="simulator-keyboard-toggle"]'),
      bodyBg: getComputedStyle(document.body).backgroundColor,
    };
  });

  // Verdicts
  const v = {};
  if (m.screen && m.video) {
    const gap = m.screen.y + m.screen.h - (m.video.y + m.video.h);
    v.bottomGapPx = gap;
    v.blackBandSuspected = gap > 8; // >8px of screen below the video = visible band
  } else {
    v.note = 'screen or video element not found (no live session → video may be absent)';
  }
  if (m.keyboard && m.screen) {
    v.keyboardOverflowsRight = m.keyboard.x + m.keyboard.w > m.screen.x + m.screen.w + 2;
    v.keyboardWidthVsScreen = `${m.keyboard.w} vs screen ${m.screen.w}`;
    v.keyboardBelowScreenBottom = m.keyboard.y + m.keyboard.h > m.screen.y + m.screen.h + 2;
  }
  console.log(JSON.stringify({ measured: m, verdict: v, pageErrors: errors.slice(0, 5) }, null, 2));
} finally {
  if (browser) await browser.close();
  srv.kill('SIGTERM');
}
