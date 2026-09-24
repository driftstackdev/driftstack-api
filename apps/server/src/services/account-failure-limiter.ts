// Account-keyed failure limits for the sign-in paths (sign-in audit #2 and #3).
//
// The auth routes were throttled per IP address only. That bounds one address,
// not one account: guesses spread over many addresses were never refused, for a
// password (#3: 40 wrong guesses from 40 IPs, 0 refused, then the right one
// signed in) or for the six-digit MFA sign-in code (#2: five per challenge, and
// every fresh password sign-in mints a new challenge). This limiter counts
// failures per SUBJECT — the canonical email for password sign-in, the account
// id for the MFA code — and, once `maxFailures` have landed inside the window,
// refuses that subject for `lockSeconds`. The per-IP gates stay; this is layered
// on top of them, never a replacement.
//
// Reserve-before-verify, the shape step-up already uses (auth-flows.ts,
// stepUpReauth): every attempt takes a slot BEFORE its secret is checked, so a
// burst of concurrent guesses cannot all pass a stale "not yet locked" read and
// then all be verified. A failed attempt keeps its slot; a success or a verifier
// error gives back only its own. The attempt whose failure brings the count to
// `maxFailures` sets the lock.
//
// Storage is the short-lived Redis store the MFA hand-off already uses
// (`MfaChallengeStore`: an atomic INCR that sets its TTL in the same step, DEL
// of a counter, GET, GETDEL, SET EX). Bootstrap always wires it, so production
// needs no new wiring and no migration. Keys carry a SHA-256 of the subject, never the email itself,
// for the same reason the challenge keys hash their tokens: plaintext stays out
// of the keyspace, MONITOR and snapshots.
//
// While Redis is unreachable the password limit counts in a bounded store inside
// the process (`FailoverFailureLimiterStore` over `BoundedMemoryFailureLimiterStore`),
// as the per-IP limit does — it must not fail open (sign-in re-audit, round 1,
// defect 4). The MFA code limit does not fall back: the challenge it guards lives
// in the same store, so without Redis there is no challenge to guess at.

import { createHash } from 'node:crypto';
import type { MfaChallengeStore } from './mfa-challenge-store.js';

/** The store operations the limiter needs — a subset every `MfaChallengeStore` has. */
export type FailureLimiterStore = Pick<
  MfaChallengeStore,
  'incrAttempts' | 'releaseAttempt' | 'resetAttempts' | 'set' | 'peek' | 'consume'
>;

export interface FailureLimit {
  /** Key namespace. Distinct per limit so two limits on one subject never share a count. */
  readonly name: string;
  /** Failures inside the window that lock the subject. */
  readonly maxFailures: number;
  /** How long a failure counts. The window starts at the first failure. */
  readonly windowSeconds: number;
  /** How long the subject stays locked once `maxFailures` is reached. */
  readonly lockSeconds: number;
}

/** Password sign-in, keyed on the canonical email (#3). */
export const PASSWORD_SIGN_IN_LIMIT: FailureLimit = {
  name: 'sign-in-limit:password',
  maxFailures: 10,
  windowSeconds: 15 * 60,
  lockSeconds: 15 * 60,
};

/**
 * The MFA sign-in code, keyed on the account id AND the sign-in method that
 * started the challenge, across every challenge (#2; per method since the
 * re-audit's defect 1 — see `mfaSignInSubject` in auth-flows.ts).
 */
export const MFA_SIGN_IN_LIMIT: FailureLimit = {
  name: 'sign-in-limit:mfa-code',
  maxFailures: 10,
  windowSeconds: 15 * 60,
  lockSeconds: 15 * 60,
};

/** One reserved attempt. Exactly one of its three methods should be called. */
export interface ReservedAttempt {
  /**
   * The secret was right. Gives back this attempt's slot; with `clear`, forgets
   * every failure counted so far (password sign-in: "a success clears it").
   */
  succeeded(opts?: { clear?: boolean }): Promise<void>;
  /**
   * The secret was wrong. Keeps the slot. When this failure is the one that
   * reaches the limit, sets the lock and reports `locked: true`; `firstNotice`
   * is true for exactly one caller per lock, so a notice goes out once.
   */
  failed(): Promise<{ locked: boolean; lockedUntil: Date | null; firstNotice: boolean }>;
  /** The check itself could not run (a verifier error): give the slot back. */
  abandoned(): Promise<void>;
}

