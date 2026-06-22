// Standalone browser entry that mounts the REAL useInputCapture wheel->touch converter
// (apps/gui-client/src/lib/livekit-input-capture.ts) into a plain chromium page, with NO
// GUI app and NO vite dev server. esbuild bundles this (+ React + react-dom + the hook)
// into harness.iife.js; the '../../src/lib/livekit' import the hook makes is aliased to
// ./livekit-shim (see build.mjs) so sendInputEvent is captured instead of hitting a real
// LiveKit Room.
//
// Exposes on window:
//   __dsMountConverter(videoEl?)  mount the converter on a chosen <video> (defaults to a
//                                 stubbed 402x874 element it creates). Returns the element.
//   __dsTouchLog                  the captured InputEvent stream (filled by the shim).
//   __dsFireWheel(deltaX,deltaY)  dispatch a REAL WheelEvent on the bound video element.
//   __dsResetLog()                clear the touch log between gestures.
//
// A caller (smoke.mjs or the live probe) drives realistic wheel events via __dsFireWheel
// and reads __dsTouchLog; the live probe additionally sets window.__dsPublishTouch so each
// emitted touch is published to the box over its DataChannel.

import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { useInputCapture } from '../../apps/gui-client/src/lib/livekit-input-capture';
import type { InputEvent } from './livekit-shim';

// The box's capture dimensions — the 402x874 CSS-point profile (matches the unit tests'
// stubVideo + the live box video track). video-px == element-px (no bar-boxing / scaling).
const CAP_W = 402;
const CAP_H = 874;

declare global {
  interface Window {
    __dsTouchLog?: InputEvent[];
    __dsPublishTouch?: (ev: InputEvent) => void;
    __dsMountConverter?: (el?: HTMLVideoElement) => HTMLVideoElement;
    __dsFireWheel?: (deltaX: number, deltaY: number) => void;
    __dsResetLog?: () => void;
    __dsBoundVideo?: HTMLVideoElement;
  }
}

/** Stub a <video> so getBoundingClientRect / videoWidth / videoHeight report the box's
 *  402x874 capture dims — exactly like the reference unit tests. In a real chromium page a
 *  <video> with no stream has videoWidth/Height 0 and a zero-size rect, which the
 *  converter's pointerToViewport rejects (returns null); the live probe attaches a real
 *  device track so this stub is only for the no-box smoke run, but we apply it uniformly so
 *  the converter always has a valid surface to map against. */
function stubVideo(el: HTMLVideoElement): void {
  el.getBoundingClientRect = () =>
    ({
      left: 0,
      top: 0,
      width: CAP_W,
      height: CAP_H,
      right: CAP_W,
      bottom: CAP_H,
      x: 0,
      y: 0,
      toJSON() {
        return {};
      },
    }) as DOMRect;
  Object.defineProperty(el, 'videoWidth', { value: CAP_W, configurable: true });
  Object.defineProperty(el, 'videoHeight', { value: CAP_H, configurable: true });
}

/** A tiny component that wires the REAL hook to the given element. room is a non-null stub
 *  ({}) so the effect's `room === null` guard passes; enabled=true binds the wheel/mouse/
 *  keyboard listeners on mount. */
function Converter({ video }: { video: HTMLVideoElement }): null {
  // The hook's Room type is the shim's structural interface; {} satisfies it (the hook
  // never reads a Room field — it only forwards it to the shimmed sendInputEvent).
  useInputCapture({ room: {} as never, videoElement: video, enabled: true });
  return null;
}

function mountConverter(el?: HTMLVideoElement): HTMLVideoElement {
  const video = el ?? document.createElement('video');
  if (!video.isConnected) {
    video.id = video.id || 'harness-video';
    document.body.appendChild(video);
  }
  stubVideo(video);
  window.__dsBoundVideo = video;
  if (!Array.isArray(window.__dsTouchLog)) window.__dsTouchLog = [];

  // Mount React into a detached host (the converter renders nothing visible).
  const host = document.createElement('div');
  host.style.display = 'none';
  document.body.appendChild(host);
  createRoot(host).render(createElement(Converter, { video }));
  return video;
}

window.__dsMountConverter = mountConverter;
window.__dsResetLog = (): void => {
  window.__dsTouchLog = [];
};
window.__dsFireWheel = (deltaX: number, deltaY: number): void => {
  const video = window.__dsBoundVideo;
  if (!video)
    throw new Error('__dsFireWheel: converter not mounted (call __dsMountConverter first)');
  // clientX/Y at the video centre so pointerToViewport maps inside the surface. A real
  // WheelEvent (bubbles) on the bound element drives the hook's onWheel exactly as a
  // trackpad would.
  video.dispatchEvent(
    new WheelEvent('wheel', {
      clientX: CAP_W / 2,
      clientY: CAP_H / 2,
      deltaX,
      deltaY,
      bubbles: true,
    }),
  );
};

// Auto-mount on a pre-existing #harness-video if the page provided one; otherwise the
// caller invokes __dsMountConverter explicitly.
const pre = document.getElementById('harness-video');
if (pre instanceof HTMLVideoElement) mountConverter(pre);
