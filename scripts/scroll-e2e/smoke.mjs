#!/usr/bin/env node
// SMOKE TEST (no box, no DS_KEY): drive the REAL useInputCapture wheel->touch converter in a
// real chromium page with a REALISTIC macOS trackpad scroll-DOWN wheel stream and assert the
// emitted touch stream is exactly what the converter SHOULD produce.
//
//   node scripts/scroll-e2e/build.mjs && node scripts/scroll-e2e/smoke.mjs
//
// This is the missing-middle test the founder asked for: the unit tests fake rAF/timers and
// the live probe hand-crafts touch; THIS exercises the REAL converter under REAL browser
// timing (real requestAnimationFrame ~16ms + the real 320ms idle setTimeout), driven by a
// real WheelEvent stream, with the SAME wheel->touch code path the GUI ships. The only thing
// stubbed is sendInputEvent (-> window.__dsTouchLog) and the video surface (402x874).
//
// Assertions (the converter's contract for a clean scroll-DOWN):
//   1. >= 1 touchStart (the gesture actually started)
//   2. within each touchId leg, touchMove y is STRICTLY NON-INCREASING (finger up = content
//      down; a y that goes back UP = the page bounced — the founder's "scrolls me back up")
//   3. no touchMove after that leg's touchEnd (no stray down-less move)
//   4. net finger travel is UP (last move y < first start y) — it really scrolled down
//   5. a SMALL number of legs (<=3) — not one-leg-per-wheel-event fragmentation

import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundlePath = path.join(here, 'harness.iife.js');
if (!fs.existsSync(bundlePath)) {
  console.error('harness.iife.js missing — run: node scripts/scroll-e2e/build.mjs');
  process.exit(2);
}
const bundle = fs.readFileSync(bundlePath, 'utf8');

