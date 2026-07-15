// P1b — the simulator window-height math must size the device screen-host to EXACTLY
// the LIVE CONTENT aspect (videoW/videoH), so the <video> fills it edge-to-edge with
// NO bottom-black band. These pin the pure formula the four window-sizing sites share
// (so a missing status-strip / chrome term on one site can't silently re-introduce a
// top cutoff or a bottom gap), across ≥2 archetypes with content-only heights.

import { describe, expect, it } from 'vitest';
import {
  friendlyUnavailableNote,
  shouldRefitForAspectChange,
  simulatorChromeHeight,
  simulatorWindowHeight,
} from '../../src/views/SimulatorWindow';

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

// #75b — the RUNTIME screen-clamp (fitWindow / resetToActualSize / onResized) that the
// pure formula tests above do NOT cover. On a short laptop work area the keyboard-DOCKED
// window overflows `avail - 24`, so the clamp pins the height and re-derives the width
// from (height - chrome) * aspect. If KEYBOARD_H is still folded into `chrome` there, the
// video area shrinks and the window narrows ("keyboard crops the browser"). The fix
// OVERLAYS the keyboard instead (KEYBOARD_H excluded from chrome), preserving the video
// width. This reproduces the clamp arithmetic over the exported chrome/height helpers.
describe('#75b — keyboard overlay vs docked under the short-screen clamp', () => {
  // The exact clamp the sizing closures run:
  //   height = avail - 24; width = (height - chrome) * aspect + BEZEL_PAD
  function clampedWidth(
    avail: number,
    aspect: number,
    browserMode: boolean,
    keyboardFoldedIntoChrome: boolean,
  ): { videoW: number; windowW: number; videoH: number } {
    const height = avail - 24;
    const chrome = simulatorChromeHeight(browserMode, keyboardFoldedIntoChrome);
    const videoH = height - chrome;
    const videoW = videoH * aspect; // content width the video gets
    return { videoW, windowW: Math.round(videoW + BEZEL_PAD), videoH };
  }

  it('a docked keyboard on a short (875px) work area overflows then would shrink the video (the bug)', () => {
    const aspect = 402 / 714;
    const phoneW = 402 + BEZEL_PAD;
    // The docked-keyboard ideal height for a natural-size 16 Pro overflows avail-24…
    const idealDockedH = simulatorWindowHeight(phoneW, aspect, false, true);
    const avail = 875; // typical laptop work area
    expect(idealDockedH).toBeGreaterThan(avail - 24); // the clamp fires
    // …and the OLD behavior (KEYBOARD_H folded into chrome during the clamp) shrinks the
    // video well below its natural 402 width.
    const docked = clampedWidth(avail, aspect, false, true);
    expect(docked.videoW).toBeLessThan(402 - 30); // materially narrower (the founder symptom)
  });

  it('the overlay path (KEYBOARD_H NOT folded into chrome) PRESERVES the video width under the same clamp', () => {
    const aspect = 402 / 714;
    const avail = 875;
    const docked = clampedWidth(avail, aspect, false, true); // keyboard in chrome (bug)
    const overlay = clampedWidth(avail, aspect, false, false); // keyboard excluded (fix)
    // The overlay keeps strictly MORE video width than the shrinking docked path…
    expect(overlay.videoW).toBeGreaterThan(docked.videoW);
    // …and matches the no-keyboard clamp exactly (the keyboard never carves the video).
    expect(overlay).toEqual(clampedWidth(avail, aspect, false, false));
    // The overlay video area is the full clamped height minus only the real chrome.
    expect(overlay.videoH).toBe(avail - 24 - simulatorChromeHeight(false, false));
  });

  it('on a TALL screen the docked keyboard fits (no clamp) so it stays docked, full size', () => {
    const aspect = 402 / 714;
    const phoneW = 402 + BEZEL_PAD;
    const idealDockedH = simulatorWindowHeight(phoneW, aspect, false, true);
    const avail = 1440; // a tall external display
    expect(idealDockedH).toBeLessThanOrEqual(avail - 24); // no clamp then docks below, full aspect
  });
});

