// LK.6.d pure-function tests — pointerToViewport + modifiersFromEvent +
// mouseButton. The useInputCapture React hook is harder to exercise
// without a full jsdom + LiveKit Room mock; the three pure helpers
// underneath it are testable in isolation. Pins:
//
//   pointerToViewport
//     - null when the <video> has zero width/height (race on mount)
//     - converts client coords into the per-archetype captured-frame logical device
//       frame (the `logical` arg = videoW/dpr × videoH/dpr per device; 402×874 only
//       as the pre-stream fallback default), object-contain-aware: maps against the
//       contained sub-rect (logicalWidth / displayedWidth ratio), so aspect-mismatched
//       (letterboxed / pillarboxed) streams map correctly
//     - null for clicks in the letterbox / pillarbox bars (off-surface)
//     - DOWNSCALE-INVARIANT: the sent coords do NOT depend on video.videoWidth/
//       Height, so an SFU-throttled (downscaled) track maps identically to a
//       full-res one (the founder tap-offset fix, A3 W2811)
//     - PER-ARCHETYPE: passing a device's `logical` dims maps to that device's space
//       (content-only fork A3 84de32ad4d — the captured video is the web content
//       edge-to-edge, sized per archetype)
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
    // The object-contain math is verified at arbitrary stream sizes by passing an
    // explicit `logical` size — these tests pin that math, not the device default.
    // (Production calls `pointerToViewport(e, video)` and gets the fixed 402×874
    // logical frame; see the separate "downscale invariance" block below.)
    it('returns null when the <video> has zero width (mount race)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 0, height: 480 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(100, 100);
      expect(pointerToViewport(event, video, { width: 640, height: 480 })).toBeNull();
    });

    it('returns null when the <video> has zero height (mount race)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 640, height: 0 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(100, 100);
      expect(pointerToViewport(event, video, { width: 640, height: 480 })).toBeNull();
    });

    it('returns null for non-finite pointer, element, or logical geometry', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 640, height: 480 },
        videoWidth: 640,
        videoHeight: 480,
      });
      expect(
        pointerToViewport(fakeMouseEvent(Number.NaN, 100), video, { width: 640, height: 480 }),
      ).toBeNull();
      expect(
        pointerToViewport(fakeMouseEvent(100, 100), video, { width: Number.NaN, height: 480 }),
      ).toBeNull();

      const invalidRectVideo = fakeVideo({
        rect: { left: Number.NaN, top: 0, width: 640, height: 480 },
        videoWidth: 640,
        videoHeight: 480,
      });
      expect(
        pointerToViewport(fakeMouseEvent(100, 100), invalidRectVideo, {
          width: 640,
          height: 480,
        }),
      ).toBeNull();
    });

    it('maps client coords into the logical px frame (1:1 when rect matches logical size)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 640, height: 480 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(120, 240);
      expect(pointerToViewport(event, video, { width: 640, height: 480 })).toEqual({
        x: 120,
        y: 240,
      });
    });

    it('scales coords up when rect is smaller than the logical size (CSS-downscaled element)', () => {
      // 320x240 element showing a 640x480 logical frame — coords scale 2×.
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 320, height: 240 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(100, 100);
      // (100/320)*640 = 200; (100/240)*480 = 200.
      expect(pointerToViewport(event, video, { width: 640, height: 480 })).toEqual({
        x: 200,
        y: 200,
      });
    });

    it('accounts for rect.left/top offset (video not at viewport origin)', () => {
      const video = fakeVideo({
        rect: { left: 50, top: 30, width: 640, height: 480 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(150, 130);
      // Relative-to-element: 100x100 → 100x100 (1:1).
      expect(pointerToViewport(event, video, { width: 640, height: 480 })).toEqual({
        x: 100,
        y: 100,
      });
    });

    it('rounds non-integer ratios to nearest integer (Mac decoder needs ints)', () => {
      // 360x270 element showing a 640x480 logical frame — non-integer ratio.
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 360, height: 270 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(123, 87);
      const result = pointerToViewport(event, video, { width: 640, height: 480 });
      expect(result).not.toBeNull();
      expect(Number.isInteger(result?.x ?? 0.5)).toBe(true);
      expect(Number.isInteger(result?.y ?? 0.5)).toBe(true);
      // Math: (123/360)*640 = 218.666… → 219; (87/270)*480 = 154.666… → 155.
      expect(result).toEqual({ x: 219, y: 155 });
    });

    // #7 — object-contain letterbox/pillarbox awareness. The <video> fills
    // its container (w-full h-full); when the logical aspect differs from the
    // element aspect the stream is bar-boxed, so the element rect is NOT the
    // displayed video. Map against the contained sub-rect + ignore clicks in
    // the bars (return null). All the matched-aspect cases above are
    // unaffected (offsets are zero when the aspects are equal).

    it('letterbox (logical wider than element → top/bottom bars): maps an on-video click against the contained sub-rect, not the full rect', () => {
      // 640x480 (4:3) logical in a 600x600 (square) element → fills width
      // 600, displayed height 600/(640/480)=450, 75px bars top+bottom.
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 600, height: 600 },
        videoWidth: 640,
        videoHeight: 480,
      });
      const event = fakeMouseEvent(300, 150);
      // x=(300/600)*640=320; y=((150-75)/450)*480=80. (Naive full-rect math
      // would give y=(150/600)*480=120 — the latent bug this fixes.)
      expect(pointerToViewport(event, video, { width: 640, height: 480 })).toEqual({
        x: 320,
        y: 80,
      });
    });

    it('letterbox: returns null for a click in the top bar (off-surface)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 600, height: 600 },
        videoWidth: 640,
        videoHeight: 480,
      });
      // clientY=30 is within the 75px top bar → no video there.
      expect(
        pointerToViewport(fakeMouseEvent(300, 30), video, { width: 640, height: 480 }),
      ).toBeNull();
    });

    it('letterbox: returns null for a click in the bottom bar (off-surface)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 600, height: 600 },
        videoWidth: 640,
        videoHeight: 480,
      });
      // Video ends at 75+450=525; clientY=570 is in the bottom bar.
      expect(
        pointerToViewport(fakeMouseEvent(300, 570), video, { width: 640, height: 480 }),
      ).toBeNull();
    });

    it('pillarbox (logical taller than element → left/right bars): maps an on-video click against the contained sub-rect', () => {
      // 480x640 (portrait) logical in an 800x600 element → fills height 600,
      // displayed width 600*(480/640)=450, 175px bars left+right.
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 800, height: 600 },
        videoWidth: 480,
        videoHeight: 640,
      });
      const event = fakeMouseEvent(300, 300);
      // x=((300-175)/450)*480=133.33→133; y=(300/600)*640=320.
      expect(pointerToViewport(event, video, { width: 480, height: 640 })).toEqual({
        x: 133,
        y: 320,
      });
    });

    it('pillarbox: returns null for clicks in the left and right bars (off-surface)', () => {
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 800, height: 600 },
        videoWidth: 480,
        videoHeight: 640,
      });
      // 175px bars: clientX=50 is in the left bar; 750 is in the right bar
      // (video spans 175..625).
      expect(
        pointerToViewport(fakeMouseEvent(50, 300), video, { width: 480, height: 640 }),
      ).toBeNull();
      expect(
        pointerToViewport(fakeMouseEvent(750, 300), video, { width: 480, height: 640 }),
      ).toBeNull();
    });
  });

  // The founder's intermittent "taps land above where I tap, then it's normal
  // again" (2026-06-23), root-caused with A3 (W2811): the Mac touch injector
  // addresses a FIXED 402×874 device-CSS-px frame, but pointerToViewport used to
  // scale by video.videoWidth/videoHeight — and the SFU REMB-DOWNSCALES the
  // published track under bandwidth pressure (e.g. 402×874 → ~201×437). On a
  // throttle every coordinate halved, so a tap landed at ~half the intended
  // x/y = high-and-left, snapping back when the track recovered. The fix maps
  // against the fixed logical frame (the default `logical` arg), so the SENT
  // coords are identical no matter what resolution the <video> element currently
  // reports. These pins lock that invariance so the regression can't return.
  describe('downscale invariance (founder tap-offset / A3 W2811)', () => {
    // A 402×874 element whose <video> intrinsic size is whatever the SFU sent.
    const iphoneEl = (videoWidth: number, videoHeight: number): HTMLVideoElement =>
      fakeVideo({
        rect: { left: 0, top: 0, width: 402, height: 874 },
        videoWidth,
        videoHeight,
      });
    const click = fakeMouseEvent(201, 437); // dead-centre of the 402×874 frame

    it('maps to the fixed 402×874 frame at FULL track resolution (default logical)', () => {
      expect(pointerToViewport(click, iphoneEl(402, 874))).toEqual({ x: 201, y: 437 });
    });

    it('maps to the SAME coords when the SFU has downscaled the track to ~half (the bug)', () => {
      // Pre-fix this produced ~{x:100,y:218} (halved) → tap lands high-and-left.
      // With the fixed logical frame it is identical to full-res.
      expect(pointerToViewport(click, iphoneEl(201, 437))).toEqual({ x: 201, y: 437 });
    });

    it('maps to the SAME coords even before the track is sized (videoWidth=0)', () => {
      // No reliance on the track px at all → no first-mount race either.
      expect(pointerToViewport(click, iphoneEl(0, 0))).toEqual({ x: 201, y: 437 });
    });

    it('is invariant across a sweep of SFU downscale levels for an edge tap', () => {
      const edge = fakeMouseEvent(402, 874); // bottom-right corner
      for (const [w, h] of [
        [402, 874],
        [320, 696],
        [201, 437],
        [120, 261],
      ]) {
        expect(pointerToViewport(edge, iphoneEl(w, h))).toEqual({ x: 402, y: 874 });
      }
    });
  });

  // Per-archetype content-only mapping (A3 84de32ad4d, box mac-macstadium-us-001):
  // the captured video is the web content edge-to-edge, sized PER archetype, so the
  // touch injector addresses each device's captured-frame logical space (= screen_width
  // × inner_height ÷ dpr). The simulator threads those dims via the `logical` arg
  // (videoW/dpr × videoH/dpr from the first full-res frame). These pins lock that a
  // per-archetype `logical` maps correctly AND stays SFU-downscale-invariant for each
  // device — the founder's "coords went off after the per-archetype size change" class.
  describe('per-archetype content-only mapping (A3 84de32ad4d)', () => {
    // Each archetype's captured-frame LOGICAL dims (= screen_width × inner_height),
    // per A3's dims (16pro 402×714, 14promax 430×739, 13pro 390×699) — the content-only
    // web viewport the injector now targets. The <video> element fills its (logical-
    // aspect) container; intrinsic px = logical × dpr but the SFU may downscale it.
    const cases = [
      { name: 'iphone16pro', w: 402, h: 714 },
      { name: 'iphone14promax', w: 430, h: 739 },
      { name: 'iphone13pro', w: 390, h: 699 },
    ];

    for (const { name, w, h } of cases) {
      it(`${name}: dead-centre maps to the per-archetype logical centre`, () => {
        // Element sized to the logical aspect (the simulator window matches the
        // capture-profile aspect → no letterbox). Centre click → centre coords.
        const video = fakeVideo({
          rect: { left: 0, top: 0, width: w, height: h },
          videoWidth: w * 3, // full-res capture px (dpr 3)
          videoHeight: h * 3,
        });
        const centre = fakeMouseEvent(w / 2, h / 2);
        expect(pointerToViewport(centre, video, { width: w, height: h })).toEqual({
          x: Math.round(w / 2),
          y: Math.round(h / 2),
        });
      });

      it(`${name}: bottom-right edge maps to the per-archetype max coords (no 402×874 hardcode)`, () => {
        const video = fakeVideo({
          rect: { left: 0, top: 0, width: w, height: h },
          videoWidth: w * 3,
          videoHeight: h * 3,
        });
        const edge = fakeMouseEvent(w, h);
        expect(pointerToViewport(edge, video, { width: w, height: h })).toEqual({ x: w, y: h });
      });

      it(`${name}: is SFU-downscale-invariant (same coords as the track is throttled)`, () => {
        // The element keeps its logical-aspect size; only the intrinsic track px shrink.
        // Coords must NOT depend on videoWidth/videoHeight (A3 W2811) — passing the same
        // per-archetype `logical` at every downscale level yields identical coords.
        const edge = fakeMouseEvent(w, h);
        for (const k of [1, 0.8, 0.5, 0.3]) {
          const video = fakeVideo({
            rect: { left: 0, top: 0, width: w, height: h },
            videoWidth: Math.round(w * 3 * k),
            videoHeight: Math.round(h * 3 * k),
          });
          expect(pointerToViewport(edge, video, { width: w, height: h })).toEqual({ x: w, y: h });
        }
      });
    }

    it('the same element + pixel maps DIFFERENTLY per `logical` (proves the per-archetype dims drive the map, not the old hardcode)', () => {
      // Use a SQUARE element so neither logical aspect bar-boxes the same edge out of
      // range: a click on the displayed sub-rect maps to each logical frame's own max.
      // A square 600×600 element: the 390×699 frame pillarboxes (taller), the 402×874
      // frame pillarboxes more — but the dead-centre always lands on-surface for both,
      // and the centre coord is each frame's own (w/2, h/2), which differ per archetype.
      const video = fakeVideo({
        rect: { left: 0, top: 0, width: 600, height: 600 },
        videoWidth: 1170,
        videoHeight: 2097,
      });
      const centre = fakeMouseEvent(300, 300);
      const thirteenPro = pointerToViewport(centre, video, { width: 390, height: 699 });
      const oldDefault = pointerToViewport(centre, video); // 402×874 default
      expect(thirteenPro).toEqual({ x: 195, y: 350 }); // (390/2, round(699/2))
      expect(oldDefault).toEqual({ x: 201, y: 437 }); // (402/2, 874/2)
      expect(thirteenPro).not.toEqual(oldDefault);
    });
  });

  describe('modifiersFromEvent', () => {
    it('returns undefined when NO modifier is held (matches optional field on InputEvent)', () => {
      expect(modifiersFromEvent(fakeKeyEvent({}))).toBeUndefined();
    });

    // 2026-05-20 — Mac-native vocabulary lock. Prior cycle this used
    // DOM-standard Shift/Control/Alt/Meta names which forced the
    // harness to remap Meta → Command on every key press; aligned
    // here to cmd/ctrl/shift/option (1:1 Quartz CGEventFlags) +
    // matches the customer-dashboard ManualControlOverlay inline
    // copy. Both surfaces now send the same wire vocabulary.

    it('returns ["shift"] alone', () => {
      expect(modifiersFromEvent(fakeKeyEvent({ shift: true }))).toEqual(['shift']);
    });

    it('returns ["ctrl"] alone', () => {
      expect(modifiersFromEvent(fakeKeyEvent({ ctrl: true }))).toEqual(['ctrl']);
    });

    it('returns ["option"] alone (alt/option on Mac)', () => {
      expect(modifiersFromEvent(fakeKeyEvent({ alt: true }))).toEqual(['option']);
    });

    it('returns ["cmd"] alone (Meta on DOM = Command on Mac)', () => {
      expect(modifiersFromEvent(fakeKeyEvent({ meta: true }))).toEqual(['cmd']);
    });

    it('emits modifiers in canonical cmd→ctrl→shift→option order, regardless of held combo', () => {
      // All 4 held — pin the deterministic order so the Mac-side
      // decoder receives a stable shape across runs.
      expect(
        modifiersFromEvent(fakeKeyEvent({ shift: true, ctrl: true, alt: true, meta: true })),
      ).toEqual(['cmd', 'ctrl', 'shift', 'option']);
      // Ctrl + Meta only — order preserved.
      expect(modifiersFromEvent(fakeKeyEvent({ ctrl: true, meta: true }))).toEqual(['cmd', 'ctrl']);
      // Shift + Alt only — order preserved.
      expect(modifiersFromEvent(fakeKeyEvent({ shift: true, alt: true }))).toEqual([
        'shift',
        'option',
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
