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
import { act, render } from '@testing-library/react';

const sendInputEvent = vi.fn((_room: Room, _event: InputEvent, _opts?: { reliable?: boolean }) =>
  Promise.resolve(),
);
// The hook reads RoomEvent.DCBufferStatusChanged; our Room stub's `.on` ignores the event
// name (it just captures the callback), so RoomEvent only needs to be DEFINED. Provide the
// real event string for faithfulness while stubbing the network send.
vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent,
  RoomEvent: {
    DCBufferStatusChanged: 'dcBufferStatusChanged',
    Reconnected: 'reconnected',
  },
}));

const { useInputCapture } = await import('../../src/lib/livekit-input-capture');
import type { InputEvent, Room } from '../../src/lib/livekit';

const AUTHORITY_EPOCH = 23;

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
  fireReconnected: () => void;
  state: { on: number; off: number; hasHandler: boolean };
} {
  // V-2168 — a LIST per event, not one slot: the hook now registers the
  // DataChannel-health listeners TWICE (a room-scoped latch-maintenance effect
  // plus the capture effect's local mirror), and a single-slot map silently
  // dropped the first — modelling a Room that real livekit is not.
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  const state = {
    on: 0,
    off: 0,
    get hasHandler() {
      return (handlers.get('dcBufferStatusChanged')?.length ?? 0) > 0;
    },
  };
  const room = {
    on(_e: string, cb: (isLow: boolean, kind: number) => void): void {
      state.on += 1;
      const list = handlers.get(_e) ?? [];
      list.push(cb as (...args: unknown[]) => void);
      handlers.set(_e, list);
    },
    off(_e: string, cb: unknown): void {
      state.off += 1;
      const list = handlers.get(_e) ?? [];
      const i = list.indexOf(cb as (...args: unknown[]) => void);
      if (i !== -1) list.splice(i, 1);
    },
  } as unknown as Room;
  const fire = (e: string, ...args: unknown[]): void => {
    for (const cb of [...(handlers.get(e) ?? [])]) cb(...args);
  };
  return {
    room,
    state,
    fireDC: (isLow, kind) => fire('dcBufferStatusChanged', isLow, kind),
    fireReconnected: () => fire('reconnected'),
  };
}

