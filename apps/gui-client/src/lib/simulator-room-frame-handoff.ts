// The hand-off of room frames between the Simulator's data-channel listeners.
//
// The window listens to the phone's room with one listener per manual-input
// authority epoch: each listener applies frames under the epoch it was
// subscribed for, and turns inert once the epoch moves on. The epoch moves
// SYNCHRONOUSLY (a control read lands, a capability report changes), but the
// next listener is subscribed only when React commits that change — a render
// and a passive effect later. A frame the phone sends in between reaches the
// old listener, which can no longer apply it, while the new one is not yet
// there to hear it. Dropping it lost exactly the frames that arrive at those
// moments: the tab restore that comes with the first control, and the focus
// report for the field the customer just tapped — which the phone sends once,
// so the keyboard stayed down until a second tap.
//
// So the old listener HOLDS such a frame for the listener of the same session
// and room, and that listener applies the held frames, in order, as it
// subscribes — before anything newer can reach it. A frame held for a room or
// session the window has since left is discarded, as it always was.

/** Frames waiting for the next listener of one session's room. */
export interface HeldRoomFrames<R> {
  sessionId: string;
  room: R;
  payloads: Uint8Array[];
}

/** A generous bound on one hand-off: the gap is a render long, so hitting it
 *  means no listener is coming. The oldest frames go first. */
export const HELD_ROOM_FRAMES_MAX = 256;

/** Hold `payload` for the next listener of `sessionId`'s `room`. */
export function holdRoomFrame<R>(
  held: HeldRoomFrames<R> | null,
  sessionId: string,
  room: R,
  payload: Uint8Array,
): HeldRoomFrames<R> {
  const payloads =
    held !== null && held.sessionId === sessionId && held.room === room ? held.payloads : [];
  // The transport owns the buffer it delivered; keep a copy.
  payloads.push(payload.slice());
  if (payloads.length > HELD_ROOM_FRAMES_MAX) payloads.shift();
  return { sessionId, room, payloads };
}

/** The frames held for `sessionId`'s `room`, oldest first — none for any
 *  other room or session. */
export function heldRoomFramesFor<R>(
  held: HeldRoomFrames<R> | null,
  sessionId: string,
  room: R,
): Uint8Array[] {
  if (held === null || held.sessionId !== sessionId || held.room !== room) return [];
  return held.payloads;
}
