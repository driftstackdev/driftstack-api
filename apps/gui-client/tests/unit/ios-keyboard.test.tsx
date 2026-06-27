// On-screen iOS keyboard (founder 2026-06-25 "behave exactly like a real
// iPhone"). Pins the three-layer render + the GUI-local shift behaviour + that
// every key produces the SAME keyDown/keyUp InputEvents the host-keyboard path
// emits. Mocks the livekit wrapper so we capture the emitted events without a
// real Room / data channel.

import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import {
  IOSKeyboard,
  applyShift,
  keyForChar,
  DOUBLE_TAP_MS,
} from '../../src/components/IOSKeyboard';
import { DeviceToolbar } from '../../src/views/SimulatorWindow';
import type { InputEvent } from '../../src/lib/livekit';

const sendInputEventMock = vi.fn();

vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent: (...args: unknown[]) => sendInputEventMock(...args) as unknown,
}));

// A non-null sentinel Room — the component only forwards it to sendInputEvent
// (which is mocked), so its shape is irrelevant.
const ROOM = {} as never;

/** The InputEvent objects passed as the 2nd arg of each sendInputEvent call. */
function emitted(): InputEvent[] {
  return sendInputEventMock.mock.calls.map((c) => c[1] as InputEvent);
}

/** A required-element querySelector (throws if missing) so the act() callbacks
 *  stay non-returning (lint: act with a returning arrow is a floating promise). */
function el(container: HTMLElement, selector: string): Element {
  const found = container.querySelector(selector);
  if (found === null) throw new Error(`not found: ${selector}`);
  return found;
}

/** Press (pointerdown = the iOS press) + release a key by its data-key glyph. */
function pressKey(container: HTMLElement, glyph: string): void {
  const btn = el(container, `[data-key="${CSS.escape(glyph)}"]`);
  act(() => {
    fireEvent.pointerDown(btn);
    fireEvent.pointerUp(btn);
  });
}

/** pointerdown-only press (layer switches / shift / function keys). */
function tap(container: HTMLElement, glyph: string): void {
  const btn = el(container, `[data-key="${CSS.escape(glyph)}"]`);
  act(() => {
    fireEvent.pointerDown(btn);
  });
}

beforeEach(() => {
  sendInputEventMock.mockReset();
});

describe('IOSKeyboard — pure helpers', () => {
  it('applyShift uppercases only when shift is on', () => {
    expect(applyShift('a', 'off')).toBe('a');
    expect(applyShift('a', 'once')).toBe('A');
    expect(applyShift('a', 'locked')).toBe('A');
  });
  it('keyForChar mirrors applyShift (the cased key the wire receives)', () => {
    expect(keyForChar('q', 'off')).toBe('q');
    expect(keyForChar('q', 'once')).toBe('Q');
  });
});

describe('IOSKeyboard — layers', () => {
  it('renders the LETTERS layer (qwerty) by default', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    expect(container.querySelector('[data-component="ios-keyboard"]')).toHaveAttribute(
      'data-layer',
      'letters',
    );
    for (const ch of ['q', 'w', 'e', 'a', 's', 'd', 'z', 'x', 'c']) {
      expect(container.querySelector(`[data-key="${ch}"]`)).not.toBeNull();
    }
    // Function keys present on the letters layer.
    expect(container.querySelector('[data-key="⇧"]')).not.toBeNull();
    expect(container.querySelector('[data-key="⌫"]')).not.toBeNull();
    expect(container.querySelector('[data-key="123"]')).not.toBeNull();
    expect(container.querySelector('[data-key="space"]')).not.toBeNull();
    expect(container.querySelector('[data-key="return"]')).not.toBeNull();
  });

  it('123 switches to the NUMBERS layer and #+= to SYMBOLS; ABC returns to letters', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const kb = (): Element => el(container, '[data-component="ios-keyboard"]');

    tap(container, '123');
    expect(kb()).toHaveAttribute('data-layer', 'numbers');
    // Number-layer characters render.
    for (const ch of ['1', '0', '-', '@', '"']) {
      expect(container.querySelector(`[data-key="${CSS.escape(ch)}"]`)).not.toBeNull();
    }
    // Numbers layer offers #+= (→ symbols) + ABC (→ letters).
    expect(container.querySelector('[data-key="#+="]')).not.toBeNull();
    expect(container.querySelector('[data-key="ABC"]')).not.toBeNull();

    tap(container, '#+=');
    expect(kb()).toHaveAttribute('data-layer', 'symbols');
    for (const ch of ['[', ']', '{', '€', '£', '•']) {
      expect(container.querySelector(`[data-key="${CSS.escape(ch)}"]`)).not.toBeNull();
    }

    tap(container, 'ABC');
    expect(kb()).toHaveAttribute('data-layer', 'letters');
  });
});

describe('IOSKeyboard — character keys send keyDown/keyUp', () => {
  it("tapping 'a' sends keyDown then keyUp with key:'a'", () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    pressKey(container, 'a');
    expect(emitted()).toEqual([
      { type: 'keyDown', key: 'a' },
      { type: 'keyUp', key: 'a' },
    ]);
  });

  it('a number key on the 123 layer sends its digit', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    tap(container, '123');
    sendInputEventMock.mockReset();
    pressKey(container, '7');
    expect(emitted()).toEqual([
      { type: 'keyDown', key: '7' },
      { type: 'keyUp', key: '7' },
    ]);
  });

  it('is a no-op when room is null (mirrors the host path)', () => {
    const { container } = render(<IOSKeyboard room={null} />);
    pressKey(container, 'a');
    expect(sendInputEventMock).not.toHaveBeenCalled();
  });
});

