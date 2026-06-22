// LK.6.d scroll-vs-tap as a TIME + DISTANCE gesture (founder 2026-06-21 "taps
// still scroll instead of tapping"). The GUI streams a click as touchStart →
// touchMove* → touchEnd, and the fork flips tap→scroll on the FIRST touchMove past
// its 10px tapSlop. So to keep a tap a tap, the GUI now BUFFERS the touchStart: a
// gesture stays a TAP — emitting a clean touchStart+touchEnd at the PRESS point
// with NO touchMove (the box click-synths it; it can never scroll) — until it
// COMMITS to a drag. Commit = moved past MOVE_DEADZONE(14) AND held > DRAG_HOLD_MS
// (140ms, a deliberate scroll), OR moved past DRAG_HARD_PX(44, a fast flick). So a
// QUICK press→release never scrolls, even with several px of mouse/trackpad drift.
//
// These exercise the REAL hook in jsdom: a harness component wires useInputCapture
// to a stubbed <video> and we dispatch real MouseEvents (with controlled
// timeStamps) + assert the emitted InputEvent stream. sendInputEvent is mocked.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

const sendInputEvent = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent,
}));

const { useInputCapture } = await import('../../src/lib/livekit-input-capture');
import type { InputEvent, Room } from '../../src/lib/livekit';

/** A stub <video> sized 1:1 so video-px == element-px (the 402×874 CSS-point
 *  profile case — no bar-boxing, no scaling). */
function stubVideo(el: HTMLVideoElement): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 402, height: 874, right: 402, bottom: 874, x: 0, y: 0 }) as DOMRect;
  Object.defineProperty(el, 'videoWidth', { value: 402, configurable: true });
  Object.defineProperty(el, 'videoHeight', { value: 874, configurable: true });
}

function mountCapture(): HTMLVideoElement {
  const video = document.createElement('video');
  document.body.appendChild(video);
  stubVideo(video);
  function Wired(): JSX.Element {
    useInputCapture({ room: {} as Room, videoElement: video, enabled: true });
    return <span />;
  }
  render(<Wired />);
  return video;
}

function emittedTypes(): string[] {
  return sendInputEvent.mock.calls.map((c) => (c[1] as InputEvent).type);
}
function eventsOfType(type: string): InputEvent[] {
  return sendInputEvent.mock.calls.map((c) => c[1] as InputEvent).filter((e) => e.type === type);
}

/** Dispatch a MouseEvent with a CONTROLLED timeStamp (the gesture model is
 *  time-sensitive; jsdom would otherwise stamp every synchronous event ~equal). */
function fireMouse(el: HTMLElement, type: string, x: number, y: number, ts: number): void {
  const ev = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, 'timeStamp', { value: ts, configurable: true });
  el.dispatchEvent(ev);
}

/** Dispatch a release on WINDOW (the real WebView fires window `pointerup` BEFORE
 *  the element `mouseup`; the release handler must own the full logic there). */
