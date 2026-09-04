#!/usr/bin/env node
// Autonomous sim-behavior probe (task #43, founder 2026-06-21) — measure
// tap-LANDING accuracy on the LIVE box with NO human, so we can iterate the
// tap/coordinate pipeline to 100%.
//
// It creates a real agent session (mirrors the GUI: profile_id + manual),
// connects to the session's LiveKit room as an ordinary participant (a headless
// Playwright/chromium page running livekit-client — A3 confirmed the box injects
// data-channel InputEvents from ANY participant), publishes navigate + tap
// InputEvents EXACTLY like the GUI (apps/gui-client/src/lib/livekit.ts), then
// reads back where each tap landed by polling the server's page-state for the
// session (the test page at driftstack.io/sim-probe.html encodes the hit cell
// into title/url#hash). Always deletes the session.
//
// Run (key via env — NEVER hardcode/log it):
//   DS_KEY="$(security find-generic-password -s dev.driftstack.gui -w)" \
//     node scripts/sim-tap-probe.mjs
// Options:
//   --taps "x,y x,y ..."   video-px points to tap (default: a spread grid)
//   --url <https-url>      page to navigate to (default sim-probe.html)
//   --proxy <id|none>      egress proxy (default: the account's first proxy)
//   --ycomp <n>            subtract n from each injected tap Y (mimic the GUI's
//                          devY title-band compensation) while measuring error vs
//                          the ORIGINAL aim → verifies the GUI's -n offset (the
//                          +32 title-band fix) drives the landing error to ~0
//   --keep                 do NOT delete the session (debugging)
//
// NOTE: this never prints DS_KEY or the LiveKit token. Diagnostic-first: it logs
// whatever each observation source returns each tick, so the first run TELLS us
// which source reflects the tap (A3's page_state emit may ride a later deploy).

import { chromium } from 'playwright';

const BASE = 'https://api.driftstack.dev';
const KEY = process.env.DS_KEY;
if (!KEY || KEY.length < 8) {
  console.error(
    'Missing DS_KEY. Run:\n  DS_KEY="$(security find-generic-password -s dev.driftstack.gui -w)" node scripts/sim-tap-probe.mjs',
  );
  process.exit(2);
}
const H = { authorization: 'Bearer ' + KEY, 'content-type': 'application/json' };

