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
import type {
  ConsumeResult,
  RateLimitStore,
  SlidingWindowConsumeResult,
  SlidingWindowRateLimitStore,
} from '../services/rate-limit.js';
import { BoundedMemoryRateLimitStore } from '../lib/bounded-memory-rate-limit-store.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';

// DoS hardening — bounded per-instance fallback shared across ALL
// ip-rate-limit gates (signup/login/oauth/... + the global pre-auth gate).
// When the primary store (Redis) throws, the gates degrade to coarse
// per-instance IP limiting via THIS store instead of unconditionally
// allowing every request — so a Redis blip can't remove every IP gate at
// once. Module-level so the fallback buckets persist across requests +
// across the many factory-built gate instances during an outage.
const ipFallbackStore = new BoundedMemoryRateLimitStore();

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
 *   - When `req.ip` is empty (unusual: only happens on Unix-socket or
 *     misconfigured proxy setups), requests share one non-sensitive
 *     `unresolved-client` identity. That preserves a bounded availability
 *     budget without letting a missing identity bypass the gate.
 *   - On limit hit, throws `RateLimitedError` which the global
 *     error handler maps to RFC 7807 with `Retry-After` set.
 */
export function ipRateLimit(
  store: RateLimitStore,
  cfg: IpRateLimitConfig,
  /** DoS hardening — optional metrics registry. When wired, a primary-store
   *  failure that degrades to the bounded fallback increments
   *  `driftstack_rate_limit_store_fallback_total{limiter="ip"}`. */
  metrics?: MetricsRegistry,
): (req: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (req: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const ip =
      typeof req.ip === 'string' && req.ip.trim().length > 0 ? req.ip : 'unresolved-client';

    const consumeArgs = {
      key: `${cfg.bucketPrefix}:${ip}`,
      capacity: cfg.capacity,
      refillPerSecond: cfg.refillPerSecond,
      cost: 1,
      now: Date.now(),
    };
    let result: ConsumeResult;
    try {
      result = await store.consume(consumeArgs);
    } catch (err) {
      // W384 / DoS hardening — the primary store (Redis) threw. The IP gate
      // is defense-in-depth, but previously a store outage failed fully OPEN
      // (allow), which removed EVERY IP gate (signup/login/oauth/... + the
      // global pre-auth gate) at once on a Redis blip. Instead degrade to a
      // bounded PER-INSTANCE memory store so coarse per-IP limiting survives
      // the outage. The warn + metric make the bounded bypass observable.
      req.log.warn(
        { component: 'ip-rate-limit', bucket_prefix: cfg.bucketPrefix, err },
        'ip rate-limit store error — degrading to bounded in-process fallback',
      );
      try {
        metrics?.inc(METRIC_NAMES.rateLimitStoreFallbackTotal, { limiter: 'ip' });
      } catch {
        // Swallow; metrics are best-effort.
      }
      try {
        result = await ipFallbackStore.consume(consumeArgs);
      } catch (fallbackErr) {
        // Keep ordinary Redis outages available through the bounded fallback,
        // but never admit a request when BOTH enforcement stores failed. The
        // state is unknown, so a short retryable denial is the safe outcome.
        req.log.warn(
          { component: 'ip-rate-limit', bucket_prefix: cfg.bucketPrefix, err: fallbackErr },
          'ip rate-limit fallback store error — failing CLOSED',
        );
        const retryAfterSec = 60;
        reply.header('retry-after', retryAfterSec.toString());
        throw new RateLimitedError(
          retryAfterSec,
          'Request rate limiting is temporarily unavailable. Retry shortly.',
        );
      }
    }

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
    // W561 — IETF draft names alongside the x- set (see rate-limit.ts).
    // `ratelimit-reset` is RELATIVE delta-seconds, not the absolute stamp.
    reply.header('ratelimit-limit', cfg.capacity.toString());
    reply.header('ratelimit-remaining', Math.floor(result.remaining).toString());
    reply.header('ratelimit-reset', secondsToFull.toString());

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

    // Security audit 2026-07-01 — absolute per-IP daily ceiling, layered on
    // top of (never a substitute for) the token bucket above. See
    // DAILY_IP_CEILINGS below for the full rationale. This only runs once
    // the burst bucket above has already allowed the request, so a request
    // the burst bucket denies never also spends a daily-ceiling token.
    const dailyCfg = dailyCeilingConfigFor(cfg.bucketPrefix);
    if (dailyCfg) {
      await enforceDailyIpCeiling(store, dailyCfg, ip, req, reply, metrics);
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
 *   - resend-verification: 3/min — same posture as password-reset
 *     (each request fires a Postmark send to the user's address).
 *   - magic-link: 3/min — same posture as password-reset + resend-
 *     verification (each request fires a Postmark send). Pre-#190
 *     this endpoint had no gate at all (oversight surfaced during
 *     the wire-up audit 2026-05-15); landing this closes the abuse
 *     vector before Postmark goes live.
 */
export const AUTH_IP_LIMITS = {
  login: { capacity: 10, refillPerSecond: 10 / 60 },
  signup: { capacity: 5, refillPerSecond: 5 / 60 },
  verifyEmail: { capacity: 10, refillPerSecond: 10 / 60 },
  passwordResetRequest: { capacity: 3, refillPerSecond: 3 / 60 },
  resendVerification: { capacity: 3, refillPerSecond: 3 / 60 },
  magicLink: { capacity: 3, refillPerSecond: 3 / 60 },
  // V-295c3 — public status-page email subscribe. Tighter than
  // signup because we don't create a paying account, and the form is
  // explicitly anonymous (no captcha layer); easier abuse vector.
  statusSubscribe: { capacity: 3, refillPerSecond: 3 / 60 },
  // 2026-05-20 — OAuth-client flow IP gates (pre-launch blocker per
  // 2026-05-19 rate-limit audit doc). The /start + /callback +
  // /confirm-merge surface is unauthenticated by design (the customer
  // is mid-OAuth-handshake), making account-creation flood the real
  // risk. 5/min/IP matches the signup posture since the
  // OAuth-callback success path may MINT a new account on first
  // /callback for a new IDP identity.
  oauthClientStart: { capacity: 5, refillPerSecond: 5 / 60 },
  oauthClientCallback: { capacity: 5, refillPerSecond: 5 / 60 },
  oauthClientConfirmMerge: { capacity: 5, refillPerSecond: 5 / 60 },
  // 2026-05-20 — public status-incident reads (defense-in-depth per
  // 2026-05-19 rate-limit audit doc Category B). The CDN absorbs
  // the primary read load (Cache-Control: public, max-age=30 +
  // status-site polls every 30s), so legit traffic is ~2/min/IP.
  // 60/min/IP gives a comfortable abuse-burst budget without
  // affecting CDN-cached normal traffic; abuse via direct API
  // hits (bypassing CDN) still gets gated.
  statusIncidentsList: { capacity: 60, refillPerSecond: 60 / 60 },
  statusIncidentDetail: { capacity: 60, refillPerSecond: 60 / 60 },
  // Public rolling SLA aggregation reads roughly 43k probe rows per
  // target window. Match the adjacent public incident-read budget so
  // direct API traffic is bounded independently of the global IP gate.
  statusSla: { capacity: 60, refillPerSecond: 60 / 60 },
  // The snapshot endpoint the status PAGE actually calls, and the only member
  // of this family that had no gate. It is also the most expensive: every
  // request fans out to all readiness checks (`Promise.all(readinessChecks)`,
  // each with its own timeout), so an unauthenticated caller bypassing the CDN
  // could drive one DB/Redis probe per component per request. Its siblings were
  // gated for exactly the abuse this leaves open, at exactly this budget, and
  // it carries the same `Cache-Control: public, max-age=30`.
  statusSnapshot: { capacity: 60, refillPerSecond: 60 / 60 },
  // 2026-06-01 — OAuth-PROVIDER public dance (V-667; Driftstack issuing
  // tokens to 3rd-party apps). authorize/token/introspect/revoke are
  // unauthenticated by protocol (PKCE + client_secret + code IS the
  // auth), so /token is a code+secret brute-force surface (RFC 6749
  // §10.10) and /introspect an unauthenticated token-validity oracle
  // (RFC 7662) — they were the only live unauth API family with no
  // limiter. 60/min/IP gives meaningful brute-force friction + oracle
  // throttling while staying generous for a legitimate client server
  // (token/introspect/revoke are CLIENT-SERVER-called → one source IP
  // per client; per-client_id keying is the future enhancement for a
  // high-volume client). This limit is LIVE, not a gate waiting on a
  // store: DrizzleOAuthStore is constructed in bootstrap.ts and
  // routes/oauth.ts applies this bucket per-route. Treating it as inert
  // is how a real brute-force limit gets tuned away.
  oauthProvider: { capacity: 60, refillPerSecond: 60 / 60 },
  // W484 — the 4 remaining unauth token routes (surfaced §4.12; gated on the
  // TRUST_PROXY fix so per-IP keys on the real client IP — live since W424).
  // The consumed tokens are high-entropy single-use (brute-force infeasible);
  // these gates close the residual unbounded-request/abuse friction.
  //   - magic-link/consume + password-reset/confirm: token-paste retries are
  //     common → verify-email posture (10/min).
  //   - refresh: HIGH-frequency legitimate traffic (every dashboard session
  //     refreshes; corporate-NAT puts many users behind one IP) → generous
  //     60/min so legit flows never see it while loops/floods get friction.
  //   - logout: cheap single-shot; 10/min covers any sane client.
  magicLinkConsume: { capacity: 10, refillPerSecond: 10 / 60 },
  passwordResetConfirm: { capacity: 10, refillPerSecond: 10 / 60 },
  refresh: { capacity: 60, refillPerSecond: 60 / 60 },
  logout: { capacity: 10, refillPerSecond: 10 / 60 },
  // V-266 CLI/GUI device-activation flow. /initiate is unauthenticated and
  // MINTS a server-side authorization-code row + a browser URL on every call —
  // same abuse posture as signup (5/min/IP). /exchange is a CLI/GUI POLL
  // endpoint (the client polls until the dashboard binds the code), so it needs
  // a generous bucket; 60/min/IP matches the refresh/oauth-provider posture so
  // a legitimate poll loop never trips it while a flood still gets friction.
  cliAuthorizeInitiate: { capacity: 5, refillPerSecond: 5 / 60 },
  cliAuthorizeExchange: { capacity: 60, refillPerSecond: 60 / 60 },
} as const;

// ───────────────────────────────────────────────────────────────────────────
// Security audit 2026-07-01 — absolute per-IP DAILY ceiling.
//
// The AUTH_IP_LIMITS token buckets above bound BURST speed via a
// continuously-refilling rate (tokens/sec) with NO upper bound on total
// daily volume: an attacker who paces requests at exactly
// `refillPerSecond` never trips the bucket denial. E.g. signup's
// capacity=5 / refillPerSecond=5/60 bucket lets a request through every
// 12s indefinitely — ~7,200 signups/day from one IP, unattended, since
// nothing anywhere tracks "total signups from this IP today".
//
// DAILY_IP_CEILINGS closes that gap with a SECOND, independent exact
// sliding-window consume against its own key (`${prefix}-daily-window:${ip}`) —
// additional to, never a replacement for, the burst bucket above. The store
// retains accepted event timestamps for 24 hours and atomically refuses event
// 26 until the oldest accepted event expires. A fixed calendar-day counter
// would have a reset-boundary doubling gap (N requests at 23:59 + N more at
// 00:01); a continuously-refilling capacity-25 token bucket is also incorrect
// because it can accept nearly 49 events in its first 24 hours.
//
// Only `signup` is gated for now — the highest-value farming target
// (mints a usable account + DB row per call). 25/day/IP comfortably
// covers a small shared-NAT office onboarding a full team in a day,
// while capping unattended account-farming at ~25 accounts/IP/day
// instead of the ~7,200/day the burst bucket alone would permit.
//
// Keyed on the exact `bucketPrefix` string the caller passes to
// `ipRateLimit` (see `routes/auth.ts`'s `signupGate`, currently
// `'auth-ip:signup'`) — NOT the `AUTH_IP_LIMITS` map key above (that
// object's keys are camelCase config lookups, e.g. `signup`; the
// bucketPrefix strings callers actually wire up are a separate,
// per-route-chosen namespace, e.g. `auth-ip:signup`).
const DAILY_IP_CEILINGS: Partial<Record<string, number>> = {
  'auth-ip:signup': 25,
};

const SECONDS_PER_DAY = 24 * 60 * 60;
const MILLISECONDS_PER_DAY = SECONDS_PER_DAY * 1000;

interface DailyCeilingConfig {
  bucketPrefix: string;
  limit: number;
  windowMs: number;
}

function dailyCeilingConfigFor(bucketPrefix: string): DailyCeilingConfig | null {
  const limit = DAILY_IP_CEILINGS[bucketPrefix];
  if (limit === undefined) {
    return null;
  }
  return {
    // Versioned away from the former `${bucketPrefix}-daily` token-bucket HASH.
    // Reusing that key would make the ZSET script fail WRONGTYPE for every IP
    // until the legacy key's ~24h TTL elapsed.
    bucketPrefix: `${bucketPrefix}-daily-window`,
    limit,
    windowMs: MILLISECONDS_PER_DAY,
  };
}

function hasSlidingWindowCapability(
  store: RateLimitStore,
): store is RateLimitStore & SlidingWindowRateLimitStore {
  return 'consumeSlidingWindow' in store && typeof store.consumeSlidingWindow === 'function';
}

async function enforceDailyIpCeiling(
  store: RateLimitStore,
  dailyCfg: DailyCeilingConfig,
  ip: string,
  req: FastifyRequest,
  reply: FastifyReply,
  metrics?: MetricsRegistry,
): Promise<void> {
  const consumeArgs = {
    key: `${dailyCfg.bucketPrefix}:${ip}`,
    limit: dailyCfg.limit,
    windowMs: dailyCfg.windowMs,
    now: Date.now(),
  };
  let result: SlidingWindowConsumeResult;
  try {
    if (!hasSlidingWindowCapability(store)) {
      throw new Error('rate-limit store lacks exact sliding-window support');
    }
    result = await store.consumeSlidingWindow(consumeArgs);
  } catch (err) {
    // Security audit 2026-07-01 fix — deliberately DIVERGES from the burst
    // bucket's posture above. The burst bucket degrades to the bounded
    // `ipFallbackStore` on a primary-store error because it's the ONLY
    // gate on the request; failing closed there would 500/lock out every
    // caller platform-wide on a Redis blip. The daily ceiling is a coarser
    // SECOND gate layered on top of an already-enforced burst bucket (which
    // ran first, allowed this request, and keeps its own fallback
    // protection independent of this code path) — so failing CLOSED here
    // doesn't remove rate-limiting during an outage; it makes signup
    // temporarily unavailable rather than silently bypassing the absolute cap.
    //
    // Falling back to `ipFallbackStore` here (as W384 originally did,
    // uniformly, for every ip-rate-limit gate) would be actively wrong for
    // THIS gate specifically: `ipFallbackStore` starts a key at FULL
    // capacity on first touch, so every Redis outage or instance restart
    // would silently hand a fresh IP a full bonus 25/day allotment,
    // un-reconciled once Redis recovers — reintroducing, via outage
    // boundaries, the exact "absolute ceiling" gap this feature exists to
    // close (see the fixed-window reset-boundary rationale above).
    req.log.warn(
      { component: 'ip-rate-limit', bucket_prefix: dailyCfg.bucketPrefix, err },
      'daily ip-rate-limit ceiling store error — failing CLOSED (denying request) rather than granting fallback capacity',
    );
    try {
      metrics?.inc(METRIC_NAMES.rateLimitStoreFallbackTotal, { limiter: 'ip-daily-fail-closed' });
    } catch {
      // Swallow; metrics are best-effort.
    }
    const retryAfterSec = 60;
    reply.header('retry-after', retryAfterSec.toString());
    throw new RateLimitedError(
      retryAfterSec,
      'Too many requests from this IP today. Retry shortly.',
    );
  }

  // Security audit 2026-07-01 — surface the daily ceiling's OWN
  // remaining/reset state on every request once a daily cap is configured
  // for this route, using this bucket's own consume result (not the burst
  // bucket's, whose headers above only describe the fast-refilling
  // per-minute gate). Without this, a high-volume-IP customer got zero
  // advance warning before the abrupt 429 on request #(capacity + 1) —
  // only the terminal denial set `retry-after`.
  reply.header('x-ratelimit-daily-remaining', result.remaining.toString());
  reply.header('x-ratelimit-daily-reset', Math.ceil(result.resetAtMs / 1000).toString());

  if (!result.allowed) {
    const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
    reply.header('retry-after', retryAfterSec.toString());
    req.log.warn(
      {
        component: 'ip-rate-limit',
        bucket_prefix: dailyCfg.bucketPrefix,
        ip,
        tokens_remaining: Math.floor(result.remaining),
        retry_after_ms: result.retryAfterMs,
      },
      'ip rate-limit exceeded on auth endpoint (daily ceiling)',
    );
    throw new RateLimitedError(
      retryAfterSec,
      `Too many requests from this IP today. Retry in ${retryAfterSec.toString()}s.`,
    );
  }
}
