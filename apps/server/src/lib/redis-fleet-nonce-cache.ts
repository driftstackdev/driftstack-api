// Redis-backed FleetNodeAuth replay-defense nonce cache (production).
//
// The InMemoryFleetNonceCache in services/fleet-nonce-cache.ts covers tests +
// single-instance dev; production needs Redis so the (iss, nonce) replay window
// is shared across control-plane instances and survives restarts. Wired into the
// /v1/fleet/events WSS handler's FleetNodeAuthImpl so a captured fleet-node JWT
// can't be replayed within its 5-min lifetime even across instances.
//
// Atomicity: a single `SET key value NX EX ttl`. NX = set-iff-absent, so the
// command itself is the check-and-record — first caller for a given key gets
// 'OK' (first sight → record), any concurrent/later caller within the TTL gets
// null (already present → replay). No read-then-write race (same principle as
// RedisRateLimitStore's single-command atomicity).

import type { Redis } from 'ioredis';
import type { FleetNonceCache } from '../services/fleet-nonce-cache.js';

const KEY_PREFIX = 'fleet-nonce:';

export class RedisFleetNonceCache implements FleetNonceCache {
  constructor(private readonly redis: Redis) {}

  async checkAndRecord(nodeId: string, nonce: string, ttlSeconds: number): Promise<boolean> {
    // NUL separator: nodeId is a uuid (no NUL) so (nodeId, nonce) can't collide
    // with a different pair even if an attacker crafts a nonce containing the
    // separator — same defense as the in-memory variant + the recapture dedupKey.
    const key = `${KEY_PREFIX}${nodeId}\x00${nonce}`;
    // Redis EX requires a positive integer; the verifier passes max(1, exp-now)
    // but clamp defensively so a 0/negative TTL can't throw or set a non-expiring
    // key (which would pin a nonce forever).
    const ttl = Math.max(1, Math.floor(ttlSeconds));
    // SET ... NX EX ttl → 'OK' when newly set (first sight), null when the key
    // already exists (replay).
    const res = await this.redis.set(key, '1', 'EX', ttl, 'NX');
    return res === 'OK';
  }
}
