// V-353d — short-lived ("challenge_token") store for the MFA login
// hand-off. Issued at /v1/auth/login when the account has MFA
// enrolled; consumed at /v1/auth/mfa/challenge to exchange the token
// + 6-digit code (or recovery code) for the real session.
//
// Storage: Redis SET … EX 300 in production; in-memory Map in tests.
// One-shot consumption via GETDEL — once the customer's challenge
// succeeds the token is gone. Failed challenges DO NOT consume the
// token (caller can retry up to maxAttempts; rate-limit + abandon).
//
// The stored payload binds the challenge to:
//   - account_id (so we know which account to challenge)
//   - email (sanity check the caller still claims this account)
//   - source_ip (defense-in-depth: if attacker steals the
//     challenge_token from a Slack paste, their IP differs and we
//     refuse — best-effort, not load-bearing security)
//   - issued_at (logged on success for audit reconstruction)
//   - issued_user_agent (carried into the eventual web_session row
//     so the user-agent comes from the login attempt, not the
//     challenge attempt — avoids "all sessions look like curl").

import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

const REDIS_KEY_PREFIX = 'mfa-challenge:';
const TTL_SECONDS = 5 * 60;

export interface MfaChallengePayload {
  account_id: string;
  email: string;
  source_ip: string | null;
  issued_at: number;
  issued_user_agent: string | null;
}

export interface MfaChallengeStore {
  /** Atomically read + delete (single-use). Returns null when missing
   *  or already consumed. */
  consume(key: string): Promise<string | null>;
  /** Store a payload for `ttlSeconds`. Idempotent overwrite. */
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  /** Read without consuming. Used by IP-mismatch refusal so the legit
   *  customer can still retry. */
  peek(key: string): Promise<string | null>;
  /** V-353d.A — atomically increment the per-challenge failed-attempt
   *  counter under `key` and return the new count. Ensures the counter has
   *  `ttlSeconds` on first increment (and repairs legacy no-TTL counters) so
   *  it expires with the challenge. Used to
   *  cap brute-force on the 6-digit code (the challenge token itself is
   *  left alive on a wrong code; this bounds how many wrong codes one
   *  token accepts before it's invalidated). */
  incrAttempts(key: string, ttlSeconds: number): Promise<number>;
  /** Release one previously-reserved attempt without letting the counter go
   *  negative or resurrecting an expired key. Valid proofs and verifier
   *  failures release; invalid proofs intentionally retain their slot. */
  releaseAttempt(key: string): Promise<void>;
}

export class RedisMfaChallengeStore implements MfaChallengeStore {
  constructor(private readonly redis: Redis) {}

  async consume(key: string): Promise<string | null> {
    // GETDEL is atomic and requires Redis 6.2+. There is NO fallback here — an
    // earlier comment claimed a GET + DEL pipeline for older servers and none
    // was ever implemented, so on a pre-6.2 server this rejects and the verify
    // fails closed rather than degrading to a non-atomic read. Both deployment
    // targets run 7.x (Upstash, Hetzner-managed), which is what makes that
    // acceptable — not a fallback.
    //
    // Called through the typed client: ioredis 5.x declares `getdel` in
    // RedisCommander, so the previous `as unknown as { getdel }` cast bought
    // nothing and would have silently absorbed a signature change.
    return this.redis.getdel(key);
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async peek(key: string): Promise<string | null> {
    return this.redis.get(key);
  }

  async incrAttempts(key: string, ttlSeconds: number): Promise<number> {
    // Reserve and attach the expiry in one Redis step. A separate INCR then
    // EXPIRE can strand an immortal counter if the process/connection dies
    // between commands, permanently locking account-scoped step-up attempts.
    // Checking TTL also repairs any such legacy counter without extending the
    // window for counters that already expire.
    const result = await this.redis.eval(
      "local count = redis.call('INCR', KEYS[1]); " +
        "local ttl = redis.call('TTL', KEYS[1]); " +
        "if ttl < 0 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end; " +
        'return count',
      1,
      key,
      ttlSeconds.toString(),
    );
    return Number(result);
  }

  async releaseAttempt(key: string): Promise<void> {
    // One Lua step avoids two Redis races: GET→DECR could act on a newly
    // replaced value, while bare DECR would resurrect an expired key as -1.
    await this.redis.eval(
      "local value = redis.call('GET', KEYS[1]); " +
        'if not value then return 0 end; ' +
        'local count = tonumber(value); ' +
        "if not count or count <= 1 then return redis.call('DEL', KEYS[1]) end; " +
        "return redis.call('DECR', KEYS[1])",
      1,
      key,
    );
  }
}

export class InMemoryMfaChallengeStore implements MfaChallengeStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly attempts = new Map<string, { count: number; expiresAt: number }>();

  // eslint-disable-next-line @typescript-eslint/require-await
  async consume(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return null;
    return entry.value;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.entries.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async peek(key: string): Promise<string | null> {
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async incrAttempts(key: string, ttlSeconds: number): Promise<number> {
    const now = Date.now();
    const existing = this.attempts.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.attempts.set(key, { count: 1, expiresAt: now + ttlSeconds * 1000 });
      return 1;
    }
    existing.count += 1;
    return existing.count;
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async releaseAttempt(key: string): Promise<void> {
    const now = Date.now();
    const existing = this.attempts.get(key);
    if (!existing || existing.expiresAt <= now) {
      this.attempts.delete(key);
      return;
    }
    if (existing.count <= 1) {
      this.attempts.delete(key);
      return;
    }
    existing.count -= 1;
  }
}

/** V-353d — generate a fresh challenge token. The plaintext crosses the wire
 * once; Redis key helpers store only its fixed-length SHA-256 identifier. */
export function generateChallengeToken(): string {
  // 32 bytes → 43 url-safe chars (base64url, no padding). Plenty of
  // entropy for a 5-minute single-use code; doesn't need scrypt.
  return randomBytes(32).toString('base64url');
}

export function redisKey(token: string): string {
  return `${REDIS_KEY_PREFIX}${challengeTokenDigest(token)}`;
}

/** V-353d.A — key for the per-challenge failed-attempt counter, distinct
 *  from the payload key so the counter and payload don't collide. */
export function attemptsKey(token: string): string {
  return `${REDIS_KEY_PREFIX}attempts:${challengeTokenDigest(token)}`;
}

function challengeTokenDigest(token: string): string {
  // Tokens carry 256 random bits, so an unsalted one-way lookup digest is
  // sufficient (same posture as database auth-token lookup hashes). Keeping
  // the plaintext out of the Redis keyspace protects MONITOR/slowlog/key scans
  // and snapshots without adding a second secret or changing wire behavior.
  return createHash('sha256').update(token).digest('hex');
}

export const MFA_CHALLENGE_TTL_SECONDS = TTL_SECONDS;

/** V-353d.A — max wrong 6-digit/recovery codes accepted per challenge
 *  token before it's invalidated (forcing a fresh /login). Bounds
 *  brute-force on the second factor without a per-account lockout. */
export const MAX_MFA_CHALLENGE_ATTEMPTS = 5;
