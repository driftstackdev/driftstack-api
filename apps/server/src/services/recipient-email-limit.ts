// Security sweep 2026-09-24, findings #4, #5 and #6 — a per-RECIPIENT limit on
// every email a caller can have sent to an address they have not proved they own.
//
// Verification resend, sign-in link, password reset, status-page confirmation and
// team invite each send to an address the request names. They were bounded only
// per source IP (3/min per route) or per inviting account, so rotating source
// addresses — or one address working three routes at their pace — sent without
// bound to one mailbox: 20 IPs, 20 mails; one IP, 540 mails an hour. This limit is
// keyed on the MAILBOX instead, whoever asks and from wherever.
//
// The rules:
//
//   - Keyed on the canonical address (`canonicalizeEmailForDedup` after trim and
//     lowercase), so Gmail's dot and +tag spellings of one inbox share a count, and
//     stored as a SHA-256 so no address reaches the keyspace.
//   - One count per KIND of email, so a flood of status-page confirmations does
//     not also stop the owner resetting their password. Each kind allows 5 an hour
//     and 10 a day (two exact sliding windows).
//   - Counted on every REQUEST for the address, before anything looks the address
//     up. The answer is therefore the same whether or not an account exists: a
//     refusal says nothing about who has an account, and an accepted request for
//     an unknown address still spends a slot, exactly as for a known one.
//   - Held in the shared rate-limit store (Redis in production, the same one the
//     per-IP limits use). While that throws, the count moves to a bounded store
//     inside this process — coarser, per instance, but never "no limit" — and moves
//     back when Redis answers. If both fail, the request is refused.

import { createHash } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { RateLimitedError } from '../lib/errors.js';
import { canonicalizeEmailForDedup } from './auth-flows.js';
import type {
  RateLimitStore,
  SlidingWindowConsumeOpts,
  SlidingWindowConsumeResult,
  SlidingWindowRateLimitStore,
} from './rate-limit.js';

export type RecipientEmailKind =
  | 'signup-verification'
  | 'magic-link'
  | 'password-reset'
  | 'status-subscription'
  | 'team-invite';

export interface RecipientEmailWindow {
  /** Stable key segment; distinct per window so two windows never share a count. */
  readonly name: string;
  readonly limit: number;
  readonly windowMs: number;
}

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Every kind: at most 5 an hour and 10 in any 24 hours to one mailbox. */
const WINDOWS: readonly RecipientEmailWindow[] = [
  { name: 'hour', limit: 5, windowMs: HOUR_MS },
  { name: 'day', limit: 10, windowMs: DAY_MS },
];

export const RECIPIENT_EMAIL_WINDOWS: Readonly<
  Record<RecipientEmailKind, readonly RecipientEmailWindow[]>
> = {
  'signup-verification': WINDOWS,
  'magic-link': WINDOWS,
  'password-reset': WINDOWS,
  'status-subscription': WINDOWS,
  'team-invite': WINDOWS,
};

/** How each refusal names what was asked for. */
const WHAT: Readonly<Record<Exclude<RecipientEmailKind, 'team-invite'>, string>> = {
  'signup-verification': 'verification emails',
  'magic-link': 'sign-in links',
  'password-reset': 'password reset emails',
  'status-subscription': 'confirmation emails',
};

/**
 * "12 minutes", "3 hours", "7 days" — the wait, rounded UP so a customer who
 * comes back when told is never refused again.
 */
export function describeWait(ms: number): string {
  const minutes = Math.max(1, Math.ceil(ms / 60_000));
  if (minutes < 120) return `${minutes.toString()} minute${minutes === 1 ? '' : 's'}`;
  const hours = Math.ceil(minutes / 60);
  if (hours < 48) return `${hours.toString()} hours`;
  const days = Math.ceil(hours / 24);
  return `${days.toString()} days`;
}

/** The 429 a refused request gets: what happened, and when to try again. */
export function recipientEmailLimitedError(
  kind: RecipientEmailKind,
  retryAfterMs: number,
): RateLimitedError {
  const retryAfterSeconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  const wait = describeWait(retryAfterMs);
  if (kind === 'team-invite') {
    return new RateLimitedError(
      retryAfterSeconds,
      `This address has been sent too many team invites recently. Try again in ${wait}.`,
    );
  }
  return new RateLimitedError(
    retryAfterSeconds,
    `Too many ${WHAT[kind]} have been requested for this address. Try again in ${wait}.`,
  );
}

/** The mailbox an address delivers to, as the limit keys it. */
export function recipientKey(email: string): string {
  const canonical = canonicalizeEmailForDedup(email.trim().toLowerCase());
  return createHash('sha256').update(canonical).digest('hex');
}

function hasSlidingWindow(
  store: RateLimitStore,
): store is RateLimitStore & SlidingWindowRateLimitStore {
  return (
    'consumeSlidingWindow' in store &&
    typeof (store as Partial<SlidingWindowRateLimitStore>).consumeSlidingWindow === 'function'
  );
}

