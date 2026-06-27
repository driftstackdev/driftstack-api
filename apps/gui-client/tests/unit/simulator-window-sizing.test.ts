// P1b — the simulator window-height math must size the device screen-host to EXACTLY
// the LIVE CONTENT aspect (videoW/videoH), so the <video> fills it edge-to-edge with
// NO bottom-black band. These pin the pure formula the four window-sizing sites share
// (so a missing status-strip / chrome term on one site can't silently re-introduce a
// top cutoff or a bottom gap), across ≥2 archetypes with content-only heights.

import { describe, expect, it } from 'vitest';
import { simulatorChromeHeight, simulatorWindowHeight } from '../../src/views/SimulatorWindow';

// The chrome constants, restated here so the test FAILS if any of them changes
// without the formula being re-reasoned (these are load-bearing for "no bottom gap").
const TOOLBAR_H = 34;
const BROWSER_BAR_H = 40;
const TAB_STRIP_H = 32;
const BEZEL_PAD = 20; // p-[10px] × 2
const STATUS_STRIP_H = 40; // the rendered <IosStatusBar/> the video sits BELOW

describe('simulatorChromeHeight — non-video chrome above/around the screen-host', () => {
  it('content mode (browser bars hidden) = toolbar + bezel + status strip', () => {
    // No browser bar / tab strip: just the Mac toolbar, bezel padding, and the
    // in-screen iOS status strip (which IS rendered — so it MUST be in the math).
    expect(simulatorChromeHeight(false)).toBe(TOOLBAR_H + BEZEL_PAD + STATUS_STRIP_H);
    expect(simulatorChromeHeight(false)).toBe(94);
  });

  it('browser mode adds the address bar + tab strip rows', () => {
    expect(simulatorChromeHeight(true)).toBe(
      TOOLBAR_H + BROWSER_BAR_H + TAB_STRIP_H + BEZEL_PAD + STATUS_STRIP_H,
    );
    expect(simulatorChromeHeight(true)).toBe(166);
  });
});

describe('simulatorWindowHeight — screen-host sized to the LIVE content aspect (P1b)', () => {
  // The screen-host gets contentW (= phoneW − BEZEL_PAD) wide and contentW/aspect
  // tall. window_height = chrome + contentW/aspect. The bottom of the video then sits
  // EXACTLY at the bottom of the screen-host — no band.
  function expectExactFit(
    label: string,
    contentW: number,
    contentH: number,
    browserMode: boolean,
  ): void {
    const aspect = contentW / contentH; // live CONTENT aspect (e.g. 402/714)
    const phoneW = contentW + BEZEL_PAD;
    const height = simulatorWindowHeight(phoneW, aspect, browserMode);
    const chrome = simulatorChromeHeight(browserMode);
    // The screen-host height the layout will give the <video> = window − chrome.
    const hostHeight = height - chrome;
    // It must equal contentW / aspect = contentH (within rounding) — i.e. the host
    // is the content aspect, so the video fills it with no top/bottom gap.
    expect(Math.abs(hostHeight - contentH)).toBeLessThanOrEqual(1);
    // And the host width (= contentW) ÷ host height ≈ the content aspect.
    expect(Math.abs(contentW / hostHeight - aspect)).toBeLessThan(0.005);
    // Sanity: a positive, integer height.
    expect(Number.isInteger(height)).toBe(true);
    expect(height).toBeGreaterThan(chrome);
    void label;
  }

  // iPhone 16 Pro — full device 402×874, content-only 402×714 (chrome freed).
  it('16 Pro content (402×714) fits exactly in content mode', () => {
    expectExactFit('16pro', 402, 714, false);
  });
  it('16 Pro content (402×714) fits exactly in browser mode', () => {
    expectExactFit('16pro', 402, 714, true);
  });

  // iPhone 13 Pro — full device 390×844, content-only 390×699.
  it('13 Pro content (390×699) fits exactly in content mode', () => {
    expectExactFit('13pro', 390, 699, false);
  });
  it('13 Pro content (390×699) fits exactly in browser mode', () => {
    expectExactFit('13pro', 390, 699, true);
  });

  it('uses the CONTENT aspect, not the full-device aspect (the bug): a 402×874 box would over-tall the window', () => {
    const phoneW = 402 + BEZEL_PAD;
    // Correct: sized to the content aspect (402×714).
    const contentHeight = simulatorWindowHeight(phoneW, 402 / 714, false);
    // The OLD bug: sizing the host to the content aspect but giving the panel box the
    // full-device 402:874 aspect made the video letterbox. Here we assert the host the
    // window provides is the CONTENT height (714), not the device height (874) — so the
    // panel box (now also content aspect) matches it exactly.
    const hostHeight = contentHeight - simulatorChromeHeight(false);
    expect(Math.round(hostHeight)).toBe(714);
    expect(Math.round(hostHeight)).not.toBe(874);
  });

  it('returns 0 for a non-positive aspect or a width below the bezel (caller guards)', () => {
    expect(simulatorWindowHeight(100, 0, false)).toBe(0);
    expect(simulatorWindowHeight(100, -1, false)).toBe(0);
    expect(simulatorWindowHeight(BEZEL_PAD, 0.5, false)).toBe(0);
  });
});
