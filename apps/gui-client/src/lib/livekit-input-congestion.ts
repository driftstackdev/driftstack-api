/** Room-scoped reliable-input congestion state shared by the capture hook and every
 * command wrapper that publishes on the same ordered LiveKit data channel. WeakMap
 * ownership means a torn-down Room is never retained merely for health bookkeeping.
 *
 * ⛔ THIS LATCH USED TO HAVE NO WAY OUT, AND THAT WAS THE CUSTOMER'S "FREEZE".
 * It was set on `DCBufferStatusChanged(isLow=false)` and cleared on either the
 * matching low crossing or a room reconnect — both EVENTS. If the buffer never
 * drained (the far end wedged, which is the case that congests it in the first
 * place) and LiveKit emitted no Reconnected, nothing ever cleared it. Every
 * reliable input then threw for the life of the room: reported as "one freeze
 * and nothing works anymore, not a single input, not a single new URL, and it
 * never picks up."
 *
 * So congestion is now a TIMESTAMP, not a flag, and the read is level-triggered
 * against a deadline. It expires on its own with no timer, no watchdog task and
 * nothing to leak — a stuck channel degrades to "publish and let it fail", which
 * is strictly better than refusing forever. Backpressure is a short-term
 * optimisation; permanent backpressure is an outage.
 */

/** How long a congestion signal may suppress input before it is treated as
 *  stale. Sized against the receipt deadline (~5s) and the reconnect window: a
 *  channel that has not drained in this long is not congested, it is wedged, and
 *  refusing the user's input is no longer helping them. */
export const CONGESTION_MAX_AGE_MS = 10_000;

/** Onset time per room. A WeakMap so a destroyed Room is collectable. */
const congestedSince = new WeakMap<object, number>();

export class ReliableInputCongestedError extends Error {
  constructor() {
    super('The reliable input channel is congested');
    this.name = 'ReliableInputCongestedError';
  }
}

export function setReliableInputCongested(
  room: object,
  congested: boolean,
  now: number = Date.now(),
): void {
  if (congested) {
    // Do NOT restamp an already-congested room. Re-arming on every repeat
    // high-water event would let a chatty channel push the deadline forward
    // indefinitely and recreate the unbounded latch this replaced.
    if (!congestedSince.has(room)) congestedSince.set(room, now);
  } else {
    congestedSince.delete(room);
  }
}

export function isReliableInputCongested(room: object, now: number = Date.now()): boolean {
  const since = congestedSince.get(room);
  if (since === undefined) return false;
  if (now - since >= CONGESTION_MAX_AGE_MS) {
    // Expire on read. The room is left un-congested so the next publish is
    // attempted rather than refused; if the channel really is still full, the
    // publish fails on its own terms with a real error the caller can report.
    congestedSince.delete(room);
    return false;
  }
  return true;
}

/** Test/diagnostic view: how long this room has been congested, or null. */
export function reliableInputCongestedForMs(room: object, now: number = Date.now()): number | null {
  const since = congestedSince.get(room);
  return since === undefined ? null : now - since;
}
