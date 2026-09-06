// P-26 — what survives a discarded tab activation, so a slow switch still leaves
// a number in the dev-log.
//
// The simulator gives up on an unacked tab switch after
// ACTIVATE_ACK_TIMEOUT_MS × ACTIVATE_MAX_ATTEMPTS = 3600 ms and discards the
// activation record. Everything the instruments need — when the switch began,
// how many attempts it took, whether any ack was ever seen — lived on that
// record, so the switches worth measuring were exactly the ones that left
// nothing behind. A3's fleet-box canary acked at 102,431 ms and the dev-log has
// no line for it.
//
// A tombstone keeps that handful of fields after the record is gone. It is
// BOUNDED on purpose: an instrument that grows without limit on a wedged session
// is a leak wearing a measurement's clothes, which is the same defect class P-28
// bounded on the publish path.

export interface DiscardedActivation {
  tabId: string;
  startedAt: number;
  attempts: number;
  ackSeen: boolean;
}

/** Tombstones retained for late acks. The oldest entry is the least likely to
 *  still be waiting on a reply, so eviction is insertion-ordered. */
export const MAX_ACTIVATION_TOMBSTONES = 64;

/**
 * Record `value` under `key`, evicting oldest-first past the bound.
 *
 * Re-inserting an existing key refreshes its position: a requestId written again
 * is the most recent thing we know about, and evicting it next would drop the
 * entry most likely to still matter.
 */
export function rememberDiscardedActivation(
  map: Map<string, DiscardedActivation>,
  key: string,
  value: DiscardedActivation,
): void {
  map.delete(key);
  map.set(key, value);
  while (map.size > MAX_ACTIVATION_TOMBSTONES) {
    const oldest = map.keys().next();
    if (oldest.done === true) break;
    map.delete(oldest.value);
  }
}
