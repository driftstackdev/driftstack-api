// V-820 — nonce cache for fleet-node JWT replay defense (foundation
// slice; production impl is Redis-backed and lands with the
// `/v1/fleet/events` WebSocket route).
//
// `FleetNodeAuthImpl.verify` validates JWT signature + expiry +
// node revocation but cannot, by itself, defeat replay (an attacker
// who captures a valid JWT in its 5-min window can replay it
// arbitrarily). The nonce-cache contract closes that gap:
//   1. Every JWT carries a per-request `nonce` (per
//      docs/network-architecture.md §"What the JWT carries").
//   2. The verifier checks the nonce hasn't been seen for this
//      `nodeId` within the JWT's lifetime.
//   3. If seen → reject as replay; if unseen → record + accept.
//
// Production wires a Redis SET with TTL = JWT lifetime (5 min); the
// in-memory variant here is for tests + dev mode. They share this
// exact interface so the WebSocket route handler never has to know
// which backend it's talking to.
//
// Scope: the cache scopes nonces by `nodeId` (a single nonce value
// MAY be reused across different nodes — they have separate keys
// + separate threat models). Scope-by-(nodeId, nonce) is the
// minimum needed to defeat replay without rejecting legitimate
// per-node nonce-counter resets.

export interface FleetNonceCache {
  /**
   * Returns true if this is the FIRST time the (nodeId, nonce) pair
   * has been seen within the TTL window — and records the pair.
   * Returns false if the pair has been seen (replay attempt).
   *
   * `ttlSeconds` matches the JWT's lifetime; the cache evicts after
   * that so a replay much later isn't flagged (the JWT itself would
   * have expired by then anyway, but defence-in-depth).
   */
  checkAndRecord(nodeId: string, nonce: string, ttlSeconds: number): Promise<boolean>;
}

/**
 * In-memory FleetNonceCache for tests + dev. Each entry's expiry is
 * tracked alongside; periodic-eviction-on-write keeps the map size
 * bounded without a separate timer.
 *
 * Thread-safety: intended for single-threaded use (Node event loop).
 * Concurrent calls for the same key are serialized by the loop;
 * Redis impl in production handles cross-instance contention via
 * SET NX + EXPIRE primitives.
 */
export class InMemoryFleetNonceCache implements FleetNonceCache {
  private entries = new Map<string, number>(); // key → expiresAtMs

  constructor(private readonly clock: () => Date = () => new Date()) {}

  checkAndRecord(nodeId: string, nonce: string, ttlSeconds: number): Promise<boolean> {
    const nowMs = this.clock().getTime();
    this.evictExpired(nowMs);
    const key = nodeId + '\x00' + nonce;
    const existing = this.entries.get(key);
    if (existing !== undefined && existing > nowMs) {
      // Seen within window → replay.
      return Promise.resolve(false);
    }
    this.entries.set(key, nowMs + ttlSeconds * 1000);
    return Promise.resolve(true);
  }

  private evictExpired(nowMs: number): void {
    for (const [k, exp] of this.entries.entries()) {
      if (exp <= nowMs) this.entries.delete(k);
    }
  }

  /** Test/inspection helper — current cache size. */
  size(): number {
    return this.entries.size;
  }
}
