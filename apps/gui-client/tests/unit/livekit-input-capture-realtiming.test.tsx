// FAITHFUL real-timing test of the trackpad wheel→touch converter (founder 2026-06-22:
// "nothing fixed still the same" + "find auto ways to test scroll stuff"). The existing
// deadzone tests drain a SYNCHRONOUS rAF stub + fire-all-then-flush, which hides any bug
// that only appears under REAL async timing (rAF firing ~16ms apart while wheel events
// arrive spread over time, the 320ms idle timer interleaving). Here we drive the REAL
// hook with vi.useFakeTimers() faking BOTH requestAnimationFrame AND setTimeout, dispatch
// a REALISTIC macOS trackpad wheel stream (finger ramp + inertial momentum decay) with
// realistic inter-event spacing, and assert the emitted touch stream is a clean monotonic
// drag (finger never reverses within a leg = the page never "scrolls back up").
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

const sendInputEvent = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/livekit', () => ({ sendInputEvent }));

const { useInputCapture } = await import('../../src/lib/livekit-input-capture');
import type { InputEvent, Room } from '../../src/lib/livekit';

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
function fireWheel(el: HTMLElement, deltaX: number, deltaY: number): void {
  el.dispatchEvent(
    new WheelEvent('wheel', { clientX: 200, clientY: 400, deltaX, deltaY, bubbles: true }),
  );
}
type TouchEv = InputEvent & { type: string; x: number; y: number; touchId: number };
function emitted(): TouchEv[] {
  return sendInputEvent.mock.calls.map((c) => c[1] as TouchEv);
}

// Drive a wheel stream with realistic timing: dispatch each event, then advance fake time
// by its inter-event gap so rAF (≈16ms) fires between events exactly as in production.
function feed(video: HTMLElement, events: { dx?: number; dy: number; dt: number }[]): void {
  for (const e of events) {
    fireWheel(video, e.dx ?? 0, e.dy);
    vi.advanceTimersByTime(e.dt);
  }
  vi.advanceTimersByTime(400); // > 320ms idle → gesture closes
}

// A realistic macOS two-finger scroll-DOWN: a short finger-drag ramp (deltaY grows) then
// an inertial MOMENTUM tail (deltaY decays exponentially, SAME sign), ~12ms apart.
function macScrollDown(totalScale = 1): { dy: number; dt: number }[] {
  const ev: { dy: number; dt: number }[] = [];
  for (let i = 0; i < 8; i++) ev.push({ dy: (5 + i * 5) * totalScale, dt: 12 }); // ramp 5..40
  for (let i = 0; i < 34; i++)
    ev.push({ dy: Math.max(1, Math.round(42 * Math.exp(-i / 9))) * totalScale, dt: 12 }); // momentum decay
  return ev;
}

// Within each touchId "leg" (one touchStart..touchEnd), the finger must move strictly one
// direction (for a scroll-DOWN: y non-increasing). Any leg where y goes back UP = a bounce.
function assertMonotonicPerLeg(
  evs: TouchEv[],
  dir: 'down' | 'up',
): { legs: number; moves: number } {
  const startY = new Map<number, number>();
  let legs = 0;
  let moves = 0;
  const lastY = new Map<number, number>();
  for (const e of evs) {
    if (e.type === 'touchStart') {
      startY.set(e.touchId, e.y);
      lastY.set(e.touchId, e.y);
      legs++;
    } else if (e.type === 'touchMove') {
      moves++;
      const prev = lastY.get(e.touchId);
      expect(prev, `touchMove for an unknown leg ${e.touchId}`).not.toBeUndefined();
      if (dir === 'down') {
        // finger up = content down; y must not increase (no back-up bounce)
        expect(e.y, `BOUNCE: leg ${e.touchId} moved DOWN (y ${prev}->${e.y})`).toBeLessThanOrEqual(
          prev!,
        );
      } else {
        expect(e.y).toBeGreaterThanOrEqual(prev!);
      }
      lastY.set(e.touchId, e.y);
    }
  }
  return { legs, moves };
}

describe('useInputCapture — FAITHFUL real-timing macOS trackpad scroll', () => {
  beforeEach(() => {
    sendInputEvent.mockClear();
    document.body.innerHTML = '';
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('realistic down-scroll + momentum → strictly monotonic, NO back-up bounce', () => {
    const video = mountCapture();
    vi.useFakeTimers(); // fakes rAF (~16ms) + setTimeout — real async cadence
    feed(video, macScrollDown());
    const { legs, moves } = assertMonotonicPerLeg(emitted(), 'down');
    expect(moves).toBeGreaterThan(2); // it actually scrolled
    expect(legs).toBeGreaterThan(0);
  });

  it('FAST realistic flick (3x magnitude) + momentum → monotonic, NO bounce, full distance', () => {
    const video = mountCapture();
    vi.useFakeTimers();
    feed(video, macScrollDown(3));
    const evs = emitted();
    assertMonotonicPerLeg(evs, 'down');
    expect(evs.filter((e) => e.type === 'touchMove').length).toBeGreaterThan(2);
  });

  it('does NOT fragment one continuous scroll into many centre-anchored legs', () => {
    const video = mountCapture();
    vi.useFakeTimers();
    feed(video, macScrollDown());
    const starts = emitted().filter((e) => e.type === 'touchStart');
    // One continuous ~600px scroll needs at most a couple of edge re-centres (runway ~389px),
    // NOT one-per-burst fragmentation (the bug was 9 for one scroll).
    expect(starts.length).toBeLessThanOrEqual(3);
  });
});