export type AttemptAdmission =
  | { kind: 'reserved'; attempt: ReservedAttempt }
  | { kind: 'locked'; retryAfterSeconds: number };

export class AccountFailureLimiter {
  constructor(
    private readonly store: FailureLimiterStore,
    private readonly limit: FailureLimit,
    private readonly now: () => number = () => Date.now(),
  ) {}

  private keys(subject: string): { failures: string; lock: string; notice: string } {
    const digest = createHash('sha256').update(subject).digest('hex');
    return {
      failures: `${this.limit.name}:failures:${digest}`,
      lock: `${this.limit.name}:lock:${digest}`,
      notice: `${this.limit.name}:notice:${digest}`,
    };
  }

  /** Seconds until the subject's lock lifts, or null when it is not locked. */
  async lockedFor(subject: string): Promise<number | null> {
    return this.readLock(this.keys(subject).lock);
  }

  /** Forget the subject's failures and lift its lock (a password reset proves the mailbox). */
  async clear(subject: string): Promise<void> {
    const keys = this.keys(subject);
    await this.store.resetAttempts(keys.failures);
    await this.store.consume(keys.lock);
  }

  private async readLock(lockKey: string): Promise<number | null> {
    const raw = await this.store.peek(lockKey);
    if (raw === null) return null;
    const until = Number(raw);
    // An unreadable value still means "locked" — the key exists and carries its
    // own TTL — so fail closed with the full lock rather than treat it as open.
    if (!Number.isFinite(until)) return this.limit.lockSeconds;
    const remainingMs = until - this.now();
    if (remainingMs <= 0) return null;
    return Math.max(1, Math.ceil(remainingMs / 1000));
  }

  /**
   * Reserve an attempt for `subject`, or report that it is locked. Call before
   * checking the secret, and settle the returned attempt afterwards.
   */
  async admit(subject: string): Promise<AttemptAdmission> {
    const keys = this.keys(subject);
    const lockedFor = await this.readLock(keys.lock);
    if (lockedFor !== null) return { kind: 'locked', retryAfterSeconds: lockedFor };

    const reserved = await this.store.incrAttempts(keys.failures, this.limit.windowSeconds);
    if (reserved > this.limit.maxFailures) {
      // The limit is already spent by failures and in-flight attempts. Give this
      // slot back and refuse; the lock (if the last failure has set it yet)
      // says how long, else the full lock.
      await this.store.releaseAttempt(keys.failures);
      return {
        kind: 'locked',
        retryAfterSeconds: (await this.readLock(keys.lock)) ?? this.limit.lockSeconds,
      };
    }

    let settled = false;
    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      return true;
    };
    return {
      kind: 'reserved',
      attempt: {
        succeeded: async (opts) => {
          if (!settle()) return;
          if (opts?.clear === true) {
            await this.store.resetAttempts(keys.failures);
          } else {
            await this.store.releaseAttempt(keys.failures);
          }
        },
        failed: async () => {
          if (!settle() || reserved < this.limit.maxFailures) {
            return { locked: false, lockedUntil: null, firstNotice: false };
          }
          const lockedUntil = new Date(this.now() + this.limit.lockSeconds * 1000);
          await this.store.set(keys.lock, lockedUntil.getTime().toString(), this.limit.lockSeconds);
          // One notice per lock: the first INCR on the notice key wins, and the
          // key lives exactly as long as the lock.
          const notices = await this.store.incrAttempts(keys.notice, this.limit.lockSeconds);
          return { locked: true, lockedUntil, firstNotice: notices === 1 };
        },
        abandoned: async () => {
          if (!settle()) return;
          await this.store.releaseAttempt(keys.failures);
        },
      },
    };
  }
}

/**
 * Sign-in re-audit, round 1, defect 4 — a bounded store inside this process, for
 * a limit to count in while its Redis store is unreachable. The same operations
 * and the same semantics as the in-memory challenge store, but each of its two
 * maps holds at most `maxKeys` keys and drops the least recently written one past
 * that, so a flood of distinct subjects during an outage cannot grow it without
 * limit — the same trade `BoundedMemoryRateLimitStore` makes for the per-IP
 * limit: a dropped key starts again from zero, coarser than Redis, far better
 * than no limit at all.
 */
