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

import { randomBytes } from 'node:crypto';
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
}

export class RedisMfaChallengeStore implements MfaChallengeStore {
  constructor(private readonly redis: Redis) {}

  async consume(key: string): Promise<string | null> {
    // GETDEL is atomic in Redis 6.2+; falls back to GET + DEL pipeline
    // for older Redis. We assume 6.2+ (Upstash + modern Hetzner-managed
    // builds both run 7.x).
    const result = await (
      this.redis as unknown as {
        getdel: (k: string) => Promise<string | null>;
      }
    ).getdel(key);
    return result;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(key, value, 'EX', ttlSeconds);
  }

  async peek(key: string): Promise<string | null> {
    return this.redis.get(key);
  }
}

export class InMemoryMfaChallengeStore implements MfaChallengeStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();

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
}

/** V-353d — generate a fresh challenge token. Caller stores under
 *  `mfa-challenge:<token>` (per `redisKey`). */
export function generateChallengeToken(): string {
  // 32 bytes → 43 url-safe chars (base64url, no padding). Plenty of
  // entropy for a 5-minute single-use code; doesn't need scrypt.
  return randomBytes(32).toString('base64url');
}

export function redisKey(token: string): string {
  return `${REDIS_KEY_PREFIX}${token}`;
}

export const MFA_CHALLENGE_TTL_SECONDS = TTL_SECONDS;
