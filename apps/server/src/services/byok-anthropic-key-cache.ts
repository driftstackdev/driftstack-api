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
//   - DELETE on session close (DELETE /v1/agent-sessions/:id and on
//     budget-exhausted close from the runtime).
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

export class InMemoryByokKeyCache {
  private readonly cache = new Map<string, string>();

  /**
   * Stash the plaintext key for the given agent-session id. Overwrites
   * any prior value (no-op on first call; intentional for the rare
   * key-rotation-during-active-session edge case).
   */
  set(agentSessionId: string, plaintextKey: string): void {
    this.cache.set(agentSessionId, plaintextKey);
  }

  /** Returns the cached plaintext or undefined when no entry exists
   *  (cache miss on process restart, never-stashed session, or
   *  post-delete read). */
  get(agentSessionId: string): string | undefined {
    return this.cache.get(agentSessionId);
  }

  /**
   * Drop the cached plaintext. Idempotent — safe to call on already-
   * empty entries (e.g. when the route's DELETE handler fires
   * concurrent with the runtime's budget-exhausted close).
   */
  delete(agentSessionId: string): void {
    this.cache.delete(agentSessionId);
  }

  /** Test seam: observable size for cache-pressure assertions. */
  size(): number {
    return this.cache.size;
  }
}