/**
 * An exact sliding-window store inside this process: the fallback while the
 * shared store is unreachable. Holds at most `maxKeys` keys and drops the least
 * recently written past that, so a flood of distinct addresses during an outage
 * cannot grow it without bound (a dropped key starts again from zero — coarser
 * than Redis, never unlimited). Each key keeps at most `limit` timestamps.
 */
export class BoundedMemorySlidingWindowStore implements SlidingWindowRateLimitStore {
  private readonly windows = new Map<string, number[]>();

  constructor(private readonly maxKeys = 100_000) {
    if (maxKeys < 1) throw new Error('maxKeys must be >= 1');
  }

  consumeSlidingWindow(opts: SlidingWindowConsumeOpts): Promise<SlidingWindowConsumeResult> {
    const cutoff = opts.now - opts.windowMs;
    const retained = (this.windows.get(opts.key) ?? []).filter((at) => at > cutoff);
    this.windows.delete(opts.key);
    if (retained.length >= opts.limit) {
      this.put(opts.key, retained);
      const oldest = retained[0] ?? opts.now;
      const newest = retained[retained.length - 1] ?? opts.now;
      return Promise.resolve({
        allowed: false,
        remaining: 0,
        retryAfterMs: Math.max(1, oldest + opts.windowMs - opts.now),
        resetAtMs: newest + opts.windowMs,
      });
    }
    retained.push(opts.now);
    this.put(opts.key, retained);
    return Promise.resolve({
      allowed: true,
      remaining: opts.limit - retained.length,
      retryAfterMs: 0,
      resetAtMs: opts.now + opts.windowMs,
    });
  }

  private put(key: string, value: number[]): void {
    if (this.windows.size >= this.maxKeys) {
      const oldest = this.windows.keys().next().value;
      if (oldest !== undefined) this.windows.delete(oldest);
    }
    this.windows.set(key, value);
  }

  /** Keys held (a test seam for the bound). */
  size(): number {
    return this.windows.size;
  }
}

// One fallback for the whole process, as the per-IP limit keeps one: every route
// that builds a limiter counts into the same store during an outage.
const processFallback = new BoundedMemorySlidingWindowStore();

export type RecipientEmailAdmission = { allowed: true } | { allowed: false; retryAfterMs: number };

export class RecipientEmailLimiter {
  private degraded = false;

  constructor(
    /** The shared store (Redis in production). `null`: count in this process only. */
    private readonly primary: RateLimitStore | null,
    private readonly opts: {
      fallback?: SlidingWindowRateLimitStore;
      now?: () => number;
    } = {},
  ) {}

  private get fallback(): SlidingWindowRateLimitStore {
    return this.opts.fallback ?? processFallback;
  }

  private async consume(
    args: SlidingWindowConsumeOpts,
    log: FastifyBaseLogger,
  ): Promise<SlidingWindowConsumeResult> {
    const primary = this.primary;
    if (primary !== null && hasSlidingWindow(primary)) {
      try {
        const result = await primary.consumeSlidingWindow(args);
        if (this.degraded) {
          this.degraded = false;
          log.info(
            { component: 'recipient-email-limit' },
            'per-address email limit store answers again — counting there',
          );
        }
        return result;
      } catch (err) {
        if (!this.degraded) {
          this.degraded = true;
          log.warn(
            { component: 'recipient-email-limit', err },
            'per-address email limit store unreachable — counting in this process until it answers again',
          );
        }
      }
    }
    return this.fallback.consumeSlidingWindow(args);
  }

  /**
   * Count one request for `email` of this `kind`, or refuse it. Call BEFORE the
   * address is looked up or anything is sent.
   */
  async admit(
    kind: RecipientEmailKind,
    email: string,
    log: FastifyBaseLogger,
  ): Promise<RecipientEmailAdmission> {
    const subject = recipientKey(email);
    const now = (this.opts.now ?? Date.now)();
    for (const window of RECIPIENT_EMAIL_WINDOWS[kind]) {
      let result: SlidingWindowConsumeResult;
      try {
        result = await this.consume(
          {
            key: `recipient-email:${kind}:${window.name}:${subject}`,
            limit: window.limit,
            windowMs: window.windowMs,
            now,
          },
          log,
        );
      } catch (err) {
        // Both stores failed: the count is unknown, so refuse briefly rather
        // than send unbounded.
        log.warn(
          { component: 'recipient-email-limit', kind, err },
          'per-address email limit could not be counted — refusing',
        );
        return { allowed: false, retryAfterMs: 60_000 };
      }
      if (!result.allowed) return { allowed: false, retryAfterMs: result.retryAfterMs };
    }
    return { allowed: true };
  }

  /** {@link admit}, throwing the customer-facing 429 when refused. */
  async enforce(kind: RecipientEmailKind, email: string, log: FastifyBaseLogger): Promise<void> {
    const admission = await this.admit(kind, email, log);
    if (!admission.allowed) {
      log.warn(
        { component: 'recipient-email-limit', kind, retry_after_ms: admission.retryAfterMs },
        'per-address email limit reached',
      );
      throw recipientEmailLimitedError(kind, admission.retryAfterMs);
    }
  }
}
