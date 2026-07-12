// Reliable-channel BACKPRESSURE guard (founder 2026-07-08: "sometimes I do some fast
// scrolling / tapping, and then after it becomes unresponsive"). livekit's publishData
// does NOT drop on the reliable DataChannel — it BLOCKS (waitForBufferStatusLow) once the
// channel's bufferedAmount exceeds ~64KB. On a slow/lossy link (the founder's ~620ms-RTT
// proxy) the ORDERED reliable channel stalls under loss and every queued reliable msg —
// taps, scroll re-centre/reversal legs, navigate, activateTab — backs up head-of-line, so
// input goes dead and replays in a flurry when the link recovers.
//
// The fix watches RoomEvent.DCBufferStatusChanged (RELIABLE kind === 0) and, WHILE the
// reliable channel is congested, SHEDS new staleable input at its source while preserving
// mandatory releases for already-sent gestures/keys. These tests drive the
// REAL hook in jsdom with a Room stub whose `.on` captures the buffer-status handler, so
// we can toggle congestion and assert the wheel path is shed / resumes / stays untouched.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

const sendInputEvent = vi.fn(() => Promise.resolve());
// The hook reads RoomEvent.DCBufferStatusChanged; our Room stub's `.on` ignores the event
// name (it just captures the callback), so RoomEvent only needs to be DEFINED. Provide the
// real event string for faithfulness while stubbing the network send.
vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent,
  RoomEvent: { DCBufferStatusChanged: 'dcBufferStatusChanged' },
}));

const { useInputCapture } = await import('../../src/lib/livekit-input-capture');
import type { InputEvent, Room } from '../../src/lib/livekit';

function stubVideo(el: HTMLVideoElement): void {
  el.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 402, height: 874, right: 402, bottom: 874, x: 0, y: 0 }) as DOMRect;
  Object.defineProperty(el, 'videoWidth', { value: 402, configurable: true });
  Object.defineProperty(el, 'videoHeight', { value: 874, configurable: true });
}

/** A Room stub that captures the DCBufferStatusChanged handler so a test can flip the
 *  reliable buffer between "low" (drained) and "not low" (congested). Tracks on/off calls
 *  so we can assert the listener is registered once and cleaned up on unmount. */
function makeRoom(): {
  room: Room;
  fireDC: (isLow: boolean, kind: number) => void;
  state: { on: number; off: number; hasHandler: boolean };
} {
  let handler: ((isLow: boolean, kind: number) => void) | null = null;
  const state = {
    on: 0,
    off: 0,
    get hasHandler() {
      return handler !== null;
    },
  };
  const room = {
    on(_e: string, cb: (isLow: boolean, kind: number) => void): void {
      state.on += 1;
      handler = cb;
    },
    off(_e: string, _cb: unknown): void {
      state.off += 1;
      handler = null;
    },
  } as unknown as Room;
  return { room, state, fireDC: (isLow, kind) => handler?.(isLow, kind) };
}

function mount(
  room: Room,
  onCongestionChange?: (congested: boolean) => void,
): { video: HTMLVideoElement; unmount: () => void } {
  const video = document.createElement('video');
  document.body.appendChild(video);
  stubVideo(video);
  function Wired(): JSX.Element {
    useInputCapture({ room, videoElement: video, enabled: true, onCongestionChange });
    return <span />;
  }
  const { unmount } = render(<Wired />);
  return { video, unmount };
}

function fireWheel(el: HTMLElement, deltaY: number): void {
  el.dispatchEvent(new WheelEvent('wheel', { clientX: 200, clientY: 400, deltaY, bubbles: true }));
}
/** Feed a short realistic down-scroll (ramp) and let the idle timer close the gesture. */
function scroll(video: HTMLElement): void {
  for (let i = 0; i < 10; i++) {
    fireWheel(video, 10 + i * 6);
    vi.advanceTimersByTime(12);
  }
  vi.advanceTimersByTime(400); // > WHEEL_IDLE_MS (320) → gesture closes
}
function emitted(): InputEvent[] {
  return sendInputEvent.mock.calls.map((c) => c[1] as InputEvent);
}
function fireMouse(el: EventTarget, type: string, x: number, y: number, ts: number): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  Object.defineProperty(ev, 'timeStamp', { value: ts, configurable: true });
  el.dispatchEvent(ev);
}