export class BoundedMemoryFailureLimiterStore implements FailureLimiterStore {
  private readonly entries = new Map<string, { value: string; expiresAt: number }>();
  private readonly attempts = new Map<string, { count: number; expiresAt: number }>();

  constructor(
    private readonly maxKeys = 100_000,
    private readonly now: () => number = () => Date.now(),
  ) {
    if (maxKeys < 1) throw new Error('maxKeys must be >= 1');
  }

  /** Write `key` as the most recent entry of `map`, dropping the oldest past the bound. */
  private put<V>(map: Map<string, V>, key: string, value: V): void {
    map.delete(key);
    if (map.size >= this.maxKeys) {
      const oldest = map.keys().next().value;
      if (oldest !== undefined) map.delete(oldest);
    }
    map.set(key, value);
  }

  private live<V extends { expiresAt: number }>(map: Map<string, V>, key: string): V | null {
    const found = map.get(key);
    if (found === undefined) return null;
    if (found.expiresAt <= this.now()) {
      map.delete(key);
      return null;
    }
    return found;
  }

  consume(key: string): Promise<string | null> {
    const found = this.live(this.entries, key);
    this.entries.delete(key);
    return Promise.resolve(found?.value ?? null);
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.put(this.entries, key, { value, expiresAt: this.now() + ttlSeconds * 1000 });
    return Promise.resolve();
  }

  peek(key: string): Promise<string | null> {
    return Promise.resolve(this.live(this.entries, key)?.value ?? null);
  }

  incrAttempts(key: string, ttlSeconds: number): Promise<number> {
    const found = this.live(this.attempts, key);
    const next = {
      count: (found?.count ?? 0) + 1,
      expiresAt: found?.expiresAt ?? this.now() + ttlSeconds * 1000,
    };
    this.put(this.attempts, key, next);
    return Promise.resolve(next.count);
  }

  releaseAttempt(key: string): Promise<void> {
    const found = this.live(this.attempts, key);
    if (found === null || found.count <= 1) {
      this.attempts.delete(key);
    } else {
      found.count -= 1;
    }
    return Promise.resolve();
  }

  resetAttempts(key: string): Promise<void> {
    this.attempts.delete(key);
    return Promise.resolve();
  }

  /** Keys held across both maps (a test seam for the bound). */
  size(): number {
    return this.entries.size + this.attempts.size;
  }
}

/**
 * Sign-in re-audit, round 1, defect 4 — `primary` while it answers, `fallback`
 * while it throws. Each operation tries the primary first, so the limit moves
 * back to Redis the moment it answers again. `onOutage` runs once when the
 * primary starts failing and `onRecovery` once when it answers again: one log
 * line per outage, not one per request.
 */
export class FailoverFailureLimiterStore implements FailureLimiterStore {
  private degraded = false;

  constructor(
    private readonly primary: FailureLimiterStore,
    private readonly fallback: FailureLimiterStore,
    private readonly onOutage: (err: unknown) => void,
    private readonly onRecovery: () => void,
  ) {}

  private async run<T>(op: (store: FailureLimiterStore) => Promise<T>): Promise<T> {
    let result: T;
    try {
      result = await op(this.primary);
    } catch (err) {
      if (!this.degraded) {
        this.degraded = true;
        this.onOutage(err);
      }
      return op(this.fallback);
    }
    if (this.degraded) {
      this.degraded = false;
      this.onRecovery();
    }
    return result;
  }

  consume(key: string): Promise<string | null> {
    return this.run((s) => s.consume(key));
  }

  set(key: string, value: string, ttlSeconds: number): Promise<void> {
    return this.run((s) => s.set(key, value, ttlSeconds));
  }

  peek(key: string): Promise<string | null> {
    return this.run((s) => s.peek(key));
  }

  incrAttempts(key: string, ttlSeconds: number): Promise<number> {
    return this.run((s) => s.incrAttempts(key, ttlSeconds));
  }

  releaseAttempt(key: string): Promise<void> {
    return this.run((s) => s.releaseAttempt(key));
  }

  resetAttempts(key: string): Promise<void> {
    return this.run((s) => s.resetAttempts(key));
  }
}
