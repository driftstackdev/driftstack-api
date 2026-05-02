// Authenticate a Bearer API key against the account/api_keys store.
//
// The service is decoupled from Drizzle via an `AccountAuthRepo` interface
// so unit tests can use an in-memory fake. The real implementation lives in
// `apps/server/src/db/auth-repo.ts`.

import {
  ExpiredKeyError,
  ForbiddenError,
  InvalidKeyError,
  RevokedKeyError,
  UnauthorizedError,
} from '../lib/errors.js';
import { keyPrefixFromPlaintext, verifyApiKey } from '../lib/api-keys.js';
import type { AuthCache } from './auth-cache.js';
import { sha256Hex } from './auth-cache.js';
import type { AuthCoalescer } from './auth-coalescer.js';
import type { ApiKeyScope } from '@driftstack/api-types';
import type { AccountTier } from '@driftstack/api-types';

const CACHE_TTL_SEC = 30;

// ───────────────────────────────────────────────────────────────────────────
// Repository interface (implemented by Drizzle in prod, by a Map in tests)
// ───────────────────────────────────────────────────────────────────────────

export interface AccountRow {
  id: string;
  email: string;
  name: string | null;
  tier: AccountTier;
  status: 'active' | 'suspended' | 'deleted';
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyRow {
  id: string;
  accountId: string;
  name: string;
  keyPrefix: string;
  keyHash: string;
  scopes: ApiKeyScope[];
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  expiresAt: Date | null;
  createdAt: Date;
}

export interface AccountAuthRepo {
  findApiKeyByPrefix(prefix: string): Promise<ApiKeyRow | null>;
  getAccount(id: string): Promise<AccountRow | null>;
  touchApiKeyLastUsed(id: string, at: Date): Promise<void>;
  /**
   * Load the active (unexpired) rate-limit overrides for an account.
   * Called once per auth-cache miss; the overrides are then cached
   * inside the AccountContext until the next invalidation.
   */
  findActiveRateLimitOverrides(accountId: string, now: Date): Promise<RateLimitOverride[]>;
}

// ───────────────────────────────────────────────────────────────────────────
// Context attached to authenticated requests
// ───────────────────────────────────────────────────────────────────────────

export interface RateLimitOverride {
  bucketKey: string;
  capacity: number;
  refillPerSecond: number;
  expiresAt: Date;
}

export interface AccountContext {
  account: AccountRow;
  apiKey: ApiKeyRow;
  /**
   * Active (unexpired) rate-limit overrides for this account, keyed by
   * bucketKey. Loaded once on auth-cache miss; subsequent reads come
   * from the cache. When an override expires, `rateLimitConsume` falls
   * through to the tier default (lazy expiry — no background sweep).
   */
  rateLimitOverrides: Record<string, RateLimitOverride>;
}

// ───────────────────────────────────────────────────────────────────────────
// Authentication entrypoint
// ───────────────────────────────────────────────────────────────────────────

const BEARER_RE = /^Bearer\s+(\S+)\s*$/i;

export function extractBearerToken(authorizationHeader: string | undefined): string {
  if (!authorizationHeader) {
    throw new UnauthorizedError('Missing Authorization header.');
  }
  const match = BEARER_RE.exec(authorizationHeader);
  if (!match || !match[1]) {
    throw new UnauthorizedError('Malformed Authorization header. Expected "Bearer <key>".');
  }
  return match[1];
}

export async function authenticate(
  repo: AccountAuthRepo,
  plaintext: string,
  cache: AuthCache | null = null,
  now: Date = new Date(),
  coalescer: AuthCoalescer | null = null,
): Promise<AccountContext> {
  if (plaintext.length < 24) throw new InvalidKeyError();

  // Cache fast path: if Redis has a fresh entry for sha256(plaintext), skip
  // the prefix lookup + scrypt verification entirely. The cache may also
  // throw (broken Redis, network blip, etc.) — graceful degradation is
  // belt-and-suspenders: the cache impl swallows internally AND we wrap
  // here in case a future impl forgets.
  const sha = sha256Hex(plaintext);
  if (cache) {
    let cached: AccountContext | null = null;
    try {
      cached = await cache.get(sha);
    } catch {
      cached = null;
    }
    if (cached) {
      // expiresAt is the only clock-bound condition that can change inside
      // the TTL window — re-check on every cache read so an expiry doesn't
      // leak past its deadline.
      if (cached.apiKey.expiresAt !== null && cached.apiKey.expiresAt.getTime() <= now.getTime()) {
        throw new ExpiredKeyError();
      }
      // Skip the last_used_at touch on cache hits — sampled at TTL granularity
      // (once per 30s in the worst case), which is the acceptable trade for
      // amortising scrypt across the burst window.
      return cached;
    }
  }

  // Slow path: prefix lookup + scrypt verification + account fetch +
  // touch + cache write. Coalesce concurrent misses for the same sha
  // through one execution — see auth-coalescer.ts for the why.
  const slowPath = async (): Promise<AccountContext> => {
    const prefix = keyPrefixFromPlaintext(plaintext);
    const apiKey = await repo.findApiKeyByPrefix(prefix);
    if (!apiKey) throw new InvalidKeyError();

    const matches = await verifyApiKey(plaintext, apiKey.keyHash);
    if (!matches) throw new InvalidKeyError();

    if (apiKey.revokedAt !== null) throw new RevokedKeyError();
    if (apiKey.expiresAt !== null && apiKey.expiresAt.getTime() <= now.getTime()) {
      throw new ExpiredKeyError();
    }

    const account = await repo.getAccount(apiKey.accountId);
    if (!account) throw new InvalidKeyError(); // FK invariant — treat as invalid
    if (account.status === 'suspended') {
      throw new ForbiddenError('Account is suspended.');
    }
    if (account.status === 'deleted') {
      throw new InvalidKeyError();
    }

    await repo.touchApiKeyLastUsed(apiKey.id, now);

    const overrideRows = await repo.findActiveRateLimitOverrides(account.id, now);
    const rateLimitOverrides: Record<string, RateLimitOverride> = {};
    for (const o of overrideRows) {
      rateLimitOverrides[o.bucketKey] = o;
    }
    const ctx: AccountContext = { account, apiKey, rateLimitOverrides };

    // Cap TTL at expiresAt so the cache entry can never outlive the key.
    if (cache) {
      let ttl = CACHE_TTL_SEC;
      if (apiKey.expiresAt !== null) {
        const remaining = Math.floor((apiKey.expiresAt.getTime() - now.getTime()) / 1000);
        if (remaining < ttl) ttl = Math.max(1, remaining);
      }
      try {
        await cache.set(sha, apiKey.id, account.id, ctx, ttl);
      } catch {
        // Cache write failed — auth still completed via scrypt path. Drop on
        // the floor; next request will retry the cache write.
      }
    }

    return ctx;
  };

  if (coalescer) return coalescer.coalesce(sha, slowPath);
  return slowPath();
}

// ───────────────────────────────────────────────────────────────────────────
// Scope check
// ───────────────────────────────────────────────────────────────────────────

export function requireScope(ctx: AccountContext, required: ApiKeyScope): void {
  if (!ctx.apiKey.scopes.includes(required)) {
    throw new ForbiddenError(`This action requires the "${required}" scope.`);
  }
}