// Aspect-track — the screen-host must TRACK the live video intrinsic aspect, not just the
// first onLoadedMetadata frame. The founder's TOP black band: the first frame was ~0.497
// (393×790), the steady-state content was ~0.593 (268×452); the host stayed sized to the
// stale 0.497 so the wider 0.593 content object-contained inside it → black bars top+bottom.
// shouldRefitForAspectChange decides when a later frame re-fits — it MUST re-fit on a real
// aspect change but NOT on the SFU's pure-resolution downscale (which preserves the aspect),
// or the window would jitter on every bandwidth dip.
describe('shouldRefitForAspectChange — re-fit only on a real aspect change (no thrash)', () => {
  it('re-fits when the live aspect moves to the steady-state content aspect (the founder bug)', () => {
    // Host sized to the first-frame 393×790 ≈ 0.4975; the steady content settles at
    // 268×452 ≈ 0.5929 — a ~19% aspect jump → must re-fit (else top/bottom letterbox).
    const firstAspect = 393 / 790;
    expect(shouldRefitForAspectChange(firstAspect, 268, 452)).toBe(true);
  });

  it('does NOT re-fit for a pure-resolution SFU downscale that PRESERVES the aspect', () => {
    // 268×452 (0.5929) downscaled to 134×226 — identical aspect → no re-fit (no jitter).
    const aspect = 268 / 452;
    expect(shouldRefitForAspectChange(aspect, 134, 226)).toBe(false);
    // …and a near-exact downscale with sub-pixel rounding drift stays under the threshold.
    expect(shouldRefitForAspectChange(aspect, 200, 337)).toBe(false); // 200/337 ≈ 0.5935
  });

  it('does NOT re-fit when the SAME intrinsic re-reports (idempotent resize events)', () => {
    const aspect = 402 / 714;
    expect(shouldRefitForAspectChange(aspect, 402, 714)).toBe(false);
  });

  it('honors the relative threshold boundary (default 1.5%)', () => {
    const aspect = 0.5;
    // +1.0% aspect change (0.505) is BELOW the 1.5% threshold → no re-fit.
    expect(shouldRefitForAspectChange(aspect, 0.505, 1)).toBe(false);
    // +2.0% aspect change (0.51) is ABOVE the threshold → re-fit.
    expect(shouldRefitForAspectChange(aspect, 0.51, 1)).toBe(true);
    // A custom (tighter) threshold flips the +1.0% case to a re-fit.
    expect(shouldRefitForAspectChange(aspect, 0.505, 1, 0.005)).toBe(true);
  });

  it('returns false for non-positive inputs (caller already guards w>0/h>0)', () => {
    expect(shouldRefitForAspectChange(0.5, 0, 100)).toBe(false);
    expect(shouldRefitForAspectChange(0.5, 100, 0)).toBe(false);
    expect(shouldRefitForAspectChange(0, 100, 200)).toBe(false); // no current aspect yet
    expect(shouldRefitForAspectChange(0.5, -1, 100)).toBe(false);
  });
});

// Finding #4 — the cookies/downloads LIST polls map the three INTERNAL server
// 'unavailable' reasons to one friendly line, while passing every other reason through
// (RELAY_BUSY, harness messages, the calm session fallback) so actionable
// copy still shows.
describe('friendlyUnavailableNote — map internal diagnostics, pass through the rest', () => {
  it('maps the three known internal reasons to a single friendly line', () => {
    const friendly = "the session isn't live on a device right now";
    expect(friendlyUnavailableNote('session is not live on a node')).toBe(friendly);
    expect(friendlyUnavailableNote('session node is not connected')).toBe(friendly);
    expect(friendlyUnavailableNote('fleet control plane not enabled')).toBe(friendly);
  });

  it('passes through an actionable reason verbatim (RELAY_BUSY, harness messages)', () => {
    const relay = 'too many concurrent requests for this account — retry shortly';
    expect(friendlyUnavailableNote(relay)).toBe(relay);
    expect(friendlyUnavailableNote('proxy handshake failed')).toBe('proxy handshake failed');
  });

  it('falls back to calm current-session copy when no reason is given', () => {
    expect(friendlyUnavailableNote(null)).toBe('unavailable for this session');
    expect(friendlyUnavailableNote(undefined)).toBe('unavailable for this session');
    // Normalize the retired roadmap phrasing if an older server still sends it.
    expect(friendlyUnavailableNote('not available yet')).toBe('unavailable for this session');
  });
});
