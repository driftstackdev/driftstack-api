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

  // 3. drive a tap on the middle of the video + see if a reaction fires (page_state
  // url change is hard to observe here, but a console/DOM signal or no-throw is a
  // baseline; the functional auto-verify harness asserts the real injection).
  let tapErr = null;
  try {
    if (m.video) await page.mouse.click(m.video.x + m.video.w / 2, m.video.y + m.video.h / 2);
    await sleep(800);
  } catch (e) {
    tapErr = String(e);
  }
  v.tapDispatched = tapErr === null;

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
