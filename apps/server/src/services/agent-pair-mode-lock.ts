// Arc 2 sub-slice 8.8 (v2-#8 AI chat + manual side-by-side).
//
// Redis-backed lock for pair-mode takeover contention. Founder
// verdict Q4=A LOCKED 2026-05-18: route-layer Redis lock (the
// transition into 'takeover-pending' is the only contention point
// that matters; subsequent transitions are serialized by the
// per-row UPDATE in setPairModeState).
//
// Implementation: SET NX EX. Two clients racing both win different
// Redis keys' acquire calls, but only one wins the per-session
// `pair_lock:{sessionId}` key. The loser gets a typed 409 Conflict
// + the winner's client_id in the body so the dashboard can render
// "user X is taking over — your request was declined".
//
// In-process variant used in tests; the production wire passes the
// real ioredis client through.

export interface PairModeTakeoverLock {
  /**
   * Attempt to acquire the takeover lock for `sessionId` on behalf
   * of `clientId`. TTL bounds the maximum hold time (30s by default;
   * the route layer's transition path is much faster, so the TTL is
   * insurance against a stuck client). Returns the winner — when the
   * caller wins, the winner equals `clientId`; otherwise it's whoever
   * holds the live lock.
   */
  tryAcquire(args: {
    sessionId: string;
    clientId: string;
    ttlSeconds?: number;
  }): Promise<{ acquired: boolean; winnerClientId: string }>;

  /** Release a lock the caller holds. No-op when the lock isn't held
   *  or has already expired. */
  release(args: { sessionId: string; clientId: string }): Promise<void>;
}

/** In-memory variant for tests + dev. */
export class InMemoryPairModeTakeoverLock implements PairModeTakeoverLock {
  private readonly locks = new Map<string, { clientId: string; expiresAtMs: number }>();

  constructor(private readonly clock: () => Date = () => new Date()) {}

  tryAcquire(args: {
    sessionId: string;
    clientId: string;
    ttlSeconds?: number;
  }): Promise<{ acquired: boolean; winnerClientId: string }> {
    const ttl = args.ttlSeconds ?? 30;
    const nowMs = this.clock().getTime();
    const existing = this.locks.get(args.sessionId);
    if (existing && existing.expiresAtMs > nowMs) {
      return Promise.resolve({ acquired: false, winnerClientId: existing.clientId });
    }
    this.locks.set(args.sessionId, {
      clientId: args.clientId,
      expiresAtMs: nowMs + ttl * 1000,
    });
    return Promise.resolve({ acquired: true, winnerClientId: args.clientId });
  }

  release(args: { sessionId: string; clientId: string }): Promise<void> {
    const existing = this.locks.get(args.sessionId);
    if (!existing) return Promise.resolve();
    if (existing.clientId === args.clientId) {
      this.locks.delete(args.sessionId);
    }
    return Promise.resolve();
  }
}

/** Redis-backed variant. Uses SET NX EX (the canonical Redlock-style
 *  single-key lock). Caller is responsible for handling the
 *  `acquired: false` path (typically: 409 Conflict + return the
 *  winner's client_id to the SDK). */
export interface RedisLikeClient {
  /** Subset of ioredis.set used by this service. Returns 'OK' on
   *  success, null on NX failure. */
  set(
    key: string,
    value: string,
    nxFlag: 'NX',
    expiryFlag: 'EX',
    ttlSeconds: number,
  ): Promise<'OK' | null>;
  /** Subset of ioredis.get — returns the value or null. */
  get(key: string): Promise<string | null>;
  /** Subset of ioredis.del. */
  del(key: string): Promise<number>;
}

export class RedisPairModeTakeoverLock implements PairModeTakeoverLock {
  constructor(private readonly redis: RedisLikeClient) {}

  async tryAcquire(args: {
    sessionId: string;
    clientId: string;
    ttlSeconds?: number;
  }): Promise<{ acquired: boolean; winnerClientId: string }> {
    const ttl = args.ttlSeconds ?? 30;
    const key = `pair_lock:${args.sessionId}`;
    const ok = await this.redis.set(key, args.clientId, 'NX', 'EX', ttl);
    if (ok === 'OK') {
      return { acquired: true, winnerClientId: args.clientId };
    }
    const winner = (await this.redis.get(key)) ?? 'unknown';
    return { acquired: false, winnerClientId: winner };
  }

  async release(args: { sessionId: string; clientId: string }): Promise<void> {
    const key = `pair_lock:${args.sessionId}`;
    const current = await this.redis.get(key);
    if (current === args.clientId) {
      // Best-effort cas-check; a true CAS-DEL needs a Lua script
      // (DEL_IF_VALUE) — leaving that as a follow-up since the TTL
      // bounds the worst-case stale-holder window to ttlSeconds.
      await this.redis.del(key);
    }
  }
}
