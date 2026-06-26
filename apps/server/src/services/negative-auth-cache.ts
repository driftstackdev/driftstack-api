// Negative auth-result cache (DoS hardening).
//
// The positive AuthCache (auth-cache.ts) amortises scrypt across the
// 30s TTL window for VALID credentials. It deliberately does NOT cache
// failures — so a flood of bogus bearer tokens re-hits the DB
// (findApiKeyByPrefix) and, when a 16-char prefix collides with a real
// key's semi-public key_prefix, re-runs scrypt verify (logN=15,
// ~50-100ms CPU) on every request. A few hundred req/s saturates the
// libuv threadpool + DB pool, degrading service for all tenants.
//
// This cache remembers "this plaintext is DEFINITELY invalid" for a
// short TTL, keyed by sha256(plaintext) (never the plaintext itself —
// same posture as the positive cache). On a hit we throw InvalidKeyError
// immediately, skipping the prefix lookup + scrypt verify entirely.
//
// Scope: ONLY the unambiguous "invalid credential" outcome is cached
// (unknown prefix / scrypt mismatch / unknown web-session). Revoked /
// expired / suspended / forbidden are NOT negatively cached — those are
// valid-but-state-changed credentials whose state can flip back (e.g. an
// account un-suspended), and the positive cache + version counters own
// that propagation. A genuinely invalid token cannot become valid, so a
// brief negative TTL is safe (a newly-minted key has a brand-new random
// body → a different sha → a cache miss).
//
// In-process + bounded. A Redis-backed variant is unnecessary: the
// attack is per-instance CPU/DB exhaustion, and a per-instance negative
// cache caps each instance's own scrypt/DB spend on repeats. The bound
// (LRU-ish FIFO eviction) makes it safe against an attacker rotating
// tokens to grow the map unboundedly.

export interface NegativeAuthCache {
  /** Returns true if this sha is known-invalid and still within TTL. */
  has(sha256Hex: string): boolean;
  /** Record this sha as invalid for the configured TTL. */
  markInvalid(sha256Hex: string): void;
}

interface NegativeAuthCacheOptions {
  /** TTL for a negative entry, ms. Default 2000ms. */
  ttlMs?: number;
  /** Max entries; FIFO-evicts the oldest on overflow. Default 50_000. */
  maxEntries?: number;
  /** Injectable clock for tests. */
  now?: () => number;
}

export class InProcessNegativeAuthCache implements NegativeAuthCache {
  private readonly entries = new Map<string, number>(); // sha -> expiresAtMs
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(opts: NegativeAuthCacheOptions = {}) {
    this.ttlMs = opts.ttlMs ?? 2000;
    this.maxEntries = opts.maxEntries ?? 50_000;
    this.now = opts.now ?? Date.now;
  }

  has(sha256Hex: string): boolean {
    const exp = this.entries.get(sha256Hex);
    if (exp === undefined) return false;
    if (exp <= this.now()) {
      this.entries.delete(sha256Hex);
      return false;
    }
    return true;
  }

  markInvalid(sha256Hex: string): void {
    // Bound the map: evict the oldest insertion (Map preserves insertion
    // order) when at capacity. Re-inserting an existing key first deletes
    // it so it moves to the most-recent slot (refreshes its eviction
    // priority + TTL).
    if (this.entries.has(sha256Hex)) {
      this.entries.delete(sha256Hex);
    } else if (this.entries.size >= this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
    this.entries.set(sha256Hex, this.now() + this.ttlMs);
  }

  /** Test helper: current entry count. */
  size(): number {
    return this.entries.size;
  }
}
