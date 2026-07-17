// LK.6.d — a BARE Escape keypress must NOT be forwarded to the device. Escape is
// the SimulatorWindow drawer-collapse shortcut (a document-level keydown); the
// input-capture hook also binds window keydown/keyup and forwarded EVERY key,
// so the same Escape both collapsed the drawer AND dismissed a modal/menu on the
// live page — one keypress doing two things (audit). A bare Escape is now
// skipped; other keys (and a MODIFIED Escape) still forward.
//
// Exercises the REAL hook in jsdom: a harness wires useInputCapture to a stubbed
// <video> + an enabled room, and we dispatch real KeyboardEvents on window.
// sendInputEvent is mocked.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

const sendInputEvent = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent,
}));

const { useInputCapture } = await import('../../src/lib/livekit-input-capture');
import type { InputEvent, Room } from '../../src/lib/livekit';

const ROOM = {} as Room;
const AUTHORITY_EPOCH = 17;
const canSend = (room: Room, epoch: number): boolean => room === ROOM && epoch === AUTHORITY_EPOCH;

function mountCapture(): void {
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
}

function keyEventsFor(key: string): InputEvent[] {
  return sendInputEvent.mock.calls
    .map((c) => c[1] as InputEvent)
    .filter(
      (e) => (e.type === 'keyDown' || e.type === 'keyUp') && (e as { key: string }).key === key,
    );
}

describe('useInputCapture — bare Escape is not forwarded to the device', () => {
  beforeEach(() => {
    sendInputEvent.mockClear();
    // Focus is on the body (not a text field) so the editingLocally guard is off.
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does NOT forward a bare Escape keydown/keyup', () => {
    mountCapture();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Escape', bubbles: true }));
    expect(keyEventsFor('Escape')).toHaveLength(0);
  });

  it('STILL forwards a non-Escape key (e.g. Enter)', () => {
    mountCapture();
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    expect(keyEventsFor('Enter').length).toBeGreaterThan(0);
  });

  it('STILL forwards a MODIFIED Escape (only the bare drawer shortcut is skipped)', () => {
    mountCapture();
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', shiftKey: true, bubbles: true }),
    );
    expect(keyEventsFor('Escape').length).toBeGreaterThan(0);
  });
});
