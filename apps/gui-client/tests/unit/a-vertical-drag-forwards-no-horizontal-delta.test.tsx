// T-4 — the owner: "Browser in the simulator sometimes moves left and right like
// shaking, which is not like a real iPhone where you usually only scroll up and
// down."
//
// MEASURED in src/lib/livekit-input-capture.ts before the fix: the two scroll paths
// were not symmetric. The wheel/trackpad path locks ONE dominant axis once the
// cumulative intent clears an 8 px deadband (tryLockWheelDir) and drops the off-axis
// delta; the click-drag path (onMouseMove) streamed
//   send({ type: 'touchMove', x: p.x, y: devY(p.y), touchId })
// with BOTH raw coordinates, so a slightly diagonal drag forwarded every horizontal
// wobble and a page with no horizontal extent rubber-banded sideways in the fork —
// the shake. The frame clamps only ever touched the release/off-surface points.
//
// The fix routes every committed drag sample (and the in-bounds release, the last
// sample of the same stream) through projectDrag: the gesture locks to its dominant
// axis via the SAME lockDominantAxis the wheel path uses, pins the off-axis
// coordinate to the press point, lets the on-axis coordinate flow raw, and re-locks
// only on a sustained (> DIR_REVERSAL_PX = 96) off-axis excursion — the wheel path's
// reversal band — with a continuous wire point.
//
// Exercises the REAL hook in jsdom (the deadzone harness: a stubbed 1:1 <video>, real
// MouseEvents with controlled timeStamps, sendInputEvent mocked). Arms:
//   1. a 200 px vertical drag with ±3 px horizontal jitter on every move → EVERY
//      touchMove.x is the press x (the first committed move included), y advances
//      the full distance, and the release lifts at the press x.
//   2. VACUITY CONTROL: a 200 px horizontal drag → touchMove.x advances (the lock
//      chose horizontal — a carousel still works), y pinned. A dominant-axis lock,
//      not a horizontal disable.
//   3. the shared lock refuses to decide inside the 8 px deadband (the raw path stays
//      in force) and decides the dominant axis once it is cleared. At the drag level
//      no committed move can sit inside that deadband — the commit threshold
//      (MOVE_DEADZONE = 14) is above it — so the property is pinned on the helper the
//      drag path calls, not on a drag that could only pass vacuously.
//   4. a sustained off-axis excursion (> 96 px) re-locks the drag to that axis with a
//      continuous wire point on the SAME finger (no end + restart); VACUITY CONTROL:
//      a sub-band excursion holds the pin through release.

import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const sendInputEvent = vi.fn((_room: Room, _event: InputEvent, _opts?: { reliable?: boolean }) =>
  Promise.resolve(),
);
vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent,
}));

const { useInputCapture, lockDominantAxis } = await import('../../src/lib/livekit-input-capture');
import type { InputEvent, Room } from '../../src/lib/livekit';

const ROOM = {} as Room;
const AUTHORITY_EPOCH = 17;
const canSend = (room: Room, epoch: number): boolean => room === ROOM && epoch === AUTHORITY_EPOCH;

type TouchEv = Extract<InputEvent, { type: 'touchStart' | 'touchMove' | 'touchEnd' }>;

/** A stub <video> sized 1:1 so video-px == element-px (402×874, no bar-boxing). */
function mountCapture(): HTMLVideoElement {
  const video = document.createElement('video');
  document.body.appendChild(video);
  video.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 402, height: 874, right: 402, bottom: 874, x: 0, y: 0 }) as DOMRect;
  Object.defineProperty(video, 'videoWidth', { value: 402, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 874, configurable: true });
  function Wired(): JSX.Element {
    useInputCapture({
      room: ROOM,
      videoElement: video,
      enabled: true,
      authorityEpoch: AUTHORITY_EPOCH,
      canSend,
    });
    return <span />;
  }
  render(<Wired />);
  return video;
}

function wire(): TouchEv[] {
  return sendInputEvent.mock.calls
    .map((c) => c[1])
    .filter(
      (e): e is TouchEv =>
        e.type === 'touchStart' || e.type === 'touchMove' || e.type === 'touchEnd',
    );
}
function ofType(type: TouchEv['type']): TouchEv[] {
  return wire().filter((e) => e.type === type);
}

/** Dispatch a MouseEvent with a CONTROLLED timeStamp (the scroll-vs-tap gate is
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

const PRESS_T = 1000;
/** Press at `press`, then stream `points` as moves 20 ms apart starting 200 ms after
 *  the press — the first move is > MOVE_DEADZONE (14) and held > DRAG_HOLD_MS (140),
 *  so the gesture commits to a drag on it. Returns the timestamp after the last move. */
function drag(video: HTMLVideoElement, press: [number, number], points: [number, number][]) {
  fireMouse(video, 'mousedown', press[0], press[1], PRESS_T);
  let t = PRESS_T + 200;
  for (const [x, y] of points) {
    fireMouse(video, 'mousemove', x, y, t);
    t += 20;
  }
  return t;
}

