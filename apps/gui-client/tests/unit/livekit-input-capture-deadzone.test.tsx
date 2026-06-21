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

import { describe, expect, it, vi, beforeEach } from 'vitest';
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

describe('useInputCapture — scroll-vs-tap (TIME + DISTANCE gesture)', () => {
  beforeEach(() => {
    sendInputEvent.mockClear();
    document.body.innerHTML = '';
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
});