describe('useInputCapture — reliable-channel backpressure shed', () => {
  beforeEach(() => {
    sendInputEvent.mockClear();
    document.body.innerHTML = '';
    vi.useFakeTimers(); // fakes rAF (~16ms) + setTimeout, like the real wheel cadence
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a DCBufferStatusChanged listener on the room', () => {
    const { room, state } = makeRoom();
    mount(room);
    expect(state.on).toBe(1);
    expect(state.hasHandler).toBe(true);
  });

  it('surfaces congestion transitions and clears the state during teardown', () => {
    const { room, fireDC } = makeRoom();
    const onCongestionChange = vi.fn();
    const { unmount } = mount(room, onCongestionChange);
    expect(onCongestionChange).toHaveBeenLastCalledWith(false);
    fireDC(false, 0);
    expect(onCongestionChange).toHaveBeenLastCalledWith(true);
    fireDC(true, 0);
    expect(onCongestionChange).toHaveBeenLastCalledWith(false);
    fireDC(false, 1);
    expect(onCongestionChange).toHaveBeenLastCalledWith(false);
    unmount();
    expect(onCongestionChange).toHaveBeenLastCalledWith(false);
  });

  it('baseline: with the channel healthy (no congestion event), a scroll emits touch events', () => {
    const { room } = makeRoom();
    const { video } = mount(room);
    scroll(video);
    const types = emitted().map((e) => e.type);
    expect(types).toContain('touchStart');
    expect(types.filter((t) => t === 'touchMove').length).toBeGreaterThan(0);
  });

  it('CRITICAL sheds the scroll flood while the reliable channel is congested', () => {
    const { room, fireDC } = makeRoom();
    const { video } = mount(room);
    fireDC(false, 0); // reliable (kind 0) buffer NO LONGER low → congested
    scroll(video);
    // onWheel returns early while congested: no accumulation, no rAF, no drag → nothing
    // is ever put on the wire, so the stalled channel can drain instead of growing.
    expect(emitted()).toHaveLength(0);
  });

  it('resumes scrolling once the reliable channel drains (buffer low again)', () => {
    const { room, fireDC } = makeRoom();
    const { video } = mount(room);
    fireDC(false, 0); // congested
    scroll(video);
    expect(emitted()).toHaveLength(0); // shed
    fireDC(true, 0); // drained → no longer congested
    scroll(video);
    const types = emitted().map((e) => e.type);
    expect(types).toContain('touchStart'); // scroll works again
    expect(types.filter((t) => t === 'touchMove').length).toBeGreaterThan(0);
  });

  it('ignores a NON-reliable (lossy, kind 1) buffer-status event — only reliable gates the shed', () => {
    const { room, fireDC } = makeRoom();
    const { video } = mount(room);
    fireDC(false, 1); // lossy channel congested — lossy self-drops, must NOT shed scroll
    scroll(video);
    expect(emitted().map((e) => e.type)).toContain('touchStart');
  });

  it('sheds a new tap while congested so it cannot replay against a later page', () => {
    const { room, fireDC } = makeRoom();
    const { video } = mount(room);
    fireDC(false, 0); // congested
    fireMouse(video, 'mousedown', 100, 200, 1000);
    fireMouse(window, 'pointerup', 100, 200, 1080); // quick press→release = a tap
    expect(emitted()).toHaveLength(0);
  });

  it('lifts an already-committed drag exactly once when congestion begins', () => {
    const { room, fireDC } = makeRoom();
    const { video } = mount(room);
    fireMouse(video, 'mousedown', 100, 200, 1000);
    fireMouse(window, 'mousemove', 100, 240, 1200); // hard-distance commit
    expect(emitted().map((e) => e.type)).toEqual(['touchStart', 'touchMove']);

    fireDC(false, 0);
    expect(emitted().map((e) => e.type)).toEqual(['touchStart', 'touchMove', 'touchEnd']);
    fireMouse(window, 'pointerup', 100, 240, 1250);
    expect(emitted().map((e) => e.type)).toEqual(['touchStart', 'touchMove', 'touchEnd']);
  });

  it('sheds new key intent while congested and resumes after drain', () => {
    const { room, fireDC } = makeRoom();
    mount(room);
    fireDC(false, 0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
    expect(emitted()).toHaveLength(0);

    fireDC(true, 0);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA' }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA' }));
    expect(emitted().map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('still sends keyUp for a key pressed before congestion so it cannot stick remotely', () => {
    const { room, fireDC } = makeRoom();
    mount(room);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft' }));
    expect(emitted().map((e) => e.type)).toEqual(['keyDown']);

    fireDC(false, 0);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }));
    expect(emitted().map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('unregisters the buffer-status listener on unmount', () => {
    const { room, state } = makeRoom();
    const { unmount } = mount(room);
    expect(state.on).toBe(1);
    unmount();
    expect(state.off).toBe(1);
    expect(state.hasHandler).toBe(false);
  });
});
