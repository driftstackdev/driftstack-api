// Slice 4 (Wave 29-NNN ARC 3) — Zod schema tests for the InputEvent
// discriminated union. Pins the 12-variant wire contract (7 mouse/key/wheel/ping
// + 5 touch) +
// bounds-checking on coords / button / wheel deltas / key length.

import { describe, expect, it } from 'vitest';
import { InputEventSchema, SendInputEventRequestSchema } from '@driftstack/api-types';

describe('Slice 4 — agent-input-event schema (LK.6 InputEvent wire contract)', () => {
  it('accepts all 12 valid variants (7 mouse/key/wheel/ping + 5 touch)', () => {
    const cases = [
      { type: 'mouseMove', x: 10, y: 20 },
      { type: 'mouseDown', x: 10, y: 20, button: 0 },
      { type: 'mouseDown', x: 10, y: 20, button: 1 },
      { type: 'mouseDown', x: 10, y: 20, button: 2 },
      { type: 'mouseUp', x: 10, y: 20, button: 0 },
      { type: 'keyDown', key: 'Enter' },
      { type: 'keyDown', key: 'a', modifiers: ['cmd', 'shift'] },
      { type: 'keyUp', key: 'Escape' },
      { type: 'wheel', x: 5, y: 5, deltaX: 0, deltaY: 100 },
      { type: 'ping', timestamp: 1_700_000_000 },
      // Touch vocab (founder 2026-06-08 — device-CSS coords).
      { type: 'tap', x: 200, y: 400 },
      { type: 'touchStart', x: 200, y: 400, touchId: 0 },
      { type: 'touchMove', x: 210, y: 405, touchId: 0 },
      { type: 'touchEnd', x: 212, y: 406, touchId: 0 },
      { type: 'touchStart', x: 50, y: 50, touchId: 9 }, // 10-finger cap edge
      { type: 'swipe', x1: 100, y1: 700, x2: 100, y2: 200, durationMs: 350 },
    ];
    for (const c of cases) {
      const parsed = InputEventSchema.safeParse(c);
      expect(parsed.success, `Failed: ${JSON.stringify(c)}`).toBe(true);
    }
  });

  it('rejects touchStart.touchId > 9 (10-finger cap) and missing touchId', () => {
    expect(
      InputEventSchema.safeParse({ type: 'touchStart', x: 1, y: 1, touchId: 10 }).success,
    ).toBe(false);
    expect(InputEventSchema.safeParse({ type: 'touchStart', x: 1, y: 1 }).success).toBe(false);
  });

  it('rejects swipe.durationMs exceeding 60_000 and negative duration', () => {
    expect(
      InputEventSchema.safeParse({ type: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, durationMs: 60_001 })
        .success,
    ).toBe(false);
    expect(
      InputEventSchema.safeParse({ type: 'swipe', x1: 0, y1: 0, x2: 1, y2: 1, durationMs: -1 })
        .success,
    ).toBe(false);
  });

  it('rejects tap with non-integer / out-of-bounds coords', () => {
    expect(InputEventSchema.safeParse({ type: 'tap', x: 1.5, y: 2 }).success).toBe(false);
    expect(InputEventSchema.safeParse({ type: 'tap', x: 100_001, y: 0 }).success).toBe(false);
  });

  it('rejects mouseDown.button = 3 (only 0/1/2 allowed)', () => {
    const parsed = InputEventSchema.safeParse({
      type: 'mouseDown',
      x: 1,
      y: 1,
      button: 3,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects mouseMove with non-integer coords', () => {
    const parsed = InputEventSchema.safeParse({ type: 'mouseMove', x: 1.5, y: 2 });
    expect(parsed.success).toBe(false);
  });

  it('rejects coordinate exceeding MAX_COORD=100_000', () => {
    const parsed = InputEventSchema.safeParse({
      type: 'mouseMove',
      x: 100_001,
      y: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects wheel deltaX exceeding MAX_WHEEL_DELTA=100_000', () => {
    const parsed = InputEventSchema.safeParse({
      type: 'wheel',
      x: 0,
      y: 0,
      deltaX: 100_001,
      deltaY: 0,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects keyDown.key exceeding MAX_KEY_LENGTH=64', () => {
    const parsed = InputEventSchema.safeParse({
      type: 'keyDown',
      key: 'a'.repeat(65),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects keyDown with > 8 modifiers (MAX_MODIFIERS)', () => {
    const parsed = InputEventSchema.safeParse({
      type: 'keyDown',
      key: 'a',
      modifiers: Array.from({ length: 9 }, (_, i) => `mod${i.toString()}`),
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects unknown variant type', () => {
    const parsed = InputEventSchema.safeParse({ type: 'mouseClick', x: 1, y: 1 });
    expect(parsed.success).toBe(false);
  });

  it('accepts negative coords (off-screen drag)', () => {
    const parsed = InputEventSchema.safeParse({
      type: 'mouseMove',
      x: -50,
      y: -50,
    });
    expect(parsed.success).toBe(true);
  });

  it('SendInputEventRequestSchema wraps a valid InputEvent in {event}', () => {
    const parsed = SendInputEventRequestSchema.safeParse({
      event: { type: 'mouseMove', x: 10, y: 20 },
    });
    expect(parsed.success).toBe(true);
  });

  it('SendInputEventRequestSchema rejects missing event field', () => {
    const parsed = SendInputEventRequestSchema.safeParse({
      type: 'mouseMove',
      x: 10,
      y: 20,
    });
    expect(parsed.success).toBe(false);
  });
});
