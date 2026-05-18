// LK.6.d pure-function tests — pointerToViewport + modifiersFromEvent +
// mouseButton. The useInputCapture React hook is harder to exercise
// without a full jsdom + LiveKit Room mock; the three pure helpers
// underneath it are testable in isolation. Pins:
//
//   pointerToViewport
//     - null when the <video> has zero width/height (race on mount)
//     - converts client coords into the video's intrinsic px space
//       (naturalWidth / rect.width ratio)
//     - falls back to rect dimensions when videoWidth/Height are 0
//       (pre-track-subscribed state)
//     - rounds to nearest integer (Mac-side decoder expects ints)
//
//   modifiersFromEvent
//     - returns undefined when NO modifier is held (matches the
//       optional `modifiers` field on the InputEvent JSON shape)
//     - returns the canonical 4-name set (Shift / Control / Alt /
//       Meta) in fixed order so the Mac-side decoder receives
//       deterministic ordering
//     - any combination of the 4 holds
//
//   mouseButton
//     - 0 / 1 / 2 are passed through (left / middle / right)
//     - 3, 4 (back / forward) + anything outside [0,2] returns null

import { describe, expect, it } from 'vitest';
import {
  mouseButton,
  modifiersFromEvent,
  pointerToViewport,
} from '../../src/lib/livekit-input-capture';

function fakeVideo(opts: {
  rect: { left: number; top: number; width: number; height: number };
  videoWidth: number;
  videoHeight: number;
}): HTMLVideoElement {
  return {
    getBoundingClientRect: () => ({
      left: opts.rect.left,
      top: opts.rect.top,
      width: opts.rect.width,
      height: opts.rect.height,
      right: opts.rect.left + opts.rect.width,
      bottom: opts.rect.top + opts.rect.height,
      x: opts.rect.left,
      y: opts.rect.top,
      toJSON() {
        return this;
      },
    }),
    videoWidth: opts.videoWidth,
    videoHeight: opts.videoHeight,
  } as unknown as HTMLVideoElement;
}

function fakeMouseEvent(clientX: number, clientY: number): MouseEvent {
  return { clientX, clientY } as MouseEvent;
}

function fakeKeyEvent(opts: {
  shift?: boolean;
  ctrl?: boolean;
  alt?: boolean;
  meta?: boolean;
}): KeyboardEvent {
  return {
    shiftKey: opts.shift ?? false,
    ctrlKey: opts.ctrl ?? false,
    altKey: opts.alt ?? false,
    metaKey: opts.meta ?? false,
  } as KeyboardEvent;
}

describe('LK.6.d pure-function tests', () => {
  describe('pointerToViewport', () => {
    it('returns null when the <video> has zero width (mount race)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 0, height: 480 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(100, 100);
      expect(pointerToViewport(event, video)).toBeNull();
    });

    it('returns null when the <video> has zero height (mount race)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 640, height: 0 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(100, 100);
      expect(pointerToViewport(event, video)).toBeNull();
    });

    it('maps client coords into video intrinsic px (1:1 when rect matches natural size)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 640, height: 480 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(120, 240);
      expect(pointerToViewport(event, video)).toEqual({ x: 120, y: 240 });
    });

    it('scales coords up when rect is smaller than natural (CSS-downscaled video)', () => {
      // 320x240 rendered at 640x480 natural — coords scale 2×.
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 320, height: 240 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(100, 100);
      // (100/320)*640 = 200; (100/240)*480 = 200.
      expect(pointerToViewport(event, video)).toEqual({ x: 200, y: 200 });
    });

    it('accounts for rect.left/top offset (video not at viewport origin)', () => {
      const video = fakeVideo({
        rect: { left: 50, top: 30, width: 640, height: 480 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(150, 130);
      // Relative-to-element: 100x100 → 100x100 (1:1).
      expect(pointerToViewport(event, video)).toEqual({ x: 100, y: 100 });
    });

    it('falls back to rect dimensions when videoWidth/Height are 0 (pre-track-subscribed)', () => {
      // Before any track is subscribed, videoWidth/Height read as 0.
      // Coords should pass through at rect scale (no division by zero).
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 640, height: 480 },
        videoWidth: 0,
        videoHeight: 0,
      });
      const event = fakeMouseEvent(120, 240);
      expect(pointerToViewport(event, video)).toEqual({ x: 120, y: 240 });
    });

    it('rounds non-integer ratios to nearest integer (Mac decoder needs ints)', () => {
      // 360x270 rendered at 640x480 natural — non-integer ratio.
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 360, height: 270 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(123, 87);
      const result = pointerToViewport(event, video);
      expect(result).not.toBeNull();
      expect(Number.isInteger(result?.x ?? 0.5)).toBe(true);
      expect(Number.isInteger(result?.y ?? 0.5)).toBe(true);
      // Math: (123/360)*640 = 218.666… → 219; (87/270)*480 = 154.666… → 155.
      expect(result).toEqual({ x: 219, y: 155 });
    });
  });

  describe('modifiersFromEvent', () => {
    it('returns undefined when NO modifier is held (matches optional field on InputEvent)', () => {
      expect(modifiersFromEvent(fakeKeyEvent({}))).toBeUndefined();
    });

    it('returns ["Shift"] alone', () => {
      expect(modifiersFromEvent(fakeKeyEvent({ shift: true }))).toEqual(['Shift']);
    });

    it('returns ["Control"] alone', () => {
      expect(modifiersFromEvent(fakeKeyEvent({ ctrl: true }))).toEqual(['Control']);
    });

    it('returns ["Alt"] alone', () => {
      expect(modifiersFromEvent(fakeKeyEvent({ alt: true }))).toEqual(['Alt']);
    });

    it('returns ["Meta"] alone (cmd on macOS, win-key on Windows)', () => {
      expect(modifiersFromEvent(fakeKeyEvent({ meta: true }))).toEqual(['Meta']);
    });

    it('emits modifiers in canonical Shift→Control→Alt→Meta order, regardless of held combo', () => {
      // All 4 held — pin the deterministic order so the Mac-side
      // decoder receives a stable shape across runs.
      expect(
        modifiersFromEvent(fakeKeyEvent({ shift: true, ctrl: true, alt: true, meta: true })),
      ).toEqual(['Shift', 'Control', 'Alt', 'Meta']);
      // Ctrl + Meta only — order preserved.
      expect(modifiersFromEvent(fakeKeyEvent({ ctrl: true, meta: true }))).toEqual([
        'Control',
        'Meta',
      ]);
      // Shift + Alt only — order preserved.
      expect(modifiersFromEvent(fakeKeyEvent({ shift: true, alt: true }))).toEqual([
        'Shift',
        'Alt',
      ]);
    });
  });

  describe('mouseButton', () => {
    it('passes through 0 (left button)', () => {
      expect(mouseButton(0)).toBe(0);
    });

    it('passes through 1 (middle button)', () => {
      expect(mouseButton(1)).toBe(1);
    });

    it('passes through 2 (right button)', () => {
      expect(mouseButton(2)).toBe(2);
    });

    it('returns null for 3 (back button) — not yet in Mac decoder', () => {
      expect(mouseButton(3)).toBeNull();
    });

    it('returns null for 4 (forward button) — not yet in Mac decoder', () => {
      expect(mouseButton(4)).toBeNull();
    });

    it('returns null for negative values (defensive)', () => {
      expect(mouseButton(-1)).toBeNull();
    });

    it('returns null for non-integer values (defensive)', () => {
      // Even though browsers should never emit fractional button
      // codes, the type accepts `number`, so we defensively reject.
      expect(mouseButton(0.5)).toBeNull();
    });
  });
});