// A realistic macOS two-finger scroll-DOWN (from livekit-input-capture-realtiming.test.tsx):
// a finger-drag ramp (deltaY grows 5..40) then an inertial MOMENTUM tail (deltaY decays
// exponentially, SAME positive sign), ~12ms apart. All deltaY > 0 = scroll content DOWN.
function macScrollDown(scale = 1) {
  const ev = [];
  for (let i = 0; i < 8; i++) ev.push({ dy: (5 + i * 5) * scale, dt: 12 });
  for (let i = 0; i < 34; i++)
    ev.push({ dy: Math.max(1, Math.round(42 * Math.exp(-i / 9))) * scale, dt: 12 });
  return ev;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let failures = [];
let summary = {};
try {
  browser = await chromium.launch({ args: ['--no-sandbox'] });
  const page = await browser.newPage();
  const logs = [];
  page.on('console', (m) => logs.push(m.text()));
  page.on('pageerror', (e) => failures.push('pageerror: ' + e.message));

  await page.setContent('<!doctype html><html><body style="margin:0"></body></html>');
  await page.addScriptTag({ content: bundle });

  // Mount the converter on a fresh stubbed 402x874 video.
  await page.evaluate(() => {
    if (typeof window.__dsMountConverter !== 'function')
      throw new Error('__dsMountConverter missing');
    window.__dsResetLog();
    window.__dsMountConverter();
  });

  // Feed the realistic wheel stream with REAL timing (real WheelEvent + real setTimeout gaps
  // so the converter's real requestAnimationFrame coalescer + 320ms idle behave as in prod).
  const stream = macScrollDown(1);
  for (const e of stream) {
    await page.evaluate((dy) => window.__dsFireWheel(0, dy), e.dy);
    await sleep(e.dt);
  }
  // Wait out the 320ms idle (+ margin) so the converter flushes the final touchEnd.
  await sleep(600);

  const log = await page.evaluate(() => window.__dsTouchLog);
  summary.rawCount = log.length;

  // ---- analyse the emitted stream ----
  const types = log.map((e) => e.type);
  const touchStarts = log.filter((e) => e.type === 'touchStart');
  const touchMoves = log.filter((e) => e.type === 'touchMove');
  const touchEnds = log.filter((e) => e.type === 'touchEnd');

  // (1) at least one touchStart
  if (touchStarts.length < 1) failures.push(`expected >=1 touchStart, got ${touchStarts.length}`);

  // (2)+(3)+(4): per-leg monotonic, no move-after-end-for-same-id, net travel UP.
  const startY = new Map();
  const lastY = new Map();
  const endedIds = new Set();
  let firstStartY = null;
  let lastMoveY = null;
  let bounceCount = 0;
  let strayAfterEnd = 0;
  for (const e of log) {
    if (e.type === 'touchStart') {
      startY.set(e.touchId, e.y);
      lastY.set(e.touchId, e.y);
      endedIds.delete(e.touchId);
      if (firstStartY === null) firstStartY = e.y;
    } else if (e.type === 'touchMove') {
      if (endedIds.has(e.touchId)) {
        strayAfterEnd++;
      }
      const prev = lastY.get(e.touchId);
      if (prev === undefined) {
        failures.push(`touchMove for leg ${e.touchId} with no preceding touchStart`);
      } else if (e.y > prev) {
        bounceCount++; // y increased = finger moved DOWN = page bounced UP
      }
      lastY.set(e.touchId, e.y);
      lastMoveY = e.y;
    } else if (e.type === 'touchEnd') {
      endedIds.add(e.touchId);
    }
  }
  if (bounceCount > 0)
    failures.push(
      `BOUNCE: ${bounceCount} touchMove(s) moved the finger DOWN within a leg (page scrolled back up)`,
    );
  if (strayAfterEnd > 0)
    failures.push(
      `STRAY: ${strayAfterEnd} touchMove(s) after that leg's touchEnd (down-less move)`,
    );

  // (4) net finger travel up
  if (firstStartY !== null && lastMoveY !== null && !(lastMoveY < firstStartY)) {
    failures.push(
      `net travel not UP: first start y=${firstStartY}, last move y=${lastMoveY} (expected last < first for scroll-down)`,
    );
  }
  if (touchMoves.length < 2)
    failures.push(`expected the scroll to actually move (>=2 touchMove), got ${touchMoves.length}`);

  // (5) small number of legs (no per-event fragmentation; runway ~389px => a ~600px scroll
  // needs at most a couple of edge re-centres).
  if (touchStarts.length > 3)
    failures.push(
      `fragmentation: ${touchStarts.length} legs (expected <=3 for one continuous scroll)`,
    );

  // every leg balanced: each touchStart eventually touchEnds (no stuck finger)
  if (touchEnds.length < touchStarts.length) {
    failures.push(
      `unbalanced: ${touchStarts.length} touchStart vs ${touchEnds.length} touchEnd (stuck finger)`,
    );
  }

  summary = {
    ...summary,
    touchStart: touchStarts.length,
    touchMove: touchMoves.length,
    touchEnd: touchEnds.length,
    legs: touchStarts.length,
    bounceCount,
    strayAfterEnd,
    firstStartY,
    lastMoveY,
    netTravelUp: firstStartY !== null && lastMoveY !== null ? firstStartY - lastMoveY : null,
    typeSequence: types.join(','),
  };

  console.log('=== SMOKE: REAL wheel->touch converter, realistic macOS scroll-DOWN ===');
  console.log(JSON.stringify(summary, null, 2));
  if (logs.length) console.log('page logs:', logs.join(' | '));

  if (failures.length === 0) {
    console.log(
      '\nSMOKE PASS — clean monotonic scroll-down, no bounce, no stray move, no fragmentation.',
    );
  } else {
    console.log('\nSMOKE FAIL:');
    for (const f of failures) console.log('  - ' + f);
  }
} catch (e) {
  failures.push('exception: ' + (e?.stack || e?.message || String(e)));
} finally {
  if (browser) await browser.close().catch(() => {});
  process.exit(failures.length === 0 ? 0 : 1);
}