function mount(
  room: Room,
  onCongestionChange?: (congested: boolean, room: Room) => void,
): { video: HTMLVideoElement; unmount: () => void } {
  const video = document.createElement('video');
  document.body.appendChild(video);
  stubVideo(video);
  function Wired(): JSX.Element {
    useInputCapture({
      room,
      videoElement: video,
      enabled: true,
      authorityEpoch: AUTHORITY_EPOCH,
      canSend: (ownerRoom, epoch) => ownerRoom === room && epoch === AUTHORITY_EPOCH,
      onCongestionChange,
    });
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
  return sendInputEvent.mock.calls.map((c) => c[1]);
}
function fireMouse(el: EventTarget, type: string, x: number, y: number, ts: number): void {
  const ev = new MouseEvent(type, { clientX: x, clientY: y, button: 0, bubbles: true });
  Object.defineProperty(ev, 'timeStamp', { value: ts, configurable: true });
  el.dispatchEvent(ev);
}

describe('useInputCapture — reliable-channel backpressure shed', () => {
  beforeEach(() => {
    sendInputEvent.mockReset();
    sendInputEvent.mockResolvedValue(undefined);
    document.body.innerHTML = '';
    vi.useFakeTimers(); // fakes rAF (~16ms) + setTimeout, like the real wheel cadence
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('registers a DCBufferStatusChanged listener on the room', () => {
    const { room, state } = makeRoom();
    mount(room);
    // V-2168 — four registrations: DC + Reconnected from the room-scoped latch
    // effect, and the same pair from the capture effect's local mirror.
    expect(state.on).toBe(4);
    expect(state.hasHandler).toBe(true);
  });

  it('surfaces congestion transitions and clears the state during teardown', () => {
    const { room, fireDC } = makeRoom();
    const onCongestionChange = vi.fn();
    const { unmount } = mount(room, onCongestionChange);
    expect(onCongestionChange).toHaveBeenLastCalledWith(false, room);
    fireDC(false, 0);
    expect(onCongestionChange).toHaveBeenLastCalledWith(true, room);
    fireDC(true, 0);
    expect(onCongestionChange).toHaveBeenLastCalledWith(false, room);
    fireDC(false, 1);
    expect(onCongestionChange).toHaveBeenLastCalledWith(false, room);
    unmount();
    expect(onCongestionChange).toHaveBeenLastCalledWith(false, room);
  });

  it('drops late publish failure callbacks once retired Room A loses exact authority', async () => {
    const { room: roomA } = makeRoom();
    const { room: roomB } = makeRoom();
    const video = document.createElement('video');
    document.body.appendChild(video);
    stubVideo(video);
    let rejectA!: (reason: Error) => void;
    sendInputEvent.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectA = reject;
        }),
    );
    const onPublishError = vi.fn();
    const onCongestionChange = vi.fn();
    let currentRoom = roomA;
    const canSend = (ownerRoom: Room, epoch: number): boolean =>
      ownerRoom === currentRoom && epoch === AUTHORITY_EPOCH;
    function Wired({ room }: { room: Room }): JSX.Element {
      useInputCapture({
        room,
        videoElement: video,
        enabled: true,
        authorityEpoch: AUTHORITY_EPOCH,
        canSend,
        onPublishError,
        onCongestionChange,
      });
      return <span />;
    }
    const mounted = render(<Wired room={roomA} />);
    fireMouse(video, 'mousedown', 100, 100, 0);
    fireMouse(window, 'mouseup', 100, 100, 10);
    expect(sendInputEvent).toHaveBeenCalled();

    currentRoom = roomB;
    mounted.rerender(<Wired room={roomB} />);
    expect(onCongestionChange).toHaveBeenLastCalledWith(false, roomB);
    await act(async () => {
      rejectA(new Error('old room reply lost'));
      await Promise.resolve();
    });
    expect(onPublishError).not.toHaveBeenCalled();
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

  it('clears stale congestion when LiveKit reconnects with a fresh data channel', () => {
    const { room, fireDC, fireReconnected } = makeRoom();
    const onCongestionChange = vi.fn();
    const { video } = mount(room, onCongestionChange);
    fireDC(false, 0);
    expect(onCongestionChange).toHaveBeenLastCalledWith(true, room);

    fireReconnected();
    expect(onCongestionChange).toHaveBeenLastCalledWith(false, room);
    scroll(video);
    expect(emitted().map((e) => e.type)).toContain('touchStart');
  });

  it('preserves room congestion across a same-room logical-dimension reattach', () => {
    const { room, fireDC } = makeRoom();
    const video = document.createElement('video');
    document.body.appendChild(video);
    stubVideo(video);
    const onCongestionChange = vi.fn();
    function Wired({ width }: { width: number }): JSX.Element {
      useInputCapture({
        room,
        videoElement: video,
        enabled: true,
        authorityEpoch: AUTHORITY_EPOCH,
        canSend: (ownerRoom, epoch) => ownerRoom === room && epoch === AUTHORITY_EPOCH,
        logical: { width, height: 874 },
        onCongestionChange,
      });
      return <span />;
    }
    const mounted = render(<Wired width={402} />);
    fireDC(false, 0);
    expect(onCongestionChange).toHaveBeenLastCalledWith(true, room);

    const callsBeforeReattach = onCongestionChange.mock.calls.length;
    mounted.rerender(<Wired width={390} />);
    expect(onCongestionChange).toHaveBeenLastCalledWith(true, room);
    const reattachCalls = onCongestionChange.mock.calls.slice(callsBeforeReattach);
    expect(reattachCalls).not.toContainEqual([false, room]);
    scroll(video);
    expect(emitted()).toHaveLength(0);
  });

  it('⛔ V-2168: a reconnect WHILE capture is torn down still clears the latch — input must come back', () => {
    // The owner's exact failure: "if I press Reconnect it reconnects, but not
    // listening to any of my inputs anymore." Authority is suspended for the
    // whole reconnect (connState !== 'connected'), which tears the capture
    // effect down — and BOTH of the latch's clearing paths used to live inside
    // it. RoomEvent.Reconnected then fired with nobody listening, the fresh
    // DataChannel started low (no crossing event would ever come), and every
    // input shed at the source forever. The room-scoped latch effect must
    // survive the teardown and catch that Reconnected.
    const { room, fireDC, fireReconnected } = makeRoom();
    const video = document.createElement('video');
    document.body.appendChild(video);
    stubVideo(video);
    function Wired({ enabled }: { enabled: boolean }): JSX.Element {
      useInputCapture({
        room,
        videoElement: video,
        enabled,
        authorityEpoch: AUTHORITY_EPOCH,
        canSend: (ownerRoom, epoch) => ownerRoom === room && epoch === AUTHORITY_EPOCH,
      });
      return <span />;
    }
    const mounted = render(<Wired enabled />);
    fireDC(false, 0); // congested
    // The reconnect window: capture torn down, THEN the room reconnects.
    mounted.rerender(<Wired enabled={false} />);
    fireReconnected();
    // Capture returns (authority restored). The fresh channel never crosses a
    // threshold, so if the latch survived the window, this scroll sheds forever.
    mounted.rerender(<Wired enabled />);
    scroll(video);
    expect(emitted().length).toBeGreaterThan(0);
  });

  it('preserves same-Room congestion across capture off/on until buffer-low or reconnect', () => {
    const { room, fireDC, fireReconnected } = makeRoom();
    const video = document.createElement('video');
    document.body.appendChild(video);
    stubVideo(video);
    const onCongestionChange = vi.fn();
    function Wired({ enabled }: { enabled: boolean }): JSX.Element {
      useInputCapture({
        room,
        videoElement: video,
        enabled,
        authorityEpoch: AUTHORITY_EPOCH,
        canSend: (ownerRoom, epoch) => ownerRoom === room && epoch === AUTHORITY_EPOCH,
        onCongestionChange,
      });
      return <span />;
    }
    const mounted = render(<Wired enabled />);
    fireDC(false, 0);
    expect(onCongestionChange).toHaveBeenLastCalledWith(true, room);

    mounted.rerender(<Wired enabled={false} />);
    expect(onCongestionChange).toHaveBeenLastCalledWith(true, room);
    mounted.rerender(<Wired enabled />);
    scroll(video);
    expect(emitted()).toHaveLength(0);

    fireDC(true, 0);
    scroll(video);
    expect(emitted().map((e) => e.type)).toContain('touchStart');

    sendInputEvent.mockClear();
    fireDC(false, 0);
    mounted.rerender(<Wired enabled={false} />);
    mounted.rerender(<Wired enabled />);
    fireReconnected();
    scroll(video);
    expect(emitted().map((e) => e.type)).toContain('touchStart');
  });

  it('fails closed when capture authority is omitted or denied', () => {
    const { room } = makeRoom();
    const video = document.createElement('video');
    document.body.appendChild(video);
    stubVideo(video);
    function Wired({ denied }: { denied: boolean }): JSX.Element {
      useInputCapture({
        room,
        videoElement: video,
        enabled: true,
        authorityEpoch: AUTHORITY_EPOCH,
        ...(denied ? { canSend: () => false } : {}),
      });
      return <span />;
    }
    const mounted = render(<Wired denied={false} />);
    scroll(video);
    expect(emitted()).toHaveLength(0);

    mounted.rerender(<Wired denied />);
    scroll(video);
    expect(emitted()).toHaveLength(0);
  });

  it('drops rAF and release callbacks when their captured authority epoch becomes stale', () => {
    const { room } = makeRoom();
    const video = document.createElement('video');
    document.body.appendChild(video);
    stubVideo(video);
    let currentEpoch = AUTHORITY_EPOCH;
    const canSend = (ownerRoom: Room, epoch: number): boolean =>
      ownerRoom === room && epoch === currentEpoch;
    function Wired(): JSX.Element {
      useInputCapture({
        room,
        videoElement: video,
        enabled: true,
        authorityEpoch: AUTHORITY_EPOCH,
        canSend,
      });
      return <span />;
    }
    render(<Wired />);

    fireWheel(video, 90);
    fireMouse(video, 'mousedown', 100, 100, 0);
    currentEpoch += 1;
    fireMouse(window, 'mouseup', 100, 100, 10);
    vi.advanceTimersByTime(500);
    expect(emitted()).toHaveLength(0);
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
    // Cleanup emits a final reliable coordinate anchor immediately before the
    // mandatory release. In production sendInputEvent may shed that anchor after
    // the congestion latch flips, but the touchEnd remains mandatory either way.
    expect(emitted().map((e) => e.type)).toEqual([
      'touchStart',
      'touchMove',
      'touchMove',
      'touchEnd',
    ]);
    fireMouse(window, 'pointerup', 100, 240, 1250);
    expect(emitted().map((e) => e.type)).toEqual([
      'touchStart',
      'touchMove',
      'touchMove',
      'touchEnd',
    ]);
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

  it('synthesizes keyUp immediately for a key pressed before congestion, exactly once', () => {
    const { room, fireDC } = makeRoom();
    mount(room);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft' }));
    expect(emitted().map((e) => e.type)).toEqual(['keyDown']);

    fireDC(false, 0);
    expect(emitted().map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft' }));
    expect(emitted().map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('releases a held remote key during teardown', () => {
    const { room } = makeRoom();
    const { unmount } = mount(room);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', code: 'ShiftLeft' }));
    expect(emitted().map((e) => e.type)).toEqual(['keyDown']);
    unmount();
    expect(emitted().map((e) => e.type)).toEqual(['keyDown', 'keyUp']);
  });

  it('unregisters the buffer-status listener on unmount', () => {
    const { room, state } = makeRoom();
    const { unmount } = mount(room);
    // V-2168 — two effects × (DC + Reconnected); both must unwind fully.
    expect(state.on).toBe(4);
    unmount();
    expect(state.off).toBe(4);
    expect(state.hasHandler).toBe(false);
  });
});
