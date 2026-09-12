// On-screen iOS keyboard (founder 2026-06-25 "behave exactly like a real
// iPhone"). Pins the three-layer render + the GUI-local shift behaviour + that
// every key produces the SAME keyDown/keyUp InputEvents the host-keyboard path
// emits. Mocks the livekit wrapper so we capture the emitted events without a
// real Room / data channel.

import { useState } from 'react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import {
  IOSKeyboard as IOSKeyboardImpl,
  type IOSKeyboardProps,
  applyShift,
  keyForChar,
  DOUBLE_TAP_MS,
  KEY_REPEAT_INITIAL_MS,
  KEY_REPEAT_START_MS,
  KEY_COLUMNS,
  KEYBOARD_PALETTES,
  MIN_GEOMETRY,
  MIN_TEXT_PX,
  REF_DEVICE_WIDTH,
  REF_GEOMETRY,
  SCALE_MAX,
  SCALE_MIN,
  charSpanForRow,
  keyBasisPx,
  keyWidthPx,
  keyboardHeightPx,
  keyboardMetrics,
  keyboardPlan,
  keyboardScale,
  type KeyPlan,
  type KeyboardMetrics,
  type KeyboardPalette,
  type KeyboardPlan,
} from '../../src/components/IOSKeyboard';
import { DeviceToolbar } from '../../src/views/SimulatorWindow';
import type { InputEvent, Room } from '../../src/lib/livekit';

const sendInputEventMock = vi.fn();

vi.mock('../../src/lib/livekit', () => ({
  sendInputEvent: (...args: unknown[]) => sendInputEventMock(...args) as unknown,
}));

// A non-null sentinel Room — the component only forwards it to sendInputEvent
// (which is mocked), so its shape is irrelevant.
const ROOM = {} as Room;
const AUTHORITY_EPOCH = 7;
const canSendInput = (room: Room, epoch: number): boolean =>
  room === ROOM && epoch === AUTHORITY_EPOCH;

/** Existing positive fixtures exercise a fully-authorized exact Room/epoch owner. */
function IOSKeyboard(props: IOSKeyboardProps): JSX.Element {
  return (
    <IOSKeyboardImpl {...props} authorityEpoch={AUTHORITY_EPOCH} canSendInput={canSendInput} />
  );
}

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

const noop = (): void => {
  /* fixture */
};

/** The widths the simulator can actually render this board at, measured on the
 *  live harness 2026-09-12 (the area report's table): the Tauri min-width floor
 *  (280 − rail 48 − bezel 20), the 13" height-clamp widths in app and browser
 *  mode, the harness's own 300px column, the three portrait archetypes at 1:1,
 *  and the landscape 1:1. A guard that only ever asks about 402 is the reason
 *  the board rendered 42px keys on a 212px phone for three months. */
const APP_WIDTHS = [212, 254, 287, 300, 360, 390, 393, 402, 660, 874] as const;

/** A required key of a plan (throws rather than `!`, so a renamed key is a loud
 *  failure instead of a silent undefined that compares equal to nothing). */
function planKey(plan: KeyboardPlan, id: string): KeyPlan {
  const key = plan.byId.get(id);
  if (key === undefined) throw new Error(`no key planned for ${id}`);
  return key;
}

/**
 * (rendered board px, device logical px) pairs the app can mount.
 *
 * ⛔ `device` is SimulatorWindow's `inputLogical.width`, and the BOX is its
 * writer: it is set from `page_state.logicalContentWidth`
 * (SimulatorWindow.tsx:6081), i.e. the LONG side if the box ever reports a
 * rotated device. So the 874-device pairs are a configuration this component
 * must accept, not a hypothetical — and every arm that only ever asked about
 * 402 is how a 42px key on a 212px board survived three months. Measured at
 * (212, 874) the scale lands on the SCALE_MIN floor and the keys come out
 * square (18.3 × 18); the aspect arm states the band that allows.
 */
const APP_RENDERS: readonly (readonly [number, number])[] = [
  ...APP_WIDTHS.map((w) => [w, REF_DEVICE_WIDTH] as const),
  [212, 874],
  [300, 874],
  [660, 874],
  [874, 874],
];

/** The function keys iOS draws at the GLYPH size rather than the label size. */
const GLYPH_KEY_IDS = new Set(['⇧', '⌫', '⌄', '😀']);

/** The font size each KIND of key must render at for these metrics. Glyph
 *  function keys draw at the glyph metric because GLYPH_FIT_RATIO's cap is inert
 *  at every pair in APP_RENDERS (it binds only on a 1:1 render of a board
 *  narrower than ~316px, which no real archetype is — the harness scene's
 *  fictional 300pt device at 1:1 is the one such render, measured). The arm that
 *  renders a width where the cap binds is 'the glyph FIT CAP' below. */
function expectedFontPx(key: KeyPlan, m: KeyboardMetrics): number {
  if (key.kind === 'char') return m.charFont;
  if (key.kind === 'space') return m.spaceFont;
  return GLYPH_KEY_IDS.has(key.id) ? m.glyphFont : m.fnFont;
}

/** WCAG relative luminance of a #rrggbb colour. The press-state arm needs an
 *  ORDERING: `expect(dark.fnPressed).not.toBe(dark.fnBg)` was the entire guard
 *  before, and it passes on a pressed colour that goes the WRONG way. */
