// Q.1.c — in-memory per-session BYOK Anthropic plaintext cache.
//
// Founder verdict 2026-05-17: decrypt the customer's stored key ONCE
// at agent-session create, hold the plaintext in process memory for
// the session lifetime, never re-decrypt mid-session. Bounds AES-GCM
// ciphertext unwrap to one operation per session-create (matching how
// MFA TOTP is decrypted once on enrollment-flow load).
//
// Lifecycle:
//
//   - SET on POST /v1/agent-sessions when the customer has a stored
//     BYOK key (after BYOKAnthropicService.getPlaintext returns
//     non-null).
//   - GET on every POST /v1/agent-sessions/:id/message that doesn't
//     carry an x-byok-anthropic-api-key header (header overrides per
//     Q.1.c verdict option 2).
//   - DELETE on session close — both at the route layer, since this cache
//     is route-owned and the runtime has no handle on it: the customer
//     DELETE /v1/agent-sessions/:id handler, and the POST /:id/message
//     handler when a turn closed the session (post-turn status 'closed',
//     e.g. the runtime's budget-exhausted close via closeWithReason).
//
// Memory shape: in-process Map keyed by agent_session_id. Plaintext
// strings are held in JS heap; not persisted; not serialized to logs.
// On process restart the cache is empty; existing customer sessions
// fall through to the header-only path (still works because the route
// resolution chain is header > cache > fallback).
//
// Why not Redis-backed: Redis adds round-trip latency per turn (~1-2
// ms each way) for a value that's only useful within one process's
// memory. The orchestrator's verdict was explicit about per-SESSION
// caching, not cross-process; the trade-off is acceptable for v1.0.

export interface ByokKeyCacheOptions {
  /** LRU cap on retained entries — a hard bound on how many decrypted keys can
   *  co-reside, independent of close-path delete() coverage. Default 10k. */
  maxEntries?: number;
  /** Per-entry TTL (ms), stamped at set(). An entry older than this is treated
   *  as absent on get() and swept on the next set(). Defaults to 13h — just
   *  past the 12h orphan-sweep session cap, so a live session's key is never
   *  evicted mid-run, but a key LEAKED by a close path that missed delete()
   *  (worker-initiated / reaper / sweeper terminal close — audit wsihqzj39)
   *  can't be read or retained beyond the session's own max lifetime. */
  ttlMs?: number;
  /** Injectable clock (tests). Defaults to Date.now. */
  now?: () => number;
}

export class InMemoryByokKeyCache {
  private readonly cache = new Map<string, { key: string; at: number; accountId?: string }>();
  /** V-730 — session ids per owning account, so a key CLEAR or ROTATE can evict
   *  the live plaintext it invalidates. Without this the cache was keyed only by
   *  session, and the credential lifecycle had no way to reach it. */
  private readonly byAccount = new Map<string, Set<string>>();
  private readonly maxEntries: number;
  private readonly ttlMs: number;
  private readonly now: () => number;

  constructor(opts: ByokKeyCacheOptions = {}) {
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.ttlMs = opts.ttlMs ?? 13 * 60 * 60 * 1000;
    this.now = opts.now ?? Date.now;
  }

  /**
   * Stash the plaintext key for the given agent-session id. Overwrites any
   * prior value (intentional for the rare key-rotation-during-active-session
   * edge case). session-create is the ONLY writer, so the opportunistic
   * expired-entry sweep + LRU-cap enforcement here are cheap and bound memory
   * even when a session's close path omits delete().
   */
  set(agentSessionId: string, plaintextKey: string, accountId?: string): void {
    const now = this.now();
    // Free (not just hide) plaintext keys leaked by a delete()-less close path.
    for (const [id, e] of this.cache) {
      if (now - e.at > this.ttlMs) this.forget(id);
    }
    // Re-insert to move to the end (LRU recency) with a fresh timestamp.
    this.forget(agentSessionId);
    this.cache.set(agentSessionId, {
      key: plaintextKey,
      at: now,
      ...(accountId ? { accountId } : {}),
    });
    if (accountId !== undefined) {
      const ids = this.byAccount.get(accountId) ?? new Set<string>();
      ids.add(agentSessionId);
      this.byAccount.set(accountId, ids);
    }
    // Hard cap: evict oldest-inserted until within bound (an evicted live
    // session degrades to the header/fallback resolution path, still correct).
    while (this.cache.size > this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest === undefined) break;
      this.forget(oldest);
    }
  }

  /** Drop one entry from BOTH indexes. Every removal goes through here so the
   *  account index cannot outlive the entries it points at. */
  private forget(agentSessionId: string): void {
    const entry = this.cache.get(agentSessionId);
    this.cache.delete(agentSessionId);
    if (entry?.accountId === undefined) return;
    const ids = this.byAccount.get(entry.accountId);
    if (ids === undefined) return;
    ids.delete(agentSessionId);
    if (ids.size === 0) this.byAccount.delete(entry.accountId);
  }

  /**
   * V-730 — evict every live plaintext this account has cached, and report how
   * many. Called when the stored key is CLEARED or ROTATED.
   *
   * Without it, `DELETE /v1/account/me/byok-anthropic-key` flipped `has_key` to
   * false while every already-open agent session kept transmitting the cleared
   * key to Anthropic until the session closed or the 13h TTL lapsed — a clear
   * that did not revoke. Rotation had the mirror problem: open sessions kept
   * using the OLD key for the rest of their lives.
   *
   * In-process only. A multi-instance deployment still needs a shared
   * invalidation signal; this closes the single-node case, which is what runs
   * today.
   */
  deleteByAccount(accountId: string): number {
    const ids = this.byAccount.get(accountId);
    if (ids === undefined) return 0;
    const n = ids.size;
    for (const id of [...ids]) this.forget(id);
    return n;
  }

  /** Returns the cached plaintext or undefined when no entry exists (cache
   *  miss on process restart, never-stashed session, post-delete read, or an
   *  entry past its TTL — which is lazily evicted here so an aged plaintext key
   *  can never be served). */
  get(agentSessionId: string): string | undefined {
    const entry = this.cache.get(agentSessionId);
    if (entry === undefined) return undefined;
    if (this.now() - entry.at > this.ttlMs) {
      this.forget(agentSessionId);
      return undefined;
    }
    return entry.key;
  }

  /**
   * Drop the cached plaintext. Idempotent — safe to call on already-
   * empty entries (e.g. when the route's DELETE handler fires
   * concurrent with the runtime's budget-exhausted close).
   */
  delete(agentSessionId: string): void {
    this.forget(agentSessionId);
  }

  /** Test seam: observable size for cache-pressure assertions. */
  size(): number {
    return this.cache.size;
  }
}
