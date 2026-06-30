// LIVE visual self-test — creates a REAL session (optionally through a proxy),
// points the actual built GUI at it in a headless browser with REAL WebRTC video,
// then screenshots + MEASURES the true layout and DRIVES a tap. This is the
// "see + test it myself" harness (founder 2026-06-28): it catches the layout +
// input bugs that unit tests and the no-stream visual check can't, because here
// the <video> carries a real stream (so its size is real, not the 300x150 HTML
// default) and the click goes through the real input path.
//
// Env: DRIFTSTACK_API_KEY, DRIFTSTACK_BASE_URL (from ~/.driftstack-autotest.env),
//      DRIFTSTACK_PROXY_ID (optional), NAV_URL (default https://example.com),
//      KEYBOARD=1 to open the on-screen keyboard, PHONE_W/PHONE_H to size.
// Writes visual-out/live*.png + a measured JSON verdict to stdout. Cleans up the
// session at the end.

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
const PORT = 4321;
const BASE = process.env.DRIFTSTACK_BASE_URL || 'https://api.driftstack.dev';
const KEY = process.env.DRIFTSTACK_API_KEY || process.env.API_KEY || '';
const PROXY_ID = process.env.DRIFTSTACK_PROXY_ID || '';
const NAV_URL = process.env.NAV_URL || 'https://example.com';
const WANT_KB = process.env.KEYBOARD === '1';
if (!KEY) throw new Error('DRIFTSTACK_API_KEY not set');

