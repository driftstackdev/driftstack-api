// Shim for '../../src/lib/livekit' used by the standalone scroll-e2e harness.
//
// The REAL useInputCapture hook imports { sendInputEvent, type InputEvent, type Room }
// from '../../src/lib/livekit'. That module pulls in the full livekit-client SDK (a Room
// class wrapping WebSocket signalling / ICE / DTLS) which we neither have nor want in a
// plain chromium page with no real SFU. esbuild aliases the import to THIS module so the
// REAL converter runs unchanged while sendInputEvent is intercepted: each emitted touch
// event is (1) pushed to window.__dsTouchLog (so the smoke test + the live probe can read
// the produced stream) and (2) forwarded to window.__dsPublishTouch(ev) if present (so the
// live probe can wire it straight to the box's DataChannel). The hook's signature must be
// matched EXACTLY: sendInputEvent(room, event, opts?) -> Promise<void>, called with
// reliable in opts. We ignore `room` (a stub) and `reliable` here; the log records the raw
// InputEvent so the assertions see precisely what the converter decided to emit.

// Minimal structural stand-ins for the types the hook imports. The hook only ever uses
// `Room` as the opaque first arg to sendInputEvent (never reads a field), so an empty
// interface is faithful. InputEvent mirrors the real discriminated union the converter
// produces; we keep it permissive (the converter only emits touchStart/Move/End +
// key/navigate, all of which carry {type} + numeric/string fields).
export interface Room {
  readonly __isShimRoom?: true;
}

export type InputEvent =
  | { type: 'touchStart'; x: number; y: number; touchId: number }
  | { type: 'touchMove'; x: number; y: number; touchId: number }
  | { type: 'touchEnd'; x: number; y: number; touchId: number }
  | { type: 'keyDown'; key: string; modifiers?: readonly string[] }
  | { type: 'keyUp'; key: string; modifiers?: readonly string[] }
  | { type: 'navigate'; url: string }
  | { type: string; [k: string]: unknown };

declare global {
  interface Window {
    __dsTouchLog?: InputEvent[];
    __dsPublishTouch?: (ev: InputEvent) => void;
  }
}

/** Intercepts the converter's per-event publish. Records every emitted InputEvent on
 *  window.__dsTouchLog and forwards it to window.__dsPublishTouch when wired (live probe).
 *  Always resolves (the converter treats this as fire-and-forget). */
export async function sendInputEvent(
  _room: Room,
  event: InputEvent,
  _opts: { reliable?: boolean } = {},
): Promise<void> {
  const w = window;
  if (!Array.isArray(w.__dsTouchLog)) w.__dsTouchLog = [];
  w.__dsTouchLog.push(event);
  try {
    w.__dsPublishTouch?.(event);
  } catch {
    // A live-probe publish failure must never throw back into the converter's event
    // handler (it swallows sendInputEvent rejections, but a synchronous throw from the
    // forward would escape). Swallow it; the log entry is already recorded.
  }
}