function lum(hex: string): number {
  const channel = (i: number): number => {
    const v = parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(0) + 0.7152 * channel(1) + 0.0722 * channel(2);
}

/**
 * A ResizeObserver that reports ONE width, synchronously, on observe().
 *
 * ⛔ This is not a convenience: the board's whole scaling rule is
 * measured-width ÷ logical-width, and jsdom has no layout, so without this the
 * rendered DOM could only ever be exercised at the degenerate 1:1 case
 * (measured === prop === scale 1) — exactly the case that was already correct.
 * With it, a render can be driven at a real (rendered 212, logical 402) pair and
 * the geometry the customer sees is what these arms measure. `data-kb-source`
 * is the positive control: it reads `measured` only when this path really ran.
 */
function fakeResizeObserver(width: number): typeof ResizeObserver {
  class FakeResizeObserver {
    private readonly cb: ResizeObserverCallback;
    constructor(cb: ResizeObserverCallback) {
      this.cb = cb;
    }
    observe(target: Element): void {
      const entry = {
        target,
        borderBoxSize: [{ inlineSize: width, blockSize: 0 }],
      } as unknown as ResizeObserverEntry;
      this.cb([entry], this);
    }
    unobserve(): void {
      /* one-shot */
    }
    disconnect(): void {
      /* one-shot */
    }
  }
  return FakeResizeObserver;
}

/** Render the keyboard as the app renders it: a `logical` device width prop, and
 *  a board whose measured width is `rendered`. */
function renderScaled(
  rendered: number,
  logical: number,
): { container: HTMLElement; unmount: () => void } {
  vi.stubGlobal('ResizeObserver', fakeResizeObserver(rendered));
  try {
    const { container, unmount } = render(
      <IOSKeyboard room={ROOM} width={logical} onDismiss={noop} />,
    );
    return { container, unmount };
  } finally {
    vi.unstubAllGlobals();
  }
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

  it('fails closed when the authority predicate is omitted or false', () => {
    const omitted = render(<IOSKeyboardImpl room={ROOM} authorityEpoch={AUTHORITY_EPOCH} />);
    pressKey(omitted.container, 'a');
    expect(sendInputEventMock).not.toHaveBeenCalled();
    omitted.unmount();

    const denied = render(
      <IOSKeyboardImpl room={ROOM} authorityEpoch={AUTHORITY_EPOCH} canSendInput={() => false} />,
    );
    pressKey(denied.container, 'a');
    expect(sendInputEventMock).not.toHaveBeenCalled();
  });

  it('drops a retained key callback after its exact authority epoch becomes stale', () => {
    let currentEpoch = AUTHORITY_EPOCH;
    const { container } = render(
      <IOSKeyboardImpl
        room={ROOM}
        authorityEpoch={AUTHORITY_EPOCH}
        canSendInput={(room, epoch) => room === ROOM && epoch === currentEpoch}
      />,
    );
    currentEpoch += 1;
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

  it('cancels the deferred delete-repeat chain when its authority epoch is revoked', () => {
    vi.useFakeTimers();
    try {
      let currentEpoch = AUTHORITY_EPOCH;
      const { container } = render(
        <IOSKeyboardImpl
          room={ROOM}
          authorityEpoch={AUTHORITY_EPOCH}
          canSendInput={(room, epoch) => room === ROOM && epoch === currentEpoch}
        />,
      );
      const del = el(container, '[data-key="⌫"]');
      act(() => {
        fireEvent.pointerDown(del);
      });
      expect(emitted()).toHaveLength(2);

      currentEpoch += 1;
      act(() => {
        vi.advanceTimersByTime(KEY_REPEAT_INITIAL_MS + KEY_REPEAT_START_MS * 3);
      });
      expect(emitted()).toHaveLength(2);
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
    // ⛔ This used to read `not.toContain('active:brightness-95')`, which is
    // VACUOUS here: the disabled key's class branch is `cursor-default
    // opacity-40` and can contain no `active:` class for ANY value of the live
    // branch, so reverting the live flash to the iOS-wrong darkening one read
    // 43/43 green. Assert the shape that is actually true of a disabled key, and
    // pin the live keys' flash where it renders ('press states', below).
    expect(emoji.className).not.toContain('active:');
  });
});

describe('IOSKeyboard — return key colour', () => {
  it('renders GREY by default (real iOS on a generic field) yet stays kind="return"', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const ret = el(container, '[data-key="return"]');
    // Semantically still the return key (not relabelled to a plain fn key).
    expect(ret).toHaveAttribute('data-key-kind', 'return');
    // Grey iOS function-key fill, NOT the blue accent. Every colour now comes
    // from ONE palette object through a CSS custom property (so the press states
    // stay real `:active` rules and no colour is hard-coded in a class string),
    // so this pins the var the key paints through AND the value that var holds.
    expect(ret.className).toContain('bg-[var(--kb-fn-bg)]');
    expect(ret.className).not.toContain('--kb-accent');
    expect(KEYBOARD_PALETTES.light.fnBg).toBe('#aeb3bd');
    expect(KEYBOARD_PALETTES.light.accent).toBe('#0a84ff');
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

// V-2168 — iPhone key GEOMETRY. The letters rows have 10, 9 and 7 keys, and a
// real iPhone renders all of them at ONE key width, centring the shorter rows so
// they sit inset. The old `grow basis-0` gave each row an equal share of the
// full board instead, so `asdf` keys were visibly wider than `qwerty` keys and
// `zxcv` wider still — the clearest single tell that this was a web keyboard
// rather than the device's. These arms pin the sizing rule, which is what
// survives a restyle, rather than a pixel measurement jsdom cannot produce.
describe('IOSKeyboard — one key width across rows (V-2168)', () => {
  it('⛔ every character key is sized from the same 10-column unit, not a per-row share', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const charKeys = [...container.querySelectorAll('[data-key-kind="char"]')];
    expect(charKeys.length).toBeGreaterThan(20); // all three letter rows rendered

    const bases = new Set(charKeys.map((k) => (k as HTMLElement).style.flexBasis));
    // ONE sizing rule for every key on the board — a per-row share would give
    // three different values here (10, 9 and 7 keys per row).
    expect(bases.size, `expected one basis, saw: ${[...bases].join(' | ')}`).toBe(1);
    expect([...bases][0]).not.toBe('');
    // And no key may GROW: growth is exactly what stretched the short rows.
    expect(
      charKeys.every((k) => (k as HTMLElement).style.flexGrow === '0'),
      'a character key that grows re-stretches its row',
    ).toBe(true);
  });

  it('the sizing rule itself: one column, and shift/delete at 1.5 columns + the gap they swallow', () => {
    const m = keyboardMetrics(REF_DEVICE_WIDTH, REF_DEVICE_WIDTH);
    // One column = (content box − the 9 gaps between the 10 columns) / 10.
    expect(m.unit).toBeCloseTo(
      (REF_DEVICE_WIDTH - 2 * REF_GEOMETRY.padX - 9 * REF_GEOMETRY.gap) / KEY_COLUMNS,
      6,
    );
    expect(keyWidthPx(1, m)).toBeCloseTo(m.unit, 6);
    // ⛔ A 1.5-column key is 1.5 keys PLUS the gap it swallows. The old
    // `calc((100% - 54px) * n / 10)` basis charged every key all 9 gaps whatever
    // its row actually held, so row 3 (9 keys, 8 gaps) and the bottom row (4/5
    // keys) came out one gap NARROWER than row 1 — a keyboard whose outer rows
    // were flush and whose middle rows were inset by 3px a side.
    expect(keyWidthPx(1.5, m)).toBeCloseTo(m.unit * 1.5 + m.gap * 0.5, 6);
    const plan = keyboardPlan({
      layer: 'letters',
      width: REF_DEVICE_WIDTH,
      device: REF_DEVICE_WIDTH,
    });
    expect(plan.rows.map((r) => r.spans)).toEqual([
      KEY_COLUMNS,
      KEY_COLUMNS - 1,
      KEY_COLUMNS,
      KEY_COLUMNS,
    ]);
    // …and the per-row character span: uniform where there are no flanks (V-2168
    // — the short `asdf` row is INSET, never stretched), filling where there are
    // (the 123 layer's `. , ? ! '` row is five WIDE keys on iOS, not five
    // letter-width keys floating in the middle of the row).
    expect(charSpanForRow(9, 0)).toBe(1);
    expect(charSpanForRow(7, 2)).toBe(1);
    expect(charSpanForRow(5, 2)).toBeCloseTo(1.4, 6);
  });

  it('shift and delete really use the 1.5-unit rule on the rendered board', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const shift = container.querySelector<HTMLElement>('[aria-label="Shift"]');
    const del = container.querySelector<HTMLElement>('[aria-label="Delete"]');
    expect(shift).not.toBeNull();
    expect(del).not.toBeNull();
    for (const key of [shift, del]) {
      if (key === null) continue;
      // A row-3 flank must not GROW into slack — that would re-stretch the row
      // the uniform sizing exists to keep inset.
      expect(key.style.flexGrow).toBe('0');
      expect(key.style.flexBasis).not.toBe('');
    }
  });

  it('character glyphs render at the iOS letter size at 1:1, and scale with the render zoom', () => {
    const { container } = render(<IOSKeyboard room={ROOM} width={REF_DEVICE_WIDTH} />);
    const anyChar = container.querySelector<HTMLElement>('[data-key-kind="char"]');
    // 22px is the real iOS letter size; 17px read as a compact web keyboard.
    expect(anyChar?.style.fontSize).toBe(`${String(REF_GEOMETRY.charFont)}px`);
    expect(REF_GEOMETRY.charFont).toBe(22);
    // …and it is no longer a constant: a board rendered at 300 or 212 CSS px for
    // a 402pt device is a 0.75× / 0.53× zoom of that device, glyph included.
    expect(keyboardMetrics(300, REF_DEVICE_WIDTH).charFont).toBe(16);
    expect(keyboardMetrics(212, REF_DEVICE_WIDTH).charFont).toBe(12);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K3 — WIDTH-DERIVED GEOMETRY (owner 2026-09-12: "imprpoved auto scaling").
//
// The defect these arms exist for, measured on the live harness before the fix:
// driving the rendered board width 212 → 874 moved NOTHING. Key height 42, board
// height 200, gap 6, radius 5, fonts 22/15/13 at every width — because the only
// width-derived value in the component was the side padding, and it was a
// function of the `width` PROP (the archetype's logical width, a constant 402)
// rather than of the box the customer is looking at. A 42px key on a 212px board
// is 2.7× taller than it is wide.
//
// So: the pure geometry is pinned at every width the app can produce, and the
// RENDERED DOM is pinned at two of them through a one-shot ResizeObserver —
// because a guard that can only ask about the reference width is the guard this
// board already had.
describe('IOSKeyboard — width-derived geometry (K3)', () => {
  it('reproduces the REFERENCE 402 render exactly at 1:1 — including the 200px board', () => {
    const m = keyboardMetrics(REF_DEVICE_WIDTH, REF_DEVICE_WIDTH);
    expect(m.scale).toBe(1);
    // ⛔ LITERALS, not `{ ...REF_GEOMETRY }`. At scale 1 `scaled(ref, floor, 1)`
    // IS `ref` for every entry, so comparing the derived metrics to the table
    // they derive from is a tautology: both sides move together and the arm
    // cannot fail on a change to the reference. Proved — `radius 5 → 17` plus
    // `glyphFont 20 → 40` read 43/43 green (17px pill corners and a 26px ⇧), and
    // so did `bevel → 'none'`. These are the numbers of the render this replaces,
    // spelled out, so moving one is a decision instead of a drift.
    expect({
      gap: m.gap,
      keyH: m.keyH,
      radius: m.radius,
      padX: m.padX,
      padTop: m.padTop,
      padBottom: m.padBottom,
      charFont: m.charFont,
      glyphFont: m.glyphFont,
      fnFont: m.fnFont,
      spaceFont: m.spaceFont,
      bevel: m.bevel,
    }).toEqual({
      gap: 6,
      keyH: 42,
      radius: 5,
      padX: 3,
      padTop: 8,
      padBottom: 6,
      charFont: 22,
      glyphFont: 20,
      fnFont: 15,
      spaceFont: 13,
      bevel: 1,
    });
    // The pop-up balloon's own geometry: 44 × 48 at 26px, overlapping the key's
    // top edge by 4 (so its rendered `top` is −44). Nothing pinned these four —
    // POP_H_RATIO could double and POP_FONT_RATIO drop to 8/22 with every arm
    // green, while the docstring claimed they "reproduce the shipped balloon
    // exactly".
    expect({
      popHeight: m.popHeight,
      popRadius: m.popRadius,
      popFont: m.popFont,
      popOverlap: m.popOverlap,
    }).toEqual({ popHeight: 48, popRadius: 10, popFont: 26, popOverlap: 4 });
    // ⛔ SimulatorWindow's KEYBOARD_H hard-codes 200 and its comment DERIVES it
    // ("4 rows × 42 + 3 × 6 + 8 + 6"). That term is inert today
    // (keyboardChromeOn() is always false) but the number is pinned by
    // simulator-window-sizing.test.ts, so the reference width must keep
    // reproducing it exactly — which is why the scale is anchored at 402 and
    // capped at 1 instead of being free above it.
    expect(m.height).toBe(200);
    expect(keyboardHeightPx(REF_DEVICE_WIDTH)).toBe(200);
    // Below 1:1 the board is genuinely shorter — it is a zoomed-out phone.
    expect(keyboardHeightPx(300, REF_DEVICE_WIDTH)).toBe(146);
    expect(keyboardHeightPx(212, REF_DEVICE_WIDTH)).toBe(104);
  });

  it('the scale is the render ZOOM (measured ÷ logical), capped at 1:1', () => {
    expect(keyboardScale(REF_DEVICE_WIDTH, REF_DEVICE_WIDTH)).toBe(1);
    expect(keyboardScale(300, REF_DEVICE_WIDTH)).toBeCloseTo(300 / REF_DEVICE_WIDTH, 6);
    expect(keyboardScale(212, REF_DEVICE_WIDTH)).toBeCloseTo(212 / REF_DEVICE_WIDTH, 6);
    // Landscape 1:1 (874 logical shown in 874 px) is a 1:1 render, so the rows
    // stay reference-height and only the keys get wider — which is what a
    // landscape iPhone keyboard does.
    expect(keyboardScale(874, 874)).toBe(1);
    // A board wider than the device it is showing never grows the keys BEYOND
    // the real device's own keyboard.
    expect(keyboardScale(874, REF_DEVICE_WIDTH)).toBe(SCALE_MAX);
    // ⛔ …and the clamps as LITERALS. The line above compares the function's
    // output to the very constant it clamps WITH, so it holds for any value of
    // that constant: `SCALE_MAX 1 → 2` was caught only by the rendered key
    // height, and `SCALE_MIN 0.3 → 0.02` was caught by nothing at all.
    expect(SCALE_MAX).toBe(1);
    expect(SCALE_MIN).toBe(0.3);
    expect(keyboardScale(874, REF_DEVICE_WIDTH)).toBe(1);
    expect(keyboardScale(60, REF_DEVICE_WIDTH)).toBe(0.3);
    // A zero / non-finite prop must not collapse the board.
    expect(keyboardScale(300, 0)).toBeCloseTo(300 / REF_DEVICE_WIDTH, 6);
    expect(keyboardScale(Number.NaN, REF_DEVICE_WIDTH)).toBe(1);
  });

  it('⛔ every row fills the board EXACTLY, and no key leaves it, at every width the app renders', () => {
    for (const layer of ['letters', 'numbers', 'symbols'] as const) {
      for (const [width, device] of APP_RENDERS) {
        const plan = keyboardPlan({ layer, width, device, hasDismiss: true });
        const m = plan.metrics;
        plan.rows.forEach((row, i) => {
          const where = `${layer} row ${String(i)} at ${String(width)}/${String(device)}`;
          if (row.spans === KEY_COLUMNS) {
            // Flush with the content box: this is what makes row 3 and the
            // bottom row line up with row 1 on a real iPhone.
            expect(Math.abs(row.width - m.contentWidth), `${where} fill`).toBeLessThan(0.01);
            expect(Math.abs(row.left - m.padX), `${where} left`).toBeLessThan(0.01);
          } else {
            // The 9-key `asdf` row: inset by exactly half a key pitch a side.
            expect(row.spans, `${where} spans`).toBe(KEY_COLUMNS - 1);
            expect(
              Math.abs(row.left - (m.padX + (m.unit + m.gap) / 2)),
              `${where} inset`,
            ).toBeLessThan(0.01);
          }
          for (const key of row.keys) {
            expect(key.width, `${where} ${key.id} width`).toBeGreaterThan(0);
            expect(key.left, `${where} ${key.id} left`).toBeGreaterThanOrEqual(m.padX - 0.01);
            expect(key.left + key.width, `${where} ${key.id} right`).toBeLessThanOrEqual(
              m.width - m.padX + 0.01,
            );
          }
        });
      }
    }
  });

  it('the ROW STRUCTURE is identical at two very different widths — only the pixels move', () => {
    const shape = (width: number): string[] =>
      keyboardPlan({
        layer: 'letters',
        width,
        device: REF_DEVICE_WIDTH,
        hasDismiss: true,
      }).rows.map((r) => r.keys.map((k) => `${k.id}@${k.span.toFixed(3)}`).join(' '));
    expect(shape(212)).toEqual(shape(874));
    // The spacebar takes what the other four leave: 10 − 1.5 − 1 − 1 − 2.5.
    expect(shape(212)[3]).toContain('space@4.000');
    // …and the pixels really do move (a guard whose two widths agree on
    // everything is measuring a constant).
    const narrow = keyboardPlan({ layer: 'letters', width: 212, device: REF_DEVICE_WIDTH });
    const wide = keyboardPlan({ layer: 'letters', width: 874, device: REF_DEVICE_WIDTH });
    expect(planKey(narrow, 'q').width).toBeLessThan(planKey(wide, 'q').width);
    expect(narrow.metrics.keyH).toBeLessThan(wide.metrics.keyH);
  });

  it('⛔ a letter key keeps an iPhone-ish ASPECT at every (render, device) pair', () => {
    // The owner reported an ASPECT, not a width: 0.37 at a 212px board, 1.94 at
    // 874. "No key leaves the box" cannot see that — a 15 × 42 key is inside the
    // box. This band is the shape assertion, and it is the only arm that asks
    // about a rotated device at all.
    for (const [rendered, device] of APP_RENDERS) {
      const plan = keyboardPlan({ layer: 'letters', width: rendered, device, hasDismiss: true });
      const aspect = planKey(plan, 'q').width / plan.metrics.keyH;
      const where = `q aspect at ${String(rendered)}/${String(device)}`;
      expect(aspect, where).toBeGreaterThan(0.6);
      expect(aspect, where).toBeLessThan(2.2);
    }
    // Vacuity control: the geometry this replaces — a CONSTANT 42px key height at
    // every width — is outside the band at the narrow end (18.1 / 42 = 0.43),
    // which is the defect the owner reported.
    const narrow = keyboardPlan({ layer: 'letters', width: 212, device: REF_DEVICE_WIDTH });
    expect(planKey(narrow, 'q').width / REF_GEOMETRY.keyH).toBeLessThan(0.6);
    // …and the rotated pair is the one that lands ON the scale floor: square-ish
    // keys at a 212px board showing an 874pt page. It is inside the band, and it
    // is the number to hand A3 if the box ever reports a rotated
    // logicalContentWidth (the floor is a legibility contract — below it the font
    // floors would sink under the text-quality gate).
    const rotated = keyboardPlan({ layer: 'letters', width: 212, device: 874 });
    expect(rotated.metrics.scale).toBe(SCALE_MIN);
    const rotatedAspect = planKey(rotated, 'q').width / rotated.metrics.keyH;
    expect(rotatedAspect).toBeGreaterThan(1);
    expect(rotatedAspect).toBeLessThan(1.05);
  });

  it('the space/return ratio no longer drifts with the width (both are on the grid)', () => {
    // Measured before the fix: space/letter went 2.74u → 4.47u (+63%) across
    // 874 → 212, because the bottom row split a flexGrow SLACK that changed with
    // the width while the letter rows used a fixed basis. On the column grid the
    // SPAN is identical at every width by construction, and the px ratio moves
    // only by the gap's own rounding (a gap is a whole px; a column is not).
    const shaped = APP_WIDTHS.map((width) => {
      const plan = keyboardPlan({ layer: 'letters', width, device: REF_DEVICE_WIDTH });
      const unit = planKey(plan, 'q').width;
      return {
        width,
        spaceSpan: planKey(plan, 'space').span,
        retSpan: planKey(plan, 'return').span,
        space: planKey(plan, 'space').width / unit,
        ret: planKey(plan, 'return').width / unit,
      };
    });
    const first = shaped[0];
    if (first === undefined) throw new Error('no widths');
    for (const r of shaped) {
      expect(r.spaceSpan, `space span at ${String(r.width)}`).toBe(first.spaceSpan);
      expect(r.retSpan, `return span at ${String(r.width)}`).toBe(first.retSpan);
      // In PX the ratio still moves a little, and for a reason worth naming: a
      // gap is a whole number of pixels while a column is fractional, so g/u
      // wobbles with the gap's rounding (3px at 212, 4px at 254), and past 1:1
      // the gap is capped at the reference 6 while the columns keep widening —
      // which is the landscape behaviour, wider keys at the same gap. Bounded at
      // 7% across 212 → 874, against the +63% this replaces.
      const tolerance = 0.07;
      expect(
        Math.abs(r.space / first.space - 1),
        `space/letter at ${String(r.width)}`,
      ).toBeLessThan(tolerance);
      expect(Math.abs(r.ret / first.ret - 1), `return/letter at ${String(r.width)}`).toBeLessThan(
        tolerance,
      );
    }
  });

  it('the pressed-key balloon stays INSIDE the board at every width (it did not, even at 402)', () => {
    for (const width of APP_WIDTHS) {
      const plan = keyboardPlan({ layer: 'letters', width, device: REF_DEVICE_WIDTH });
      for (const row of plan.rows) {
        for (const key of row.keys) {
          if (key.kind !== 'char') continue;
          const left = key.left + key.width / 2 - key.popWidth / 2 + key.popDx;
          expect(left, `${key.id} balloon left at ${String(width)}`).toBeGreaterThanOrEqual(-0.01);
          expect(
            left + key.popWidth,
            `${key.id} balloon right at ${String(width)}`,
          ).toBeLessThanOrEqual(width + 0.01);
        }
      }
    }
    // POSITIVE CONTROL for the arm above: it would also pass on a balloon of
    // width 0, or with every nudge 0. The row ENDS must really be nudged inward
    // (measured: 2.8px over the left edge at the default 402, 12.3px at 212) and
    // an interior key must not be nudged at all.
    const ref = keyboardPlan({
      layer: 'letters',
      width: REF_DEVICE_WIDTH,
      device: REF_DEVICE_WIDTH,
    });
    expect(planKey(ref, 'q').popWidth).toBeGreaterThan(planKey(ref, 'q').width);
    expect(planKey(ref, 'q').popDx).toBeGreaterThan(0.5);
    expect(planKey(ref, 'p').popDx).toBeLessThan(-0.5);
    expect(planKey(ref, 't').popDx).toBe(0);
  });

  it('no derived font can sink under the text-quality gate at any width the app renders', () => {
    // scripts/gui-text-quality.mjs MIN_PX — and the simulator scene already has
    // 50 leaves sitting exactly on it, so there is no headroom to borrow.
    const GATE_MIN_PX = 9;
    expect(MIN_TEXT_PX).toBeGreaterThan(GATE_MIN_PX);
    for (const floor of [
      MIN_GEOMETRY.charFont,
      MIN_GEOMETRY.glyphFont,
      MIN_GEOMETRY.fnFont,
      MIN_GEOMETRY.spaceFont,
    ]) {
      expect(floor).toBeGreaterThanOrEqual(MIN_TEXT_PX);
    }
    for (const [width, device] of APP_RENDERS) {
      const m = keyboardMetrics(width, device);
      for (const [name, size] of [
        ['charFont', m.charFont],
        ['glyphFont', m.glyphFont],
        ['fnFont', m.fnFont],
        ['spaceFont', m.spaceFont],
      ] as const) {
        expect(size, `${name} at ${String(width)}/${String(device)}`).toBeGreaterThanOrEqual(
          MIN_TEXT_PX,
        );
      }
      // A proportional scale WOULD break it — this is the vacuity control for
      // the floors: 15px and 13px at a 212px board are 7.9 and 6.9.
      if (width === 212 && device === REF_DEVICE_WIDTH) {
        expect(Math.round(REF_GEOMETRY.fnFont * m.scale)).toBeLessThan(GATE_MIN_PX);
        expect(Math.round(REF_GEOMETRY.spaceFont * m.scale)).toBeLessThan(GATE_MIN_PX);
      }
    }
  });

  it('⛔ the RENDERED board is the plan — a NARROW, a WIDE and a ROTATED-device board', () => {
    const renderedKeyHeights = new Map<string, number>();
    for (const [rendered, logical] of [
      [212, REF_DEVICE_WIDTH],
      [874, REF_DEVICE_WIDTH],
      // ⛔ The rotated device: a 212px board showing an 874pt-wide page. It is the
      // pair that lands on the SCALE_MIN floor, and no arm rendered it before.
      [212, 874],
    ] as const) {
      const { container, unmount } = renderScaled(rendered, logical);
      try {
        const board = el(container, '[data-component="ios-keyboard"]') as HTMLElement;
        // The measurement path really ran — otherwise every number below is the
        // prop's, and this whole arm would be measuring the old behaviour.
        expect(board).toHaveAttribute('data-kb-source', 'measured');
        expect(board).toHaveAttribute('data-kb-width', String(rendered));
        expect(board).toHaveAttribute('data-kb-device', String(logical));

        const plan = keyboardPlan({
          layer: 'letters',
          width: rendered,
          device: logical,
          hasDismiss: true,
        });
        const m = plan.metrics;
        expect(board).toHaveAttribute('data-kb-height', String(m.height));
        expect(board.style.paddingLeft).toBe(`${String(m.padX)}px`);
        expect(board.style.rowGap).toBe(`${String(m.gap)}px`);

        for (const [rowIndex, row] of plan.rows.entries()) {
          const rowEl = el(container, `[data-kb-row="${String(rowIndex)}"]`) as HTMLElement;
          // ⛔ ONE gap: the arithmetic that sizes the keys and the gap the DOM
          // actually renders used to be two unlinked literals (KEY_GAP_PX and a
          // `gap-[6px]` class), and nothing pinned that they agreed.
          expect(rowEl.style.columnGap, `row ${String(rowIndex)} gap`).toBe(`${String(m.gap)}px`);
          expect(rowEl.getAttribute('data-kb-row-spans')).toBe(String(row.spans));
          for (const key of row.keys) {
            const node = el(container, `[data-key="${CSS.escape(key.id)}"]`) as HTMLElement;
            // The key's rendered basis IS its planned width — hard-code one key
            // in px and this fails at whichever of the two widths it is not.
            expect(node.style.flexBasis, `${key.id} basis at ${String(rendered)}`).toBe(
              `${String(key.width)}px`,
            );
            expect(node.style.height, `${key.id} height at ${String(rendered)}`).toBe(
              `${String(m.keyH)}px`,
            );
            expect(node.style.borderRadius).toBe(`${String(m.radius)}px`);
            // The plan is really PRESENT for every rendered key: a key the plan
            // has no entry for drops this attribute (and used to render at
            // flexBasis 0 — invisible, with the row absorbing its space).
            expect(node.getAttribute('data-key-span'), `${key.id} span attr`).toBe(
              key.span.toString(),
            );
            // The stable identity beside the cased glyph `data-key` publishes.
            if (key.kind === 'char') {
              expect(node.getAttribute('data-key-id'), `${key.id} id attr`).toBe(key.id);
            }
            // ⛔ The FONT per key kind. The file had exactly ONE fontSize
            // assertion (a char key at 402), so the change's own headline —
            // ⇧ ⌫ ⌄ 😀 at the iOS glyph size instead of the 15px label size —
            // shipped with no guard: dropping `glyph` from ⇧, and collapsing
            // GLYPH_FIT_RATIO, both read 43/43 green.
            expect(node.style.fontSize, `${key.id} font at ${String(rendered)}`).toBe(
              `${String(expectedFontPx(key, m))}px`,
            );
            expect(
              node.style.boxShadow.startsWith(`0 ${String(m.bevel)}px 0 rgba`),
              `${key.id} bevel at ${String(rendered)}: ${node.style.boxShadow}`,
            ).toBe(true);
            // Nothing may grow: growth is what let the bottom row drift off the
            // grid, and what stretched the short letter rows before V-2168.
            expect(node.style.flexGrow, `${key.id} grow`).toBe('0');
            expect(node.style.flexShrink, `${key.id} shrink`).toBe('1');
          }
        }
        expect(board.getAttribute('data-kb-scale')).toBe(
          keyboardScale(rendered, logical).toFixed(4),
        );
        renderedKeyHeights.set(`${String(rendered)}/${String(logical)}`, m.keyH);
      } finally {
        unmount();
      }
    }
    // The whole point, as LITERALS: a 212px board does not render the 402px
    // board's key height (874 against a 402pt device is a >1:1 zoom, so it is the
    // REFERENCE height with wider keys — a landscape keyboard), and the rotated
    // pair sits on MIN_GEOMETRY.keyH.
    expect([...renderedKeyHeights.entries()]).toEqual([
      ['212/402', 22],
      ['874/402', 42],
      ['212/874', 18],
    ]);
    expect(MIN_GEOMETRY.keyH).toBe(18);
  });

  it('the spacebar is on the grid and CAN shrink — it was the one key that could not', () => {
    // Measured before the fix at a 212px board: `row4 scrollW 210 > clientW 208`.
    // CharKey and FnKey both carried min-w-0; the spacebar had `flexBasis: auto`
    // and no min-width, so its min-content ("space" at 13px) refused to shrink
    // and the bottom row overflowed the keyboard.
    const { container } = renderScaled(212, REF_DEVICE_WIDTH);
    const space = el(container, '[data-key="space"]') as HTMLElement;
    expect(space.className).toContain('min-w-0');
    expect(space.style.flexGrow).toBe('0');
    expect(space.style.flexShrink).toBe('1');
    expect(space.style.flexBasis).not.toBe('');
    expect(space.style.flexBasis).not.toBe('auto');
    expect(space.getAttribute('data-key-span')).toBe('4');
  });

  it('is FIXED light by default, and dark is reachable ONLY through the explicit prop', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    const board = el(container, '[data-component="ios-keyboard"]');
    expect(board).toHaveAttribute('data-kb-scheme', 'light');
    // ⛔ A device screen is not themed: external web content uses FIXED colours
    // (the rule is written at visual-harness/gallery.tsx), a real iPhone keyboard
    // follows the PAGE's colour scheme, and no colour scheme exists on the wire
    // (PageState carries none). A `dark:` variant is exactly how this file would
    // silently start following the DESKTOP app's theme instead.
    expect(container.innerHTML).not.toContain('dark:');
    const dark = render(
      <IOSKeyboardImpl
        room={ROOM}
        authorityEpoch={AUTHORITY_EPOCH}
        canSendInput={canSendInput}
        colorScheme="dark"
      />,
    );
    const darkBoard = el(dark.container, '[data-component="ios-keyboard"]') as HTMLElement;
    expect(darkBoard).toHaveAttribute('data-kb-scheme', 'dark');
    expect(KEYBOARD_PALETTES.dark.board).not.toBe(KEYBOARD_PALETTES.light.board);
    expect(KEYBOARD_PALETTES.dark.charBg).not.toBe(KEYBOARD_PALETTES.light.charBg);
    // A pressed function key goes LIGHTER on iOS (the white flash a held 123 or
    // return shows), in both schemes — it never darkens.
    expect(KEYBOARD_PALETTES.light.fnPressed).toBe('#ffffff');
    expect(KEYBOARD_PALETTES.dark.fnPressed).not.toBe(KEYBOARD_PALETTES.dark.fnBg);
    dark.unmount();
  });

  it('⛔ at 1:1 every key renders the iOS font size for its KIND — as literals', () => {
    const { container, unmount } = renderScaled(REF_DEVICE_WIDTH, REF_DEVICE_WIDTH);
    try {
      const font = (sel: string): string => (el(container, sel) as HTMLElement).style.fontSize;
      // The glyph keys ARE the change: ⇧ ⌫ ⌄ 😀 used to draw at the 15px label
      // size, which on iOS they do not. Both mutations that revert it — dropping
      // `glyph` from the ⇧ FnKey, and collapsing GLYPH_FIT_RATIO — read 43/43
      // green before this arm and the per-key arm above existed.
      for (const id of ['⇧', '⌫', '⌄', '😀']) {
        expect(font(`[data-key="${CSS.escape(id)}"]`), `${id} glyph font`).toBe('20px');
      }
      for (const id of ['123', 'return']) {
        expect(font(`[data-key="${id}"]`), `${id} label font`).toBe('15px');
      }
      expect(font('[data-key="space"]')).toBe('13px');
      for (const ch of ['q', 'a', 'z']) {
        expect(font(`[data-key="${ch}"]`), `${ch} char font`).toBe('22px');
      }
      // …and the shapes those fonts sit in (radius and the iOS key bevel had no
      // independent pin either: `bevel → 'none'` read green).
      const q = el(container, '[data-key="q"]') as HTMLElement;
      expect(q.style.borderRadius).toBe('5px');
      expect(q.style.height).toBe('42px');
      expect(q.style.boxShadow.startsWith('0 1px 0 rgba'), q.style.boxShadow).toBe(true);
    } finally {
      unmount();
    }
  });

  it('the glyph FIT CAP really lowers a glyph on a key too narrow for it', () => {
    // ⛔ GLYPH_FIT_RATIO is INERT at every width the simulator can mount — the
    // narrowest board is 212 (Tauri min 280 − rail 48 − bezel 20) and its 18.1px
    // column carries the 11px glyph with margin — so `0.78 → 10` (the cap
    // disabled) read 43/43 green, and the constant's ⛔ comment credited it with
    // preventing a clip it cannot reach. The 120px board below is deliberately
    // BELOW the reachable floor: it is the only way to exercise the cap, and it
    // also pins the precedence (the cap lowers the glyph, then MIN_TEXT_PX —
    // 1px above the text-quality gate's floor — stops it). With the floor
    // outside the cap, as it shipped, this renders 11px instead of 10.
    const reachable = renderScaled(212, REF_DEVICE_WIDTH);
    try {
      expect(keyboardMetrics(212, REF_DEVICE_WIDTH).glyphFont).toBe(11);
      expect((el(reachable.container, '[data-key="😀"]') as HTMLElement).style.fontSize).toBe(
        '11px',
      );
    } finally {
      reachable.unmount();
    }
    const narrow = renderScaled(120, REF_DEVICE_WIDTH);
    try {
      const m = keyboardMetrics(120, REF_DEVICE_WIDTH);
      expect(m.glyphFont).toBe(11);
      expect(m.unit).toBeLessThan(11 / 0.78);
      expect((el(narrow.container, '[data-key="😀"]') as HTMLElement).style.fontSize).toBe(
        `${String(MIN_TEXT_PX)}px`,
      );
    } finally {
      narrow.unmount();
    }
  });

  it('⛔ every palette colour reaches the board as a CSS custom property (both schemes)', () => {
    // Deleting the nine `--kb-char-*` / `--kb-fn-*` declarations from boardStyle
    // read 43/43 green, and the measured consequence is exactly the failure the
    // palette comment exists to prevent: every char key inherits the DESKTOP
    // app's ink (gui-text-quality: fg #f1f5f9 on bg #d1d4db, ratio 1.35, 29
    // findings) and marketing-screens reports 160369 pixels differ.
    // `innerHTML` not containing 'dark:' pins the ABSENCE of a mechanism; this
    // pins the PRESENCE of the colours.
    const VARS: readonly (readonly [keyof KeyboardPalette, string])[] = [
      ['board', '--kb-board'],
      ['charBg', '--kb-char-bg'],
      ['charPressed', '--kb-char-press'],
      ['charInk', '--kb-char-ink'],
      ['fnBg', '--kb-fn-bg'],
      ['fnPressed', '--kb-fn-press'],
      ['fnActive', '--kb-fn-active'],
      ['fnLocked', '--kb-fn-locked'],
      ['fnLockedPressed', '--kb-fn-locked-press'],
      ['fnInk', '--kb-fn-ink'],
      ['fnLockedInk', '--kb-fn-locked-ink'],
      ['accent', '--kb-accent'],
      ['accentInk', '--kb-accent-ink'],
      ['popBg', '--kb-pop-bg'],
      ['popInk', '--kb-pop-ink'],
    ];
    for (const scheme of ['light', 'dark'] as const) {
      const view = render(
        <IOSKeyboardImpl
          room={ROOM}
          authorityEpoch={AUTHORITY_EPOCH}
          canSendInput={canSendInput}
          colorScheme={scheme}
        />,
      );
      try {
        const board = el(view.container, '[data-component="ios-keyboard"]') as HTMLElement;
        for (const [field, prop] of VARS) {
          expect(board.style.getPropertyValue(prop), `${scheme} ${prop}`).toBe(
            KEYBOARD_PALETTES[scheme][field],
          );
        }
        // …and the board really paints THROUGH the var instead of from a literal.
        expect(board.getAttribute('style')).toContain('var(--kb-board)');
        expect(el(view.container, '[data-key="q"]').className).toContain('bg-[var(--kb-char-bg)]');
      } finally {
        view.unmount();
      }
    }
  });

  it('⛔ the pressed balloon RENDERS the plan — size, font, top overlap and the edge nudge', () => {
    // The balloon arm above measures the PLAN, and the render was free to ignore
    // it: dropping `popDx` from the transform (`translateX(-50%)`) read 43/43
    // green while a browser measured the row-end balloon hanging off the board
    // again (pre-fix: q left −1.84, p right 403.84 on a 402px board). The
    // vertical half — height, font, the −44px top — was pinned nowhere at all.
    const { container, unmount } = renderScaled(REF_DEVICE_WIDTH, REF_DEVICE_WIDTH);
    try {
      const ref = keyboardPlan({
        layer: 'letters',
        width: REF_DEVICE_WIDTH,
        device: REF_DEVICE_WIDTH,
        hasDismiss: true,
      });
      const q = planKey(ref, 'q');
      expect(q.popWidth).toBe(44);
      expect(q.popDx).toBeCloseTo(1.9, 6);
      const edge = el(container, '[data-key="q"]') as HTMLElement;
      // The attributes a browser-side gate reads (the balloon exists in the DOM
      // only while a key is held under confirmed manual authority, which the
      // harness scene — room={null} — can never produce).
      expect(edge.getAttribute('data-pop-w')).toBe('44');
      expect(edge.getAttribute('data-pop-dx')).toBe(q.popDx.toFixed(2));
      act(() => {
        fireEvent.pointerDown(edge);
      });
      const pop = el(container, '[data-component="key-popup"]') as HTMLElement;
      expect(pop.style.width).toBe('44px');
      expect(pop.style.height).toBe('48px');
      expect(pop.style.top).toBe('-44px');
      expect(pop.style.fontSize).toBe('26px');
      expect(pop.style.borderRadius).toBe('10px');
      expect(pop.style.transform, 'the row-end balloon must be nudged inward').toContain(
        `${String(q.popDx)}px`,
      );
      act(() => {
        fireEvent.pointerUp(edge);
      });
      // …and an interior key is not nudged at all.
      expect(planKey(ref, 't').popDx).toBe(0);
      const interior = el(container, '[data-key="t"]') as HTMLElement;
      act(() => {
        fireEvent.pointerDown(interior);
      });
      expect((el(container, '[data-component="key-popup"]') as HTMLElement).style.transform).toBe(
        'translateX(calc(-50% + 0px))',
      );
      act(() => {
        fireEvent.pointerUp(interior);
      });
    } finally {
      unmount();
    }
  });

  it('an UNPLANNED key falls back to one visible column, not an invisible zero-width key', () => {
    const m = keyboardMetrics(REF_DEVICE_WIDTH, REF_DEVICE_WIDTH);
    const plan = keyboardPlan({
      layer: 'letters',
      width: REF_DEVICE_WIDTH,
      device: REF_DEVICE_WIDTH,
    });
    expect(keyBasisPx(planKey(plan, '⇧'), m)).toBe(planKey(plan, '⇧').width);
    // ⛔ `plan?.width ?? 0` was the shipped fallback: with `flexShrink: 1` the
    // rest of the row absorbed the space, so a key the plan had no entry for
    // rendered INVISIBLE and nothing overflowed to give it away. One column is
    // wrong in the loud direction — the row over-fills and `data-key-span`
    // (asserted per key above) is absent.
    expect(keyBasisPx(undefined, m)).toBe(m.unit);
    expect(keyBasisPx(undefined, m)).toBeGreaterThan(0);
  });

  it('data-key is the CASED glyph while data-key-id stays the stable identity', () => {
    const { container } = render(<IOSKeyboard room={ROOM} />);
    expect(el(container, '[data-key="a"]').getAttribute('data-key-id')).toBe('a');
    tap(container, '⇧');
    // KeyPlan.id's comment claimed `data-key` was "stable across shift (lowercase
    // canonical)". It is not: the board publishes data-key="A" here, and this
    // file has resolved it that way since the pop-up arm was written — so any
    // instrument that resolves keys by `data-key` with shift on misses every
    // letter. `data-key-id` is the stable one.
    expect(container.querySelector('[data-key="a"]')).toBeNull();
    expect(el(container, '[data-key="A"]').getAttribute('data-key-id')).toBe('a');
  });
});

// ⛔ PRESS STATES. The press flash is a named K1 deliverable that shipped with no
// coverage at all: the only arm mentioning it asserted its ABSENCE on the one key
// that can never carry it (the disabled 😀), so reverting to
// `active:brightness-95` — the darkening flash the device does not do — read
// 43/43 green. And the dark caps-locked shift really was wrong: one pressed
// colour served both key classes, so pressing a near-white locked key went
// markedly DARKER in dark and gave zero feedback in light.
describe('IOSKeyboard — press states (direction, not just difference)', () => {
  it('a live function key carries the iOS press flash, and never a darkening one', () => {
    const { container } = render(<IOSKeyboard room={ROOM} onDismiss={noop} />);
    for (const id of ['123', 'return', '⌫', '⇧', '⌄']) {
      const key = el(container, `[data-key="${CSS.escape(id)}"]`);
      expect(key.className, `${id} press flash`).toContain('active:bg-[var(--kb-fn-press)]');
      expect(key.className, `${id} must not darken`).not.toContain('brightness');
    }
    expect(el(container, '[data-key="q"]').className).toContain('active:bg-[var(--kb-char-press)]');
    expect(el(container, '[data-key="space"]').className).toContain(
      'active:bg-[var(--kb-char-press)]',
    );
  });

  it('the caps-LOCKED shift flashes its OWN colour (a near-white key cannot go lighter)', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      const { container } = render(<IOSKeyboard room={ROOM} />);
      const shiftKey = (): Element => el(container, '[data-key="⇧"]');
      expect(shiftKey().className).toContain('active:bg-[var(--kb-fn-press)]');
      now.mockReturnValue(1000);
      tap(container, '⇧');
      now.mockReturnValue(1000 + DOUBLE_TAP_MS - 1);
      tap(container, '⇧');
      expect(el(container, '[data-component="ios-keyboard"]')).toHaveAttribute(
        'data-shift',
        'locked',
      );
      expect(shiftKey().className).toContain('bg-[var(--kb-fn-locked)]');
      expect(shiftKey().className).toContain('active:bg-[var(--kb-fn-locked-press)]');
      expect(shiftKey().className).not.toContain('active:bg-[var(--kb-fn-press)]');
      const board = el(container, '[data-component="ios-keyboard"]') as HTMLElement;
      expect(board.style.getPropertyValue('--kb-fn-locked-press')).toBe(
        KEYBOARD_PALETTES.light.fnLockedPressed,
      );
    } finally {
      now.mockRestore();
    }
  });

  it('⛔ the press DIRECTION per key class, by relative luminance, in both schemes', () => {
    for (const scheme of ['light', 'dark'] as const) {
      const p = KEYBOARD_PALETTES[scheme];
      // A grey function key is darker than the board and flashes LIGHTER (iOS: a
      // held 123/return goes white on the light keyboard).
      expect(lum(p.fnPressed), `${scheme} fn press lighter`).toBeGreaterThan(lum(p.fnBg));
      expect(lum(p.fnPressed), `${scheme} fn press vs one-shot`).toBeGreaterThan(lum(p.fnActive));
      // The caps-locked highlight is the lightest function state…
      expect(lum(p.fnLocked), `${scheme} locked highlight`).toBeGreaterThan(lum(p.fnBg));
      // …so its press can only go DARKER, and must be visibly different. With one
      // pressed colour for both classes this was a 0.00 delta in light (#ffffff
      // pressed to #ffffff — no feedback) and 0.75 the wrong way in dark.
      expect(lum(p.fnLockedPressed), `${scheme} locked press darker`).toBeLessThan(lum(p.fnLocked));
      expect(
        lum(p.fnLocked) - lum(p.fnLockedPressed),
        `${scheme} locked press visible`,
      ).toBeGreaterThan(0.03);
      expect(p.fnLockedPressed, `${scheme} locked press is its own colour`).not.toBe(p.fnPressed);
      // A character key's press is visible in whichever direction its scheme
      // allows (light: a white key darkens; dark: a mid-grey key lightens).
      expect(Math.abs(lum(p.charPressed) - lum(p.charBg)), `${scheme} char press`).toBeGreaterThan(
        0.03,
      );
    }
    // …and the two schemes really do differ in that direction, so the |…| above
    // is not measuring one case twice.
    expect(lum(KEYBOARD_PALETTES.light.charPressed)).toBeLessThan(
      lum(KEYBOARD_PALETTES.light.charBg),
    );
    expect(lum(KEYBOARD_PALETTES.dark.charPressed)).toBeGreaterThan(
      lum(KEYBOARD_PALETTES.dark.charBg),
    );
  });
});