// ---- args ----
const argv = process.argv.slice(2);
const getFlag = (name) => argv.includes(name);
const getOpt = (name, def) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const KEEP = getFlag('--keep');
// --cleantap: send a zero-move touchStart+touchEnd (what the GUI emits for a TAP)
// instead of a {type:'tap'} — verifies the box treats a no-move touch as a tap, not
// a scroll (A3 W2736/W2737 clean-gesture confirmation).
const CLEANTAP = getFlag('--cleantap');
const PROBE_URL = getOpt('--url', 'https://driftstack.io/sim-probe.html');
// Title-band compensation to mimic the GUI's devY (set --ycomp 32 to verify the
// shipped tap fix): inject y-YCOMP but score error against the original aim.
const YCOMP = parseInt(getOpt('--ycomp', '0'), 10) || 0;
const DEFAULT_TAPS = '50,120 150,120 250,120 350,120 120,320 280,520';
const TAPS = getOpt('--taps', DEFAULT_TAPS)
  .trim()
  .split(/\s+/)
  .map((p) => p.split(',').map((n) => parseInt(n, 10)))
  .filter((p) => p.length === 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jres = async (r) => {
  const t = await r.text();
  try {
    return { status: r.status, body: JSON.parse(t) };
  } catch {
    return { status: r.status, body: t };
  }
};

// Parse a landed cell ("r,c") out of whatever the observation surface gives us.
function parseLanded(obs) {
  if (!obs) return null;
  const fields = [obs.title, obs.url, obs.page_state?.url, obs.page_state?.title].filter(
    (x) => typeof x === 'string',
  );
  for (const f of fields) {
    const m = f.match(/tap[:=](\d+),(\d+)/);
    if (m) return m[1] + ',' + m[2];
  }
  return null;
}

// Best-effort: gather every observable signal for the session this tick.
async function observe(sid) {
  const out = {};
  try {
    const ps = await fetch(`${BASE}/v1/agent-sessions/${sid}/page-state`, { headers: H }).then(
      jres,
    );
    out.page_state = ps.body?.page_state ?? null;
  } catch {
    /* ignore */
  }
  try {
    const ag = await fetch(`${BASE}/v1/agent-sessions/${sid}`, { headers: H }).then(jres);
    out.status = ag.body?.status;
    // Some deployments surface the latest driver state inline on the agent get.
    out.url = ag.body?.state?.url ?? ag.body?.url ?? undefined;
    out.title = ag.body?.state?.title ?? ag.body?.title ?? undefined;
    out.driverSessionId = ag.body?.driftstack_session_id ?? ag.body?.session_id ?? undefined;
  } catch {
    /* ignore */
  }
  // If a driver session is linked, its /state carries url/title/page_state.
  if (out.driverSessionId) {
    try {
      const ds = await fetch(`${BASE}/v1/sessions/${out.driverSessionId}/state`, {
        headers: H,
      }).then(jres);
      if (ds.body && typeof ds.body === 'object') {
        out.url = out.url ?? ds.body.url ?? undefined;
        out.title = out.title ?? ds.body.title ?? undefined;
        out.page_state = out.page_state ?? ds.body.page_state ?? null;
      }
    } catch {
      /* ignore */
    }
  }
  return out;
}

function obsLine(o) {
  return `status=${o.status ?? '?'} url=${o.url ?? o.page_state?.url ?? '∅'} title=${o.title ?? '∅'} page_state=${JSON.stringify(o.page_state ?? null)}`;
}

let sid = null;
let browser = null;
const results = [];
try {
  // 1. pick a profile (mirrors a GUI launch).
  const profs = await fetch(`${BASE}/v1/profiles?limit=5`, { headers: H }).then(jres);
  const list = Array.isArray(profs.body?.data) ? profs.body.data : [];
  const prof = list[0];
  if (!prof?.id) {
    console.error('No profiles on this account — cannot launch a profile-backed session.');
    process.exit(1);
  }
  console.log(`profile: ${prof.id} (${prof.archetype ?? 'archetype?'})`);

  // 1b. resolve a working egress proxy (mirrors the GUI: a no-proxy session
  // uses the operator default which can be down → "SOCKS5 CONNECT failed").
  // --proxy <id|none>; default = the account's first proxy.
  const proxyArg = getOpt('--proxy', '');
  let proxyId;
  if (proxyArg === 'none') {
    proxyId = undefined;
  } else if (proxyArg) {
    proxyId = proxyArg;
  } else {
    const px = await fetch(`${BASE}/v1/account/me/proxies`, { headers: H }).then(jres);
    const pl = Array.isArray(px.body?.data) ? px.body.data : [];
    proxyId = pl[0]?.id;
  }
  console.log(`proxy: ${proxyId ?? '(none — operator default)'}`);

  // 2. create the agent session.
  const created = await fetch(`${BASE}/v1/agent-sessions`, {
    method: 'POST',
    headers: H,
    body: JSON.stringify({
      profile_id: prof.id,
      mode: 'manual',
      ...(proxyId ? { proxy_id: proxyId } : {}),
    }),
  }).then(jres);
  sid = created.body?.id ?? null;
  const lk = created.body?.livekit;
  if (!sid) {
    console.error('create failed:', JSON.stringify(created.body).slice(0, 300));
    process.exit(1);
  }
  console.log(
    `session: ${sid} | livekit: ${lk?.ws_url ? 'present' : 'ABSENT'} room=${lk?.room ?? '?'}`,
  );
  if (!lk?.ws_url || !lk?.token) {
    console.error(
      'No LiveKit join info on create — cannot inject input. Aborting (session will be deleted).',
    );
    process.exit(1);
  }

  // 3. headless chromium → livekit-client → connect to the room.
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
      // Subscribe + attach the device video so we can read frames.
      room.on(LK.RoomEvent.TrackSubscribed, (track) => {
        try {
          if (track.kind === 'video') track.attach(vid);
        } catch (e) {
          /* ignore */
        }
      });
      // Capture inbound DataChannel messages (A3's HarnessOutbound page_state etc.)
      // so we can VERIFY the exact live-URL wire shape the GUI consumer must parse.
      window.__dsData = [];
      room.on(LK.RoomEvent.DataReceived, (payload) => {
        try {
          window.__dsData.push(new TextDecoder().decode(payload));
        } catch (e) {
          /* ignore */
        }
      });
      // Capture the latest frame + find the green landing marker's centroid (the
      // sim-probe page draws a bright-green dot at the tapped point). Returns the
      // centroid in VIDEO pixels so we can compare to the aimed video-px.
      window.__grabGreen = () => {
        const w = vid.videoWidth,
          h = vid.videoHeight;
        if (!w || !h) return { found: false, count: 0, w: 0, h: 0 };
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const ctx = c.getContext('2d');
        ctx.drawImage(vid, 0, 0, w, h);
        const d = ctx.getImageData(0, 0, w, h).data;
        let n = 0,
          sx = 0,
          sy = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i + 1] > 170 && d[i] < 110 && d[i + 2] < 110) {
            const p = i >> 2;
            sx += p % w;
            sy += (p / w) | 0;
            n++;
          }
        }
        return n > 0
          ? { found: true, count: n, vx: Math.round(sx / n), vy: Math.round(sy / n), w, h }
          : { found: false, count: 0, w, h };
      };
      try {
        await room.connect(ws, token, { autoSubscribe: true });
      } catch (e) {
        return 'connect-error: ' + (e && e.message ? e.message : String(e));
      }
      // brief settle so the data channel + first video frame are up
      await new Promise((r) => setTimeout(r, 2500));
      console.log('[probe] room.state=' + room.state);
      return room.state;
    },
    { ws: lk.ws_url, token: lk.token },
  );
  console.log(`livekit connect: ${connState}`);
  if (connState !== 'connected') {
    console.error('Could not connect to the room as a participant — aborting (session deleted).');
    process.exit(1);
  }

  // publishData helper — mirrors gui-client sendInputEvent EXACTLY.
  const publish = (event) =>
    page.evaluate(async (ev) => {
      const room = window.__dsRoom;
      const data = new TextEncoder().encode(JSON.stringify(ev));
      await room.localParticipant.publishData(data, { reliable: true });
    }, event);

  // Avg luminance of the current frame — sim-probe.html is near-black (#0b0c0f);
  // the default landing (webkit.org) is bright. Lets us DETECT the page change
  // from the video (page_state is unreliable here), so we know navigate landed.
  await page.evaluate(() => {
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
      return Math.round(s / (d.length / 4) / 3);
    };
  });

  // 4. navigate to the probe page. The box starts on a default page (webkit.org)
  // + the data channel may not be ready immediately, so RE-SEND navigate a few
  // times after a settle, and confirm via the frame going dark (sim-probe.html).
  console.log(`navigate → ${PROBE_URL}`);
  await sleep(6000); // let the box + data channel come up before the first nav
  let navOk = false;
  for (let i = 0; i < 90; i++) {
    if (i % 5 === 0) await publish({ type: 'navigate', url: PROBE_URL });
    await sleep(1500);
    const luma = await page.evaluate(() => window.__avgLuma());
    if (i % 4 === 0 || luma >= 0)
      console.log(`  nav t+${((i + 1) * 1.5).toFixed(1)}s luma=${luma}`);
    if (luma >= 0 && luma < 40) {
      navOk = true; // dark frame → sim-probe.html (or its error page) is showing
      break;
    }
  }
  console.log(navOk ? 'navigate observed ✓ (dark frame = sim-probe)' : 'navigate NOT confirmed');

  // Log the device video resolution once — that's the aim-space for taps.
  const vdim = await page.evaluate(() => {
    const v = document.getElementById('dsvid');
    return { w: v.videoWidth, h: v.videoHeight };
  });
  console.log(`video dims: ${vdim.w}x${vdim.h}${vdim.w ? '' : ' (NO FRAME YET)'}`);

  // Verify the page-state STORE populates after navigate (the live-URL source the
  // GUI polls): GET /v1/agent-sessions/:id/page-state should return {state,url,…}
  // once the box's control-plane pageState frame lands. null here = not reaching
  // the server store (coordinate A3).
  try {
    const o0 = await observe(sid);
    console.log(
      `page-state after nav: ${JSON.stringify(o0.page_state)} | url=${o0.url ?? '∅'} | title=${o0.title ?? '∅'}`,
    );
  } catch {
    /* ignore */
  }

  // Capture what the box is ACTUALLY showing (the <video> fills the page) so we
  // can SEE whether navigate landed + where taps go. Visual self-debugging.
  try {
    await page.screenshot({ path: '/tmp/probe-nav.png' });
    console.log('saved frame → /tmp/probe-nav.png');
  } catch (e) {
    console.log('screenshot failed:', e?.message ?? e);
  }

  // 5. tap sweep — aim at each video-px; MEASURE the landed point from the green
  // marker in the video frame (self-contained), plus the page-state read (dual).
  if (YCOMP) console.log(`ycomp: injecting y-${YCOMP} (GUI devY), scoring vs original aim`);
  let tapNum = 0;
  for (const [x, y] of TAPS) {
    // Pre-tap marker position — so a tap that DOESN'T register (leaving the
    // marker where the previous tap put it) is detected as stale, not a false
    // measurement.
    const pre = await page.evaluate(() => window.__grabGreen());
    // Inject the (optionally) compensated Y, but score against the original aim:
    // with --ycomp 32 this mirrors the GUI's devY so a landing on (x,y) = err ~0.
    const iy = Math.max(0, y - YCOMP);
    if (CLEANTAP) {
      // Zero-move touch sequence = the GUI's clean tap. A green marker at (x,iy)
      // ⇒ the box synthesized a TAP (no scroll); a missing/shifted marker ⇒ scroll.
      const tid = 90000 + tapNum;
      await publish({ type: 'touchStart', x, y: iy, touchId: tid });
      await publish({ type: 'touchEnd', x, y: iy, touchId: tid });
    } else {
      await publish({ type: 'tap', x, y: iy });
    }
    await sleep(1600);
    const green = await page.evaluate(() => window.__grabGreen());
    const stale = green.found && pre.found && Math.hypot(green.vx - pre.vx, green.vy - pre.vy) < 6;
    if (stale) green.found = false; // treat an unmoved marker as a missed tap
    tapNum += 1;
    if (tapNum === 1) {
      try {
        await page.screenshot({ path: '/tmp/probe-tap.png' });
        console.log('saved post-tap frame → /tmp/probe-tap.png');
      } catch {
        /* ignore */
      }
    }
    // page-state observation (kept as a second source).
    let landed = null;
    let src = null;
    for (let i = 0; i < 3; i++) {
      const o = await observe(sid);
      landed = parseLanded(o);
      if (landed) {
        src = o.page_state?.url || o.url ? 'url' : 'title';
        break;
      }
      await sleep(800);
    }
    let err = null;
    let line;
    if (green.found) {
      const dx = green.vx - x;
      const dy = green.vy - y;
      err = Math.round(Math.hypot(dx, dy));
      line = `landed (${green.vx},${green.vy}) err (${dx},${dy}) |${err}|px [green n=${green.count}]`;
    } else if (stale) {
      line = `MISSED (marker unmoved — tap not registered)`;
    } else {
      line = `NO GREEN [video ${green.w}x${green.h}]`;
    }
    results.push({ x, y, green, err, landed });
    console.log(
      `tap (${x},${y}) → ${line}${landed ? ' | page-state ' + landed + ' [' + src + ']' : ''}`,
    );
  }

  // 5b. dump inbound DataChannel messages (A3 page_state etc.) — verify the exact
  // live-URL wire shape the GUI consumer (SimulatorWindow page_state parser) must
  // match, instead of guessing it.
  try {
    const data = await page.evaluate(() => window.__dsData || []);
    const pageStates = data.filter((d) => /url|state|page/i.test(d));
    console.log(
      `\n=== DataChannel inbound: ${data.length} msgs, ${pageStates.length} page_state-like ===`,
    );
    for (const d of pageStates.slice(0, 8)) console.log('  ' + d.slice(0, 300));
  } catch {
    /* ignore */
  }

  // 6. summary.
  console.log('\n=== SUMMARY ===');
  const measured = results.filter((r) => r.green?.found);
  console.log(
    `taps: ${results.length} | green-measured: ${measured.length} | page-state landings: ${results.filter((r) => r.landed).length}`,
  );
  if (measured.length) {
    const errs = measured.map((r) => r.err);
    const mean = Math.round(errs.reduce((a, b) => a + b, 0) / errs.length);
    const max = Math.max(...errs);
    console.log(`landing error: mean ${mean}px | max ${max}px (over ${measured.length} taps)`);
    for (const r of measured) {
      console.log(`  aim (${r.x},${r.y}) -> (${r.green.vx},${r.green.vy}) |${r.err}|px`);
    }
  } else {
    const anyVideo = results.some((r) => r.green && r.green.w > 0);
    console.log(
      anyVideo
        ? 'Video frames OK but NO GREEN found — the box may not have delivered the tap, or the page did not render the marker (confirm navigate observed + that the box honors taps).'
        : 'NO VIDEO frames (videoWidth=0) — autoSubscribe/track-attach issue or no video published; cannot measure from video.',
    );
  }
} catch (e) {
  console.error('ERR', e?.message ?? e);
} finally {
  if (browser) await browser.close().catch(() => {});
  if (sid && !KEEP) {
    const d = await fetch(`${BASE}/v1/agent-sessions/${sid}`, { method: 'DELETE', headers: H })
      .then((r) => r.status)
      .catch(() => 'err');
    console.log(`DELETE session ${sid} → http ${d}`);
  } else if (sid) {
    console.log(
      `--keep set; session ${sid} left running (delete it: DELETE /v1/agent-sessions/${sid})`,
    );
  }
}
