// LK.6.d — keyboard + mouse capture on the AgentSessionPanel
// video element. Translates browser events to the InputEvent
// JSON schema Agent 1's Mac-side Quartz CGEvent decoder (commit
// 9170da82) accepts, and ships them via the LiveKit DataChannel.
//
// Coordinate translation:
//   - <video> renders the remote stream with object-contain. The
//     video element's bounding rect IS the visible video region;
//     pointer coords are within that rect.
//   - The Mac side expects viewport-space coordinates (the
//     fork's logical px). Convert via
//     `naturalWidth / rect.width` ratio, matching the existing
//     LiveSessionView pattern.
//
// Reliability:
//   - Mouse down/up, key down/up, wheel: reliable=true (must
//     arrive in order; missed events break click logic).
//   - mouseMove: reliable=false (lossy ok — cursor jitter at the
//     remote side is preferable to congesting the data channel
//     when the user moves quickly).
//
// Browser-side event sources:
//   - mousemove / mousedown / mouseup → mouseMove + mouseDown +
//     mouseUp variants.
//   - keydown / keyup → keyDown + keyUp variants. Modifier set
//     captured from event.shiftKey/ctrlKey/altKey/metaKey.
//   - wheel → wheel variant; deltaX + deltaY pass through.
//
// Pointer-capture: when mouseDown fires the capture pointer-
// captures the video element so subsequent mouseMove / mouseUp
// land even when the cursor leaves the element bounds (matches
// remote-desktop UX expectation).

/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any */

import type { RefObject } from 'react';
import { useEffect, useRef } from 'react';
import { sendInputEvent, type InputEvent, type Room } from './livekit';

export interface UseInputCaptureOpts {
  /** The LiveKit room — null when not connected. Capture is a
   *  no-op until a room is present. */
  room: Room | null;
  /** The <video> element receiving the live stream. */
  videoRef: RefObject<HTMLVideoElement>;
  /** Capture toggle. Off by default (subscriber-only viewing); the
   *  parent view flips this when the customer engages "Take
   *  control". */
  enabled: boolean;
}

/** Map a browser pointer event to the video's intrinsic logical
 *  coordinate space. Returns null when the element isn't sized
 *  yet (race on first mount).
 *
 *  Exported (alongside `modifiersFromEvent` and `mouseButton`) so
 *  pure-function unit tests can pin the coordinate math without
 *  spinning up jsdom + a fake LiveKit Room. */
export function pointerToViewport(
  event: PointerEvent | MouseEvent | WheelEvent,
  video: HTMLVideoElement,
): { x: number; y: number } | null {
  const rect = video.getBoundingClientRect();
  if (rect.width === 0 || rect.height === 0) return null;
  const nw = video.videoWidth || rect.width;
  const nh = video.videoHeight || rect.height;
  const x = ((event.clientX - rect.left) / rect.width) * nw;
  const y = ((event.clientY - rect.top) / rect.height) * nh;
  return { x: Math.round(x), y: Math.round(y) };
}

/** Capture the modifier-set from a KeyboardEvent. Returns
 *  undefined when no modifier is held (matches the InputEvent
 *  optional `modifiers` field). */
export function modifiersFromEvent(event: KeyboardEvent): readonly string[] | undefined {
  const mods: string[] = [];
  if (event.shiftKey) mods.push('Shift');
  if (event.ctrlKey) mods.push('Control');
  if (event.altKey) mods.push('Alt');
  if (event.metaKey) mods.push('Meta');
  return mods.length > 0 ? mods : undefined;
}

/** Translate a mouse `button` field (0=left/1=middle/2=right) to
 *  the bounded InputEvent type. Returns null for unsupported
 *  buttons (e.g. back/forward — not yet in the Mac-side decoder). */
export function mouseButton(raw: number): 0 | 1 | 2 | null {
  if (raw === 0 || raw === 1 || raw === 2) return raw;
  return null;
}

/** React hook that wires keyboard + mouse capture to the
 *  AgentSessionPanel's video element. Calls sendInputEvent
 *  asynchronously; rejections are swallowed (input capture is
 *  best-effort and shouldn't throw out of an event handler). */
export function useInputCapture(opts: UseInputCaptureOpts): void {
  const lastSend = useRef<Promise<void>>(Promise.resolve());

  useEffect(() => {
    const { room, videoRef, enabled } = opts;
    if (!enabled || room === null) return;
    const video = videoRef.current;
    if (video === null) return;

    const send = (event: InputEvent, reliable: boolean): void => {
      lastSend.current = sendInputEvent(room, event, { reliable }).catch(() => undefined);
    };

    const onMouseMove = (e: MouseEvent): void => {
      const p = pointerToViewport(e, video);
      if (p === null) return;
      send({ type: 'mouseMove', x: p.x, y: p.y }, false);
    };
    const onMouseDown = (e: MouseEvent): void => {
      const p = pointerToViewport(e, video);
      const button = mouseButton(e.button);
      if (p === null || button === null) return;
      try {
        if ('setPointerCapture' in video && 'pointerId' in e) {
          (video as any).setPointerCapture((e as any).pointerId);
        }
      } catch {
        // Browser may refuse pointer-capture — non-fatal.
      }
      send({ type: 'mouseDown', x: p.x, y: p.y, button }, true);
    };
    const onMouseUp = (e: MouseEvent): void => {
      const p = pointerToViewport(e, video);
      const button = mouseButton(e.button);
      if (p === null || button === null) return;
      send({ type: 'mouseUp', x: p.x, y: p.y, button }, true);
    };
    const onWheel = (e: WheelEvent): void => {
      const p = pointerToViewport(e, video);
      if (p === null) return;
      send({ type: 'wheel', x: p.x, y: p.y, deltaX: e.deltaX, deltaY: e.deltaY }, true);
    };
    const onKeyDown = (e: KeyboardEvent): void => {
      const modifiers = modifiersFromEvent(e);
      send(
        {
          type: 'keyDown',
          key: e.key,
          ...(modifiers !== undefined ? { modifiers } : {}),
        },
        true,
      );
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      const modifiers = modifiersFromEvent(e);
      send(
        {
          type: 'keyUp',
          key: e.key,
          ...(modifiers !== undefined ? { modifiers } : {}),
        },
        true,
      );
    };

    video.addEventListener('mousemove', onMouseMove);
    video.addEventListener('mousedown', onMouseDown);
    video.addEventListener('mouseup', onMouseUp);
    video.addEventListener('wheel', onWheel, { passive: true });
    // Keyboard events go on window so capture works even when the
    // <video> isn't directly focused. Side-effect: the customer can
    // type into the remote browser without first clicking on the
    // video. Trade-off: pressing a key with the panel mounted
    // forwards it everywhere — acceptable because the panel is the
    // only LK consumer in v1.0.
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);

    return () => {
      video.removeEventListener('mousemove', onMouseMove);
      video.removeEventListener('mousedown', onMouseDown);
      video.removeEventListener('mouseup', onMouseUp);
      video.removeEventListener('wheel', onWheel);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, [opts]);
}