async function api(method, path, body) {
  const r = await fetch(BASE + path, {
    method,
    headers: { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try {
    json = await r.json();
  } catch {
    /* no body */
  }
  return { ok: r.ok, status: r.status, json };
}
async function waitForServer(url, ms = 30000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      /* */
    }
    await sleep(400);
  }
  throw new Error('preview server did not come up');
}

let sessionId = null;
const srv = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: GUI,
  stdio: 'ignore',
});
let browser;
try {
  await waitForServer(`http://localhost:${PORT}/`);
  // 1. create a real manual session (the founder's path)
  const created = await api('POST', '/v1/agent-sessions', {
    mode: 'manual',
    initial_url: NAV_URL,
    ...(PROXY_ID ? { proxy_id: PROXY_ID } : {}),
  });
  if (!created.ok || !created.json?.id) throw new Error('create failed: HTTP ' + created.status);
  sessionId = created.json.id;
  let lk = created.json.livekit ?? null;
  if (!lk) {
    const t = await api(
      'POST',
      `/v1/agent-sessions/${encodeURIComponent(sessionId)}/livekit-token`,
    );
    if (t.ok && t.json?.ws_url) lk = t.json;
  }
  if (!lk?.ws_url || !lk?.token) throw new Error('no livekit join info');
  console.log(`session=${sessionId} proxy=${PROXY_ID || '(none)'} nav=${NAV_URL}`);

  browser = await chromium.launch({ args: ['--use-fake-ui-for-media-stream'] });
  const W = Number(process.env.PHONE_W ?? 462),
    H = Number(process.env.PHONE_H ?? 956);
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const u = new URL(`http://localhost:${PORT}/`);
  u.searchParams.set('window', 'simulator');
  u.searchParams.set('ws', lk.ws_url);
  u.searchParams.set('token', lk.token);
  u.searchParams.set('session', sessionId);
  await page.goto(u.toString(), { waitUntil: 'domcontentloaded' });

  // 2. wait for REAL video frames (videoWidth > 0 = the box is publishing + we decode)
  let gotVideo = false;
  try {
    await page.waitForFunction(
      () => {
        const v = document.querySelector('video');
        return v && v.videoWidth > 0 && v.videoHeight > 0;
      },
      { timeout: 45000 },
    );
    gotVideo = true;
  } catch {
    /* no video within 45s — itself a finding */
  }
  await sleep(1500);

  // Mimic the real app's fitWindow: the Tauri simulator window resizes ITSELF to the
  // LIVE content aspect, so the screen-host == content aspect and the aspect-locked
  // container fills it. The headless preview has no Tauri window, so a too-tall default
  // viewport CLAMPS the container (h-full + max-w-full) → a letterbox the real app never
  // shows (false negative — this masked the 2026-06-30 top-band fix verification). Resize
  // the viewport so the screen-host matches the content aspect, exactly as fitWindow would,
  // BEFORE screenshotting + measuring the band.
  if (gotVideo) {
    const fit = await page.evaluate(() => {
      const v = document.querySelector('video');
      const host =
        document.querySelector('[data-component="simulator-screen-host"]') ||
        document.querySelector('[data-component="simulator-screen"]');
      if (!v || !host || !v.videoWidth || !v.videoHeight) return null;
      const hb = host.getBoundingClientRect();
      return {
        hostW: hb.width,
        hostH: hb.height,
        contentAspect: v.videoWidth / v.videoHeight,
        vh: window.innerHeight,
      };
    });
    if (fit && fit.hostW > 0 && fit.contentAspect > 0) {
      const targetHostH = fit.hostW / fit.contentAspect; // host height for a no-clamp fit
      const chromeH = fit.vh - fit.hostH; // toolbar/status-strip above+below the host (fixed)
      const newVH = Math.max(360, Math.round(targetHostH + chromeH));
      if (Math.abs(newVH - fit.vh) > 4) {
        await page.setViewportSize({ width: W, height: newVH });
        await sleep(800); // let the layout reflow to the device-faithful window
      }
    }
  }

  if (WANT_KB) {
    const tg = page.locator('[data-component="simulator-keyboard-toggle"]');
    if (await tg.count()) {
      await tg.first().click();
      await sleep(900);
    }
  }
  await page.screenshot({ path: resolve(OUT, WANT_KB ? 'live-keyboard.png' : 'live.png') });

  const m = await page.evaluate(() => {
    const rect = (el) => {
      if (!el) return null;
      const b = el.getBoundingClientRect();
      return {
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.width),
        h: Math.round(b.height),
      };
    };
    const q = (...s) => {
      for (const x of s) {
        const e = document.querySelector(x);
        if (e) return { sel: x, ...rect(e) };
      }
      return null;
    };
    const vid = document.querySelector('video');
    return {
      screen: q('[data-component="simulator-screen"]', '[class*="screen"]'),
      video: q('video'),
      videoIntrinsic: vid ? { vw: vid.videoWidth, vh: vid.videoHeight } : null,
      keyboard: q('[data-component="ios-keyboard"]'),
    };
  });
  const v = { gotVideo };
  if (m.screen && m.video) {
    v.rightGapPx = m.screen.x + m.screen.w - (m.video.x + m.video.w);
    v.bottomGapPx = m.screen.y + m.screen.h - (m.video.y + m.video.h);
    v.sideBandSuspected = v.rightGapPx > 6 || m.video.x - m.screen.x > 6;
    v.bottomBandSuspected = v.bottomGapPx > 8;
  }
  // TOP/BOTTOM letterbox detection (the founder's "black space at the top"): with
  // object-contain, a screen-host sized to the WRONG aspect bar-boxes the real content —
  // black bars ABOVE + below it. Compare the video INTRINSIC aspect (the true captured
  // content) to the element aspect; a correctly-sized host matches → ~0 letterbox. This
  // is the class verify-all previously MISSED — it only checked the element-vs-screen gap
  // (sideBand/bottomBand), never the content-vs-element letterbox INSIDE the <video>.
  if (m.video && m.videoIntrinsic && m.videoIntrinsic.vh > 0 && m.videoIntrinsic.vw > 0) {
    const elementAspect = m.video.w / m.video.h;
    const intrinsicAspect = m.videoIntrinsic.vw / m.videoIntrinsic.vh;
    v.elementAspect = Math.round(elementAspect * 1000) / 1000;
    v.intrinsicAspect = Math.round(intrinsicAspect * 1000) / 1000;
    if (intrinsicAspect > elementAspect)
      v.letterboxTopBottomPx = Math.round((m.video.h - m.video.w / intrinsicAspect) / 2);
    else if (intrinsicAspect < elementAspect)
      v.letterboxLeftRightPx = Math.round((m.video.w - m.video.h * intrinsicAspect) / 2);
    // a top/bottom bar > 8px is a visible black band (the founder's top-black regression)
    v.topBandSuspected = (v.letterboxTopBottomPx || 0) > 8;
  }

  // 3. drive a tap THROUGH the GUI's pointer→viewport mapping (which uses inputLogical
  // = the box's page_state logicalContentWidth/Height — the durable fix) at a chosen
  // LOGICAL coord, then verify it LANDED by reading the GUI address bar before/after.
  // A url change proves the tap hit the link → the coordinate mapping is correct
  // end-to-end (not just dispatched). The pixel is computed with the SAME math the GUI
  // inverts, so a round-trip preserves the logical coord. Defaults ≈ the example.com
  // "More information…" link; override TAP_LOGICAL_X/Y to aim elsewhere, or set
  // TAP_FULLPAGE_LINK=1 + NAV_URL to a page whose whole viewport navigates (center tap).
  const LOGW = Number(process.env.TAP_LOGICAL_W || 402);
  const LOGH = Number(process.env.TAP_LOGICAL_H || 714);
  const FULLPAGE = process.env.TAP_FULLPAGE_LINK === '1';
  const LX = FULLPAGE ? LOGW / 2 : Number(process.env.TAP_LOGICAL_X || 122);
  const LY = FULLPAGE ? LOGH / 2 : Number(process.env.TAP_LOGICAL_Y || 207);
  const addrVal = async () =>
    page.evaluate(() => {
      const a = document.querySelector('[aria-label="Address bar"]');
      return a instanceof HTMLInputElement ? a.value : null;
    });
  let tapErr = null;
  const urlBefore = await addrVal();
  try {
    if (m.video) {
      // Match the GUI's object-contain pointer math EXACTLY (livekit-input-capture
      // pointerToViewport) so a logical→pixel→logical round-trip is identity even when
      // the stream is bar-boxed within the element (aspect mismatch). Without this, an
      // aspect mismatch would land the verify tap off-target → a false negative.
      const elementAspect = m.video.w / m.video.h;
      const videoAspect = LOGW / LOGH;
      let dispW = m.video.w;
      let dispH = m.video.h;
      if (videoAspect > elementAspect) dispH = m.video.w / videoAspect;
      else if (videoAspect < elementAspect) dispW = m.video.h * videoAspect;
      const px = m.video.x + (m.video.w - dispW) / 2 + (LX / LOGW) * dispW;
      const py = m.video.y + (m.video.h - dispH) / 2 + (LY / LOGH) * dispH;
      await page.mouse.click(px, py);
      v.tapPixel = { x: Math.round(px), y: Math.round(py), logical: { x: LX, y: LY } };
    }
    await sleep(2400);
  } catch (e) {
    tapErr = String(e);
  }
  const urlAfter = await addrVal();
  v.tapDispatched = tapErr === null;
  v.urlBefore = urlBefore;
  v.urlAfter = urlAfter;
  v.navigated = urlBefore !== null && urlAfter !== null && urlBefore !== urlAfter;
  await page.screenshot({ path: resolve(OUT, 'live-after-tap.png') });

  console.log(JSON.stringify({ measured: m, verdict: v, pageErrors: errors.slice(0, 6) }, null, 2));
} finally {
  if (browser) await browser.close();
  if (sessionId) {
    try {
      await api('DELETE', `/v1/agent-sessions/${encodeURIComponent(sessionId)}`);
    } catch {
      /* */
    }
  }
  srv.kill('SIGTERM');
}
