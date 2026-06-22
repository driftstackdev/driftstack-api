#!/usr/bin/env node
// Autonomous SCROLL probe (founder 2026-06-22: "nothing fixed still the same. find
// auto ways to test scroll stuff, without needing me ... 100% fixed and verified").
//
// Measures, with NO human, whether a scroll-DOWN gesture actually scrolls the page DOWN
// MONOTONICALLY on the live box — i.e. whether the founder's "it scrolls me back up"
// reproduces. Mirrors sim-tap-probe.mjs: creates a real agent session, joins the
// session's LiveKit room as a headless participant, navigates the box to a TALL vertical
// gradient (driftstack.dev/scroll-probe.html — black top → white bottom, so the streamed
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
//
// Verdict: for a scroll-DOWN the luma trace must be NON-DECREASING (page shows lower =
// lighter content). A DIP below the running max by > NOISE = a BOUNCE (scrolled back up).
//
// Run (key via env — NEVER hardcode/log it):
//   DS_KEY="$(security find-generic-password -s dev.driftstack.gui -w)" node scripts/sim-scroll-probe.mjs
// Options: --url <https-url> (default scroll-probe.html) · --proxy <id|none> · --keep
//
// NEVER prints DS_KEY or the LiveKit token. Always deletes the session (unless --keep).

import { chromium } from 'playwright';

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
const PROBE_URL = getOpt('--url', 'https://driftstack.dev/scroll-probe.html');
const MODE = getOpt('--mode', 'both');
const NOISE = 3; // luma units of frame noise to tolerate before calling a dip a bounce

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
  // 1. profile + proxy (mirror a GUI launch).
  const profs = await fetch(`${BASE}/v1/profiles?limit=5`, { headers: H }).then(jres);
  const prof = (Array.isArray(profs.body?.data) ? profs.body.data : [])[0];
  if (!prof?.id) {
    console.error('No profiles on this account — cannot launch.');
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

  // 4. ensure the gradient page is loaded (initial_url should land it; re-send navigate
  //    a few times as a fallback, like the tap probe).
  console.log(`ensuring ${PROBE_URL} is loaded…`);
  await sleep(6000);
  for (let i = 0; i < 12; i++) {
    await publish({ type: 'navigate', url: PROBE_URL });
    await sleep(1500);
    const l = await luma();
    console.log(`  load t+${((i + 1) * 1.5).toFixed(1)}s luma=${l}`);
    if (l >= 0 && l < 90) break; // gradient TOP is dark → low luma once it lands
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

  const out = [];
  if (MODE === 'clean' || MODE === 'both')
    out.push(await runDrag('clean-single-leg', 700, 50, 12, 0)); // 700→100, 600px, one leg
  if (MODE === 'legs' || MODE === 'both')
    out.push(await runDrag('multi-leg-recenter', 700, 50, 18, 6)); // re-centre every 6 moves

  console.log('\n===== SCROLL PROBE SUMMARY =====');
  for (const r of out) console.log(`  [${r.label}] ${r.verdict}`);
  if (out.some((r) => r.dips > 0)) {
    console.log(
      'BOUNCE reproduced on the live box. A clean monotonic drag that still bounces => the FORK (box) is the cause (e.g. undeployed W2761 sub-pixel phantom), not the GUI converter.',
    );
    exitCode = 3;
  } else if (out.every((r) => r.net > NOISE)) {
    console.log('All drags scrolled DOWN monotonically with NO bounce on the live box.');
  } else {
    console.log('Inconclusive — at least one drag showed no scroll (luma flat). See traces above.');
    exitCode = 4;
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
