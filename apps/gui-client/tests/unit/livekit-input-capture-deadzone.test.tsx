// LK.6.d scroll-vs-tap deadzone tests (A3 W2668; founder's "sometimes a tap also
// scrolls"). The GUI streams a click as touchStart → touchMove* → touchEnd; every
// sub-slop cursor drift between mousedown and mouseup fires its OWN touchMove. In
// the fork the FIRST touchMove past its 10px tapSlop flips the gesture tap→scroll,
// so a near-still click scrolls instead of clicking. useInputCapture now suppresses
// touchMoves within MOVE_DEADZONE (14 video-px) of the press point — raised from 6
// per A3's deep tap-path investigation (wpiyo8v6x): a real trackpad click drifts
// >6 video-px, so 6 still leaked a move + scrolled; 14 sits above the fork's 10px
// tapSlop with margin so a drifty click no longer scrolls.
//
// These exercise the REAL hook (not just the pure helpers) in jsdom: a harness
// component wires useInputCapture to a stubbed <video>, and we dispatch real
// MouseEvents + assert the emitted InputEvent stream. sendInputEvent is mocked so
// no LiveKit Room is needed.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const sendInputEvent = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent,
}));

const { useInputCapture } = await import('../../src/lib/livekit-input-capture');
import type { InputEvent, Room } from '../../src/lib/livekit';

/** A stub <video> sized 1:1 with its natural size so video-px == element-px
 *  (the 402×874 CSS-point profile case — no bar-boxing, no scaling). A click at
 *  (clientX,clientY) maps straight through to viewport (clientX,clientY). */
function stubVideo(el: HTMLVideoElement): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 402, height: 874, right: 402, bottom: 874, x: 0, y: 0 }) as DOMRect;
  Object.defineProperty(el, 'videoWidth', { value: 402, configurable: true });
  Object.defineProperty(el, 'videoHeight', { value: 874, configurable: true });
}

/** Render + wire the hook against a freshly-stubbed video, returning the element
 *  so the test can dispatch events on it. Done imperatively (not via a child
 *  component) so the hook sees the element on its first effect run. */
function mountCapture(): HTMLVideoElement {
  const video = document.createElement('video');
  document.body.appendChild(video);
  stubVideo(video);
  // Render a component that calls the hook with the already-mounted element.
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

function fireMouse(el: HTMLElement, type: string, clientX: number, clientY: number): void {
  el.dispatchEvent(
    new MouseEvent(type, { clientX, clientY, button: 0, bubbles: true, cancelable: true }),
  );
}

describe('useInputCapture — scroll-vs-tap MOVE_DEADZONE (14 video-px)', () => {
  beforeEach(() => {
    sendInputEvent.mockClear();
    document.body.innerHTML = '';
  });

  it('DRIFTY-CLICK: a press + a 10px drift + a release emits NO touchMove (this exact drift used to leak + scroll at the old 6px deadzone)', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400);
    // A 10px drift (>old 6, ≤new 14) between mousedown and mouseup — the real
    // trackpad click-drift A3 found was leaking a touchMove + scrolling at 6.
    fireMouse(video, 'mousemove', 206, 408); // dist = √(6²+8²) = 10 ≤ 14
    fireMouse(video, 'mouseup', 206, 408);
    const types = emittedTypes();
    expect(types).toContain('touchStart');
    expect(types).toContain('touchEnd');
    // The deadzone drops the move → the fork keeps it a tap (its first touchMove
    // past tapSlop is what would flip tap→scroll).
    expect(types).not.toContain('touchMove');
    expect(eventsOfType('touchMove')).toHaveLength(0);
  });

  it('REAL DRAG: a press + a >14px move streams touchMove (scrolls exactly as before)', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400);
    // A 20px drag (dist > 14) — a genuine scroll gesture.
    fireMouse(video, 'mousemove', 200, 420); // dist = 20 > 14
    fireMouse(video, 'mouseup', 200, 420);
    const types = emittedTypes();
    expect(types).toContain('touchStart');
    expect(types).toContain('touchMove');
    expect(types).toContain('touchEnd');
    expect(eventsOfType('touchMove').length).toBeGreaterThanOrEqual(1);
  });

  it('LATCH: once past the deadzone, a move back WITHIN the deadzone of the press point still streams (moved stays true)', () => {
    const video = mountCapture();
    fireMouse(video, 'mousedown', 200, 400);
    // First move crosses the deadzone (latches moved=true)…
    fireMouse(video, 'mousemove', 200, 420);
    // …then a follow-up only 6px from the START (≤14, would be suppressed on its
    // own) must STILL stream — a real drag emits every move once begun.
    fireMouse(video, 'mousemove', 200, 406); // dist from start = 6 ≤ 14
    fireMouse(video, 'mouseup', 200, 406);
    expect(eventsOfType('touchMove').length).toBeGreaterThanOrEqual(2);
  });

  it('PER-GESTURE RESET: a fresh press restarts the deadzone (a jiggle after a prior drag is still a tap)', () => {
    const video = mountCapture();
    // Gesture 1 — a real drag.
    fireMouse(video, 'mousedown', 200, 400);
    fireMouse(video, 'mousemove', 200, 430);
    fireMouse(video, 'mouseup', 200, 430);
    sendInputEvent.mockClear();
    // Gesture 2 — a jiggle: moved must reset to false on the new touchStart.
    fireMouse(video, 'mousedown', 100, 100);
    fireMouse(video, 'mousemove', 102, 101); // dist ≈ 2.2 ≤ 14
    fireMouse(video, 'mouseup', 102, 101);
    expect(emittedTypes()).not.toContain('touchMove');
  });
});