describe('IOSKeyboard — shift', () => {
  it("shift (one-shot) then 'a' sends key:'A', and the NEXT letter reverts to lowercase", () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    tap(container, '⇧');
    expect(container.querySelector('[data-component="ios-keyboard"]')).toHaveAttribute(
      'data-shift',
      'once',
    );
    // After one-shot shift the key glyph is uppercase.
    pressKey(container, 'A');
    expect(emitted()).toEqual([
      { type: 'keyDown', key: 'A' },
      { type: 'keyUp', key: 'A' },
    ]);
    // One-shot consumed → back to off → next letter is lowercase.
    expect(container.querySelector('[data-component="ios-keyboard"]')).toHaveAttribute(
      'data-shift',
      'off',
    );
    sendInputEventMock.mockReset();
    pressKey(container, 'b');
    expect(emitted()).toEqual([
      { type: 'keyDown', key: 'b' },
      { type: 'keyUp', key: 'b' },
    ]);
  });

  it('double-tap shift engages CAPS-LOCK, which persists across letters until tapped again', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const { container } = render(<IOSKeyboard room={ROOM} />);
      const kb = (): Element => el(container, '[data-component="ios-keyboard"]');

      now.mockReturnValue(1000);
      tap(container, '⇧');
      // Second tap inside the double-tap window → caps-lock.
      now.mockReturnValue(1000 + DOUBLE_TAP_MS - 1);
      tap(container, '⇧');
      expect(kb()).toHaveAttribute('data-shift', 'locked');

      // Two letters in a row both uppercase (lock persists).
      pressKey(container, 'A');
      pressKey(container, 'B');
      expect(emitted()).toEqual([
        { type: 'keyDown', key: 'A' },
        { type: 'keyUp', key: 'A' },
        { type: 'keyDown', key: 'B' },
        { type: 'keyUp', key: 'B' },
      ]);
      expect(kb()).toHaveAttribute('data-shift', 'locked');

      // Tapping shift again releases caps-lock.
      now.mockReturnValue(5000);
      tap(container, '⇧');
      expect(kb()).toHaveAttribute('data-shift', 'off');
    } finally {
      now.mockRestore();
    }
  });

  it('two slow taps (outside the window) do NOT caps-lock — they toggle one-shot off', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const { container } = render(<IOSKeyboard room={ROOM} />);
      const kb = (): Element => el(container, '[data-component="ios-keyboard"]');
      now.mockReturnValue(1000);
      tap(container, '⇧'); // → once
      expect(kb()).toHaveAttribute('data-shift', 'once');
      now.mockReturnValue(1000 + DOUBLE_TAP_MS + 50); // outside the window
      tap(container, '⇧'); // once → off
      expect(kb()).toHaveAttribute('data-shift', 'off');
    } finally {
      now.mockRestore();
    }
  });
});

describe('IOSKeyboard — named keys', () => {
  it("return → Enter, delete → Backspace, space → ' '", () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);

    tap(container, 'return');
    expect(emitted()).toEqual([
      { type: 'keyDown', key: 'Enter' },
      { type: 'keyUp', key: 'Enter' },
    ]);

    sendInputEventMock.mockReset();
    tap(container, '⌫');
    expect(emitted()).toEqual([
      { type: 'keyDown', key: 'Backspace' },
      { type: 'keyUp', key: 'Backspace' },
    ]);

    sendInputEventMock.mockReset();
    tap(container, 'space');
    expect(emitted()).toEqual([
      { type: 'keyDown', key: ' ' },
      { type: 'keyUp', key: ' ' },
    ]);
  });
});

describe('IOSKeyboard — key pop-up magnifier', () => {
  it('shows the iOS pop-up over a pressed character key, dismissed on release', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const aKey = el(container, '[data-key="a"]');
    act(() => {
      fireEvent.pointerDown(aKey);
    });
    expect(container.querySelector('[data-component="key-popup"]')).not.toBeNull();
    act(() => {
      fireEvent.pointerUp(aKey);
    });
    expect(container.querySelector('[data-component="key-popup"]')).toBeNull();
  });

  it('does NOT show a pop-up for a function key (delete)', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    tap(container, '⌫');
    expect(container.querySelector('[data-component="key-popup"]')).toBeNull();
  });
});

describe('IOSKeyboard — dismiss affordance', () => {
  it('renders a hide key only when onDismiss is provided, and calls it on press', () => {
    const onDismiss = vi.fn();
    const { container, rerender } = render(<IOSKeyboard room={ROOM} />);
    expect(container.querySelector('[data-key="⌄"]')).toBeNull();
    rerender(<IOSKeyboard room={ROOM} onDismiss={onDismiss} />);
    tap(container, '⌄');
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});

describe('DeviceToolbar — keyboard show/hide toggle', () => {
  // A tiny stateful harness mirroring SimulatorWindow's toggle wiring (the
  // keyboard mounts/unmounts on this flag).
  function Harness(): JSX.Element {
    const [visible, setVisible] = useState(false);
    return (
      <div>
        <DeviceToolbar
          deviceName="iPhone 17"
          profileName="amsterdam"
          recording={false}
          onToggleRecord={() => {}}
          running
          keyboardVisible={visible}
          onToggleKeyboard={() => setVisible((v) => !v)}
        />
        {visible && <IOSKeyboard room={ROOM} />}
      </div>
    );
  }

  it('toggles the keyboard mount + reflects the pressed state', () => {
    const { container } = render(<Harness />);
    const toggle = el(container, '[data-component="simulator-keyboard-toggle"]');
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('[data-component="ios-keyboard"]')).toBeNull();

    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'true');
    expect(container.querySelector('[data-component="ios-keyboard"]')).not.toBeNull();

    act(() => {
      fireEvent.click(toggle);
    });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    expect(container.querySelector('[data-component="ios-keyboard"]')).toBeNull();
  });
});
