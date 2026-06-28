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
const KEYBOARD_H = 200; // the on-screen iOS keyboard, docked below the video when shown

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

  // #75 — the on-screen iOS keyboard docks BELOW the video (a flex sibling of the
  // flex-1 screen-host). When SHOWN the window must grow by exactly KEYBOARD_H, or
  // the screen-host loses that height and the video letterboxes into a bottom band.
  // When HIDDEN the keyboard is conditionally NOT rendered → zero extra height.
  it('keyboard HIDDEN (default) reserves no extra height', () => {
    expect(simulatorChromeHeight(false, false)).toBe(simulatorChromeHeight(false));
    expect(simulatorChromeHeight(true, false)).toBe(simulatorChromeHeight(true));
  });

  it('keyboard SHOWN adds exactly KEYBOARD_H to the chrome (content + browser mode)', () => {
    expect(simulatorChromeHeight(false, true)).toBe(
      simulatorChromeHeight(false, false) + KEYBOARD_H,
    );
    expect(simulatorChromeHeight(true, true)).toBe(simulatorChromeHeight(true, false) + KEYBOARD_H);
    expect(simulatorChromeHeight(false, true)).toBe(94 + KEYBOARD_H);
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
    keyboardVisible = false,
  ): void {
    const aspect = contentW / contentH; // live CONTENT aspect (e.g. 402/714)
    const phoneW = contentW + BEZEL_PAD;
    const height = simulatorWindowHeight(phoneW, aspect, browserMode, keyboardVisible);
    const chrome = simulatorChromeHeight(browserMode, keyboardVisible);
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

  // #75 — with the keyboard SHOWN the video STILL fills the screen-host exactly
  // (host == contentH, no bottom band): the window grew by KEYBOARD_H so the
  // keyboard docks below the full-aspect video, ≥2 archetypes, both modes.
  it('16 Pro content (402×714) keeps the exact video fit with the keyboard shown (content mode)', () => {
    expectExactFit('16pro+kbd', 402, 714, false, true);
  });
  it('16 Pro content (402×714) keeps the exact video fit with the keyboard shown (browser mode)', () => {
    expectExactFit('16pro+kbd', 402, 714, true, true);
  });
  it('13 Pro content (390×699) keeps the exact video fit with the keyboard shown', () => {
    expectExactFit('13pro+kbd', 390, 699, false, true);
  });

  it('showing the keyboard grows the window by exactly KEYBOARD_H (the video size is unchanged)', () => {
    const phoneW = 402 + BEZEL_PAD;
    const aspect = 402 / 714;
    const hiddenH = simulatorWindowHeight(phoneW, aspect, false, false);
    const shownH = simulatorWindowHeight(phoneW, aspect, false, true);
    expect(shownH - hiddenH).toBe(KEYBOARD_H);
    // The video-area height (window − chrome) is identical in both — the keyboard is
    // PURELY additive, never carved out of the screen-host (the #75 bottom-band bug).
    const hiddenHost = hiddenH - simulatorChromeHeight(false, false);
    const shownHost = shownH - simulatorChromeHeight(false, true);
    expect(shownHost).toBe(hiddenHost);
    expect(Math.round(shownHost)).toBe(714);
  });

  it('returns 0 for a non-positive aspect or a width below the bezel (caller guards)', () => {
    expect(simulatorWindowHeight(100, 0, false)).toBe(0);
    expect(simulatorWindowHeight(100, -1, false)).toBe(0);
    expect(simulatorWindowHeight(BEZEL_PAD, 0.5, false)).toBe(0);
  });
});
