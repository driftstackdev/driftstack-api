// Rate-limit middleware. Decorates `request` with no state and exposes a
// per-bucket factory: `app.rateLimit(bucketKey, costFn?)` returns a Fastify
// preHandler that consumes from the named bucket (account-keyed) and either
// allows the request or throws `RateLimitedError` with retry hint.

import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import {
  rateLimitConsume,
  type ConsumeResultWithBucket,
  type RateLimitStore,
} from '../services/rate-limit.js';
import { ForbiddenError, RateLimitedError, UnauthorizedError } from '../lib/errors.js';
import { METRIC_NAMES, type MetricsRegistry } from '../services/metrics-registry.js';
import { BoundedMemoryRateLimitStore } from '../lib/bounded-memory-rate-limit-store.js';
import type { AccountAuthRepo, AccountRow, RateLimitOverride } from '../services/auth.js';

declare module 'fastify' {
  interface FastifyInstance {
    rateLimit: (
      bucketKey: string,
      cost?: number,
    ) => (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface RateLimitPluginOptions {
  store: RateLimitStore;
  /** Arc 7 obs.5 — optional metrics registry. When wired, the
   *  plugin increments `driftstack_rate_limit_total{bucket,outcome}`
   *  on every consume. outcome ∈ { allowed | exceeded }. */
  metrics?: MetricsRegistry;
  /**
   * Live owner/tier/override authority for effective-owner enforcement.
   * Optional only for isolated middleware tests that never call that
   * decorator; production always wires it.
   */
  authRepo?: AccountAuthRepo;
}

interface EffectiveOwnerInvocation {
  ownerAccountId: string;
  bucketKey: string;
  cost: number;
  resolvedTier?: AccountRow['tier'];
}

const effectiveOwnerInvocations = new WeakMap<FastifyRequest, EffectiveOwnerInvocation>();

/**
 * Consume the route's existing actor bucket a second time for an authorized,
 * distinct effective owner. The plugin-local actor receipt makes actor-first
 * ordering and exact bucket/cost parity mandatory. Isolated route fakes keep
 * using their existing no-op `app.rateLimit()` seam.
 */
export async function consumeEffectiveOwnerRateLimit(
  app: FastifyInstance,
  request: FastifyRequest,
  reply: FastifyReply,
  ownerAccountId: string,
  bucketKey: string,
  cost = 1,
): Promise<AccountRow['tier']> {
  if (effectiveOwnerInvocations.has(request)) {
    throw new RateLimitedError(60);
  }
  const invocation: EffectiveOwnerInvocation = {
    ownerAccountId,
    bucketKey,
    cost,
  };
  effectiveOwnerInvocations.set(request, invocation);
  try {
    await app.rateLimit(bucketKey, cost)(request, reply);
    if (invocation.resolvedTier === undefined) {
      // A production app always has the real plugin. A fake route app may
      // intentionally no-op the limiter; no owner tier is available there.
      return request.account?.account.tier ?? 'free';
    }
    return invocation.resolvedTier;
  } finally {
    if (effectiveOwnerInvocations.get(request) === invocation) {
      effectiveOwnerInvocations.delete(request);
    }
  }
}

function rateLimitPlugin(
  app: FastifyInstance,
  opts: RateLimitPluginOptions,
  done: (err?: Error) => void,
): void {
  // DoS hardening — bounded per-instance fallback store. When the primary
  // store (Redis in prod) throws, the limiter degrades to THIS instead of
  // unconditionally allowing every request. A Redis blip then drops to
  // coarse per-instance limiting (still bounded) rather than removing ALL
  // limiting platform-wide. Created once per plugin instance so the
  // fallback buckets persist across requests during the outage.
  const fallbackStore = new BoundedMemoryRateLimitStore();
  type ActorReceipt = {
    accountId: string;
    tier: AccountRow['tier'];
    bucketKey: string;
    cost: number;
  };
  const actorReceipts = new WeakMap<FastifyRequest, Map<string, ActorReceipt>>();
  const ownerReceipts = new WeakMap<FastifyRequest, Map<string, AccountRow['tier']>>();
  const policyHeaders = [
    'x-ratelimit-bucket',
    'x-ratelimit-limit',
    'x-ratelimit-remaining',
    'x-ratelimit-reset',
    'ratelimit-limit',
    'ratelimit-remaining',
    'ratelimit-reset',
  ] as const;
  const receiptKey = (bucketKey: string, cost: number): string =>
    `${bucketKey}\u0000${cost.toString()}`;
  const rememberActorReceipt = (request: FastifyRequest, receipt: ActorReceipt): void => {
    const receipts = actorReceipts.get(request) ?? new Map<string, ActorReceipt>();
    receipts.set(receiptKey(receipt.bucketKey, receipt.cost), receipt);
    actorReceipts.set(request, receipts);
  };
  const rejectEffectiveOwner = (reply: FastifyReply, retryAfterSeconds: number): never => {
    // The actor's successful policy headers must not be mistaken for details
    // about the selected owner's lower capacity/override. Owner denial exposes
    // only a generic problem plus the actionable Retry-After.
    for (const name of policyHeaders) reply.removeHeader(name);
    reply.header('retry-after', retryAfterSeconds.toString());
    throw new RateLimitedError(retryAfterSeconds);
  };
  const indexOverrides = (rows: RateLimitOverride[]): Record<string, RateLimitOverride> => {
    const indexed: Record<string, RateLimitOverride> = {};
    for (const row of rows) indexed[row.bucketKey] = row;
    return indexed;
  };
  type OwnerAuthority = { account: AccountRow; overrides: Record<string, RateLimitOverride> };
  /**
   * Owner authority was read fresh on EVERY distinct-owner request: two
   * uncached Postgres reads (account row + active overrides) before the token
   * check, so the limiter amplified the database load it exists to cap. The
   * blast radius is bounded — the actor bucket is charged first, and self /
   * control-key traffic returns before ever reaching here — but a large team on
   * a high tier can still drive thousands of extra reads per second.
   *
   * Two mitigations, both plugin-local so every app instance (and every test)
   * starts clean: single-flight, so a concurrent burst for one owner collapses
   * to ONE read pair instead of one per request; and a short TTL, so steady
   * traffic re-reads at most once per window.
   *
   * The staleness this introduces stays strictly INSIDE the contract the actor
   * path already has. RedisAuthCache holds the actor's own tier and overrides
   * for 30s, and revocation is documented to take effect within that window;
   * 5s keeps owner policy fresher than the caller's own, so no request is ever
   * limited by owner state older than its actor state. Failures are never
   * cached, so a suspended owner that is restored recovers on the next request
   * rather than after a window.
   */
  const OWNER_AUTHORITY_TTL_MS = 5_000;
  /** Bounded like the fallback store: a hostile spread of owner ids must not
   *  grow this without limit. Insertion-ordered, so evicting the oldest key is
   *  a first-entry delete. */
  const OWNER_AUTHORITY_MAX_ENTRIES = 5_000;
  const ownerAuthorityCache = new Map<string, { value: OwnerAuthority; expiresAtMs: number }>();
  const ownerAuthorityInFlight = new Map<string, Promise<OwnerAuthority>>();

  const readLiveOwnerAuthority = async (ownerAccountId: string): Promise<OwnerAuthority> => {
    if (opts.authRepo === undefined) {
      throw new Error('effective-owner rate-limit authority is unavailable');
    }
    const account = await opts.authRepo.getAccount(ownerAccountId);
    // A missing or non-active owner is a DETERMINISTIC authorization outcome,
    // not a capacity outcome. Reporting it as 429 would hand the caller a
    // Retry-After the SDK honours forever (packages/sdk-typescript/src/retry.ts
    // retries 429 and no other 4xx), so a suspended or deleted owner would turn
    // every team member's request into an infinite retry loop against a
    // permanent condition. Accounts are soft-deleted (`account_status` is
    // active|suspended|deleted), so the reachable case is `status`, not a null
    // row. Mirrors routes/admin.ts, profiles.ts and profile-snapshots.ts, which
    // already answer 403 on exactly this condition.
    if (account === null || account.status === 'deleted') {
      throw new ForbiddenError('Owner account no longer exists.');
    }
    if (account.status !== 'active') {
      throw new ForbiddenError('Owner account is suspended.');
    }
    const rows = await opts.authRepo.findActiveRateLimitOverrides(ownerAccountId, new Date());
    return { account, overrides: indexOverrides(rows) };
  };

  const loadLiveOwnerAuthority = async (ownerAccountId: string): Promise<OwnerAuthority> => {
    const cached = ownerAuthorityCache.get(ownerAccountId);
    if (cached !== undefined) {
      if (cached.expiresAtMs > Date.now()) return cached.value;
      ownerAuthorityCache.delete(ownerAccountId);
    }
    const inFlight = ownerAuthorityInFlight.get(ownerAccountId);
    if (inFlight !== undefined) return inFlight;

    const pending = readLiveOwnerAuthority(ownerAccountId);
    ownerAuthorityInFlight.set(ownerAccountId, pending);
    try {
      const value = await pending;
      // Only a SUCCESSFUL read is cached; a rejection (missing/suspended owner,
      // or an authority outage) must be re-decided on the next request.
      if (ownerAuthorityCache.size >= OWNER_AUTHORITY_MAX_ENTRIES) {
        const oldest = ownerAuthorityCache.keys().next();
        if (!oldest.done) ownerAuthorityCache.delete(oldest.value);
      }
      ownerAuthorityCache.set(ownerAccountId, {
        value,
        expiresAtMs: Date.now() + OWNER_AUTHORITY_TTL_MS,
      });
      return value;
    } finally {
      ownerAuthorityInFlight.delete(ownerAccountId);
    }
  };

  const consumeEffectiveOwner = async (
    request: FastifyRequest,
    reply: FastifyReply,
    ownerAccountId: string,
    bucketKey: string,
    cost: number,
  ): Promise<AccountRow['tier']> => {
    const key = receiptKey(bucketKey, cost);
    const actorReceipt = actorReceipts.get(request)?.get(key);
    if (actorReceipt === undefined) {
      request.log.warn(
        { component: 'rate-limit', bucket: bucketKey },
        'effective-owner limiter has no allowed actor receipt — failing CLOSED',
      );
      return rejectEffectiveOwner(reply, 60);
    }

    // Self and the exact per-session control key were already charged to
    // this owner by the actor preHandler. Never double-consume them.
    if (actorReceipt.accountId === ownerAccountId) return actorReceipt.tier;

    // Defense in depth: a distinct owner must still be one of the actor's
    // live memberships. Exact member/admin role remains route-specific and
    // must be checked before this decorator is called.
    const ctx = request.account;
    if (
      ctx == null ||
      !ctx.teams.some((membership) => membership.ownerAccountId === ownerAccountId)
    ) {
      request.log.warn(
        { component: 'rate-limit', bucket: bucketKey },
        'effective-owner limiter received an unauthorized owner — failing CLOSED',
      );
      return rejectEffectiveOwner(reply, 60);
    }

    const ownerReceiptKey = `${ownerAccountId}\u0000${key}`;
    const priorOwnerTier = ownerReceipts.get(request)?.get(ownerReceiptKey);
    if (priorOwnerTier !== undefined) return priorOwnerTier;

    const authority = await loadLiveOwnerAuthority(ownerAccountId).catch((error: unknown) => {
      // Owner availability is decided above and keeps its exact non-retryable
      // 403. Only genuine authority-infrastructure failure (no repo wired, or a
      // rejected account/override read) degrades to the generic closed 429.
      if (error instanceof ForbiddenError) throw error;
      request.log.warn(
        { component: 'rate-limit', bucket: bucketKey, err: error },
        'effective-owner authority lookup failed — failing CLOSED',
      );
      return rejectEffectiveOwner(reply, 60);
    });

    const consumeInput = {
      accountId: authority.account.id,
      tier: authority.account.tier,
      bucketKey,
      cost,
      overrides: authority.overrides,
    };
    const result = await rateLimitConsume(opts.store, consumeInput).catch(async (err: unknown) => {
      request.log.warn(
        { component: 'rate-limit', bucket: bucketKey, err },
        'effective-owner rate-limit store error — degrading to bounded in-process fallback',
      );
      try {
        opts.metrics?.inc(METRIC_NAMES.rateLimitStoreFallbackTotal, {
          limiter: 'account',
        });
      } catch {
        // Swallow; metrics are best-effort.
      }
      try {
        return await rateLimitConsume(fallbackStore, consumeInput);
      } catch (fallbackErr) {
        request.log.warn(
          { component: 'rate-limit', bucket: bucketKey, err: fallbackErr },
          'effective-owner rate-limit fallback error — failing CLOSED',
        );
        return rejectEffectiveOwner(reply, 60);
      }
    });

    try {
      opts.metrics?.inc(METRIC_NAMES.rateLimitTotal, {
        bucket: bucketKey,
        outcome: result.allowed ? 'allowed' : 'exceeded',
      });
    } catch {
      // Swallow; metrics are best-effort.
    }
    const logFields = {
      component: 'rate-limit',
      account_id: ownerAccountId,
      tier: authority.account.tier,
      bucket_key: bucketKey,
      cost,
      tokens_remaining: Math.floor(result.remaining),
      allowed: result.allowed,
      retry_after_ms: result.retryAfterMs,
      authority: 'effective_owner',
    };
    if (!result.allowed) {
      request.log.warn(logFields, 'effective-owner rate-limit exceeded');
      return rejectEffectiveOwner(reply, Math.max(1, Math.ceil(result.retryAfterMs / 1000)));
    }
    request.log.debug(logFields, 'effective-owner rate-limit consumed');
    const receipts = ownerReceipts.get(request) ?? new Map<string, AccountRow['tier']>();
    receipts.set(ownerReceiptKey, authority.account.tier);
    ownerReceipts.set(request, receipts);
    return authority.account.tier;
  };

  app.decorate('rateLimit', (bucketKey: string, cost = 1) => {
    return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
      const ownerInvocation = effectiveOwnerInvocations.get(request);
      if (ownerInvocation !== undefined) {
        if (ownerInvocation.bucketKey !== bucketKey || ownerInvocation.cost !== cost) {
          rejectEffectiveOwner(reply, 60);
        }
        ownerInvocation.resolvedTier = await consumeEffectiveOwner(
          request,
          reply,
          ownerInvocation.ownerAccountId,
          bucketKey,
          cost,
        );
        return;
      }
      const ctx = request.account;
      // gui_control_key control-auth path: `request.account` is absent
      // (the per-session control key isn't an account credential), but
      // the route's auth preHandler stashed the session's OWNING
      // account id. Charge that account's bucket at the conservative
      // `free`-tier floor so a per-session control key still consumes
      // rate-limit budget (never bypasses it) — and never sees a tier
      // larger than the smallest. Overrides are intentionally NOT
      // applied here (they're a per-account-key concept).
      const controlKeyAccountId = request.guiControlKeyRateLimitAccountId;
      if (!ctx && controlKeyAccountId === undefined) {
        // Rate limit only applies to authenticated requests. If we ever wire
        // this on a public route, that's a misconfiguration — return 401.
        throw new UnauthorizedError('Rate limit requires an authenticated request.');
      }

      const consumeInput = {
        accountId: ctx ? ctx.account.id : controlKeyAccountId!,
        tier: ctx ? ctx.account.tier : ('free' as const),
        bucketKey,
        cost,
        overrides: ctx ? ctx.rateLimitOverrides : {},
      };
      let result: ConsumeResultWithBucket;
      try {
        result = await rateLimitConsume(opts.store, consumeInput);
      } catch (err) {
        // W384 / DoS hardening — the primary store (Redis) threw. A
        // rate-limiter must not be a SPOF that 500s the whole API when its
        // backing store is down. Previously this failed fully OPEN (allow),
        // which removed ALL limiting platform-wide on a Redis blip — turning
        // a transient Redis outage into an unbounded resource-exhaustion
        // window on the expensive session-create / LLM-dispatch routes.
        // Instead degrade to a bounded PER-INSTANCE memory store so coarse
        // limiting survives the outage; full shared limiting resumes when
        // Redis recovers. The warn + metric make the bounded bypass
        // observable/alertable.
        request.log.warn(
          { component: 'rate-limit', bucket: bucketKey, err },
          'rate-limit store error — degrading to bounded in-process fallback',
        );
        try {
          opts.metrics?.inc(METRIC_NAMES.rateLimitStoreFallbackTotal, { limiter: 'account' });
        } catch {
          // Swallow; metrics are best-effort.
        }
        try {
          result = await rateLimitConsume(fallbackStore, consumeInput);
        } catch (fallbackErr) {
          // A failed primary store is an availability event; the bounded
          // fallback keeps normal Redis outages available. A failure of BOTH
          // stores is different: admitting the request would remove the last
          // abuse/resource-exhaustion guard precisely while its state is
          // unknown. Fail closed with a bounded, retryable 429 instead.
          request.log.warn(
            { component: 'rate-limit', bucket: bucketKey, err: fallbackErr },
            'rate-limit fallback store error — failing CLOSED',
          );
          const retryAfterSec = 60;
          reply.header('retry-after', retryAfterSec.toString());
          throw new RateLimitedError(
            retryAfterSec,
            'Rate limiting is temporarily unavailable. Retry shortly.',
          );
        }
      }

      // W199 — full RateLimit-header set as documented at
      // `/docs/rate-limits`. `bucket` lets clients distinguish which
      // limiter fired (`global` / `sessions:create` /
      // `agent_sessions:message` today); `limit` is the bucket
      // capacity; `reset` is unix seconds at which the bucket will
      // be back at capacity.
      const nowSec = Math.floor(Date.now() / 1000);
      const tokensNeededForFull = result.capacity - result.remaining;
      const secondsToFull =
        tokensNeededForFull > 0 && result.refillPerSecond > 0
          ? Math.ceil(tokensNeededForFull / result.refillPerSecond)
          : 0;
      reply.header('x-ratelimit-bucket', bucketKey);
      reply.header('x-ratelimit-limit', result.capacity.toString());
      reply.header('x-ratelimit-remaining', Math.floor(result.remaining).toString());
      reply.header('x-ratelimit-reset', (nowSec + secondsToFull).toString());
      // W561 — IETF draft-ietf-httpapi-ratelimit-headers names, emitted
      // alongside the vendor x- set (gateways + generic retry libraries read
      // the un-prefixed names). SEMANTIC DIFFERENCE: `ratelimit-reset` is
      // RELATIVE delta-seconds per the draft, whereas `x-ratelimit-reset`
      // is an ABSOLUTE unix timestamp — do not copy the absolute value.
      reply.header('ratelimit-limit', result.capacity.toString());
      reply.header('ratelimit-remaining', Math.floor(result.remaining).toString());
      reply.header('ratelimit-reset', secondsToFull.toString());

      // V-092: structured log line on every consume so observability
      // tooling (Sentry breadcrumbs, log search) can answer "is account
      // X near its rate-limit budget right now?" without piecing it
      // together from the egress log. Fastify's per-request logger is
      // already account-tagged from the auth middleware; we add the
      // bucket-specific fields here.
      //
      // Allowed → debug level (high-volume; avoid noise at default
      // info-level production logs). Exceeded → warn level (carries the
      // operational signal for capacity planning + abuse detection).
      const effectiveAccountId = ctx ? ctx.account.id : controlKeyAccountId!;
      const effectiveTier = ctx ? ctx.account.tier : 'free';
      const logFields = {
        component: 'rate-limit',
        account_id: effectiveAccountId,
        tier: effectiveTier,
        bucket_key: bucketKey,
        cost,
        tokens_remaining: Math.floor(result.remaining),
        allowed: result.allowed,
        retry_after_ms: result.retryAfterMs,
      };

      // Arc 7 obs.5 — bucket-labelled consume counter. Best-effort.
      try {
        opts.metrics?.inc(METRIC_NAMES.rateLimitTotal, {
          bucket: bucketKey,
          outcome: result.allowed ? 'allowed' : 'exceeded',
        });
      } catch {
        // Swallow; metrics are best-effort.
      }

      if (!result.allowed) {
        request.log.warn(logFields, 'rate-limit exceeded');
        const retryAfterSec = Math.max(1, Math.ceil(result.retryAfterMs / 1000));
        reply.header('retry-after', retryAfterSec.toString());
        throw new RateLimitedError(
          retryAfterSec,
          `Rate limit for "${bucketKey}" exceeded for tier "${effectiveTier}".`,
        );
      }
      request.log.debug(logFields, 'rate-limit consumed');
      rememberActorReceipt(request, {
        accountId: effectiveAccountId,
        tier: effectiveTier,
        bucketKey,
        cost,
      });
    };
  });

  done();
}

export default fp(rateLimitPlugin, { name: 'rate-limit', dependencies: ['auth'] });