describe('click-drag dominant-axis lock (T-4: a vertical drag forwards no horizontal delta)', () => {
  beforeEach(() => {
    sendInputEvent.mockClear();
    document.body.innerHTML = '';
  });

  it('ARM 1: a vertical drag with ±3 px horizontal jitter → every touchMove.x is the press x, y advances the full 200 px, the release lifts at the press x', () => {
    const video = mountCapture();
    const points: [number, number][] = [];
    for (let i = 1; i <= 10; i++) points.push([i % 2 === 0 ? 197 : 203, 100 + 20 * i]);
    const t = drag(video, [200, 100], points);
    fireMouse(video, 'mouseup', 203, 300, t + 200);

    expect(ofType('touchStart')).toEqual([expect.objectContaining({ x: 200, y: 100 })]);
    const moves = ofType('touchMove');
    // 10 streamed moves + the reliable final anchor put before the touchEnd.
    expect(moves).toHaveLength(11);
    // The property under test: NOT ONE forwarded move carries the jitter — the first
    // committed move included (the lock resolves on the commit sample).
    expect(moves.map((m) => m.x)).toEqual(Array<number>(11).fill(200));
    const ys = moves.slice(0, 10).map((m) => m.y);
    for (let i = 1; i < ys.length; i++) expect(ys[i]).toBeGreaterThan(ys[i - 1]);
    expect(ys.at(-1)).toBe(300);
    // The release is the last sample of the same stream: raw 203 must not leak here.
    expect(ofType('touchEnd')).toEqual([expect.objectContaining({ x: 200, y: 300 })]);
  });

  it('ARM 2 (VACUITY CONTROL): a horizontal drag still scrolls horizontally — touchMove.x advances (the lock chose horizontal), y pinned to the press y', () => {
    const video = mountCapture();
    const points: [number, number][] = [];
    for (let i = 1; i <= 10; i++) points.push([100 + 20 * i, i % 2 === 0 ? 397 : 403]);
    const t = drag(video, [100, 400], points);
    fireMouse(video, 'mouseup', 300, 403, t + 200);

    const moves = ofType('touchMove');
    expect(moves).toHaveLength(11);
    const xs = moves.slice(0, 10).map((m) => m.x);
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBeGreaterThan(xs[i - 1]);
    expect(xs.at(-1)).toBe(300);
    expect(moves.map((m) => m.y)).toEqual(Array<number>(11).fill(400));
    expect(ofType('touchEnd')).toEqual([expect.objectContaining({ x: 300, y: 400 })]);
  });

  it('ARM 4: a sustained off-axis excursion (> 96 px) re-locks the drag to that axis — continuous wire point, one finger, no end + restart', () => {
    const video = mountCapture();
    const t = drag(
      video,
      [100, 100],
      [
        [100, 120], // commits + locks vertical
        [100, 200],
        [100, 300],
        [140, 300], // 40 px sideways: inside the band → HOLD (x stays pinned)
        [180, 300], // 80 px: still HOLD
        [200, 300], // 100 px > 96 → re-lock horizontal; x continues from its pinned value
        [240, 300],
        [280, 300],
      ],
    );
    const moves = ofType('touchMove');
    expect(moves.map((m) => m.x)).toEqual([100, 100, 100, 100, 100, 100, 140, 180]);
    expect(moves.map((m) => m.y)).toEqual([120, 200, 300, 300, 300, 300, 300, 300]);
    expect(ofType('touchStart')).toHaveLength(1);
    expect(ofType('touchEnd')).toHaveLength(0);
    fireMouse(video, 'mouseup', 280, 300, t + 200);
    expect(ofType('touchEnd')).toEqual([expect.objectContaining({ x: 180, y: 300 })]);
  });

  it('ARM 4 (VACUITY CONTROL): a sub-band off-axis excursion (80 px) holds the pin through release', () => {
    const video = mountCapture();
    const t = drag(
      video,
      [100, 100],
      [
        [100, 120],
        [100, 200],
        [100, 300],
        [140, 300],
        [180, 300],
      ],
    );
    fireMouse(video, 'mouseup', 180, 300, t + 200);
    // 5 streamed moves + the final anchor + the touchEnd: all at the press x.
    const afterStart = wire().filter((e) => e.type !== 'touchStart');
    expect(afterStart).toHaveLength(7);
    expect(afterStart.map((e) => e.x)).toEqual(Array<number>(7).fill(100));
  });
});

describe('lockDominantAxis — the lock both scroll paths share', () => {
  it('ARM 3: refuses to decide inside the 8 px deadband, so the raw path stays in force', () => {
    expect(lockDominantAxis(5, 5)).toBeNull(); // hypot 7.07 < 8
    expect(lockDominantAxis(0, -7)).toBeNull();
  });

  it('ARM 3 (control): decides the dominant axis with its sign once the deadband is cleared', () => {
    expect(lockDominantAxis(3, -8)).toEqual({ dirX: 0, dirY: -1 });
    expect(lockDominantAxis(-9, 2)).toEqual({ dirX: -1, dirY: 0 });
  });
});
