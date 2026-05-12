// V-251 / V-246-P1-004 — IP-based rate limiting on unauthenticated
// auth endpoints. Distinct from `app.rateLimit(bucketKey)` which is
// account-keyed (post-auth). The four auth-flow endpoints
// (signup / login / verify-email / password-reset) take requests
// where the customer doesn't have an account+key yet, so account-key
// rate limiting is impossible. IP-keyed gating is the standard
// pre-auth abuse-mitigation surface.
//
// Per founder direction 2026-05-07 (P1-004 deferral OVERRIDDEN):
// brute-force protection is launch-blocking. Wire in basic IP gates;
// fancier (CAPTCHA on threshold breach, exponential backoff per IP)
// is post-launch.
//
// Implementation reuses the existing `RateLimitStore` (token bucket
// with capacity + refillPerSecond) — same primitive the account-keyed
// limiter uses, just with an IP-derived bucket key. Memory store in
// tests; Redis store in production.

import type { FastifyReply, FastifyRequest } from 'fastify';
import { RateLimitedError } from '../lib/errors.js';
import type { RateLimitStore } from '../services/rate-limit.js';

export interface IpRateLimitConfig {
  /** Bucket-key prefix; final key is `${prefix}:${ip}`. */
  bucketPrefix: string;
  /** Max tokens in the bucket; first `capacity` requests pass freely. */
  capacity: number;
  /** Tokens refilled per second; sustained throughput floor. */
  refillPerSecond: number;
}

/**
 * Build a Fastify preHandler that applies IP-keyed rate limiting.
 * Designed for unauthenticated endpoints; for authenticated routes
 * use `app.rateLimit(bucketKey)` (account-keyed; richer overrides).
 *
 * Behavior:
 *   - `req.ip` extracted via Fastify's resolution (honors trust-proxy
 *     when set; falls back to socket).
 *   - When `req.ip` is null/empty (unusual: only happens on Unix-socket
 *     setups in some Fastify configs), the request is **allowed**.
 *     Rationale: the IP gate is defense-in-depth on top of the
 *     auth-flow's existing account-keyed protections (V-049 etc.); a
 *     missing IP shouldn't lock out legitimate customers.
 *   - On limit hit, throws `RateLimitedError` which the global
 *     error handler maps to RFC 7807 with `Retry-After` set.
 */
export function ipRateLimit(
  store: RateLimitStore,
  cfg: IpRateLimitConfig,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ip = typeof req.ip === 'string' && req.ip.length > 0 ? req.ip : null;
    if (ip === null) {
      // Misconfigured trust-proxy or test harness without an IP. Skip
      // the gate; document this as a known soft-fail mode in the V-251
      // V-log entry.
      return;
    }

    const result = await store.consume({
      key: `${cfg.bucketPrefix}:${ip}`,
      capacity: cfg.capacity,
      refillPerSecond: cfg.refillPerSecond,
      cost: 1,
      now: Date.now(),
    });

    // W200 — full RateLimit-header set documented at /docs/rate-limits.
    // Mirrors the account-keyed middleware (W199). `bucket` here is the
    // configured prefix; consumers shouldn't depend on the IP suffix
    // being visible in the header (we expose only the prefix to avoid
    // leaking the resolved IP through the response).
    const nowSec = Math.floor(Date.now() / 1000);
    const tokensNeededForFull = cfg.capacity - result.remaining;
    const secondsToFull =
      tokensNeededForFull > 0 && cfg.refillPerSecond > 0
        ? Math.ceil(tokensNeededForFull / cfg.refillPerSecond)
        : 0;
    reply.header('x-ratelimit-bucket', cfg.bucketPrefix);
    reply.header('x-ratelimit-limit', cfg.capacity.toString());
    reply.header('x-ratelimit-remaining', Math.floor(result.remaining).toString());
    reply.header('x-ratelimit-reset', (nowSec + secondsToFull).toString());

    if (!result.allowed) {
      const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
      reply.header('retry-after', retryAfterSec.toString());
      req.log.warn(
        {
          component: 'ip-rate-limit',
          bucket_prefix: cfg.bucketPrefix,
          ip,
          tokens_remaining: Math.floor(result.remaining),
          retry_after_ms: result.retryAfterMs,
        },
        'ip rate-limit exceeded on auth endpoint',
      );
      throw new RateLimitedError(
        retryAfterSec,
        `Too many requests from this IP. Retry in ${retryAfterSec.toString()}s.`,
      );
    }
  };
}

/**
 * V-251 — locked rate limits per auth endpoint per founder direction.
 * Sized for "legitimate customer can complete the flow without hitting
 * the gate; abuser hits it within seconds":
 *
 *   - login: 10/min — typo-budget + usual retry headroom.
 *   - signup: 5/min — fewer because signup creates DB rows + emails.
 *   - verify-email: 10/min — token paste retries are common.
 *   - password-reset: 3/min — tightest because each fires an email.
 */
export const AUTH_IP_LIMITS = {
  login: { capacity: 10, refillPerSecond: 10 / 60 },
  signup: { capacity: 5, refillPerSecond: 5 / 60 },
  verifyEmail: { capacity: 10, refillPerSecond: 10 / 60 },
  passwordResetRequest: { capacity: 3, refillPerSecond: 3 / 60 },
  // V-295c3 — public status-page email subscribe. Tighter than
  // signup because we don't create a paying account, and the form is
  // explicitly anonymous (no captcha layer); easier abuse vector.
  statusSubscribe: { capacity: 3, refillPerSecond: 3 / 60 },
} as const;
