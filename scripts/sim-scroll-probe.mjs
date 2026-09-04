#!/usr/bin/env node
// Autonomous SCROLL probe (founder 2026-06-22: "nothing fixed still the same. find
// auto ways to test scroll stuff, without needing me ... 100% fixed and verified").
//
// Measures, with NO human, whether a scroll-DOWN gesture actually scrolls the page DOWN
// MONOTONICALLY on the live box — i.e. whether the founder's "it scrolls me back up"
// reproduces. Mirrors sim-tap-probe.mjs: creates a real agent session, joins the
// session's LiveKit room as a headless participant, navigates the box to a TALL vertical
// gradient (driftstack.io/scroll-probe.html — black top → white bottom, so the streamed
// frame's AVERAGE LUMA encodes scroll position), then injects touch events EXACTLY like
// the GUI and samples luma over time.
//
// Two modes (default: both):
//   --mode clean   : inject a HAND-CRAFTED clean monotonic drag (touchStart + monotone
//                    touchMoves up + touchEnd). This ISOLATES THE FORK: if a clean drag
//                    still bounces (luma dips), the bug is the box/fork (e.g. the
//                    undeployed W2761 sub-pixel phantom), NOT the GUI wheel→touch converter.
//   --mode legs    : a longer drag that forces an edge re-centre (touchEnd+touchStart
//                    mid-scroll) — tests the re-anchor path on the fork.
//   --e2e          : THE PROPER REAL LIVE TEST (founder 2026-06-22). Mounts the REAL GUI
//                    wheel->touch converter (scripts/scroll-e2e/harness.iife.js) on the
//                    live #dsvid box stream, wires its emitted touch to publishData, then
//                    dispatches a realistic macOS trackpad scroll-DOWN WheelEvent stream at
//                    it. This drives the founder's ACTUAL path end-to-end (trackpad wheel ->
//                    converter -> DataChannel -> box -> scroll), not hand-crafted touch.
//
// Verdict: for a scroll-DOWN the luma trace must be NON-DECREASING (page shows lower =
// lighter content). A DIP below the running max by > NOISE = a BOUNCE (scrolled back up).
//
// Run (key via env — NEVER hardcode/log it):
//   DS_KEY="$(security find-generic-password -s dev.driftstack.gui -w)" node scripts/sim-scroll-probe.mjs
// Options: --url <https-url> (default scroll-probe.html) · --proxy <id|none> · --keep · --e2e
//
// NEVER prints DS_KEY or the LiveKit token. Always deletes the session (unless --keep).

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const BASE = 'https://api.driftstack.dev';
const KEY = process.env.DS_KEY;
if (!KEY || KEY.length < 8) {
  console.error(
    'Missing DS_KEY. Run:\n  DS_KEY="$(security find-generic-password -s dev.driftstack.gui -w)" node scripts/sim-scroll-probe.mjs',
  );
  process.exit(2);
}
const H = { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' };

const argv = process.argv.slice(2);
const getFlag = (n) => argv.includes(n);
const getOpt = (n, d) => {
  const i = argv.indexOf(n);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const KEEP = getFlag('--keep');
// --e2e: run the FULL LIVE flow through the REAL GUI wheel->touch converter (W2769).
// Instead of hand-crafting touch (the default modes) or driving the fork's native path,
// --e2e injects the bundled REAL converter (scripts/scroll-e2e/harness.iife.js), wires its
// emitted touch straight to the box DataChannel, then fires a realistic macOS trackpad
// WheelEvent stream at it — exercising EXACTLY the founder's path: trackpad wheel ->
// useInputCapture -> sendInputEvent -> publishData -> box -> scroll. Additive: the existing
// modes still run unless you pass --e2e (which runs ONLY the e2e flow).
const E2E = getFlag('--e2e');
const PROBE_URL = getOpt('--url', 'https://driftstack.io/scroll-probe.html');
const MODE = getOpt('--mode', 'both');
const NOISE = 3; // luma units of frame noise to tolerate before calling a dip a bounce
const here = path.dirname(fileURLToPath(import.meta.url));
const HARNESS_PATH = path.join(here, 'scroll-e2e', 'harness.iife.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jres = async (r) => {
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
};

let sid = null;
let browser = null;
let exitCode = 0;
try {
  // 1. profile + proxy (mirror a GUI launch). --profile <id> targets a specific profile
  //    (default = first) — used to disambiguate profile-state vs box-wide stream failures.
  const profs = await fetch(`${BASE}/v1/profiles?limit=20`, { headers: H }).then(jres);
  const profRows = Array.isArray(profs.body?.data) ? profs.body.data : [];
  const profArg = getOpt('--profile', '');
  const prof = profArg ? profRows.find((p) => p.id === profArg) : profRows[0];
  if (!prof?.id) {
    console.error(
      profArg
        ? `Profile ${profArg} not found on this account.`
        : 'No profiles on this account — cannot launch.',
    );
    process.exit(1);
  }
  console.log(`profile: ${prof.id} (${prof.archetype ?? '?'})`);
  const proxyArg = getOpt('--proxy', '');
  let proxyId;
  if (proxyArg === 'none') proxyId = undefined;
  else if (proxyArg) proxyId = proxyArg;
  else {
    const px = await fetch(`${BASE}/v1/account/me/proxies`, { headers: H }).then(jres);
    proxyId = (Array.isArray(px.body?.data) ? px.body.data : [])[0]?.id;
  }
  console.log(`proxy: ${proxyId ?? '(none — operator default)'}`);

  // 2. create the session.
  const created = await fetch(`${BASE}/v1/agent-sessions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      profile_id: prof.id,
      mode: 'manual',
      ...(proxyId ? { proxy_id: proxyId } : {}),
      initial_url: PROBE_URL,
    }),
  }).then(jres);
  sid = created.body?.id ?? null;
  const lk = created.body?.livekit;
  if (!sid || !lk?.ws_url || !lk?.token) {
    console.error(
      'create failed / no LiveKit join info:',
      JSON.stringify(created.body).slice(0, 300),
    );
    process.exit(1);
  }
  console.log(`session: ${sid} | livekit room=${lk?.room ?? '?'}`);

  // 3. headless chromium → livekit-client → connect; expose publish() + __avgLuma().
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  page.on('console', (m) => {
    const t = m.text();
    if (t.startsWith('[probe]')) console.log('  ' + t);
  });
  await page.setContent(
    '<!doctype html><html><body style="margin:0;background:#000">' +
      '<video id="dsvid" autoplay muted playsinline style="position:fixed;inset:0;width:100vw;height:100vh;object-fit:contain"></video>' +
      '</body></html>',
  );
  await page.addScriptTag({
    url: 'https://cdn.jsdelivr.net/npm/livekit-client@2/dist/livekit-client.umd.min.js',
  });
  const connState = await page.evaluate(
    async ({ ws, token }) => {
      const LK = window.LivekitClient;
      if (!LK) return 'no-livekit-umd';
      const room = new LK.Room();
      window.__dsRoom = room;
      const vid = document.getElementById('dsvid');
      room.on(LK.RoomEvent.TrackSubscribed, (track) => {
        try {
          if (track.kind === 'video') track.attach(vid);
        } catch (e) {
          /* ignore */
        }
      });
      window.__avgLuma = () => {
        const v = document.getElementById('dsvid');
        const w = v.videoWidth,
          h = v.videoHeight;
        if (!w) return -1;
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(v, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let s = 0;
        for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
        return Math.round((s / (d.length / 4) / 3) * 10) / 10;
      };
      try {
        await room.connect(ws, token, { autoSubscribe: true });
      } catch (e) {
        return 'connect-error: ' + (e && e.message ? e.message : String(e));
      }
      await new Promise((r) => setTimeout(r, 2500));
      return room.state;
    },
    { ws: lk.ws_url, token: lk.token },
  );
  console.log(`livekit connect: ${connState}`);
  if (connState !== 'connected') {
    console.error('Could not connect to the room — aborting (session deleted).');
    process.exit(1);
  }

  const publish = (event) =>
    page.evaluate(async (ev) => {
      const room = window.__dsRoom;
      const data = new TextEncoder().encode(JSON.stringify(ev));
      await room.localParticipant.publishData(data, { reliable: true });
    }, event);
  const luma = () => page.evaluate(() => window.__avgLuma());

  // 4. wait for the device VIDEO track to come up (box boot + proxy connect can take a
  //    while — a too-short wait => videoWidth=0 => luma -1 => false "NO-SCROLL"), THEN
  //    ensure the gradient page is loaded (initial_url should land it; re-send navigate).
  const videoW = () =>
    page.evaluate(() => {
      const v = document.getElementById('dsvid');
      return v ? v.videoWidth : 0;
    });
  console.log('waiting for the device video track…');
  let vw = 0;
  for (let i = 0; i < 70; i++) {
    vw = await videoW();
    if (vw > 0) {
      console.log(`  video up at t+${(i * 2).toFixed(0)}s (w=${vw})`);
      break;
    }
    await sleep(2000);
  }
  if (!vw) {
    console.error('No device video after ~140s — box did not stream; aborting (session deleted).');
    process.exit(1);
  }
  console.log(`ensuring ${PROBE_URL} is loaded…`);
  for (let i = 0; i < 20; i++) {
    if (i % 3 === 0) await publish({ type: 'navigate', url: PROBE_URL });
    await sleep(1500);
    const l = await luma();
    console.log(`  load t+${((i + 1) * 1.5).toFixed(1)}s luma=${l}`);
    if (l >= 0 && l < 110) break; // gradient TOP is dark → low luma once it lands
  }
  await sleep(1500);

  // 5. scroll test. Inject a scroll-DOWN: finger STARTS low + moves UP monotonically
  //    (the fork scrolls by lastTouchPoint - current, so finger-up = content-down).
  //    Sample luma after each step (with a settle so the streamed frame catches up).
  let tid = 1000;
  async function runDrag(label, startY, stepPx, steps, recenterEvery) {
    console.log(
      `\n=== DRAG [${label}] startY=${startY} step=${stepPx} steps=${steps}${recenterEvery ? ` recenterEvery=${recenterEvery}` : ''} ===`,
    );
    const trace = [];
    const samp = async (tag) => {
      await sleep(120); // let the box render + stream the frame
      const l = await luma();
      trace.push(l);
      return l;
    };
    const X = 200;
    let y = startY;
    let id = tid++;
    await publish({ type: 'touchStart', x: X, y, touchId: id });
    const base = await samp('start');
    for (let i = 1; i <= steps; i++) {
      // re-centre (lift + re-anchor low) to test the multi-leg path on the fork
      if (recenterEvery && i % recenterEvery === 0) {
        await publish({ type: 'touchEnd', x: X, y, touchId: id });
        y = startY;
        id = tid++;
        await publish({ type: 'touchStart', x: X, y, touchId: id });
      } else {
        y -= stepPx;
      }
      await publish({ type: 'touchMove', x: X, y, touchId: id });
      await samp('m' + i);
    }
    await publish({ type: 'touchEnd', x: X, y, touchId: id });
    await samp('end1');
    await samp('end2');

    // analysis: for a scroll-DOWN the luma trace must be NON-DECREASING.
    let runMax = trace[0];
    let dips = 0;
    let maxDip = 0;
    for (let i = 1; i < trace.length; i++) {
      if (trace[i] < runMax - NOISE) {
        dips++;
        maxDip = Math.max(maxDip, runMax - trace[i]);
      }
      runMax = Math.max(runMax, trace[i]);
    }
    const net = Math.round((trace[trace.length - 1] - base) * 10) / 10;
    console.log(`  luma trace: ${trace.join(' ')}`);
    console.log(
      `  baseline=${base} net=${net} (>0 = scrolled down) | dips=${dips} maxDip=${Math.round(maxDip * 10) / 10}`,
    );
    let verdict;
    if (net <= NOISE && dips === 0)
      verdict = 'NO-SCROLL (luma flat — box may not honor the touch, or page not scrollable)';
    else if (dips === 0 && net > NOISE) verdict = 'PASS — monotonic scroll-down, no bounce';
    else
      verdict = `BOUNCE — ${dips} dip(s), maxDip=${Math.round(maxDip * 10) / 10} luma (page scrolled back UP mid-drag)`;
    console.log(`  VERDICT [${label}]: ${verdict}`);
    return { label, base, net, dips, maxDip, trace, verdict };
  }

  // STRAY-MOVE: the decisive regression for A3's W2770 fork gate (the proven back-up cause).
  // Scroll down a bit, lift (touchEnd), then send a touchMove with NO active finger at a y
  // far BELOW the drag end → the buggy fork reads a big NEGATIVE delta off the stale
  // lastTouchPoint and scrolls the page back UP. Pre-W2770: luma DROPS (bounce reproduced).
  // Post-W2770 (m_driftstackTouchActive gate): the move is ignored → luma FLAT.
  // sameId=true → the stray move reuses the JUST-ENDED finger's touchId (a "late move
  // after touchEnd" — matches A3's exact repro). sameId=false → a fresh orphan id (no
  // touchStart at all). Try BOTH so the probe reliably reproduces A3's down-less-move
  // bounce regardless of whether the fork keys the gate on touchId or on a global flag.
  async function runStrayMove(label, sameId) {
    console.log(`\n=== STRAY-MOVE [${label}] (regression for A3 W2770 down-less-move gate) ===`);
    const X = 200;
    const id = tid++;
    await publish({ type: 'touchStart', x: X, y: 700, touchId: id });
    await sleep(150);
    for (let y = 650; y >= 250; y -= 50) {
      await publish({ type: 'touchMove', x: X, y, touchId: id });
      await sleep(110);
    }
    await publish({ type: 'touchEnd', x: X, y: 250, touchId: id });
    await sleep(300);
    const afterDrag = await luma();
    const strayId = sameId ? id : tid++; // a move with NO active finger (after touchEnd)
    await publish({ type: 'touchMove', x: X, y: 760, touchId: strayId });
    await sleep(350);
    const afterStray = await luma();
    const delta = Math.round((afterStray - afterDrag) * 10) / 10;
    console.log(`  luma afterDrag=${afterDrag} afterStray=${afterStray} delta=${delta}`);
    const verdict =
      delta < -NOISE
        ? `BOUNCE REPRODUCED — down-less move (${label}) scrolled the page back UP (${afterDrag}->${afterStray}). Pre-W2770 / gate not effective.`
        : `GATED — down-less move (${label}) did NOT scroll (${afterDrag}->${afterStray}, flat).`;
    console.log(`  VERDICT [stray-${label}]: ${verdict}`);
    return { label: `stray-${label}`, verdict, bounce: delta < -NOISE };
  }

  // === --e2e: THE FULL LIVE FLOW through the REAL GUI wheel->touch converter (W2769) ===
  // Mounts the bundled REAL useInputCapture converter on the live #dsvid box stream, wires
  // its emitted touch straight to publishData, then dispatches a realistic macOS trackpad
  // scroll-DOWN WheelEvent stream at it. Measures the real scroll via luma. This is the only
  // path that exercises the founder's ACTUAL chain (trackpad wheel -> converter ->
  // DataChannel -> box -> scroll); the hand-crafted modes above never touch the converter.
  async function runE2E() {
    console.log('\n=== E2E [real wheel -> REAL converter -> DataChannel -> box] ===');
    if (!fs.existsSync(HARNESS_PATH)) {
      console.error(
        `harness bundle missing at ${HARNESS_PATH} — build it first:\n  node scripts/scroll-e2e/build.mjs`,
      );
      return { label: 'e2e', verdict: 'NO-HARNESS', noScroll: true, bounce: false };
    }

    // (1) inject the bundled REAL converter into THIS probe page (same page that owns
    //     window.__dsRoom + #dsvid + window.__avgLuma).
    await page.addScriptTag({ path: HARNESS_PATH });

    // (2) wire the converter's emitted touch straight to the box DataChannel, and (3) mount
    //     the converter on the REAL #dsvid box-stream element. The harness's __dsMountConverter
    //     stubs getBoundingClientRect AND overrides videoWidth/videoHeight to 402x874; per the
    //     task we keep #dsvid's REAL videoWidth/videoHeight (the box capture IS 402x874, but
    //     mapping must use the real attached track) while keeping the 402x874 rect stub the
    //     converter's pointerToViewport needs in a headless page (the <video> CSS box is the
    //     full viewport, not the capture size). We re-define the real dims back after mount.
    const mounted = await page.evaluate(() => {
      const vid = document.getElementById('dsvid');
      if (!vid) return { ok: false, why: 'no #dsvid' };
      if (typeof window.__dsMountConverter !== 'function')
        return { ok: false, why: '__dsMountConverter missing (harness not injected)' };
      const realW = vid.videoWidth;
      const realH = vid.videoHeight;
      // (2) publish each emitted InputEvent to the box exactly like sendInputEvent does.
      window.__dsPublishTouch = (ev) => {
        try {
          const data = new TextEncoder().encode(JSON.stringify(ev));
          window.__dsRoom.localParticipant.publishData(data, { reliable: true });
        } catch (e) {
          /* never throw back into the converter */
        }
      };
      window.__dsResetLog && window.__dsResetLog();
      // (3) mount the REAL converter on the live #dsvid. __dsMountConverter applies the
      //     402x874 rect stub (good — the headless <video> CSS box is viewport-sized, not the
      //     capture size, so pointerToViewport needs the real capture rect to map wheel coords).
      window.__dsMountConverter(vid);
      // …but restore the REAL videoWidth/videoHeight the stub clobbered, so the converter maps
      //  against the actual attached device track dims (per task instruction).
      if (realW > 0) Object.defineProperty(vid, 'videoWidth', { value: realW, configurable: true });
      if (realH > 0)
        Object.defineProperty(vid, 'videoHeight', { value: realH, configurable: true });
      return { ok: true, realW, realH };
    });
    if (!mounted.ok) {
      console.error(`  E2E mount failed: ${mounted.why}`);
      return {
        label: 'e2e',
        verdict: `MOUNT-FAILED (${mounted.why})`,
        noScroll: true,
        bounce: false,
      };
    }
    console.log(`  converter mounted on #dsvid (real track ${mounted.realW}x${mounted.realH})`);

    // A realistic macOS two-finger scroll-DOWN stream (matches smoke.mjs + the realtiming
    // reference test): a finger-drag ramp (deltaY 5..40) then an inertial momentum tail
    // (deltaY decays ~42*exp(-i/9), SAME positive sign), ~12ms apart. All deltaY > 0.
    const wheelStream = [];
    for (let i = 0; i < 8; i++) wheelStream.push({ dy: 5 + i * 5, dt: 12 });
    for (let i = 0; i < 34; i++)
      wheelStream.push({ dy: Math.max(1, Math.round(42 * Math.exp(-i / 9))), dt: 12 });

    // (5) sample luma over time: a baseline, then through the wheel stream, then a settle tail.
    const trace = [];
    const tags = [];
    const samp = async (tag) => {
      const l = await luma();
      trace.push(l);
      tags.push(tag);
      return l;
    };
    const base = await samp('base');

    // (4) dispatch the wheel stream on #dsvid via __dsFireWheel — drives the REAL converter
    //     live (its real rAF coalescer + 320ms idle run under real browser timing). Sample
    //     luma every few wheels so the trace captures the scroll progression.
    for (let i = 0; i < wheelStream.length; i++) {
      const e = wheelStream[i];
      await page.evaluate((dy) => window.__dsFireWheel(0, dy), e.dy);
      await sleep(e.dt);
      if (i % 6 === 5) await samp('w' + (i + 1)); // ~7 mid-stream samples
    }
    // settle: let the converter's 320ms idle flush the final touchEnd + the box render+stream.
    for (let i = 0; i < 8; i++) {
      await sleep(150);
      await samp('s' + (i + 1));
    }

    // How many touch events the REAL converter actually emitted (sanity: the chain ran).
    const emitted = await page.evaluate(() => {
      const log = Array.isArray(window.__dsTouchLog) ? window.__dsTouchLog : [];
      const c = { touchStart: 0, touchMove: 0, touchEnd: 0 };
      for (const e of log) if (e.type in c) c[e.type]++;
      return { total: log.length, ...c };
    });
    console.log(
      `  converter emitted: ${emitted.total} events (start=${emitted.touchStart} move=${emitted.touchMove} end=${emitted.touchEnd})`,
    );

    // (6) verdict: for a scroll-DOWN the luma trace must RISE MONOTONICALLY (non-decreasing
    //     within NOISE) with NO dip (a dip below the running max = the page bounced back UP)
    //     and reach a clear NET increase.
    let runMax = trace[0];
    let dips = 0;
    let maxDip = 0;
    for (let i = 1; i < trace.length; i++) {
      if (trace[i] < runMax - NOISE) {
        dips++;
        maxDip = Math.max(maxDip, runMax - trace[i]);
      }
      runMax = Math.max(runMax, trace[i]);
    }
    const net = Math.round((trace[trace.length - 1] - base) * 10) / 10;
    console.log(`  luma trace: ${trace.map((l, i) => `${tags[i]}=${l}`).join(' ')}`);
    console.log(
      `  baseline=${base} net=${net} (>0 = scrolled down) | dips=${dips} maxDip=${Math.round(maxDip * 10) / 10}`,
    );
    let verdict;
    let noScroll = false;
    let bounce = false;
    if (emitted.touchMove < 1) {
      verdict = 'NO-SCROLL (converter emitted no touchMove — wheel->touch did not run)';
      noScroll = true;
    } else if (net <= NOISE && dips === 0) {
      verdict =
        'NO-SCROLL (luma flat — box did not honor the published touch, or page not scrollable)';
      noScroll = true;
    } else if (dips > 0) {
      verdict = `BOUNCE — ${dips} dip(s), maxDip=${Math.round(maxDip * 10) / 10} luma (page scrolled back UP mid/after the real wheel stream)`;
      bounce = true;
    } else {
      verdict =
        'PASS — real trackpad wheel -> REAL converter -> box scrolled DOWN monotonically, no bounce';
    }
    console.log(`  VERDICT [e2e]: ${verdict}`);
    return { label: 'e2e', base, net, dips, maxDip, trace, verdict, noScroll, bounce };
  }

  // STUCK-FINGER: the dropped-touchEnd case A3 found (audit #5 → fork fix W2780). Scroll
  // down but DROP the touchEnd, wait past the 250ms re-anchor window, then send a late move
  // on the still-"active" finger. A fork WITHOUT W2780 lets the stale finger FLING the page
  // (luma jumps); WITH W2780 (>250ms gap => re-anchor) the late move is re-anchored => no
  // fling (luma flat). Always sends a final touchEnd to clean up the stuck finger.
  async function runStuckFinger() {
    console.log(`\n=== STUCK-FINGER (regression for A3 W2780 dropped-touchEnd fling) ===`);
    const X = 200;
    const id = tid++;
    await publish({ type: 'touchStart', x: X, y: 700, touchId: id });
    await sleep(150);
    for (let y = 650; y >= 250; y -= 50) {
      await publish({ type: 'touchMove', x: X, y, touchId: id });
      await sleep(110);
    }
    await sleep(600); // DROP the touchEnd → stuck finger; wait past the 250ms re-anchor window
    const afterScroll = await luma();
    await publish({ type: 'touchMove', x: X, y: 760, touchId: id }); // late move on the stuck finger
    await sleep(350);
    const afterLate = await luma();
    await publish({ type: 'touchEnd', x: X, y: 760, touchId: id }); // clean up the stuck finger
    const delta = Math.round((afterLate - afterScroll) * 10) / 10;
    console.log(`  luma afterScroll=${afterScroll} afterLate=${afterLate} delta=${delta}`);
    const verdict =
      Math.abs(delta) > NOISE
        ? `FLUNG — the stuck-finger late move MOVED the page (luma ${afterScroll}->${afterLate}, |Δ|=${Math.abs(delta)}). Expected pre-W2780; the gap re-anchor is not effective here.`
        : `RE-ANCHORED — the stuck-finger late move did NOT move the page (luma ${afterScroll}->${afterLate}, flat). W2780 gap-reanchor working.`;
    console.log(`  VERDICT [stuck-finger]: ${verdict}`);
    return { label: 'stuck-finger', verdict, flung: Math.abs(delta) > NOISE };
  }

  // FLOOD: stress the box's serial WD-inject FIFO to reproduce/verify the "keeps scrolling a
  // minute" runaway (founder). Burst MANY touchMoves from inside the page (faster than the box
  // injects), STOP, then sample luma for ~6s and measure the DRAIN — how long the page keeps
  // moving after input ends. Pre-coalescer: the FIFO drains for seconds (the runaway).
  // Post-coalescer (drop-intermediate + inject-latest): settles ~immediately.
  async function runFlood() {
    console.log('\n=== FLOOD (runaway / FIFO-backlog drain test) ===');
    const sent = await page.evaluate(async () => {
      const room = window.__dsRoom;
      const enc = new TextEncoder();
      const pub = (ev) =>
        room.localParticipant.publishData(enc.encode(JSON.stringify(ev)), { reliable: true });
      let y = 700;
      let id = 9000;
      let n = 0;
      await pub({ type: 'touchStart', x: 200, y, touchId: id });
      for (let i = 0; i < 300; i++) {
        y -= 8;
        if (y < 110) {
          await pub({ type: 'touchEnd', x: 200, y, touchId: id });
          y = 700;
          id += 1;
          await pub({ type: 'touchStart', x: 200, y, touchId: id });
        } else {
          await pub({ type: 'touchMove', x: 200, y, touchId: id });
          n += 1;
        }
      }
      await pub({ type: 'touchEnd', x: 200, y, touchId: id });
      return n;
    });
    console.log(`  flooded ${sent} touchMoves back-to-back; sampling drain ~6s…`);
    const samples = [];
    for (let i = 0; i < 30; i++) {
      await sleep(200);
      samples.push(await luma());
    }
    let lastChange = 0;
    for (let i = 1; i < samples.length; i++) {
      if (Math.abs(samples[i] - samples[i - 1]) > NOISE) lastChange = i;
    }
    const drainMs = lastChange * 200;
    console.log(`  luma: ${samples.map((s) => s.toFixed(1)).join(' ')}`);
    console.log(`  DRAIN after last input: ~${drainMs}ms`);
    const verdict =
      drainMs <= 600
        ? `PASS — settled ~${drainMs}ms after input (no FIFO-backlog runaway)`
        : `RUNAWAY — page kept scrolling ~${drainMs}ms after input stopped (FIFO draining; coalescer not effective)`;
    console.log(`  VERDICT [flood]: ${verdict}`);
    return { label: 'flood', verdict, drainMs, runaway: drainMs > 600 };
  }

  const out = [];
  if (E2E) {
    out.push(await runE2E());
  } else if (MODE === 'flood') {
    out.push(await runFlood());
  } else {
    if (MODE === 'clean' || MODE === 'both')
      out.push(await runDrag('clean-single-leg', 700, 50, 12, 0)); // 700→100, 600px, one leg
    if (MODE === 'legs' || MODE === 'both')
      out.push(await runDrag('multi-leg-recenter', 700, 50, 18, 6)); // re-centre every 6 moves
    if (MODE === 'stray' || MODE === 'both') {
      out.push(await runStrayMove('sameid', true));
      out.push(await runStrayMove('newid', false));
    }
    if (MODE === 'stuck' || MODE === 'both') out.push(await runStuckFinger());
  }

  console.log('\n===== SCROLL PROBE SUMMARY =====');
  for (const r of out) console.log(`  [${r.label}] ${r.verdict}`);
  if (E2E) {
    const e = out[0];
    if (e.bounce) {
      console.log(
        'The REAL GUI wheel->touch converter, driven by a realistic trackpad scroll-DOWN, BOUNCED the live box (luma dipped). The founder path reproduces the back-up.',
      );
      exitCode = 3;
    } else if (e.noScroll) {
      console.log(
        'Inconclusive — the converter ran but the live box showed no scroll (luma flat). See trace above.',
      );
      exitCode = 4;
    } else {
      console.log(
        'A real trackpad scroll-DOWN through the REAL GUI converter scrolled the live box DOWN monotonically with NO bounce. Founder path verified end-to-end.',
      );
    }
  } else {
    const cleanBounce = out.some((r) => r.dips > 0);
    const strayBounce = out.some((r) => r.bounce);
    const floodRunaway = out.some((r) => r.runaway);
    const cleanScrolled = out.filter((r) => r.net !== undefined).every((r) => r.net > NOISE);
    if (floodRunaway) {
      console.log(
        'A heavy touch-flood kept the page scrolling AFTER input stopped (FIFO-backlog runaway = the "scrolls a minute later"). The box-side coalescer is not effective here.',
      );
      exitCode = 6;
    } else if (out.some((r) => r.label === 'flood')) {
      console.log(
        'A heavy touch-flood settled promptly after input stopped — the box drops intermediate moves (no FIFO-backlog runaway). Coalescer verified on the live box.',
      );
    } else if (cleanBounce) {
      console.log('A clean monotonic drag itself bounced => fork mishandles even clean input.');
      exitCode = 3;
    } else if (strayBounce) {
      console.log(
        'A down-less move bounced the page (A3 W2770 root cause) — gate not yet live here.',
      );
      exitCode = 3;
    } else if (out.some((r) => r.flung)) {
      console.log(
        'A dropped-touchEnd stuck finger FLUNG the page (A3 W2780 case) — expected pre-W2780; the W2770 down-less-move path is clean. Re-run after W2780 deploys to confirm RE-ANCHORED.',
      );
      exitCode = 5;
    } else if (cleanScrolled) {
      console.log(
        'Clean drags scrolled DOWN monotonically with NO bounce, and the down-less move was gated. Scroll verified on the live box.',
      );
    } else {
      console.log('Inconclusive — a drag showed no scroll (luma flat). See traces above.');
      exitCode = 4;
    }
  }
} catch (e) {
  console.error('ERR', e?.message ?? e);
  exitCode = 1;
} finally {
  if (browser) await browser.close().catch(() => {});
  if (sid && !KEEP) {
    const d = await fetch(`${BASE}/v1/agent-sessions/${sid}`, { method: 'DELETE', headers: H })
      .then((r) => r.status)
      .catch(() => 'err');
    console.log(`DELETE session ${sid} → http ${d}`);
  } else if (sid) {
    console.log(`--keep set; session ${sid} left running.`);
  }
  process.exit(exitCode);
}
