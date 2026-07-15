// Fable GUI LiveKit re-audit — a key whose default action moves GUI focus INTO a
// text input (Tab / Shift+Tab into the address bar or the "Tell the agent"
// composer) used to forward its keyDown but DROP its keyUp, because onKeyUp
// re-evaluated editingLocally() at keyup time (now true) instead of mirroring the
// keyDown decision. That stranded a key — or, for Shift+Tab, a stuck Shift
// modifier corrupting every later forwarded key — on the remote device. The keyUp
// gate now forwards the up iff the down was forwarded, regardless of the current
// focus, while composer-only typing still never leaks.
//
// Exercises the REAL hook in jsdom (same harness as the escape test).

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';

const sendInputEvent = vi.fn(() => Promise.resolve());
vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent,
}));

const { useInputCapture } = await import('../../src/lib/livekit-input-capture');
import type { InputEvent, Room } from '../../src/lib/livekit';

function mountCapture(): ReturnType<typeof render> {
  const video = document.createElement('video');
  document.body.appendChild(video);
  video.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 402, height: 874, right: 402, bottom: 874, x: 0, y: 0 }) as DOMRect;
  Object.defineProperty(video, 'videoWidth', { value: 402, configurable: true });
  Object.defineProperty(video, 'videoHeight', { value: 874, configurable: true });
  function Wired(): JSX.Element {
    useInputCapture({ room: {} as Room, videoElement: video, enabled: true });
    return <span />;
  }
  return render(<Wired />);
}

function eventsFor(key: string, type: 'keyDown' | 'keyUp'): InputEvent[] {
  return sendInputEvent.mock.calls
    .map((c) => c[1] as InputEvent)
    .filter((e) => e.type === type && (e as { key: string }).key === key);
}

function keyEvents(): InputEvent[] {
  return sendInputEvent.mock.calls
    .map((c) => c[1] as InputEvent)
    .filter((e) => e.type === 'keyDown' || e.type === 'keyUp');
}

function makeEditableInput(): HTMLInputElement {
  const input = document.createElement('input');
  document.body.appendChild(input);
  return input;
}

describe('useInputCapture — keyUp mirrors the keyDown forward decision', () => {
  beforeEach(() => {
    sendInputEvent.mockClear();
    (document.activeElement as HTMLElement | null)?.blur?.();
  });
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('Tab that moves focus into an input still forwards BOTH keyDown and keyUp', () => {
    mountCapture();
    // Video focused (editing off): Tab keyDown is forwarded.
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', bubbles: true }));
    // Tab's default action moved focus into a text field → editingLocally() is now true.
    makeEditableInput().focus();
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', bubbles: true }));

    expect(eventsFor('Tab', 'keyDown')).toHaveLength(1);
    // The keyUp must NOT be dropped just because focus moved into an input.
    expect(eventsFor('Tab', 'keyUp')).toHaveLength(1);
  });

  it('Shift+Tab into an input releases BOTH Shift and Tab on the device', () => {
    mountCapture();
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Shift',
        code: 'ShiftLeft',
        shiftKey: true,
        bubbles: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Tab', code: 'Tab', shiftKey: true, bubbles: true }),
    );
    makeEditableInput().focus();
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Tab', code: 'Tab', shiftKey: true, bubbles: true }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keyup', { key: 'Shift', code: 'ShiftLeft', bubbles: true }),
    );

    expect(eventsFor('Tab', 'keyUp')).toHaveLength(1);
    expect(eventsFor('Shift', 'keyUp')).toHaveLength(1);
  });

  it('a key pressed WHILE editing (composer typing) still forwards neither half', () => {
    mountCapture();
    makeEditableInput().focus(); // editing on at keydown → not forwarded
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'x', code: 'KeyX', bubbles: true }));

    expect(eventsFor('x', 'keyDown')).toHaveLength(0);
    expect(eventsFor('x', 'keyUp')).toHaveLength(0);
  });

  it('releases the stored down-time wire key when Shift changes A to a before keyUp', () => {
    mountCapture();
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'A',
        code: 'KeyA',
        shiftKey: true,
        bubbles: true,
      }),
    );
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }));

    expect(keyEvents()).toEqual([
      { type: 'keyDown', key: 'A', modifiers: ['shift'] },
      { type: 'keyUp', key: 'A' },
    ]);
  });

  it('balance-releases a changed repeat value before forwarding its successor', () => {
    mountCapture();
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'A',
        code: 'KeyA',
        shiftKey: true,
        bubbles: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'a',
        code: 'KeyA',
        repeat: true,
        bubbles: true,
      }),
    );
    window.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', code: 'KeyA', bubbles: true }));

    expect(keyEvents()).toEqual([
      { type: 'keyDown', key: 'A', modifiers: ['shift'] },
      { type: 'keyUp', key: 'A' },
      { type: 'keyDown', key: 'a' },
      { type: 'keyUp', key: 'a' },
    ]);
  });

  it('teardown releases every stored key with a neutral modifier snapshot', () => {
    const mounted = mountCapture();
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Shift',
        code: 'ShiftLeft',
        shiftKey: true,
        bubbles: true,
      }),
    );
    window.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'A',
        code: 'KeyA',
        shiftKey: true,
        bubbles: true,
      }),
    );

    mounted.unmount();

    expect(keyEvents()).toEqual([
      { type: 'keyDown', key: 'Shift', modifiers: ['shift'] },
      { type: 'keyDown', key: 'A', modifiers: ['shift'] },
      { type: 'keyUp', key: 'Shift' },
      { type: 'keyUp', key: 'A' },
    ]);
  });
});