function fireWindow(type: string, x: number, y: number, ts: number): void {
  const ev = new MouseEvent(type, {
    clientX: x,
    clientY: y,
    button: 0,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperty(ev, 'timeStamp', { value: ts, configurable: true });
  window.dispatchEvent(ev);
}

/** Dispatch a wheel event on the video element. */
function fireWheel(el: HTMLElement, deltaX: number, deltaY: number): void {
  el.dispatchEvent(
    new WheelEvent('wheel', { clientX: 200, clientY: 400, deltaX, deltaY, bubbles: true }),
  );
}

// The wheel→touch converter coalesces deltas + flushes on requestAnimationFrame.
// jsdom's rAF is async; queue the callbacks + drain them on demand so the tests can
// flush the coalescer deterministically (this MODELS production: many wheel events
// within one frame → a single coalesced touchMove).
let rafQueue: FrameRequestCallback[] = [];
function flushRaf(maxFrames = 30): void {
  let n = 0;
  while (rafQueue.length > 0 && n++ < maxFrames) {
    const batch = rafQueue;
    rafQueue = [];
    for (const cb of batch) cb(0);
  }
}

describe('useInputCapture — scroll-vs-tap (TIME + DISTANCE gesture)', () => {
  beforeEach(() => {
    sendInputEvent.mockClear();
    document.body.innerHTML = '';
    // The wheel→touch converter coalesces deltas + flushes on requestAnimationFrame;
    // jsdom's rAF is async, so run it synchronously here. In production multiple wheel
    // events within one real frame coalesce to a single touchMove; the synchronous
    // stub makes each fireWheel flush its accumulated delta so the tests stay sync.
    rafQueue = [];
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback): number => {
      rafQueue.push(cb);
      return rafQueue.length;
    });
    vi.stubGlobal('cancelAnimationFrame', () => {});
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('STILL TAP: press + release with no move → exactly touchStart then touchEnd at the press point (devY-compensated y), no touchMove', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 150, 300, 1000);
    fireMouse(video, 'mouseup', 150, 300, 1080);
    expect(emittedTypes()).toEqual(['touchStart', 'touchEnd']);
    expect(eventsOfType('touchStart')[0]).toMatchObject({ x: 150, y: 268 }); // 300 - 32 devY
    expect(eventsOfType('touchEnd')[0]).toMatchObject({ x: 150, y: 268 });
  });

  it('QUICK DRIFTY TAP: press + ~28px FAST drift + release → NO touchMove (the founder fix — a drifty quick tap no longer scrolls)', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 220, 420, 1040); // dist ~28 (>14, <44), 40ms (<140) → tap
    fireMouse(video, 'mouseup', 220, 420, 1060);
    const types = emittedTypes();
    expect(types).toContain('touchStart');
    expect(types).toContain('touchEnd');
    expect(eventsOfType('touchMove')).toHaveLength(0);
  });

  it('DECISIVE DRAG (>44px move): commits + streams touchMove + ends — a real scroll', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 200, 460, 1030); // dist 60 > 44 → commit despite being fast
    // Settle before releasing (>FLING_STALE_MS since the last move) so no inertial
    // fling kicks in — the touchEnd is then synchronous (a fling defers it via a
    // timer; that path is covered by the computeFlingPath unit tests).
    fireMouse(video, 'mouseup', 200, 460, 1300);
    const types = emittedTypes();
    expect(types).toContain('touchStart');
    expect(types).toContain('touchMove');
    expect(types).toContain('touchEnd');
  });

  it('SUSTAINED SMALL DRAG (>14px held >140ms): commits to a scroll', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 200, 420, 1200); // dist 20 (>14), elapsed 200ms (>140) → commit
    fireMouse(video, 'mouseup', 200, 420, 1220);
    expect(emittedTypes()).toContain('touchMove');
  });

  it('QUICK SMALL DRAG (>14px but <44px, <140ms): stays a TAP', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 200, 420, 1050); // dist 20, elapsed 50ms (<140), <44 → tap
    fireMouse(video, 'mouseup', 200, 420, 1070);
    expect(eventsOfType('touchMove')).toHaveLength(0);
  });

  it('COMMITTED touchStart is emitted at the PRESS point (so the scroll originates there), not the commit point', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 100, 100, 1000);
    fireMouse(video, 'mousemove', 100, 160, 1030); // 60px > 44 → commit
    fireMouse(video, 'mouseup', 100, 160, 1050);
    expect(eventsOfType('touchStart')[0]).toMatchObject({ x: 100, y: 68 }); // press 100 - 32 devY
  });

  it('LATCH: once committed, a follow-up move back near the press still streams', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 200, 460, 1030); // commit (60px)
    fireMouse(video, 'mousemove', 200, 406, 1050); // 6px from start — still streams once committed
    fireMouse(video, 'mouseup', 200, 406, 1070);
    expect(eventsOfType('touchMove').length).toBeGreaterThanOrEqual(2);
  });

  it('PER-GESTURE RESET: a jiggle after a prior drag is still a tap', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 200, 460, 1030); // drag
    fireMouse(video, 'mouseup', 200, 460, 1050);
    sendInputEvent.mockClear();
    fireMouse(video, 'mousedown', 100, 100, 2000);
    fireMouse(video, 'mousemove', 102, 101, 2040); // dist ~2 → tap
    fireMouse(video, 'mouseup', 102, 101, 2060);
    expect(emittedTypes()).not.toContain('touchMove');
  });

  it('RELEASE RACE (B1): a committed drag released via WINDOW pointerup (which beats the element mouseup) is still ENDED — release handling is not lost to the event-ordering race, and the duplicate mouseup no-ops (no stuck finger, no double end)', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 200, 300, 1010); // 100px up → commit
    // Real WebView ordering: window 'pointerup' fires BEFORE the element 'mouseup'.
    fireWindow('pointerup', 200, 300, 1500);
    fireMouse(video, 'mouseup', 200, 300, 1501); // arrives after → must no-op
    const types = emittedTypes();
    // The drag scrolled (touchMove) and the release was handled on the pointerup:
    // exactly one touchStart + one touchEnd (the fling is disabled → stops dead, no
    // glide; the duplicate mouseup is idempotent on active.current).
    expect(types).toContain('touchMove');
    expect(types.filter((t) => t === 'touchStart').length).toBe(1);
    expect(types.filter((t) => t === 'touchEnd').length).toBe(1);
  });

  it('OFF-VIDEO DRAG keeps scrolling: a committed drag that moves off the element still streams touchMove (clamped), not freeze', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 200, 320, 1030); // commit (80px)
    sendInputEvent.mockClear();
    // Wander off the right edge of the 402-wide video (clientX 600) — window
    // listener still fires; the move clamps to the edge and keeps scrolling.
    fireWindow('mousemove', 600, 300, 1060);
    expect(eventsOfType('touchMove').length).toBeGreaterThanOrEqual(1);
  });

  it('WHEEL scroll → a touchStream drag (touchStart+touchMove), NOT a swipe (no fork momentum stacking)', () => {
    const video = mountCapture();
    fireWheel(video, 0, 100); // scroll content down
    flushRaf();
    const types = emittedTypes();
    expect(types).toContain('touchStart');
    expect(types).toContain('touchMove');
    expect(types).not.toContain('swipe');
    // Scroll DOWN (deltaY>0) = finger swipes UP → the move y is above the start y.
    const ts = eventsOfType('touchStart')[0];
    const tm = eventsOfType('touchMove').at(-1) as InputEvent & { y: number };
    expect(tm.y).toBeLessThan((ts as InputEvent & { y: number }).y);
  });

  it('WHEEL scroll stays a continuous drag across many events (one touchStart, many moves) — no per-event swipe spam', () => {
    const video = mountCapture();
    for (let i = 0; i < 6; i++) fireWheel(video, 0, 40);
    flushRaf();
    // ONE finger (not 6), and the 6 wheel events COALESCE into a continuous touchMove
    // stream (≥1 move — production merges events within a frame), never per-event
    // `swipe` spam. The cumulative scroll (6×40 down = finger moved UP) is preserved.
    expect(eventsOfType('touchStart').length).toBe(1);
    const moves = eventsOfType('touchMove') as (InputEvent & { y: number })[];
    expect(moves.length).toBeGreaterThanOrEqual(1);
    expect(emittedTypes()).not.toContain('swipe');
    const ts0 = eventsOfType('touchStart')[0] as InputEvent & { y: number };
    expect(moves.at(-1)!.y).toBeLessThan(ts0.y);
  });

  it('WHEEL during a COMMITTED mouse drag is IGNORED — no second concurrent finger (audit: spurious pinch)', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400, 1000);
    fireMouse(video, 'mousemove', 200, 300, 1010); // 100px up → commit (mouse finger on the wire)
    sendInputEvent.mockClear();
    fireWheel(video, 0, 100); // spin the wheel while the mouse finger is still down
    // The wheel is ignored while a mouse gesture owns the single finger → no 2nd touchStart.
    expect(eventsOfType('touchStart')).toHaveLength(0);
  });

  it('a new mouse PRESS lifts an in-flight wheel-scroll finger (audit: no stuck second touch)', () => {
    const video = mountCapture();
    fireWheel(video, 0, 60); // starts a wheel drag — wheel finger held down
    flushRaf(); // flush the coalescer so the wheel finger is actually down
    sendInputEvent.mockClear();
    fireMouse(video, 'mousedown', 150, 300, 2000); // press within the 110ms wheel-idle window
    // onMouseDown calls endWheelDrag → a touchEnd lifts the lingering wheel finger.
    expect(eventsOfType('touchEnd').length).toBeGreaterThanOrEqual(1);
  });
});
