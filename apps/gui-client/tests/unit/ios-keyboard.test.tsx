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
  KEY_REPEAT_INITIAL_MS,
  KEY_REPEAT_START_MS,
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

  it('a char press BETWEEN two quick shift taps does NOT falsely caps-lock (fast acronym "AB")', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const { container } = render(<IOSKeyboard room={ROOM} />);
      const kb = (): Element => el(container, '[data-component="ios-keyboard"]');
      now.mockReturnValue(1000);
      tap(container, '⇧'); // shift → once (uppercase keys)
      // Type a letter WITHIN the double-tap window — consumes the one-shot shift
      // AND must break the double-tap sequence.
      pressKey(container, 'A');
      expect(kb()).toHaveAttribute('data-shift', 'off');
      // A second shift tap still inside the FIRST tap's window must NOT lock,
      // because the intervening keypress reset the double-tap timer.
      now.mockReturnValue(1000 + DOUBLE_TAP_MS - 1);
      tap(container, '⇧');
      expect(kb()).toHaveAttribute('data-shift', 'once'); // toggled on, NOT locked
    } finally {
      now.mockRestore();
    }
  });

  it('SPACE between two quick shift taps does NOT falsely caps-lock (keyboard audit w8cp0yp5d)', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const { container } = render(<IOSKeyboard room={ROOM} />);
      const kb = (): Element => el(container, '[data-component="ios-keyboard"]');
      now.mockReturnValue(1000);
      tap(container, '⇧'); // shift → once
      expect(kb()).toHaveAttribute('data-shift', 'once');
      // A SPACE is a non-shift keypress → it must BREAK the double-tap sequence exactly
      // like a char press (reset lastShiftTap). Before the fix, space left the first
      // shift's timestamp intact, so the next quick shift saw isDouble and LOCKED caps.
      pressKey(container, 'space');
      // A second shift tap still inside the FIRST tap's window must NOT lock.
      now.mockReturnValue(1000 + DOUBLE_TAP_MS - 1);
      tap(container, '⇧');
      expect(kb()).not.toHaveAttribute('data-shift', 'locked');
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

describe('IOSKeyboard — delete key press-and-hold repeat (iOS fidelity)', () => {
  it('holding delete repeats Backspace at an accelerating cadence; release stops it', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<IOSKeyboard room={ROOM} />);
      const del = el(container, '[data-key="⌫"]');

      // Press down: one immediate Backspace (keyDown + keyUp), no repeat yet.
      act(() => {
        fireEvent.pointerDown(del);
      });
      expect(emitted()).toEqual([
        { type: 'keyDown', key: 'Backspace' },
        { type: 'keyUp', key: 'Backspace' },
      ]);

      // Nothing more until the initial hold delay elapses.
      act(() => {
        vi.advanceTimersByTime(KEY_REPEAT_INITIAL_MS - 1);
      });
      expect(emitted().length).toBe(2);

      // First repeat fires at the initial-hold boundary (+1 Backspace pair).
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(emitted().length).toBe(4);

      // A further repeat interval yields another Backspace pair.
      act(() => {
        vi.advanceTimersByTime(KEY_REPEAT_START_MS);
      });
      expect(emitted().length).toBe(6);

      // Release: no further repeats no matter how long we wait.
      act(() => {
        fireEvent.pointerUp(del);
      });
      const afterRelease = emitted().length;
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(emitted().length).toBe(afterRelease);
    } finally {
      vi.useRealTimers();
    }
  });

  it('pointer leaving the key mid-hold stops the repeat (iOS: slide off to cancel)', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<IOSKeyboard room={ROOM} />);
      const del = el(container, '[data-key="⌫"]');

      act(() => {
        fireEvent.pointerDown(del);
      });
      act(() => {
        fireEvent.pointerLeave(del);
      });
      const afterLeave = emitted().length;
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(emitted().length).toBe(afterLeave);
    } finally {
      vi.useRealTimers();
    }
  });

  it('a normal delete tap (press + release) fires exactly one Backspace, no repeat', () => {
    vi.useFakeTimers();
    try {
      const { container } = render(<IOSKeyboard room={ROOM} />);
      const del = el(container, '[data-key="⌫"]');
      act(() => {
        fireEvent.pointerDown(del);
        fireEvent.pointerUp(del);
      });
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(emitted()).toEqual([
        { type: 'keyDown', key: 'Backspace' },
        { type: 'keyUp', key: 'Backspace' },
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('IOSKeyboard — bottom-row emoji key', () => {
  it('renders the 😀 emoji key (left of the spacebar) on the letters layer', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const emoji = container.querySelector('[data-key="😀"]');
    expect(emoji).not.toBeNull();
    // It is a function key (no char popup), labelled Emoji.
    expect(emoji).toHaveAttribute('aria-label', 'Emoji');
    expect(emoji).toHaveAttribute('data-key-kind', 'fn');
  });

  it('persists across the numbers + symbols layers (every iOS layer has it)', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    tap(container, '123');
    expect(container.querySelector('[data-key="😀"]')).not.toBeNull();
    tap(container, '#+=');
    expect(container.querySelector('[data-key="😀"]')).not.toBeNull();
  });

  it('is a zero-fingerprint no-op — tapping it emits NO input events', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    tap(container, '😀');
    expect(sendInputEventMock).not.toHaveBeenCalled();
  });

  it('is rendered INERT (disabled + dimmed, no press flash) so the dead key does not invite a tap', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const emoji = el(container, '[data-key="😀"]');
    // Disabled affordance: not interactive, marked for AT, visually dimmed.
    expect(emoji).toHaveAttribute('data-disabled', 'true');
    expect(emoji).toHaveAttribute('aria-disabled', 'true');
    expect((emoji as HTMLButtonElement).disabled).toBe(true);
    expect(emoji.className).toContain('opacity-40');
    // No active press-flash on the inert key (it must not look tappable).
    expect(emoji.className).not.toContain('active:brightness-95');
  });
});

describe('IOSKeyboard — return key colour', () => {
  it('renders GREY by default (real iOS on a generic field) yet stays kind="return"', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const ret = el(container, '[data-key="return"]');
    // Semantically still the return key (not relabelled to a plain fn key).
    expect(ret).toHaveAttribute('data-key-kind', 'return');
    // Grey iOS function-key fill, NOT the blue accent (#0a84ff).
    expect(ret.className).toContain('bg-[#aeb3bd]');
    expect(ret.className).not.toContain('bg-[#0a84ff]');
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

  it('shows the UPPERCASE glyph in the balloon for a one-shot-shifted letter (frozen at press)', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    tap(container, '⇧'); // shift → once; letter keys render uppercase (data-key="A")
    const aKey = el(container, '[data-key="A"]');
    act(() => {
      fireEvent.pointerDown(aKey);
    });
    // The press consumes the one-shot shift so the key re-renders lowercase, but
    // the pop-up balloon must still show the UPPERCASE 'A' it was pressed as
    // (regression: the pre-fix popped-vs-sent match went false → NO balloon).
    const popup = container.querySelector('[data-component="key-popup"]');
    expect(popup).not.toBeNull();
    expect(popup?.textContent).toBe('A');
    act(() => {
      fireEvent.pointerUp(el(container, '[data-key="a"]')); // key is now lowercase
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
